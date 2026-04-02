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
/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
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
  | 'lbank'
  | 'blofin'
  | 'bitmart'
  // CEX spot
  | 'binance_spot'
  | 'bitget_spot'
  | 'bybit_spot'
  | 'okx_spot'
  | 'bingx_spot'
  // CEX web3 / wallets
  | 'binance_web3'
  | 'okx_web3'
  | 'okx_wallet'
  // DEX / on-chain perpetuals
  | 'gmx'
  | 'dydx'
  | 'hyperliquid'
  | 'gains'
  | 'jupiter_perps'
  | 'aevo'
  | 'kwenta'
  | 'synthetix'
  | 'mux'
  | 'perpetual_protocol'
  // Solana DEX
  | 'drift'
  // Arbitrum DEX
  | 'paradex'
  // New CEX
  | 'bitunix'
  | 'btcc'
  // Dune on-chain data
  | 'dune_gmx'
  | 'dune_hyperliquid'
  | 'dune_uniswap'
  | 'dune_defi'
  // Web3 bots / AI agents
  // CEX margin
  | 'bitfinex'
  | 'toobit'
  // Social trading
  | 'etoro'
  // Web3 bots / AI agents
  | 'web3_bot'
  // New platforms (Wave 2)
  | 'woox'
  | 'polymarket'
  | 'copin'

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
  'phemex',
  'htx_futures',
  'weex',
  'bingx',
  'gateio',
  'xt',
  'lbank',
  'blofin',
  'bitmart',
  // CEX spot
  'binance_spot',
  'bitget_spot',
  'bybit_spot',
  'okx_spot',
  'bingx_spot',
  // CEX web3
  'binance_web3',
  'okx_web3',
  // DEX / on-chain perpetuals
  'gmx',
  'dydx',
  'hyperliquid',
  'gains',
  'jupiter_perps',
  'aevo',
  'drift',
  'paradex',
  // New CEX
  'bitunix',
  'btcc',
  'bitfinex',
  'toobit',
  // Social trading
  'etoro',
  // Web3 bots
  'web3_bot',
  // New platforms (Wave 2)
  'woox',
  'polymarket',
  'copin',
]

// ---------------------------------------------------------------------------
// DEAD_BLOCKED_PLATFORMS – excluded from health alerts & freshness checks
// These platforms are structurally unable to fetch data and should not
// trigger pipeline alerts or auto-fix attempts.
// ---------------------------------------------------------------------------

export const DEAD_BLOCKED_PLATFORMS: TraderSource[] = [
  // ═══════════════════════════════════════════════════════════════
  // PERMANENTLY DEAD — exchange shut down, feature removed, or no data behind page
  // ═══════════════════════════════════════════════════════════════
  'perpetual_protocol', // Domain 404, app down, Binance delisted PERP — confirmed 2026-03-13
  'whitebit' as TraderSource, // No copy-trading feature or API — confirmed 2026-03-13
  'bitmart',      // CF 403 on API, Playwright found zero API calls — confirmed dead 2026-03-13
  'btse' as TraderSource, // SPA page 200 but zero API calls intercepted — no real data 2026-03-13
  'vertex' as TraderSource,    // No public leaderboard API — competition backend DNS dead, SDK has 0 leaderboard endpoints (2026-04-01)
  'apex_pro' as TraderSource,  // No public leaderboard API — tested 8+ endpoint patterns all 404, docs have 0 leaderboard endpoints (2026-04-01)
  'rabbitx' as TraderSource,   // ALL domains DNS dead — rabbitx.io, api.rabbitx.com, api.prod.rabbitx.io all NXDOMAIN (2026-04-01)
  // 'dydx' — RECOVERED: Heroku + Copin API fallback, 3339 traders in leaderboard_ranks (2026-03-15)

  // ═══════════════════════════════════════════════════════════════
  // MAC MINI ONLY — geo-blocked from VPS, needs residential IP
  // Data confirmed visible on user's browser, Mac Mini scripts deployed
  // ═══════════════════════════════════════════════════════════════
  // RECOVERED via Mac Mini scrapers (2026-03-13):
  // 'phemex' — Mac Mini fetch-phemex.mjs (183 traders)
  // 'lbank' — VPS scraper working (42 traders)
  // 'blofin' — VPS/Mac Mini working (429 traders)
  // 'kucoin' — RECOVERED 2026-03-31: POST API at /_api/ct-copy-trade/ works (822 traders)
  // crypto_com: DELETED — confirmed no copy trading feature on web (2026-03-19)
  // 'bingx_spot' — RECOVERED 2026-03-31: SSR extraction gets 12 spot traders
  // 'weex' — RE-ENABLED 2026-03-31: VPS scraper works (server back from 521)
  // 'okx_web3' — RE-ENABLED 2026-03-31: same v5 copytrading API as okx_futures (confirmed working)
  // dydx: RECOVERED 2026-03-31 — Copin API needs queryDate = now-3days (2-day processing delay)

  // ═══════════════════════════════════════════════════════════════
  // BLOCKED — needs API key or credentials to unlock
  // ═══════════════════════════════════════════════════════════════
  'kwenta',       // kwenta.eth.limo works, API suspended (503), needs Playwright or Graph API key
  'mux',          // app.mux.network alive, TheGraph subgraph needs THEGRAPH_API_KEY
  'synthetix',    // Copin 0 traders, TheGraph subgraph needs THEGRAPH_API_KEY
  'paradex',      // /v1/markets public, /v1/leaderboard needs JWT auth (Starknet wallet)

  // ═══════════════════════════════════════════════════════════════
  // STRUCTURAL — API limitation, not a bug
  // ═══════════════════════════════════════════════════════════════
  // 'okx_spot' — RECOVERED: v5 API supports instType=SPOT, 20+ traders — 2026-03-19
  // 'bitget_spot' — RECOVERED: 55 traders in leaderboard from old data
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
  'htx_futures',
  'coinex',
  'bingx',
  'gateio',
  'xt',
  'blofin',
  'btcc',
  'bitfinex',
  'bitunix',
  'toobit',
  'weex',
  // Social trading
  'etoro',
  // Web3 / DEX
  'gmx',
  'hyperliquid',
  'gains',
  'okx_web3',
  'dydx',
  'jupiter_perps',
  'aevo',
  'drift',
  'web3_bot',
  // Spot
  'binance_spot',
  'bybit_spot',
  'binance_web3',
  // New platforms (Wave 2)
  'woox',
  'polymarket',
  'copin',
]

// ---------------------------------------------------------------------------
// SOURCES_WITH_DATA – platforms with significant data (>50 records)
// Used to filter UI platform options. Updated based on actual DB counts.
// ---------------------------------------------------------------------------

export const SOURCES_WITH_DATA: TraderSource[] = [
  // CEX futures
  'binance_futures',
  'bybit',
  'bitget_futures',
  'okx_futures',
  'mexc',
  'htx_futures',
  'coinex',
  'bingx',
  'gateio',
  'xt',
  'blofin',
  'btcc',
  'bitfinex',
  'bitunix',
  'toobit',
  'weex',
  'kucoin',
  'phemex',
  'lbank',
  // Social trading
  'etoro',
  // CEX spot
  'binance_spot',
  'bybit_spot',
  'okx_spot',
  // Web3 / DEX
  'gmx',
  'hyperliquid',
  'gains',
  'okx_web3',
  'aevo',
  'dydx',
  'jupiter_perps',
  'binance_web3',
  'drift',
  'web3_bot',
  // New platforms (Wave 2)
  'woox',
  'polymarket',
  'copin',
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
  bybit: { name: 'Bybit', sourceType: 'futures', reliability: 85, trustWeight: 0.85, roiType: 'mixed' },
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
  // pionex: removed — no public leaderboard API
  lbank: { name: 'LBank', sourceType: 'futures', reliability: 35, trustWeight: 0.60, roiType: 'mixed' },
  blofin: { name: 'BloFin', sourceType: 'futures', reliability: 40, trustWeight: 0.65, roiType: 'mixed' },
  bitmart: { name: 'BitMart', sourceType: 'futures', reliability: 65, trustWeight: 0.65, roiType: 'mixed' },
  // CEX spot
  binance_spot: { name: 'Binance Spot', sourceType: 'spot', reliability: 88, trustWeight: 1.0, roiType: 'mixed' },
  bitget_spot: { name: 'Bitget Spot', sourceType: 'spot', reliability: 65, trustWeight: 0.80, roiType: 'mixed' },
  bybit_spot: { name: 'Bybit Spot', sourceType: 'spot', reliability: 45, trustWeight: 0.85, roiType: 'mixed' },
  okx_spot: { name: 'OKX Spot', sourceType: 'spot', reliability: 90, trustWeight: 0.80, roiType: 'mixed' },
  bingx_spot: { name: 'BingX Spot', sourceType: 'spot', reliability: 70, trustWeight: 0.80, roiType: 'mixed' },
  // CEX web3 / wallets
  binance_web3: { name: 'Binance Web3', sourceType: 'web3', reliability: 85, trustWeight: 0.85, roiType: 'mixed' },
  okx_web3: { name: 'OKX Web3', sourceType: 'web3', reliability: 90, trustWeight: 1.0, roiType: 'mixed' },
  okx_wallet: { name: 'OKX Wallet', sourceType: 'web3', reliability: 90, trustWeight: 1.0, roiType: 'mixed' },
  // DEX / on-chain perpetuals
  gmx: { name: 'GMX', sourceType: 'web3', reliability: 95, trustWeight: 1.0, roiType: 'realized' },
  dydx: { name: 'dYdX', sourceType: 'web3', reliability: 90, trustWeight: 0.95, roiType: 'realized' },
  hyperliquid: { name: 'Hyperliquid', sourceType: 'web3', reliability: 95, trustWeight: 1.0, roiType: 'mixed' },
  drift: { name: 'Drift', sourceType: 'web3', reliability: 80, trustWeight: 0.90, roiType: 'mixed' },
  paradex: { name: 'Paradex', sourceType: 'web3', reliability: 80, trustWeight: 0.90, roiType: 'realized' },
  // kwenta, mux, vertex, synthetix: removed — no accessible public leaderboard APIs
  gains: { name: 'Gains Network', sourceType: 'web3', reliability: 95, trustWeight: 0.95, roiType: 'realized' },
  jupiter_perps: { name: 'Jupiter Perps', sourceType: 'web3', reliability: 85, trustWeight: 0.95, roiType: 'mixed' },
  aevo: { name: 'Aevo', sourceType: 'web3', reliability: 85, trustWeight: 0.90, roiType: 'mixed' },
  perpetual_protocol: { name: 'Perpetual Protocol', sourceType: 'web3', reliability: 85, trustWeight: 0.90, roiType: 'mixed' },
  // Dune on-chain data
  dune_gmx: { name: 'GMX (Dune)', sourceType: 'web3', reliability: 90, trustWeight: 0.95, roiType: 'realized' },
  dune_hyperliquid: { name: 'Hyperliquid (Dune)', sourceType: 'web3', reliability: 90, trustWeight: 0.95, roiType: 'mixed' },
  dune_uniswap: { name: 'Uniswap (Dune)', sourceType: 'spot', reliability: 85, trustWeight: 0.85, roiType: 'realized' },
  dune_defi: { name: 'DeFi (Dune)', sourceType: 'web3', reliability: 80, trustWeight: 0.80, roiType: 'mixed' },
  bitunix: { name: 'Bitunix', sourceType: 'futures', reliability: 65, trustWeight: 0.75, roiType: 'mixed' },
  btcc: { name: 'BTCC', sourceType: 'futures', reliability: 65, trustWeight: 0.75, roiType: 'mixed' },
  bitfinex: { name: 'Bitfinex', sourceType: 'futures', reliability: 70, trustWeight: 0.80, roiType: 'mixed' },
  toobit: { name: 'Toobit', sourceType: 'futures', reliability: 50, trustWeight: 0.65, roiType: 'mixed' },
  etoro: { name: 'eToro', sourceType: 'spot', reliability: 90, trustWeight: 0.85, roiType: 'realized' },
  web3_bot: { name: 'Web3 Bot', sourceType: 'web3', reliability: 75, trustWeight: 0.70, roiType: 'mixed' },
  // New platforms (Wave 2)
  woox: { name: 'WOO X', sourceType: 'futures', reliability: 80, trustWeight: 0.85, roiType: 'mixed' },
  polymarket: { name: 'Polymarket', sourceType: 'web3', reliability: 90, trustWeight: 0.80, roiType: 'realized' },
  copin: { name: 'Copin', sourceType: 'web3', reliability: 85, trustWeight: 0.90, roiType: 'realized' },
  kwenta: { name: 'Kwenta', sourceType: 'web3', reliability: 70, trustWeight: 0.75, roiType: 'realized' },
  synthetix: { name: 'Synthetix', sourceType: 'futures', reliability: 70, trustWeight: 0.75, roiType: 'mixed' },
  mux: { name: 'MUX Protocol', sourceType: 'futures', reliability: 60, trustWeight: 0.70, roiType: 'mixed' },
}

// ---------------------------------------------------------------------------
// Backward-compatible derived exports from EXCHANGE_CONFIG
// ---------------------------------------------------------------------------

/** @deprecated Use EXCHANGE_CONFIG[source].name instead */
export const EXCHANGE_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(EXCHANGE_CONFIG).map(([k, v]) => [k, v.name])
)

// ---------------------------------------------------------------------------
// EXCHANGE_SLUG_ALIASES – friendly URL slugs that map to canonical source keys
// e.g. /rankings/binance → /rankings/binance_futures
// ---------------------------------------------------------------------------

export const EXCHANGE_SLUG_ALIASES: Record<string, string> = {
  binance: 'binance_futures',
  okx: 'okx_futures',
  bitget: 'bitget_futures',
  htx: 'htx_futures',
  gate: 'gateio',
  'gate.io': 'gateio',
  jupiter: 'jupiter_perps',
  woo: 'woox',
  'woo_x': 'woox',
}

/** Resolve a URL slug to the canonical exchange source key.
 *  Handles hyphenated URLs (binance-futures → binance_futures) and aliases (binance → binance_futures). */
export function resolveExchangeSlug(slug: string): string {
  // Check alias first (exact match)
  if (EXCHANGE_SLUG_ALIASES[slug]) return EXCHANGE_SLUG_ALIASES[slug]
  // Normalize hyphens → underscores (URL-friendly → DB key)
  const normalized = slug.replace(/-/g, '_')
  return EXCHANGE_SLUG_ALIASES[normalized] || normalized
}

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

// ---------------------------------------------------------------------------
// Safety: ensure SOURCES_WITH_DATA never contains dead/blocked platforms
// ---------------------------------------------------------------------------
const _deadSet = new Set<string>(DEAD_BLOCKED_PLATFORMS)
// Mutate in-place to keep the same array reference
for (let i = SOURCES_WITH_DATA.length - 1; i >= 0; i--) {
  if (_deadSet.has(SOURCES_WITH_DATA[i])) SOURCES_WITH_DATA.splice(i, 1)
}

/** ROI type per source – derived from EXCHANGE_CONFIG */
export const SOURCE_ROI_TYPE: Record<string, RoiType> = Object.fromEntries(
  Object.entries(EXCHANGE_CONFIG).map(([k, v]) => [k, v.roiType])
)

// ---------------------------------------------------------------------------
// SOURCE_TO_CONNECTOR_MAP – maps source names to ConnectorRegistry keys
// ---------------------------------------------------------------------------

/**
 * Maps source names (used in DB and cron groups) to ConnectorRegistry lookup keys.
 * Source names like 'htx_futures' map to connector platform 'htx' + marketType 'futures'.
 * Used by batch-fetch-traders and fetch-traders/[platform] routes.
 */
export const SOURCE_TO_CONNECTOR_MAP: Record<string, { platform: string; marketType: string }> = {
  binance_futures: { platform: 'binance_futures', marketType: 'futures' },
  binance_spot: { platform: 'binance_spot', marketType: 'spot' },
  binance_web3: { platform: 'binance_web3', marketType: 'web3' },
  bitget_futures: { platform: 'bitget_futures', marketType: 'futures' },
  bitget_spot: { platform: 'bitget_spot', marketType: 'spot' },
  okx_futures: { platform: 'okx_futures', marketType: 'futures' },
  okx_spot: { platform: 'okx_spot', marketType: 'spot' },
  okx_web3: { platform: 'okx_web3', marketType: 'web3' },
  htx_futures: { platform: 'htx_futures', marketType: 'futures' },
  mexc: { platform: 'mexc', marketType: 'futures' },
  coinex: { platform: 'coinex', marketType: 'futures' },
  bingx: { platform: 'bingx', marketType: 'futures' },
  gateio: { platform: 'gateio', marketType: 'futures' },
  xt: { platform: 'xt', marketType: 'futures' },
  blofin: { platform: 'blofin', marketType: 'futures' },
  btcc: { platform: 'btcc', marketType: 'futures' },
  bitunix: { platform: 'bitunix', marketType: 'futures' },
  bitfinex: { platform: 'bitfinex', marketType: 'futures' },
  toobit: { platform: 'toobit', marketType: 'futures' },
  etoro: { platform: 'etoro', marketType: 'spot' },
  bybit: { platform: 'bybit', marketType: 'futures' },
  bybit_spot: { platform: 'bybit_spot', marketType: 'spot' },
  hyperliquid: { platform: 'hyperliquid', marketType: 'perp' },
  gmx: { platform: 'gmx', marketType: 'perp' },
  dydx: { platform: 'dydx', marketType: 'perp' },
  gains: { platform: 'gains', marketType: 'perp' },
  jupiter_perps: { platform: 'jupiter_perps', marketType: 'perp' },
  aevo: { platform: 'aevo', marketType: 'perp' },
  drift: { platform: 'drift', marketType: 'perp' },
  web3_bot: { platform: 'web3_bot', marketType: 'spot' },
  weex: { platform: 'weex', marketType: 'futures' },
  phemex: { platform: 'phemex', marketType: 'futures' },
  lbank: { platform: 'lbank', marketType: 'futures' },
  kucoin: { platform: 'kucoin', marketType: 'futures' },
  kwenta: { platform: 'kwenta', marketType: 'perp' },
  // New platforms (Wave 2)
  woox: { platform: 'woox', marketType: 'copy' },
  polymarket: { platform: 'polymarket', marketType: 'copy' },
  copin: { platform: 'copin', marketType: 'perp' },
  // DEAD (2026-04): rabbitx (DNS dead), vertex (no public leaderboard API), apex_pro (no public leaderboard API, geo-blocked)
}
