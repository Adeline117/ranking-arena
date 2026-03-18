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
  'okx_futures', 'htx_futures', 'binance_futures', // binance_spot REMOVED 2026-03-14
  'binance_web3', 'okx_web3', 'xt', 'bingx', // bitget_futures REMOVED 2026-03-18 (6th stuck)
  'gateio', 'mexc', 'coinex', 'phemex', 'bybit', 'blofin',
  'bitfinex', 'toobit', 'drift', 'bitunix', 'btcc', 'web3_bot',
  'etoro', 'hyperliquid', 'gmx', 'gains', 'jupiter_perps',
  'aevo', 'dydx', 'kwenta',
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
