// Production's PDF path, outside the app: the same launch and page settings as
// apps/web/api/_lib/pdf.ts, with the exact Chromium pack production downloads.
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import chromium from '@sparticuz/chromium-min'
import puppeteer from 'puppeteer-core'
const PACK = `https://github.com/Sparticuz/chromium/releases/download/v${process.env.CHROMIUM_VERSION}/chromium-v${process.env.CHROMIUM_VERSION}-pack.x64.tar`
const executablePath = await chromium.executablePath(PACK)
const args = chromium.args.filter(a => !a.startsWith('--disable-web-security'))
// Generous timeouts: on an ARM machine the x64 container runs emulated, several times slower
// than Vercel. They are for this check only; pdf.ts keeps puppeteer's defaults.
const browser = await puppeteer.launch({ args, executablePath, headless: true, protocolTimeout: 600_000 })
console.log('browser', await browser.version(), 'puppeteer-core', JSON.parse(readFileSync('node_modules/puppeteer-core/package.json')).version)
mkdirSync('/work/out', { recursive: true })
for (const f of readdirSync('/work/html')) {
  const html = readFileSync(`/work/html/${f}`, 'utf8')
  const page = await browser.newPage()
  page.setDefaultTimeout(600_000)
  await page.setJavaScriptEnabled(false)
  await page.setRequestInterception(true)
  page.on('request', r => (r.url().startsWith('data:') || r.url().startsWith('about:') ? r.continue() : r.abort()))
  await page.setContent(html, { waitUntil: 'load' })
  const pdf = await page.pdf({ format: 'A4', printBackground: true, displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:right;padding:0 18mm">Seite <span class="pageNumber"></span> von <span class="totalPages"></span></div>',
    margin: { top: '12mm', right: '0', bottom: '14mm', left: '0' } })
  const pages = (Buffer.from(pdf).toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
  if (f.startsWith('statement-')) await page.screenshot({ path: `/work/out/${f}.png`, fullPage: false })
  writeFileSync(`/work/out/${f}.pdf`, pdf)
  console.log(`${f}: ${Buffer.from(pdf).subarray(0, 5).toString()} ${pdf.length} bytes, ${pages} pages`)
  await page.close()
}
await browser.close()
