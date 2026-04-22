/**
 * Trader filtering thresholds — single source of truth.
 *
 * Used by both the ranking utility (`lib/utils/ranking.ts`) and the
 * compute-leaderboard cron job. Keeping them in one place prevents the
 * two systems from drifting apart (issue H-7).
 */

/** Minimum number of trades required for a trader to be included in rankings */
export const MIN_TRADES = 10

/** Ideal number of trades (used in stability scoring) */
export const IDEAL_TRADES = 100
