-- Fix index/query mismatch: trader_snapshots uses season_id (not window)
-- This migration replaces wrong index definitions introduced in 00074.

-- Drop invalid index specs if they were ever created in divergent environments
DROP INDEX IF EXISTS idx_trader_snapshots_v2_ranking;
DROP INDEX IF EXISTS idx_trader_snapshots_v2_roi;
DROP INDEX IF EXISTS idx_trader_snapshots_v2_pnl;

-- Recreate for actual query predicates in /api/v2/rankings
CREATE INDEX IF NOT EXISTS idx_trader_snapshots_v2_season_arena
  ON trader_snapshots(source, season_id, arena_score DESC NULLS LAST)
  WHERE arena_score IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_v2_season_roi
  ON trader_snapshots(source, season_id, roi DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_v2_season_pnl
  ON trader_snapshots(source, season_id, pnl DESC NULLS LAST);
