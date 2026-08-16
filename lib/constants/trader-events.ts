/**
 * Significant-event thresholds for proactive trader-event broadcasts.
 *
 * When a trader that users FOLLOW (trader_follows) moves past one of these
 * rank threshold, the broadcast-trader-events cron notifies all their followers
 * (respecting user_profiles.notify_trader_events). Legacy ROI/PnL delta events
 * are disabled because their daily input lacks publication provenance.
 *
 * Distinct from the per-user opt-in `trader_alerts` thresholds (which each user
 * tunes themselves). These are the platform-wide "this is big" bar.
 */

/** Absolute rank movement (places) that counts as a notable move. */
export const EVENT_RANK_MOVE = 20
