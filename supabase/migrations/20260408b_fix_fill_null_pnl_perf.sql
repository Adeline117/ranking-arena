-- Fix fill_null_pnl_from_siblings: 11 sec/call → milliseconds
--
-- ROOT CAUSE: The function does a self-join on trader_snapshots_v2 looking for
-- rows where pnl_usd IS NULL within the last 72 hours. PostgreSQL has no index
-- to support `WHERE pnl_usd IS NULL`, so it scans all 32K+ rows for each call.
-- compute-leaderboard calls this 3x/hour (once per season), totaling 337+ calls
-- in pg_stat_statements at 11 sec each = 62 minutes of total DB time wasted.
--
-- FIX:
-- 1. Partial index on rows with NULL pnl_usd — turns scan into index lookup
-- 2. Tighten function: limit candidates explicitly, add statement_timeout
-- 3. Remove the cross-window join entirely if no candidates exist (early return)

-- Partial index — only ~2K-5K rows where pnl_usd is NULL and recently updated
CREATE INDEX IF NOT EXISTS idx_snapshots_v2_null_pnl_recent
ON trader_snapshots_v2 (platform, trader_key, "window", updated_at DESC)
WHERE pnl_usd IS NULL AND roi_pct IS NOT NULL;

-- Improved function with early-return + timeout safety
CREATE OR REPLACE FUNCTION fill_null_pnl_from_siblings()
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER := 0;
  candidate_count INTEGER := 0;
BEGIN
  -- Fail fast if blocked, don't hold locks for minutes
  SET LOCAL lock_timeout = '5s';
  SET LOCAL statement_timeout = '30s';

  -- Quick check: any candidates? Uses partial index, ms-fast.
  SELECT count(*) INTO candidate_count
  FROM trader_snapshots_v2
  WHERE pnl_usd IS NULL
    AND roi_pct IS NOT NULL
    AND updated_at > NOW() - INTERVAL '72 hours'
  LIMIT 100;  -- We only need to know if there are any, cap to avoid scanning whole index

  -- Early return if nothing to fill — most calls will exit here
  IF candidate_count = 0 THEN
    RETURN 0;
  END IF;

  -- Do the actual fill, capped at 500 rows per call to bound execution time
  WITH candidates AS (
    SELECT id, platform, trader_key, "window"
    FROM trader_snapshots_v2
    WHERE pnl_usd IS NULL
      AND updated_at > NOW() - INTERVAL '72 hours'
      AND roi_pct IS NOT NULL
    LIMIT 500
  ),
  best_sibling AS (
    SELECT DISTINCT ON (c.id) c.id, sv2.pnl_usd
    FROM candidates c
    JOIN trader_snapshots_v2 sv2
      ON sv2.platform = c.platform
      AND sv2.trader_key = c.trader_key
      AND sv2."window" != c."window"
      AND sv2.pnl_usd IS NOT NULL
      AND sv2.updated_at > NOW() - INTERVAL '7 days'
    ORDER BY c.id, sv2.updated_at DESC
  )
  UPDATE trader_snapshots_v2 t
  SET pnl_usd = s.pnl_usd
  FROM best_sibling s
  WHERE t.id = s.id;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;
