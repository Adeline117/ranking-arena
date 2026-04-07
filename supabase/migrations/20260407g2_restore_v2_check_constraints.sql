-- Restore CHECK constraints on trader_snapshots_v2
-- Previously NOT VALID — now re-add as validated after P0 data cleanup.
-- Run AFTER p0-batch-fix.sh completes (all violations fixed).

-- These match VALIDATION_BOUNDS in lib/pipeline/types.ts exactly.

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_roi_pct
  CHECK (roi_pct IS NULL OR (roi_pct >= -10000 AND roi_pct <= 10000))
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_sharpe_ratio
  CHECK (sharpe_ratio IS NULL OR (sharpe_ratio >= -10 AND sharpe_ratio <= 10))
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_max_drawdown
  CHECK (max_drawdown IS NULL OR (max_drawdown >= 0 AND max_drawdown <= 100))
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_win_rate
  CHECK (win_rate IS NULL OR (win_rate >= 0 AND win_rate <= 100))
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_arena_score
  CHECK (arena_score IS NULL OR (arena_score >= 0 AND arena_score <= 100))
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_followers
  CHECK (followers IS NULL OR followers >= 0)
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_copiers
  CHECK (copiers IS NULL OR copiers >= 0)
  NOT VALID;

ALTER TABLE trader_snapshots_v2
  ADD CONSTRAINT chk_v2_trades_count
  CHECK (trades_count IS NULL OR trades_count >= 0)
  NOT VALID;
