-- Migration: 20260519160421_db_cleanup_drop_dead_tables_indexes.sql
-- DB cleanup: drop dead tables and unused indexes
-- Applied manually via Supabase MCP on 2026-05-19
-- Total savings: ~6 GB (44 GB -> 38 GB)

-- 1. leaderboard_ranks_old (502 MB, zero FK, zero code references)
DROP TABLE IF EXISTS public.leaderboard_ranks_old CASCADE;

-- 2. idx_snapshots_v2_part_hourly — partitioned index, barely used
--    April: 1.5 GB (1 scan), May: 886 MB (575 scans)
--    Near-duplicate of the UNIQUE index (trunc_hour vs as_of_ts)
DROP INDEX IF EXISTS public.idx_snapshots_v2_part_hourly;

-- 3. library_items + book_ratings (61 MB, library feature removed from code)
DROP TABLE IF EXISTS public.book_ratings CASCADE;
DROP TABLE IF EXISTS public.library_items CASCADE;

-- 4. Legacy web3 analytics tables (235 MB total, zero/minimal code references)
DROP TABLE IF EXISTS public.interactions CASCADE;
DROP TABLE IF EXISTS public.wallets CASCADE;
DROP TABLE IF EXISTS public.projects CASCADE;

-- 5. idx_snap_v2_p2026_04_win_ts_arena_cov (2.1 GB, 274 scans, no parent index)
DROP INDEX CONCURRENTLY IF EXISTS public.idx_snap_v2_p2026_04_win_ts_arena_cov;

-- Remaining structural debt (not addressed in this migration):
-- - trader_position_history: 20 GB flat table, code still reads/writes it
--   Partitioned replacement (trader_position_history_partitioned) exists but
--   migration was never completed. Needs code migration to use partitioned table.
-- - traders (v1): 152 MB, still heavily referenced in code
-- - trader_snapshots (v1): 114 MB, still referenced in backfill scripts + OG image
