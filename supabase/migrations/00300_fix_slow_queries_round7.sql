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

-- Fix 3: fill_null_pnl_from_siblings 5707ms → <1ms
-- Replace CTE + cross-partition JOIN with correlated subquery + EXISTS guard
-- Correlated subquery enables partition pruning per-row
CREATE OR REPLACE FUNCTION fill_null_pnl_from_siblings()
RETURNS INTEGER
LANGUAGE plpgsql
SET statement_timeout = '30s'
AS $$
DECLARE
  updated_count INTEGER := 0;
BEGIN
  UPDATE trader_snapshots_v2 t
  SET pnl_usd = (
    SELECT sv2.pnl_usd
    FROM trader_snapshots_v2 sv2
    WHERE sv2.platform = t.platform
      AND sv2.trader_key = t.trader_key
      AND sv2."window" != t."window"
      AND sv2.pnl_usd IS NOT NULL
      AND sv2.updated_at > NOW() - INTERVAL '7 days'
    ORDER BY sv2.updated_at DESC
    LIMIT 1
  )
  WHERE t.pnl_usd IS NULL
    AND t.updated_at > NOW() - INTERVAL '72 hours'
    AND t.roi_pct IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM trader_snapshots_v2 sv2
      WHERE sv2.platform = t.platform
        AND sv2.trader_key = t.trader_key
        AND sv2."window" != t."window"
        AND sv2.pnl_usd IS NOT NULL
        AND sv2.updated_at > NOW() - INTERVAL '7 days'
    );
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;
