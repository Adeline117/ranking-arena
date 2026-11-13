/**
 * Raised by an adapter's getHistory when an orders/transfers crawl stops at its
 * caller page budget while upstream still had more rows (every page full, no
 * cursor overlap reached). The pages already yielded are valid newest-first
 * evidence; the error only says the stream was CUT, so the caller must record
 * the truncation instead of treating the history as complete.
 */
export class HistoryPageCapReachedError extends Error {
  constructor(
    readonly sourceSlug: string,
    readonly kind: 'orders' | 'transfers',
    readonly pageCap: number,
    /**
     * Page-numbered sources: the first page NOT fetched (the backward
     * continuation resume point, see history-continuation.ts). Undefined for
     * sources that do not page by number.
     */
    readonly nextPage?: number
  ) {
    super(
      `[${sourceSlug}] ${kind} reached page cap ${pageCap} before cursor overlap or a short page`
    )
    this.name = 'HistoryPageCapReachedError'
  }
}

/**
 * Hard ceiling for copier pagination when the source reports its own page
 * count: the crawl may extend its configured budget up to the reported total,
 * but never past this many pages.
 */
export const COPIER_PAGE_CEILING = 100

/**
 * Raised by a copier getHistory when its page budget ends while the source
 * still has more copiers. A Tier-B copier snapshot must be unbounded
 * (`copier_snapshot_tier_b_not_caller_limited`), so a cut capture can never be
 * published as a snapshot; the caller records the truncation instead.
 */
export class CopierPageCapReachedError extends Error {
  constructor(
    readonly sourceSlug: string,
    readonly pageCap: number
  ) {
    super(`[${sourceSlug}] copiers reached page cap ${pageCap} before the source's last page`)
    this.name = 'CopierPageCapReachedError'
  }
}
