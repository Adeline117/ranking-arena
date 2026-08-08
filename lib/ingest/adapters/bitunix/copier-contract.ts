export const BITUNIX_COPIER_PAGE_ENVELOPE_CONTRACT =
  'arena.ingest.bitunix.copier-page-envelope@2' as const
export const BITUNIX_COPIER_HISTORY_URL =
  'https://api.bitunix.com/copy/trading/v1/trader/follow/list' as const

// This public web endpoint exposes no documented snapshot/version token. A
// reviewed 500-row request is currently honored and keeps the observed crawl
// interval to one response for the largest sampled public trader (236 rows),
// while exact row-count/totalPage validation still fails closed on API drift.
export const BITUNIX_COPIER_PAGE_SIZE = 500 as const
