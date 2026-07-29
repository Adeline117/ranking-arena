-- Recovery crosses Auth and PostgreSQL. If restoring the Auth ban fails, or
-- the final PostgreSQL outcome cannot be observed, retain an exact durable
-- incident record instead of relying on an ephemeral application log.

DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.record_account_recovery_auth_manual_review(uuid,uuid,text)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'account recovery Auth manual-review writer already exists';
  END IF;

  IF pg_catalog.to_regclass('public.account_recovery_admissions') IS NULL
    OR pg_catalog.to_regclass('public.stripe_manual_reviews') IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
  THEN
    RAISE EXCEPTION
      'account recovery Auth manual-review prerequisites are missing';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION
  public.record_account_recovery_auth_manual_review(
    p_user_id uuid,
    p_operation_id uuid,
    p_reason_key text
  )
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_review public.stripe_manual_reviews%ROWTYPE;
  v_reason text;
  v_inserted boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_operation_id IS NULL
    OR p_reason_key NOT IN (
      'auth_reban_failed',
      'finish_outcome_unknown'
    )
  THEN
    RAISE EXCEPTION 'invalid account recovery Auth review input'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );

  SELECT admission.*
  INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_admission.user_id IS DISTINCT FROM p_user_id
  THEN
    RAISE EXCEPTION 'account recovery Auth review identity conflict'
      USING ERRCODE = '23505';
  END IF;

  v_reason := CASE p_reason_key
    WHEN 'auth_reban_failed' THEN
      'Auth could not restore the deletion ban after an incomplete account recovery.'
    WHEN 'finish_outcome_unknown' THEN
      'The final account recovery transaction outcome could not be observed exactly.'
  END;

  INSERT INTO public.stripe_manual_reviews (
    object_type,
    object_id,
    user_id,
    action,
    reason_key,
    reason,
    metadata
  )
  VALUES (
    'account_recovery',
    p_operation_id::text,
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM public.user_profiles AS profile
        WHERE profile.id = p_user_id
      )
      THEN p_user_id
      ELSE NULL
    END,
    'reconcile_auth',
    'account_recovery:' || p_reason_key,
    v_reason,
    pg_catalog.jsonb_build_object(
      'user_id', p_user_id,
      'operation_id', p_operation_id,
      'reason_key', p_reason_key,
      'admission_state', v_admission.state,
      'admission_claimed_at', v_admission.claimed_at,
      'admission_lease_expires_at', v_admission.lease_expires_at,
      'recorded_at', pg_catalog.clock_timestamp()
    )
  )
  ON CONFLICT (object_type, object_id, reason_key) DO NOTHING
  RETURNING true INTO v_inserted;

  SELECT review.*
  INTO v_review
  FROM public.stripe_manual_reviews AS review
  WHERE review.object_type = 'account_recovery'
    AND review.object_id = p_operation_id::text
    AND review.reason_key = 'account_recovery:' || p_reason_key
  FOR UPDATE;
  IF NOT FOUND
    OR v_review.action IS DISTINCT FROM 'reconcile_auth'
    OR v_review.metadata ->> 'user_id' IS DISTINCT FROM p_user_id::text
    OR v_review.metadata ->> 'operation_id'
      IS DISTINCT FROM p_operation_id::text
    OR v_review.metadata ->> 'reason_key'
      IS DISTINCT FROM p_reason_key
  THEN
    RAISE EXCEPTION 'account recovery Auth review acknowledgement is not exact'
      USING ERRCODE = '23505';
  END IF;

  RETURN CASE WHEN v_inserted THEN 'recorded' ELSE 'existing' END;
END
$function$;

ALTER FUNCTION public.record_account_recovery_auth_manual_review(
  uuid,
  uuid,
  text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION
  public.record_account_recovery_auth_manual_review(uuid, uuid, text)
FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION
  public.record_account_recovery_auth_manual_review(uuid, uuid, text)
TO service_role;

COMMENT ON FUNCTION public.record_account_recovery_auth_manual_review(
  uuid,
  uuid,
  text
) IS
  'Persists an exact service-only manual-review record for unresolved cross-system account recovery Auth state.';
