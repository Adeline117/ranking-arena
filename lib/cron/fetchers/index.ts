/**
 * Platform registry — active platform list for monitoring.
 *
 * All 24 active platforms use ConnectorRegistry + ConnectorDbAdapter.
 * Inline fetchers have been fully removed.
 *
 * This module only exports getSupportedPlatforms() for monitoring
 * (used by check-data-freshness, daily-digest).
 *
 * For fetching, use ConnectorRegistry from lib/connectors/registry.ts.
 */

/**
 * Static list of all active platforms (matches SOURCE_TO_CONNECTOR in batch-fetch-traders).
 * Used by check-data-freshness and daily-digest for monitoring coverage.
 */
const ACTIVE_PLATFORMS = [
  // CEX futures — matches batch-fetch-traders GROUPS (a1, a2, b1, b2, c, d1, d2, e, f, g)
  'binance_futures', 'binance_spot', 'okx_futures', 'okx_spot',
  'bybit', 'bybit_spot', 'bitget_futures', 'bitget_spot',
  'htx_futures', 'mexc', 'coinex', 'gateio', 'xt',
  'btcc', 'bitfinex', 'bitunix', 'toobit', 'lbank',
  // Web3 / DEX
  'binance_web3', 'okx_web3', 'hyperliquid', 'gmx',
  'drift', 'jupiter_perps', 'aevo', 'dydx',
  'gains', 'web3_bot', 'etoro', 'weex',
  // New platforms (Wave 2)
  'woox', 'polymarket', 'copin',
  // Mac Mini / VPS only (not in Vercel cron but actively fetching)
  // blofin: Mac Mini crontab, phemex: VPS scraper-cron
]

/** Returns list of all known active platforms (for monitoring). */
export function getSupportedPlatforms(): string[] {
  return [...ACTIVE_PLATFORMS]
}

/** @deprecated Renamed to getSupportedPlatforms */
export const getSupportedInlinePlatforms = getSupportedPlatforms

/** Inline fetcher function signature (for type compatibility) */
type InlineFetcherFn = (supabase: unknown, periods: string[]) => Promise<{
  source: string
  duration: number
  periods: Record<string, { total: number; saved: number; error?: string }>
}>

/**
 * @deprecated All inline fetchers have been removed. Use ConnectorRegistry instead.
 * Returns null for all platforms — kept as stub for backward compatibility.
 */
export function getInlineFetcher(_platform: string): InlineFetcherFn | null {
  return null
}

/**
 * @deprecated Inline fetchers have been removed. This is an empty registry stub.
 */
export const INLINE_FETCHERS: Record<string, InlineFetcherFn> = {}
