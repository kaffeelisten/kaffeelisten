import type { VercelRequest, VercelResponse } from '@vercel/node'
import { createClient } from '@supabase/supabase-js'
import { mailerSend, processOutbox, supabaseOutboxStore } from '../_lib/outbox'
import { databaseConfigError, isDemoDeployment } from '../../shared/environment'

// Sends the emails the sending quota held back (migration 043). Fires nightly a
// few minutes after midnight UTC, when Resend resets the free plan's daily quota
// (vercel.json; keep OUTBOX_CRON_DELAY_MINUTES in shared/mailQueue.ts in step).
// Uses the same CRON_SECRET check as the monthly report and changes nothing
// about how it is set: an instance without it simply never runs this.
export const config = { maxDuration: 300 }

// Leave room under maxDuration for settling the runs after the last send.
const DEADLINE_MS = 270_000

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // The demo never sends mail, so it has nothing queued.
  if (isDemoDeployment(process.env.DEMO_MODE)) {
    return res.status(410).json({ error: 'Diese Funktion ist in der Demo nicht verfügbar.' })
  }
  const cronSecret = process.env.CRON_SECRET
  const authHeader = req.headers['authorization']
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const url = process.env.VITE_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    const resendKey = process.env.RESEND_API_KEY
    if (!url || !key) throw new Error('Missing VITE_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
    if (!resendKey) throw new Error('Missing RESEND_API_KEY')
    const envError = databaseConfigError(url, process.env.VERCEL_ENV)
    if (envError) throw new Error(envError)

    const result = await processOutbox(supabaseOutboxStore(createClient(url, key)), mailerSend(resendKey), { deadlineMs: DEADLINE_MS })
    return res.status(200).json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('[cron/mail-outbox]', message)
    return res.status(500).json({ error: message })
  }
}
