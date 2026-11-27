// The monthly run against a Resend account that runs out of quota part-way:
// the real runMonthlyReport and the real outbox, an in-memory database and a
// capturing email provider that starts refusing with daily_quota_exceeded.
//
// It proves the three promises of migration 043: a quota refusal is queued, not
// counted as failed; the run is not recorded as completed while emails wait; and
// the retry sends each waiting email once, under its original idempotency key.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeClient, type FakeDb } from './support/fakeSupabase'
import { summariseProgress, type ProgressRun } from '../shared/reportProgress'

process.env.VERCEL_ENV = 'production'

type Sent = { to: string[]; subject: string; idempotencyKey: string }

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  // Every email Resend accepted, with the key it was sent under.
  accepted: [] as Sent[],
  refused: 0,
  // Accept this many in total, then refuse every send for quota. Null: no limit.
  quotaAfter: null as number | null,
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => createFakeClient(state.db),
}))

vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (payload: { to: string[]; subject: string }, options: { idempotencyKey: string }) => {
        if (state.quotaAfter !== null && state.accepted.length >= state.quotaAfter) {
          state.refused++
          return {
            data: null,
            error: { name: 'daily_quota_exceeded', statusCode: 429, message: 'You have exceeded your daily email sending quota.' },
            headers: null,
          }
        }
        state.accepted.push({ to: payload.to, subject: payload.subject, idempotencyKey: options.idempotencyKey })
        return { data: { id: `msg-${state.accepted.length}` }, error: null, headers: null }
      },
    }
  },
}))

vi.mock('../api/_lib/pdf', () => ({
  launchBrowser: async () => ({ close: async () => undefined }),
  pageToPdf: async (_browser: unknown, html: string) => Buffer.from(`%PDF stub ${html.length}`),
}))

vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
  fn()
  return 0
}) as unknown as typeof setTimeout)

const { runMonthlyReport } = await import('../api/_lib/report')
const { processOutbox, supabaseOutboxStore, mailerSend } = await import('../api/_lib/outbox')

function seed(): FakeDb {
  return {
    tables: {
      app_settings: [{
        id: 1,
        report_recipients: ['admin@itc1.de'],
        ceo_email: 'ceo@itc1.de',
        cc_ceo_on_reports: false,
        member_statements_enabled: true,
        company_documents_enabled: true,
        company_paid_member_reports_enabled: true,
        auto_report_enabled: true,
        auto_report_day: null,
        report_accent: '#D97706',
        report_subject: null, report_intro: null,
        report_include_pdf: true, report_include_excel: true,
        member_subject: null, member_intro: null,
        issue_invoices: false,
        invoice_mode_authorized: false,
        invoice_vat_rate: 19,
      }],
      app_theme: [],
      companies: [
        { id: 'c-efco', name: 'EFCO', billing_mode: 'individual', billing_contact_name: 'Eva', billing_contact_email: 'billing@efco.de', member_document_copies_enabled: false, checkout_mode: 'member' },
      ],
      members: [
        { id: 'm-shen', company_id: 'c-efco', name: 'Shen Li', work_email: 'shen@efco.de', kind: 'person' },
        { id: 'm-bettina', company_id: 'c-efco', name: 'Bettina Roth', work_email: 'bettina@efco.de', kind: 'person' },
        { id: 'm-jonas', company_id: 'c-efco', name: 'Jonas Bauer', work_email: 'jonas@efco.de', kind: 'person' },
      ],
      items: [{ id: 'i-esp', name: 'Espresso', unit_label: 'Tasse', price_cents: 50, category: 'coffee' }],
      transactions: [
        { id: 't1', member_id: 'm-shen', company_id: 'c-efco', item_id: 'i-esp', quantity: 2, unit_price_cents: 50, logged_at: '2026-08-04T08:00:00.000Z' },
        { id: 't2', member_id: 'm-bettina', company_id: 'c-efco', item_id: 'i-esp', quantity: 1, unit_price_cents: 50, logged_at: '2026-08-05T08:00:00.000Z' },
        { id: 't3', member_id: 'm-jonas', company_id: 'c-efco', item_id: 'i-esp', quantity: 3, unit_price_cents: 50, logged_at: '2026-08-06T08:00:00.000Z' },
      ],
      transactions_archive: [],
      report_runs: [],
      billing_runs: [],
      billing_documents: [],
      document_deliveries: [],
      mail_outbox: [],
    },
    rpc: { prune_reported_transactions: () => 0 },
  }
}

const run = () => state.db.tables.report_runs[0]
const outbox = () => state.db.tables.mail_outbox
const store = () => supabaseOutboxStore(createFakeClient(state.db) as never)
// Three statements, the company statement, the report and the CEO archive.
const PLANNED_EMAILS = 6

beforeEach(() => {
  state.db = seed()
  state.accepted = []
  state.refused = 0
  state.quotaAfter = null
  process.env.RESEND_API_KEY = 'test'
  process.env.VITE_SUPABASE_URL = 'http://fake'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake'
})

describe('monthly run under the sending quota', () => {
  it('completes as before when the quota is not reached', async () => {
    const result = await runMonthlyReport('2026-08')
    expect(result.queued).toBeUndefined()
    expect(state.accepted).toHaveLength(PLANNED_EMAILS)
    expect(run().status).toBe('completed')
    expect(outbox()).toHaveLength(0)
  })

  it('queues what the quota refused, and does not record the month completed', async () => {
    state.quotaAfter = 2
    const result = await runMonthlyReport('2026-08')

    expect(result.status).toBe('sent')
    expect(result.memberStatements).toEqual(expect.objectContaining({ sent: 2, failed: 0, queued: 2 }))
    expect(result.queued).toEqual(expect.objectContaining({ count: 4, reason: 'daily_quota' }))
    // Midnight UTC after now: when Resend resets the daily quota.
    expect(result.queued!.nextAttemptAt).toMatch(/T00:00:00\.000Z$/)

    expect(run().status).toBe('queued')
    expect(run().completed_at).toBeUndefined()
    const progress = summariseProgress(run() as unknown as ProgressRun, state.db.tables.document_deliveries as never, [])
    expect(progress.status).toBe('queued')
    expect(progress.phase).toBe('queued')
    expect(progress.queued).toBe(4)
    expect(progress.failed).toBe(0)
    expect(progress.report.queued).toBe(true)

    // Only the first refusal reached Resend; the rest went straight to the outbox.
    expect(state.refused).toBe(1)
    expect(outbox().map(r => r.purpose).sort()).toEqual(['archive', 'document', 'document', 'report'])
    expect(outbox().every(r => r.status === 'queued' && r.payload !== null)).toBe(true)
    // The month is archived all the same: its documents are issued.
    expect(state.db.tables.transactions_archive).toHaveLength(3)
  })

  it('sends every queued email once after the reset, under its original key, and completes the run', async () => {
    state.quotaAfter = 2
    await runMonthlyReport('2026-08')
    const queuedKeys = outbox().map(r => r.idempotency_key)

    state.quotaAfter = null
    const tomorrow = () => new Date(Date.now() + 25 * 60 * 60 * 1000)
    const result = await processOutbox(store(), mailerSend('test'), { now: tomorrow })

    expect(result).toEqual(expect.objectContaining({ sent: 4, failed: 0, stoppedBy: null }))
    expect(state.accepted.slice(2).map(s => s.idempotencyKey).sort()).toEqual([...queuedKeys].sort())
    // Every planned email went out exactly once.
    const keys = state.accepted.map(s => s.idempotencyKey)
    expect(keys).toHaveLength(PLANNED_EMAILS)
    expect(new Set(keys).size).toBe(PLANNED_EMAILS)

    expect(outbox().every(r => r.status === 'sent' && r.payload === null && r.resend_message_id)).toBe(true)
    // Queued documents are recorded when they actually go out.
    expect(state.db.tables.document_deliveries).toHaveLength(4)
    expect(run().status).toBe('completed')
    const progress = summariseProgress(run() as unknown as ProgressRun, state.db.tables.document_deliveries as never, [])
    expect(progress.report.sent).toBe(true)
    expect(progress.archive.sent).toBe(true)
    expect(progress.queued).toBe(0)

    // A second pass finds nothing to do.
    expect(await processOutbox(store(), mailerSend('test'), { now: tomorrow })).toEqual(expect.objectContaining({ sent: 0 }))
    expect(state.accepted).toHaveLength(PLANNED_EMAILS)
  })

  it('does not try before the quota resets, and postpones when still over it', async () => {
    state.quotaAfter = 2
    await runMonthlyReport('2026-08')

    expect(await processOutbox(store(), mailerSend('test'))).toEqual(expect.objectContaining({ sent: 0, postponed: 0 }))
    expect(state.refused).toBe(1)

    const tomorrow = () => new Date(Date.now() + 25 * 60 * 60 * 1000)
    const again = await processOutbox(store(), mailerSend('test'), { now: tomorrow })
    expect(again).toEqual(expect.objectContaining({ sent: 0, postponed: 4, stoppedBy: 'daily_quota' }))
    expect(run().status).toBe('queued')
  })

  it('refuses a forced re-send while the month still has queued emails', async () => {
    state.quotaAfter = 2
    await runMonthlyReport('2026-08')
    state.quotaAfter = null
    const before = state.accepted.length

    const result = await runMonthlyReport('2026-08', { force: true })
    expect(result).toEqual({ status: 'skipped', skipReason: 'queued' })
    expect(state.accepted).toHaveLength(before)
  })
})
