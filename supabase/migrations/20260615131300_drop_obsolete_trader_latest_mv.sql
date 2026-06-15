-- Migration: 20260615131300_drop_obsolete_trader_latest_mv.sql
-- Created: 2026-06-15T20:13:00Z
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Up
-- Drop the obsolete public.trader_latest_mv.
--
-- It was prebuilt as a candidate to SWAP for public.trader_latest (a
-- materialized projection over arena.score_inputs). The arena cutover made
-- that swap both LOSSY and STALE-prone, so it was never executed:
--   - lossy: the matview covers only serving sources (~331k rows); trader_latest
--     also carries ~21k rows for 13 legacy-only platforms (aevo, copin, dydx,
--     etoro, polymarket, weex, woox, …) that have no arena rows — swapping would
--     silently drop them and break those pages/leaderboard entries.
--   - stale: a periodic full REFRESH is staler + more expensive than the current
--     event-driven incremental compat writer (worker tier-a publish →
--     lib/ingest/serving/compat-trader-latest.ts), which is the correct bridge.
-- Nothing in code or the DB references it (verified). Removing the dead,
-- mismatched artifact so it can't be mistaken for live infrastructure.
DROP MATERIALIZED VIEW IF EXISTS public.trader_latest_mv;
