-- Migration: 20260615204949_drop_retired_trader_latest_and_v2.sql
-- Created: 2026-06-16T03:49:49Z
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Up
-- Physically drop the retired legacy snapshot tables (ARENA_DATA_SPEC endgame).
-- These were soft-dropped (renamed _retired_20260616) after every reader was
-- migrated to leaderboard_ranks / arena.* / trader_daily_snapshots / rank_history,
-- the compat writer removed, and all legacy cron v2 writes deleted. Verified:
-- qa:schema green with them gone from public, core/serving/API paths green, and
-- batch-5min cron ran success post-rename. Going-forward history lives in
-- arena.trader_series + trader_daily_snapshots. CASCADE drops v2's monthly partitions.
DROP TABLE IF EXISTS public.trader_latest_retired_20260616 CASCADE;
DROP TABLE IF EXISTS public.trader_snapshots_v2_retired_20260616 CASCADE;
