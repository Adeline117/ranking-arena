/**
 * Shared exchange/source constants
 *
 * Single source of truth for all exchange-related mappings used across the
 * codebase: API routes, SSR data loading, cron jobs, and UI components.
 *
 * Key naming convention: the `source` column in `trader_snapshots` /
 * `trader_sources` uses snake_case identifiers (e.g. "binance_futures").
 * All constants here must match those DB values exactly.
 */

// ---------------------------------------------------------------------------
// Source type
// ---------------------------------------------------------------------------

export type SourceType = 'futures' | 'spot' | 'web3'

/**
 * Union of every known source identifier stored in the database.
 * Keep in sync with import scripts and the `source` column.
 */
export type TraderSource =
  // CEX futures
  | 'binance_futures'
  | 'bybit'
  | 'bitget_futures'
  | 'okx_futures'
  | 'mexc'
  | 'kucoin'
  | 'coinex'
  | 'htx_futures'
  | 'weex'
  | 'phemex'
  | 'bingx'
  | 'gateio'
  | 'xt'
  | 'pionex'
  | 'lbank'
  | 'blofin'
  | 'bitmart'
  // CEX spot
  | 'binance_spot'
  | 'bitget_spot'
  | 'bybit_spot'
  | 'okx_spot'
  // CEX web3 / wallets
  | 'binance_web3'
  | 'okx_web3'
  | 'okx_wallet'
  // DEX / on-chain perpetuals
  | 'gmx'
  | 'dydx'
  | 'hyperliquid'
  | 'kwenta'
  | 'gains'
  | 'mux'
  | 'vertex'
  | 'drift'
  | 'jupiter_perps'
  | 'aevo'
  | 'synthetix'
  // Dune on-chain data
  | 'dune_gmx'
  | 'dune_hyperliquid'
  | 'dune_uniswap'
  | 'dune_defi'

// ---------------------------------------------------------------------------
// ALL_SOURCES – exhaustive list of every source the system can query
// ---------------------------------------------------------------------------

export const ALL_SOURCES: TraderSource[] = [
  // CEX futures
  'binance_futures',
  'bybit',
  'bitget_futures',
  'mexc',
  'coinex',
  'okx_futures',
  'kucoin',
  'bitmart',
  'phemex',
  'htx_futures',
  'weex',
  'bingx',
  'gateio',
  'xt',
  'pionex',
  'lbank',
  'blofin',
  // CEX spot
  'binance_spot',
  'bitget_spot',
  'bybit_spot',
  'okx_spot',
  // CEX web3 / wallets
  'binance_web3',
  'okx_web3',
  'okx_wallet',
  // DEX / on-chain perpetuals
  'gmx',
  'dydx',
  'hyperliquid',
  'kwenta',
  'gains',
  'mux',
  'vertex',
  'drift',
  'jupiter_perps',
  'aevo',
  'synthetix',
  // Dune on-chain data
  'dune_gmx',
  'dune_hyperliquid',
  'dune_uniswap',
  'dune_defi',
]

// ---------------------------------------------------------------------------
// SOURCE_TYPE_MAP – classifies each source as futures / spot / web3
// ---------------------------------------------------------------------------

export const SOURCE_TYPE_MAP: Record<string, SourceType> = {
  // CEX futures
  binance_futures: 'futures',
  bybit: 'futures',
  bitget_futures: 'futures',
  mexc: 'futures',
  coinex: 'futures',
  okx_futures: 'futures',
  kucoin: 'futures',
  bitmart: 'futures',
  phemex: 'futures',
  htx_futures: 'futures',
  weex: 'futures',
  bingx: 'futures',
  gateio: 'futures',
  xt: 'futures',
  pionex: 'futures',
  lbank: 'futures',
  blofin: 'futures',
  // CEX spot
  binance_spot: 'spot',
  bitget_spot: 'spot',
  bybit_spot: 'spot',
  okx_spot: 'spot',
  // CEX web3 / wallets & on-chain
  binance_web3: 'web3',
  okx_web3: 'web3',
  okx_wallet: 'web3',
  // DEX / on-chain perpetuals
  gmx: 'web3',
  dydx: 'web3',
  hyperliquid: 'web3',
  kwenta: 'web3',
  gains: 'web3',
  mux: 'web3',
  vertex: 'web3',
  drift: 'web3',
  jupiter_perps: 'web3',
  aevo: 'web3',
  synthetix: 'web3',
  // Dune on-chain data
  dune_gmx: 'web3',
  dune_hyperliquid: 'web3',
  dune_uniswap: 'spot', // Uniswap is DEX spot
  dune_defi: 'web3',
}

// ---------------------------------------------------------------------------
// PRIORITY_SOURCES – ordered subset used for SSR initial render
// ---------------------------------------------------------------------------

export const PRIORITY_SOURCES: TraderSource[] = [
  // Top CEX futures (highest volume)
  'binance_futures',
  'bybit',
  'bitget_futures',
  'okx_futures',
  // Secondary CEX futures
  'mexc',
  'kucoin',
  'htx_futures',
  'coinex',
  'bingx',
  'gateio',
  'phemex',
  'xt',
  'weex',
  'lbank',
  'blofin',
  // Web3 / DEX
  'gmx',
  'hyperliquid',
  'kwenta',
  'gains',
  'okx_web3',
  'dydx',
  // Spot
  'bitget_spot',
  'binance_spot',
  'bybit_spot',
  'okx_spot',
]

// ---------------------------------------------------------------------------
// SOURCES_WITH_DATA – platforms with significant data (>50 records)
// Used to filter UI platform options. Updated based on actual DB counts.
// ---------------------------------------------------------------------------

export const SOURCES_WITH_DATA: TraderSource[] = [
  // CEX futures
  'binance_futures',
  'bitget_futures',
  'htx_futures',
  'okx_futures',
  'mexc',
  'kucoin',
  'bybit',
  'coinex',
  'xt',
  'weex',
  // CEX spot
  'binance_spot',
  'bitget_spot',
  'bybit_spot',
  // Web3 / DEX
  'gmx',
  'hyperliquid',
  'gains',
  'okx_web3',
  'aevo',
  'dydx',
  'binance_web3',
]

// ---------------------------------------------------------------------------
// EXCHANGE_NAMES – human-readable display names for UI badges
// ---------------------------------------------------------------------------

export const EXCHANGE_NAMES: Record<string, string> = {
  binance_futures: 'Binance',
  binance_spot: 'Binance Spot',
  binance_web3: 'Binance Web3',
  bybit: 'Bybit',
  bybit_spot: 'Bybit Spot',
  bitget_futures: 'Bitget',
  bitget_spot: 'Bitget Spot',
  okx_futures: 'OKX',
  okx_spot: 'OKX Spot',
  okx_web3: 'OKX Web3',
  okx_wallet: 'OKX Wallet',
  mexc: 'MEXC',
  coinex: 'CoinEx',
  kucoin: 'KuCoin',
  bitmart: 'BitMart',
  phemex: 'Phemex',
  htx_futures: 'HTX',
  weex: 'WEEX',
  bingx: 'BingX',
  gateio: 'Gate.io',
  xt: 'XT.COM',
  pionex: 'Pionex',
  lbank: 'LBank',
  blofin: 'BloFin',
  gmx: 'GMX',
  dydx: 'dYdX',
  hyperliquid: 'Hyperliquid',
  kwenta: 'Kwenta',
  gains: 'Gains Network',
  mux: 'MUX',
  vertex: 'Vertex',
  drift: 'Drift',
  jupiter_perps: 'Jupiter Perps',
  aevo: 'Aevo',
  synthetix: 'Synthetix',
  dune_gmx: 'GMX (Dune)',
  dune_hyperliquid: 'Hyperliquid (Dune)',
  dune_uniswap: 'Uniswap (Dune)',
  dune_defi: 'DeFi (Dune)',
}

// ---------------------------------------------------------------------------
// SOURCE_RELIABILITY – data reliability scores for each platform (0-100)
// Used by data-quality scoring system
// ---------------------------------------------------------------------------

export const SOURCE_RELIABILITY: Record<string, number> = {
  // ⭐⭐⭐⭐⭐ 稳定平台 (90-100) - 纯 API，无反爬
  okx_futures: 95,
  okx_web3: 90,
  okx_wallet: 90,
  htx_futures: 95,
  gains: 95,
  hyperliquid: 95,
  gmx: 95,
  dydx: 90,
  kwenta: 88,
  mux: 88,
  vertex: 85,
  drift: 85,
  jupiter_perps: 85,
  aevo: 85,
  synthetix: 85,
  
  // ⭐⭐⭐⭐ 需代理但稳定 (80-89)
  binance_futures: 88,
  binance_spot: 88,
  binance_web3: 85,
  
  // ⭐⭐⭐ 需浏览器/有限制 (60-79)
  mexc: 75,
  kucoin: 72,
  coinex: 72,
  weex: 70,
  phemex: 70,
  bitget_futures: 68,
  bitget_spot: 65,
  bitmart: 65,
  gateio: 68,
  xt: 55,
  pionex: 60,
  
  // ⭐⭐ 不稳定/数据少 (40-59)
  bybit: 45,
  bybit_spot: 45,
  bingx: 40,
  blofin: 40,
  lbank: 35,
  
  // Dune 数据源
  dune_gmx: 90,
  dune_hyperliquid: 90,
  dune_uniswap: 85,
  dune_defi: 80,
}
