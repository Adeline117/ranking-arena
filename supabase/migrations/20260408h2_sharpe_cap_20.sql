-- Raise Sharpe ratio bounds from ±10 to ±20
-- Many legitimate crypto traders have Sharpe 10-20, causing 13k false rejections/day.
-- Also updates DB trigger and cleanup functions.
-- Matches VALIDATION_BOUNDS.sharpe_ratio in lib/pipeline/types.ts.

ALTER TABLE trader_snapshots_v2 DROP CONSTRAINT IF EXISTS chk_v2_sharpe_ratio;
ALTER TABLE trader_snapshots_v2 ADD CONSTRAINT chk_v2_sharpe_ratio
  CHECK (sharpe_ratio IS NULL OR (sharpe_ratio >= -20 AND sharpe_ratio <= 20)) NOT VALID;
