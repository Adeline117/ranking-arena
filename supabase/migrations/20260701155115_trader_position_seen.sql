-- Migration: 20260701155115_trader_position_seen.sql
-- Created: 2026-07-01T22:51:15Z
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Seen-state for new-position broadcasts (broadcast-trader-events cron).
--
-- The cron pulls a followed trader's CURRENT positions via arena_records_page
-- (kind='positions') and needs to know which (symbol, side) it has already seen
-- to detect genuinely NEW positions. Insert-once semantics (PK + ON CONFLICT DO
-- NOTHING): only the first appearance of a position key produces an event. On a
-- trader's very first run the cron seeds all current positions silently (no
-- alert spam). Service-role only: RLS on, no policies (default deny).

-- Up
CREATE TABLE IF NOT EXISTS public.trader_position_seen (
  trader_id text NOT NULL,
  source text NOT NULL DEFAULT '',
  symbol text NOT NULL,
  side text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trader_id, source, symbol, side)
);

ALTER TABLE public.trader_position_seen ENABLE ROW LEVEL SECURITY;
