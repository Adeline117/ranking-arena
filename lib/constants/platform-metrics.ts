/**
 * Platform Metric Availability
 * 
 * Documents which metrics each platform's API provides.
 * Used to display N/A with appropriate tooltips in the UI.
 */

export interface PlatformMetrics {
  /** Whether the platform API provides win rate */
  hasWinRate: boolean
  /** Whether the platform API provides max drawdown */
  hasMaxDrawdown: boolean
  /** Note about the platform's data limitations */
  note?: string
}

/**
 * Platform metric availability based on API capabilities.
 * 
 * Data quality categories:
 * - full: API provides WR and DD (Binance, OKX, HTX, etc.)
 * - partial: API provides WR but not DD, or vice versa
 * - limited: API doesn't provide WR or DD (on-chain/DEX)
 */
export const PLATFORM_METRICS: Record<string, PlatformMetrics> = {
  // CEX Futures - Generally good data
  binance_futures: { hasWinRate: true, hasMaxDrawdown: true },
  bybit: { hasWinRate: true, hasMaxDrawdown: true },
  bitget_futures: { hasWinRate: true, hasMaxDrawdown: true },
  okx_futures: { hasWinRate: true, hasMaxDrawdown: true },
  htx_futures: { hasWinRate: true, hasMaxDrawdown: true },
  kucoin: { hasWinRate: true, hasMaxDrawdown: true },
  weex: { hasWinRate: true, hasMaxDrawdown: false, note: 'WEEX API不提供回撤数据' },
  xt: { hasWinRate: true, hasMaxDrawdown: true },

  // CEX Futures - Limited data
  mexc: { hasWinRate: false, hasMaxDrawdown: false, note: 'MEXC API数据有限' },
  coinex: { hasWinRate: false, hasMaxDrawdown: false, note: 'CoinEx API不提供胜率/回撤' },
  phemex: { hasWinRate: false, hasMaxDrawdown: false, note: 'Phemex API不提供胜率/回撤' },
  bingx: { hasWinRate: false, hasMaxDrawdown: false, note: 'BingX API不提供胜率/回撤' },
  blofin: { hasWinRate: false, hasMaxDrawdown: false, note: 'BloFin API数据有限' },
  lbank: { hasWinRate: false, hasMaxDrawdown: true, note: 'LBank API不提供胜率' },

  // CEX Spot
  binance_spot: { hasWinRate: true, hasMaxDrawdown: true },
  bitget_spot: { hasWinRate: false, hasMaxDrawdown: true, note: 'Bitget现货不提供完整胜率' },
  bybit_spot: { hasWinRate: true, hasMaxDrawdown: true },
  okx_spot: { hasWinRate: true, hasMaxDrawdown: true },

  // CEX Web3 Wallets
  binance_web3: { hasWinRate: false, hasMaxDrawdown: false, note: '钱包数据不包含交易统计' },
  okx_web3: { hasWinRate: true, hasMaxDrawdown: true },

  // DEX/On-chain - Most don't provide WR/DD
  gmx: { hasWinRate: true, hasMaxDrawdown: false, note: 'GMX是链上数据，回撤需链上计算' },
  hyperliquid: { hasWinRate: true, hasMaxDrawdown: true },
  dydx: { hasWinRate: false, hasMaxDrawdown: false, note: 'dYdX API不提供胜率/回撤' },
  gains: { hasWinRate: true, hasMaxDrawdown: false, note: 'Gains Network不提供回撤数据' },
  aevo: { hasWinRate: false, hasMaxDrawdown: false, note: 'Aevo是链上DEX，API数据有限' },
  kwenta: { hasWinRate: false, hasMaxDrawdown: false, note: 'Kwenta是链上DEX' },
  mux: { hasWinRate: false, hasMaxDrawdown: false, note: 'MUX是链上聚合器' },
  vertex: { hasWinRate: false, hasMaxDrawdown: false, note: 'Vertex是链上DEX' },
  drift: { hasWinRate: false, hasMaxDrawdown: false, note: 'Drift是Solana上DEX' },
  jupiter_perps: { hasWinRate: false, hasMaxDrawdown: false, note: 'Jupiter Perps是Solana上DEX' },
  synthetix: { hasWinRate: false, hasMaxDrawdown: false, note: 'Synthetix是链上衍生品' },

  // Dune data
  dune_gmx: { hasWinRate: true, hasMaxDrawdown: false },
  dune_hyperliquid: { hasWinRate: true, hasMaxDrawdown: false },
  dune_uniswap: { hasWinRate: false, hasMaxDrawdown: false },
  dune_defi: { hasWinRate: false, hasMaxDrawdown: false },
}

/**
 * Check if a platform provides win rate data
 */
export function platformHasWinRate(source: string): boolean {
  return PLATFORM_METRICS[source]?.hasWinRate ?? false
}

/**
 * Check if a platform provides max drawdown data
 */
export function platformHasMaxDrawdown(source: string): boolean {
  return PLATFORM_METRICS[source]?.hasMaxDrawdown ?? false
}

/**
 * Get the note about a platform's data limitations
 */
export function getPlatformNote(source: string): string | undefined {
  return PLATFORM_METRICS[source]?.note
}
