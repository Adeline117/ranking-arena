-- ROOT-CAUSE FIX for the 2026-06-13 cutover incident.
--
-- The arena cutover collapsed leaderboard_ranks to bitget-only (30D 5644→471
-- rows, 7D gone). Cause: PostgREST caps table-returning RPC results at ~1000
-- rows, so arena_score_inputs (15k+ rows) silently truncated to the first ~1000
-- (all bitget — the lowest source_id), and compute's per-platform cleanup then
-- WIPED every other source. This jsonb variant returns ONE row carrying the
-- whole array, which has no row-count cap, so the reader gets the full set.
-- (Applied live via MCP during the incident; this file records it for the repo.)
CREATE OR REPLACE FUNCTION public.arena_score_inputs_json(
  p_window text,
  p_per_platform_limit int DEFAULT 1000,
  p_max_age_hours int DEFAULT 48
)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = arena, public
AS $$
  SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
  FROM (
    SELECT si.platform, si.market_type, si.trader_key, si.board_rank,
           si.roi_pct, si.pnl_usd, si.win_rate, si.max_drawdown,
           si.copiers, si.trades_count, si.sharpe_ratio, si.sortino_ratio,
           si.calmar_ratio, si.volatility_pct, si.trader_kind, si.handle,
           si.avatar_url, si.currency, si.as_of
      FROM arena.score_inputs si
     WHERE si.window = p_window
       AND (si.board_rank IS NULL OR si.board_rank <= p_per_platform_limit)
       AND si.as_of > now() - make_interval(hours => p_max_age_hours)
  ) t;
$$;

REVOKE ALL ON FUNCTION public.arena_score_inputs_json(text, int, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.arena_score_inputs_json(text, int, int) TO service_role;
