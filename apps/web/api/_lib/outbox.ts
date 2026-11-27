// The mail outbox (migration 043): emails Resend refused because the sending
// quota was reached, sent again once it resets.
//
// Why it exists: on Resend's free plan an account may send 100 emails per UTC
// day and 3,000 per month. A monthly run of a few hundred documents, or an admin
// re-sending documents by hand, can reach either. Resend does not queue a send it
// refused for quota, and the run used to count it as failed and still record the
// month as completed.
//
// Never twice: a queued row keeps the exact payload and the idempotency key of
// its first attempt. The first attempt was refused, so nothing went out; the
// retry sends the same payload under the same key, so if two workers retry at
// once Resend returns the same message for both, and only the worker that flips
// the row to `sent` records it.

import type { SupabaseClient } from '@supabase/supabase-js'
import { markBillingDocumentFailed, markBillingDocumentSent } from './billing'
import { classifyResendError, isQuotaError, makeMailer, type QuotaReason, type SendPayload } from './mail'
import { nextQuotaAttempt, type MailQueueStatus } from '../../shared/mailQueue'
import { readStoredProgress } from '../../shared/reportProgress'

export type OutboxPurpose = 'document' | 'report' | 'archive' | 'resend'

// A document_deliveries row (migration 037) minus what the send itself supplies.
export interface DeliveryRecord {
  report_month: string
  kind: string
  company_id: string
  member_id: string | null
  recipient_name: string
  recipient_email: string
  document_number: string | null
  billing_document_id: string | null
  gross_cents: number
  has_pdf: boolean
  has_xlsx: boolean
  resend_of?: string | null
}

// What to record once a queued email has gone out.
export type OnSent =
  | { kind: 'delivery'; delivery: DeliveryRecord; markInvoiceSent: boolean }
  | { kind: 'run_email'; slot: 'report' | 'archive' }

export interface OutboxEntry {
  idempotencyKey: string
  reportMonth: string | null
  purpose: OutboxPurpose
  payload: SendPayload
  onSent: OnSent | null
}

export type SendOutcome =
  | { status: 'sent'; messageId: string | null }
  | { status: 'queued'; reason: QuotaReason; nextAttemptAt: string }

type SendFn = (payload: SendPayload, idempotencyKey: string) => Promise<{
  data: { id: string } | null
  error: unknown
}>

export type QueueFn = (entry: OutboxEntry, reason: QuotaReason, nextAttemptAt: string) => Promise<void>

/**
 * Remembers the first quota refusal of a run. Every later email of the run goes
 * straight to the outbox: the quota will not come back within the run, and each
 * refused call would still count against the per-second rate limit.
 */
export class QuotaGate {
  reason: QuotaReason | null = null
  nextAttemptAt: string | null = null
  queued = 0
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return JSON.stringify(error)
}

/**
 * Send an email, or queue it when the quota is reached. Any other failure is
 * thrown, as before, so the caller counts it as failed.
 */
export async function sendOrQueue(
  deps: { send: SendFn; queue: QueueFn; now?: () => Date },
  gate: QuotaGate,
  entry: OutboxEntry,
): Promise<SendOutcome> {
  const now = deps.now ?? (() => new Date())
  const queue = async (reason: QuotaReason): Promise<SendOutcome> => {
    const nextAttemptAt = gate.nextAttemptAt ?? nextQuotaAttempt(now()).toISOString()
    await deps.queue(entry, reason, nextAttemptAt)
    gate.reason = reason
    gate.nextAttemptAt = nextAttemptAt
    gate.queued++
    return { status: 'queued', reason, nextAttemptAt }
  }
  if (gate.reason) return queue(gate.reason)
  const { data, error } = await deps.send(entry.payload, entry.idempotencyKey)
  if (!error) return { status: 'sent', messageId: data?.id ?? null }
  const kind = classifyResendError(error)
  if (isQuotaError(kind)) {
    console.warn(`[outbox] ${kind} reached, queueing ${entry.purpose} for ${entry.payload.to}`)
    return queue(kind)
  }
  throw new Error(errorMessage(error))
}

// ─── Retrying ────────────────────────────────────────────────────────────────

export interface OutboxRow {
  id: string
  idempotency_key: string
  report_month: string | null
  purpose: OutboxPurpose
  payload: SendPayload
  on_sent: OnSent | null
  attempts: number
}

export interface OutboxStore {
  /** Queued rows, oldest first: only those due unless `all` (an admin's "try now"). */
  due(now: Date, all: boolean, limit: number): Promise<OutboxRow[]>
  /** Flip to sent. False when another worker already did, so it is recorded once. */
  markSent(id: string, messageId: string | null): Promise<boolean>
  recordSent(row: OutboxRow, messageId: string | null): Promise<void>
  postpone(ids: string[], reason: QuotaReason, nextAttemptAt: string): Promise<void>
  retryLater(id: string, attempts: number, nextAttemptAt: string, error: string): Promise<void>
  markFailed(row: OutboxRow, attempts: number, error: string): Promise<void>
  /** Complete every queued monthly run whose emails have all gone out. */
  settleRuns(): Promise<void>
}

// A non-quota failure is tried again an hour later (in practice the next cron),
// up to this many attempts in all.
export const MAX_ATTEMPTS = 5
const RETRY_DELAY_MS = 60 * 60 * 1000
// Errors a retry cannot fix.
const PERMANENT = new Set(['validation_error', 'invalid_idempotent_request', 'invalid_idempotency_key', 'invalid_from_address', 'invalid_attachment'])

export interface ProcessResult {
  sent: number
  failed: number
  postponed: number
  stoppedBy: QuotaReason | 'rate_limit' | 'deadline' | null
}

export async function processOutbox(
  store: OutboxStore,
  send: SendFn,
  opts: { now?: () => Date; deadlineMs?: number; limit?: number; all?: boolean } = {},
): Promise<ProcessResult> {
  const now = opts.now ?? (() => new Date())
  const started = now().getTime()
  const rows = await store.due(now(), opts.all ?? false, opts.limit ?? 200)
  const result: ProcessResult = { sent: 0, failed: 0, postponed: 0, stoppedBy: null }

  for (let i = 0; i < rows.length; i++) {
    if (opts.deadlineMs !== undefined && now().getTime() - started > opts.deadlineMs) {
      result.stoppedBy = 'deadline'
      break
    }
    const row = rows[i]
    const { data, error } = await send(row.payload, row.idempotency_key)
    if (!error) {
      const messageId = data?.id ?? null
      if (await store.markSent(row.id, messageId)) await store.recordSent(row, messageId)
      result.sent++
      continue
    }
    const kind = classifyResendError(error)
    if (isQuotaError(kind)) {
      // Still over quota: this row and every one after it wait for the next reset.
      const rest = rows.slice(i).map(r => r.id)
      await store.postpone(rest, kind, nextQuotaAttempt(now()).toISOString())
      result.postponed += rest.length
      result.stoppedBy = kind
      break
    }
    if (kind === 'rate_limit') {
      // Already retried with backoff by the mailer; the rest stay due for next time.
      result.stoppedBy = 'rate_limit'
      break
    }
    const attempts = row.attempts + 1
    const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : ''
    const message = errorMessage(error)
    if (attempts >= MAX_ATTEMPTS || PERMANENT.has(name)) {
      await store.markFailed(row, attempts, message)
      result.failed++
    } else {
      await store.retryLater(row.id, attempts, new Date(now().getTime() + RETRY_DELAY_MS).toISOString(), message)
    }
  }

  await store.settleRuns()
  return result
}

// ─── Supabase ────────────────────────────────────────────────────────────────

/** Queue an email. A key already queued is left as it is (unique idempotency_key). */
export function queueTo(supabase: SupabaseClient): QueueFn {
  return async (entry, reason, nextAttemptAt) => {
    const to = entry.payload.to
    const { error } = await supabase.from('mail_outbox').upsert(
      {
        idempotency_key: entry.idempotencyKey,
        report_month: entry.reportMonth,
        purpose: entry.purpose,
        recipient: Array.isArray(to) ? to.join(', ') : to,
        payload: entry.payload,
        on_sent: entry.onSent,
        status: 'queued',
        attempts: 0,
        reason,
        next_attempt_at: nextAttemptAt,
      },
      { onConflict: 'idempotency_key', ignoreDuplicates: true },
    )
    if (error) throw new Error(`mail_outbox insert failed: ${error.message}`)
  }
}

/** Resend through the guarded mailer (staging allowlist, demo block). */
export function mailerSend(apiKey: string): SendFn {
  const resend = makeMailer(apiKey)
  return async (payload, idempotencyKey) => {
    const { data, error } = await resend.emails.send(payload, { idempotencyKey })
    return { data: data ? { id: data.id } : null, error }
  }
}

async function updateRunProgress(
  supabase: SupabaseClient,
  month: string,
  change: (progress: NonNullable<ReturnType<typeof readStoredProgress>>) => void,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { data: run, error } = await supabase.from('report_runs').select('progress').eq('report_month', month).maybeSingle()
  if (error || !run) return
  const progress = readStoredProgress(run.progress)
  if (!progress) return
  change(progress)
  const { error: upErr } = await supabase
    .from('report_runs')
    .update({ progress, updated_at: new Date().toISOString(), ...extra })
    .eq('report_month', month)
  if (upErr) console.error('[outbox] run progress not saved:', upErr.message)
}

export function supabaseOutboxStore(supabase: SupabaseClient): OutboxStore {
  const touch = () => new Date().toISOString()
  return {
    async due(now, all, limit) {
      let q = supabase
        .from('mail_outbox')
        .select('id, idempotency_key, report_month, purpose, payload, on_sent, attempts')
        .eq('status', 'queued')
      if (!all) q = q.lte('next_attempt_at', now.toISOString())
      const { data, error } = await q.order('created_at').order('id').limit(limit)
      if (error) throw new Error(`mail_outbox read failed: ${error.message}`)
      return (data ?? []) as OutboxRow[]
    },

    async markSent(id, messageId) {
      const now = touch()
      const { data, error } = await supabase
        .from('mail_outbox')
        .update({ status: 'sent', sent_at: now, updated_at: now, resend_message_id: messageId, payload: null, last_error: null })
        .eq('id', id)
        .eq('status', 'queued')
        .select('id')
      if (error) {
        // The email went out; failing to flip the row only risks a replay, which
        // the idempotency key turns into the same message. Log and do not record.
        console.error('[outbox] sent but not marked:', error.message)
        return false
      }
      return (data ?? []).length > 0
    },

    async recordSent(row, messageId) {
      const onSent = row.on_sent
      if (!onSent) return
      if (onSent.kind === 'delivery') {
        if (onSent.markInvoiceSent && onSent.delivery.billing_document_id) {
          await markBillingDocumentSent(supabase, onSent.delivery.billing_document_id, messageId)
        }
        const { error } = await supabase.from('document_deliveries').insert({ ...onSent.delivery, resend_message_id: messageId })
        if (error) console.error(`[outbox] delivered but not recorded for ${onSent.delivery.recipient_email}:`, error.message)
        return
      }
      if (row.report_month) {
        await updateRunProgress(supabase, row.report_month, p => {
          p[onSent.slot] = { planned: true, sent: true, queued: false, messageId }
        })
      }
    },

    async postpone(ids, reason, nextAttemptAt) {
      for (let i = 0; i < ids.length; i += 100) {
        const { error } = await supabase
          .from('mail_outbox')
          .update({ reason, next_attempt_at: nextAttemptAt, updated_at: touch() })
          .in('id', ids.slice(i, i + 100))
          .eq('status', 'queued')
        if (error) console.error('[outbox] could not postpone:', error.message)
      }
    },

    async retryLater(id, attempts, nextAttemptAt, message) {
      const { error } = await supabase
        .from('mail_outbox')
        .update({ attempts, next_attempt_at: nextAttemptAt, last_error: message.slice(0, 500), updated_at: touch() })
        .eq('id', id)
        .eq('status', 'queued')
      if (error) console.error('[outbox] could not reschedule:', error.message)
    },

    async markFailed(row, attempts, message) {
      const { data, error } = await supabase
        .from('mail_outbox')
        .update({ status: 'failed', attempts, last_error: message.slice(0, 500), updated_at: touch() })
        .eq('id', row.id)
        .eq('status', 'queued')
        .select('id')
      if (error || !(data ?? []).length) return
      console.error(`[outbox] gave up on ${row.purpose} ${row.idempotency_key}: ${message}`)
      const onSent = row.on_sent
      if (onSent?.kind === 'delivery' && onSent.markInvoiceSent && onSent.delivery.billing_document_id) {
        await markBillingDocumentFailed(supabase, onSent.delivery.billing_document_id)
      }
      if (row.report_month && row.purpose !== 'resend') {
        await updateRunProgress(supabase, row.report_month, p => {
          p.failed++
          if (onSent?.kind === 'run_email') p[onSent.slot].queued = false
        })
      }
    },

    async settleRuns() {
      const { data: runs, error } = await supabase.from('report_runs').select('report_month').eq('status', 'queued')
      if (error) throw new Error(`report_runs read failed: ${error.message}`)
      for (const { report_month: month } of (runs ?? []) as { report_month: string }[]) {
        const { count, error: cErr } = await supabase
          .from('mail_outbox')
          .select('id', { count: 'exact', head: true })
          .eq('report_month', month)
          .eq('status', 'queued')
          .neq('purpose', 'resend')
        if (cErr) throw new Error(`mail_outbox count failed: ${cErr.message}`)
        const waiting = count ?? 0
        if (waiting > 0) {
          await updateRunProgress(supabase, month, p => { p.queued = waiting })
        } else {
          const now = touch()
          await updateRunProgress(supabase, month, p => { p.queued = 0; p.phase = 'done' }, { status: 'completed', completed_at: now })
        }
      }
    },
  }
}

// ─── Status for the admin notice ─────────────────────────────────────────────

export async function readMailQueueStatus(supabase: SupabaseClient, env: NodeJS.ProcessEnv = process.env): Promise<MailQueueStatus> {
  const { count: queued, error: qErr } = await supabase
    .from('mail_outbox')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'queued')
  if (qErr) throw new Error(qErr.message)

  const { data: next, error: nErr } = await supabase
    .from('mail_outbox')
    .select('reason, next_attempt_at')
    .eq('status', 'queued')
    .order('next_attempt_at')
    .limit(1)
  if (nErr) throw new Error(nErr.message)

  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const { count: failed, error: fErr } = await supabase
    .from('mail_outbox')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'failed')
    .gte('updated_at', since)
  if (fErr) throw new Error(fErr.message)

  const first = (next ?? [])[0] as { reason: QuotaReason; next_attempt_at: string } | undefined
  return {
    queued: queued ?? 0,
    reason: first?.reason ?? null,
    nextAttemptAt: first?.next_attempt_at ?? null,
    failed: failed ?? 0,
    operatorEmail: env.OPERATOR_CONTACT_EMAIL?.trim() || null,
  }
}
