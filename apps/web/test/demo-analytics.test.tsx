// @vitest-environment jsdom
// Vercel Web Analytics runs on the public demo only. A campus instance's privacy page says
// "kein Analytics", and its data protection agreement lists none.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetAppConfigCache } from '../src/lib/appConfig'

vi.mock('@vercel/analytics/react', () => ({
  Analytics: () => createElement('span', { 'data-testid': 'analytics' }),
}))

import { DemoAnalytics } from '../src/components/DemoAnalytics'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const realFetch = globalThis.fetch
let container: HTMLDivElement
let root: Root

beforeEach(() => {
  resetAppConfigCache()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  globalThis.fetch = realFetch
  resetAppConfigCache()
})

async function mounted(config: unknown, ok = true): Promise<boolean> {
  globalThis.fetch = vi.fn(async () => ({ ok, json: async () => config })) as never
  await act(async () => {
    root.render(createElement(DemoAnalytics))
  })
  await act(async () => { await new Promise(r => setTimeout(r, 0)) })
  return container.querySelector('[data-testid="analytics"]') !== null
}

describe('DemoAnalytics', () => {
  it('mounts analytics on the demo', async () => {
    expect(await mounted({ demo: true, demoPin: '1234' })).toBe(true)
  })

  it('mounts nothing on a campus instance', async () => {
    expect(await mounted({ demo: false })).toBe(false)
  })

  it('mounts nothing when the config cannot be read', async () => {
    expect(await mounted({}, false)).toBe(false)
  })
})
