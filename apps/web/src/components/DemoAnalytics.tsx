import { Analytics } from '@vercel/analytics/react'
import { useAppConfig } from '../lib/appConfig'

// Vercel Web Analytics (page views, no cookies) runs on the public demo only. A campus
// instance processes its members' data under a data protection agreement that lists no
// analytics, and its privacy page says there is none.
export function DemoAnalytics() {
  const { demo } = useAppConfig()
  return demo ? <Analytics /> : null
}
