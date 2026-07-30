-- A recovery that atomically wins admission before the 30-day deadline must
-- be allowed to finish inside its bounded lease even when Auth verification
-- crosses the deadline. The previous restore helper rechecked wall-clock
-- expiry at finish time, contradicting the admission/hard-delete barrier and
-- allowing an already-admitted recovery to lose its retained data.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.account_recovery_tokens') IS NULL
    OR pg_catalog.to_regclass('public.account_recovery_admissions') IS NULL
    OR pg_catalog.to_regclass('public.posts') IS NULL
    OR pg_catalog.to_regclass('public.comments') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.restore_pending_account(uuid,text)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.finish_account_recovery_admission_atomic(uuid,uuid)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'admitted account recovery deadline prerequisites are missing';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.restore_pending_account(
  p_user_id uuid,
  p_recovery_token_hash text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR (
      p_recovery_token_hash IS NOT NULL
      AND p_recovery_token_hash !~ '^[0-9a-f]{64}$'
    )
  THEN
    RAISE EXCEPTION 'invalid admitted account recovery input'
      USING ERRCODE = '22023';
  END IF;

  -- Match claim/finish/abort/hard-delete lock order even when this helper is
  -- called directly by a future service path. Reacquiring the transaction
  -- advisory lock from finish is harmless and closes a profile/admission
  -- deadlock edge.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );

  -- finish_account_recovery_admission_atomic already holds this row, but the
  -- explicit lock makes the helper safe and exact if another service path is
  -- introduced. The one-claimed-user index guarantees at most one match.
  SELECT admission.*
  INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.user_id = p_user_id
    AND admission.state = 'claimed'
    AND admission.recovery_token_hash
      IS NOT DISTINCT FROM p_recovery_token_hash
  ORDER BY admission.claimed_at, admission.operation_id
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_profile.deleted_at IS NULL
    OR v_profile.deletion_scheduled_at IS NULL
  THEN
    RETURN NULL;
  END IF;

  v_now := pg_catalog.clock_timestamp();
  IF v_admission.claimed_at >= v_profile.deletion_scheduled_at
    OR v_admission.lease_expires_at <= v_now
  THEN
    RETURN NULL;
  END IF;

  -- Token admission proved this exact unused credential before its expiry.
  -- Keep requiring that same row and proof timestamp; only the post-admission
  -- wall clock is allowed to cross the user-visible recovery deadline.
  IF p_recovery_token_hash IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.account_recovery_tokens AS token
    WHERE token.user_id = p_user_id
      AND token.token_hash = p_recovery_token_hash
      AND token.used_at IS NULL
      AND token.expires_at > v_admission.claimed_at
  ) THEN
    RETURN NULL;
  END IF;

  UPDATE public.posts AS post
  SET author_handle = v_profile.original_handle
  WHERE post.author_id = p_user_id;

  UPDATE public.comments AS comment
  SET author_handle = v_profile.original_handle
  WHERE comment.user_id = p_user_id;

  UPDATE public.user_profiles AS profile
  SET deleted_at = NULL,
      deletion_scheduled_at = NULL,
      deletion_reason = NULL,
      updated_at = v_now
  WHERE profile.id = p_user_id
    AND profile.deleted_at IS NOT NULL
    AND profile.deletion_scheduled_at = v_profile.deletion_scheduled_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'admitted account recovery lost profile ownership'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.account_recovery_tokens AS token
  SET used_at = v_now
  WHERE token.user_id = p_user_id
    AND token.used_at IS NULL;

  RETURN p_user_id;
END
$function$;

ALTER FUNCTION public.restore_pending_account(uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.restore_pending_account(uuid, text)
  FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.restore_pending_account(uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.restore_pending_account(uuid, text) IS
  'Restores only the exact live recovery admission that won before the grace deadline; its bounded lease may finish after that deadline.';

DO $postflight$
DECLARE
  v_function pg_catalog.regprocedure :=
    'public.restore_pending_account(uuid,text)'::pg_catalog.regprocedure;
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function
    AND function_row.proowner = pg_catalog.to_regrole('postgres')
    AND function_row.prorettype = 'uuid'::pg_catalog.regtype
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.strpos(v_source, 'account_recovery_admissions') = 0
    OR pg_catalog.strpos(v_source, 'v_admission.claimed_at >=') = 0
    OR pg_catalog.strpos(v_source, 'v_admission.lease_expires_at <=') = 0
    OR pg_catalog.strpos(v_source, 'token.expires_at > v_admission.claimed_at') = 0
  THEN
    RAISE EXCEPTION 'admitted account recovery deadline contract drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    v_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_function,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'admitted account recovery deadline ACL drifted';
  END IF;
END
$postflight$;

COMMIT;
