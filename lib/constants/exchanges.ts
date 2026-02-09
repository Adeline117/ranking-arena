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

// SOURCE_TYPE_MAP is derived from EXCHANGE_CONFIG at the bottom of this file.
// Declared here for backward compatibility with existing imports.
// Actual value assigned after EXCHANGE_CONFIG definition.
export const SOURCE_TYPE_MAP: Record<string, SourceType> = {} as Record<string, SourceType>

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
  'phemex',
  'lbank',
  'blofin',
  'gateio',
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
  'jupiter_perps',
  'binance_web3',
  // HTX (futures alias)
  'htx_futures',
]

// ---------------------------------------------------------------------------
// EXCHANGE_CONFIG – unified configuration object per source
// ---------------------------------------------------------------------------

export type RoiType = 'realized' | 'unrealized' | 'mixed'

export interface ExchangeConfig {
  name: string
  sourceType: SourceType
  reliability: number
  trustWeight: number
  /** How ROI is calculated on this platform */
  roiType: RoiType
}

export const EXCHANGE_CONFIG: Record<TraderSource, ExchangeConfig> = {
  // CEX futures
  binance_futures: { name: 'Binance', sourceType: 'futures', reliability: 88, trustWeight: 1.0, roiType: 'mixed' },
  bybit: { name: 'Bybit', sourceType: 'futures', reliability: 45, trustWeight: 0.85, roiType: 'mixed' },
  bitget_futures: { name: 'Bitget', sourceType: 'futures', reliability: 68, trustWeight: 0.85, roiType: 'mixed' },
  okx_futures: { name: 'OKX', sourceType: 'futures', reliability: 95, trustWeight: 1.0, roiType: 'mixed' },
  mexc: { name: 'MEXC', sourceType: 'futures', reliability: 75, trustWeight: 0.80, roiType: 'mixed' },
  kucoin: { name: 'KuCoin', sourceType: 'futures', reliability: 72, trustWeight: 0.80, roiType: 'mixed' },
  coinex: { name: 'CoinEx', sourceType: 'futures', reliability: 72, trustWeight: 0.80, roiType: 'mixed' },
  htx_futures: { name: 'HTX', sourceType: 'futures', reliability: 95, trustWeight: 0.95, roiType: 'mixed' },
  weex: { name: 'WEEX', sourceType: 'futures', reliability: 70, trustWeight: 0.70, roiType: 'mixed' },
  phemex: { name: 'Phemex', sourceType: 'futures', reliability: 70, trustWeight: 0.75, roiType: 'mixed' },
  bingx: { name: 'BingX', sourceType: 'futures', reliability: 40, trustWeight: 0.65, roiType: 'mixed' },
  gateio: { name: 'Gate.io', sourceType: 'futures', reliability: 68, trustWeight: 0.80, roiType: 'mixed' },
  xt: { name: 'XT.COM', sourceType: 'futures', reliability: 55, trustWeight: 0.65, roiType: 'mixed' },
  pionex: { name: 'Pionex', sourceType: 'futures', reliability: 60, trustWeight: 0.65, roiType: 'mixed' },
  lbank: { name: 'LBank', sourceType: 'futures', reliability: 35, trustWeight: 0.60, roiType: 'mixed' },
  blofin: { name: 'BloFin', sourceType: 'futures', reliability: 40, trustWeight: 0.65, roiType: 'mixed' },
  bitmart: { name: 'BitMart', sourceType: 'futures', reliability: 65, trustWeight: 0.65, roiType: 'mixed' },
  // CEX spot
  binance_spot: { name: 'Binance Spot', sourceType: 'spot', reliability: 88, trustWeight: 1.0, roiType: 'mixed' },
  bitget_spot: { name: 'Bitget Spot', sourceType: 'spot', reliability: 65, trustWeight: 0.80, roiType: 'mixed' },
  bybit_spot: { name: 'Bybit Spot', sourceType: 'spot', reliability: 45, trustWeight: 0.85, roiType: 'mixed' },
  okx_spot: { name: 'OKX Spot', sourceType: 'spot', reliability: 90, trustWeight: 0.80, roiType: 'mixed' },
  // CEX web3 / wallets
  binance_web3: { name: 'Binance Web3', sourceType: 'web3', reliability: 85, trustWeight: 0.85, roiType: 'mixed' },
  okx_web3: { name: 'OKX Web3', sourceType: 'web3', reliability: 90, trustWeight: 1.0, roiType: 'mixed' },
  okx_wallet: { name: 'OKX Wallet', sourceType: 'web3', reliability: 90, trustWeight: 1.0, roiType: 'mixed' },
  // DEX / on-chain perpetuals
  gmx: { name: 'GMX', sourceType: 'web3', reliability: 95, trustWeight: 1.0, roiType: 'realized' },
  dydx: { name: 'dYdX', sourceType: 'web3', reliability: 90, trustWeight: 0.95, roiType: 'realized' },
  hyperliquid: { name: 'Hyperliquid', sourceType: 'web3', reliability: 95, trustWeight: 1.0, roiType: 'mixed' },
  kwenta: { name: 'Kwenta', sourceType: 'web3', reliability: 88, trustWeight: 0.90, roiType: 'realized' },
  gains: { name: 'Gains Network', sourceType: 'web3', reliability: 95, trustWeight: 0.95, roiType: 'realized' },
  mux: { name: 'MUX', sourceType: 'web3', reliability: 88, trustWeight: 0.85, roiType: 'realized' },
  vertex: { name: 'Vertex', sourceType: 'web3', reliability: 85, trustWeight: 0.85, roiType: 'mixed' },
  drift: { name: 'Drift', sourceType: 'web3', reliability: 85, trustWeight: 0.90, roiType: 'mixed' },
  jupiter_perps: { name: 'Jupiter Perps', sourceType: 'web3', reliability: 85, trustWeight: 0.95, roiType: 'mixed' },
  aevo: { name: 'Aevo', sourceType: 'web3', reliability: 85, trustWeight: 0.90, roiType: 'mixed' },
  synthetix: { name: 'Synthetix', sourceType: 'web3', reliability: 85, trustWeight: 0.90, roiType: 'realized' },
  // Dune on-chain data
  dune_gmx: { name: 'GMX (Dune)', sourceType: 'web3', reliability: 90, trustWeight: 0.95, roiType: 'realized' },
  dune_hyperliquid: { name: 'Hyperliquid (Dune)', sourceType: 'web3', reliability: 90, trustWeight: 0.95, roiType: 'mixed' },
  dune_uniswap: { name: 'Uniswap (Dune)', sourceType: 'spot', reliability: 85, trustWeight: 0.85, roiType: 'realized' },
  dune_defi: { name: 'DeFi (Dune)', sourceType: 'web3', reliability: 80, trustWeight: 0.80, roiType: 'mixed' },
}

// ---------------------------------------------------------------------------
// Backward-compatible derived exports from EXCHANGE_CONFIG
// ---------------------------------------------------------------------------

/** @deprecated Use EXCHANGE_CONFIG[source].name instead */
export const EXCHANGE_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(EXCHANGE_CONFIG).map(([k, v]) => [k, v.name])
)

// Populate SOURCE_TYPE_MAP from EXCHANGE_CONFIG
for (const [key, config] of Object.entries(EXCHANGE_CONFIG)) {
  SOURCE_TYPE_MAP[key] = config.sourceType
}

/** @deprecated Use EXCHANGE_CONFIG[source].reliability instead */
export const SOURCE_RELIABILITY: Record<string, number> = Object.fromEntries(
  Object.entries(EXCHANGE_CONFIG).map(([k, v]) => [k, v.reliability])
)

/** @deprecated Use EXCHANGE_CONFIG[source].trustWeight instead */
export const SOURCE_TRUST_WEIGHT: Record<string, number> = Object.fromEntries(
  Object.entries(EXCHANGE_CONFIG).map(([k, v]) => [k, v.trustWeight])
)

/** ROI type per source – derived from EXCHANGE_CONFIG */
export const SOURCE_ROI_TYPE: Record<string, RoiType> = Object.fromEntries(
  Object.entries(EXCHANGE_CONFIG).map(([k, v]) => [k, v.roiType])
)
