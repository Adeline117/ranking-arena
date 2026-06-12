/**
 * Centralized React Query staleTime presets.
 *
 * Use these instead of magic numbers so cache behavior is consistent
 * and tunable from one place.
 *
 * Naming convention: STALE_<speed> where speed indicates how quickly
 * the underlying data changes.
 */

/** 10s — real-time prices, market tickers */
export const STALE_REALTIME = 10_000

/** 30s — rankings, search results, social feeds, notifications */
export const STALE_STANDARD = 30_000

/** 60s — activity feeds, linked accounts, news */
export const STALE_RELAXED = 60_000

/** 2min — trader detail (pipeline refreshes every ~5min) */
export const STALE_SLOW = 120_000

/** 5min — sidebar widgets, recommendations, percentile badges */
export const STALE_STATIC = 300_000

/**
 * Centralized refetchInterval presets — pair with the STALE_* tier of the
 * same name. One knob per tier instead of magic numbers in every hook.
 */

/** 30s — real-time prices, market tickers */
export const REFETCH_REALTIME = 30_000

/** 2min — notifications, unread counters */
export const REFETCH_STANDARD = 120_000

/** 5min — trader detail/positions, posts, linked accounts */
export const REFETCH_RELAXED = 300_000

/** 15min — secondary rankings (bots) */
export const REFETCH_SLOW = 900_000

/** 30-60min — near-static lists (full leaderboard fallback, equity curves) */
export const REFETCH_STATIC = 1_800_000
