/**
 * Platform fetcher registry (DEPRECATED — all inline fetchers removed)
 *
 * All 24 active platforms now use ConnectorRegistry + ConnectorDbAdapter
 * in batch-fetch-traders. The inline fetcher files have been deleted.
 *
 * This module preserves the API surface for callers that import
 * getInlineFetcher / getSupportedInlinePlatforms.
 * - getInlineFetcher: always returns undefined (connector path handles all platforms)
 * - getSupportedInlinePlatforms: returns static list of all known active platforms
 *   (used by check-data-freshness and daily-digest for monitoring)
 *
 * @deprecated Use ConnectorRegistry from lib/connectors/registry.ts instead
 */

import type { PlatformFetcher } from './shared'

/**
 * Static list of all active platforms (matches SOURCE_TO_CONNECTOR in batch-fetch-traders).
 * Used by check-data-freshness and daily-digest for monitoring coverage.
 */
const ACTIVE_PLATFORMS = [
  'okx_futures', 'htx_futures', 'binance_futures', 'binance_spot',
  'binance_web3', 'okx_web3', 'bitget_futures', 'xt', 'bingx',
  'gateio', 'mexc', 'coinex', 'phemex', 'bybit', 'blofin',
  'bitfinex', 'toobit', 'drift', 'bitunix', 'btcc', 'web3_bot',
  'etoro', 'hyperliquid', 'gmx', 'gains', 'jupiter_perps',
  'aevo', 'dydx', 'kwenta',
]

/** @deprecated No inline fetchers remain — use ConnectorRegistry */
export const INLINE_FETCHERS: Record<string, PlatformFetcher> = {}

/** @deprecated Always returns undefined — use ConnectorRegistry */
export function getInlineFetcher(platform: string): PlatformFetcher | undefined {
  return INLINE_FETCHERS[platform]
}

/** Returns list of all known active platforms (for monitoring). */
export function getSupportedInlinePlatforms(): string[] {
  return [...ACTIVE_PLATFORMS]
}
