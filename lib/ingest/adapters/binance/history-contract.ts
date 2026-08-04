export const BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT = 'arena.ingest.binance-history-page@1' as const

export const BINANCE_POSITION_HISTORY_URL =
  'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/position-history' as const

export const BINANCE_COPIER_HISTORY_URLS = Object.freeze({
  futures:
    'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade/lead-portfolio/copy-traders',
  spot: 'https://www.binance.com/bapi/futures/v1/friendly/future/spot-copy-trade/lead-portfolio/get-copy-trader-result-by-page',
} as const)
