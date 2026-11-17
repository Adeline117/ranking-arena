/**
 * Tier-B/C profile stats upsert (publishProfile).
 *
 * Kept in a dependency-free module so the exact production statement can be
 * executed against an isolated PostgreSQL 17 cluster
 * (supabase/migrations/__tests__/profile-acquisition-evidence.pg17.sh)
 * without loading the worker DB pool.
 *
 * Parameters: $1 trader_id, $2 timeframe, $3 as_of, $4 currency, $5 roi,
 * $6 pnl, $7 sharpe, $8 mdd, $9 win_rate, $10 win_positions,
 * $11 total_positions, $12 copier_pnl, $13 copier_count, $14 aum, $15 volume,
 * $16 profit_share_rate, $17 holding seconds, $18 trading_preferences jsonb,
 * $19 extras jsonb, $20 preserve fill metrics, $21 profile evidence attempt
 * seq (NULL when this publish carries no attempt-bound profile evidence),
 * $22 profile evidence metrics.
 *
 * Evidence (20261116215328): an attested publish replaces the row's profile
 * attestation with its own; the table trigger accepts it only for a complete
 * capture of this trader and timeframe and only for values equal to the
 * captured ones. Any other publish keeps the pointer, and the trigger strips
 * each attested metric whose value it changed. #489's board pointer is never
 * written here, so its trigger strips board-attested values this changes.
 */
export const PROFILE_PUBLICATION_EPOCH_KEY = '_arena_profile_publication_epoch_ms'

export const PROFILE_STATS_UPSERT_SQL = `INSERT INTO arena.trader_stats
           (trader_id, timeframe, as_of, currency, roi, pnl, sharpe, mdd, win_rate,
            win_positions, total_positions, copier_pnl, copier_count, aum, volume,
            profit_share_rate, holding_duration_avg, trading_preferences, extras,
            profile_evidence_attempt_seq, profile_evidence_metrics)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                 make_interval(secs => $17), $18, $19, $21::bigint, $22::text[])
         ON CONFLICT (trader_id, timeframe) DO UPDATE SET
           -- A partial fill crawl retains older fill metrics. Its row-level
           -- freshness must therefore be the older observation, never "now".
           as_of = CASE WHEN $20
             THEN LEAST(arena.trader_stats.as_of, EXCLUDED.as_of)
             ELSE EXCLUDED.as_of
           END,
           currency = EXCLUDED.currency,
           roi = EXCLUDED.roi, pnl = EXCLUDED.pnl, sharpe = EXCLUDED.sharpe,
           mdd = EXCLUDED.mdd,
           win_rate = CASE WHEN $20 THEN arena.trader_stats.win_rate ELSE EXCLUDED.win_rate END,
           win_positions = CASE WHEN $20 THEN arena.trader_stats.win_positions ELSE EXCLUDED.win_positions END,
           total_positions = CASE WHEN $20 THEN arena.trader_stats.total_positions ELSE EXCLUDED.total_positions END,
           copier_pnl = EXCLUDED.copier_pnl, copier_count = EXCLUDED.copier_count,
           aum = EXCLUDED.aum, volume = EXCLUDED.volume,
           profit_share_rate = EXCLUDED.profit_share_rate,
           holding_duration_avg = CASE WHEN $20 THEN arena.trader_stats.holding_duration_avg ELSE EXCLUDED.holding_duration_avg END,
           trading_preferences = EXCLUDED.trading_preferences,
           extras = CASE WHEN $20
             THEN COALESCE(arena.trader_stats.extras, '{}'::jsonb) || EXCLUDED.extras
             ELSE EXCLUDED.extras
           END,
           -- An attested publish replaces the profile attestation; any other
           -- publish keeps the pointer, and the table trigger strips each
           -- attested metric whose value this write changed.
           profile_evidence_attempt_seq = CASE WHEN $21::bigint IS NULL
             THEN arena.trader_stats.profile_evidence_attempt_seq
             ELSE EXCLUDED.profile_evidence_attempt_seq
           END,
           profile_evidence_metrics = CASE WHEN $21::bigint IS NULL
             THEN arena.trader_stats.profile_evidence_metrics
             ELSE EXCLUDED.profile_evidence_metrics
           END
         -- Profile ordering is independent from board as_of. The internal
         -- numeric watermark is written by every accepted profile and avoids
         -- timestamp parsing failures from arbitrary source extras.
         WHERE COALESCE(
           CASE WHEN jsonb_typeof(arena.trader_stats.extras -> '${PROFILE_PUBLICATION_EPOCH_KEY}') = 'number'
             THEN (arena.trader_stats.extras ->> '${PROFILE_PUBLICATION_EPOCH_KEY}')::numeric
           END,
           -1
         ) <= extract(epoch FROM EXCLUDED.as_of) * 1000`
