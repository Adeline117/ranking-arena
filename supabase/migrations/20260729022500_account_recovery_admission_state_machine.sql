-- Account recovery crosses PostgreSQL, Auth, and Stripe. Admit exactly one
-- recovery operation before any external mutation so a concurrent loser can
-- exit without unbanning the user or changing billing.

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.account_recovery_admissions') IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.claim_account_recovery_admission_atomic(uuid,text,uuid)'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.finish_account_recovery_admission_atomic(uuid,uuid)'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.abort_account_recovery_admission_atomic(uuid,uuid)'
    ) IS NOT NULL
  THEN
    RAISE EXCEPTION 'account recovery admission state machine already exists';
  END IF;

  IF pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.account_recovery_tokens') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.restore_pending_account(uuid,text)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'account recovery admission prerequisites are missing';
  END IF;
END
$preflight$;

CREATE TABLE public.account_recovery_admissions (
  operation_id uuid PRIMARY KEY,
  -- Deliberately retained without a profile FK. A finished/aborted admission
  -- remains an exact concurrency and incident-response record after deletion.
  user_id uuid NOT NULL,
  recovery_token_hash text,
  state text NOT NULL,
  claimed_at timestamptz NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  finished_at timestamptz,
  aborted_at timestamptz,
  abort_reason text,
  updated_at timestamptz NOT NULL,
  CONSTRAINT account_recovery_admission_token_shape
    CHECK (
      recovery_token_hash IS NULL
      OR recovery_token_hash ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT account_recovery_admission_state
    CHECK (state IN ('claimed', 'finished', 'aborted')),
  CONSTRAINT account_recovery_admission_time_order
    CHECK (
      lease_expires_at > claimed_at
      AND updated_at >= claimed_at
    ),
  CONSTRAINT account_recovery_admission_terminal_shape
    CHECK (
      (
        state = 'claimed'
        AND finished_at IS NULL
        AND aborted_at IS NULL
        AND abort_reason IS NULL
      )
      OR (
        state = 'finished'
        AND finished_at IS NOT NULL
        AND aborted_at IS NULL
        AND abort_reason IS NULL
      )
      OR (
        state = 'aborted'
        AND finished_at IS NULL
        AND aborted_at IS NOT NULL
        AND pg_catalog.length(pg_catalog.btrim(abort_reason))
          BETWEEN 1 AND 128
      )
    )
);

CREATE UNIQUE INDEX account_recovery_admissions_one_claimed_user
  ON public.account_recovery_admissions (user_id)
  WHERE state = 'claimed';
CREATE INDEX account_recovery_admissions_user_history
  ON public.account_recovery_admissions (
    user_id,
    claimed_at DESC,
    operation_id
  );

ALTER TABLE public.account_recovery_admissions OWNER TO postgres;
ALTER TABLE public.account_recovery_admissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_recovery_admissions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_recovery_admissions
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE OR REPLACE FUNCTION public.claim_account_recovery_admission_atomic(
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
DECLARE
  v_existing public.account_recovery_admissions%ROWTYPE;
  v_active public.account_recovery_admissions%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_profile_deleted_at timestamptz;
  v_profile_deletion_scheduled_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_operation_id IS NULL
    OR (
      p_recovery_token_hash IS NOT NULL
      AND p_recovery_token_hash !~ '^[0-9a-f]{64}$'
    )
  THEN
    RAISE EXCEPTION 'invalid account recovery admission input'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );

  SELECT admission.*
  INTO v_existing
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = p_operation_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id
      OR v_existing.recovery_token_hash
        IS DISTINCT FROM p_recovery_token_hash
    THEN
      RAISE EXCEPTION 'account recovery operation identity conflict'
        USING ERRCODE = '23505';
    END IF;
    IF v_existing.state = 'finished' THEN
      RETURN 'finished';
    END IF;
    IF v_existing.state = 'claimed'
      AND v_existing.lease_expires_at > v_now
    THEN
      RETURN 'claimed';
    END IF;
    IF v_existing.state = 'claimed' THEN
      UPDATE public.account_recovery_admissions
      SET state = 'aborted',
          aborted_at = v_now,
          abort_reason = 'lease_expired',
          updated_at = v_now
      WHERE operation_id = p_operation_id;
    END IF;
  END IF;

  SELECT
    profile.deleted_at,
    profile.deletion_scheduled_at
  INTO
    v_profile_deleted_at,
    v_profile_deletion_scheduled_at
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_profile_deleted_at IS NULL
    OR v_profile_deletion_scheduled_at IS NULL
    OR v_profile_deletion_scheduled_at <= v_now
  THEN
    RETURN 'invalid';
  END IF;

  IF p_recovery_token_hash IS NOT NULL THEN
    PERFORM 1
    FROM public.account_recovery_tokens AS token
    WHERE token.user_id = p_user_id
      AND token.token_hash = p_recovery_token_hash
      AND token.used_at IS NULL
      AND token.expires_at > v_now
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN 'invalid';
    END IF;
  END IF;

  SELECT admission.*
  INTO v_active
  FROM public.account_recovery_admissions AS admission
  WHERE admission.user_id = p_user_id
    AND admission.state = 'claimed'
  ORDER BY admission.claimed_at, admission.operation_id
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    IF v_active.lease_expires_at > v_now THEN
      RETURN 'busy';
    END IF;
    UPDATE public.account_recovery_admissions
    SET state = 'aborted',
        aborted_at = v_now,
        abort_reason = 'lease_expired',
        updated_at = v_now
    WHERE operation_id = v_active.operation_id;
  END IF;

  UPDATE public.account_recovery_admissions
  SET state = 'claimed',
      claimed_at = v_now,
      lease_expires_at = v_now + interval '15 minutes',
      finished_at = NULL,
      aborted_at = NULL,
      abort_reason = NULL,
      updated_at = v_now
  WHERE operation_id = p_operation_id
    AND user_id = p_user_id
    AND recovery_token_hash IS NOT DISTINCT FROM p_recovery_token_hash;
  IF NOT FOUND THEN
    INSERT INTO public.account_recovery_admissions (
      operation_id,
      user_id,
      recovery_token_hash,
      state,
      claimed_at,
      lease_expires_at,
      updated_at
    )
    VALUES (
      p_operation_id,
      p_user_id,
      p_recovery_token_hash,
      'claimed',
      v_now,
      v_now + interval '15 minutes',
      v_now
    );
  END IF;

  RETURN 'claimed';
END
$function$;

ALTER FUNCTION public.claim_account_recovery_admission_atomic(uuid, text, uuid)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.finish_account_recovery_admission_atomic(
  p_user_id uuid,
  p_operation_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_restored_user_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'invalid account recovery finish input'
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
  IF NOT FOUND THEN
    RETURN 'absent';
  END IF;
  IF v_admission.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'account recovery operation identity conflict'
      USING ERRCODE = '23505';
  END IF;
  IF v_admission.state = 'finished' THEN
    RETURN 'finished';
  END IF;
  IF v_admission.state = 'aborted' THEN
    RETURN 'aborted';
  END IF;
  IF v_admission.lease_expires_at <= v_now THEN
    UPDATE public.account_recovery_admissions
    SET state = 'aborted',
        aborted_at = v_now,
        abort_reason = 'lease_expired',
        updated_at = v_now
    WHERE operation_id = p_operation_id;
    RETURN 'aborted';
  END IF;

  v_restored_user_id := public.restore_pending_account(
    p_user_id,
    v_admission.recovery_token_hash
  );
  IF v_restored_user_id IS DISTINCT FROM p_user_id THEN
    UPDATE public.account_recovery_admissions
    SET state = 'aborted',
        aborted_at = v_now,
        abort_reason = 'restore_invalid',
        updated_at = v_now
    WHERE operation_id = p_operation_id;
    RETURN 'invalid';
  END IF;

  UPDATE public.account_recovery_admissions
  SET state = 'finished',
      finished_at = v_now,
      updated_at = v_now
  WHERE operation_id = p_operation_id
    AND state = 'claimed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account recovery finish transition was not exact'
      USING ERRCODE = '40001';
  END IF;

  RETURN 'finished';
END
$function$;

ALTER FUNCTION public.finish_account_recovery_admission_atomic(uuid, uuid)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.abort_account_recovery_admission_atomic(
  p_user_id uuid,
  p_operation_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'invalid account recovery abort input'
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
  IF NOT FOUND THEN
    RETURN 'absent';
  END IF;
  IF v_admission.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION 'account recovery operation identity conflict'
      USING ERRCODE = '23505';
  END IF;
  IF v_admission.state = 'finished' THEN
    RETURN 'finished';
  END IF;
  IF v_admission.state = 'aborted' THEN
    RETURN 'aborted';
  END IF;

  UPDATE public.account_recovery_admissions
  SET state = 'aborted',
      aborted_at = v_now,
      abort_reason = 'caller_aborted',
      updated_at = v_now
  WHERE operation_id = p_operation_id
    AND state = 'claimed';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account recovery abort transition was not exact'
      USING ERRCODE = '40001';
  END IF;

  RETURN 'aborted';
END
$function$;

ALTER FUNCTION public.abort_account_recovery_admission_atomic(uuid, uuid)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION
  public.claim_account_recovery_admission_atomic(uuid, text, uuid)
FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION
  public.finish_account_recovery_admission_atomic(uuid, uuid)
FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION
  public.abort_account_recovery_admission_atomic(uuid, uuid)
FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION
  public.claim_account_recovery_admission_atomic(uuid, text, uuid)
TO service_role;
GRANT EXECUTE ON FUNCTION
  public.finish_account_recovery_admission_atomic(uuid, uuid)
TO service_role;
GRANT EXECUTE ON FUNCTION
  public.abort_account_recovery_admission_atomic(uuid, uuid)
TO service_role;

COMMENT ON TABLE public.account_recovery_admissions IS
  'Exact single-winner admission ledger for cross-system account recovery.';
COMMENT ON FUNCTION public.claim_account_recovery_admission_atomic(
  uuid,
  text,
  uuid
) IS
  'Claims the sole live recovery lease before any Auth or Stripe mutation.';
COMMENT ON FUNCTION public.finish_account_recovery_admission_atomic(uuid, uuid) IS
  'Atomically restores the pending profile and terminalizes its recovery admission.';
COMMENT ON FUNCTION public.abort_account_recovery_admission_atomic(uuid, uuid) IS
  'Idempotently releases an unfinished recovery admission after compensation.';
