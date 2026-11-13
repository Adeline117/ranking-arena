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
    readonly pageCap: number
  ) {
    super(
      `[${sourceSlug}] ${kind} reached page cap ${pageCap} before cursor overlap or a short page`
    )
    this.name = 'HistoryPageCapReachedError'
  }
}
