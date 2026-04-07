-- Add confidence column to trader_daily_snapshots
-- Marks data quality: 'high' (post-validation), 'low' (pre-validation / known dirty periods)
--
-- All data before 2026-04-01 was written without validateSnapshot checks.
-- Known dirty periods:
--   - Hyperliquid 03-28~03-31: ROI = PnL mapping bug
--   - Bitget 02~03: decimal ratio bug (ROI ÷100)
--   - Bybit 02~04-01: PnL=0 (missing, not zero)

-- 1. Add column with default 'high' for new data
ALTER TABLE trader_daily_snapshots
  ADD COLUMN IF NOT EXISTS confidence TEXT NOT NULL DEFAULT 'high';

-- 2. Mark all pre-validation data as 'low'
UPDATE trader_daily_snapshots
SET confidence = 'low'
WHERE date < '2026-04-01';

-- 3. Mark known dirty platform/period combinations as 'low'
-- (catches any post-04-01 data that was computed from dirty inputs)
UPDATE trader_daily_snapshots
SET confidence = 'low'
WHERE platform = 'hyperliquid' AND date BETWEEN '2026-03-28' AND '2026-03-31'
  AND confidence != 'low';

UPDATE trader_daily_snapshots
SET confidence = 'low'
WHERE platform = 'bitget_futures' AND date < '2026-04-01'
  AND confidence != 'low';

UPDATE trader_daily_snapshots
SET confidence = 'low'
WHERE platform = 'bybit_futures' AND date < '2026-04-01'
  AND confidence != 'low';

-- 4. Index for filtering by confidence
CREATE INDEX IF NOT EXISTS idx_daily_snapshots_confidence
  ON trader_daily_snapshots (confidence)
  WHERE confidence = 'low';
