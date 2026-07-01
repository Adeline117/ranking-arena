/**
 * Significant-event thresholds for proactive trader-event broadcasts.
 *
 * When a trader that users FOLLOW (trader_follows) moves past one of these
 * day-over-day thresholds, the broadcast-trader-events cron notifies all their
 * followers (respecting user_profiles.notify_trader_events). Kept deliberately
 * high so only genuinely notable moves broadcast — the cron is daily and
 * notifications dedupe within 1h, but the thresholds are the real volume gate.
 *
 * Distinct from the per-user opt-in `trader_alerts` thresholds (which each user
 * tunes themselves). These are the platform-wide "this is big" bar.
 */

/** Absolute rank movement (places) that counts as a notable move. */
export const EVENT_RANK_MOVE = 20

/** Absolute ROI change (percentage points, day-over-day) that's notable. */
export const EVENT_ROI_MOVE_PCT = 20

/** Absolute PnL change (USD, day-over-day) that's notable. */
export const EVENT_PNL_MOVE_USD = 50_000
