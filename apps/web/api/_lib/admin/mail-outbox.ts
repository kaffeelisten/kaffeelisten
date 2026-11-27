// Emails held back by the sending quota (migration 043), for the admin notice.
//
//   GET  /api/admin/mail-outbox → MailQueueStatus (shared/mailQueue.ts): how many
//        emails wait, why, when they are next tried, how many were given up on,
//        and who to ask for a larger email plan.
//   POST /api/admin/mail-outbox → try every waiting email now (after the
//        operator upgraded the plan, say), then the new status.
//
// Admin-only. Sending is still the nightly cron's job (api/cron/mail-outbox.ts);
// this only lets the admin not wait for it. Every retry reuses the email's
// original idempotency key, so trying early can never send anything twice.

import type { VercelRequest, VercelResponse } from '@vercel/node'
import { makeAdminClient, requireAdmin } from '../adminAuth'
import { classifyServerError } from '../errors'
import { mailerSend, processOutbox, readMailQueueStatus, supabaseOutboxStore } from '../outbox'

// The admin function shares the platform default duration; stop early.
const DEADLINE_MS = 20_000

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const auth = await requireAdmin(req.headers)
    if (!auth.ok) return res.status(auth.status).json({ error: auth.error })

    const supabase = makeAdminClient()
    if (req.method === 'POST') {
      const resendKey = process.env.RESEND_API_KEY
      if (!resendKey) throw new Error('Missing RESEND_API_KEY')
      const result = await processOutbox(supabaseOutboxStore(supabase), mailerSend(resendKey), {
        all: true,
        deadlineMs: DEADLINE_MS,
        limit: 50,
      })
      const status = await readMailQueueStatus(supabase)
      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).json({ ...status, sent: result.sent })
    }

    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json(await readMailQueueStatus(supabase))
  } catch (err) {
    console.error('[admin/mail-outbox]', err instanceof Error ? err.message : err)
    const { status, error } = classifyServerError(err)
    return res.status(status).json({ error })
  }
}
