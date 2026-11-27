import { useCallback, useEffect, useState } from 'react'
import AdminButton from './AdminButton'
import AdminIcon from './AdminIcon'
import { adminApi } from '../../lib/adminApi'
import { mailQueueNotice, type MailQueueStatus } from '../../../shared/mailQueue'

// Shown above every admin page while emails wait for the email provider's
// sending quota to reset (migration 043): how many, when they go out, and that a
// larger email plan is available from the operator. No prices: the operator
// quotes them.
//
// Every piece of text sits in its own element, for the same reason as in
// ReportSendDialog: browser translation replaces bare text nodes.

export interface MailQueueNoticeViewProps {
  status: MailQueueStatus | null
  retrying: boolean
  onRetry: () => void
}

export function MailQueueNoticeView({ status, retrying, onRetry }: MailQueueNoticeViewProps) {
  const text = status ? mailQueueNotice(status) : null
  if (!status || !text) return null
  return (
    <section
      aria-label="E-Mail-Versand"
      className="mx-4 mt-4 md:mx-8 rounded-xl border border-accent bg-accent-subtle px-4 py-3 text-sm text-fg flex flex-col gap-2"
    >
      <div className="flex items-start gap-3">
        <span className="mt-0.5 text-accent shrink-0"><AdminIcon name="warning" size={18} /></span>
        <div className="flex flex-col gap-1 min-w-0">
          <p className="font-semibold"><span>{text.title}</span></p>
          <p><span>{text.body}</span></p>
          {text.failed && <p className="text-error"><span>{text.failed}</span></p>}
          {status.queued > 0 && <p className="text-fg-muted"><span>{text.upgrade}</span></p>}
        </div>
      </div>
      {status.queued > 0 && (
        <div className="flex justify-end">
          <AdminButton size="sm" variant="secondary" onClick={onRetry} disabled={retrying}>
            {retrying ? 'Wird versucht …' : 'Jetzt erneut versuchen'}
          </AdminButton>
        </div>
      )}
    </section>
  )
}

const POLL_MS = 60_000

interface MailQueueNoticeProps {
  // Changes when something may have queued mail (the report dialog closed).
  refreshKey: number
  onToast: (message: string) => void
}

export default function MailQueueNotice({ refreshKey, onToast }: MailQueueNoticeProps) {
  const [status, setStatus] = useState<MailQueueStatus | null>(null)
  const [retrying, setRetrying] = useState(false)

  const load = useCallback(async () => {
    try {
      setStatus(await adminApi.getMailQueue())
    } catch {
      // The notice is a convenience; the admin pages work without it.
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, POLL_MS)
    return () => clearInterval(timer)
  }, [load, refreshKey])

  const retry = async () => {
    setRetrying(true)
    try {
      const next = await adminApi.retryMailQueue()
      setStatus(next)
      onToast(next.queued === 0
        ? 'Alle wartenden E-Mails wurden versendet.'
        : next.sent > 0
          ? `${next.sent} versendet, ${next.queued} warten weiter auf das Versandkontingent.`
          : 'Das Versandkontingent ist noch erreicht. Die E-Mails gehen automatisch raus, sobald es frei ist.')
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Erneuter Versuch fehlgeschlagen.')
    } finally {
      setRetrying(false)
    }
  }

  return <MailQueueNoticeView status={status} retrying={retrying} onRetry={retry} />
}
