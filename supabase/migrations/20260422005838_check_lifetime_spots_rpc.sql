-- Migration: 20260422005838_check_lifetime_spots_rpc.sql
-- Created: 2026-04-22T07:58:38Z
-- Description: Atomic lifetime spot availability check with advisory lock.
-- Prevents TOCTOU race where two concurrent checkout requests both see
-- count < 200 and both proceed, overselling the 200 founding member spots.

CREATE OR REPLACE FUNCTION check_lifetime_spots(max_spots INT, lock_key BIGINT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_count INT;
BEGIN
  -- Serialize concurrent callers within the same transaction
  PERFORM pg_advisory_xact_lock(lock_key);

  SELECT count(*)::int INTO current_count
  FROM user_profiles
  WHERE pro_plan = 'lifetime';

  RETURN jsonb_build_object(
    'available', current_count < max_spots,
    'current_count', current_count,
    'max_spots', max_spots
  );
END;
$$;

-- Only callable by service role (server-side checkout handler)
REVOKE ALL ON FUNCTION check_lifetime_spots(INT, BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION check_lifetime_spots(INT, BIGINT) FROM authenticated;
GRANT EXECUTE ON FUNCTION check_lifetime_spots(INT, BIGINT) TO service_role;
