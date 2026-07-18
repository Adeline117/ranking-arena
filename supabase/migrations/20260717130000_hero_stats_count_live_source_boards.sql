-- Report the coverage users can actually browse: one count per live 90D
-- ranking source board. The legacy RPC output column remains exchange_count
-- for API compatibility, but it no longer pretends a source-name prefix is an
-- exchange or brand.
--
-- leaderboard_count_cache is rebuilt atomically by
-- 20260716063000_rebuild_leaderboard_count_cache.sql, so every positive live
-- board has exactly one <source>_gt0 row and retired boards are absent.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE OR REPLACE FUNCTION public.get_hero_stats()
RETURNS TABLE(exchange_count bigint, trader_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '2s'
AS $$
DECLARE
  v_source_board_count bigint;
  v_trader_count bigint;
BEGIN
  SELECT total_count INTO v_trader_count
  FROM public.leaderboard_count_cache
  WHERE season_id = '90D' AND source = '_all_gt0'
  LIMIT 1;

  SELECT COUNT(*) INTO v_source_board_count
  FROM public.leaderboard_count_cache
  WHERE season_id = '90D'
    AND RIGHT(source, 4) = '_gt0'
    AND source <> '_all_gt0'
    AND total_count > 0;

  -- Cold-cache fallback uses the same visibility threshold as the cache
  -- builder and /api/rankings.
  IF v_trader_count IS NULL OR v_source_board_count = 0 THEN
    SELECT
      COUNT(DISTINCT source),
      COUNT(*)
    INTO v_source_board_count, v_trader_count
    FROM public.leaderboard_ranks
    WHERE season_id = '90D'
      AND arena_score > 0
      AND (is_outlier IS NULL OR is_outlier = false);
  END IF;

  RETURN QUERY SELECT v_source_board_count, v_trader_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_hero_stats() TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
