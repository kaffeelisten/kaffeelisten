// Shared mail helpers.

import { Resend } from 'resend'
import { filterRecipients, isDemoDeployment, isExactlyAllowed, isProductionDeployment, subjectFor } from '../../shared/environment'
import { BLOCKED_MESSAGE_ID } from '../../shared/reportProgress'

/**
 * Reply-to for all outgoing mail. A from-address (bericht@kaffeelisten.de) that
 * bounces replies hurts deliverability and trust, so every send points replies
 * at the first configured admin address. Returns undefined when ADMIN_EMAIL is
 * unset, in which case callers simply omit reply_to.
 */
export function replyTo(): string | undefined {
  const first = process.env.ADMIN_EMAIL?.split(',')[0]?.trim()
  return first || undefined
}


type SendArgs = Parameters<Resend['emails']['send']>
type SendResult = Awaited<ReturnType<Resend['emails']['send']>>
export type SendPayload = SendArgs[0]

/**
 * What a failed Resend send means for the caller.
 *
 * Resend answers HTTP 429 for three different things (resend.com/docs/api-reference/errors):
 * - `rate_limit_exceeded`: more than 10 requests per second. Clears in seconds.
 * - `daily_quota_exceeded`: the free plan's 100 emails per UTC day. Resets at midnight UTC.
 * - `monthly_quota_exceeded`: the plan's monthly emails. Resets with the plan period.
 * Resend does not queue a send it refused for quota, so the email was not sent and
 * must be sent again later. Anything else is an ordinary failure.
 */
export type MailErrorKind = 'daily_quota' | 'monthly_quota' | 'rate_limit' | 'other'
export type QuotaReason = Extract<MailErrorKind, 'daily_quota' | 'monthly_quota'>

export function classifyResendError(error: unknown): MailErrorKind {
  if (!error || typeof error !== 'object') return 'other'
  const { name, statusCode } = error as { name?: unknown; statusCode?: unknown }
  const n = typeof name === 'string' ? name : ''
  if (n === 'daily_quota_exceeded') return 'daily_quota'
  if (n === 'monthly_quota_exceeded') return 'monthly_quota'
  if (n === 'rate_limit_exceeded') return 'rate_limit'
  // An undocumented 429: a quota if its name says so, otherwise the per-second limit.
  if (statusCode === 429) {
    if (/month/i.test(n) && /quota/i.test(n)) return 'monthly_quota'
    if (/quota/i.test(n)) return 'daily_quota'
    return 'rate_limit'
  }
  return 'other'
}

export function isQuotaError(kind: MailErrorKind): kind is QuotaReason {
  return kind === 'daily_quota' || kind === 'monthly_quota'
}

/** Thrown by a send that Resend refused for quota, so callers can queue instead of fail. */
export class MailQuotaError extends Error {
  constructor(readonly reason: QuotaReason, message: string) {
    super(message)
    this.name = 'MailQuotaError'
  }
}

const RATE_LIMIT_DELAYS_MS = [1000, 2000, 4000]

/**
 * Resend allows 10 requests per second per team. A monthly run sends one email
 * at a time, but a re-send or a second tab can push past that; a 429 used to
 * count the document as failed. Retry it with backoff – the idempotency key on
 * every send makes a retry safe. Quota errors (daily/monthly limit reached) are
 * not retried: waiting seconds does not help. They go to the outbox (outbox.ts).
 */
export async function retryRateLimited(
  attempt: () => Promise<SendResult>,
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms)),
): Promise<SendResult> {
  let result = await attempt()
  for (const delay of RATE_LIMIT_DELAYS_MS) {
    if (classifyResendError(result.error) !== 'rate_limit') return result
    console.warn(`[mail] rate limited by Resend, retrying in ${delay} ms`)
    await sleep(delay)
    result = await attempt()
  }
  return result
}

/**
 * The only way the API creates a Resend client. Outside production (VERCEL_ENV)
 * recipients not on MAIL_ALLOWLIST (default example.com) are dropped and the
 * subject is prefixed "[STAGING]", so a preview can never email a real person.
 * When every recipient is dropped the send is skipped and reported as delivered
 * with a recognisable id, so staging runs complete end to end.
 */
export function makeMailer(apiKey: string, env: NodeJS.ProcessEnv = process.env): Resend {
  const resend = new Resend(apiKey)
  const send = resend.emails.send.bind(resend.emails)
  resend.emails.send = async (...args: SendArgs): Promise<SendResult> => {
    const [payload, options] = args
    // The demo is public and must not be able to reach anyone, so it never
    // sends at all. This is deliberately ahead of the allowlist: the allowlist
    // narrows recipients, while the demo has no legitimate recipient of any
    // kind. Reported as delivered with the blocked id so callers still complete.
    if (isDemoDeployment(env.DEMO_MODE)) {
      console.warn('[mail-guard] demo deployment: send suppressed')
      return { data: { id: BLOCKED_MESSAGE_ID }, error: null, headers: null } as SendResult
    }
    const r = filterRecipients(payload, env.VERCEL_ENV, env.MAIL_ALLOWLIST)
    if (r.blocked.length) console.warn('[mail-guard] blocked outside production:', r.blocked.join(', '))
    if (r.to.length === 0) {
      return { data: { id: BLOCKED_MESSAGE_ID }, error: null, headers: null } as SendResult
    }
    // MAIL_SINK (non-production only): mail for domain-allowed test addresses
    // (example.com) goes to one test inbox such as Resend's delivered@resend.dev,
    // because those addresses would bounce and hurt the sending domain's
    // reputation. Addresses the allowlist names exactly are real test inboxes and
    // receive the email themselves.
    const sink = !isProductionDeployment(env.VERCEL_ENV) ? env.MAIL_SINK?.trim() : undefined
    const direct = (xs: string[]) => (sink ? xs.filter(x => isExactlyAllowed(x, env.MAIL_ALLOWLIST)) : xs)
    const sunk = sink ? [...r.to, ...r.cc, ...r.bcc].filter(x => !isExactlyAllowed(x, env.MAIL_ALLOWLIST)) : []
    const to = [...direct(r.to), ...(sunk.length ? [sink!] : [])]
    const cc = direct(r.cc)
    const bcc = direct(r.bcc)
    const subject = payload.subject === undefined
      ? undefined
      : subjectFor(sunk.length ? `${payload.subject} (an: ${sunk.join(', ')})` : payload.subject, env.VERCEL_ENV)
    const guarded = {
      ...payload,
      to: to.length ? to : [sink!],
      cc: cc.length ? cc : undefined,
      bcc: bcc.length ? bcc : undefined,
      ...(subject !== undefined ? { subject } : {}),
    } as SendArgs[0]
    return retryRateLimited(() => send(guarded, options))
  }
  return resend
}
