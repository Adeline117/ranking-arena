-- Migration: 20260706201258_drop_bot_ranking_tables.sql
-- Created: 2026-07-07T03:12:58Z
-- Description: Drop the trading-bot-ranking feature tables (owner decision).
--
-- The /rankings/bots + /bot/[id] leaderboard was a ONE-TIME seed imported on
-- 2026-02-11 with NO ingest pipeline (verified: zero cron / zero script ever
-- wrote these tables). Performance data was frozen/garbage (ROI -133% scoring
-- 100). The owner chose to remove the feature entirely; the app code, routes,
-- API, sitemap entries and nav were deleted in the same change, and old URLs now
-- 301 to /. These tables are orphaned — no remaining code, view, function or FK
-- (outside this trio) references them.
--
-- Dependency chain: bot_snapshots.bot_id -> bot_sources, bot_equity_curve.bot_id
-- -> bot_sources. Children dropped first, then the parent (CASCADE as a backstop).
--
-- DATA-DESTRUCTIVE + forward-only. Dropped rows (2273 sources / 6738 snapshots /
-- 0 equity-curve) are the dead seed — not recoverable (there was never an
-- upstream). If bots ever return, build a real ingest pipeline against NEW tables.

-- Up
DROP TABLE IF EXISTS public.bot_snapshots CASCADE;
DROP TABLE IF EXISTS public.bot_equity_curve CASCADE;
DROP TABLE IF EXISTS public.bot_sources CASCADE;
