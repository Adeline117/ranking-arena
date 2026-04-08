-- Fix cleanup_snapshot_violations: add partial index + reduce lock impact
--
-- ROOT CAUSE: cleanup_snapshot_violations() was running every 1 minute and
-- doing a sequential scan of trader_snapshots_v2_p2026_04 (1.18GB partition)
-- to find rows violating CHECK constraints. Each invocation took 90-200 seconds,
-- holding row locks that blocked all concurrent INSERT/UPDATE on the partition.
-- This cascaded into Supabase pooler exhaustion and 500 errors on the API.
--
-- FIX:
-- 1. Partial index on the violation condition — query becomes index scan instead
--    of full table scan. The partial index only covers ~103K violation rows,
--    not the entire 1.18GB partition.
-- 2. Add NOWAIT hint via SET LOCAL lock_timeout — fail fast instead of blocking.

-- Partial index — only contains rows that ARE violations.
-- Postgres uses this for both finding violations AND for the UPDATE.
-- Index size: ~103K rows × ~50 bytes = ~5MB (vs scanning 1.18GB).
CREATE INDEX IF NOT EXISTS idx_snapshots_v2_p2026_04_violations
ON trader_snapshots_v2_p2026_04 (id)
WHERE
  (sharpe_ratio IS NOT NULL AND (sharpe_ratio < -10 OR sharpe_ratio > 10))
  OR (roi_pct IS NOT NULL AND abs(roi_pct) > 10000)
  OR (max_drawdown IS NOT NULL AND (max_drawdown < 0 OR max_drawdown > 100))
  OR (win_rate IS NOT NULL AND (win_rate < 0 OR win_rate > 100));

-- Replace function with safer version:
-- - Uses lock_timeout to fail fast if blocked
-- - Smaller batch (25 instead of 50) to release locks more frequently
-- - Returns early if 0 violations found
CREATE OR REPLACE FUNCTION cleanup_snapshot_violations(batch_limit INTEGER DEFAULT 25)
RETURNS TABLE(issue TEXT, fixed BIGINT) AS $$
DECLARE
  v_ids uuid[];
  v_count BIGINT;
BEGIN
  -- Fail fast if we can't acquire locks within 2 seconds
  -- (prevents this cleanup from blocking the entire table for minutes)
  SET LOCAL lock_timeout = '2s';
  SET LOCAL statement_timeout = '10s';

  -- Find rows that violate ANY constraint — uses partial index
  SELECT array_agg(id) INTO v_ids FROM (
    SELECT id FROM trader_snapshots_v2_p2026_04
    WHERE (sharpe_ratio IS NOT NULL AND (sharpe_ratio < -10 OR sharpe_ratio > 10))
       OR (roi_pct IS NOT NULL AND abs(roi_pct) > 10000)
       OR (max_drawdown IS NOT NULL AND (max_drawdown < 0 OR max_drawdown > 100))
       OR (win_rate IS NOT NULL AND (win_rate < 0 OR win_rate > 100))
    LIMIT batch_limit
  ) sub;

  IF v_ids IS NULL OR array_length(v_ids, 1) IS NULL THEN
    issue := 'none'; fixed := 0; RETURN NEXT;
    RETURN;
  END IF;

  -- Fix all violating columns in a single UPDATE
  UPDATE trader_snapshots_v2_p2026_04
  SET
    sharpe_ratio = CASE WHEN sharpe_ratio IS NOT NULL AND (sharpe_ratio < -10 OR sharpe_ratio > 10) THEN NULL ELSE sharpe_ratio END,
    roi_pct = CASE WHEN roi_pct IS NOT NULL AND abs(roi_pct) > 10000 THEN NULL ELSE roi_pct END,
    max_drawdown = CASE WHEN max_drawdown IS NOT NULL AND (max_drawdown < 0 OR max_drawdown > 100) THEN NULL ELSE max_drawdown END,
    win_rate = CASE WHEN win_rate IS NOT NULL AND (win_rate < 0 OR win_rate > 100) THEN NULL ELSE win_rate END
  WHERE id = ANY(v_ids);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  issue := 'all'; fixed := v_count; RETURN NEXT;
END;
$$ LANGUAGE plpgsql;
