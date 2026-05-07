-- Migration: 20260506180127_drop_unused_rpc_functions.sql
-- Created: 2026-05-07T01:01:27Z
-- Description: Drop 6 unused RPC functions identified by cross-referencing
-- live DB functions with codebase grep (excluding database.types.ts auto-gen).
--
-- Verification method: for each function, grepped lib/ app/ scripts/ for
-- .rpc('function_name') calls. Only functions with ZERO actual call sites
-- (excluding database.types.ts) are dropped.

-- 1. compute_leaderboard_snapshot — replaced by TypeScript cron (app/api/cron/compute-leaderboard)
DROP FUNCTION IF EXISTS compute_leaderboard_snapshot();

-- 2. migrate_position_history_batch — one-time migration helper (2026-03)
DROP FUNCTION IF EXISTS migrate_position_history_batch(integer);

-- 3. recalculate_all_user_weights — one-time recalculation (user weights now managed by triggers)
DROP FUNCTION IF EXISTS recalculate_all_user_weights();

-- 4. expire_trader_flags — never called from code, trader flags managed manually
DROP FUNCTION IF EXISTS expire_trader_flags();

-- 5. fix_snapshot_violations — one-time data fix (violations now prevented by sanitize triggers)
DROP FUNCTION IF EXISTS fix_snapshot_violations();

-- 6. get_latest_timestamps_by_source — replaced by pipeline-health-check.mjs direct queries
DROP FUNCTION IF EXISTS get_latest_timestamps_by_source();
