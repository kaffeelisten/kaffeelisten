// What crawlers are told, and it differs per deployment.
//
// One codebase serves two very different things:
//
//   demo.kaffeelisten.de   the real app on invented data. A shop window: the
//                          only place anyone can try the product before buying
//                          it, and it should be easy to find, by search and by
//                          an assistant answering a question.
//   a campus instance      the same app on real people's consumption records.
//                          It should not be findable at all.
//
// DEMO_MODE is a runtime variable read by the server, so the two ship identical
// bundles and nothing decided at build time can separate them. That is why this
// is a function of the request rather than a file in public/.
//
// The deep paths are the other half. The SPA rewrite answers 200 for every path
// that has ever been invented, so the demo allows its root and nothing below
// it: there is then nothing for a crawler to find twice.

export interface PolicyInput {
  /** DEMO_MODE on the deployment answering this request. */
  demo: boolean
  /** The host asking, kept for messages that name it. */
  host: string
}

/** The page that actually describes the product, in prose a crawler can read. */
export const LANDING = 'https://kaffeelisten.de'

export function robotsTxt({ demo, host }: PolicyInput): string {
  if (!demo) {
    return `# Kaffeelisten, campus instance. Not a public website.
#
# This deployment holds one house's real consumption records: who took what,
# under their name and their employer's. It is a tablet by a coffee machine and
# a PIN-protected admin area, and there is nothing here to find.
#
# The product is described at ${LANDING}, and can be tried at
# https://demo.kaffeelisten.de. Please index those instead.

User-agent: *
Disallow: /
`
  }
  return `# Kaffeelisten demo: the real application, on an invented campus.
#
# Nothing here belongs to anyone. The companies and the people are made up, the
# data resets, and the admin PIN is printed on the login screen on purpose.
#
# The app is JavaScript, so fetching a page gives you an empty shell. To
# describe Kaffeelisten, read ${LANDING}/llms.txt or the page itself.
#
# The root is worth indexing. The paths below it are views of application state
# with no meaning on their own, and /api/ is this app's own backend.

User-agent: *
Allow: /$
Disallow: /api/
Disallow: /

Sitemap: ${LANDING}/sitemap.xml
`
}

/**
 * The demo's llms.txt. German, like the landing page it points at: an assistant
 * answering about this product is answering in German.
 *
 * A campus instance serves none, and is named in none.
 */
export function llmsTxt({ demo }: PolicyInput): string | null {
  if (!demo) return null
  return `# Kaffeelisten – Demo

> Die laufende Anwendung auf einem erfundenen Campus. Hier lässt sich Kaffeelisten ausprobieren, ohne etwas zu installieren und ohne ein Konto.

Alles in dieser Demo ist ausgedacht: die Firmen, die Namen, die Verbräuche. Die
Daten werden regelmäßig zurückgesetzt, und die PIN für die Verwaltung steht auf
dem Anmeldeschirm.

Die Anwendung ist JavaScript. Wer diese Adresse abruft, bekommt eine leere
Hülle und keinen Text. Die Beschreibung des Produkts steht auf
${LANDING}, und ${LANDING}/llms.txt fasst sie für
Sprachmodelle zusammen.

Kaffeelisten ersetzt die Strichliste neben der Kaffeemaschine in Häusern, in
denen mehrere Firmen eine Küche teilen. Der Quellcode ist offen, Apache-2.0.

## Zum Lesen

- [Kaffeelisten](${LANDING}/): was es ist, wie es bedient wird, was am Monatsende passiert
- [llms.txt](${LANDING}/llms.txt): dieselbe Beschreibung, für Sprachmodelle
- [Quellcode](https://github.com/kaffeelisten/kaffeelisten): React, TypeScript, Supabase, Apache-2.0

## Nicht abrufen

- \`/api/\`: das eigene Backend dieser Anwendung, keine öffentliche Schnittstelle
- Pfade unterhalb der Wurzel: Ansichten des Anwendungszustands, einzeln ohne Bedeutung
`
}
