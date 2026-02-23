-- P0-3: Enforce MDD/ROI sanity bounds and provide stock cleanup utility.

-- 1) Cleanup function for existing outliers.
CREATE OR REPLACE FUNCTION public.clean_trader_snapshot_outliers()
RETURNS TABLE(updated_rows bigint) AS $$
DECLARE
  v_updated bigint := 0;
BEGIN
  -- Clamp ROI to [-5000, 5000]
  UPDATE public.trader_snapshots
  SET roi = CASE
    WHEN roi > 5000 THEN 5000
    WHEN roi < -5000 THEN -5000
    ELSE roi
  END
  WHERE roi IS NOT NULL
    AND (roi > 5000 OR roi < -5000);

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  -- Clamp max_drawdown to [0, 100]
  UPDATE public.trader_snapshots
  SET max_drawdown = CASE
    WHEN max_drawdown > 100 THEN 100
    WHEN max_drawdown < 0 THEN 0
    ELSE max_drawdown
  END
  WHERE max_drawdown IS NOT NULL
    AND (max_drawdown > 100 OR max_drawdown < 0);

  GET DIAGNOSTICS updated_rows = v_updated + ROW_COUNT;
  RETURN NEXT;
END;
$$ LANGUAGE plpgsql;

-- 2) Add guard rails to stop future bad writes.
ALTER TABLE public.trader_snapshots
  ADD CONSTRAINT ck_trader_snapshots_roi_sane
  CHECK (roi IS NULL OR (roi >= -5000 AND roi <= 5000))
  NOT VALID;

ALTER TABLE public.trader_snapshots
  ADD CONSTRAINT ck_trader_snapshots_mdd_sane
  CHECK (max_drawdown IS NULL OR (max_drawdown >= 0 AND max_drawdown <= 100))
  NOT VALID;

-- Optional validate after cleanup in production migration runbook.
-- ALTER TABLE public.trader_snapshots VALIDATE CONSTRAINT ck_trader_snapshots_roi_sane;
-- ALTER TABLE public.trader_snapshots VALIDATE CONSTRAINT ck_trader_snapshots_mdd_sane;
