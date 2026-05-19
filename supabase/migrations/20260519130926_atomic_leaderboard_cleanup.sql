-- Migration: 20260519130926_atomic_leaderboard_cleanup.sql
-- ROOT CAUSE FIX: Atomic per-platform cleanup for leaderboard_ranks.
--
-- Problem: incremental upsert never deletes rows for traders that drop off
-- the leaderboard. These "zombie rows" accumulate (914K dead rows observed),
-- inflate the table count, break the degradation check, and cause stale
-- traders to persist at #1 for days.
--
-- Fix: After each compute cycle, delete rows for FRESH platforms that are
-- NOT in the newly computed set. This runs inside a single SQL function
-- to minimize round trips and lock hold time.

-- Delete leaderboard_ranks rows for a given season + platform that are NOT
-- in the provided set of trader IDs. Returns the number of rows deleted.
CREATE OR REPLACE FUNCTION cleanup_stale_platform_rows(
  p_season_id text,
  p_source text,
  p_keep_trader_ids text[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM leaderboard_ranks
  WHERE season_id = p_season_id
    AND source = p_source
    AND source_trader_id != ALL(p_keep_trader_ids)
  ;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- Compute expected trader count per platform from leaderboard_count_cache.
-- Used by the degradation check to compare against platform-level expected
-- output instead of a drifting global baseline.
CREATE OR REPLACE FUNCTION get_expected_platform_counts(p_season_id text)
RETURNS TABLE(source text, expected_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT source, total_count::bigint
  FROM leaderboard_count_cache
  WHERE season_id = p_season_id
    AND source != '_all'
    AND total_count > 0;
$$;
