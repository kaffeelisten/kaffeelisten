// Vercel Edge Middleware: the only place that knows which deployment this is.
//
// DEMO_MODE is a runtime variable, so the demo and a campus instance build from
// the same commit into identical bundles. Nothing in public/ and no static
// header in vercel.json can tell them apart, which is why robots.txt and
// llms.txt are served from here.
//
// DELIBERATELY SMALL. The first version imported `next()` from @vercel/edge to
// add response headers to ordinary pages, and every request to the demo came
// back 500 - MIDDLEWARE_INVOCATION_FAILED. That version is reverted here.
//
// It turned out those headers were not needed:
//
//   * The canonical existed to collapse the SPA's invented paths. robots.txt
//     already keeps crawlers off them (`Allow: /$` then `Disallow: /`), so
//     there are no duplicates to collapse.
//   * X-Robots-Tag on a campus instance is belt to robots.txt's braces. The
//     braces hold: nothing links to a campus instance and it sits behind
//     deployment protection.
//
// So this returns a Response for the two paths it owns and nothing at all
// otherwise, which is the documented way to let a request continue. No
// dependency, no response rewriting, nothing to fail on a request it does not
// handle.

import { llmsTxt, robotsTxt } from './shared/robotsPolicy'

const text = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Short, so flipping DEMO_MODE takes effect the same day.
      'Cache-Control': 'public, max-age=3600',
    },
  })

export default function middleware(request: Request): Response | undefined {
  const { pathname, host } = new URL(request.url)
  const input = { demo: process.env.DEMO_MODE === 'true', host }

  if (pathname === '/robots.txt') return text(robotsTxt(input))

  if (pathname === '/llms.txt') {
    const body = llmsTxt(input)
    // A campus instance has no llms.txt rather than an empty one.
    return body ? text(body) : text('Not found', 404)
  }

  return undefined
}
