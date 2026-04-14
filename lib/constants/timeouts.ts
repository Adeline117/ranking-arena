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

/**
 * SSR query timeouts — used with AbortSignal.timeout() on Supabase queries.
 *
 * During compute-leaderboard cron execution, bulk upserts hold row locks on
 * leaderboard_ranks / trader_snapshots for seconds at a time. SSR SELECT
 * queries against those tables block until the lock is released. These
 * timeouts ensure SSR queries are *actually cancelled* (AbortSignal aborts
 * the HTTP request to PostgREST) instead of just racing a setTimeout that
 * lets the abandoned query keep consuming a connection in the background.
 */
export const SSR_QUERY_TIMEOUT_MS = 3_000
export const SSR_HEAVY_QUERY_TIMEOUT_MS = 5_000

/**
 * Race a Supabase query (PromiseLike) against a timeout that also aborts
 * the underlying HTTP request via AbortController.
 *
 * Unlike a plain `Promise.race` + `setTimeout`, this actually cancels the
 * HTTP request to PostgREST when the timeout fires, freeing the connection
 * for other requests. This is critical during compute-leaderboard cron
 * contention where abandoned queries pile up and exhaust the connection pool.
 *
 * Works with any PromiseLike (Supabase query builders are thenables).
 *
 * @param queryFn  Function that receives an AbortSignal and returns the query.
 *                 Callers should pass the signal to `.abortSignal(signal)` on the
 *                 Supabase query builder (before `.single()` / `.maybeSingle()`).
 * @param timeoutMs  Timeout in milliseconds (default: SSR_QUERY_TIMEOUT_MS)
 * @param fallback   Value to return on timeout/error (default: null)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function ssrRace<T, F = any>(
  queryFn: (signal: AbortSignal) => PromiseLike<T>,
  timeoutMs: number = SSR_QUERY_TIMEOUT_MS,
  fallback?: F,
): Promise<T | F | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const result = await queryFn(controller.signal)
    clearTimeout(timer)
    return result
  } catch {
    clearTimeout(timer)
    return fallback ?? null
  }
}
