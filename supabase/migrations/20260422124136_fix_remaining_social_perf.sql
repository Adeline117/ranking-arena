-- Migration: 20260422124136_fix_remaining_social_perf.sql
-- Fix remaining social performance issues:
-- 1. Composite index on user_follows(follower_id, following_id) for mutual-follow check
-- 2. Wilson score SQL function for DB-level comment sorting
-- 3. Recount follow counts RPC for periodic cron

-- 1. Composite index for dual-condition follow queries
CREATE INDEX IF NOT EXISTS idx_user_follows_follower_following
  ON user_follows (follower_id, following_id);

-- 2. Wilson score lower bound for comment ranking (immutable → indexable)
CREATE OR REPLACE FUNCTION wilson_score_lower(ups INT, downs INT)
RETURNS FLOAT8
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  n INT;
  z FLOAT8 := 1.96;
  phat FLOAT8;
BEGIN
  n := COALESCE(ups, 0) + COALESCE(downs, 0);
  IF n = 0 THEN RETURN 0; END IF;
  phat := COALESCE(ups, 0)::FLOAT8 / n;
  RETURN (phat + (z * z) / (2 * n) - z * sqrt((phat * (1 - phat) + (z * z) / (4 * n)) / n)) / (1 + (z * z) / n);
END;
$$;

-- 3. Bulk recount follow counts for all users with follows
CREATE OR REPLACE FUNCTION recount_all_follow_counts()
RETURNS TABLE (updated_count BIGINT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  WITH follower_counts AS (
    SELECT following_id AS user_id, COUNT(*) AS cnt
    FROM user_follows
    GROUP BY following_id
  ),
  following_counts AS (
    SELECT follower_id AS user_id, COUNT(*) AS cnt
    FROM user_follows
    GROUP BY follower_id
  ),
  updates AS (
    UPDATE user_profiles up
    SET
      follower_count = COALESCE(fc.cnt, 0),
      following_count = COALESCE(fg.cnt, 0)
    FROM (SELECT id FROM user_profiles) ids
    LEFT JOIN follower_counts fc ON fc.user_id = ids.id
    LEFT JOIN following_counts fg ON fg.user_id = ids.id
    WHERE up.id = ids.id
      AND (up.follower_count IS DISTINCT FROM COALESCE(fc.cnt, 0)
        OR up.following_count IS DISTINCT FROM COALESCE(fg.cnt, 0))
    RETURNING up.id
  )
  SELECT COUNT(*) AS updated_count FROM updates;
$$;

COMMENT ON FUNCTION wilson_score_lower IS 'Wilson score lower bound for ranking by quality with small sample correction';
COMMENT ON FUNCTION recount_all_follow_counts IS 'Bulk recount follower/following counts — call from cron to fix drift';
