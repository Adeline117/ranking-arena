-- A recovery admitted before the grace-period deadline can remain in flight
-- across Auth and Stripe after that deadline. Hard deletion must serialize
-- with that admission before its first external mutation; checking only the
-- profile timestamp would cancel billing and delete an account whose recovery
-- already won the database race.

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.admit_expired_account_hard_delete_atomic(uuid)'
  ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.claim_account_recovery_admission_atomic_locked_impl(uuid,text,uuid)'
    ) IS NOT NULL
  THEN
    RAISE EXCEPTION 'account hard-delete recovery barrier already exists';
  END IF;

  IF pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.account_recovery_admissions') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.claim_account_recovery_admission_atomic(uuid,text,uuid)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'account hard-delete recovery barrier prerequisites are missing';
  END IF;
END
$preflight$;

-- The original claim function sampled its deadline clock before waiting for
-- the advisory lock. Keep its reviewed state machine intact behind a wrapper
-- that acquires the user lock first; its v_now is then necessarily sampled
-- after every earlier hard-delete admission has committed.
ALTER FUNCTION public.claim_account_recovery_admission_atomic(uuid, text, uuid)
  RENAME TO claim_account_recovery_admission_atomic_locked_impl;

REVOKE ALL ON FUNCTION
  public.claim_account_recovery_admission_atomic_locked_impl(uuid, text, uuid)
FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE FUNCTION public.claim_account_recovery_admission_atomic(
  p_user_id uuid,
  p_recovery_token_hash text,
  p_operation_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );

  RETURN public.claim_account_recovery_admission_atomic_locked_impl(
    p_user_id,
    p_recovery_token_hash,
    p_operation_id
  );
END
$function$;

ALTER FUNCTION public.claim_account_recovery_admission_atomic(uuid, text, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.claim_account_recovery_admission_atomic(uuid, text, uuid)
FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION
  public.claim_account_recovery_admission_atomic(uuid, text, uuid)
TO service_role;

COMMENT ON FUNCTION public.claim_account_recovery_admission_atomic(
  uuid,
  text,
  uuid
) IS
  'Claims recovery only after serializing with expired-account hard-delete admission.';
COMMENT ON FUNCTION public.claim_account_recovery_admission_atomic_locked_impl(
  uuid,
  text,
  uuid
) IS
  'Internal recovery state machine; callable only through the advisory-first claim wrapper.';

CREATE OR REPLACE FUNCTION public.admit_expired_account_hard_delete_atomic(
  p_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_deleted_at timestamptz;
  v_deletion_scheduled_at timestamptz;
  v_now timestamptz;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'invalid account hard-delete admission input'
      USING ERRCODE = '22023';
  END IF;

  -- This is deliberately the exact advisory key and lock order used by
  -- claim/finish/abort recovery. Once an expired profile returns ready, a new
  -- recovery cannot subsequently win: its own admission rechecks the locked
  -- deletion_scheduled_at against the database clock.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );

  -- A recovery transaction may have acquired this lock just before the grace
  -- deadline. Use the clock after waiting so a cleanup request queued before
  -- the deadline cannot retain a stale grace-period decision after it crosses.
  v_now := pg_catalog.clock_timestamp();

  SELECT
    profile.deleted_at,
    profile.deletion_scheduled_at
  INTO
    v_deleted_at,
    v_deletion_scheduled_at
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_status := 'not_found';
  ELSIF v_deleted_at IS NULL THEN
    v_status := 'account_active';
  ELSIF v_deletion_scheduled_at IS NULL THEN
    v_status := 'not_scheduled';
  ELSIF v_deletion_scheduled_at > v_now THEN
    v_status := 'grace_period_active';
  ELSIF EXISTS (
    SELECT 1
    FROM public.account_recovery_admissions AS admission
    WHERE admission.user_id = p_user_id
      AND admission.state = 'claimed'
      AND admission.lease_expires_at > v_now
    FOR UPDATE
  ) THEN
    v_status := 'recovery_in_progress';
  ELSE
    v_status := 'ready';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_status,
    'user_id', p_user_id
  );
END
$function$;

ALTER FUNCTION public.admit_expired_account_hard_delete_atomic(uuid)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.admit_expired_account_hard_delete_atomic(uuid)
  FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.admit_expired_account_hard_delete_atomic(uuid)
  TO service_role;

COMMENT ON FUNCTION public.admit_expired_account_hard_delete_atomic(uuid) IS
  'Serializes expired-account hard deletion against an already-admitted recovery before any external destructive mutation.';

DO $postflight$
DECLARE
  v_function pg_catalog.regprocedure :=
    'public.admit_expired_account_hard_delete_atomic(uuid)'::pg_catalog.regprocedure;
  v_claim pg_catalog.regprocedure :=
    'public.claim_account_recovery_admission_atomic(uuid,text,uuid)'::pg_catalog.regprocedure;
  v_claim_impl pg_catalog.regprocedure :=
    'public.claim_account_recovery_admission_atomic_locked_impl(uuid,text,uuid)'::pg_catalog.regprocedure;
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service_role oid := pg_catalog.to_regrole('service_role');
BEGIN
  IF v_postgres IS NULL OR v_service_role IS NULL THEN
    RAISE EXCEPTION 'account hard-delete recovery barrier roles are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres
      AND function_row.prosecdef
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
        'lock_timeout=5s'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'account hard-delete recovery barrier contract drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    v_service_role,
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
    RAISE EXCEPTION 'account hard-delete recovery barrier ACL drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_claim
      AND function_row.proowner = v_postgres
      AND function_row.prosecdef
      AND function_row.prorettype = 'pg_catalog.text'::pg_catalog.regtype
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
  )
    OR NOT pg_catalog.has_function_privilege(v_service_role, v_claim, 'EXECUTE')
    OR pg_catalog.has_function_privilege(v_service_role, v_claim_impl, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', v_claim, 'EXECUTE')
    OR pg_catalog.has_function_privilege('anon', v_claim, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'account recovery advisory-first wrapper contract drifted';
  END IF;
END
$postflight$;
