// What each deployment tells crawlers.
//
// This cannot be checked by deploying and looking, because the whole point is
// that the two deployments are the same bundle and differ only by a runtime
// variable. So the policy is a pure function and the invariants live here.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canonicalLink,
  llmsTxt,
  robotsHeader,
  robotsTxt,
} from '../shared/robotsPolicy'

vi.mock('@vercel/edge', () => ({
  next: (init?: { headers?: Record<string, string> }) =>
    new Response(null, { status: 200, headers: init?.headers }),
}))

const demo = { demo: true, host: 'demo.kaffeelisten.de' }
const campus = { demo: false, host: 'itc1.kaffeelisten.de' }

describe('a campus instance is not findable', () => {
  it('disallows everything', () => {
    const r = robotsTxt(campus)
    expect(r).toMatch(/^User-agent: \*$/m)
    expect(r).toMatch(/^Disallow: \/$/m)
    expect(r).not.toMatch(/^Allow:/m)
  })

  it('offers no sitemap', () => {
    expect(robotsTxt(campus)).not.toContain('Sitemap:')
  })

  it('sends noindex', () => {
    expect(robotsHeader(campus)).toBe('noindex, nofollow')
  })

  it('has no llms.txt at all, rather than an empty one', () => {
    expect(llmsTxt(campus)).toBeNull()
  })

  it('points a crawler at the public pages instead', () => {
    expect(robotsTxt(campus)).toContain('https://kaffeelisten.de')
    expect(robotsTxt(campus)).toContain('https://demo.kaffeelisten.de')
  })
})

describe('the demo is findable, but only its root', () => {
  it('allows exactly the root and nothing under it', () => {
    const r = robotsTxt(demo)
    // Allow must come first: a crawler takes the most specific rule, and the
    // anchored /$ is what keeps the root in while the SPA's invented paths
    // stay out.
    expect(r.indexOf('Allow: /$')).toBeLessThan(r.indexOf('Disallow: /\n'))
    expect(r).toMatch(/^Allow: \/\$$/m)
    expect(r).toMatch(/^Disallow: \/$/m)
  })

  it('closes its own backend', () => {
    expect(robotsTxt(demo)).toMatch(/^Disallow: \/api\/$/m)
  })

  it('carries the landing page sitemap, not one of its own', () => {
    expect(robotsTxt(demo)).toContain('Sitemap: https://kaffeelisten.de/sitemap.xml')
  })

  it('is not noindexed', () => {
    expect(robotsHeader(demo)).toBeNull()
  })

  it('tells a model the page is empty and where the prose is', () => {
    const l = llmsTxt(demo)!
    expect(l).toContain('JavaScript')
    expect(l).toContain('https://kaffeelisten.de/llms.txt')
    expect(l.startsWith('# ')).toBe(true)
    expect(l).toMatch(/\n> /)
  })

  it('says the data is invented, so nobody quotes it as real', () => {
    expect(llmsTxt(demo)!).toContain('ausgedacht')
  })
})

describe('no campus host ever appears in public text', () => {
  it('is absent from everything the demo serves', () => {
    expect(robotsTxt(demo)).not.toContain('itc1')
    expect(llmsTxt(demo)!).not.toContain('itc1')
  })
})

describe('canonical', () => {
  it('collapses every invented path onto the deployment root', () => {
    expect(canonicalLink({ ...demo, host: 'demo.kaffeelisten.de' }))
      .toBe('<https://demo.kaffeelisten.de/>; rel="canonical"')
  })

  it('uses the host that was asked for, never a baked-in one', () => {
    expect(canonicalLink(campus)).toContain('itc1.kaffeelisten.de')
  })
})

describe('the middleware routes it', () => {
  beforeEach(() => { delete process.env.DEMO_MODE })

  const call = async (path: string) => {
    const { default: middleware } = await import('../middleware')
    return middleware(new Request(`https://demo.kaffeelisten.de${path}`))
  }

  it('serves robots.txt as plain text', async () => {
    process.env.DEMO_MODE = 'true'
    const res = await call('/robots.txt')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('text/plain')
    expect(await res.text()).toContain('User-agent: *')
  })

  it('404s llms.txt on a campus instance', async () => {
    const res = await call('/llms.txt')
    expect(res.status).toBe(404)
  })

  it('sets the canonical link on an ordinary page', async () => {
    process.env.DEMO_MODE = 'true'
    const res = await call('/admin/firmen')
    expect(res.headers.get('Link')).toBe('<https://demo.kaffeelisten.de/>; rel="canonical"')
    expect(res.headers.get('X-Robots-Tag')).toBeNull()
  })

  it('noindexes an ordinary page when DEMO_MODE is off', async () => {
    const res = await call('/admin/firmen')
    expect(res.headers.get('X-Robots-Tag')).toBe('noindex, nofollow')
  })
})
