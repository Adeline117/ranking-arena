-- ============================================================
-- Create get_leaderboard_category_counts RPC
-- ============================================================
-- Root-cause fix: lib/getInitialTraders.ts has been calling
-- supabase.rpc('get_leaderboard_category_counts', ...) since the
-- 2026-04-08 fix that "replaced count(exact) fallback with static
-- estimates", but the function was never created. Every SSR request
-- was getting PGRST202 (function not found), adding ~300ms of wasted
-- round-trip + falling back to hardcoded stale estimates
-- (all: 12000, futures: 5000, spot: 1500, onchain: 5500).
--
-- Returns category counts grouped by source_type for a given season,
-- matching the same WHERE predicate used by the SSR rankings query
-- (arena_score > 0 AND not is_outlier). Uses the covering partial
-- index idx_leaderboard_ranks_api_default for fast aggregation.
--
-- Expected execution time: <50ms for 90D (~17k rows), <30ms for 30D/7D.
-- ============================================================

CREATE OR REPLACE FUNCTION get_leaderboard_category_counts(p_season_id TEXT)
RETURNS TABLE(source_type TEXT, count BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '3s'
AS $$
  SELECT
    COALESCE(lr.source_type, 'unknown')::TEXT AS source_type,
    COUNT(*)::BIGINT AS count
  FROM leaderboard_ranks lr
  WHERE lr.season_id = p_season_id
    AND lr.arena_score > 0
    AND (lr.is_outlier IS NULL OR lr.is_outlier = false)
  GROUP BY lr.source_type;
$$;

-- Grant execute to anon/authenticated/service_role so all clients can call it
GRANT EXECUTE ON FUNCTION get_leaderboard_category_counts(TEXT) TO anon, authenticated, service_role;

COMMENT ON FUNCTION get_leaderboard_category_counts(TEXT) IS
  'Returns trader counts per source_type (futures/spot/web3) for a given season_id. Used by SSR rankings page. Matches the WHERE predicate of idx_leaderboard_ranks_api_default covering index for fast aggregation.';
