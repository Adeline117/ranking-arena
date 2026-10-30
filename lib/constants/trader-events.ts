/**
 * Historical thresholds for a retired followed-trader event broadcaster.
 *
 * V1 does not publish or deliver trader-event notifications. Keep these values
 * only as legacy data/implementation context; they are not an authorization to
 * restore a scheduler, reader, notification writer, or push delivery path.
 */

/** Absolute rank movement (places) that counts as a notable move. */
export const EVENT_RANK_MOVE = 20
