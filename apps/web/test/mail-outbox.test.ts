import { describe, expect, it } from 'vitest'
import { classifyResendError } from '../api/_lib/mail'
import {
  MAX_ATTEMPTS,
  QuotaGate,
  processOutbox,
  sendOrQueue,
  type OutboxEntry,
  type OutboxRow,
  type OutboxStore,
} from '../api/_lib/outbox'
import { formatNextAttempt, mailQueueNotice, nextQuotaAttempt, type MailQueueStatus } from '../shared/mailQueue'

// The error shapes Resend documents for HTTP 429 (resend.com/docs/api-reference/errors).
const daily = { name: 'daily_quota_exceeded', statusCode: 429, message: 'You have exceeded your daily email sending quota.' }
const monthly = { name: 'monthly_quota_exceeded', statusCode: 429, message: 'You have exceeded your monthly email sending quota.' }
const rate = { name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests.' }
const invalid = { name: 'validation_error', statusCode: 422, message: 'Invalid `to` field.' }
const down = { name: 'application_error', statusCode: 500, message: 'Something went wrong.' }

describe('classifyResendError', () => {
  it('tells the two quotas from the rate limit and from everything else', () => {
    expect(classifyResendError(daily)).toBe('daily_quota')
    expect(classifyResendError(monthly)).toBe('monthly_quota')
    expect(classifyResendError(rate)).toBe('rate_limit')
    expect(classifyResendError(invalid)).toBe('other')
    expect(classifyResendError(down)).toBe('other')
  })

  it('reads an undocumented 429 by its name, and treats a bare one as the rate limit', () => {
    expect(classifyResendError({ name: 'monthly_quota_reached', statusCode: 429 })).toBe('monthly_quota')
    expect(classifyResendError({ name: 'quota_exceeded', statusCode: 429 })).toBe('daily_quota')
    expect(classifyResendError({ statusCode: 429 })).toBe('rate_limit')
  })

  it('does not mistake a missing or odd error for a quota', () => {
    for (const e of [null, undefined, 'daily_quota_exceeded', 42, {}]) expect(classifyResendError(e)).toBe('other')
  })
})

describe('nextQuotaAttempt', () => {
  it('is the next midnight UTC, when the daily quota resets', () => {
    expect(nextQuotaAttempt(new Date('2026-11-30T23:59:00Z')).toISOString()).toBe('2026-12-01T00:00:00.000Z')
    expect(nextQuotaAttempt(new Date('2026-12-01T00:00:00Z')).toISOString()).toBe('2026-12-02T00:00:00.000Z')
  })

  it('is shown in campus time, when the nightly retry runs', () => {
    // 00:10 UTC is 01:10 in Deggendorf in winter.
    expect(formatNextAttempt('2026-12-01T00:00:00.000Z')).toBe('01.12.2026 um 01:10 Uhr')
  })
})

// ── sendOrQueue ──────────────────────────────────────────────────────────────

const entry = (key: string): OutboxEntry => ({
  idempotencyKey: key,
  reportMonth: '2026-11',
  purpose: 'document',
  payload: { from: 'a@kaffeelisten.de', to: [`${key}@example.com`], subject: 's', html: '<p>x</p>' },
  onSent: null,
})

function harness(results: Array<{ data: { id: string } | null; error: unknown }>) {
  const sent: string[] = []
  const queued: Array<{ key: string; reason: string; at: string }> = []
  return {
    sent,
    queued,
    deps: {
      send: async (_p: unknown, key: string) => {
        sent.push(key)
        return results.shift() ?? { data: { id: `msg-${key}` }, error: null }
      },
      queue: async (e: OutboxEntry, reason: string, at: string) => { queued.push({ key: e.idempotencyKey, reason, at }) },
      now: () => new Date('2026-11-27T15:00:00Z'),
    },
  }
}

describe('sendOrQueue', () => {
  it('sends when Resend accepts', async () => {
    const h = harness([])
    const gate = new QuotaGate()
    expect(await sendOrQueue(h.deps, gate, entry('a'))).toEqual({ status: 'sent', messageId: 'msg-a' })
    expect(h.queued).toEqual([])
    expect(gate.reason).toBeNull()
  })

  it('queues a quota refusal for the next reset instead of failing', async () => {
    const h = harness([{ data: null, error: daily }])
    const gate = new QuotaGate()
    const outcome = await sendOrQueue(h.deps, gate, entry('a'))
    expect(outcome).toEqual({ status: 'queued', reason: 'daily_quota', nextAttemptAt: '2026-11-28T00:00:00.000Z' })
    expect(h.queued).toEqual([{ key: 'a', reason: 'daily_quota', at: '2026-11-28T00:00:00.000Z' }])
    expect(gate).toEqual(expect.objectContaining({ reason: 'daily_quota', queued: 1 }))
  })

  it('sends nothing more to Resend once the gate is shut', async () => {
    const h = harness([{ data: null, error: monthly }])
    const gate = new QuotaGate()
    await sendOrQueue(h.deps, gate, entry('a'))
    await sendOrQueue(h.deps, gate, entry('b'))
    await sendOrQueue(h.deps, gate, entry('c'))
    expect(h.sent).toEqual(['a'])
    expect(h.queued.map(q => [q.key, q.reason])).toEqual([['a', 'monthly_quota'], ['b', 'monthly_quota'], ['c', 'monthly_quota']])
    expect(gate.queued).toBe(3)
  })

  it('still throws any other failure, so the caller counts it as failed', async () => {
    const h = harness([{ data: null, error: invalid }])
    await expect(sendOrQueue(h.deps, new QuotaGate(), entry('a'))).rejects.toThrow('Invalid `to` field.')
    expect(h.queued).toEqual([])
  })

  it('throws when the outbox cannot take the email, rather than losing it silently', async () => {
    const h = harness([{ data: null, error: daily }])
    h.deps.queue = async () => { throw new Error('mail_outbox insert failed') }
    await expect(sendOrQueue(h.deps, new QuotaGate(), entry('a'))).rejects.toThrow('mail_outbox insert failed')
  })
})

// ── processOutbox ────────────────────────────────────────────────────────────

const row = (key: string, attempts = 0): OutboxRow => ({
  id: `id-${key}`,
  idempotency_key: key,
  report_month: '2026-11',
  purpose: 'document',
  payload: entry(key).payload,
  on_sent: null,
  attempts,
})

function memoryStore(rows: OutboxRow[], opts: { lostRace?: string[] } = {}) {
  const log: string[] = []
  const store: OutboxStore = {
    due: async () => rows,
    markSent: async id => { log.push(`sent ${id}`); return !(opts.lostRace ?? []).includes(id) },
    recordSent: async r => { log.push(`record ${r.id}`) },
    postpone: async (ids, reason, at) => { log.push(`postpone ${ids.join(',')} ${reason} ${at}`) },
    retryLater: async (id, attempts) => { log.push(`retry ${id} ${attempts}`) },
    markFailed: async (r, attempts) => { log.push(`failed ${r.id} ${attempts}`) },
    settleRuns: async () => { log.push('settle') },
  }
  return { store, log }
}

const sender = (results: Record<string, unknown>) => {
  const calls: string[] = []
  const send = async (_p: unknown, key: string) => {
    calls.push(key)
    const error = results[key]
    return error ? { data: null, error } : { data: { id: `msg-${key}` }, error: null }
  }
  return { send, calls }
}

const now = () => new Date('2026-11-28T00:10:00Z')

describe('processOutbox', () => {
  it('sends every due email under its own key, records it, then settles the runs', async () => {
    const { store, log } = memoryStore([row('a'), row('b')])
    const s = sender({})
    const result = await processOutbox(store, s.send, { now })
    expect(s.calls).toEqual(['a', 'b'])
    expect(result).toEqual({ sent: 2, failed: 0, postponed: 0, stoppedBy: null })
    expect(log).toEqual(['sent id-a', 'record id-a', 'sent id-b', 'record id-b', 'settle'])
  })

  it('records an email only once when another worker sent it first', async () => {
    const { store, log } = memoryStore([row('a')], { lostRace: ['id-a'] })
    await processOutbox(store, sender({}).send, { now })
    expect(log).toEqual(['sent id-a', 'settle'])
  })

  it('stops at a quota refusal and postpones the rest to the next reset', async () => {
    const { store, log } = memoryStore([row('a'), row('b'), row('c')])
    const s = sender({ b: daily })
    const result = await processOutbox(store, s.send, { now })
    expect(s.calls).toEqual(['a', 'b'])
    expect(result).toEqual({ sent: 1, failed: 0, postponed: 2, stoppedBy: 'daily_quota' })
    expect(log).toContain('postpone id-b,id-c daily_quota 2026-11-29T00:00:00.000Z')
  })

  it('stops at the rate limit and leaves the rest due', async () => {
    const { store, log } = memoryStore([row('a'), row('b')])
    const result = await processOutbox(store, sender({ a: rate }).send, { now })
    expect(result.stoppedBy).toBe('rate_limit')
    expect(log).toEqual(['settle'])
  })

  it('retries another failure later, and gives up after the last attempt', async () => {
    const { store, log } = memoryStore([row('a', 0), row('b', MAX_ATTEMPTS - 1)])
    const result = await processOutbox(store, sender({ a: down, b: down }).send, { now })
    expect(result).toEqual(expect.objectContaining({ sent: 0, failed: 1 }))
    expect(log).toEqual(['retry id-a 1', `failed id-b ${MAX_ATTEMPTS}`, 'settle'])
  })

  it('gives up at once on an error a retry cannot fix', async () => {
    const { store, log } = memoryStore([row('a')])
    await processOutbox(store, sender({ a: invalid }).send, { now })
    expect(log).toEqual(['failed id-a 1', 'settle'])
  })

  it('stops when its time is up', async () => {
    let t = 0
    const clock = () => new Date(Date.UTC(2026, 10, 28, 0, 10) + (t += 10_000))
    const { store } = memoryStore([row('a'), row('b'), row('c')])
    const s = sender({})
    const result = await processOutbox(store, s.send, { now: clock, deadlineMs: 15_000 })
    expect(result.stoppedBy).toBe('deadline')
    expect(s.calls.length).toBeLessThan(3)
  })
})

// ── The admin notice ─────────────────────────────────────────────────────────

const status = (over: Partial<MailQueueStatus> = {}): MailQueueStatus => ({
  queued: 0, reason: null, nextAttemptAt: null, failed: 0, operatorEmail: null, ...over,
})

describe('mailQueueNotice', () => {
  it('says nothing when nothing waits', () => {
    expect(mailQueueNotice(status())).toBeNull()
  })

  it('says how many wait and when they go out, in German', () => {
    const n = mailQueueNotice(status({ queued: 12, reason: 'daily_quota', nextAttemptAt: '2026-11-28T00:00:00.000Z' }))!
    expect(n.title).toBe('12 E-Mails warten auf den Versand')
    expect(n.body).toContain('tägliche Versandkontingent')
    expect(n.body).toContain('am 28.11.2026 um 01:10 Uhr')
    expect(n.body).toContain('nichts wird doppelt versendet')
  })

  it('does not promise a date for the monthly quota, only nightly retries', () => {
    const n = mailQueueNotice(status({ queued: 1, reason: 'monthly_quota', nextAttemptAt: '2026-11-28T00:00:00.000Z' }))!
    expect(n.title).toBe('1 E-Mail wartet auf den Versand')
    expect(n.body).toContain('monatliche Versandkontingent')
    expect(n.body).toContain('jede Nacht')
  })

  it('points to the operator for a larger plan, with the contact, and never shows a price', () => {
    const n = mailQueueNotice(status({ queued: 3, reason: 'daily_quota', nextAttemptAt: '2026-11-28T00:00:00.000Z', operatorEmail: 'betrieb@example.com' }))!
    expect(n.upgrade).toContain('Kaffeelisten')
    expect(n.upgrade).toContain('betrieb@example.com')
    for (const text of Object.values(n)) expect(String(text)).not.toMatch(/€|EUR|Euro|\$|\d+,\d{2}/)
  })

  it('works without an operator contact configured', () => {
    const n = mailQueueNotice(status({ queued: 3, reason: 'daily_quota' }))!
    expect(n.upgrade).toContain('Betreiber dieser Installation')
    expect(n.body).toContain('in der kommenden Nacht')
  })

  it('reports emails given up on', () => {
    const n = mailQueueNotice(status({ failed: 2 }))!
    expect(n.failed).toContain('2 E-Mails konnten')
  })
})
