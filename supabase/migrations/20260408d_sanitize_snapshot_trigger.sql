-- DB-level validation trigger: last line of defense for trader_snapshots_v2
--
-- WHY: validateBeforeWrite() in application code is optional — new code paths
-- can bypass it. This trigger ensures bad values are ALWAYS sanitized to NULL
-- at the database level, regardless of which code path writes the data.
--
-- BEHAVIOR: Sanitizes (sets to NULL) instead of rejecting (RAISE EXCEPTION)
-- because rejecting would break the pipeline. Sanitizing preserves the row
-- for later enrichment/re-computation.
--
-- INHERITED: Applied to parent table, automatically inherited by ALL partitions
-- including future ones (verified: all 9 partitions have the trigger).

CREATE OR REPLACE FUNCTION sanitize_snapshot_on_write()
RETURNS TRIGGER AS $$
BEGIN
  -- ROI bounds: [-10000, 10000]
  IF NEW.roi_pct IS NOT NULL AND (NEW.roi_pct < -10000 OR NEW.roi_pct > 10000) THEN
    NEW.roi_pct := NULL;
  END IF;

  -- ROI ≈ PnL mapping error detection
  IF NEW.roi_pct IS NOT NULL AND NEW.pnl_usd IS NOT NULL
     AND abs(NEW.roi_pct) > 10 AND abs(NEW.roi_pct - NEW.pnl_usd) < 0.01 THEN
    NEW.roi_pct := NULL;
  END IF;

  -- Sharpe bounds: [-10, 10]
  IF NEW.sharpe_ratio IS NOT NULL AND (NEW.sharpe_ratio < -10 OR NEW.sharpe_ratio > 10) THEN
    NEW.sharpe_ratio := NULL;
  END IF;

  -- MDD bounds: [0, 100]
  IF NEW.max_drawdown IS NOT NULL AND (NEW.max_drawdown < 0 OR NEW.max_drawdown > 100) THEN
    NEW.max_drawdown := NULL;
  END IF;

  -- Win rate bounds: [0, 100]
  IF NEW.win_rate IS NOT NULL AND (NEW.win_rate < 0 OR NEW.win_rate > 100) THEN
    NEW.win_rate := NULL;
  END IF;

  -- Arena score bounds: [0, 100]
  IF NEW.arena_score IS NOT NULL AND (NEW.arena_score < 0 OR NEW.arena_score > 100) THEN
    NEW.arena_score := NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sanitize_snapshot ON trader_snapshots_v2;
CREATE TRIGGER trg_sanitize_snapshot
  BEFORE INSERT OR UPDATE ON trader_snapshots_v2
  FOR EACH ROW
  EXECUTE FUNCTION sanitize_snapshot_on_write();
