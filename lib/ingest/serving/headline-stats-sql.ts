/**
 * Native-board headline stats upsert (publishLeaderboardSnapshotInTransaction).
 *
 * Kept in a dependency-free module so the exact production statement can be
 * executed against an isolated PostgreSQL 17 cluster
 * (`__tests__/headline-stats-as-of.pg17.sh`) without loading the worker DB pool.
 *
 * Parameters: $1 timeframe, $2 scraped_at (as_of), $3 currency,
 * $4 jsonb rows, $5 source_id.
 *
 * as_of semantics (row freshness = oldest surviving headline fact):
 *   - A headline column that this board did NOT send (EXCLUDED IS NULL) but
 *     the row already holds is retained by COALESCE below. That retained value
 *     is older than this board, so as_of stays LEAST(old, new).
 *   - A board that re-sends every headline column the row holds advances
 *     as_of to the new scrape. Profile-only state (profit_share_rate,
 *     trading_preferences, extras incl. `_arena_profile_publication_epoch_ms`)
 *     does NOT freeze as_of: profile publications carry their own ordering
 *     watermark in extras and are not columns this board claims to observe.
 *     The previous rule (any non-empty extras ⇒ LEAST) froze as_of forever for
 *     every trader that had ever been profile-crawled, so the 48h freshness
 *     join in arena_score_inputs dropped them from public rankings.
 */
export const HEADLINE_STATS_UPSERT_SQL = `INSERT INTO arena.trader_stats
           (trader_id, timeframe, as_of, currency, roi, pnl, win_rate, mdd, sharpe, aum, copier_count, copier_pnl, volume,
            win_positions, total_positions, holding_duration_avg, extras)
         SELECT t.id, $1, $2, $3, r.roi, r.pnl, r.win_rate, r.mdd, r.sharpe, r.aum, r.copier_count, r.copier_pnl, r.volume,
                r.win_positions, r.total_positions,
                CASE WHEN r.holding_hours IS NOT NULL THEN make_interval(secs => r.holding_hours * 3600) ELSE NULL END,
                COALESCE(r.extras, '{}'::jsonb)
           FROM jsonb_to_recordset($4::jsonb) AS r(
             exchange_trader_id text, roi numeric, pnl numeric, win_rate numeric,
             mdd numeric, sharpe numeric, aum numeric, copier_count integer, copier_pnl numeric, volume numeric,
             win_positions integer, total_positions integer, holding_hours numeric, extras jsonb)
           JOIN arena.traders t
             ON t.source_id = $5 AND t.exchange_trader_id = r.exchange_trader_id
         ON CONFLICT (trader_id, timeframe) DO UPDATE SET
           as_of           = CASE WHEN
             (EXCLUDED.roi IS NULL AND arena.trader_stats.roi IS NOT NULL) OR
             (EXCLUDED.pnl IS NULL AND arena.trader_stats.pnl IS NOT NULL) OR
             (EXCLUDED.win_rate IS NULL AND arena.trader_stats.win_rate IS NOT NULL) OR
             (EXCLUDED.mdd IS NULL AND arena.trader_stats.mdd IS NOT NULL) OR
             (EXCLUDED.sharpe IS NULL AND arena.trader_stats.sharpe IS NOT NULL) OR
             (EXCLUDED.aum IS NULL AND arena.trader_stats.aum IS NOT NULL) OR
             (EXCLUDED.copier_count IS NULL AND arena.trader_stats.copier_count IS NOT NULL) OR
             (EXCLUDED.copier_pnl IS NULL AND arena.trader_stats.copier_pnl IS NOT NULL) OR
             (EXCLUDED.volume IS NULL AND arena.trader_stats.volume IS NOT NULL) OR
             (EXCLUDED.win_positions IS NULL AND arena.trader_stats.win_positions IS NOT NULL) OR
             (EXCLUDED.total_positions IS NULL AND arena.trader_stats.total_positions IS NOT NULL) OR
             (EXCLUDED.holding_duration_avg IS NULL AND arena.trader_stats.holding_duration_avg IS NOT NULL)
             THEN LEAST(arena.trader_stats.as_of, EXCLUDED.as_of)
             ELSE EXCLUDED.as_of
           END,
           currency        = EXCLUDED.currency,
           roi             = COALESCE(EXCLUDED.roi, arena.trader_stats.roi),
           pnl             = COALESCE(EXCLUDED.pnl, arena.trader_stats.pnl),
           win_rate        = COALESCE(EXCLUDED.win_rate, arena.trader_stats.win_rate),
           mdd             = COALESCE(EXCLUDED.mdd, arena.trader_stats.mdd),
           sharpe          = COALESCE(EXCLUDED.sharpe, arena.trader_stats.sharpe),
           aum             = COALESCE(EXCLUDED.aum, arena.trader_stats.aum),
           copier_count    = COALESCE(EXCLUDED.copier_count, arena.trader_stats.copier_count),
           copier_pnl      = COALESCE(EXCLUDED.copier_pnl, arena.trader_stats.copier_pnl),
           volume          = COALESCE(EXCLUDED.volume, arena.trader_stats.volume),
           win_positions   = COALESCE(EXCLUDED.win_positions, arena.trader_stats.win_positions),
           total_positions = COALESCE(EXCLUDED.total_positions, arena.trader_stats.total_positions),
           holding_duration_avg = COALESCE(EXCLUDED.holding_duration_avg, arena.trader_stats.holding_duration_avg),
           extras          = CASE WHEN EXCLUDED.extras = '{}'::jsonb THEN arena.trader_stats.extras
                                  ELSE COALESCE(arena.trader_stats.extras, '{}'::jsonb) || EXCLUDED.extras END`
