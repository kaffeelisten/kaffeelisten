// Emails held back by the email provider's sending quota (migration 043), shared
// by the API (api/_lib/outbox.ts) and the admin notice (MailQueueNotice.tsx).
//
// On Resend's free plan the daily quota resets at midnight UTC. The monthly
// quota's reset date is not documented for the free plan, so a month-quota row
// is simply tried again every night until it goes through.

export type QuotaReason = 'daily_quota' | 'monthly_quota'

export interface MailQueueStatus {
  // Emails waiting in the outbox.
  queued: number
  // Why the earliest waiting email is waiting, and when it is next tried.
  reason: QuotaReason | null
  nextAttemptAt: string | null
  // Emails given up on in the last 30 days (a non-quota error, five times over).
  failed: number
  // Who to ask for a larger email plan. Unset on an instance without an operator.
  operatorEmail: string | null
}

export function emptyMailQueueStatus(): MailQueueStatus {
  return { queued: 0, reason: null, nextAttemptAt: null, failed: 0, operatorEmail: null }
}

/** The next midnight UTC after `now`, when Resend resets the daily quota. */
export function nextQuotaAttempt(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

// The outbox cron runs a few minutes after the reset (vercel.json). Keep in step.
export const OUTBOX_CRON_DELAY_MINUTES = 10

const berlinDate = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', year: 'numeric' })
const berlinTime = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' })

/** "28.11.2026 um 01:10 Uhr": when the cron will next try, in campus time. */
export function formatNextAttempt(iso: string): string {
  const at = new Date(new Date(iso).getTime() + OUTBOX_CRON_DELAY_MINUTES * 60_000)
  return `${berlinDate.format(at)} um ${berlinTime.format(at)} Uhr`
}

export interface MailQueueNoticeText {
  title: string
  body: string
  upgrade: string
  failed: string | null
}

const emails = (n: number) => (n === 1 ? '1 E-Mail' : `${n} E-Mails`)

/** The admin notice, German. Null when there is nothing to say. No prices: the operator quotes them. */
export function mailQueueNotice(status: MailQueueStatus): MailQueueNoticeText | null {
  if (status.queued === 0 && status.failed === 0) return null
  const failed = status.failed > 0
    ? `${status.failed === 1 ? '1 E-Mail konnte' : `${status.failed} E-Mails konnten`} auch nach mehreren Versuchen nicht versendet werden. Unter „Dokumente“ lassen sich Dokumente einzeln erneut senden.`
    : null
  const when = status.nextAttemptAt ? formatNextAttempt(status.nextAttemptAt) : null
  const body = status.queued === 0
    ? 'Es warten keine E-Mails mehr auf den Versand.'
    : status.reason === 'monthly_quota'
      ? `Das monatliche Versandkontingent des E-Mail-Dienstes ist aufgebraucht. Die E-Mails werden jede Nacht automatisch erneut versucht${when ? `, zuerst am ${when}` : ''}, und gehen raus, sobald wieder Kontingent frei ist. Nichts geht verloren und nichts wird doppelt versendet.`
      : `Das tägliche Versandkontingent des E-Mail-Dienstes ist erreicht. Die E-Mails gehen automatisch ${when ? `am ${when}` : 'in der kommenden Nacht'} raus. Nichts geht verloren und nichts wird doppelt versendet.`
  const upgrade = status.operatorEmail
    ? `Fallen regelmäßig mehr E-Mails an, stellt Kaffeelisten als Betreiber ein größeres E-Mail-Paket bereit. Kontakt: ${status.operatorEmail}`
    : 'Fallen regelmäßig mehr E-Mails an, stellt Kaffeelisten als Betreiber dieser Installation ein größeres E-Mail-Paket bereit.'
  return {
    title: status.queued > 0 ? `${emails(status.queued)} ${status.queued === 1 ? 'wartet' : 'warten'} auf den Versand` : 'E-Mail-Versand',
    body,
    upgrade,
    failed,
  }
}
