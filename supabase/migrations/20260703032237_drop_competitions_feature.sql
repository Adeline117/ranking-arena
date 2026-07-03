-- Migration: 20260703032237_drop_competitions_feature.sql
-- Created: 2026-07-03T10:22:37Z
-- Description: Drop the competitions feature entirely.
--
-- Rationale: the competitions feature (交易比赛：报名比 ROI/PnL 涨幅) was an
-- unfinished AI-generated shell — the update-competitions cron was never
-- scheduled (so standings would never refresh), there was no nav entry, and
-- both tables were empty (0 rows, verified 2026-07-03). The product direction
-- is a future "对战" (battle) idle-game, which will get its own schema.
--
-- All application code (app/(app)/competitions, app/api/competitions,
-- app/api/cron/update-competitions, i18n, feature flag, sitemap entries) is
-- removed in the same change. Forward-only: earlier competition migrations
-- (20260319h_competitions.sql etc.) stay in history; this supersedes them.

-- Up
-- competition_entries has a FK onto competitions; drop children first. CASCADE
-- also covers indexes, RLS policies, and the FK. Tables are empty (verified) so
-- no data is lost.
DROP TABLE IF EXISTS public.competition_entries CASCADE;
DROP TABLE IF EXISTS public.competitions CASCADE;
