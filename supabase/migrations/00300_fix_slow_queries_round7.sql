-- Round 7: DB query optimization
-- Fix 1: refresh_leaderboard_count_cache 1009ms → 226ms
-- Replace DELETE-all + 2x GROUP BY with UPSERT (no row churn)
-- Add partial covering index for COUNT GROUP BY pattern

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_count_cache
ON leaderboard_ranks (season_id, source)
WHERE arena_score > 10 AND (is_outlier IS NULL OR is_outlier = false);

CREATE OR REPLACE FUNCTION refresh_leaderboard_count_cache()
RETURNS void
LANGUAGE plpgsql
SET statement_timeout = '10s'
AS $$
BEGIN
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
END;
$$;
