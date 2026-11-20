// Vercel Edge Middleware: the only place that knows which deployment this is.
//
// DEMO_MODE is a runtime variable, so the demo and a campus instance build from
// the same commit into identical bundles. Nothing in public/ or in the static
// headers of vercel.json can tell them apart - which is why robots.txt is
// served from here instead of being a file.
//
// See shared/robotsPolicy.ts for what is served and why.

import { next } from '@vercel/edge'
import { canonicalLink, llmsTxt, robotsHeader, robotsTxt } from './shared/robotsPolicy'

export const config = {
  // Everything except the API and the build output. The API sets its own
  // no-store headers and is disallowed in robots.txt anyway.
  matcher: ['/((?!api/|assets/).*)'],
}

const text = (body: string) =>
  new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Short, so flipping DEMO_MODE on a deployment takes effect the same day.
      'Cache-Control': 'public, max-age=3600',
    },
  })

export default function middleware(request: Request): Response {
  const url = new URL(request.url)
  const input = {
    demo: process.env.DEMO_MODE === 'true',
    host: url.host,
  }

  if (url.pathname === '/robots.txt') return text(robotsTxt(input))

  if (url.pathname === '/llms.txt') {
    const body = llmsTxt(input)
    // A campus instance has no llms.txt rather than an empty one: a 404 says
    // "nothing here" more clearly than a file saying nothing.
    return body ? text(body) : new Response('Not found', { status: 404 })
  }

  const headers: Record<string, string> = { Link: canonicalLink(input) }
  const robots = robotsHeader(input)
  if (robots) headers['X-Robots-Tag'] = robots
  return next({ headers })
}
