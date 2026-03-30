/** Standard timeout constants used across the codebase */
export const TIMEOUTS = {
  /** Default API request timeout */
  API_REQUEST: 15_000,
  /** VPS scraper request timeout */
  VPS_SCRAPER: 120_000,
  /** Enrichment per-platform timeout */
  ENRICHMENT: 60_000,
  /** SWR hook fetch timeout */
  SWR_FETCH: 15_000,
  /** Rate limiter delay */
  RATE_LIMIT_DELAY: 2_000,
  /** Circuit breaker reset */
  CIRCUIT_BREAKER_RESET: 60_000,
  /** Cache TTL for VPS responses */
  VPS_CACHE_TTL: 90 * 60_000,
  /** Cron job max duration */
  CRON_MAX_DURATION: 300_000,
} as const
