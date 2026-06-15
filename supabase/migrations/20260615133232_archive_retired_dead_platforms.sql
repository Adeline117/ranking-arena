-- Migration: 20260615133232_archive_retired_dead_platforms.sql
-- Created: 2026-06-15T20:32:32Z
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Up
-- Archive the 12 spec-dropped "dead" legacy-only platforms before retiring them.
-- These have NO arena.* source (verified), are absent from leaderboard_ranks /
-- search, and froze on 2026-06-12 when their legacy connectors were removed.
-- User decision: delete the ones not in the spec doc; archive first (cold copy),
-- then 404 their detail pages, then remove their rows from the hot tables.
-- The 13th frozen platform, bingx_spot, is an arena 'shadow' source (in the doc)
-- and is intentionally NOT included here.

CREATE SCHEMA IF NOT EXISTS arena_archive;

-- Cold copies (CREATE TABLE AS = data snapshot; no indexes/constraints needed).
CREATE TABLE IF NOT EXISTS arena_archive.trader_latest_dead_20260615 AS
  SELECT * FROM public.trader_latest
  WHERE platform IN ('aevo','bybit_spot','copin','dydx','etoro','gains',
                     'jupiter_perps','okx_web3','polymarket','toobit','weex','woox');

CREATE TABLE IF NOT EXISTS arena_archive.trader_snapshots_v2_dead_20260615 AS
  SELECT * FROM public.trader_snapshots_v2
  WHERE platform IN ('aevo','bybit_spot','copin','dydx','etoro','gains',
                     'jupiter_perps','okx_web3','polymarket','toobit','weex','woox');

COMMENT ON SCHEMA arena_archive IS
  'Cold storage for retired/spec-dropped sources. Not served. See migration 20260615133232.';
