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
  'binance_futures',
  'binance_spot',
  'okx_futures',
  'okx_spot',
  'bybit',
  'bybit_spot',
  'bitget_futures',
  'htx_futures',
  'mexc',
  'coinex',
  'gateio',
  'xt',
  'btcc',
  'bitfinex',
  'bitunix',
  'toobit',
  // Web3 / DEX
  'binance_web3',
  'okx_web3',
  'hyperliquid',
  'gmx',
  'drift',
  'jupiter_perps',
  'aevo',
  'dydx',
  'gains',
  'etoro',
  'weex',
  // New platforms (Wave 2)
  'woox',
  'polymarket',
  'copin',
  // Mac Mini / VPS only (not in Vercel cron but actively fetching)
  // blofin: Mac Mini crontab, phemex: VPS scraper-cron
  // REMOVED: bitget_spot, lbank, web3_bot (permanently dead)
]

/** Returns list of all known active platforms (for monitoring). */
export function getSupportedPlatforms(): string[] {
  return [...ACTIVE_PLATFORMS]
}
