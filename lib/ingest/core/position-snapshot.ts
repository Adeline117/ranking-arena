/**
 * Fail-closed parsing for open-position snapshots (Tier-D / Tier-C positions).
 *
 * publishPositions REPLACES a trader's whole `positions_current` set
 * (DELETE + INSERT), so an empty parse result means "the trader is flat".
 * That conclusion is only allowed from a captured, schema-valid response:
 *   - zero captured pages is a failed fetch, never an empty book;
 *   - every parsed row must satisfy `parsedPositionSchema`;
 *   - adapter parsers throw on HTTP-200 business-error envelopes
 *     (see bitget/gate parsePositions), which propagates from here.
 * Any throw leaves the previous snapshot untouched.
 */

import type { ParseCtx, ParsedPosition, RawPage } from './types'
import { parsedPositionSchema } from './schemas'

export function parsePositionSnapshot(
  parse: (raw: unknown, ctx: ParseCtx) => ParsedPosition[],
  pages: readonly RawPage[],
  ctx: ParseCtx
): ParsedPosition[] {
  if (pages.length === 0) {
    throw new Error(`[positions] ${ctx.sourceSlug}: capture returned no evidence page`)
  }
  const positions = pages.flatMap((page) => parse(page.payload, ctx))
  positions.forEach((position, index) => {
    const result = parsedPositionSchema.safeParse(position)
    if (!result.success) {
      const issue = result.error.issues[0]
      throw new Error(
        `[positions] ${ctx.sourceSlug}: row ${index} failed schema ` +
          `(${issue?.path.join('.') || '<root>'}: ${issue?.message ?? 'invalid'})`
      )
    }
  })
  return positions
}

type Dict = Record<string, unknown>

/**
 * The row array of a position response, or a throw. `isSuccess` is the
 * source's success-envelope test; `rows` picks the row array out of the
 * envelope. A business-error envelope or a non-array row field is a failed
 * fetch — returning [] would make publishPositions delete the stored book.
 */
export function positionEnvelopeRows(
  source: string,
  raw: unknown,
  isSuccess: (envelope: Dict) => boolean,
  rows: (envelope: Dict) => unknown
): Dict[] {
  const envelope = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Dict) : null
  if (!envelope || !isSuccess(envelope)) {
    throw new Error(
      `[${source}] positions returned a non-success API envelope (code=${String(envelope?.code)})`
    )
  }
  const list = rows(envelope)
  if (!Array.isArray(list)) {
    throw new Error(`[${source}] positions returned a malformed envelope (rows are not an array)`)
  }
  return list.filter((row): row is Dict => !!row && typeof row === 'object' && !Array.isArray(row))
}

/**
 * Pages through a numeric-page open-positions endpoint until a short page (or
 * the reported total is reached). Tier-D replaces the whole book, so a book
 * still full at the page budget throws instead of publishing a cut set.
 * `rowsOf` returns the page's row count (0 for a business-error envelope —
 * the parser then rejects it); `totalOf` the reported total, when exposed.
 */
export async function fetchPositionPages(opts: {
  source: string
  pageSize: number
  maxPages: number
  fetchPage: (pageNo: number) => Promise<{ payload: unknown; url: string }>
  rowsOf: (payload: unknown) => number
  totalOf?: (payload: unknown) => number | null
}): Promise<RawPage[]> {
  const pages: RawPage[] = []
  let seen = 0
  for (let pageNo = 1; pageNo <= opts.maxPages; pageNo++) {
    const { payload, url } = await opts.fetchPage(pageNo)
    pages.push({ pageIndex: pageNo, payload, url, fetchedAt: new Date().toISOString() })
    const rows = opts.rowsOf(payload)
    seen += rows
    const total = opts.totalOf?.(payload) ?? null
    if (rows < opts.pageSize || (total !== null && seen >= total)) return pages
  }
  throw new Error(
    `[${opts.source}] open positions exceed ${opts.maxPages} pages of ${opts.pageSize} — ` +
      'refusing a partial book'
  )
}
