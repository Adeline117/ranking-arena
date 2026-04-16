-- Migration: Convert score_completeness from TEXT to NUMERIC(5,2)
-- Reason: Storing a numeric score (0-100) as TEXT causes type coercion overhead,
--         sorting errors, and wasted storage. The column stores pnlScore values.

-- Convert TEXT → NUMERIC, casting existing values
ALTER TABLE leaderboard_ranks
  ALTER COLUMN score_completeness
  TYPE NUMERIC(5,2)
  USING NULLIF(score_completeness, '')::NUMERIC(5,2);

-- Add check constraint to ensure valid range
ALTER TABLE leaderboard_ranks
  ADD CONSTRAINT chk_score_completeness_range
  CHECK (score_completeness IS NULL OR (score_completeness >= 0 AND score_completeness <= 100));
