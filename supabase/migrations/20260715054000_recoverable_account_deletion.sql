-- Make the advertised 30-day account recovery window real.
--
-- Deletion scheduling now changes only reversible presentation state. Related
-- follows, alerts, bookmarks, 2FA and preferences remain intact until the
-- existing hard-delete cron removes the auth user after the grace period.

CREATE TABLE public.account_recovery_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX account_recovery_tokens_active_idx
  ON public.account_recovery_tokens (expires_at)
  WHERE used_at IS NULL;

ALTER TABLE public.account_recovery_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service manages account recovery tokens"
  ON public.account_recovery_tokens
  FOR ALL TO service_role
  USING (true)
  WITH CHECK (true);
REVOKE ALL ON public.account_recovery_tokens FROM anon, authenticated;
GRANT ALL ON public.account_recovery_tokens TO service_role;

CREATE OR REPLACE FUNCTION public.schedule_account_deletion(
  p_user_id uuid,
  p_reason text,
  p_scheduled_at timestamptz,
  p_recovery_token_hash text
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  profile public.user_profiles%ROWTYPE;
  deleted_at_value timestamptz := now();
BEGIN
  SELECT * INTO profile
  FROM public.user_profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'user profile % not found', p_user_id;
  END IF;

  IF profile.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'account deletion is already pending';
  END IF;

  IF p_scheduled_at <= deleted_at_value THEN
    RAISE EXCEPTION 'deletion schedule must be in the future';
  END IF;

  UPDATE public.user_profiles
  SET deleted_at = deleted_at_value,
      deletion_scheduled_at = p_scheduled_at,
      deletion_reason = NULLIF(btrim(p_reason), ''),
      original_handle = COALESCE(original_handle, handle),
      original_email = COALESCE(original_email, email),
      updated_at = now()
  WHERE id = p_user_id;

  -- Public content remains for conversation integrity but is reversibly shown
  -- as Deleted User throughout the grace period.
  UPDATE public.posts SET author_handle = NULL WHERE author_id = p_user_id;
  UPDATE public.comments SET author_handle = NULL WHERE user_id = p_user_id;

  UPDATE public.account_recovery_tokens
  SET used_at = now()
  WHERE user_id = p_user_id AND used_at IS NULL;

  INSERT INTO public.account_recovery_tokens (user_id, token_hash, expires_at)
  VALUES (p_user_id, p_recovery_token_hash, p_scheduled_at);

  RETURN deleted_at_value;
END;
$$;

CREATE OR REPLACE FUNCTION public.restore_pending_account(
  p_user_id uuid,
  p_recovery_token_hash text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  profile public.user_profiles%ROWTYPE;
BEGIN
  SELECT * INTO profile
  FROM public.user_profiles
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND
     OR profile.deleted_at IS NULL
     OR profile.deletion_scheduled_at IS NULL
     OR profile.deletion_scheduled_at <= now() THEN
    RETURN NULL;
  END IF;

  IF p_recovery_token_hash IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.account_recovery_tokens
    WHERE user_id = p_user_id
      AND token_hash = p_recovery_token_hash
      AND used_at IS NULL
      AND expires_at > now()
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE public.posts
  SET author_handle = profile.original_handle
  WHERE author_id = p_user_id;

  UPDATE public.comments
  SET author_handle = profile.original_handle
  WHERE user_id = p_user_id;

  UPDATE public.user_profiles
  SET deleted_at = NULL,
      deletion_scheduled_at = NULL,
      deletion_reason = NULL,
      updated_at = now()
  WHERE id = p_user_id;

  UPDATE public.account_recovery_tokens
  SET used_at = now()
  WHERE user_id = p_user_id AND used_at IS NULL;

  RETURN p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_account_deletion(uuid, text, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.restore_pending_account(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_account_deletion(uuid, text, timestamptz, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.restore_pending_account(uuid, text)
  TO service_role;

COMMENT ON TABLE public.account_recovery_tokens IS
  'One-time hashed recovery credentials for accounts inside the 30-day deletion grace period.';
COMMENT ON FUNCTION public.schedule_account_deletion(uuid, text, timestamptz, text) IS
  'Atomically schedules reversible deletion and anonymizes public author labels without deleting account data.';
COMMENT ON FUNCTION public.restore_pending_account(uuid, text) IS
  'Atomically restores a pending account and its public author labels; optional token validation is service-controlled.';
