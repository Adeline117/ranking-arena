-- Migration: 20260409161329_hero_stats_cache_gt0_threshold.sql
-- Description: Track arena_score > 0 counts in leaderboard_count_cache for hero stats
--
-- Problem: refresh_leaderboard_count_cache() uses arena_score > 10 (quality threshold
-- for ranking display). The hero stats RPC needs arena_score > 0 (all active traders)
-- to match the previous semantics. The two definitions give different numbers:
--   - arena_score > 10: ~6,178 traders (what the cache stores)
--   - arena_score > 0:  ~12,829 traders (what hero previously showed)
--
-- Fix: extend refresh_leaderboard_count_cache() to also store '_all_gt0' and
-- '<source>_gt0' rows. Update get_hero_stats() to read from '_all_gt0'.
--
-- Both sets of rows live in the same table keyed by (season_id, source). The
-- '_gt0' suffix on source distinguishes the two thresholds. No schema change.

CREATE OR REPLACE FUNCTION refresh_leaderboard_count_cache()
RETURNS void
LANGUAGE plpgsql
SET statement_timeout = '10s'
AS $$
BEGIN
  -- Threshold 1: arena_score > 10 (quality, used by /api/traders totalCount)
  INSERT INTO leaderboard_count_cache (season_id, source, total_count, updated_at)
  SELECT season_id, '_all', COUNT(*), NOW()
  FROM leaderboard_ranks
  WHERE arena_score > 10 AND (is_outlier IS NULL OR is_outlier = false)
  GROUP BY season_id
  ON CONFLICT (season_id, source) DO UPDATE SET total_count = EXCLUDED.total_count, updated_at = NOW();

  INSERT INTO leaderboard_count_cache (season_id, source, total_count, updated_at)
  SELECT season_id, source, COUNT(*), NOW()
  FROM leaderboard_ranks
  WHERE arena_score > 10 AND (is_outlier IS NULL OR is_outlier = false)
  GROUP BY season_id, source
  ON CONFLICT (season_id, source) DO UPDATE SET total_count = EXCLUDED.total_count, updated_at = NOW();

  -- Threshold 2: arena_score > 0 (all active, used by hero stats)
  -- Stored under source prefix '_all_gt0' and '<source>_gt0'
  INSERT INTO leaderboard_count_cache (season_id, source, total_count, updated_at)
  SELECT season_id, '_all_gt0', COUNT(*), NOW()
  FROM leaderboard_ranks
  WHERE arena_score > 0 AND (is_outlier IS NULL OR is_outlier = false)
  GROUP BY season_id
  ON CONFLICT (season_id, source) DO UPDATE SET total_count = EXCLUDED.total_count, updated_at = NOW();

  INSERT INTO leaderboard_count_cache (season_id, source, total_count, updated_at)
  SELECT season_id, source || '_gt0', COUNT(*), NOW()
  FROM leaderboard_ranks
  WHERE arena_score > 0 AND (is_outlier IS NULL OR is_outlier = false)
  GROUP BY season_id, source
  ON CONFLICT (season_id, source) DO UPDATE SET total_count = EXCLUDED.total_count, updated_at = NOW();
END;
$$;

-- Prime the new _gt0 cache entries immediately so get_hero_stats doesn't hit the
-- fallback path on the next deploy.
SELECT refresh_leaderboard_count_cache();

-- Update get_hero_stats to read the _gt0 entries
CREATE OR REPLACE FUNCTION public.get_hero_stats()
RETURNS TABLE(exchange_count bigint, trader_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '2s'
AS $$
DECLARE
  v_exchange_count bigint;
  v_trader_count bigint;
BEGIN
  -- Fast path: read from leaderboard_count_cache using the _gt0 threshold entries
  SELECT total_count INTO v_trader_count
  FROM leaderboard_count_cache
  WHERE season_id = '90D' AND source = '_all_gt0'
  LIMIT 1;

  SELECT COUNT(*) INTO v_exchange_count
  FROM leaderboard_count_cache
  WHERE season_id = '90D'
    AND source LIKE '%_gt0'
    AND source <> '_all_gt0'
    AND total_count > 0;

  -- Fallback: if cache is empty (cold deploy), direct COUNT query
  IF v_trader_count IS NULL OR v_exchange_count = 0 THEN
    SELECT
      COUNT(DISTINCT source) AS exchange_count,
      COUNT(*) AS trader_count
    INTO v_exchange_count, v_trader_count
    FROM leaderboard_ranks
    WHERE season_id = '90D'
      AND arena_score > 0
      AND (is_outlier IS NULL OR is_outlier = false);
  END IF;

  RETURN QUERY SELECT v_exchange_count, v_trader_count;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_hero_stats() TO anon, authenticated, service_role;
