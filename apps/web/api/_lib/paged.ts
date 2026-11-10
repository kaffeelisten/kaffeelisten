// Read every row, not the first page of them.
//
// PostgREST caps a response at the project's `max_rows` (1000 here and on the
// hosted projects – supabase/config.toml). A select with no .range() does not
// error when it hits that cap; it returns 1000 rows and a 206. Code that then
// sums what it got reports a number that is quietly too small.
//
// At 30–80 campus members logging a couple of items a day, a month is a few
// thousand transactions, so every unbounded read of `transactions` or
// `transactions_archive` was wrong from the first real month of use – the
// month-end report included.
//
// Reported by Gianna Gonzales (Perch Scan) on 6 November 2026, against the
// paid grid. The same pattern was in six other places.

const PAGE = 1000

// A page is only stable if the rows come back in a defined order: without one,
// Postgres may return the same row on two pages and drop another. Every caller
// orders by a unique column (id) for that reason, not for presentation.
const MAX_PAGES = 1000

export interface PageResult<T> {
  data: T[] | null
  error: { message: string } | null
}

/**
 * Call `page(from, to)` repeatedly until it stops returning rows.
 *
 * Advances by how many rows actually came back rather than by PAGE, so it stays
 * correct if the server's cap is lower than PAGE.
 */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<PageResult<T>>,
  label: string,
): Promise<T[]> {
  const out: T[] = []
  let from = 0
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new Error(`${label}: ${error.message}`)
    const batch = data ?? []
    out.push(...batch)
    if (batch.length === 0) return out
    from += batch.length
  }
  throw new Error(`${label}: more than ${MAX_PAGES * PAGE} rows; refusing to page further`)
}
