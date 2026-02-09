-- Arena Score V3: Add score_confidence to trader_sources
-- Tracks data completeness level for scoring: full, partial, minimal, insufficient

ALTER TABLE trader_sources
  ADD COLUMN IF NOT EXISTS score_confidence TEXT
    CHECK (score_confidence IN ('full', 'partial', 'minimal', 'insufficient'));

COMMENT ON COLUMN trader_sources.score_confidence IS
  'Data completeness for Arena Score V3: full/partial/minimal/insufficient';

-- Also ensure trader_snapshots has the v3 breakdown columns we need
-- (some may already exist from 00040, this is idempotent)
ALTER TABLE trader_snapshots
  ADD COLUMN IF NOT EXISTS profitability_score DECIMAL(6, 2),
  ADD COLUMN IF NOT EXISTS risk_control_score DECIMAL(6, 2),
  ADD COLUMN IF NOT EXISTS execution_score DECIMAL(6, 2),
  ADD COLUMN IF NOT EXISTS score_completeness TEXT
    CHECK (score_completeness IN ('full', 'partial', 'minimal', 'insufficient')),
  ADD COLUMN IF NOT EXISTS score_penalty DECIMAL(4, 2) DEFAULT 0;

COMMENT ON COLUMN trader_snapshots.profitability_score IS 'V3 profitability dimension (0-35)';
COMMENT ON COLUMN trader_snapshots.risk_control_score IS 'V3 risk control dimension (0-40)';
COMMENT ON COLUMN trader_snapshots.execution_score IS 'V3 execution quality dimension (0-25)';
COMMENT ON COLUMN trader_snapshots.score_completeness IS 'Data completeness level used for V3 scoring';
COMMENT ON COLUMN trader_snapshots.score_penalty IS 'Points deducted due to incomplete data';
