-- Migration: 20260413171441_drop_unused_indexes_and_vacuum.sql
-- Created: 2026-04-13
-- Description: Drop unused indexes on trader_snapshots_v2_p2026_04 (0 scans, ~1 GB wasted)
-- and VACUUM high-bloat tables. Applied manually via pg pool on 2026-04-13.

-- 0 scans, 298 MB — redundant with the parent's partitioned index
DROP INDEX CONCURRENTLY IF EXISTS trader_snapshots_v2_p2026_04_window_arena_score_idx;

-- 1 scan, 682 MB — redundant with the UNIQUE index (3.7M scans)
DROP INDEX CONCURRENTLY IF EXISTS trader_snapshots_v2_p2026_04_platform_market_type_trader_k_idx2;

-- VACUUM high-bloat tables (applied manually)
-- trader_daily_snapshots: 12.4% dead rows
-- trader_portfolio: 10.7% dead rows
-- trader_sources: 18.4% dead rows
-- trader_profiles_v2: 18.3% dead rows
