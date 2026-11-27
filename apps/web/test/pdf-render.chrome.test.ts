// Renders the real documents through a real Chromium with hostile, oversized data.
// Opt-in: set CHROMIUM_PATH to a local Chrome or Edge, e.g.
//   CHROMIUM_PATH="C:/Program Files/Google/Chrome/Application/chrome.exe" npx vitest run test/pdf-render.chrome.test.ts
// Run it after any upgrade of puppeteer-core or @sparticuz/chromium-min, before pushing.
import type { Browser } from 'puppeteer-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { launchBrowser, pageToPdf } from '../api/_lib/pdf'
import {
  buildCompanyDocumentHtml,
  buildEmployeeListHtml,
  buildMemberStatementHtml,
  type EnrichedTransaction,
  type MemberSummary,
} from '../api/_lib/reportHtml'

const enabled = Boolean(process.env.CHROMIUM_PATH)

// Names a campus roster can really hold, plus the ones an attacker would type.
const NAMES = [
  'Anna-Lena Müller-Lüdenscheidt', 'Ødegård Ærø', 'Łukasz Wójcik', 'Zoë O\'Brien', 'Mc Donald van der Berg',
  'محمد الأحمد', 'דוד כהן', '张伟', 'さくら 田中', '김민준', 'Νίκος Παπαδόπουλος', 'Шевченко Тарас',
  'Ana\u0301 (combining)', '👩‍🔬 Dr. Emoji', 'A'.repeat(200),
  '<script>alert(1)</script>', '"><img src=x onerror=alert(1)>', '&amp;&lt;&gt;&quot;&#39;', '${7*7}{{7*7}}',
  '\u202Eevil\u202C', 'Robert\'); DROP TABLE members;--', 'line\nbreak\ttab', '   spaces   ',
]
const ITEMS: Array<[string, number]> = [
  ['Espresso', 50], ['Cappuccino', 70], ['Tee (lose) 1/2 Kanne', 1], ['Wasser 0,5 l', 99999], ['Ä/Ö/Ü ß €', 123456],
]

let seq = 0
function tx(memberId: string, name: string, i: number): EnrichedTransaction {
  const [item, price] = ITEMS[i % ITEMS.length]
  const qty = (i % 7) + 1
  return {
    id: `t${++seq}`, member_id: memberId, company_id: 'c', item_id: item, quantity: qty,
    logged_at: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T${String(i % 24).padStart(2, '0')}:15:00Z`,
    member_name: name, work_email: `${memberId}@example.com`, company_name: 'Ä & <Co> GmbH',
    item_name: item, item_category: 'coffee', unit_label: 'Stück',
    price_cents: price, total_cents: price * qty,
  }
}
function roster(people: number, perPerson: number): MemberSummary[] {
  return Array.from({ length: people }, (_, p) => {
    const name = `${NAMES[p % NAMES.length]} ${p}`
    const entries = Array.from({ length: perPerson }, (_, i) => tx(`m${p}`, name, i + p))
    return { member_id: `m${p}`, member_name: name, work_email: `m${p}@example.com`, entries, subtotal_cents: entries.reduce((s, e) => s + e.total_cents, 0) }
  })
}
function pages(pdf: Buffer): number {
  return (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
}

describe.skipIf(!enabled)('PDF rendering in a real Chromium', () => {
  let browser: Browser
  beforeAll(async () => { browser = await launchBrowser() }, 60_000)
  // Closing Chrome can take longer than the 10 s hook default on a loaded Windows machine.
  afterAll(async () => { await browser?.close() }, 60_000)

  it('renders one statement per hostile name without running any of it', async () => {
    for (const m of roster(NAMES.length, 40)) {
      const html = buildMemberStatementHtml(m.member_name, m.entries, 'August 2026')
      expect(html).not.toContain('<script>alert')
      const pdf = await pageToPdf(browser, html)
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
      expect(pages(pdf)).toBeGreaterThanOrEqual(1)
    }
  }, 120_000)

  it('renders a company Verzehrliste for 400 people and 8,000 entries', async () => {
    const people = roster(400, 20)
    const pdf = await pageToPdf(browser, buildEmployeeListHtml('Ä & <Co> GmbH', people, 'August 2026', { invoiceNumber: 'K-000001' }))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pages(pdf)).toBeGreaterThan(10)
  }, 180_000)

  it('renders a company document for the same month', async () => {
    const people = roster(120, 30)
    const html = buildCompanyDocumentHtml('Ä & <Co> GmbH', '<b>Kontakt</b> & "Co"', people, 'August 2026')
    const pdf = await pageToPdf(browser, html)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  }, 120_000)
})
