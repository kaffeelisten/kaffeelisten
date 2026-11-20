// What each deployment tells crawlers.
//
// This cannot be checked by deploying and looking, because the whole point is
// that the two deployments are the same bundle and differ only by a runtime
// variable. So the policy is a pure function and the invariants live here.

import { beforeEach, describe, expect, it } from 'vitest'
import { llmsTxt, robotsTxt } from '../shared/robotsPolicy'

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

  it('does not touch an ordinary page, so it cannot break one', async () => {
    process.env.DEMO_MODE = 'true'
    // The 500 that took the demo down came from rewriting the response of every
    // request. Returning undefined is the documented way to stand aside.
    expect(await call('/admin/firmen')).toBeUndefined()
    expect(await call('/')).toBeUndefined()
  })
})
