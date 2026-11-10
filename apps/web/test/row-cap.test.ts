// The 1,000-row cap, and the paging that answers it.
//
// PostgREST returns at most max_rows (1000) and does not error when it hits the
// cap. Every unbounded read of `transactions` summed whatever came back, so a
// busy month was reported as a quiet one — the month-end invoice included.
//
// Reported by Gianna Gonzales (Perch Scan), 6 November 2026, against the paid
// grid. These tests cover the cap itself, the paging helper, and the month-end
// run end to end at a volume that used to truncate.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFakeClient, MAX_ROWS, type FakeDb } from './support/fakeSupabase'
import { fetchAllRows } from '../api/_lib/paged'

process.env.VERCEL_ENV = 'production'

const state = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  sent: [] as Array<{ to: string[]; subject: string; html: string }>,
}))

vi.mock('@supabase/supabase-js', () => ({ createClient: () => createFakeClient(state.db) }))
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (payload: (typeof state.sent)[number]) => {
        state.sent.push(payload)
        return { data: { id: `msg-${state.sent.length}` }, error: null }
      },
    }
  },
}))
vi.mock('../api/_lib/pdf', () => ({
  launchBrowser: async () => ({ close: async () => undefined }),
  pageToPdf: async () => Buffer.from('%PDF stub'),
}))
vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0 }) as unknown as typeof setTimeout)

const { runMonthlyReport } = await import('../api/_lib/report')

const CO = 'c-only'
const ME = 'm-only'
const COUNT = 1500          // comfortably over the cap, and a realistic month
const PRICE = 50            // cents

function seed(): FakeDb {
  let seq = 0
  return {
    tables: {
      app_settings: [{
        id: 1,
        report_recipients: ['admin@itc1.de'],
        ceo_email: null,
        cc_ceo_on_reports: false,
        member_statements_enabled: false,
        company_documents_enabled: false,
        company_paid_member_reports_enabled: false,
        auto_report_enabled: true,
        auto_report_day: null,
        report_accent: '#D97706',
        report_subject: null, report_intro: null,
        report_include_pdf: false, report_include_excel: false,
        member_subject: null, member_intro: null,
        issue_invoices: false,
        invoice_mode_authorized: false,
        issuer_legal_name: 'ITC Innovations Technologie Campus GmbH',
        issuer_address: null,
        issuer_vat_id: 'DE207285819',
        issuer_iban: 'DE33741500000380009340',
        issuer_bic: 'BYLADEM1DEG',
        invoice_number_prefix: 'K-',
        invoice_payment_terms: null,
        invoice_vat_rate: 19,
        member_paid_grid_enabled: true,
      }],
      app_theme: [],
      companies: [{ id: CO, name: 'Nur Eine', billing_mode: 'individual', billing_contact_name: null, billing_contact_email: null, member_document_copies_enabled: false, checkout_mode: 'member' }],
      members: [{ id: ME, company_id: CO, name: 'Vielkaffee', work_email: 'viel@example.com', kind: 'person' }],
      items: [{ id: 'i-esp', name: 'Espresso', unit_label: 'Tasse', price_cents: PRICE, category: 'coffee' }],
      transactions: Array.from({ length: COUNT }, (_, i) => ({
        // Zero-padded so lexical ordering matches insertion order: the fake sorts
        // as text, like Postgres does on a text id.
        id: `t-${String(i).padStart(5, '0')}`,
        member_id: ME,
        company_id: CO,
        item_id: 'i-esp',
        quantity: 1,
        unit_price_cents: PRICE,
        logged_at: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T08:00:00.000Z`,
      })),
      transactions_archive: [],
      report_runs: [],
      billing_runs: [],
      billing_documents: [],
      document_deliveries: [],
    },
    rpc: { prune_reported_transactions: () => 0, next_billing_document_number: () => ++seq },
  }
}

beforeEach(() => {
  state.sent = []
  state.db = seed()
  process.env.RESEND_API_KEY = 'test'
  process.env.VITE_SUPABASE_URL = 'http://fake'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake'
})

describe('the row cap', () => {
  it('truncates an unbounded select, silently and without an error', async () => {
    const supabase = createFakeClient(state.db)
    const { data, error } = await supabase.from('transactions').select('id')
    expect(error).toBeNull()                       // this is what made it invisible
    expect((data as unknown[]).length).toBe(MAX_ROWS)
    expect((data as unknown[]).length).toBeLessThan(COUNT)
  })

  it('fetchAllRows pages past it', async () => {
    const supabase = createFakeClient(state.db)
    const rows = await fetchAllRows<{ id: string }>(
      (from, to) => supabase.from('transactions').select('id').order('id').range(from, to) as never,
      'test',
    )
    expect(rows).toHaveLength(COUNT)
    expect(new Set(rows.map(r => r.id)).size).toBe(COUNT)   // no page repeated a row
  })
})

describe('the month-end run at volume', () => {
  it('bills every transaction, not the first page of them', async () => {
    await runMonthlyReport('2026-08', { force: true })

    // Every row reached the archive. Truncated reads archived 1000 and dropped
    // the rest, which also lost them from the permanent record.
    expect(state.db.tables.transactions_archive).toHaveLength(COUNT)

    // 1500 x 50 cents = 750,00 EUR. The old behaviour reported 500,00.
    const admin = state.sent.find(m => m.to.includes('admin@itc1.de'))
    expect(admin).toBeDefined()
    expect(admin!.html).toContain('750,00')
    expect(admin!.html).not.toContain('500,00')
  })
})
