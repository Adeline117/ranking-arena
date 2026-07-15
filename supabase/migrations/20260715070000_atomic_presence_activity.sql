-- Keep the compatibility presence fields and durable activity-day fact in one
-- database transaction. A partial write would make WAU and profile presence
-- disagree again, so the API calls only this function.

CREATE OR REPLACE FUNCTION public.record_user_activity(
  p_user_id uuid,
  p_seen_at timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.user_profiles
  SET last_seen_at = GREATEST(COALESCE(last_seen_at, p_seen_at), p_seen_at),
      is_online = true
  WHERE id = p_user_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active user profile not found';
  END IF;

  INSERT INTO public.user_activity_days (
    user_id,
    activity_date,
    first_seen_at,
    last_seen_at,
    heartbeat_count
  ) VALUES (
    p_user_id,
    (p_seen_at AT TIME ZONE 'UTC')::date,
    p_seen_at,
    p_seen_at,
    1
  )
  ON CONFLICT (user_id, activity_date) DO UPDATE
  SET first_seen_at = LEAST(public.user_activity_days.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = GREATEST(public.user_activity_days.last_seen_at, EXCLUDED.last_seen_at),
      heartbeat_count = public.user_activity_days.heartbeat_count + 1;
END;
$$;

REVOKE ALL ON FUNCTION public.record_user_activity(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_user_activity(uuid, timestamptz) TO service_role;

COMMENT ON FUNCTION public.record_user_activity(uuid, timestamptz) IS
  'Atomically records profile presence and the durable UTC activity-day fact.';
