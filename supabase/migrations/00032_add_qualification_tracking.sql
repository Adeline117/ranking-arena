-- 00032_add_qualification_tracking.sql
--
-- Add qualification tracking columns for ranking stability:
-- 1. last_qualified_at: Grace period - traders remain visible 24h after qualifying
-- 2. full_confidence_at: Confidence debounce - prevent score jumps when data intermittently missing
--
-- Also creates a trigger to auto-set these fields on INSERT, and backfills existing data.

-- ============================================
-- 1. Add columns
-- ============================================

ALTER TABLE trader_snapshots
ADD COLUMN IF NOT EXISTS last_qualified_at TIMESTAMPTZ DEFAULT NULL;

ALTER TABLE trader_snapshots
ADD COLUMN IF NOT EXISTS full_confidence_at TIMESTAMPTZ DEFAULT NULL;

-- ============================================
-- 2. Indexes
-- ============================================

-- Partial index for grace period queries (only non-null values)
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_qualification
ON trader_snapshots(source, source_trader_id, season_id, last_qualified_at DESC NULLS LAST)
WHERE last_qualified_at IS NOT NULL;

-- ============================================
-- 3. Trigger: auto-set qualification fields on INSERT
-- ============================================
-- This trigger runs on every INSERT into trader_snapshots.
-- It sets last_qualified_at and full_confidence_at based on the snapshot data,
-- so import scripts do NOT need to be modified individually.

CREATE OR REPLACE FUNCTION fn_set_qualification_fields()
RETURNS TRIGGER AS $$
DECLARE
  threshold NUMERIC;
  soft_floor NUMERIC;
BEGIN
  -- Determine PnL threshold based on season_id
  threshold := CASE NEW.season_id
    WHEN '7D' THEN 200
    WHEN '30D' THEN 500
    WHEN '90D' THEN 1000
    ELSE 1000
  END;
  soft_floor := threshold * 0.5;

  -- Set last_qualified_at when PnL exceeds the soft floor
  -- Only set if the caller didn't already provide a value
  IF NEW.last_qualified_at IS NULL
     AND NEW.pnl IS NOT NULL
     AND NEW.pnl > soft_floor THEN
    NEW.last_qualified_at := NEW.captured_at;
  END IF;

  -- Set full_confidence_at when both win_rate and max_drawdown have real data
  -- (max_drawdown = 0 is treated as missing data)
  IF NEW.full_confidence_at IS NULL
     AND NEW.win_rate IS NOT NULL
     AND NEW.max_drawdown IS NOT NULL
     AND NEW.max_drawdown != 0 THEN
    NEW.full_confidence_at := NEW.captured_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_set_qualification_fields
BEFORE INSERT ON trader_snapshots
FOR EACH ROW
EXECUTE FUNCTION fn_set_qualification_fields();

-- ============================================
-- 4. Backfill existing data
-- ============================================

-- Set last_qualified_at for existing qualifying snapshots (using soft floor)
UPDATE trader_snapshots
SET last_qualified_at = captured_at
WHERE last_qualified_at IS NULL
  AND pnl IS NOT NULL
  AND (
    (season_id = '7D' AND pnl > 100)
    OR (season_id = '30D' AND pnl > 250)
    OR (season_id = '90D' AND pnl > 500)
  );

-- Set full_confidence_at for snapshots with complete data
UPDATE trader_snapshots
SET full_confidence_at = captured_at
WHERE full_confidence_at IS NULL
  AND win_rate IS NOT NULL
  AND max_drawdown IS NOT NULL
  AND max_drawdown != 0;
