-- Advisory lock wrapper for compute-leaderboard to prevent concurrent writes.
-- Uses pg_try_advisory_lock (non-blocking) so the caller can skip if lock is held.
-- Lock is session-level and must be released with pg_advisory_unlock.

CREATE OR REPLACE FUNCTION acquire_leaderboard_lock(season text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_try_advisory_lock(hashtext('compute-leaderboard:' || season));
$$;

CREATE OR REPLACE FUNCTION release_leaderboard_lock(season text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT pg_advisory_unlock(hashtext('compute-leaderboard:' || season));
$$;
