/**
 * Canonical source-key → human label map for exchange/platform badges on
 * share cards (X-intent text, OG rank cards, /share/rank pages).
 *
 * Keys are ingest SOURCE keys (binance_futures, bybit_spot, …), NOT the
 * hyphenated exchange landing-page slugs. Previously this map was copy-pasted
 * into ShareOnXButton, ShareRankCardButtons, the /share/rank page and the
 * og/rank-card route — and they had already drifted (ShareOnXButton was missing
 * gateio/dydx/htx_futures/… so it rendered raw "gateio" while /share/rank
 * rendered "Gate.io"). This is the single source.
 */
export const PLATFORM_LABELS: Record<string, string> = {
  binance_futures: 'Binance',
  binance_spot: 'Binance Spot',
  binance_web3: 'Binance Web3',
  bybit: 'Bybit',
  bybit_spot: 'Bybit Spot',
  bitget_futures: 'Bitget',
  bitget_spot: 'Bitget Spot',
  okx: 'OKX',
  okx_spot: 'OKX Spot',
  okx_web3: 'OKX Web3',
  okx_web3_solana: 'OKX Wallet',
  okx_futures: 'OKX',
  hyperliquid: 'Hyperliquid',
  gmx: 'GMX',
  dydx: 'dYdX',
  mexc: 'MEXC',
  kucoin: 'KuCoin',
  gateio: 'Gate.io',
  htx_futures: 'HTX',
  weex: 'Weex',
  blofin: 'Blofin',
  coinex: 'CoinEx',
}

/** Label for a platform source key, with a title-cased fallback for unknowns. */
export function platformLabel(platform?: string | null): string {
  if (!platform) return ''
  return (
    PLATFORM_LABELS[platform] ??
    platform.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
  )
}

/** Compact ROI formatter for share cards: +1.2K% / +34.5% / -8.0%. */
export function formatRoiShort(roi: number): string {
  const sign = roi >= 0 ? '+' : '-'
  const abs = Math.abs(roi)
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}K%`
  return `${sign}${abs.toFixed(1)}%`
}
