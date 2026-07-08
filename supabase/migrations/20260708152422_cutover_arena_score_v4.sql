-- Migration: 20260708152422_cutover_arena_score_v4.sql
-- Created: 2026-07-08T22:24:22Z
-- Description: Cutover — arena_score becomes v4; add v3 rollback col + score_factors

-- Arena Score v4 cutover (2026-07-08): compute-leaderboard now writes the v4 score
-- INTO `arena_score` (the served + ranked column — the rerank RPC and serving read it
-- unchanged), so the whole leaderboard re-ranks by v4 automatically. We keep the old
-- v3 value in `arena_score_v3` for one-swap rollback, and persist the v4 factor
-- breakdown (roi/pnl/drawdown/sharpe/consistency 0-1 contributions) in `score_factors`
-- for the redesigned score UI. `arena_score_v4` (added earlier) stays = arena_score.

-- Up
ALTER TABLE public.leaderboard_ranks
  ADD COLUMN IF NOT EXISTS arena_score_v3 numeric,
  ADD COLUMN IF NOT EXISTS score_factors jsonb;

COMMENT ON COLUMN public.leaderboard_ranks.arena_score_v3 IS
  'Rollback: the pre-v4 (V3 ROI+PnL) arena_score. arena_score itself now holds v4.';
COMMENT ON COLUMN public.leaderboard_ranks.score_factors IS
  'v4 score breakdown {roi,pnl,drawdown,sharpe,consistency} 0-1 for the score UI.';
