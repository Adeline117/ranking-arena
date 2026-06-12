-- Description: ENDGAME — public RPC the compute-leaderboard chain reads
-- INSTEAD of trader_latest. arena.* is not PostgREST-exposed (all reads go
-- through public SECURITY DEFINER RPCs — same pattern as arena_first_screen /
-- arena_core_modules), so the cutover reader calls this one function once per
-- window rather than ~35 per-platform PostgREST queries against trader_latest.
--
-- Per-platform cap = board rank <= p_per_platform_limit (default 1000),
-- behaviour-preserving vs the legacy `.limit(1000)` per platform/window — and
-- more correct (rank-ordered, not freshest-by-updated_at). Sources whose
-- latest passed snapshot is older than p_max_age_hours are dropped as stale
-- (the view already restricts to the latest count-check-PASSED snapshot, so
-- this only sheds genuinely-dead crawls).

-- Re-create the view with board rank exposed (the RPC ranks/caps on it).
DROP VIEW IF EXISTS arena.score_inputs;
CREATE VIEW arena.score_inputs AS
WITH latest_passed AS (
  SELECT DISTINCT ON (ls.source_id, ls.timeframe)
         ls.id AS snapshot_id, ls.source_id, ls.timeframe, ls.scraped_at
    FROM arena.leaderboard_snapshots ls
   WHERE ls.count_check_passed
   ORDER BY ls.source_id, ls.timeframe, ls.scraped_at DESC
)
SELECT
  COALESCE(s.meta->>'legacy_platform', s.slug)             AS platform,
  CASE WHEN s.product_type='spot' THEN 'spot' ELSE 'futures' END AS market_type,
  t.exchange_trader_id                                     AS trader_key,
  (lp.timeframe::text || 'D')                              AS "window",
  e.rank                                                   AS board_rank,
  LEAST(GREATEST(e.headline_roi, -10000), 10000)           AS roi_pct,
  e.headline_pnl                                           AS pnl_usd,
  LEAST(GREATEST(e.headline_win_rate, 0), 100)             AS win_rate,
  LEAST(abs(st.mdd), 100)                                  AS max_drawdown,
  st.copier_count                                          AS copiers,
  st.total_positions                                       AS trades_count,
  st.sharpe                                                AS sharpe_ratio,
  (st.extras->>'sortino')::numeric                         AS sortino_ratio,
  (st.extras->>'calmar')::numeric                          AS calmar_ratio,
  (st.extras->>'volatility')::numeric                      AS volatility_pct,
  t.trader_kind,
  t.nickname                                               AS handle,
  COALESCE(t.avatar_url_mirror, t.avatar_url_origin)       AS avatar_url,
  s.currency                                               AS currency,
  lp.scraped_at                                            AS as_of
FROM latest_passed lp
JOIN arena.sources s             ON s.id = lp.source_id
JOIN arena.leaderboard_entries e ON e.snapshot_id = lp.snapshot_id
JOIN arena.traders t             ON t.id = e.trader_id
LEFT JOIN arena.trader_stats st  ON st.trader_id = t.id AND st.timeframe = lp.timeframe
WHERE s.serving_mode <> 'legacy'
  AND s.currency IN ('USDT','USDx','USDC','USD')
  AND (s.meta->>'legacy_platform') IS DISTINCT FROM 'null';

GRANT SELECT ON arena.score_inputs TO service_role;

-- One call returns every platform's top-N for the window, already capped.
CREATE OR REPLACE FUNCTION public.arena_score_inputs(
  p_window text,
  p_per_platform_limit int DEFAULT 1000,
  p_max_age_hours int DEFAULT 48
)
RETURNS TABLE (
  platform text,
  market_type text,
  trader_key text,
  board_rank int,
  roi_pct numeric,
  pnl_usd numeric,
  win_rate numeric,
  max_drawdown numeric,
  copiers numeric,
  trades_count numeric,
  sharpe_ratio numeric,
  sortino_ratio numeric,
  calmar_ratio numeric,
  volatility_pct numeric,
  trader_kind text,
  handle text,
  avatar_url text,
  currency text,
  as_of timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = arena, public
AS $$
  SELECT si.platform, si.market_type, si.trader_key, si.board_rank,
         si.roi_pct, si.pnl_usd, si.win_rate, si.max_drawdown,
         si.copiers, si.trades_count, si.sharpe_ratio, si.sortino_ratio,
         si.calmar_ratio, si.volatility_pct, si.trader_kind, si.handle,
         si.avatar_url, si.currency, si.as_of
    FROM arena.score_inputs si
   WHERE si.window = p_window
     AND (si.board_rank IS NULL OR si.board_rank <= p_per_platform_limit)
     AND si.as_of > now() - make_interval(hours => p_max_age_hours);
$$;

-- Public read path: callable by the service role (compute cron) only.
-- Not anon/authenticated — this is a server-side ranking input, not user data.
REVOKE ALL ON FUNCTION public.arena_score_inputs(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.arena_score_inputs(text, int, int) TO service_role;
