-- Phase 1: Drop 10 dead tables with zero code references.
-- Verified by exhaustive grep: no TypeScript file reads/writes these tables.
-- Combined space savings: ~230 MB (data + indexes).

-- Step 1: Drop FK from trader_sources → traders_legacy (NO ACTION rule blocks CASCADE)
ALTER TABLE trader_sources DROP CONSTRAINT IF EXISTS trader_sources_trader_id_fkey;

-- Step 2: Drop traders_legacy and all CASCADE dependents
-- (signals: 0 rows, strategies: 2 rows, trader_seasons: 2 rows, trader_merges: 0 rows)
DROP TABLE IF EXISTS trader_merges CASCADE;
DROP TABLE IF EXISTS signals CASCADE;
DROP TABLE IF EXISTS strategies CASCADE;
DROP TABLE IF EXISTS trader_seasons CASCADE;
DROP TABLE IF EXISTS traders_legacy CASCADE;

-- Step 3: Drop trader_snapshots v1 (fully replaced by trader_snapshots_v2)
DROP TABLE IF EXISTS trader_snapshots CASCADE;

-- Step 4: Drop orphaned feature tables (0 rows, 0 code references)
DROP TABLE IF EXISTS trader_scores CASCADE;
DROP TABLE IF EXISTS trader_flags CASCADE;
DROP TABLE IF EXISTS user_activity CASCADE;
DROP TABLE IF EXISTS user_streaks CASCADE;
DROP TABLE IF EXISTS exp_transactions CASCADE;
DROP TABLE IF EXISTS notification_history CASCADE;
DROP TABLE IF EXISTS platform_heartbeats CASCADE;

-- Step 5: Nullable the orphaned trader_id column on trader_sources
-- (was FK to traders_legacy, now points nowhere)
-- Column kept for backwards compat but no longer constrained.
