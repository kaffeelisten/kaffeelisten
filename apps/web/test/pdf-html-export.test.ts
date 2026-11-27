// Opt-in: writes the real documents, built from invented stress names, as HTML files for
// scripts/pdf-production-check/run.sh. Skipped unless PDF_HTML_OUT is set.
import { writeFileSync } from 'node:fs'
import { it } from 'vitest'
import { buildCompanyDocumentHtml, buildEmployeeListHtml, buildMemberStatementHtml, type EnrichedTransaction, type MemberSummary } from '../api/_lib/reportHtml'
const OUT = process.env.PDF_HTML_OUT!
const NAMES = ['Anna-Lena Müller', 'محمد الأحمد', '张伟', 'さくら 田中', '김민준', 'Anáis', '👩‍🔬 Dr. Emoji', '<script>alert(1)</script>', 'Zoë O\'Brien', 'Шевченко']
let seq = 0
const tx = (id: string, name: string, i: number): EnrichedTransaction => ({ id: `t${++seq}`, member_id: id, company_id: 'c', item_id: 'e', quantity: (i % 5) + 1,
  logged_at: `2026-11-${String((i % 27) + 1).padStart(2, '0')}T09:15:00Z`, member_name: name, work_email: `${id}@example.com`, company_name: 'Ä & <Co> GmbH',
  item_name: ['Espresso', 'Wasser 0,5 l', 'Ä/Ö/Ü ß €'][i % 3], item_category: 'coffee', unit_label: 'Stück', price_cents: [50, 99, 999999][i % 3], total_cents: [50, 99, 999999][i % 3] * ((i % 5) + 1) })
const roster = (n: number, per: number): MemberSummary[] => Array.from({ length: n }, (_, p) => {
  const name = `${NAMES[p % NAMES.length]} ${p}`; const entries = Array.from({ length: per }, (_, i) => tx(`m${p}`, name, i + p))
  return { member_id: `m${p}`, member_name: name, work_email: `m${p}@example.com`, entries, subtotal_cents: entries.reduce((s, e) => s + e.total_cents, 0) } })
it.skipIf(!process.env.PDF_HTML_OUT)('writes the documents as HTML for scripts/pdf-production-check', () => {
  const r = roster(10, 40)
  r.forEach((m, i) => writeFileSync(`${OUT}/statement-${i}.html`, buildMemberStatementHtml(m.member_name, m.entries, 'November 2026')))
  writeFileSync(`${OUT}/verzehrliste-400.html`, buildEmployeeListHtml('Ä & <Co> GmbH', roster(400, 20), 'November 2026', { invoiceNumber: 'K-000001' }))
  writeFileSync(`${OUT}/company.html`, buildCompanyDocumentHtml('Ä & <Co> GmbH', 'Kontakt', roster(120, 30), 'November 2026'))
})
