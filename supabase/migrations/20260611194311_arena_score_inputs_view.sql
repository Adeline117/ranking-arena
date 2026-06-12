-- Migration: 20260611194311_arena_score_inputs_view.sql
-- Created: 2026-06-12T02:43:11Z
-- Description: ENDGAME view (cutover plan step 4) — the future single read
--   surface for Arena Score computation, replacing the compat dual-write
--   into public.trader_latest. Built NOW (zero risk: nothing reads it yet)
--   so the compute-leaderboard repoint becomes a one-line diff later.
--
--   Shape mirrors what compute-leaderboard consumes from trader_latest:
--   one row per (platform, trader_key, window) with legacy semantics
--   (roi_pct percent ±10000-clamped, win_rate 0-100, max_drawdown 0-100
--   positive, USDT-only — non-USDT sources rank via their own serving
--   read path, never coerced, spec §5.8).

CREATE OR REPLACE VIEW arena.score_inputs AS
WITH latest_passed AS (
  SELECT DISTINCT ON (ls.source_id, ls.timeframe)
         ls.id AS snapshot_id, ls.source_id, ls.timeframe, ls.scraped_at
    FROM arena.leaderboard_snapshots ls
   WHERE ls.count_check_passed
   ORDER BY ls.source_id, ls.timeframe, ls.scraped_at DESC
)
SELECT
  COALESCE(s.meta->>'legacy_platform', s.slug)            AS platform,
  CASE WHEN s.product_type = 'spot' THEN 'spot' ELSE 'futures' END AS market_type,
  t.exchange_trader_id                                     AS trader_key,
  (lp.timeframe::text || 'D')                              AS "window",
  LEAST(GREATEST(e.headline_roi, -10000), 10000)           AS roi_pct,
  e.headline_pnl                                           AS pnl_usd,
  LEAST(GREATEST(e.headline_win_rate, 0), 100)             AS win_rate,
  LEAST(abs(st.mdd), 100)                                  AS max_drawdown,
  st.copier_count                                          AS copiers,
  st.total_positions                                       AS trades_count,
  t.trader_kind,
  t.nickname                                               AS handle,
  COALESCE(t.avatar_url_mirror, t.avatar_url_origin)       AS avatar_url,
  lp.scraped_at                                            AS as_of
FROM latest_passed lp
JOIN arena.sources s            ON s.id = lp.source_id
JOIN arena.leaderboard_entries e ON e.snapshot_id = lp.snapshot_id
JOIN arena.traders t            ON t.id = e.trader_id
LEFT JOIN arena.trader_stats st ON st.trader_id = t.id AND st.timeframe = lp.timeframe
WHERE s.currency = 'USDT'                 -- never sum/rank across units
  AND s.serving_mode <> 'legacy'
  AND (s.meta->>'legacy_platform') IS DISTINCT FROM 'null';

GRANT SELECT ON arena.score_inputs TO service_role;
