-- Migration: 20260409180432_leaderboard_ranks_mdd_positive_check_constraint.sql
-- Created: 2026-04-10T01:04:32Z
-- Description: Re-add a CHECK constraint on leaderboard_ranks.max_drawdown
--   matching the current data convention (positive percentage [0, 100]).
--
-- BACKGROUND:
--   The original 20260319aa migration defined max_drawdown as
--     numeric(5,2) CHECK (max_drawdown IS NULL OR (max_drawdown >= -100 AND max_drawdown <= 0))
--   That used a NEGATIVE convention (e.g. -25 = "lost 25% from peak").
--
--   At some point the writer logic flipped to a POSITIVE convention
--   (25 = "drawdown of 25%"). The check constraint was dropped during
--   that transition but never re-added. Today the column has 37,829
--   non-null rows, all in [0, 100], min = 0, max = 100. ZERO rows are
--   negative.
--
--   The agent-team data audit flagged this as "constraint violation"
--   because it expected the original negative convention. In reality
--   the data is internally consistent — the audit was reading old
--   migrations. The fix is to formalize the new convention with a
--   constraint so future writers can't drift.
--
--   lib/utils/arena-score.ts:calculateDrawdownScore already uses
--   Math.abs() so the score formula is sign-agnostic and correct
--   under either convention.
--
-- SAFETY:
--   - Validated against current data: 0 rows would violate.
--   - Uses NOT VALID + VALIDATE pattern to avoid blocking writers
--     while the constraint is being added (large table).

BEGIN;

-- Drop any pre-existing variant under common naming so this is idempotent.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    WHERE c.relname = 'leaderboard_ranks'
      AND con.conname IN (
        'leaderboard_ranks_max_drawdown_check',
        'leaderboard_ranks_max_drawdown_check_pos',
        'leaderboard_ranks_mdd_check'
      )
  ) THEN
    EXECUTE 'ALTER TABLE leaderboard_ranks DROP CONSTRAINT IF EXISTS leaderboard_ranks_max_drawdown_check';
    EXECUTE 'ALTER TABLE leaderboard_ranks DROP CONSTRAINT IF EXISTS leaderboard_ranks_max_drawdown_check_pos';
    EXECUTE 'ALTER TABLE leaderboard_ranks DROP CONSTRAINT IF EXISTS leaderboard_ranks_mdd_check';
  END IF;
END $$;

-- Add the new positive-convention constraint as NOT VALID first.
-- NOT VALID means PG accepts the constraint immediately without scanning
-- existing rows. New writes are checked starting from now.
ALTER TABLE leaderboard_ranks
  ADD CONSTRAINT leaderboard_ranks_max_drawdown_check_pos
  CHECK (max_drawdown IS NULL OR (max_drawdown >= 0 AND max_drawdown <= 100))
  NOT VALID;

-- Then VALIDATE the constraint, which scans existing rows in a single
-- pass without blocking concurrent reads. If any row violates, the
-- migration fails and rolls back.
ALTER TABLE leaderboard_ranks
  VALIDATE CONSTRAINT leaderboard_ranks_max_drawdown_check_pos;

COMMENT ON CONSTRAINT leaderboard_ranks_max_drawdown_check_pos ON leaderboard_ranks IS
  'Max drawdown is stored as a positive percentage [0, 100]. Convention changed from the original negative [-100, 0] in early 2026 — see migration 20260409180432. lib/utils/arena-score.ts uses Math.abs() so the score formula is sign-agnostic.';

COMMIT;

-- ============================================================================
-- VERIFY (run manually):
-- ============================================================================
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'leaderboard_ranks'::regclass AND conname LIKE '%drawdown%';
--
-- Expect:
--   leaderboard_ranks_max_drawdown_check_pos |
--     CHECK ((max_drawdown IS NULL) OR ((max_drawdown >= 0::numeric) AND (max_drawdown <= 100::numeric)))
