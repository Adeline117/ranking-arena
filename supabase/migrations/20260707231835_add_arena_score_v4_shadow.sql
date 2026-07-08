-- Migration: 20260707231835_add_arena_score_v4_shadow.sql
-- Created: 2026-07-08T06:18:35Z
-- Description: Shadow column for Arena Score v4 (parallel compute, not yet served)

-- Arena Score v4 (2026-07-07): the redesigned single score (profitability-first,
-- ROI+PnL ≥60% per owner, + risk-adjustment + confidence layer). compute-leaderboard
-- will compute v4 alongside the live v3 arena_score and write it HERE — shadow only,
-- never served — so we can compare the two leaderboards on real data for a few days
-- before switching the flagship. Nullable so existing rows and the v3 path are
-- unaffected; the serving layer ignores this column entirely until cutover.

-- Up
ALTER TABLE public.leaderboard_ranks
  ADD COLUMN IF NOT EXISTS arena_score_v4 numeric;

COMMENT ON COLUMN public.leaderboard_ranks.arena_score_v4 IS
  'Shadow: Arena Score v4 (computeArenaScoreV4). Parallel-computed, NOT served until cutover. See lib/utils/arena-score.ts.';
