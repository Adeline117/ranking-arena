-- Reissue an unfinished account-recovery finalization capability after its
-- HttpOnly cookie is lost.  Credentials only locate the single durable
-- operation.  A short-lived, one-time proof must then attest which member of
-- the current/previous HMAC key ring matches the hash already frozen in that
-- operation; neither the route nor a locator result may choose authority.

BEGIN;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.account_recovery_admissions') IS NULL
    OR pg_catalog.to_regclass('public.account_recovery_tokens') IS NULL
    OR pg_catalog.to_regclass('public.account_recovery_password_guards') IS NULL
    OR pg_catalog.to_regclass('public.account_deletion_auth_fences') IS NULL
    OR pg_catalog.to_regclass('public.account_hard_deletion_fences') IS NULL
    OR pg_catalog.to_regclass('public.account_deletion_one_time_settlements') IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('auth.users') IS NULL
    OR pg_catalog.to_regclass('public.account_recovery_one_unfinished_finalization_v2') IS NULL
    OR pg_catalog.to_regprocedure('extensions.crypt(text,text)') IS NULL
    OR pg_catalog.to_regprocedure('extensions.gen_random_bytes(integer)') IS NULL
  THEN
    RAISE EXCEPTION 'account recovery capability reacquisition prerequisites are missing';
  END IF;

  IF pg_catalog.to_regclass(
      'public.account_recovery_capability_reacquisition_tickets'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.resolve_account_recovery_capability_reacquisition_candidate_v1(uuid,text,uuid)'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.status_account_recovery_capability_reacquisition_atomic(uuid,text)'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.locate_account_recovery_capability_reacquisition_atomic(text,text,text)'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.attest_account_recovery_capability_reacquisition_atomic(uuid,text,text,text)'
    ) IS NOT NULL
  THEN
    RAISE EXCEPTION 'account recovery capability reacquisition objects already exist';
  END IF;
END
$preflight$;

CREATE TABLE public.account_recovery_capability_reacquisition_tickets (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL
    CONSTRAINT account_recovery_reacquisition_ticket_user_fk
    REFERENCES auth.users(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL
    CONSTRAINT account_recovery_reacquisition_ticket_admission_fk
    REFERENCES public.account_recovery_admissions(operation_id) ON DELETE CASCADE,
  locator_kind text NOT NULL
    CHECK (locator_kind IN ('token', 'password')),
  recovery_token_hash text,
  credential_snapshot_hash text NOT NULL
    CHECK (credential_snapshot_hash ~ '^[0-9a-f]{64}$'),
  proof_hash text NOT NULL
    CHECK (proof_hash ~ '^[0-9a-f]{64}$'),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  selected_candidate_index smallint,
  CONSTRAINT account_recovery_capability_reacquisition_ticket_token_shape
    CHECK (
      (
        locator_kind = 'token'
        AND recovery_token_hash IS NOT NULL
        AND recovery_token_hash ~ '^[0-9a-f]{64}$'
      )
      OR (locator_kind = 'password' AND recovery_token_hash IS NULL)
    ),
  CONSTRAINT account_recovery_capability_reacquisition_ticket_time_shape
    CHECK (
      expires_at > issued_at
      AND expires_at <= issued_at + interval '15 minutes'
      AND (
        (
          consumed_at IS NULL
          AND revoked_at IS NULL
          AND selected_candidate_index IS NULL
        )
        OR (
          consumed_at IS NOT NULL
          AND revoked_at IS NULL
          AND consumed_at >= issued_at
          AND consumed_at <= expires_at
          AND selected_candidate_index IN (0, 1)
        )
        OR (
          consumed_at IS NULL
          AND revoked_at IS NOT NULL
          AND revoked_at >= issued_at
          AND selected_candidate_index IS NULL
        )
      )
    )
);

CREATE UNIQUE INDEX account_recovery_reacquisition_one_active_proof
  ON public.account_recovery_capability_reacquisition_tickets (operation_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX account_recovery_capability_reacquisition_ticket_expiry
  ON public.account_recovery_capability_reacquisition_tickets (
    expires_at,
    id
  )
  WHERE consumed_at IS NULL;

CREATE INDEX account_recovery_capability_reacquisition_ticket_operation
  ON public.account_recovery_capability_reacquisition_tickets (
    user_id,
    operation_id,
    issued_at DESC,
    id
  );

ALTER TABLE public.account_recovery_capability_reacquisition_tickets
  OWNER TO postgres;
ALTER TABLE public.account_recovery_capability_reacquisition_tickets
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_recovery_capability_reacquisition_tickets
  FORCE ROW LEVEL SECURITY;

-- Internal matcher.  Every caller takes the same admission -> global -> user
-- advisory order, then freezes admission/profile/fence/token/Auth rows.  It
-- deliberately reports only an exact safe operation, a credential-valid new
-- recovery (`absent`), or a fail-closed invalid state.
CREATE FUNCTION public.resolve_account_recovery_capability_reacquisition_candidate_v1(
  p_user_id uuid,
  p_recovery_token_hash text,
  p_fallback_operation_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_profile public.user_profiles%ROWTYPE;
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_token public.account_recovery_tokens%ROWTYPE;
  v_unfinished_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR (
      p_recovery_token_hash IS NOT NULL
      AND p_recovery_token_hash !~ '^[0-9a-f]{64}$'
    )
    OR (p_fallback_operation_id IS NOT NULL AND p_recovery_token_hash IS NULL)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_user_id::text,
      0
    )
  );

  -- Lock all unfinished-shaped rows before counting.  The partial unique index
  -- is a deployment invariant, while this count remains a runtime fail-closed
  -- defense against disabled/corrupted index state.
  PERFORM 1
  FROM public.account_recovery_admissions AS admission
  WHERE admission.user_id = p_user_id
    AND admission.state IN ('claimed', 'finished')
    AND (
      admission.auth_finalization_state IS NULL
      OR admission.auth_finalization_state NOT IN ('completed', 'superseded')
    )
  ORDER BY admission.operation_id
  FOR UPDATE;

  SELECT pg_catalog.count(*)::integer
  INTO v_unfinished_count
  FROM public.account_recovery_admissions AS admission
  WHERE admission.user_id = p_user_id
    AND admission.state IN ('claimed', 'finished')
    AND (
      admission.auth_finalization_state IS NULL
      OR admission.auth_finalization_state NOT IN ('completed', 'superseded')
    );

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM 1
  FROM public.account_deletion_auth_fences AS fence
  WHERE fence.user_id = p_user_id
  FOR SHARE;
  PERFORM 1
  FROM public.account_hard_deletion_fences AS fence
  WHERE fence.user_id = p_user_id
  FOR SHARE;
  PERFORM 1
  FROM public.account_deletion_one_time_settlements AS settlement
  WHERE settlement.user_id = p_user_id
  ORDER BY settlement.id
  FOR SHARE;

  IF p_fallback_operation_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.account_deletion_auth_fences AS fence
      WHERE fence.user_id = p_user_id
        AND fence.operation_id = p_fallback_operation_id
        AND fence.recovery_token_hash = p_recovery_token_hash
        AND fence.state = 'completed'
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF EXISTS (
      SELECT 1
      FROM public.account_deletion_auth_fences AS fence
      WHERE fence.user_id = p_user_id
        AND fence.state NOT IN ('completed', 'released')
    )
    OR EXISTS (
      SELECT 1
      FROM public.account_hard_deletion_fences AS fence
      WHERE fence.user_id = p_user_id
        AND fence.state <> 'released'
    )
    OR EXISTS (
      SELECT 1
      FROM public.account_deletion_one_time_settlements AS settlement
      WHERE settlement.user_id = p_user_id
        AND settlement.settlement_status = 'pending_fulfillment'
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF p_recovery_token_hash IS NOT NULL THEN
    SELECT token.*
    INTO v_token
    FROM public.account_recovery_tokens AS token
    WHERE token.user_id = p_user_id
      AND token.token_hash = p_recovery_token_hash
    FOR UPDATE;
    IF NOT FOUND OR v_token.expires_at <= v_now THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
  END IF;

  PERFORM 1
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_user_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF v_unfinished_count = 0 THEN
    IF v_profile.deleted_at IS NULL
      OR v_profile.deletion_scheduled_at IS NULL
      OR v_profile.deletion_scheduled_at <= v_now
      OR (p_recovery_token_hash IS NOT NULL AND v_token.used_at IS NOT NULL)
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'absent');
  END IF;
  IF v_unfinished_count <> 1 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT admission.*
  INTO STRICT v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.user_id = p_user_id
    AND admission.state IN ('claimed', 'finished')
    AND (
      admission.auth_finalization_state IS NULL
      OR admission.auth_finalization_state NOT IN ('completed', 'superseded')
    );

  IF v_admission.auth_finalization_capability_hash IS NULL
    OR v_admission.auth_finalization_capability_hash !~ '^[0-9a-f]{64}$'
    OR v_admission.auth_finalization_prepared_at IS NULL
    OR v_admission.auth_finalization_prepared_at + interval '30 days' <= v_now
    OR (
      p_recovery_token_hash IS NOT NULL
      AND v_admission.recovery_token_hash IS DISTINCT FROM p_recovery_token_hash
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF v_admission.state = 'claimed' THEN
    IF v_admission.auth_finalization_state IS DISTINCT FROM 'prepared'
      OR v_admission.lease_expires_at <= v_now
      OR v_profile.deleted_at IS NULL
      OR v_profile.deletion_scheduled_at IS NULL
      OR v_profile.deletion_scheduled_at <= v_now
      OR (p_recovery_token_hash IS NOT NULL AND v_token.used_at IS NOT NULL)
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
  ELSIF v_admission.state = 'finished' THEN
    IF v_admission.auth_finalization_state NOT IN (
        'pending',
        'claimed',
        'auth_compensation_required',
        'billing_pending'
      )
      OR v_profile.deleted_at IS NOT NULL
      OR v_profile.deletion_scheduled_at IS NOT NULL
      OR (p_recovery_token_hash IS NOT NULL AND v_token.used_at IS NULL)
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
  ELSE
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'located',
    'user_id', v_admission.user_id,
    'operation_id', v_admission.operation_id,
    'auth_finalization_state', v_admission.auth_finalization_state
  );
END
$function$;

-- Browser reload discovery has only the HttpOnly fallback token.  The cookie
-- name is the deletion-fence operation, not the later recovery operation.
-- This authority is durable-write-free and reveals neither user nor recovery
-- operation.
CREATE FUNCTION public.status_account_recovery_capability_reacquisition_atomic(
  p_operation_id uuid,
  p_recovery_token_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_user_id uuid;
  v_match jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_operation_id IS NULL
    OR p_recovery_token_hash IS NULL
    OR p_recovery_token_hash !~ '^[0-9a-f]{64}$'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT fence.user_id
  INTO v_user_id
  FROM public.account_deletion_auth_fences AS fence
  WHERE fence.operation_id = p_operation_id
    AND fence.recovery_token_hash = p_recovery_token_hash
    AND fence.state = 'completed';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'unavailable');
  END IF;

  v_match := public.resolve_account_recovery_capability_reacquisition_candidate_v1(
    v_user_id,
    p_recovery_token_hash,
    p_operation_id
  );
  RETURN CASE v_match ->> 'status'
    WHEN 'absent' THEN pg_catalog.jsonb_build_object('status', 'available')
    WHEN 'located' THEN pg_catalog.jsonb_build_object('status', 'available')
    ELSE pg_catalog.jsonb_build_object('status', 'unavailable')
  END;
END
$function$;

-- Credential locator.  A valid credential with no unfinished operation returns
-- `absent`, allowing the existing new-claim protocol.  Any unsafe/ambiguous
-- state is `invalid`; an unsupported bcrypt authority is `unavailable`.
CREATE FUNCTION public.locate_account_recovery_capability_reacquisition_atomic(
  p_recovery_token_hash text,
  p_email text,
  p_password text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_user_id uuid;
  v_profile_email text;
  v_auth_email text;
  v_encrypted_password text;
  v_guard public.account_recovery_password_guards%ROWTYPE;
  v_match jsonb;
  v_ticket_id uuid := pg_catalog.gen_random_uuid();
  v_proof text;
  v_credential_snapshot_hash text;
  v_operation_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF NOT (
      (
        p_recovery_token_hash ~ '^[0-9a-f]{64}$'
        AND p_email IS NULL
        AND p_password IS NULL
      )
      OR (
        p_recovery_token_hash IS NULL
        AND p_email IS NOT NULL
        AND p_password IS NOT NULL
        AND p_email = pg_catalog.lower(pg_catalog.btrim(p_email))
        AND pg_catalog.octet_length(p_email) BETWEEN 3 AND 320
        AND pg_catalog.octet_length(p_password) BETWEEN 1 AND 72
      )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF p_recovery_token_hash IS NOT NULL THEN
    SELECT token.user_id
    INTO v_user_id
    FROM public.account_recovery_tokens AS token
    WHERE token.token_hash = p_recovery_token_hash
      AND token.expires_at > v_now;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
  ELSE
    SELECT profile.id, profile.email, auth_user.email
    INTO v_user_id, v_profile_email, v_auth_email
    FROM public.user_profiles AS profile
    JOIN auth.users AS auth_user ON auth_user.id = profile.id
    WHERE profile.email = p_email
      AND auth_user.email = p_email
    ORDER BY profile.id
    LIMIT 1;
    IF NOT FOUND OR (
      SELECT pg_catalog.count(*)
      FROM public.user_profiles AS profile
      JOIN auth.users AS auth_user ON auth_user.id = profile.id
      WHERE profile.email = p_email
        AND auth_user.email = p_email
    ) <> 1 THEN
      PERFORM extensions.crypt(
        p_password,
        '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'
      );
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
  END IF;

  v_match := public.resolve_account_recovery_capability_reacquisition_candidate_v1(
    v_user_id,
    p_recovery_token_hash,
    NULL
  );

  IF p_recovery_token_hash IS NULL THEN
    SELECT profile.email, auth_user.email, auth_user.encrypted_password
    INTO v_profile_email, v_auth_email, v_encrypted_password
    FROM public.user_profiles AS profile
    JOIN auth.users AS auth_user ON auth_user.id = profile.id
    WHERE profile.id = v_user_id
    FOR UPDATE OF profile, auth_user;
    IF NOT FOUND
      OR v_profile_email IS DISTINCT FROM p_email
      OR v_auth_email IS DISTINCT FROM p_email
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;

    SELECT guard.*
    INTO v_guard
    FROM public.account_recovery_password_guards AS guard
    WHERE guard.user_id = v_user_id
    FOR UPDATE;
    IF FOUND AND v_guard.locked_until > v_now THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
    IF v_encrypted_password IS NULL
      OR pg_catalog.octet_length(v_encrypted_password) <> 60
      OR v_encrypted_password !~ '^\$2a\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'unavailable');
    END IF;
    IF pg_catalog.substring(v_encrypted_password, 5, 2)::integer
      NOT BETWEEN 4 AND 14
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'unavailable');
    END IF;
    IF extensions.crypt(p_password, v_encrypted_password)
      IS DISTINCT FROM v_encrypted_password
    THEN
      INSERT INTO public.account_recovery_password_guards (
        user_id,
        window_started_at,
        failure_count,
        locked_until,
        updated_at
      ) VALUES (
        v_user_id,
        v_now,
        1,
        NULL,
        v_now
      )
      ON CONFLICT (user_id) DO UPDATE SET
        window_started_at = CASE
          WHEN account_recovery_password_guards.window_started_at
            <= v_now - interval '15 minutes'
          THEN v_now
          ELSE account_recovery_password_guards.window_started_at
        END,
        failure_count = CASE
          WHEN account_recovery_password_guards.window_started_at
            <= v_now - interval '15 minutes'
          THEN 1
          ELSE LEAST(
            5,
            account_recovery_password_guards.failure_count + 1
          )
        END,
        locked_until = CASE
          WHEN account_recovery_password_guards.window_started_at
            > v_now - interval '15 minutes'
            AND account_recovery_password_guards.failure_count >= 4
          THEN v_now + interval '15 minutes'
          ELSE NULL
        END,
        updated_at = v_now;
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
    DELETE FROM public.account_recovery_password_guards
    WHERE user_id = v_user_id;
  END IF;

  IF v_match ->> 'status' IS DISTINCT FROM 'located' THEN
    RETURN v_match;
  END IF;

  v_operation_id := (v_match ->> 'operation_id')::uuid;
  v_proof := pg_catalog.rtrim(
    pg_catalog.translate(
      pg_catalog.encode(extensions.gen_random_bytes(32), 'base64'),
      '+/',
      '-_'
    ),
    '='
  );
  v_credential_snapshot_hash := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        CASE
          WHEN p_recovery_token_hash IS NOT NULL
          THEN 'account-recovery-reacquisition:token:v1:' || p_recovery_token_hash
          ELSE 'account-recovery-reacquisition:password:v1:'
            || v_profile_email
            || ':' || v_auth_email
            || ':' || v_encrypted_password
        END,
        'UTF8'
      )
    ),
    'hex'
  );

  -- A newly verified credential supersedes any older unconsumed proof for the
  -- same operation. The shared admission advisory lock serializes locators;
  -- the partial unique index remains a fail-closed deployment invariant.
  UPDATE public.account_recovery_capability_reacquisition_tickets
  SET revoked_at = v_now
  WHERE operation_id = v_operation_id
    AND consumed_at IS NULL
    AND revoked_at IS NULL;

  INSERT INTO public.account_recovery_capability_reacquisition_tickets (
    id,
    user_id,
    operation_id,
    locator_kind,
    recovery_token_hash,
    credential_snapshot_hash,
    proof_hash,
    issued_at,
    expires_at
  ) VALUES (
    v_ticket_id,
    v_user_id,
    v_operation_id,
    CASE WHEN p_recovery_token_hash IS NULL THEN 'password' ELSE 'token' END,
    p_recovery_token_hash,
    v_credential_snapshot_hash,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_proof, 'UTF8')),
      'hex'
    ),
    v_now,
    v_now + interval '15 minutes'
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'located',
    'user_id', v_user_id,
    'operation_id', v_operation_id,
    'reacquisition_id', v_ticket_id,
    'reacquisition_proof', v_proof
  );
END
$function$;

-- Final authority.  The ticket is read only to discover the canonical lock
-- key, then re-read FOR UPDATE after the shared matcher has frozen the subject.
-- Successful consumption is a single CAS and returns the exact matching key
-- ring index; a locator result alone never authorizes a cookie.
CREATE FUNCTION public.attest_account_recovery_capability_reacquisition_atomic(
  p_reacquisition_id uuid,
  p_reacquisition_proof text,
  p_current_capability_hash text,
  p_previous_capability_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_ticket public.account_recovery_capability_reacquisition_tickets%ROWTYPE;
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_match jsonb;
  v_snapshot_hash text;
  v_profile_email text;
  v_auth_email text;
  v_encrypted_password text;
  v_candidate_index smallint;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_reacquisition_id IS NULL
    OR p_reacquisition_proof IS NULL
    OR p_reacquisition_proof !~ '^[A-Za-z0-9_-]{43}$'
    OR p_current_capability_hash IS NULL
    OR p_current_capability_hash !~ '^[0-9a-f]{64}$'
    OR (
      p_previous_capability_hash IS NOT NULL
      AND p_previous_capability_hash !~ '^[0-9a-f]{64}$'
    )
    OR p_previous_capability_hash IS NOT DISTINCT FROM p_current_capability_hash
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT ticket.*
  INTO v_ticket
  FROM public.account_recovery_capability_reacquisition_tickets AS ticket
  WHERE ticket.id = p_reacquisition_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  v_match := public.resolve_account_recovery_capability_reacquisition_candidate_v1(
    v_ticket.user_id,
    v_ticket.recovery_token_hash,
    NULL
  );

  SELECT ticket.*
  INTO v_ticket
  FROM public.account_recovery_capability_reacquisition_tickets AS ticket
  WHERE ticket.id = p_reacquisition_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_ticket.consumed_at IS NOT NULL
    OR v_ticket.revoked_at IS NOT NULL
    OR v_ticket.expires_at <= v_now
    OR v_ticket.proof_hash IS DISTINCT FROM pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(p_reacquisition_proof, 'UTF8')
      ),
      'hex'
    )
    OR v_match ->> 'status' IS DISTINCT FROM 'located'
    OR (v_match ->> 'user_id')::uuid IS DISTINCT FROM v_ticket.user_id
    OR (v_match ->> 'operation_id')::uuid IS DISTINCT FROM v_ticket.operation_id
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF v_ticket.locator_kind = 'token' THEN
    v_snapshot_hash := pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          'account-recovery-reacquisition:token:v1:'
            || v_ticket.recovery_token_hash,
          'UTF8'
        )
      ),
      'hex'
    );
  ELSE
    SELECT profile.email, auth_user.email, auth_user.encrypted_password
    INTO v_profile_email, v_auth_email, v_encrypted_password
    FROM public.user_profiles AS profile
    JOIN auth.users AS auth_user ON auth_user.id = profile.id
    WHERE profile.id = v_ticket.user_id
    FOR UPDATE OF profile, auth_user;
    IF NOT FOUND
      OR v_profile_email IS NULL
      OR v_auth_email IS DISTINCT FROM v_profile_email
      OR v_profile_email IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(v_profile_email))
      OR v_encrypted_password IS NULL
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
    v_snapshot_hash := pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          'account-recovery-reacquisition:password:v1:'
            || v_profile_email
            || ':' || v_auth_email
            || ':' || v_encrypted_password,
          'UTF8'
        )
      ),
      'hex'
    );
  END IF;
  IF v_snapshot_hash IS DISTINCT FROM v_ticket.credential_snapshot_hash THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT admission.*
  INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = v_ticket.operation_id
    AND admission.user_id = v_ticket.user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  v_candidate_index := CASE
    WHEN v_admission.auth_finalization_capability_hash
      = p_current_capability_hash
    THEN 0
    WHEN p_previous_capability_hash IS NOT NULL
      AND v_admission.auth_finalization_capability_hash
        = p_previous_capability_hash
    THEN 1
    ELSE NULL
  END;
  IF v_candidate_index IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  UPDATE public.account_recovery_capability_reacquisition_tickets
  SET consumed_at = v_now,
      selected_candidate_index = v_candidate_index
  WHERE id = p_reacquisition_id
    AND consumed_at IS NULL
    AND revoked_at IS NULL
    AND expires_at > v_now
    AND proof_hash = pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(p_reacquisition_proof, 'UTF8')
      ),
      'hex'
    );
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'reacquired',
    'user_id', v_ticket.user_id,
    'operation_id', v_ticket.operation_id,
    'candidate_index', v_candidate_index,
    'auth_finalization_state', v_match ->> 'auth_finalization_state'
  );
END
$function$;

ALTER FUNCTION public.resolve_account_recovery_capability_reacquisition_candidate_v1(
  uuid, text, uuid
) OWNER TO postgres;
ALTER FUNCTION public.status_account_recovery_capability_reacquisition_atomic(
  uuid, text
) OWNER TO postgres;
ALTER FUNCTION public.locate_account_recovery_capability_reacquisition_atomic(
  text, text, text
) OWNER TO postgres;
ALTER FUNCTION public.attest_account_recovery_capability_reacquisition_atomic(
  uuid, text, text, text
) OWNER TO postgres;

-- Scrub all inherited/default grants, including unknown roles introduced by a
-- hostile ALTER DEFAULT PRIVILEGES, before adding back the three runtime RPCs.
DO $close_acl$
DECLARE
  v_owner oid := 'postgres'::pg_catalog.regrole;
  v_grantee oid;
  v_grantee_name name;
  v_function pg_catalog.regprocedure;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT permission.grantee
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS permission
    WHERE relation.oid =
      'public.account_recovery_capability_reacquisition_tickets'::pg_catalog.regclass
      AND permission.grantee <> v_owner
  LOOP
    IF v_grantee = 0 THEN
      EXECUTE 'REVOKE ALL PRIVILEGES ON TABLE public.account_recovery_capability_reacquisition_tickets FROM PUBLIC';
    ELSE
      SELECT role_row.rolname INTO STRICT v_grantee_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.account_recovery_capability_reacquisition_tickets FROM %I',
        v_grantee_name
      );
    END IF;
  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    'public.resolve_account_recovery_capability_reacquisition_candidate_v1(uuid,text,uuid)'::pg_catalog.regprocedure,
    'public.status_account_recovery_capability_reacquisition_atomic(uuid,text)'::pg_catalog.regprocedure,
    'public.locate_account_recovery_capability_reacquisition_atomic(text,text,text)'::pg_catalog.regprocedure,
    'public.attest_account_recovery_capability_reacquisition_atomic(uuid,text,text,text)'::pg_catalog.regprocedure
  ]
  LOOP
    FOR v_grantee IN
      SELECT DISTINCT permission.grantee
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS permission
      WHERE function_row.oid = v_function
        AND permission.grantee <> v_owner
    LOOP
      IF v_grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
          v_function
        );
      ELSE
        SELECT role_row.rolname INTO STRICT v_grantee_name
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.oid = v_grantee;
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
          v_function,
          v_grantee_name
        );
      END IF;
    END LOOP;
  END LOOP;
END
$close_acl$;

GRANT EXECUTE ON FUNCTION
  public.status_account_recovery_capability_reacquisition_atomic(uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.locate_account_recovery_capability_reacquisition_atomic(text, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION
  public.attest_account_recovery_capability_reacquisition_atomic(uuid, text, text, text)
  TO service_role;

COMMENT ON TABLE public.account_recovery_capability_reacquisition_tickets IS
  'Short-lived, one-time proof ledger joining a freshly verified recovery credential to one exact unfinished finalization operation; raw proofs and passwords are never stored.';
COMMENT ON FUNCTION public.status_account_recovery_capability_reacquisition_atomic(
  uuid, text
) IS
  'Service-only, durable-write-free availability authority for an exact deletion fallback cookie operation and recovery token hash.';
COMMENT ON FUNCTION public.locate_account_recovery_capability_reacquisition_atomic(
  text, text, text
) IS
  'Service-only token or normalized email/password locator which issues a short-lived one-time proof only for one exact safe unfinished recovery finalization.';
COMMENT ON FUNCTION public.attest_account_recovery_capability_reacquisition_atomic(
  uuid, text, text, text
) IS
  'Service-only final attestation which re-locks credential and operation authority, atomically consumes one ticket, and selects the exact current/previous capability hash index.';

DO $postflight$
DECLARE
  v_owner oid := 'postgres'::pg_catalog.regrole;
  v_service oid := 'service_role'::pg_catalog.regrole;
  v_external pg_catalog.regprocedure[] := ARRAY[
    'public.status_account_recovery_capability_reacquisition_atomic(uuid,text)'::pg_catalog.regprocedure,
    'public.locate_account_recovery_capability_reacquisition_atomic(text,text,text)'::pg_catalog.regprocedure,
    'public.attest_account_recovery_capability_reacquisition_atomic(uuid,text,text,text)'::pg_catalog.regprocedure
  ];
  v_internal pg_catalog.regprocedure[] := ARRAY[
    'public.resolve_account_recovery_capability_reacquisition_candidate_v1(uuid,text,uuid)'::pg_catalog.regprocedure
  ];
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
      'public.account_recovery_capability_reacquisition_tickets'::pg_catalog.regclass
      AND relation.relowner = v_owner
      AND relation.relkind = 'r'
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.account_recovery_capability_reacquisition_tickets'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.confrelid IN (
        'auth.users'::pg_catalog.regclass,
        'public.account_recovery_admissions'::pg_catalog.regclass
      )
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    WHERE index_row.indrelid =
      'public.account_recovery_capability_reacquisition_tickets'::pg_catalog.regclass
      AND index_relation.relname = 'account_recovery_reacquisition_one_active_proof'
      AND index_row.indisunique
      AND index_row.indisvalid
      AND pg_catalog.pg_get_expr(
        index_row.indpred,
        index_row.indrelid
      ) = '((consumed_at IS NULL) AND (revoked_at IS NULL))'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS permission
    WHERE relation.oid =
      'public.account_recovery_capability_reacquisition_tickets'::pg_catalog.regclass
      AND permission.grantee <> v_owner
  ) THEN
    RAISE EXCEPTION 'account recovery capability reacquisition ticket table contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = ANY(v_external || v_internal)
      AND (
        function_row.proowner <> v_owner
        OR NOT function_row.prosecdef
        OR function_row.prokind <> 'f'
        OR function_row.provolatile <> 'v'
        OR function_row.proisstrict
        OR function_row.proleakproof
        OR function_row.proparallel <> 'u'
        OR function_row.prorettype <> 'pg_catalog.jsonb'::pg_catalog.regtype
        OR function_row.proconfig IS DISTINCT FROM ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off',
          'lock_timeout=5s',
          'statement_timeout=30s',
          'idle_in_transaction_session_timeout=30s'
        ]::text[]
      )
  ) THEN
    RAISE EXCEPTION 'account recovery capability reacquisition function metadata drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS permission
    WHERE function_row.oid = ANY(v_external || v_internal)
      AND NOT (
        permission.grantee = v_owner
        AND permission.privilege_type = 'EXECUTE'
      )
      AND NOT (
        function_row.oid = ANY(v_external)
        AND permission.grantee = v_service
        AND permission.privilege_type = 'EXECUTE'
        AND NOT permission.is_grantable
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_external) AS expected(function_oid)
    WHERE NOT pg_catalog.has_function_privilege(
      v_service,
      expected.function_oid,
      'EXECUTE'
    )
  ) OR pg_catalog.has_function_privilege(
    v_service,
    v_internal[1],
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'account recovery capability reacquisition ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public.resolve_account_recovery_capability_reacquisition_candidate_v1(uuid,text,uuid)'::pg_catalog.regprocedure,
          '0200b979c5928d9768fb5040faaa7f863c7169c18944343dc858fd3c2cd38d21'::text),
        ('public.status_account_recovery_capability_reacquisition_atomic(uuid,text)'::pg_catalog.regprocedure,
          '1e42ccbc3f1b0b29f517964227697a825518170ab2f5f2ee8a56bf0eaaea84a1'::text),
        ('public.locate_account_recovery_capability_reacquisition_atomic(text,text,text)'::pg_catalog.regprocedure,
          '4eaf265f77509fb8a97113c4c58976232f0b094289b2ab52023020ee295a7fc7'::text),
        ('public.attest_account_recovery_capability_reacquisition_atomic(uuid,text,text,text)'::pg_catalog.regprocedure,
          '80ad103052ce2e855319e22329b0fd717bf476ae2e7cb6c24824a59216ce088a'::text)
    ) AS expected(function_oid, source_hash)
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected.function_oid
    WHERE pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(function_row.prosrc, 'UTF8')
      ),
      'hex'
    ) <> expected.source_hash
  ) THEN
    RAISE EXCEPTION 'account recovery capability reacquisition function body hash drifted';
  END IF;
END
$postflight$;

COMMIT;
