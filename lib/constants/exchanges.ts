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
  dune_gmx: 'GMX (Dune)',
  dune_hyperliquid: 'Hyperliquid (Dune)',
  dune_uniswap: 'Uniswap (Dune)',
  dune_defi: 'DeFi (Dune)',
}
