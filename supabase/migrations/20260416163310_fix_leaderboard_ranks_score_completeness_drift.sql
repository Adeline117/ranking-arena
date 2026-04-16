-- Migration: 20260416163310_fix_leaderboard_ranks_score_completeness_drift.sql
-- Created: 2026-04-16
-- Description: clean stray numeric values in leaderboard_ranks.score_completeness
--
-- Root cause: leaderboard_ranks.score_completeness is TEXT, documented as enum
-- ('full' | 'partial' | 'minimal'). Audit (2026-04-16) shows 3 rows with
-- numeric string values — drift from a prior schema where a numeric pnlScore
-- was written to this column:
--
--   | score_completeness | rows  |
--   |--------------------|-------|
--   | full               | 23306 |
--   | partial            | 10762 |
--   | minimal            | 3773  |
--   | 0                  | 2     |   <-- drift
--   | 1.14               | 1     |   <-- drift
--
-- The stray rows don't break reads (the application accepts any string), but
-- they will fail any downstream enum-cast and poison the convert-to-NUMERIC
-- migration sitting pending in the repo. Cleaning them now unblocks future
-- type tightening.
--
-- Fix: NULL out any score_completeness value not in the valid enum set.
-- Add a CHECK constraint to prevent re-introduction.

-- 1. Clean drifted rows
UPDATE public.leaderboard_ranks
SET score_completeness = NULL
WHERE score_completeness IS NOT NULL
  AND score_completeness NOT IN ('full', 'partial', 'minimal', 'insufficient');

-- 2. Guardrail: reject non-enum writes going forward
ALTER TABLE public.leaderboard_ranks
  ADD CONSTRAINT chk_leaderboard_ranks_score_completeness
  CHECK (score_completeness IS NULL
      OR score_completeness IN ('full', 'partial', 'minimal', 'insufficient'))
  NOT VALID;

ALTER TABLE public.leaderboard_ranks
  VALIDATE CONSTRAINT chk_leaderboard_ranks_score_completeness;

COMMENT ON CONSTRAINT chk_leaderboard_ranks_score_completeness ON public.leaderboard_ranks IS
'score_completeness must be one of the documented enum values or NULL. Mirrors the check on trader_snapshots.';
