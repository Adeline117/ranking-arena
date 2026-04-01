-- DB Audit Cleanup (2026-04-01)
-- Executed directly via Supabase SQL editor, this file documents what was done.
--
-- Total freed: ~2 GB (16 GB → 14 GB)
--
-- P0-1: trader_position_history unused indexes (666 MB)
-- DROP INDEX CONCURRENTLY IF EXISTS idx_position_history_created_at;    -- 320 MB, 0 scans
-- DROP INDEX CONCURRENTLY IF EXISTS idx_trader_positions_source_trader;  -- 346 MB, redundant

-- P0-2: snapshots_v2 window case fix (625 lowercase rows deleted)
-- DELETE FROM trader_snapshots_v2 WHERE "window" != UPPER("window") AND EXISTS(uppercase dupe);
-- UPDATE trader_snapshots_v2 SET "window" = UPPER("window") WHERE "window" != UPPER("window");
ALTER TABLE trader_snapshots_v2 ADD CONSTRAINT IF NOT EXISTS chk_window_uppercase CHECK ("window" = UPPER("window"));

-- P0-4: snapshots_v2 dead indexes (118 MB)
-- DROP INDEX CONCURRENTLY IF EXISTS uq_trader_snapshots_v2;         -- 43 MB, 2 scans
-- DROP INDEX CONCURRENTLY IF EXISTS idx_snapshots_v2_trader;         -- 43 MB, 123 scans
-- DROP INDEX CONCURRENTLY IF EXISTS idx_snapshots_v2_roi_ranking;    -- 32 MB, 281 scans
-- DROP INDEX CONCURRENTLY IF EXISTS idx_snapshots_v2_freshness;      -- 27 MB, 820 scans (as_of_ts no longer queried)

-- P1-1: Airdrop redundant indexes (500 MB)
-- DROP INDEX CONCURRENTLY IF EXISTS idx_sybil_address;     -- 214 MB, redundant
-- DROP INDEX CONCURRENTLY IF EXISTS idx_eligible_address;   -- 214 MB, redundant
-- DROP INDEX CONCURRENTLY IF EXISTS idx_claimants_address;  -- 72 MB, redundant

-- P1-2: library_items VACUUM FULL (125 MB, 0 rows)
-- VACUUM FULL library_items;

-- P1-3: trader_portfolio cleanup
-- DROP CONSTRAINT trader_portfolio_source_source_trader_id_symbol_captured_at_key (154 MB, 313 scans)
-- DROP INDEX idx_trader_portfolio_source_trader (18 MB, covered)

-- P1-4: VACUUM bloated tables
-- VACUUM ANALYZE trader_equity_curve (15.2% dead tuples)

-- P1-5: pipeline_logs missing index
CREATE INDEX IF NOT EXISTS idx_pipeline_logs_job_started ON pipeline_logs (job_name, started_at DESC);

-- Scattered redundant indexes (~50 MB)
-- DROP INDEX idx_trader_snapshots_v2_season_arena;
-- DROP INDEX idx_trader_snapshots_rankings_v2;
-- DROP INDEX idx_trader_snapshots_captured_at;
-- DROP INDEX idx_trader_equity_curve_source_trader;
-- DROP INDEX idx_trader_stats_detail_source_trader;
-- DROP INDEX idx_trader_stats_detail_period;
-- DROP INDEX idx_trader_sources_source_trader_id;
-- DROP INDEX idx_trader_profiles_v2_lookup;
-- DROP INDEX idx_trader_asset_breakdown_source_trader;
-- DROP INDEX idx_trader_asset_breakdown_period;
