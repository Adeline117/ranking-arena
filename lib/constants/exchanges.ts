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
// EXCHANGE_CONFIG – unified configuration object per source
// ---------------------------------------------------------------------------

export interface ExchangeConfig {
  name: string
  sourceType: SourceType
  reliability: number
  trustWeight: number
}

export const EXCHANGE_CONFIG: Record<TraderSource, ExchangeConfig> = {
  // CEX futures
  binance_futures: { name: 'Binance', sourceType: 'futures', reliability: 88, trustWeight: 1.0 },
  bybit: { name: 'Bybit', sourceType: 'futures', reliability: 45, trustWeight: 0.85 },
  bitget_futures: { name: 'Bitget', sourceType: 'futures', reliability: 68, trustWeight: 0.85 },
  okx_futures: { name: 'OKX', sourceType: 'futures', reliability: 95, trustWeight: 1.0 },
  mexc: { name: 'MEXC', sourceType: 'futures', reliability: 75, trustWeight: 0.80 },
  kucoin: { name: 'KuCoin', sourceType: 'futures', reliability: 72, trustWeight: 0.80 },
  coinex: { name: 'CoinEx', sourceType: 'futures', reliability: 72, trustWeight: 0.80 },
  htx_futures: { name: 'HTX', sourceType: 'futures', reliability: 95, trustWeight: 0.95 },
  weex: { name: 'WEEX', sourceType: 'futures', reliability: 70, trustWeight: 0.70 },
  phemex: { name: 'Phemex', sourceType: 'futures', reliability: 70, trustWeight: 0.75 },
  bingx: { name: 'BingX', sourceType: 'futures', reliability: 40, trustWeight: 0.65 },
  gateio: { name: 'Gate.io', sourceType: 'futures', reliability: 68, trustWeight: 0.80 },
  xt: { name: 'XT.COM', sourceType: 'futures', reliability: 55, trustWeight: 0.65 },
  pionex: { name: 'Pionex', sourceType: 'futures', reliability: 60, trustWeight: 0.65 },
  lbank: { name: 'LBank', sourceType: 'futures', reliability: 35, trustWeight: 0.60 },
  blofin: { name: 'BloFin', sourceType: 'futures', reliability: 40, trustWeight: 0.65 },
  bitmart: { name: 'BitMart', sourceType: 'futures', reliability: 65, trustWeight: 0.65 },
  // CEX spot
  binance_spot: { name: 'Binance Spot', sourceType: 'spot', reliability: 88, trustWeight: 1.0 },
  bitget_spot: { name: 'Bitget Spot', sourceType: 'spot', reliability: 65, trustWeight: 0.80 },
  bybit_spot: { name: 'Bybit Spot', sourceType: 'spot', reliability: 45, trustWeight: 0.85 },
  okx_spot: { name: 'OKX Spot', sourceType: 'spot', reliability: 90, trustWeight: 0.80 },
  // CEX web3 / wallets
  binance_web3: { name: 'Binance Web3', sourceType: 'web3', reliability: 85, trustWeight: 0.85 },
  okx_web3: { name: 'OKX Web3', sourceType: 'web3', reliability: 90, trustWeight: 1.0 },
  okx_wallet: { name: 'OKX Wallet', sourceType: 'web3', reliability: 90, trustWeight: 1.0 },
  // DEX / on-chain perpetuals
  gmx: { name: 'GMX', sourceType: 'web3', reliability: 95, trustWeight: 1.0 },
  dydx: { name: 'dYdX', sourceType: 'web3', reliability: 90, trustWeight: 0.95 },
  hyperliquid: { name: 'Hyperliquid', sourceType: 'web3', reliability: 95, trustWeight: 1.0 },
  kwenta: { name: 'Kwenta', sourceType: 'web3', reliability: 88, trustWeight: 0.90 },
  gains: { name: 'Gains Network', sourceType: 'web3', reliability: 95, trustWeight: 0.95 },
  mux: { name: 'MUX', sourceType: 'web3', reliability: 88, trustWeight: 0.85 },
  vertex: { name: 'Vertex', sourceType: 'web3', reliability: 85, trustWeight: 0.85 },
  drift: { name: 'Drift', sourceType: 'web3', reliability: 85, trustWeight: 0.90 },
  jupiter_perps: { name: 'Jupiter Perps', sourceType: 'web3', reliability: 85, trustWeight: 0.95 },
  aevo: { name: 'Aevo', sourceType: 'web3', reliability: 85, trustWeight: 0.90 },
  synthetix: { name: 'Synthetix', sourceType: 'web3', reliability: 85, trustWeight: 0.90 },
  // Dune on-chain data
  dune_gmx: { name: 'GMX (Dune)', sourceType: 'web3', reliability: 90, trustWeight: 0.95 },
  dune_hyperliquid: { name: 'Hyperliquid (Dune)', sourceType: 'web3', reliability: 90, trustWeight: 0.95 },
  dune_uniswap: { name: 'Uniswap (Dune)', sourceType: 'spot', reliability: 85, trustWeight: 0.85 },
  dune_defi: { name: 'DeFi (Dune)', sourceType: 'web3', reliability: 80, trustWeight: 0.80 },
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
