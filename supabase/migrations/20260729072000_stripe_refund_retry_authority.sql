-- Preserve the exact Stripe Refund identity while an automatic refund is
-- pending. A retry must retrieve that Refund instead of replaying a cached
-- pending idempotent response forever. A terminal failed/canceled Refund may
-- advance to one new request whose stable key is derived from its predecessor.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_finish_definition text;
BEGIN
  IF pg_catalog.to_regclass(
      'public.stripe_entitlement_effects'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.stripe_entitlement_effect_is_current_v2(uuid)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.stripe_paid_launch_readiness_v2()'
    ) IS NULL
  THEN
    RAISE EXCEPTION
      'Stripe refund retry authority prerequisites are missing';
  END IF;

  IF pg_catalog.to_regprocedure(
      'public.stripe_paid_launch_readiness_pre_refund_retry_v2()'
    ) IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid =
          'public.stripe_entitlement_effects'::pg_catalog.regclass
        AND constraint_row.conname =
          'stripe_entitlement_effects_external_ref_state_check'
    )
  THEN
    RAISE EXCEPTION
      'Stripe refund retry authority was already installed';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
  THEN
    RAISE EXCEPTION 'Stripe refund retry authority roles are missing';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)'::pg_catalog.regprocedure
  )
  INTO v_finish_definition;
  IF v_finish_definition NOT LIKE
      '%p_external_ref IS NOT NULL%'
    OR v_finish_definition NOT LIKE
      '%SET status = ''failed''%'
    OR v_finish_definition NOT LIKE
      '%SET status = ''dead_lettered''%'
  THEN
    RAISE EXCEPTION
      'Stripe entitlement effect completion contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_entitlement_effects AS effect
    WHERE effect.status <> 'completed'
      AND effect.external_ref IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'unexpected unfinished entitlement effect already has an external reference';
  END IF;
END
$preflight$;

LOCK TABLE public.stripe_entitlement_effects
  IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.stripe_entitlement_effects
  ADD CONSTRAINT stripe_entitlement_effects_external_ref_state_check
  CHECK (
    external_ref IS NULL
    OR (
      pg_catalog.btrim(external_ref) = external_ref
      AND pg_catalog.length(external_ref) BETWEEN 1 AND 512
      AND (
        (
          effect_type = 'payment_auto_refund'
          AND (
            external_ref ~ '^refund:re_[A-Za-z0-9]+$'
            OR (
              status = 'completed'
              AND external_ref
                ~ '^charge:ch_[A-Za-z0-9]+:fully_refunded$'
            )
          )
        )
        OR (
          effect_type <> 'payment_auto_refund'
          AND status = 'completed'
        )
      )
    )
  ) NOT VALID;

ALTER TABLE public.stripe_entitlement_effects
  VALIDATE CONSTRAINT
    stripe_entitlement_effects_external_ref_state_check;

CREATE OR REPLACE FUNCTION public.finish_stripe_entitlement_effect_atomic(
  p_effect_id uuid,
  p_lease_token uuid,
  p_succeeded boolean,
  p_external_ref text,
  p_error text,
  p_retry_after_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_effect public.stripe_entitlement_effects%ROWTYPE;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_effect_id IS NULL
    OR p_lease_token IS NULL
    OR p_succeeded IS NULL
    OR (
      p_succeeded
      AND (
        p_external_ref IS NULL
        OR pg_catalog.length(pg_catalog.btrim(p_external_ref))
          NOT BETWEEN 1 AND 512
        OR pg_catalog.btrim(p_external_ref)
          IS DISTINCT FROM p_external_ref
        OR p_error IS NOT NULL
        OR p_retry_after_seconds IS NOT NULL
      )
    )
    OR (
      NOT p_succeeded
      AND (
        p_error IS NULL
        OR pg_catalog.length(pg_catalog.btrim(p_error))
          NOT BETWEEN 1 AND 2000
        OR p_retry_after_seconds IS NULL
        OR p_retry_after_seconds NOT BETWEEN 0 AND 3600
      )
    )
    OR (
      p_external_ref IS NOT NULL
      AND (
        pg_catalog.length(pg_catalog.btrim(p_external_ref))
          NOT BETWEEN 1 AND 512
        OR pg_catalog.btrim(p_external_ref)
          IS DISTINCT FROM p_external_ref
      )
    )
  THEN
    RAISE EXCEPTION 'effect completion request is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT effect.*
  INTO v_effect
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.id = p_effect_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF NOT p_succeeded
    AND p_external_ref IS NOT NULL
    AND (
      v_effect.effect_type <> 'payment_auto_refund'
      OR p_external_ref !~ '^refund:re_[A-Za-z0-9]+$'
    )
  THEN
    RAISE EXCEPTION
      'failed effect provider reference is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_succeeded
    AND v_effect.effect_type = 'payment_auto_refund'
    AND p_external_ref !~ (
      '^(refund:re_[A-Za-z0-9]+'
        || '|charge:ch_[A-Za-z0-9]+:fully_refunded)$'
    )
  THEN
    RAISE EXCEPTION
      'completed automatic refund reference is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF v_effect.status = 'completed' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      CASE
        WHEN p_succeeded
          AND v_effect.external_ref IS NOT DISTINCT FROM p_external_ref
        THEN 'already_completed'
        ELSE 'identity_conflict'
      END
    );
  END IF;
  IF v_effect.status = 'dead_lettered' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_dead_lettered');
  END IF;
  IF v_effect.status = 'superseded' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_superseded');
  END IF;
  IF v_effect.status IS DISTINCT FROM 'processing'
    OR v_effect.lease_token IS DISTINCT FROM p_lease_token
    OR v_effect.lease_expires_at IS NULL
    OR v_effect.lease_expires_at <= v_now
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'lease_lost');
  END IF;

  IF v_effect.effect_type NOT IN (
      'payment_auto_refund',
      'payment_manual_review',
      'stripe_subscription_cancel'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.id = v_effect.user_id
        AND profile.deleted_at IS NULL
        AND profile.banned_at IS NULL
        AND NOT (
          COALESCE(profile.is_banned, false)
          AND (
            profile.ban_expires_at IS NULL
            OR profile.ban_expires_at > v_now
          )
        )
    )
  THEN
    UPDATE public.stripe_entitlement_effects
    SET status = 'superseded',
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error = CASE
          WHEN v_effect.user_id IS NULL THEN 'subject_deleted'
          ELSE 'subject_inactive'
        END,
        completed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_effect.id;
    RETURN pg_catalog.jsonb_build_object('status', 'superseded');
  END IF;

  IF NOT public.stripe_entitlement_effect_is_current_v2(v_effect.id) THEN
    UPDATE public.stripe_entitlement_effects
    SET status = 'superseded',
        lease_token = NULL,
        lease_expires_at = NULL,
        external_ref = CASE
          WHEN v_effect.effect_type = 'payment_auto_refund'
            AND p_external_ref ~ '^refund:re_[A-Za-z0-9]+$'
          THEN p_external_ref
          ELSE external_ref
        END,
        last_error = 'authority_superseded',
        completed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_effect.id;
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'authority_superseded'
    );
  END IF;

  IF p_succeeded THEN
    UPDATE public.stripe_entitlement_effects
    SET status = 'completed',
        lease_token = NULL,
        lease_expires_at = NULL,
        external_ref = p_external_ref,
        last_error = NULL,
        completed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_effect.id;
    RETURN pg_catalog.jsonb_build_object('status', 'completed');
  END IF;

  IF v_effect.attempt_count >= 10 THEN
    UPDATE public.stripe_entitlement_effects
    SET status = 'dead_lettered',
        lease_token = NULL,
        lease_expires_at = NULL,
        external_ref = COALESCE(p_external_ref, external_ref),
        last_error = p_error,
        completed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_effect.id;
    RETURN pg_catalog.jsonb_build_object('status', 'dead_lettered');
  END IF;

  UPDATE public.stripe_entitlement_effects
  SET status = 'failed',
      lease_token = NULL,
      lease_expires_at = NULL,
      external_ref = COALESCE(p_external_ref, external_ref),
      available_at = v_now
        + pg_catalog.make_interval(secs => p_retry_after_seconds),
      last_error = p_error,
      completed_at = NULL,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_effect.id;
  RETURN pg_catalog.jsonb_build_object('status', 'retry_scheduled');
END
$function$;

ALTER FUNCTION public.finish_stripe_entitlement_effect_atomic(
  uuid, uuid, boolean, text, text, integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finish_stripe_entitlement_effect_atomic(
  uuid, uuid, boolean, text, text, integer
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.finish_stripe_entitlement_effect_atomic(
  uuid, uuid, boolean, text, text, integer
) TO service_role;

ALTER FUNCTION public.stripe_paid_launch_readiness_v2()
  RENAME TO stripe_paid_launch_readiness_pre_refund_retry_v2;
REVOKE ALL ON FUNCTION
  public.stripe_paid_launch_readiness_pre_refund_retry_v2()
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.stripe_paid_launch_readiness_v2()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_base jsonb;
  v_refund_reference_anomalies integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  v_base :=
    public.stripe_paid_launch_readiness_pre_refund_retry_v2();

  SELECT (
    (
      SELECT pg_catalog.count(*)
      FROM public.stripe_entitlement_effects AS effect
      WHERE effect.external_ref IS NOT NULL
        AND (
          pg_catalog.btrim(effect.external_ref)
            IS DISTINCT FROM effect.external_ref
          OR pg_catalog.length(effect.external_ref) NOT BETWEEN 1 AND 512
          OR (
            effect.effect_type = 'payment_auto_refund'
            AND NOT (
              effect.external_ref ~ '^refund:re_[A-Za-z0-9]+$'
              OR (
                effect.status = 'completed'
                AND effect.external_ref
                  ~ '^charge:ch_[A-Za-z0-9]+:fully_refunded$'
              )
            )
          )
          OR (
            effect.effect_type <> 'payment_auto_refund'
            AND effect.status <> 'completed'
          )
        )
    )
    + CASE
        WHEN EXISTS (
          SELECT 1
          FROM pg_catalog.pg_constraint AS constraint_row
          WHERE constraint_row.conrelid =
              'public.stripe_entitlement_effects'::pg_catalog.regclass
            AND constraint_row.conname =
              'stripe_entitlement_effects_external_ref_state_check'
            AND constraint_row.contype = 'c'
            AND constraint_row.convalidated
            AND pg_catalog.pg_get_constraintdef(
              constraint_row.oid
            ) LIKE '%payment_auto_refund%'
            AND pg_catalog.pg_get_constraintdef(
              constraint_row.oid
            ) LIKE '%fully_refunded%'
        )
        THEN 0
        ELSE 1
      END
  )::integer
  INTO v_refund_reference_anomalies;

  RETURN v_base || pg_catalog.jsonb_build_object(
    'status',
      CASE
        WHEN COALESCE(v_base ->> 'status', '') = 'ready'
          AND v_refund_reference_anomalies = 0
        THEN 'ready'
        ELSE 'blocked'
      END,
    'refund_effect_reference_anomalies',
      v_refund_reference_anomalies
  );
END
$function$;

ALTER FUNCTION public.stripe_paid_launch_readiness_v2()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_paid_launch_readiness_v2()
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.stripe_paid_launch_readiness_v2()
TO service_role;

DO $postflight$
DECLARE
  v_finish_definition text;
  v_readiness_definition text;
BEGIN
  IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid =
          'public.stripe_entitlement_effects'::pg_catalog.regclass
        AND constraint_row.conname =
          'stripe_entitlement_effects_external_ref_state_check'
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND pg_catalog.pg_get_constraintdef(
          constraint_row.oid
        ) LIKE '%payment_auto_refund%'
        AND pg_catalog.pg_get_constraintdef(
          constraint_row.oid
        ) LIKE '%fully_refunded%'
    )
  THEN
    RAISE EXCEPTION
      'Stripe refund external-reference constraint did not converge';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)'::pg_catalog.regprocedure
  )
  INTO v_finish_definition;
  SELECT pg_catalog.pg_get_functiondef(
    'public.stripe_paid_launch_readiness_v2()'::pg_catalog.regprocedure
  )
  INTO v_readiness_definition;

  IF v_finish_definition NOT LIKE
      '%external_ref = COALESCE(p_external_ref, external_ref)%'
    OR v_finish_definition NOT LIKE
      '%failed effect provider reference is invalid%'
    OR v_readiness_definition NOT LIKE
      '%refund_effect_reference_anomalies%'
  THEN
    RAISE EXCEPTION
      'Stripe refund retry routines did not converge';
  END IF;

  IF (
      SELECT function_owner.rolname
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_roles AS function_owner
        ON function_owner.oid = routine.proowner
      WHERE routine.oid =
        'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)'::pg_catalog.regprocedure
    ) IS DISTINCT FROM 'postgres'
    OR (
      SELECT routine.prosecdef
      FROM pg_catalog.pg_proc AS routine
      WHERE routine.oid =
        'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)'::pg_catalog.regprocedure
    ) IS NOT TRUE
    OR NOT pg_catalog.has_function_privilege(
      'service_role',
      'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.stripe_paid_launch_readiness_pre_refund_retry_v2()',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'service_role',
      'public.stripe_paid_launch_readiness_v2()',
      'EXECUTE'
    )
    OR pg_catalog.has_table_privilege(
      'service_role',
      'public.stripe_entitlement_effects',
      'INSERT,UPDATE,DELETE'
    )
  THEN
    RAISE EXCEPTION
      'Stripe refund retry authority ACL drifted';
  END IF;
END
$postflight$;

COMMENT ON FUNCTION public.finish_stripe_entitlement_effect_atomic(
  uuid, uuid, boolean, text, text, integer
) IS
  'Fenced effect completion that persists exact pending automatic-Refund identity before retry.';

COMMENT ON CONSTRAINT
  stripe_entitlement_effects_external_ref_state_check
ON public.stripe_entitlement_effects IS
  'Only automatic refunds may retain a provider Refund reference before completion.';

COMMIT;
