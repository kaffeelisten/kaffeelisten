// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MailQueueNoticeView } from '../src/components/admin/MailQueueNotice'
import { emptyMailQueueStatus, type MailQueueStatus } from '../shared/mailQueue'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(status: MailQueueStatus | null, onRetry = () => {}) {
  act(() => root.render(createElement(MailQueueNoticeView, { status, retrying: false, onRetry })))
}

describe('MailQueueNoticeView', () => {
  it('renders nothing while nothing waits', () => {
    render(emptyMailQueueStatus())
    expect(container.innerHTML).toBe('')
    render(null)
    expect(container.innerHTML).toBe('')
  })

  it('tells the admin how many wait, when, and whom to ask for more, and offers a retry', () => {
    let retried = 0
    render(
      { ...emptyMailQueueStatus(), queued: 40, reason: 'daily_quota', nextAttemptAt: '2026-12-01T00:00:00.000Z', operatorEmail: 'betrieb@example.com' },
      () => { retried++ },
    )
    const text = container.textContent ?? ''
    expect(text).toContain('40 E-Mails warten auf den Versand')
    expect(text).toContain('01.12.2026 um 01:10 Uhr')
    expect(text).toContain('betrieb@example.com')
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === 'Jetzt erneut versuchen')!
    act(() => button.click())
    expect(retried).toBe(1)
  })
})
