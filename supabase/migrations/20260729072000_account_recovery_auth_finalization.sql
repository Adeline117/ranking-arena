-- Make the Auth side of account recovery an exact, one-time durable
-- finalization. The browser holds only a random capability; PostgreSQL is the
-- authority for whether that capability may perform one Auth unban attempt.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL idle_in_transaction_session_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.account_recovery_admissions') IS NULL
    OR pg_catalog.to_regclass('auth.users') IS NULL
    OR pg_catalog.to_regprocedure('extensions.crypt(text,text)') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.finish_account_recovery_admission_atomic(uuid,uuid)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'account recovery Auth finalization prerequisites are missing';
  END IF;
  IF pg_catalog.to_regclass('public.account_deletion_auth_fences') IS NOT NULL
    OR pg_catalog.to_regclass('public.account_recovery_password_guards') IS NOT NULL
    OR pg_catalog.to_regclass('public.account_hard_deletion_fences') IS NOT NULL
    OR pg_catalog.to_regclass('public.account_auth_reconciliation_scheduler') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.claim_account_recovery_with_deletion_fence_atomic(uuid,text,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.verify_pending_account_password_atomic(uuid,uuid,text,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.prepare_account_recovery_auth_finalization_atomic(uuid,uuid,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.resolve_account_recovery_capability_atomic(uuid,uuid,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.finish_account_recovery_with_auth_finalization_atomic(uuid,uuid,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.claim_account_recovery_auth_finalization_atomic(uuid,uuid,text,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.finalize_account_recovery_auth_atomic(uuid,uuid,text,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.require_account_recovery_auth_compensation_atomic(uuid,uuid,text,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.complete_account_recovery_auth_compensation_atomic(uuid,uuid,text,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.arm_account_recovery_billing_atomic(uuid,uuid,text,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.resolve_account_recovery_compensation_scope_atomic(uuid,uuid,text,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.complete_account_recovery_billing_atomic(uuid,uuid,text,uuid,boolean)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.release_account_recovery_auth_finalization_atomic(uuid,uuid,text,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.prepare_account_deletion_auth_fence_atomic(uuid,uuid,text,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.claim_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.resolve_account_deletion_capability_atomic(uuid,uuid,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.schedule_account_deletion_with_billing_blocks_fenced(uuid,uuid,uuid,text,timestamp with time zone,text,text,text[])') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.complete_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.release_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.claim_account_hard_deletion_atomic(uuid,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.arm_account_hard_deletion_atomic(uuid,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.complete_account_hard_deletion_atomic(uuid,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.finalize_account_hard_deletion_worker_atomic(uuid,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.finalize_account_hard_deletion_takeover_atomic(uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.release_account_hard_deletion_atomic(uuid,uuid)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.list_account_auth_reconciliation_candidates_atomic(integer)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.list_account_hard_deletion_candidates_atomic(integer)') IS NOT NULL
    OR pg_catalog.to_regprocedure('public.resolve_account_auth_reconciliation_authority_atomic(uuid)') IS NOT NULL
  THEN
    RAISE EXCEPTION 'account recovery Auth finalization objects already exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.account_recovery_admissions'::pg_catalog.regclass
      AND attribute.attname LIKE 'auth_finalization_%'
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'account recovery Auth finalization already exists';
  END IF;
END
$preflight$;

ALTER TABLE public.account_recovery_admissions
  ADD COLUMN auth_finalization_capability_hash text,
  ADD COLUMN auth_finalization_state text,
  ADD COLUMN auth_finalization_prepared_at timestamptz,
  ADD COLUMN auth_finalization_attempt_id uuid,
  ADD COLUMN auth_finalization_attempt_expires_at timestamptz,
  ADD COLUMN auth_finalized_at timestamptz,
  ADD COLUMN recovery_billing_resumed boolean,
  ADD COLUMN recovery_billing_may_have_changed boolean,
  ADD CONSTRAINT account_recovery_auth_finalization_shape CHECK (
    (
      auth_finalization_state IS NULL
      AND auth_finalization_capability_hash IS NULL
      AND auth_finalization_prepared_at IS NULL
      AND auth_finalization_attempt_id IS NULL
      AND auth_finalization_attempt_expires_at IS NULL
      AND auth_finalized_at IS NULL
      AND recovery_billing_resumed IS NULL
      AND recovery_billing_may_have_changed IS NULL
    )
    OR (
      auth_finalization_state IN ('prepared', 'pending', 'claimed', 'auth_compensation_required', 'billing_pending', 'completed', 'superseded', 'expired_manual')
      AND auth_finalization_capability_hash ~ '^[0-9a-f]{64}$'
      AND auth_finalization_prepared_at IS NOT NULL
      AND (
        (
          auth_finalization_state IN ('prepared', 'pending')
          AND auth_finalization_attempt_id IS NULL
          AND auth_finalization_attempt_expires_at IS NULL
          AND auth_finalized_at IS NULL
          AND recovery_billing_resumed IS NULL
          AND recovery_billing_may_have_changed IS NULL
        )
        OR (
          auth_finalization_state = 'claimed'
          AND auth_finalization_attempt_id IS NOT NULL
          AND auth_finalization_attempt_expires_at IS NOT NULL
          AND auth_finalization_attempt_expires_at > auth_finalization_prepared_at
          AND auth_finalized_at IS NULL
          AND recovery_billing_resumed IS NULL
          AND recovery_billing_may_have_changed IS NULL
        )
        OR (
          auth_finalization_state = 'auth_compensation_required'
          AND auth_finalization_attempt_id IS NOT NULL
          AND auth_finalization_attempt_expires_at IS NOT NULL
          AND auth_finalized_at IS NULL
          AND recovery_billing_resumed IS NULL
          AND recovery_billing_may_have_changed IS NOT NULL
        )
        OR (
          auth_finalization_state = 'billing_pending'
          AND auth_finalization_attempt_id IS NOT NULL
          AND auth_finalization_attempt_expires_at IS NOT NULL
          AND auth_finalized_at IS NOT NULL
          AND auth_finalized_at >= auth_finalization_prepared_at
          AND recovery_billing_resumed IS NULL
          AND recovery_billing_may_have_changed IS NOT NULL
        )
        OR (
          auth_finalization_state = 'completed'
          AND auth_finalization_attempt_id IS NULL
          AND auth_finalization_attempt_expires_at IS NULL
          AND auth_finalized_at IS NOT NULL
          AND auth_finalized_at >= auth_finalization_prepared_at
          AND recovery_billing_resumed IS NOT NULL
          AND recovery_billing_may_have_changed IS NULL
        )
        OR (
          auth_finalization_state = 'superseded'
          AND auth_finalization_attempt_id IS NULL
          AND auth_finalization_attempt_expires_at IS NULL
          AND auth_finalized_at IS NULL
          AND recovery_billing_resumed IS NULL
          AND recovery_billing_may_have_changed IS NULL
        )
        OR (
          auth_finalization_state = 'expired_manual'
          AND auth_finalization_attempt_id IS NULL
          AND auth_finalization_attempt_expires_at IS NULL
          AND recovery_billing_resumed IS NULL
          AND recovery_billing_may_have_changed IS NOT NULL
        )
      )
    )
  );

CREATE INDEX account_recovery_auth_finalization_pending
  ON public.account_recovery_admissions (user_id, auth_finalization_state)
  WHERE auth_finalization_state IN ('prepared', 'pending', 'claimed', 'auth_compensation_required', 'billing_pending');

CREATE TABLE public.account_deletion_auth_fences (
  user_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  worker_attempt_id uuid,
  recovery_token_hash text NOT NULL CHECK (recovery_token_hash ~ '^[0-9a-f]{64}$'),
  reason text NOT NULL CHECK (pg_catalog.octet_length(reason) <= 256),
  state text NOT NULL CHECK (state IN ('prepared', 'billing_pending', 'auth_ban_pending', 'completed', 'released', 'expired_manual')),
  prepared_at timestamptz NOT NULL,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  schedule_ack jsonb,
  completed_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT account_deletion_auth_fence_shape CHECK (
    updated_at >= prepared_at
    AND (
      (state = 'prepared' AND worker_attempt_id IS NULL AND claimed_at IS NULL AND lease_expires_at IS NULL AND schedule_ack IS NULL AND completed_at IS NULL AND released_at IS NULL)
      OR (state = 'billing_pending' AND worker_attempt_id IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at > claimed_at AND schedule_ack IS NULL AND completed_at IS NULL AND released_at IS NULL)
      OR (state = 'auth_ban_pending' AND worker_attempt_id IS NOT NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL AND schedule_ack IS NOT NULL AND completed_at IS NULL AND released_at IS NULL)
      OR (state = 'completed' AND worker_attempt_id IS NULL AND claimed_at IS NOT NULL AND lease_expires_at IS NULL AND schedule_ack IS NOT NULL AND completed_at IS NOT NULL AND released_at IS NULL)
      OR (state = 'released' AND worker_attempt_id IS NULL AND lease_expires_at IS NULL AND schedule_ack IS NULL AND completed_at IS NULL AND released_at IS NOT NULL)
      OR (state = 'expired_manual' AND worker_attempt_id IS NULL AND lease_expires_at IS NULL AND completed_at IS NULL AND released_at IS NULL)
    )
  )
);
ALTER TABLE public.account_deletion_auth_fences OWNER TO postgres;
ALTER TABLE public.account_deletion_auth_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_deletion_auth_fences FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_deletion_auth_fences
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE TABLE public.account_recovery_password_guards (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_started_at timestamptz NOT NULL,
  failure_count integer NOT NULL CHECK (failure_count BETWEEN 1 AND 5),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL,
  CHECK (updated_at>=window_started_at),
  CHECK (locked_until IS NULL OR (failure_count=5 AND locked_until>window_started_at))
);
ALTER TABLE public.account_recovery_password_guards OWNER TO postgres;
ALTER TABLE public.account_recovery_password_guards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_recovery_password_guards FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_recovery_password_guards
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE TABLE public.account_hard_deletion_fences (
  user_id uuid PRIMARY KEY,
  worker_attempt_id uuid,
  state text NOT NULL CHECK (state IN ('claimed','hard_delete_pending','completed','released')),
  claimed_at timestamptz NOT NULL,
  lease_expires_at timestamptz,
  armed_at timestamptz,
  completed_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT account_hard_deletion_fence_shape CHECK (
    updated_at>=claimed_at AND (
      (state='claimed' AND worker_attempt_id IS NOT NULL AND lease_expires_at>claimed_at AND armed_at IS NULL AND completed_at IS NULL AND released_at IS NULL)
      OR (state='hard_delete_pending' AND worker_attempt_id IS NOT NULL AND lease_expires_at IS NOT NULL AND armed_at IS NOT NULL AND completed_at IS NULL AND released_at IS NULL)
      OR (state='completed' AND worker_attempt_id IS NULL AND lease_expires_at IS NULL AND armed_at IS NOT NULL AND completed_at IS NOT NULL AND released_at IS NULL)
      OR (state='released' AND worker_attempt_id IS NULL AND lease_expires_at IS NULL AND armed_at IS NULL AND completed_at IS NULL AND released_at IS NOT NULL)
    )
  )
);
ALTER TABLE public.account_hard_deletion_fences OWNER TO postgres;
ALTER TABLE public.account_hard_deletion_fences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_hard_deletion_fences FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_hard_deletion_fences
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE TABLE public.account_auth_reconciliation_scheduler (
  user_id uuid PRIMARY KEY,
  last_selected_at timestamptz,
  selection_count bigint NOT NULL DEFAULT 0 CHECK (selection_count >= 0),
  hard_delete_last_selected_at timestamptz,
  hard_delete_selection_count bigint NOT NULL DEFAULT 0 CHECK (hard_delete_selection_count >= 0),
  updated_at timestamptz NOT NULL
);
ALTER TABLE public.account_auth_reconciliation_scheduler OWNER TO postgres;
ALTER TABLE public.account_auth_reconciliation_scheduler ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_auth_reconciliation_scheduler FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_auth_reconciliation_scheduler
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE OR REPLACE FUNCTION public.claim_account_recovery_with_deletion_fence_atomic(
  p_user_id uuid,
  p_recovery_token_hash text,
  p_operation_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL THEN
    RAISE EXCEPTION 'invalid fenced recovery claim input' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account-recovery-admission:' || p_user_id::text, 0)
  );
  IF EXISTS (
    SELECT 1 FROM public.account_deletion_auth_fences AS fence
    WHERE fence.user_id = p_user_id
      AND (
        (fence.state = 'prepared' AND fence.prepared_at + interval '15 minutes' > v_now)
        OR
        fence.state IN ('billing_pending','auth_ban_pending')
      )
  ) THEN
    RETURN 'busy';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_hard_deletion_fences AS hard_fence
    WHERE hard_fence.user_id=p_user_id AND (
      (hard_fence.state='claimed' AND hard_fence.lease_expires_at>v_now)
      OR hard_fence.state IN ('hard_delete_pending','completed')
    )
  ) THEN RETURN 'busy'; END IF;
  RETURN public.claim_account_recovery_admission_atomic(
    p_user_id,
    p_recovery_token_hash,
    p_operation_id
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.verify_pending_account_password_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_email text,
  p_password text
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s'
SET statement_timeout = '30s' SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_profile_email text;
  v_encrypted_password text;
  v_guard public.account_recovery_password_guards%ROWTYPE;
  v_auth_found boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_email IS NULL OR p_password IS NULL
    OR pg_catalog.octet_length(p_email) NOT BETWEEN 3 AND 320
    OR pg_catalog.octet_length(p_password) NOT BETWEEN 1 AND 72
  THEN RAISE EXCEPTION 'invalid recovery password verification input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  SELECT admission.* INTO v_admission FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_admission.user_id IS DISTINCT FROM p_user_id
    OR v_admission.state IS DISTINCT FROM 'claimed' OR v_admission.lease_expires_at<=v_now
    OR v_admission.recovery_token_hash IS NOT NULL THEN RETURN 'invalid'; END IF;
  SELECT profile.email INTO v_profile_email FROM public.user_profiles AS profile
  WHERE profile.id=p_user_id AND profile.deleted_at IS NOT NULL FOR UPDATE;
  IF NOT FOUND OR pg_catalog.lower(pg_catalog.btrim(v_profile_email))
    IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(p_email)) THEN RETURN 'invalid'; END IF;
  SELECT auth_user.encrypted_password INTO v_encrypted_password
  FROM auth.users AS auth_user WHERE auth_user.id=p_user_id;
  v_auth_found:=FOUND;
  SELECT guard.* INTO v_guard FROM public.account_recovery_password_guards AS guard
  WHERE guard.user_id=p_user_id FOR UPDATE;
  IF FOUND AND v_guard.locked_until>v_now THEN RETURN 'invalid'; END IF;
  IF NOT v_auth_found OR v_encrypted_password IS NULL
    OR pg_catalog.octet_length(v_encrypted_password)<>60
    OR v_encrypted_password !~ '^\$2a\$[0-9]{2}\$[./A-Za-z0-9]{53}$'
    OR pg_catalog.substring(v_encrypted_password,5,2)::integer NOT BETWEEN 4 AND 14
  THEN
    -- pgcrypto on the target PG17 runtime is proven to verify $2a$. Do not
    -- pretend an unproven bcrypt variant is a wrong password or count it
    -- toward the user's persistent brute-force lock.
    RETURN 'unavailable';
  END IF;
  IF extensions.crypt(p_password,v_encrypted_password) IS DISTINCT FROM v_encrypted_password
  THEN
    INSERT INTO public.account_recovery_password_guards(
      user_id,window_started_at,failure_count,locked_until,updated_at
    ) VALUES (p_user_id,v_now,1,NULL,v_now)
    ON CONFLICT(user_id) DO UPDATE SET
      window_started_at=CASE
        WHEN account_recovery_password_guards.window_started_at<=v_now-interval '15 minutes'
          THEN v_now ELSE account_recovery_password_guards.window_started_at END,
      failure_count=CASE
        WHEN account_recovery_password_guards.window_started_at<=v_now-interval '15 minutes'
          THEN 1 ELSE LEAST(5,account_recovery_password_guards.failure_count+1) END,
      locked_until=CASE
        WHEN account_recovery_password_guards.window_started_at>v_now-interval '15 minutes'
          AND account_recovery_password_guards.failure_count>=4
          THEN v_now+interval '15 minutes' ELSE NULL END,
      updated_at=v_now;
    RETURN 'invalid';
  END IF;
  DELETE FROM public.account_recovery_password_guards WHERE user_id=p_user_id;
  RETURN 'verified';
END
$function$;

CREATE OR REPLACE FUNCTION public.prepare_account_recovery_auth_finalization_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_capability_hash text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL
    OR p_capability_hash IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid recovery Auth preparation input' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account-recovery-admission:' || p_user_id::text, 0)
  );
  SELECT admission.* INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND OR v_admission.user_id IS DISTINCT FROM p_user_id THEN RETURN 'invalid'; END IF;
  IF v_admission.auth_finalization_state IS NOT NULL THEN
    IF v_admission.auth_finalization_capability_hash IS DISTINCT FROM p_capability_hash THEN
      RETURN 'invalid';
    END IF;
    RETURN CASE
      WHEN v_admission.auth_finalization_state = 'prepared' AND v_admission.state = 'claimed' THEN 'prepared'
      WHEN v_admission.state = 'finished' THEN 'finished'
      ELSE 'invalid'
    END;
  END IF;
  IF v_admission.state IS DISTINCT FROM 'claimed' OR v_admission.lease_expires_at <= v_now THEN
    RETURN 'invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_deletion_auth_fences AS fence
    WHERE fence.user_id = p_user_id
      AND fence.state IN ('billing_pending','auth_ban_pending')
  ) THEN RETURN 'busy'; END IF;
  UPDATE public.account_recovery_admissions
  SET auth_finalization_capability_hash = p_capability_hash,
      auth_finalization_state = 'prepared',
      auth_finalization_prepared_at = v_now,
      updated_at = GREATEST(updated_at, v_now)
  WHERE operation_id = p_operation_id
    AND user_id = p_user_id
    AND state = 'claimed'
    AND auth_finalization_state IS NULL;
  RETURN CASE WHEN FOUND THEN 'prepared' ELSE 'invalid' END;
END
$function$;

CREATE OR REPLACE FUNCTION public.resolve_account_recovery_capability_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_capability_hash text
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s'
SET statement_timeout = '30s' SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE v_admission public.account_recovery_admissions%ROWTYPE; v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid recovery capability resolution input' USING ERRCODE='22023'; END IF;
  SELECT admission.* INTO v_admission FROM public.account_recovery_admissions AS admission WHERE admission.operation_id=p_operation_id;
  IF NOT FOUND OR v_admission.user_id IS DISTINCT FROM p_user_id
    OR v_admission.auth_finalization_capability_hash IS DISTINCT FROM p_capability_hash
    OR v_admission.auth_finalization_state IS NULL
    OR v_admission.auth_finalization_state IN ('superseded','expired_manual')
    OR v_admission.auth_finalization_prepared_at+interval '30 days'<=v_now
  THEN RETURN 'invalid'; END IF;
  RETURN v_admission.auth_finalization_state;
END
$function$;

CREATE OR REPLACE FUNCTION public.finish_account_recovery_with_auth_finalization_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_capability_hash text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_finish_ack text;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL
    OR p_capability_hash IS NULL
    OR p_capability_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid recovery Auth finalization input' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account-recovery-admission:' || p_user_id::text, 0)
  );
  SELECT admission.* INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND OR v_admission.user_id IS DISTINCT FROM p_user_id THEN
    RETURN 'invalid';
  END IF;
  IF v_admission.auth_finalization_capability_hash IS DISTINCT FROM p_capability_hash THEN
    RETURN 'invalid';
  END IF;
  IF v_admission.auth_finalization_state NOT IN ('completed','superseded','expired_manual')
    AND v_admission.auth_finalization_prepared_at + interval '30 days' <= v_now
  THEN
    UPDATE public.account_recovery_admissions
    SET auth_finalization_state='expired_manual',
        auth_finalization_attempt_id=NULL,
        auth_finalization_attempt_expires_at=NULL,
        recovery_billing_resumed=NULL,
        recovery_billing_may_have_changed=COALESCE(recovery_billing_may_have_changed,false),
        updated_at=GREATEST(updated_at,v_now)
    WHERE operation_id=p_operation_id;
    RETURN 'invalid';
  END IF;
  IF v_admission.state = 'finished'
    AND v_admission.auth_finalization_state IN ('pending', 'claimed', 'auth_compensation_required', 'billing_pending', 'completed')
  THEN RETURN 'finished'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_deletion_auth_fences AS fence
    WHERE fence.user_id = p_user_id
      AND fence.state IN ('billing_pending','auth_ban_pending')
  ) THEN
    RETURN 'invalid';
  END IF;
  IF v_admission.state IS DISTINCT FROM 'claimed'
    OR v_admission.auth_finalization_state IS DISTINCT FROM 'prepared'
    OR v_admission.auth_finalization_prepared_at + interval '30 days' <= v_now
  THEN RETURN 'invalid'; END IF;

  v_finish_ack := public.finish_account_recovery_admission_atomic(
    p_user_id,
    p_operation_id
  );
  IF v_finish_ack IS DISTINCT FROM 'finished' THEN
    RETURN v_finish_ack;
  END IF;

  UPDATE public.account_recovery_admissions
  SET auth_finalization_state = 'pending',
      updated_at = GREATEST(updated_at, v_now)
  WHERE operation_id = p_operation_id
    AND user_id = p_user_id
    AND state = 'finished'
    AND auth_finalization_state = 'prepared'
    AND auth_finalization_capability_hash = p_capability_hash;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'recovery Auth finalization preparation was not exact'
      USING ERRCODE = '40001';
  END IF;
  RETURN 'finished';
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_account_recovery_auth_finalization_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_capability_hash text,
  p_attempt_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_deleted_at timestamptz;
  v_banned_at timestamptz;
  v_is_banned boolean;
  v_ban_expires_at timestamptz;
  v_profile_found boolean;
  v_security_conflict boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_attempt_id IS NULL
    OR p_capability_hash IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid recovery Auth claim input' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account-recovery-admission:' || p_user_id::text, 0)
  );
  SELECT admission.* INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_admission.user_id IS DISTINCT FROM p_user_id
    OR v_admission.state IS DISTINCT FROM 'finished'
    OR v_admission.auth_finalization_capability_hash IS DISTINCT FROM p_capability_hash
    OR v_admission.auth_finalization_state IS NULL
    OR v_admission.auth_finalization_state = 'superseded'
  THEN
    RETURN 'invalid';
  END IF;
  IF v_admission.auth_finalization_state NOT IN ('completed','superseded','expired_manual')
    AND v_admission.auth_finalization_prepared_at + interval '30 days' <= v_now
  THEN
    UPDATE public.account_recovery_admissions
    SET auth_finalization_state='expired_manual',
        auth_finalization_attempt_id=NULL,
        auth_finalization_attempt_expires_at=NULL,
        recovery_billing_resumed=NULL,
        recovery_billing_may_have_changed=COALESCE(recovery_billing_may_have_changed,false),
        updated_at=GREATEST(updated_at,v_now)
    WHERE operation_id=p_operation_id;
    RETURN 'invalid';
  END IF;
  IF v_admission.auth_finalization_state = 'auth_compensation_required' THEN
    IF v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
      AND v_admission.auth_finalization_attempt_expires_at > v_now
    THEN RETURN 'busy'; END IF;
    UPDATE public.account_recovery_admissions
    SET auth_finalization_attempt_id=p_attempt_id,
        auth_finalization_attempt_expires_at=v_now+interval '15 minutes',
        updated_at=GREATEST(updated_at,v_now)
    WHERE operation_id=p_operation_id
      AND auth_finalization_state='auth_compensation_required';
    RETURN CASE WHEN FOUND THEN
      CASE WHEN v_admission.recovery_billing_may_have_changed
        THEN 'compensation_billing' ELSE 'compensation_auth_only' END
      ELSE 'invalid' END;
  END IF;

  IF v_admission.auth_finalization_state = 'completed' THEN
    RETURN CASE WHEN v_admission.recovery_billing_resumed THEN 'completed_resumed' ELSE 'completed_manual' END;
  END IF;

  SELECT profile.deleted_at, profile.banned_at, profile.is_banned, profile.ban_expires_at
  INTO v_deleted_at, v_banned_at, v_is_banned, v_ban_expires_at
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  v_profile_found := FOUND;
  v_security_conflict := NOT v_profile_found
    OR v_deleted_at IS NOT NULL
    OR v_banned_at IS NOT NULL
    OR COALESCE(v_is_banned, false)
    OR (v_ban_expires_at IS NOT NULL AND v_ban_expires_at > v_now)
    OR EXISTS (
    SELECT 1 FROM public.account_deletion_auth_fences AS fence
    WHERE fence.user_id = p_user_id
      AND (
        (fence.state='prepared' AND fence.prepared_at+interval '15 minutes'>v_now)
        OR fence.state IN ('billing_pending','auth_ban_pending')
      )
  );
  IF v_security_conflict THEN
    IF v_admission.auth_finalization_state='billing_pending' THEN
      IF v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
        AND v_admission.auth_finalization_attempt_expires_at > v_now
      THEN RETURN 'busy'; END IF;
      UPDATE public.account_recovery_admissions
      SET auth_finalization_state='auth_compensation_required',
          auth_finalized_at=NULL,
          recovery_billing_may_have_changed=true,
          auth_finalization_attempt_id=p_attempt_id,
          auth_finalization_attempt_expires_at=v_now+interval '15 minutes',
          updated_at=GREATEST(updated_at,v_now)
      WHERE operation_id=p_operation_id AND auth_finalization_state='billing_pending';
      RETURN CASE WHEN FOUND THEN 'compensation_billing' ELSE 'invalid' END;
    END IF;
    IF v_admission.auth_finalization_state='claimed' THEN
      IF v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
        AND v_admission.auth_finalization_attempt_expires_at > v_now
      THEN RETURN 'busy'; END IF;
      UPDATE public.account_recovery_admissions
      SET auth_finalization_state='auth_compensation_required',
          recovery_billing_may_have_changed=false,
          auth_finalization_attempt_id=p_attempt_id,
          auth_finalization_attempt_expires_at=v_now+interval '15 minutes',
          updated_at=GREATEST(updated_at,v_now)
      WHERE operation_id=p_operation_id AND auth_finalization_state='claimed';
      RETURN CASE WHEN FOUND THEN 'compensation_auth_only' ELSE 'invalid' END;
    END IF;
    RETURN 'invalid';
  END IF;
  IF v_admission.auth_finalization_state = 'billing_pending'
    AND v_admission.auth_finalization_attempt_id = p_attempt_id
    AND v_admission.auth_finalization_attempt_expires_at > v_now
  THEN RETURN 'billing_pending'; END IF;
  IF v_admission.auth_finalization_state = 'billing_pending'
    AND v_admission.auth_finalization_attempt_expires_at > v_now
  THEN RETURN 'busy'; END IF;
  IF v_admission.auth_finalization_state = 'billing_pending' THEN
    UPDATE public.account_recovery_admissions
    SET auth_finalization_attempt_id = p_attempt_id,
        auth_finalization_attempt_expires_at = v_now + interval '15 minutes',
        updated_at = GREATEST(updated_at, v_now)
    WHERE operation_id = p_operation_id
      AND auth_finalization_state = 'billing_pending';
    RETURN CASE WHEN FOUND THEN 'billing_pending' ELSE 'invalid' END;
  END IF;

  IF v_admission.auth_finalization_state = 'claimed'
    AND v_admission.auth_finalization_attempt_id = p_attempt_id
    AND v_admission.auth_finalization_attempt_expires_at > v_now
  THEN
    RETURN 'claimed';
  END IF;
  IF v_admission.auth_finalization_state = 'claimed'
    AND v_admission.auth_finalization_attempt_expires_at > v_now
  THEN
    RETURN 'busy';
  END IF;

  -- Once a claimed Auth call's lease expires, its transport acknowledgement is
  -- unknowable. Re-ban before allowing any new unban attempt.
  IF v_admission.auth_finalization_state = 'claimed' THEN
    UPDATE public.account_recovery_admissions
    SET auth_finalization_state='auth_compensation_required',
        recovery_billing_may_have_changed=false,
        auth_finalization_attempt_id=p_attempt_id,
        auth_finalization_attempt_expires_at=v_now+interval '15 minutes',
        updated_at=GREATEST(updated_at,v_now)
    WHERE operation_id=p_operation_id AND auth_finalization_state='claimed';
    RETURN CASE WHEN FOUND THEN 'compensation_auth_only' ELSE 'invalid' END;
  END IF;

  UPDATE public.account_recovery_admissions
  SET auth_finalization_state = 'claimed',
      auth_finalization_attempt_id = p_attempt_id,
      auth_finalization_attempt_expires_at = v_now + interval '15 minutes',
      updated_at = GREATEST(updated_at, v_now)
  WHERE operation_id = p_operation_id
    AND auth_finalization_state = 'pending';
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  RETURN 'claimed';
END
$function$;

CREATE OR REPLACE FUNCTION public.finalize_account_recovery_auth_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_capability_hash text,
  p_attempt_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_profile public.user_profiles%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_attempt_id IS NULL
    OR p_capability_hash IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid recovery Auth finalize input' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account-recovery-admission:' || p_user_id::text, 0)
  );
  SELECT admission.* INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND OR v_admission.user_id IS DISTINCT FROM p_user_id
    OR v_admission.state IS DISTINCT FROM 'finished'
    OR v_admission.auth_finalization_capability_hash IS DISTINCT FROM p_capability_hash
  THEN RETURN 'invalid'; END IF;
  IF v_admission.auth_finalization_state NOT IN ('completed','superseded','expired_manual')
    AND v_admission.auth_finalization_prepared_at+interval '30 days'<=v_now
  THEN
    UPDATE public.account_recovery_admissions SET auth_finalization_state='expired_manual',
      auth_finalization_attempt_id=NULL,auth_finalization_attempt_expires_at=NULL,
      recovery_billing_resumed=NULL,
      recovery_billing_may_have_changed=COALESCE(recovery_billing_may_have_changed,false),
      updated_at=GREATEST(updated_at,v_now)
    WHERE operation_id=p_operation_id;
    RETURN 'invalid';
  END IF;
  SELECT profile.* INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_profile.deleted_at IS NOT NULL OR v_profile.banned_at IS NOT NULL
    OR COALESCE(v_profile.is_banned, false)
    OR (v_profile.ban_expires_at IS NOT NULL AND v_profile.ban_expires_at > v_now)
  THEN
    IF v_admission.auth_finalization_state='claimed'
      AND v_admission.auth_finalization_attempt_id=p_attempt_id
    THEN
      UPDATE public.account_recovery_admissions
      SET auth_finalization_state='auth_compensation_required',
          recovery_billing_may_have_changed=false,
          auth_finalization_attempt_expires_at=v_now+interval '15 minutes',
          updated_at=GREATEST(updated_at,v_now)
      WHERE operation_id=p_operation_id AND auth_finalization_state='claimed'
        AND auth_finalization_attempt_id=p_attempt_id;
      RETURN CASE WHEN FOUND THEN 'compensation_auth_only' ELSE 'invalid' END;
    END IF;
    RETURN 'invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_deletion_auth_fences AS fence
    WHERE fence.user_id = p_user_id
      AND (
        (fence.state='prepared' AND fence.prepared_at+interval '15 minutes'>v_now)
        OR fence.state IN ('billing_pending','auth_ban_pending')
      )
  ) THEN
    IF v_admission.auth_finalization_state='claimed'
      AND v_admission.auth_finalization_attempt_id=p_attempt_id
    THEN
      UPDATE public.account_recovery_admissions
      SET auth_finalization_state='auth_compensation_required',
          recovery_billing_may_have_changed=false,
          auth_finalization_attempt_expires_at=v_now+interval '15 minutes',
          updated_at=GREATEST(updated_at,v_now)
      WHERE operation_id=p_operation_id AND auth_finalization_state='claimed'
        AND auth_finalization_attempt_id=p_attempt_id;
      RETURN CASE WHEN FOUND THEN 'compensation_auth_only' ELSE 'invalid' END;
    END IF;
    RETURN 'invalid';
  END IF;
  IF v_admission.auth_finalization_state IN ('billing_pending','completed') THEN RETURN 'already_finalized'; END IF;
  IF v_admission.auth_finalization_state IS DISTINCT FROM 'claimed'
    OR v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
  THEN RETURN 'invalid'; END IF;

  UPDATE public.account_recovery_admissions
  SET auth_finalization_state = 'billing_pending',
      auth_finalization_attempt_expires_at = v_now + interval '15 minutes',
      auth_finalized_at = v_now,
      recovery_billing_may_have_changed = false,
      updated_at = GREATEST(updated_at, v_now)
  WHERE operation_id = p_operation_id
    AND auth_finalization_state = 'claimed'
    AND auth_finalization_attempt_id = p_attempt_id;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  RETURN 'finalized';
END
$function$;

CREATE OR REPLACE FUNCTION public.require_account_recovery_auth_compensation_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_capability_hash text,
  p_attempt_id uuid
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s'
SET statement_timeout = '30s' SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE v_admission public.account_recovery_admissions%ROWTYPE; v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_attempt_id IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid recovery Auth compensation requirement input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  SELECT admission.* INTO v_admission FROM public.account_recovery_admissions AS admission WHERE admission.operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_admission.user_id IS DISTINCT FROM p_user_id
    OR v_admission.auth_finalization_capability_hash IS DISTINCT FROM p_capability_hash
  THEN RETURN 'invalid'; END IF;
  IF v_admission.auth_finalization_state NOT IN ('completed','superseded','expired_manual')
    AND v_admission.auth_finalization_prepared_at+interval '30 days'<=v_now
  THEN
    UPDATE public.account_recovery_admissions SET auth_finalization_state='expired_manual',
      auth_finalization_attempt_id=NULL,auth_finalization_attempt_expires_at=NULL,
      recovery_billing_resumed=NULL,
      recovery_billing_may_have_changed=COALESCE(recovery_billing_may_have_changed,false),
      updated_at=GREATEST(updated_at,v_now) WHERE operation_id=p_operation_id;
    RETURN 'invalid';
  END IF;
  IF v_admission.auth_finalization_state='auth_compensation_required' THEN
    IF v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
      AND v_admission.auth_finalization_attempt_expires_at>v_now
    THEN RETURN 'busy'; END IF;
    UPDATE public.account_recovery_admissions SET
      auth_finalization_attempt_id=p_attempt_id,
      auth_finalization_attempt_expires_at=v_now+interval '15 minutes',
      updated_at=GREATEST(updated_at,v_now)
    WHERE operation_id=p_operation_id AND auth_finalization_state='auth_compensation_required';
    RETURN CASE WHEN FOUND THEN
      CASE WHEN v_admission.recovery_billing_may_have_changed
        THEN 'compensation_billing' ELSE 'compensation_auth_only' END
      ELSE 'busy' END;
  END IF;
  IF v_admission.auth_finalization_state IS DISTINCT FROM 'claimed'
    OR v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
  THEN RETURN 'busy'; END IF;
  UPDATE public.account_recovery_admissions SET auth_finalization_state='auth_compensation_required',
    recovery_billing_may_have_changed=false,
    auth_finalization_attempt_expires_at=v_now+interval '15 minutes',updated_at=GREATEST(updated_at,v_now)
  WHERE operation_id=p_operation_id AND auth_finalization_state='claimed'
    AND auth_finalization_attempt_id=p_attempt_id;
  RETURN CASE WHEN FOUND THEN 'compensation_auth_only' ELSE 'busy' END;
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_account_recovery_auth_compensation_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_capability_hash text,
  p_attempt_id uuid
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s'
SET statement_timeout = '30s' SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE v_admission public.account_recovery_admissions%ROWTYPE; v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_attempt_id IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid recovery Auth compensation input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  SELECT admission.* INTO v_admission FROM public.account_recovery_admissions AS admission WHERE admission.operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_admission.user_id IS DISTINCT FROM p_user_id
    OR v_admission.auth_finalization_capability_hash IS DISTINCT FROM p_capability_hash
    OR v_admission.auth_finalization_state IS DISTINCT FROM 'auth_compensation_required'
    OR v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
  THEN RETURN 'invalid'; END IF;
  IF v_admission.auth_finalization_prepared_at+interval '30 days'<=v_now THEN
    UPDATE public.account_recovery_admissions SET auth_finalization_state='expired_manual',
      auth_finalization_attempt_id=NULL,auth_finalization_attempt_expires_at=NULL,
      recovery_billing_resumed=NULL,
      recovery_billing_may_have_changed=COALESCE(recovery_billing_may_have_changed,false),
      updated_at=GREATEST(updated_at,v_now) WHERE operation_id=p_operation_id;
    RETURN 'invalid';
  END IF;
  UPDATE public.account_recovery_admissions SET auth_finalization_state='pending',
    auth_finalization_attempt_id=NULL,auth_finalization_attempt_expires_at=NULL,
    recovery_billing_may_have_changed=NULL,
    updated_at=GREATEST(updated_at,v_now)
  WHERE operation_id=p_operation_id AND auth_finalization_state='auth_compensation_required'
    AND auth_finalization_attempt_id=p_attempt_id;
  RETURN CASE WHEN FOUND THEN 'compensated' ELSE 'invalid' END;
END
$function$;

CREATE OR REPLACE FUNCTION public.arm_account_recovery_billing_atomic(
  p_user_id uuid,p_operation_id uuid,p_capability_hash text,p_attempt_id uuid
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path=pg_catalog,pg_temp SET lock_timeout='5s' SET statement_timeout='30s'
SET idle_in_transaction_session_timeout='30s' SET row_security=off
AS $function$
DECLARE v_admission public.account_recovery_admissions%ROWTYPE; v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()),'') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_attempt_id IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid recovery billing arm input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  SELECT admission.* INTO v_admission FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_admission.user_id IS DISTINCT FROM p_user_id
    OR v_admission.auth_finalization_capability_hash IS DISTINCT FROM p_capability_hash
  THEN RETURN 'invalid'; END IF;
  IF v_admission.auth_finalization_state NOT IN ('completed','superseded','expired_manual')
    AND v_admission.auth_finalization_prepared_at+interval '30 days'<=v_now
  THEN
    UPDATE public.account_recovery_admissions SET auth_finalization_state='expired_manual',
      auth_finalization_attempt_id=NULL,auth_finalization_attempt_expires_at=NULL,
      recovery_billing_resumed=NULL,
      recovery_billing_may_have_changed=COALESCE(recovery_billing_may_have_changed,false),
      updated_at=GREATEST(updated_at,v_now)
    WHERE operation_id=p_operation_id;
    RETURN 'invalid';
  END IF;
  UPDATE public.account_recovery_admissions SET recovery_billing_may_have_changed=true,
    updated_at=GREATEST(updated_at,v_now)
  WHERE operation_id=p_operation_id AND user_id=p_user_id
    AND auth_finalization_capability_hash=p_capability_hash
    AND auth_finalization_state='billing_pending' AND auth_finalization_attempt_id=p_attempt_id;
  RETURN CASE WHEN FOUND THEN 'armed' ELSE 'invalid' END;
END
$function$;

CREATE OR REPLACE FUNCTION public.resolve_account_recovery_compensation_scope_atomic(
  p_user_id uuid,p_operation_id uuid,p_capability_hash text,p_attempt_id uuid
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path=pg_catalog,pg_temp SET lock_timeout='5s' SET statement_timeout='30s'
SET idle_in_transaction_session_timeout='30s' SET row_security=off
AS $function$
DECLARE
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()),'') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_attempt_id IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid recovery compensation scope input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  SELECT admission.* INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id=p_operation_id AND admission.user_id=p_user_id
    AND admission.auth_finalization_capability_hash=p_capability_hash
    AND admission.auth_finalization_state='auth_compensation_required'
    AND admission.auth_finalization_attempt_id=p_attempt_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  IF v_admission.auth_finalization_prepared_at+interval '30 days'<=v_now THEN
    UPDATE public.account_recovery_admissions
    SET auth_finalization_state='expired_manual',auth_finalization_attempt_id=NULL,
        auth_finalization_attempt_expires_at=NULL,recovery_billing_resumed=NULL,
        recovery_billing_may_have_changed=COALESCE(recovery_billing_may_have_changed,false),
        updated_at=GREATEST(updated_at,v_now)
    WHERE operation_id=p_operation_id
      AND auth_finalization_state='auth_compensation_required'
      AND auth_finalization_attempt_id=p_attempt_id;
    RETURN 'invalid';
  END IF;
  RETURN CASE WHEN v_admission.recovery_billing_may_have_changed
    THEN 'billing_stop_required' ELSE 'auth_only' END;
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_account_recovery_billing_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_capability_hash text,
  p_attempt_id uuid,
  p_subscription_resumed boolean
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s'
SET statement_timeout = '30s' SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_profile public.user_profiles%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_attempt_id IS NULL
    OR p_subscription_resumed IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'invalid recovery billing completion input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  SELECT admission.* INTO v_admission FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR v_admission.user_id IS DISTINCT FROM p_user_id OR v_admission.auth_finalization_capability_hash IS DISTINCT FROM p_capability_hash THEN RETURN 'invalid'; END IF;
  IF v_admission.auth_finalization_state NOT IN ('completed','superseded','expired_manual')
    AND v_admission.auth_finalization_prepared_at+interval '30 days'<=v_now
  THEN
    UPDATE public.account_recovery_admissions SET auth_finalization_state='expired_manual',
      auth_finalization_attempt_id=NULL,auth_finalization_attempt_expires_at=NULL,
      recovery_billing_resumed=NULL,
      recovery_billing_may_have_changed=COALESCE(recovery_billing_may_have_changed,false),
      updated_at=GREATEST(updated_at,v_now) WHERE operation_id=p_operation_id;
    RETURN 'invalid';
  END IF;
  SELECT profile.* INTO v_profile FROM public.user_profiles AS profile WHERE profile.id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  IF v_profile.deleted_at IS NOT NULL OR v_profile.banned_at IS NOT NULL
    OR COALESCE(v_profile.is_banned,false)
    OR (v_profile.ban_expires_at IS NOT NULL AND v_profile.ban_expires_at>v_now)
    OR EXISTS (
      SELECT 1 FROM public.account_deletion_auth_fences AS fence
      WHERE fence.user_id=p_user_id AND (
        (fence.state='prepared' AND fence.prepared_at+interval '15 minutes'>v_now)
        OR fence.state IN ('billing_pending','auth_ban_pending')
      )
    )
  THEN
    UPDATE public.account_recovery_admissions
    SET auth_finalization_state='auth_compensation_required',
        auth_finalized_at=NULL,
        recovery_billing_may_have_changed=true,
        auth_finalization_attempt_expires_at=v_now+interval '15 minutes',
        updated_at=GREATEST(updated_at,v_now)
    WHERE operation_id=p_operation_id AND auth_finalization_state='billing_pending'
      AND auth_finalization_attempt_id=p_attempt_id;
    RETURN CASE WHEN FOUND THEN 'compensation_billing' ELSE 'invalid' END;
  END IF;
  IF v_admission.auth_finalization_state='completed' THEN
    RETURN CASE WHEN v_admission.recovery_billing_resumed THEN 'completed_resumed' ELSE 'completed_manual' END;
  END IF;
  IF v_admission.auth_finalization_state IS DISTINCT FROM 'billing_pending'
    OR v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
  THEN RETURN 'invalid'; END IF;
  UPDATE public.account_recovery_admissions
  SET auth_finalization_state='completed', auth_finalization_attempt_id=NULL,
      auth_finalization_attempt_expires_at=NULL,
      recovery_billing_resumed=p_subscription_resumed,
      recovery_billing_may_have_changed=NULL,
      updated_at=GREATEST(updated_at,v_now)
  WHERE operation_id=p_operation_id AND auth_finalization_state='billing_pending'
    AND auth_finalization_attempt_id=p_attempt_id;
  RETURN CASE WHEN FOUND THEN
    CASE WHEN p_subscription_resumed THEN 'completed_resumed' ELSE 'completed_manual' END
    ELSE 'invalid' END;
END
$function$;

CREATE OR REPLACE FUNCTION public.release_account_recovery_auth_finalization_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_capability_hash text,
  p_attempt_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_attempt_id IS NULL
    OR p_capability_hash IS NULL OR p_capability_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid recovery Auth release input' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account-recovery-admission:' || p_user_id::text, 0)
  );
  SELECT admission.* INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND OR v_admission.user_id IS DISTINCT FROM p_user_id
    OR v_admission.auth_finalization_capability_hash IS DISTINCT FROM p_capability_hash
  THEN RETURN 'invalid'; END IF;
  IF v_admission.auth_finalization_state NOT IN ('completed','superseded','expired_manual')
    AND v_admission.auth_finalization_prepared_at+interval '30 days'<=v_now
  THEN
    UPDATE public.account_recovery_admissions
    SET auth_finalization_state='expired_manual',auth_finalization_attempt_id=NULL,
        auth_finalization_attempt_expires_at=NULL,recovery_billing_resumed=NULL,
        recovery_billing_may_have_changed=COALESCE(recovery_billing_may_have_changed,false),
        updated_at=GREATEST(updated_at,v_now)
    WHERE operation_id=p_operation_id;
    RETURN 'invalid';
  END IF;
  IF v_admission.auth_finalization_state IN ('billing_pending','completed') THEN RETURN 'already_finalized'; END IF;
  IF v_admission.auth_finalization_state = 'superseded' THEN RETURN 'invalid'; END IF;
  IF v_admission.auth_finalization_state = 'pending' THEN RETURN 'released'; END IF;
  IF v_admission.auth_finalization_state = 'claimed'
    AND v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
  THEN RETURN 'busy'; END IF;
  UPDATE public.account_recovery_admissions
  SET auth_finalization_state = 'pending',
      auth_finalization_attempt_id = NULL,
      auth_finalization_attempt_expires_at = NULL,
      updated_at = GREATEST(updated_at, v_now)
  WHERE operation_id = p_operation_id
    AND auth_finalization_state = 'claimed'
    AND auth_finalization_attempt_id = p_attempt_id;
  RETURN CASE WHEN FOUND THEN 'released' ELSE 'invalid' END;
END
$function$;

CREATE OR REPLACE FUNCTION public.prepare_account_deletion_auth_fence_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_recovery_token_hash text,
  p_reason text
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s'
SET statement_timeout = '30s' SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE
  v_fence public.account_deletion_auth_fences%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_deleted_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_recovery_token_hash !~ '^[0-9a-f]{64}$'
    OR p_reason IS NULL OR pg_catalog.octet_length(p_reason)>256
  THEN RAISE EXCEPTION 'invalid deletion preparation input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  SELECT * INTO v_fence FROM public.account_deletion_auth_fences WHERE user_id=p_user_id FOR UPDATE;
  IF FOUND AND v_fence.operation_id = p_operation_id AND v_fence.recovery_token_hash = p_recovery_token_hash THEN
    RETURN CASE WHEN v_fence.state IN ('prepared','billing_pending','auth_ban_pending','completed') THEN v_fence.state ELSE 'invalid' END;
  END IF;
  IF FOUND AND v_fence.state IN ('billing_pending','auth_ban_pending','expired_manual') THEN RETURN 'busy'; END IF;
  SELECT profile.deleted_at INTO v_deleted_at FROM public.user_profiles AS profile WHERE profile.id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_deleted_at IS NOT NULL THEN RETURN 'invalid'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_recovery_admissions AS admission
    WHERE admission.user_id=p_user_id AND (
      (admission.state='claimed' AND admission.lease_expires_at>v_now)
      OR admission.auth_finalization_state IN ('pending','claimed','auth_compensation_required','billing_pending')
    )
  ) THEN RETURN 'busy'; END IF;
  UPDATE public.account_recovery_admissions
  SET auth_finalization_state='superseded', auth_finalization_attempt_id=NULL,
      auth_finalization_attempt_expires_at=NULL, auth_finalized_at=NULL,
      recovery_billing_resumed=NULL, recovery_billing_may_have_changed=NULL,
      updated_at=GREATEST(updated_at,v_now)
  WHERE user_id=p_user_id AND auth_finalization_state IN ('prepared','completed','expired_manual');
  INSERT INTO public.account_deletion_auth_fences(
    user_id,operation_id,worker_attempt_id,recovery_token_hash,reason,state,prepared_at,updated_at
  ) VALUES (p_user_id,p_operation_id,NULL,p_recovery_token_hash,p_reason,'prepared',v_now,v_now)
  ON CONFLICT(user_id) DO UPDATE SET
    operation_id=EXCLUDED.operation_id,worker_attempt_id=NULL,
    recovery_token_hash=EXCLUDED.recovery_token_hash,reason=EXCLUDED.reason,
    state='prepared',prepared_at=EXCLUDED.prepared_at,claimed_at=NULL,lease_expires_at=NULL,
    schedule_ack=NULL,completed_at=NULL,released_at=NULL,updated_at=EXCLUDED.updated_at;
  RETURN 'prepared';
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_account_deletion_auth_fence_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_worker_attempt_id uuid,
  p_recovery_token_hash text
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s'
SET statement_timeout = '30s' SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE v_fence public.account_deletion_auth_fences%ROWTYPE; v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_worker_attempt_id IS NULL OR p_recovery_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid deletion claim input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  SELECT * INTO v_fence FROM public.account_deletion_auth_fences WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_fence.operation_id IS DISTINCT FROM p_operation_id OR v_fence.recovery_token_hash IS DISTINCT FROM p_recovery_token_hash THEN RETURN 'invalid'; END IF;
  IF v_fence.state IN ('billing_pending','auth_ban_pending')
    AND v_fence.prepared_at+interval '31 days'<=v_now
  THEN
    UPDATE public.account_deletion_auth_fences SET state='expired_manual',
      worker_attempt_id=NULL,lease_expires_at=NULL,updated_at=v_now
    WHERE user_id=p_user_id;
    RETURN 'invalid';
  END IF;
  IF v_fence.state='completed' THEN RETURN 'completed'; END IF;
  IF v_fence.state IN ('released','expired_manual')
    OR (v_fence.state='prepared' AND v_fence.prepared_at + interval '15 minutes' <= v_now)
  THEN RETURN 'invalid'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_recovery_admissions AS admission
    WHERE admission.user_id=p_user_id AND (
      (admission.state='claimed' AND admission.lease_expires_at>v_now)
      OR admission.auth_finalization_state IN ('pending','claimed','auth_compensation_required','billing_pending')
    )
  ) THEN RETURN 'busy'; END IF;
  IF v_fence.state IN ('billing_pending','auth_ban_pending')
    AND v_fence.worker_attempt_id IS DISTINCT FROM p_worker_attempt_id
    AND v_fence.lease_expires_at>v_now
  THEN RETURN 'busy'; END IF;
  UPDATE public.account_deletion_auth_fences SET
    state=CASE WHEN state='prepared' THEN 'billing_pending' ELSE state END,
    worker_attempt_id=p_worker_attempt_id,
    claimed_at=CASE WHEN state='prepared' THEN v_now ELSE claimed_at END,
    lease_expires_at=v_now+interval '15 minutes',updated_at=v_now
  WHERE user_id=p_user_id AND operation_id=p_operation_id
    AND state IN ('prepared','billing_pending','auth_ban_pending');
  RETURN CASE WHEN FOUND THEN
    CASE WHEN v_fence.state='auth_ban_pending' THEN 'auth_ban_pending' ELSE 'billing_pending' END
    ELSE 'invalid' END;
END
$function$;

CREATE OR REPLACE FUNCTION public.resolve_account_deletion_capability_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_recovery_token_hash text
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s'
SET statement_timeout = '30s' SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE v_fence public.account_deletion_auth_fences%ROWTYPE; v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_recovery_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid deletion capability resolution input' USING ERRCODE='22023'; END IF;
  SELECT fence.* INTO v_fence FROM public.account_deletion_auth_fences AS fence WHERE fence.user_id=p_user_id;
  IF NOT FOUND OR v_fence.operation_id IS DISTINCT FROM p_operation_id
    OR v_fence.recovery_token_hash IS DISTINCT FROM p_recovery_token_hash
    OR v_fence.state IN ('released','expired_manual')
    OR (v_fence.state='prepared' AND v_fence.prepared_at+interval '15 minutes'<=v_now)
    OR (v_fence.state IN ('billing_pending','auth_ban_pending') AND v_fence.prepared_at+interval '31 days'<=v_now)
  THEN RETURN 'invalid'; END IF;
  RETURN v_fence.state;
END
$function$;

CREATE OR REPLACE FUNCTION public.schedule_account_deletion_with_billing_blocks_fenced(
  p_user_id uuid,
  p_operation_id uuid,
  p_worker_attempt_id uuid,
  p_fence_token_hash text,
  p_scheduled_at timestamptz,
  p_recovery_token_hash text,
  p_stripe_customer_id text,
  p_stripe_subscription_ids text[]
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s'
SET statement_timeout = '30s' SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE v_fence public.account_deletion_auth_fences%ROWTYPE; v_ack jsonb; v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_operation_id IS NULL OR p_worker_attempt_id IS NULL OR p_fence_token_hash !~ '^[0-9a-f]{64}$'
    OR p_recovery_token_hash IS DISTINCT FROM p_fence_token_hash THEN RAISE EXCEPTION 'invalid fenced deletion schedule input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  SELECT * INTO v_fence FROM public.account_deletion_auth_fences WHERE user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_fence.operation_id IS DISTINCT FROM p_operation_id OR v_fence.recovery_token_hash IS DISTINCT FROM p_fence_token_hash THEN RETURN NULL; END IF;
  IF v_fence.state IN ('billing_pending','auth_ban_pending')
    AND v_fence.prepared_at+interval '31 days'<=v_now
  THEN
    UPDATE public.account_deletion_auth_fences SET state='expired_manual',
      worker_attempt_id=NULL,lease_expires_at=NULL,updated_at=v_now
    WHERE user_id=p_user_id;
    RETURN NULL;
  END IF;
  IF v_fence.state='completed' THEN RETURN v_fence.schedule_ack; END IF;
  IF v_fence.state='auth_ban_pending' AND v_fence.worker_attempt_id=p_worker_attempt_id
    AND v_fence.lease_expires_at>v_now THEN RETURN v_fence.schedule_ack; END IF;
  IF v_fence.state IS DISTINCT FROM 'billing_pending' OR v_fence.worker_attempt_id IS DISTINCT FROM p_worker_attempt_id
    OR v_fence.lease_expires_at<=v_now THEN RETURN NULL; END IF;
  v_ack:=public.schedule_account_deletion_with_billing_blocks(
    p_user_id,v_fence.reason,p_scheduled_at,p_recovery_token_hash,p_stripe_customer_id,p_stripe_subscription_ids
  );
  UPDATE public.account_deletion_auth_fences SET state='auth_ban_pending',schedule_ack=v_ack,updated_at=v_now
  WHERE user_id=p_user_id AND operation_id=p_operation_id AND worker_attempt_id=p_worker_attempt_id AND state='billing_pending';
  IF NOT FOUND THEN RAISE EXCEPTION 'fenced deletion schedule transition was not exact' USING ERRCODE='40001'; END IF;
  RETURN v_ack;
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_account_deletion_auth_fence_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_worker_attempt_id uuid,
  p_recovery_token_hash text
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s'
SET statement_timeout = '30s' SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE v_fence public.account_deletion_auth_fences%ROWTYPE; v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
 IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_user_id IS NULL OR p_operation_id IS NULL OR p_worker_attempt_id IS NULL OR p_recovery_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid deletion fence completion input' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
 SELECT * INTO v_fence FROM public.account_deletion_auth_fences WHERE user_id=p_user_id FOR UPDATE;
 IF NOT FOUND OR v_fence.operation_id IS DISTINCT FROM p_operation_id OR v_fence.recovery_token_hash IS DISTINCT FROM p_recovery_token_hash THEN RETURN 'invalid'; END IF;
 IF v_fence.state='auth_ban_pending' AND v_fence.prepared_at+interval '31 days'<=v_now THEN
   UPDATE public.account_deletion_auth_fences SET state='expired_manual',worker_attempt_id=NULL,
     lease_expires_at=NULL,updated_at=v_now WHERE user_id=p_user_id;
   RETURN 'invalid';
 END IF;
 IF v_fence.state='completed' THEN RETURN 'completed'; END IF;
 IF v_fence.state IS DISTINCT FROM 'auth_ban_pending' OR v_fence.worker_attempt_id IS DISTINCT FROM p_worker_attempt_id OR v_fence.lease_expires_at<=v_now THEN RETURN 'invalid'; END IF;
 UPDATE public.account_deletion_auth_fences SET state='completed',worker_attempt_id=NULL,lease_expires_at=NULL,completed_at=v_now,updated_at=v_now WHERE user_id=p_user_id AND operation_id=p_operation_id AND worker_attempt_id=p_worker_attempt_id AND state='auth_ban_pending';
 RETURN CASE WHEN FOUND THEN 'completed' ELSE 'invalid' END;
END
$function$;

CREATE OR REPLACE FUNCTION public.release_account_deletion_auth_fence_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_worker_attempt_id uuid,
  p_recovery_token_hash text
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s'
SET statement_timeout = '30s' SET idle_in_transaction_session_timeout = '30s'
SET row_security = off
AS $function$
DECLARE v_fence public.account_deletion_auth_fences%ROWTYPE; v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
 IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
 IF p_user_id IS NULL OR p_operation_id IS NULL OR p_worker_attempt_id IS NULL OR p_recovery_token_hash !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'invalid deletion fence release input' USING ERRCODE='22023'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
 SELECT * INTO v_fence FROM public.account_deletion_auth_fences WHERE user_id=p_user_id FOR UPDATE;
 IF NOT FOUND OR v_fence.operation_id IS DISTINCT FROM p_operation_id OR v_fence.recovery_token_hash IS DISTINCT FROM p_recovery_token_hash THEN RETURN 'invalid'; END IF;
 IF v_fence.state IN ('billing_pending','auth_ban_pending')
   AND v_fence.prepared_at+interval '31 days'<=v_now
 THEN
   UPDATE public.account_deletion_auth_fences
   SET state='expired_manual',worker_attempt_id=NULL,lease_expires_at=NULL,updated_at=v_now
   WHERE user_id=p_user_id;
   RETURN 'invalid';
 END IF;
 IF v_fence.state='prepared' AND v_fence.prepared_at+interval '15 minutes'<=v_now THEN
   UPDATE public.account_deletion_auth_fences
   SET state='released',released_at=v_now,updated_at=v_now
   WHERE user_id=p_user_id AND state='prepared';
   RETURN 'invalid';
 END IF;
 IF v_fence.state='released' THEN RETURN 'released'; END IF;
 IF v_fence.state IN ('billing_pending','auth_ban_pending','completed','expired_manual') THEN RETURN v_fence.state; END IF;
 UPDATE public.account_deletion_auth_fences SET state='released',worker_attempt_id=NULL,lease_expires_at=NULL,released_at=v_now,updated_at=v_now WHERE user_id=p_user_id AND operation_id=p_operation_id AND state='prepared';
 RETURN CASE WHEN FOUND THEN 'released' ELSE 'invalid' END;
END
$function$;

CREATE OR REPLACE FUNCTION public.claim_account_hard_deletion_atomic(
  p_user_id uuid,
  p_worker_attempt_id uuid
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path=pg_catalog,pg_temp SET lock_timeout='5s' SET statement_timeout='30s'
SET idle_in_transaction_session_timeout='30s' SET row_security=off
AS $function$
DECLARE
  v_fence public.account_hard_deletion_fences%ROWTYPE;
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_deleted_at timestamptz;
  v_scheduled_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()),'') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_worker_attempt_id IS NULL THEN RAISE EXCEPTION 'invalid hard deletion claim input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  SELECT fence.* INTO v_fence FROM public.account_hard_deletion_fences AS fence WHERE fence.user_id=p_user_id FOR UPDATE;
  IF FOUND THEN
    IF v_fence.state='completed' THEN RETURN 'completed'; END IF;
    IF v_fence.state='hard_delete_pending' THEN
      IF v_fence.worker_attempt_id IS DISTINCT FROM p_worker_attempt_id AND v_fence.lease_expires_at>v_now THEN RETURN 'busy'; END IF;
      UPDATE public.account_hard_deletion_fences SET worker_attempt_id=p_worker_attempt_id,
        lease_expires_at=v_now+interval '15 minutes',updated_at=v_now
      WHERE user_id=p_user_id AND state='hard_delete_pending';
      RETURN CASE WHEN FOUND THEN 'hard_delete_pending' ELSE 'invalid' END;
    END IF;
    IF v_fence.state='claimed' AND v_fence.lease_expires_at>v_now THEN
      RETURN CASE WHEN v_fence.worker_attempt_id=p_worker_attempt_id THEN 'claimed' ELSE 'busy' END;
    END IF;
  END IF;
  SELECT profile.deleted_at,profile.deletion_scheduled_at INTO v_deleted_at,v_scheduled_at
  FROM public.user_profiles AS profile WHERE profile.id=p_user_id FOR UPDATE;
  IF NOT FOUND OR v_deleted_at IS NULL OR v_scheduled_at IS NULL OR v_scheduled_at>v_now THEN
    IF v_fence.state='claimed' THEN
      UPDATE public.account_hard_deletion_fences SET state='released',worker_attempt_id=NULL,
        lease_expires_at=NULL,released_at=v_now,updated_at=v_now
      WHERE user_id=p_user_id AND state='claimed' AND lease_expires_at<=v_now;
    END IF;
    RETURN 'invalid';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_recovery_admissions AS admission
    WHERE admission.user_id=p_user_id AND (
      (admission.state='claimed' AND admission.lease_expires_at>v_now)
      OR admission.auth_finalization_state IN ('prepared','pending','claimed','auth_compensation_required','billing_pending')
    )
  ) OR NOT EXISTS (
    SELECT 1 FROM public.account_deletion_auth_fences AS deletion_fence
    WHERE deletion_fence.user_id=p_user_id AND deletion_fence.state='completed'
  ) THEN RETURN 'busy'; END IF;
  IF v_fence.state='claimed' THEN
    UPDATE public.account_hard_deletion_fences SET worker_attempt_id=p_worker_attempt_id,
      claimed_at=v_now,lease_expires_at=v_now+interval '15 minutes',updated_at=v_now
    WHERE user_id=p_user_id AND state='claimed' AND lease_expires_at<=v_now;
    RETURN CASE WHEN FOUND THEN 'claimed' ELSE 'busy' END;
  END IF;
  INSERT INTO public.account_hard_deletion_fences(
    user_id,worker_attempt_id,state,claimed_at,lease_expires_at,updated_at
  ) VALUES (p_user_id,p_worker_attempt_id,'claimed',v_now,v_now+interval '15 minutes',v_now)
  ON CONFLICT(user_id) DO UPDATE SET worker_attempt_id=EXCLUDED.worker_attempt_id,state='claimed',
    claimed_at=EXCLUDED.claimed_at,lease_expires_at=EXCLUDED.lease_expires_at,
    armed_at=NULL,completed_at=NULL,released_at=NULL,updated_at=EXCLUDED.updated_at
  WHERE account_hard_deletion_fences.state='released';
  RETURN CASE WHEN FOUND THEN 'claimed' ELSE 'busy' END;
END
$function$;

CREATE OR REPLACE FUNCTION public.arm_account_hard_deletion_atomic(
  p_user_id uuid,p_worker_attempt_id uuid
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path=pg_catalog,pg_temp SET lock_timeout='5s' SET statement_timeout='30s'
SET idle_in_transaction_session_timeout='30s' SET row_security=off
AS $function$
DECLARE v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()),'') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_worker_attempt_id IS NULL THEN RAISE EXCEPTION 'invalid hard deletion arm input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  UPDATE public.account_hard_deletion_fences SET state='hard_delete_pending',armed_at=v_now,updated_at=v_now
  WHERE user_id=p_user_id AND state='claimed' AND worker_attempt_id=p_worker_attempt_id AND lease_expires_at>v_now;
  RETURN CASE WHEN FOUND THEN 'armed' ELSE 'invalid' END;
END
$function$;

CREATE OR REPLACE FUNCTION public.finalize_account_hard_deletion_worker_atomic(
  p_user_id uuid,p_worker_attempt_id uuid
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path=pg_catalog,pg_temp SET lock_timeout='5s' SET statement_timeout='30s'
SET idle_in_transaction_session_timeout='30s' SET row_security=off
AS $function$
DECLARE
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_fence public.account_hard_deletion_fences%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()),'') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_worker_attempt_id IS NULL THEN RAISE EXCEPTION 'invalid hard deletion worker finalization input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  SELECT fence.* INTO v_fence
  FROM public.account_hard_deletion_fences AS fence
  WHERE fence.user_id=p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  IF v_fence.state='completed' THEN
    IF EXISTS (SELECT 1 FROM auth.users AS auth_user WHERE auth_user.id=p_user_id)
      OR EXISTS (SELECT 1 FROM public.user_profiles AS profile WHERE profile.id=p_user_id)
    THEN RETURN 'invalid'; END IF;
    RETURN 'completed';
  END IF;
  IF v_fence.state IS DISTINCT FROM 'hard_delete_pending'
    OR v_fence.worker_attempt_id IS DISTINCT FROM p_worker_attempt_id
    OR v_fence.lease_expires_at<=v_now
  THEN RETURN 'invalid'; END IF;
  IF EXISTS (SELECT 1 FROM auth.users AS auth_user WHERE auth_user.id=p_user_id) THEN
    RETURN 'invalid';
  END IF;
  DELETE FROM public.user_profiles AS profile WHERE profile.id=p_user_id;
  UPDATE public.account_hard_deletion_fences
  SET state='completed',worker_attempt_id=NULL,lease_expires_at=NULL,
      completed_at=v_now,updated_at=v_now
  WHERE user_id=p_user_id AND state='hard_delete_pending'
    AND worker_attempt_id=p_worker_attempt_id AND lease_expires_at>v_now;
  IF NOT FOUND THEN RAISE EXCEPTION 'hard deletion worker finalization was not exact' USING ERRCODE='40001'; END IF;
  RETURN 'completed';
END
$function$;

CREATE OR REPLACE FUNCTION public.finalize_account_hard_deletion_takeover_atomic(
  p_user_id uuid
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path=pg_catalog,pg_temp SET lock_timeout='5s' SET statement_timeout='30s'
SET idle_in_transaction_session_timeout='30s' SET row_security=off
AS $function$
DECLARE
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_fence public.account_hard_deletion_fences%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()),'') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'invalid hard deletion takeover input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  SELECT fence.* INTO v_fence
  FROM public.account_hard_deletion_fences AS fence
  WHERE fence.user_id=p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN 'invalid'; END IF;
  IF v_fence.state='completed' THEN
    IF EXISTS (SELECT 1 FROM auth.users AS auth_user WHERE auth_user.id=p_user_id)
      OR EXISTS (SELECT 1 FROM public.user_profiles AS profile WHERE profile.id=p_user_id)
    THEN RETURN 'invalid'; END IF;
    RETURN 'completed';
  END IF;
  IF v_fence.state IS DISTINCT FROM 'hard_delete_pending'
    OR v_fence.lease_expires_at>v_now
  THEN RETURN 'invalid'; END IF;
  IF EXISTS (SELECT 1 FROM auth.users AS auth_user WHERE auth_user.id=p_user_id) THEN
    RETURN 'invalid';
  END IF;
  DELETE FROM public.user_profiles AS profile WHERE profile.id=p_user_id;
  UPDATE public.account_hard_deletion_fences
  SET state='completed',worker_attempt_id=NULL,lease_expires_at=NULL,
      completed_at=v_now,updated_at=v_now
  WHERE user_id=p_user_id AND state='hard_delete_pending'
    AND lease_expires_at<=v_now;
  IF NOT FOUND THEN RAISE EXCEPTION 'hard deletion takeover finalization was not exact' USING ERRCODE='40001'; END IF;
  RETURN 'completed';
END
$function$;

CREATE OR REPLACE FUNCTION public.release_account_hard_deletion_atomic(
  p_user_id uuid,p_worker_attempt_id uuid
)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path=pg_catalog,pg_temp SET lock_timeout='5s' SET statement_timeout='30s'
SET idle_in_transaction_session_timeout='30s' SET row_security=off
AS $function$
DECLARE v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()),'') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL OR p_worker_attempt_id IS NULL THEN RAISE EXCEPTION 'invalid hard deletion release input' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  UPDATE public.account_hard_deletion_fences SET state='released',worker_attempt_id=NULL,
    lease_expires_at=NULL,released_at=v_now,updated_at=v_now
  WHERE user_id=p_user_id AND state='claimed' AND worker_attempt_id=p_worker_attempt_id AND lease_expires_at>v_now;
  RETURN CASE WHEN FOUND THEN 'released' ELSE 'invalid' END;
END
$function$;

CREATE OR REPLACE FUNCTION public.list_account_hard_deletion_candidates_atomic(
  p_limit integer DEFAULT 100
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path=pg_catalog,pg_temp SET lock_timeout='5s' SET statement_timeout='30s'
SET idle_in_transaction_session_timeout='30s' SET row_security=off
AS $function$
DECLARE v_result jsonb; v_selected uuid[]; v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()),'') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid hard deletion candidate limit' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account-hard-deletion-scheduler',0)
  );
  INSERT INTO public.account_auth_reconciliation_scheduler(
    user_id,last_selected_at,selection_count,hard_delete_last_selected_at,
    hard_delete_selection_count,updated_at
  )
  SELECT profile.id,NULL,0,NULL,0,v_now
  FROM public.user_profiles AS profile
  WHERE profile.deleted_at IS NOT NULL AND profile.deletion_scheduled_at<v_now
  ON CONFLICT(user_id) DO NOTHING;

  SELECT pg_catalog.array_agg(selected.user_id ORDER BY selected.hard_delete_last_selected_at NULLS FIRST,selected.user_id)
  INTO v_selected FROM (
    SELECT scheduler.user_id,scheduler.hard_delete_last_selected_at
    FROM public.account_auth_reconciliation_scheduler AS scheduler
    JOIN public.user_profiles AS profile ON profile.id=scheduler.user_id
    WHERE profile.deleted_at IS NOT NULL AND profile.deletion_scheduled_at<v_now
    ORDER BY scheduler.hard_delete_last_selected_at NULLS FIRST,scheduler.user_id
    LIMIT p_limit
  ) AS selected;

  UPDATE public.account_auth_reconciliation_scheduler
  SET hard_delete_last_selected_at=v_now,
      hard_delete_selection_count=hard_delete_selection_count+1,
      updated_at=v_now
  WHERE user_id=ANY(COALESCE(v_selected,ARRAY[]::uuid[]));
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
    'id',profile.id,
    'original_email',profile.original_email,
    'stripe_customer_id',profile.stripe_customer_id,
    'api_stripe_subscription_id',profile.api_stripe_subscription_id
  ) ORDER BY selected.ordinality),'[]'::jsonb)
  INTO v_result
  FROM pg_catalog.unnest(COALESCE(v_selected,ARRAY[]::uuid[])) WITH ORDINALITY AS selected(user_id,ordinality)
  JOIN public.user_profiles AS profile ON profile.id=selected.user_id
  WHERE profile.deleted_at IS NOT NULL AND profile.deletion_scheduled_at<v_now;
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.list_account_auth_reconciliation_candidates_atomic(
  p_limit integer DEFAULT 100
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path=pg_catalog,pg_temp SET lock_timeout='5s' SET statement_timeout='30s'
SET idle_in_transaction_session_timeout='30s' SET row_security=off
AS $function$
DECLARE v_result jsonb; v_selected uuid[]; v_now timestamptz:=pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()),'') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid Auth reconciliation limit' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account-auth-reconciliation-scheduler',0)
  );
  INSERT INTO public.account_auth_reconciliation_scheduler(user_id,last_selected_at,selection_count,updated_at)
  SELECT candidate.user_id,NULL,0,v_now FROM (
    SELECT DISTINCT candidates.user_id FROM (
      SELECT fence.user_id FROM public.account_deletion_auth_fences AS fence
      WHERE fence.state IN ('billing_pending','auth_ban_pending','completed','expired_manual')
      UNION ALL
      SELECT admission.user_id FROM public.account_recovery_admissions AS admission
      WHERE admission.auth_finalization_state IN ('prepared','pending','claimed','auth_compensation_required','billing_pending','completed','expired_manual')
      UNION ALL
      SELECT hard_fence.user_id FROM public.account_hard_deletion_fences AS hard_fence
      WHERE hard_fence.state IN ('claimed','hard_delete_pending')
    ) AS candidates
  ) AS candidate
  ON CONFLICT(user_id) DO NOTHING;

  SELECT pg_catalog.array_agg(selected.user_id ORDER BY selected.last_selected_at NULLS FIRST,selected.user_id)
  INTO v_selected FROM (
    SELECT scheduler.user_id,scheduler.last_selected_at
    FROM public.account_auth_reconciliation_scheduler AS scheduler
    WHERE EXISTS (
      SELECT 1 FROM (
        SELECT fence.user_id FROM public.account_deletion_auth_fences AS fence
        WHERE fence.state IN ('billing_pending','auth_ban_pending','completed','expired_manual')
        UNION ALL
        SELECT admission.user_id FROM public.account_recovery_admissions AS admission
        WHERE admission.auth_finalization_state IN ('prepared','pending','claimed','auth_compensation_required','billing_pending','completed','expired_manual')
        UNION ALL
        SELECT hard_fence.user_id FROM public.account_hard_deletion_fences AS hard_fence
        WHERE hard_fence.state IN ('claimed','hard_delete_pending')
      ) AS candidate WHERE candidate.user_id=scheduler.user_id
    )
    ORDER BY scheduler.last_selected_at NULLS FIRST,scheduler.user_id
    LIMIT p_limit
  ) AS selected;

  UPDATE public.account_auth_reconciliation_scheduler
  SET last_selected_at=v_now,selection_count=selection_count+1,updated_at=v_now
  WHERE user_id=ANY(COALESCE(v_selected,ARRAY[]::uuid[]));
  SELECT COALESCE(pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object('user_id',selected.user_id) ORDER BY selected.ordinality
  ),'[]'::jsonb)
  INTO v_result
  FROM pg_catalog.unnest(COALESCE(v_selected,ARRAY[]::uuid[])) WITH ORDINALITY AS selected(user_id,ordinality);
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.resolve_account_auth_reconciliation_authority_atomic(
  p_user_id uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER VOLATILE
SET search_path=pg_catalog,pg_temp SET lock_timeout='5s' SET statement_timeout='30s'
SET idle_in_transaction_session_timeout='30s' SET row_security=off
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_now timestamptz:=pg_catalog.clock_timestamp();
  v_seconds bigint;
  v_required_until timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()),'') IS DISTINCT FROM 'service_role' THEN RAISE EXCEPTION 'service role required' USING ERRCODE='42501'; END IF;
  IF p_user_id IS NULL THEN RAISE EXCEPTION 'invalid Auth reconciliation user' USING ERRCODE='22023'; END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('account-recovery-admission:'||p_user_id::text,0));
  UPDATE public.account_recovery_admissions
  SET auth_finalization_state='expired_manual',auth_finalization_attempt_id=NULL,
      auth_finalization_attempt_expires_at=NULL,recovery_billing_resumed=NULL,
      recovery_billing_may_have_changed=COALESCE(recovery_billing_may_have_changed,false),
      updated_at=GREATEST(updated_at,v_now)
  WHERE user_id=p_user_id
    AND auth_finalization_state IN ('prepared','pending','claimed','auth_compensation_required','billing_pending')
    AND auth_finalization_prepared_at+interval '30 days'<=v_now;
  UPDATE public.account_deletion_auth_fences
  SET state='expired_manual',worker_attempt_id=NULL,lease_expires_at=NULL,updated_at=v_now
  WHERE user_id=p_user_id AND state IN ('billing_pending','auth_ban_pending')
    AND prepared_at+interval '31 days'<=v_now;
  SELECT profile.* INTO v_profile FROM public.user_profiles AS profile WHERE profile.id=p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1 FROM public.account_hard_deletion_fences AS fence
      WHERE fence.user_id=p_user_id AND fence.state='hard_delete_pending'
    ) THEN
      RETURN pg_catalog.jsonb_build_object(
        'state','delete_absent','hard_delete_takeover_required',true
      );
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.account_hard_deletion_fences AS fence
      WHERE fence.user_id=p_user_id AND fence.state='completed'
    ) OR EXISTS (
      SELECT 1 FROM public.account_deletion_auth_fences AS fence
      WHERE fence.user_id=p_user_id AND fence.state='completed'
    ) THEN
      RETURN pg_catalog.jsonb_build_object(
        'state','delete_absent','hard_delete_takeover_required',false
      );
    END IF;
    IF EXISTS (
      SELECT 1 FROM public.account_recovery_admissions AS admission
      WHERE admission.user_id=p_user_id
        AND admission.auth_finalization_state IN (
          'prepared','pending','claimed','auth_compensation_required','expired_manual'
        )
    ) OR EXISTS (
      SELECT 1 FROM public.account_deletion_auth_fences AS fence
      WHERE fence.user_id=p_user_id
        AND fence.state IN ('billing_pending','auth_ban_pending','expired_manual')
    ) OR EXISTS (
      SELECT 1 FROM public.account_hard_deletion_fences AS fence
      WHERE fence.user_id=p_user_id AND fence.state='claimed'
    ) THEN
      v_required_until:=v_now+interval '99 years';
      RETURN pg_catalog.jsonb_build_object(
        'state','banned','ban_duration','876000h',
        'minimum_banned_until',v_required_until
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object('state','manual');
  END IF;
  IF v_profile.deleted_at IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM public.account_deletion_auth_fences AS fence
      WHERE fence.user_id=p_user_id
        AND fence.state IN ('billing_pending','auth_ban_pending','completed','expired_manual')
    )
    OR EXISTS (
      SELECT 1 FROM public.account_hard_deletion_fences AS fence
      WHERE fence.user_id=p_user_id
        AND fence.state IN ('claimed','hard_delete_pending','completed')
    )
    OR EXISTS (
      SELECT 1 FROM public.account_recovery_admissions AS admission
      WHERE admission.user_id=p_user_id AND (
        admission.auth_finalization_state IN (
          'prepared','pending','claimed','auth_compensation_required'
        )
        OR (
          admission.auth_finalization_state='expired_manual'
          AND admission.auth_finalized_at IS NULL
        )
      )
    )
  THEN
    v_required_until:=v_now+interval '99 years';
    RETURN pg_catalog.jsonb_build_object(
      'state','banned','ban_duration','876000h',
      'minimum_banned_until',v_required_until
    );
  END IF;
  IF v_profile.ban_expires_at>v_now THEN
    v_seconds:=GREATEST(60,pg_catalog.ceil(EXTRACT(EPOCH FROM (v_profile.ban_expires_at-v_now)))::bigint);
    RETURN pg_catalog.jsonb_build_object('state','banned','ban_duration',v_seconds::text||'s','minimum_banned_until',v_profile.ban_expires_at);
  END IF;
  IF v_profile.banned_at IS NOT NULL OR (COALESCE(v_profile.is_banned,false) AND v_profile.ban_expires_at IS NULL) THEN
    v_required_until:=v_now+interval '99 years';
    RETURN pg_catalog.jsonb_build_object('state','banned','ban_duration','876000h','minimum_banned_until',v_required_until);
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.account_recovery_admissions AS admission
    WHERE admission.user_id=p_user_id AND (
      admission.auth_finalization_state='completed'
      OR (admission.auth_finalization_state IN ('billing_pending','expired_manual') AND admission.auth_finalized_at IS NOT NULL)
    )
  ) THEN RETURN pg_catalog.jsonb_build_object('state','active'); END IF;
  RETURN pg_catalog.jsonb_build_object('state','ignore');
END
$function$;

ALTER FUNCTION public.finish_account_recovery_with_auth_finalization_atomic(uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.claim_account_recovery_with_deletion_fence_atomic(uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.verify_pending_account_password_atomic(uuid,uuid,text,text) OWNER TO postgres;
ALTER FUNCTION public.prepare_account_recovery_auth_finalization_atomic(uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.resolve_account_recovery_capability_atomic(uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.claim_account_recovery_auth_finalization_atomic(uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.finalize_account_recovery_auth_atomic(uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.require_account_recovery_auth_compensation_atomic(uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.complete_account_recovery_auth_compensation_atomic(uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.arm_account_recovery_billing_atomic(uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.resolve_account_recovery_compensation_scope_atomic(uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.complete_account_recovery_billing_atomic(uuid,uuid,text,uuid,boolean) OWNER TO postgres;
ALTER FUNCTION public.release_account_recovery_auth_finalization_atomic(uuid,uuid,text,uuid) OWNER TO postgres;
ALTER FUNCTION public.prepare_account_deletion_auth_fence_atomic(uuid,uuid,text,text) OWNER TO postgres;
ALTER FUNCTION public.claim_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.resolve_account_deletion_capability_atomic(uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.schedule_account_deletion_with_billing_blocks_fenced(uuid,uuid,uuid,text,timestamptz,text,text,text[]) OWNER TO postgres;
ALTER FUNCTION public.complete_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.release_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text) OWNER TO postgres;
ALTER FUNCTION public.claim_account_hard_deletion_atomic(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.arm_account_hard_deletion_atomic(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.finalize_account_hard_deletion_worker_atomic(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.finalize_account_hard_deletion_takeover_atomic(uuid) OWNER TO postgres;
ALTER FUNCTION public.release_account_hard_deletion_atomic(uuid,uuid) OWNER TO postgres;
ALTER FUNCTION public.list_account_hard_deletion_candidates_atomic(integer) OWNER TO postgres;
ALTER FUNCTION public.list_account_auth_reconciliation_candidates_atomic(integer) OWNER TO postgres;
ALTER FUNCTION public.resolve_account_auth_reconciliation_authority_atomic(uuid) OWNER TO postgres;

-- Close the 22500 service-role entry points. The postgres-owned wrappers above
-- may call them internally, but no runtime caller may bypass the durable
-- deletion fence or omit Auth-finalization preparation.
REVOKE ALL ON FUNCTION public.claim_account_recovery_admission_atomic(uuid,text,uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.finish_account_recovery_admission_atomic(uuid,uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.schedule_account_deletion_with_billing_blocks(uuid,text,timestamptz,text,text,text[])
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

REVOKE ALL ON FUNCTION public.finish_account_recovery_with_auth_finalization_atomic(uuid,uuid,text) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.claim_account_recovery_with_deletion_fence_atomic(uuid,text,uuid) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.verify_pending_account_password_atomic(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.prepare_account_recovery_auth_finalization_atomic(uuid,uuid,text) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.resolve_account_recovery_capability_atomic(uuid,uuid,text) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.claim_account_recovery_auth_finalization_atomic(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.finalize_account_recovery_auth_atomic(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.require_account_recovery_auth_compensation_atomic(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.complete_account_recovery_auth_compensation_atomic(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.arm_account_recovery_billing_atomic(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.resolve_account_recovery_compensation_scope_atomic(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.complete_account_recovery_billing_atomic(uuid,uuid,text,uuid,boolean) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.release_account_recovery_auth_finalization_atomic(uuid,uuid,text,uuid) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.prepare_account_deletion_auth_fence_atomic(uuid,uuid,text,text) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.claim_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.resolve_account_deletion_capability_atomic(uuid,uuid,text) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.schedule_account_deletion_with_billing_blocks_fenced(uuid,uuid,uuid,text,timestamptz,text,text,text[]) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.complete_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.release_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.claim_account_hard_deletion_atomic(uuid,uuid) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.arm_account_hard_deletion_atomic(uuid,uuid) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.finalize_account_hard_deletion_worker_atomic(uuid,uuid) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.finalize_account_hard_deletion_takeover_atomic(uuid) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.release_account_hard_deletion_atomic(uuid,uuid) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.list_account_hard_deletion_candidates_atomic(integer) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.list_account_auth_reconciliation_candidates_atomic(integer) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.resolve_account_auth_reconciliation_authority_atomic(uuid) FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.finish_account_recovery_with_auth_finalization_atomic(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_account_recovery_with_deletion_fence_atomic(uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.verify_pending_account_password_atomic(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_account_recovery_auth_finalization_atomic(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_account_recovery_capability_atomic(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_account_recovery_auth_finalization_atomic(uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_account_recovery_auth_atomic(uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.require_account_recovery_auth_compensation_atomic(uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_account_recovery_auth_compensation_atomic(uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.arm_account_recovery_billing_atomic(uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_account_recovery_compensation_scope_atomic(uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_account_recovery_billing_atomic(uuid,uuid,text,uuid,boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_account_recovery_auth_finalization_atomic(uuid,uuid,text,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.prepare_account_deletion_auth_fence_atomic(uuid,uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_account_deletion_capability_atomic(uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.schedule_account_deletion_with_billing_blocks_fenced(uuid,uuid,uuid,text,timestamptz,text,text,text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_account_hard_deletion_atomic(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.arm_account_hard_deletion_atomic(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_account_hard_deletion_worker_atomic(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_account_hard_deletion_takeover_atomic(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_account_hard_deletion_atomic(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_account_hard_deletion_candidates_atomic(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_account_auth_reconciliation_candidates_atomic(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_account_auth_reconciliation_authority_atomic(uuid) TO service_role;

DO $postflight$
DECLARE
  v_expected record;
  v_function pg_catalog.pg_proc%ROWTYPE;
  v_hash text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.account_recovery_admissions'::pg_catalog.regclass
      AND relation.relowner = 'postgres'::pg_catalog.regrole
      AND relation.relkind = 'r'
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.account_deletion_auth_fences'::pg_catalog.regclass
      AND relation.relowner = 'postgres'::pg_catalog.regrole
      AND relation.relkind = 'r'
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.account_recovery_password_guards'::pg_catalog.regclass
      AND relation.relowner = 'postgres'::pg_catalog.regrole
      AND relation.relkind = 'r'
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.account_hard_deletion_fences'::pg_catalog.regclass
      AND relation.relowner = 'postgres'::pg_catalog.regrole
      AND relation.relkind = 'r'
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.account_auth_reconciliation_scheduler'::pg_catalog.regclass
      AND relation.relowner = 'postgres'::pg_catalog.regrole
      AND relation.relkind = 'r'
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.account_recovery_admissions'::pg_catalog.regclass
      AND attribute.attname = ANY (ARRAY[
        'auth_finalization_capability_hash',
        'auth_finalization_state',
        'auth_finalization_prepared_at',
        'auth_finalization_attempt_id',
        'auth_finalization_attempt_expires_at',
        'auth_finalized_at',
        'recovery_billing_resumed',
        'recovery_billing_may_have_changed'
      ])
      AND NOT attribute.attisdropped
  ) <> 8 OR (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.account_deletion_auth_fences'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 13 OR (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.account_recovery_password_guards'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 5 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.account_hard_deletion_fences'::pg_catalog.regclass
      AND constraint_row.conname='account_hard_deletion_fence_shape'
      AND constraint_row.contype='c' AND constraint_row.convalidated
  ) OR (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid='public.account_hard_deletion_fences'::pg_catalog.regclass
      AND attribute.attnum>0 AND NOT attribute.attisdropped
  ) <> 9 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid='public.account_auth_reconciliation_scheduler'::pg_catalog.regclass
      AND constraint_row.contype='c' AND constraint_row.convalidated
  ) OR (
    SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid='public.account_auth_reconciliation_scheduler'::pg_catalog.regclass
      AND attribute.attnum>0 AND NOT attribute.attisdropped
  ) <> 6 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.account_recovery_admissions'::pg_catalog.regclass
      AND constraint_row.conname = 'account_recovery_auth_finalization_shape'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.account_deletion_auth_fences'::pg_catalog.regclass
      AND constraint_row.conname = 'account_deletion_auth_fence_shape'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.account_recovery_password_guards'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'c'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_row.indexrelid
    WHERE index_row.indrelid = 'public.account_recovery_admissions'::pg_catalog.regclass
      AND index_relation.relname = 'account_recovery_auth_finalization_pending'
      AND index_relation.relowner = 'postgres'::pg_catalog.regrole
      AND index_row.indisvalid
      AND index_row.indisready
  ) THEN
    RAISE EXCEPTION 'account recovery Auth finalization storage contract drifted';
  END IF;

  IF pg_catalog.has_table_privilege('anon', 'public.account_recovery_admissions', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('authenticated', 'public.account_recovery_admissions', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('authenticator', 'public.account_recovery_admissions', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('service_role', 'public.account_recovery_admissions', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('anon', 'public.account_deletion_auth_fences', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('authenticated', 'public.account_deletion_auth_fences', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('authenticator', 'public.account_deletion_auth_fences', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('service_role', 'public.account_deletion_auth_fences', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('anon', 'public.account_recovery_password_guards', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('authenticated', 'public.account_recovery_password_guards', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('authenticator', 'public.account_recovery_password_guards', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('service_role', 'public.account_recovery_password_guards', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('anon', 'public.account_hard_deletion_fences', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('authenticated', 'public.account_hard_deletion_fences', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('authenticator', 'public.account_hard_deletion_fences', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('service_role', 'public.account_hard_deletion_fences', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('anon', 'public.account_auth_reconciliation_scheduler', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('authenticated', 'public.account_auth_reconciliation_scheduler', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('authenticator', 'public.account_auth_reconciliation_scheduler', 'SELECT,INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege('service_role', 'public.account_auth_reconciliation_scheduler', 'SELECT,INSERT,UPDATE,DELETE')
  THEN
    RAISE EXCEPTION 'account recovery Auth finalization table ACL drifted';
  END IF;

  IF pg_catalog.has_function_privilege(
      'service_role',
      'public.claim_account_recovery_admission_atomic(uuid,text,uuid)',
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'service_role',
      'public.finish_account_recovery_admission_atomic(uuid,uuid)',
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'service_role',
      'public.schedule_account_deletion_with_billing_blocks(uuid,text,timestamptz,text,text,text[])',
      'EXECUTE'
    ) OR pg_catalog.to_regprocedure(
      'public.complete_account_hard_deletion_atomic(uuid,uuid)'
    ) IS NOT NULL THEN
    RAISE EXCEPTION 'legacy account recovery runtime bypass remains executable';
  END IF;

  FOR v_expected IN
    SELECT * FROM (VALUES
      ('public.claim_account_recovery_with_deletion_fence_atomic(uuid,text,uuid)', 3, 'text', 'a57fdb14a1e0de51988288b1b4d989f46460532f1022059b644668c8920730a7'),
      ('public.verify_pending_account_password_atomic(uuid,uuid,text,text)', 4, 'text', '8aee75e2fe399e6258d6146d9ce7965cdaa71c8946a158ec80d9372d029486dd'),
      ('public.prepare_account_recovery_auth_finalization_atomic(uuid,uuid,text)', 3, 'text', '79eca76724d62e0833c33a609a412577b430e43f003cd831dc3cb43d7fa14709'),
      ('public.resolve_account_recovery_capability_atomic(uuid,uuid,text)', 3, 'text', '48bbae0fda44e19b0fb2ac10401af5f1828b80a5eaf05b2124094636eb6d9db6'),
      ('public.finish_account_recovery_with_auth_finalization_atomic(uuid,uuid,text)', 3, 'text', 'd98f4b1dbc99af0fdc9c597a4e5d65ca68c870af1cb518f6ec5e39108371b37e'),
      ('public.claim_account_recovery_auth_finalization_atomic(uuid,uuid,text,uuid)', 4, 'text', '10d854bdc45f729f1b0099b62640342947d299e74893e12273cb301353a575eb'),
      ('public.finalize_account_recovery_auth_atomic(uuid,uuid,text,uuid)', 4, 'text', '962152fbc4905da47ed14103bdee90807814c16c33d8272c2fc323f4086e3bbf'),
      ('public.require_account_recovery_auth_compensation_atomic(uuid,uuid,text,uuid)', 4, 'text', 'bf4fb919cd070a40177afc47b73d69a581ffbe0b929539cd81799071e6b80c07'),
      ('public.complete_account_recovery_auth_compensation_atomic(uuid,uuid,text,uuid)', 4, 'text', '31d90307d84631d2a183fc081997dc434c5aff323c70a45ab99d2ef971e35a19'),
      ('public.arm_account_recovery_billing_atomic(uuid,uuid,text,uuid)', 4, 'text', '373473aba38bdf335be017338136e79175a966e7828728a2dbccdb81ed60359c'),
      ('public.resolve_account_recovery_compensation_scope_atomic(uuid,uuid,text,uuid)', 4, 'text', 'e220e690cbc4347b8147d775986e31d994b37f047b2b87a5dd3a577c258363f0'),
      ('public.complete_account_recovery_billing_atomic(uuid,uuid,text,uuid,boolean)', 5, 'text', '6c1798749170fedf18bd7917b9653a7477917dff874e9fc4669ecc4e798359ce'),
      ('public.release_account_recovery_auth_finalization_atomic(uuid,uuid,text,uuid)', 4, 'text', '10a64883528f16284810bffca08a1fbab97e38d0f1b0a1de52689851516f6c97'),
      ('public.prepare_account_deletion_auth_fence_atomic(uuid,uuid,text,text)', 4, 'text', '6e0b83d5a486f67e740baffa101c8d0fa225d65e017967d94f591e5553e31398'),
      ('public.claim_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text)', 4, 'text', 'bdd17295e1301586a6c43ecadcb2124496317f4b2892557082eaffe6df3b9dbe'),
      ('public.resolve_account_deletion_capability_atomic(uuid,uuid,text)', 3, 'text', '0c27d95dd932e49243bb0fa92da5afc788e3ef23c6da5b53b025096bc42d07bb'),
      ('public.schedule_account_deletion_with_billing_blocks_fenced(uuid,uuid,uuid,text,timestamptz,text,text,text[])', 8, 'jsonb', '79cd1f6dc892f7287b0cb85f94993ef180b291ba02141f9b60e04a0b6ce41b36'),
      ('public.complete_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text)', 4, 'text', '732c479da1399d4276b2d8580927e7cdad961cbdcc19a5c4b340f6bf271e5ed0'),
      ('public.release_account_deletion_auth_fence_atomic(uuid,uuid,uuid,text)', 4, 'text', 'b168a3e31cfd16464353ef5ea6c9c9503a0be88fd389c937011207bcc4bf86dc'),
      ('public.claim_account_hard_deletion_atomic(uuid,uuid)', 2, 'text', 'b128378ecf396ae0a7890df924fee5d2e77e02cc04b695cbc68482a7ca0ffb74'),
      ('public.arm_account_hard_deletion_atomic(uuid,uuid)', 2, 'text', '05c81ec50733a5bfa473a73e51b4f80b6bae59c5db12d889a99f5b835fd6be45'),
      ('public.finalize_account_hard_deletion_worker_atomic(uuid,uuid)', 2, 'text', '70d7fb60266d513e522335722b69cf43da193a5079fce89b5ee93574e06c0aff'),
      ('public.finalize_account_hard_deletion_takeover_atomic(uuid)', 1, 'text', '6184e64a5fbd6295f04733e988badea1cc4a8513cd88381b7e9eddc5bb916c89'),
      ('public.release_account_hard_deletion_atomic(uuid,uuid)', 2, 'text', 'cde8aa6e09d0ffb013a1951288dc5a0f555f9a100ac49d07f251c9c81acf04a9'),
      ('public.list_account_hard_deletion_candidates_atomic(integer)', 1, 'jsonb', 'ac918323c3318b1ee0ac47fc7473bed1b3b142def7ba90e74e9fd42a27a08883'),
      ('public.list_account_auth_reconciliation_candidates_atomic(integer)', 1, 'jsonb', '7481759039c07d79bb38860b78c33464c6327a64010953b637fe019cc5cac988'),
      ('public.resolve_account_auth_reconciliation_authority_atomic(uuid)', 1, 'jsonb', 'd54662b27aa4fd3f4d35e48b072e1e2fc3cc0d4cc82e19c292fc3bc36b4d2bb7')
    ) AS expected(signature, argument_count, return_type, source_hash)
  LOOP
    SELECT function_row.* INTO v_function
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure(v_expected.signature);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'missing account recovery Auth finalization function: %', v_expected.signature;
    END IF;
    v_hash := pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(v_function.prosrc, 'UTF8')),
      'hex'
    );
    IF v_function.proowner <> 'postgres'::pg_catalog.regrole
      OR NOT v_function.prosecdef
      OR v_function.prokind <> 'f'
      OR v_function.provolatile <> 'v'
      OR v_function.proisstrict
      OR v_function.proleakproof
      OR v_function.proparallel <> 'u'
      OR v_function.prorettype <> pg_catalog.to_regtype(v_expected.return_type)
      OR v_function.pronargs <> v_expected.argument_count
      OR pg_catalog.array_length(v_function.proconfig, 1) <> 5
      OR NOT v_function.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s',
        'statement_timeout=30s',
        'idle_in_transaction_session_timeout=30s',
        'row_security=off'
      ]
      OR v_hash <> v_expected.source_hash
      OR pg_catalog.has_function_privilege('anon', v_function.oid, 'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated', v_function.oid, 'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticator', v_function.oid, 'EXECUTE')
      OR NOT pg_catalog.has_function_privilege('service_role', v_function.oid, 'EXECUTE')
    THEN
      RAISE EXCEPTION 'account recovery Auth finalization function contract drifted: %', v_expected.signature;
    END IF;
  END LOOP;
END
$postflight$;

COMMIT;
