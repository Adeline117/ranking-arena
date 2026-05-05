-- Migration: 20260505131451_lifetime_spots_advisory_lock.sql
-- Atomic lifetime spots check with advisory lock.
-- Prevents TOCTOU race where two concurrent requests both see count=199
-- and both proceed past the 200-spot limit.

CREATE OR REPLACE FUNCTION check_lifetime_spots_available(max_spots int DEFAULT 200)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_count int;
BEGIN
  -- Serialize all concurrent callers on the same advisory lock key.
  PERFORM pg_advisory_xact_lock(hashtext('lifetime_checkout'));

  SELECT count(*)::int INTO current_count
  FROM user_profiles
  WHERE pro_plan = 'lifetime';

  RETURN current_count < max_spots;
END;
$$;

REVOKE EXECUTE ON FUNCTION check_lifetime_spots_available(int) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION check_lifetime_spots_available(int) FROM anon;
REVOKE EXECUTE ON FUNCTION check_lifetime_spots_available(int) FROM authenticated;
GRANT EXECUTE ON FUNCTION check_lifetime_spots_available(int) TO service_role;
