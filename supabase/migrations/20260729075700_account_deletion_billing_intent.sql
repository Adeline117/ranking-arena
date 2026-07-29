-- Persist the recoverable account-deletion tombstone before the first
-- irreversible Stripe mutation. A prepared operation blocks recovery and hard
-- deletion until every remote billing surface has converged and the operation
-- is atomically marked settled.

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass(
    'public.account_deletion_billing_operations'
  ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.prepare_account_deletion_billing_atomic(uuid,uuid,text,timestamp with time zone,text,text,text[])'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.finish_account_deletion_billing_atomic(uuid,uuid,text,text[])'
    ) IS NOT NULL
  THEN
    RAISE EXCEPTION 'account deletion billing intent already exists';
  END IF;

  IF pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.subscriptions') IS NULL
    OR pg_catalog.to_regclass('public.api_tier_subscription_blocks') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.schedule_account_deletion_with_billing_blocks(uuid,text,timestamp with time zone,text,text,text[])'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.claim_account_recovery_admission_atomic(uuid,text,uuid)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.claim_account_recovery_admission_atomic_locked_impl(uuid,text,uuid)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.admit_expired_account_hard_delete_atomic(uuid)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'account deletion billing intent prerequisites are missing';
  END IF;
END
$preflight$;

CREATE TABLE public.account_deletion_billing_operations (
  operation_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  state text NOT NULL,
  recovery_token_hash text NOT NULL,
  deletion_scheduled_at timestamptz NOT NULL,
  deleted_at timestamptz NOT NULL,
  stripe_customer_id text,
  stripe_subscription_ids text[] NOT NULL,
  prepared_at timestamptz NOT NULL,
  settled_at timestamptz,
  updated_at timestamptz NOT NULL,
  CONSTRAINT account_deletion_billing_operation_state
    CHECK (state IN ('prepared', 'settled')),
  CONSTRAINT account_deletion_billing_operation_token_shape
    CHECK (recovery_token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT account_deletion_billing_operation_customer_shape
    CHECK (
      stripe_customer_id IS NULL
      OR (
        stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
        AND pg_catalog.length(stripe_customer_id) <= 255
      )
    ),
  CONSTRAINT account_deletion_billing_operation_subscription_shape
    CHECK (
      pg_catalog.cardinality(stripe_subscription_ids) <= 1000
      AND pg_catalog.array_position(stripe_subscription_ids, NULL) IS NULL
    ),
  CONSTRAINT account_deletion_billing_operation_time_order
    CHECK (
      deletion_scheduled_at > deleted_at
      AND updated_at >= prepared_at
    ),
  CONSTRAINT account_deletion_billing_operation_terminal_shape
    CHECK (
      (state = 'prepared' AND settled_at IS NULL)
      OR (
        state = 'settled'
        AND settled_at IS NOT NULL
        AND settled_at >= prepared_at
      )
    )
);

CREATE UNIQUE INDEX account_deletion_billing_one_prepared_user
  ON public.account_deletion_billing_operations (user_id)
  WHERE state = 'prepared';
CREATE INDEX account_deletion_billing_prepared_retry
  ON public.account_deletion_billing_operations (prepared_at, operation_id)
  WHERE state = 'prepared';

ALTER TABLE public.account_deletion_billing_operations OWNER TO postgres;
ALTER TABLE public.account_deletion_billing_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_deletion_billing_operations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.account_deletion_billing_operations
  FROM PUBLIC, anon, authenticated, authenticator;
GRANT SELECT ON TABLE public.account_deletion_billing_operations TO service_role;

CREATE FUNCTION public.prepare_account_deletion_billing_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_reason text,
  p_scheduled_at timestamptz,
  p_recovery_token_hash text,
  p_stripe_customer_id text,
  p_stripe_subscription_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_existing public.account_deletion_billing_operations%ROWTYPE;
  v_normalized_subscription_ids text[];
  v_schedule_ack jsonb;
  v_deleted_at timestamptz;
  v_now timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(candidate.subscription_id ORDER BY candidate.subscription_id),
    ARRAY[]::text[]
  )
  INTO v_normalized_subscription_ids
  FROM (
    SELECT DISTINCT supplied.subscription_id
    FROM pg_catalog.unnest(
      COALESCE(p_stripe_subscription_ids, ARRAY[]::text[])
    ) AS supplied(subscription_id)
  ) AS candidate;

  IF p_user_id IS NULL
    OR p_operation_id IS NULL
    OR p_scheduled_at IS NULL
    OR p_recovery_token_hash IS NULL
    OR p_recovery_token_hash !~ '^[0-9a-f]{64}$'
    OR p_stripe_subscription_ids IS NULL
    OR pg_catalog.cardinality(p_stripe_subscription_ids) > 1000
    OR p_stripe_subscription_ids IS DISTINCT FROM v_normalized_subscription_ids
    OR (
      p_stripe_customer_id IS NULL
      AND pg_catalog.cardinality(v_normalized_subscription_ids) > 0
    )
    OR (
      p_stripe_customer_id IS NOT NULL
      AND (
        pg_catalog.btrim(p_stripe_customer_id) IS DISTINCT FROM p_stripe_customer_id
        OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_stripe_customer_id) > 255
      )
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(v_normalized_subscription_ids) AS supplied(subscription_id)
      WHERE supplied.subscription_id IS NULL
        OR pg_catalog.btrim(supplied.subscription_id) IS DISTINCT FROM supplied.subscription_id
        OR supplied.subscription_id !~ '^sub_[A-Za-z0-9_]+$'
        OR pg_catalog.length(supplied.subscription_id) > 255
    )
  THEN
    RAISE EXCEPTION 'invalid account deletion billing preparation input'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );

  SELECT operation.*
  INTO v_existing
  FROM public.account_deletion_billing_operations AS operation
  WHERE operation.operation_id = p_operation_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id
      OR v_existing.recovery_token_hash IS DISTINCT FROM p_recovery_token_hash
      OR v_existing.deletion_scheduled_at IS DISTINCT FROM p_scheduled_at
      OR v_existing.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_existing.stripe_subscription_ids IS DISTINCT FROM v_normalized_subscription_ids
    THEN
      RAISE EXCEPTION 'account deletion operation identity conflict'
        USING ERRCODE = '23505';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', v_existing.state,
      'operation_id', v_existing.operation_id,
      'user_id', v_existing.user_id,
      'deleted_at', v_existing.deleted_at,
      'deletion_scheduled_at', v_existing.deletion_scheduled_at,
      'stripe_customer_id', v_existing.stripe_customer_id,
      'stripe_subscription_ids', v_existing.stripe_subscription_ids
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.account_deletion_billing_operations AS operation
    WHERE operation.user_id = p_user_id
      AND operation.state = 'prepared'
    FOR UPDATE
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'busy',
      'operation_id', p_operation_id,
      'user_id', p_user_id
    );
  END IF;

  v_schedule_ack := public.schedule_account_deletion_with_billing_blocks(
    p_user_id,
    COALESCE(p_reason, ''),
    p_scheduled_at,
    p_recovery_token_hash,
    p_stripe_customer_id,
    v_normalized_subscription_ids
  );

  IF v_schedule_ack->>'status' IS DISTINCT FROM 'scheduled'
    OR v_schedule_ack->>'user_id' IS DISTINCT FROM p_user_id::text
    OR (v_schedule_ack->>'deletion_scheduled_at')::timestamptz
      IS DISTINCT FROM p_scheduled_at
    OR v_schedule_ack->>'stripe_customer_id'
      IS DISTINCT FROM p_stripe_customer_id
    OR ARRAY(
      SELECT pg_catalog.jsonb_array_elements_text(
        v_schedule_ack->'stripe_subscription_ids'
      )
    ) IS DISTINCT FROM v_normalized_subscription_ids
  THEN
    RAISE EXCEPTION 'account deletion schedule returned an invalid acknowledgement';
  END IF;

  v_deleted_at := (v_schedule_ack->>'deleted_at')::timestamptz;
  v_now := pg_catalog.clock_timestamp();
  IF v_deleted_at IS NULL OR p_scheduled_at <= v_deleted_at THEN
    RAISE EXCEPTION 'account deletion schedule returned invalid timestamps';
  END IF;

  INSERT INTO public.account_deletion_billing_operations (
    operation_id,
    user_id,
    state,
    recovery_token_hash,
    deletion_scheduled_at,
    deleted_at,
    stripe_customer_id,
    stripe_subscription_ids,
    prepared_at,
    updated_at
  ) VALUES (
    p_operation_id,
    p_user_id,
    'prepared',
    p_recovery_token_hash,
    p_scheduled_at,
    v_deleted_at,
    p_stripe_customer_id,
    v_normalized_subscription_ids,
    v_now,
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'prepared',
    'operation_id', p_operation_id,
    'user_id', p_user_id,
    'deleted_at', v_deleted_at,
    'deletion_scheduled_at', p_scheduled_at,
    'stripe_customer_id', p_stripe_customer_id,
    'stripe_subscription_ids', v_normalized_subscription_ids
  );
END
$function$;

ALTER FUNCTION public.prepare_account_deletion_billing_atomic(
  uuid, uuid, text, timestamptz, text, text, text[]
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prepare_account_deletion_billing_atomic(
  uuid, uuid, text, timestamptz, text, text, text[]
) FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.prepare_account_deletion_billing_atomic(
  uuid, uuid, text, timestamptz, text, text, text[]
) TO service_role;

CREATE FUNCTION public.finish_account_deletion_billing_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_operation public.account_deletion_billing_operations%ROWTYPE;
  v_normalized_subscription_ids text[];
  v_subscription_id text;
  v_now timestamptz;
  v_profile_deleted_at timestamptz;
  v_profile_scheduled_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(candidate.subscription_id ORDER BY candidate.subscription_id),
    ARRAY[]::text[]
  )
  INTO v_normalized_subscription_ids
  FROM (
    SELECT DISTINCT supplied.subscription_id
    FROM pg_catalog.unnest(
      COALESCE(p_stripe_subscription_ids, ARRAY[]::text[])
    ) AS supplied(subscription_id)
  ) AS candidate;

  IF p_user_id IS NULL
    OR p_operation_id IS NULL
    OR p_stripe_subscription_ids IS NULL
    OR pg_catalog.cardinality(p_stripe_subscription_ids) > 1000
    OR p_stripe_subscription_ids IS DISTINCT FROM v_normalized_subscription_ids
    OR (
      p_stripe_customer_id IS NULL
      AND pg_catalog.cardinality(v_normalized_subscription_ids) > 0
    )
    OR (
      p_stripe_customer_id IS NOT NULL
      AND (
        pg_catalog.btrim(p_stripe_customer_id) IS DISTINCT FROM p_stripe_customer_id
        OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_stripe_customer_id) > 255
      )
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(v_normalized_subscription_ids) AS supplied(subscription_id)
      WHERE supplied.subscription_id IS NULL
        OR pg_catalog.btrim(supplied.subscription_id) IS DISTINCT FROM supplied.subscription_id
        OR supplied.subscription_id !~ '^sub_[A-Za-z0-9_]+$'
        OR pg_catalog.length(supplied.subscription_id) > 255
    )
  THEN
    RAISE EXCEPTION 'invalid account deletion billing finish input'
      USING ERRCODE = '22023';
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
  IF p_stripe_customer_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-customer-owner:' || p_stripe_customer_id,
        0
      )
    );
  END IF;
  FOREACH v_subscription_id IN ARRAY v_normalized_subscription_ids
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'api-tier-stripe-subscription:false:' || v_subscription_id,
        0
      )
    );
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'api-tier-stripe-subscription:true:' || v_subscription_id,
        0
      )
    );
  END LOOP;

  SELECT operation.*
  INTO v_operation
  FROM public.account_deletion_billing_operations AS operation
  WHERE operation.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'absent',
      'operation_id', p_operation_id,
      'user_id', p_user_id
    );
  END IF;
  IF v_operation.user_id IS DISTINCT FROM p_user_id
    OR v_operation.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
  THEN
    RAISE EXCEPTION 'account deletion billing finish identity conflict'
      USING ERRCODE = '23505';
  END IF;
  IF v_operation.state = 'settled' THEN
    IF v_operation.stripe_subscription_ids IS DISTINCT FROM v_normalized_subscription_ids THEN
      RAISE EXCEPTION 'settled account deletion billing identity changed'
        USING ERRCODE = '23505';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'settled',
      'operation_id', v_operation.operation_id,
      'user_id', v_operation.user_id,
      'stripe_customer_id', v_operation.stripe_customer_id,
      'stripe_subscription_ids', v_operation.stripe_subscription_ids
    );
  END IF;
  IF NOT v_operation.stripe_subscription_ids <@ v_normalized_subscription_ids THEN
    RAISE EXCEPTION 'account deletion billing finish omitted prepared subscriptions'
      USING ERRCODE = '22023';
  END IF;

  SELECT profile.deleted_at, profile.deletion_scheduled_at
  INTO v_profile_deleted_at, v_profile_scheduled_at
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_profile_deleted_at IS DISTINCT FROM v_operation.deleted_at
    OR v_profile_scheduled_at IS DISTINCT FROM v_operation.deletion_scheduled_at
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'invalid',
      'operation_id', p_operation_id,
      'user_id', p_user_id
    );
  END IF;

  INSERT INTO public.api_tier_subscription_blocks (
    livemode,
    stripe_subscription_id,
    block_kind,
    user_id,
    stripe_customer_id
  )
  SELECT
    mode_value.livemode,
    supplied.subscription_id,
    'account_deletion',
    p_user_id,
    p_stripe_customer_id
  FROM pg_catalog.unnest(v_normalized_subscription_ids) AS supplied(subscription_id)
  CROSS JOIN (VALUES (false), (true)) AS mode_value(livemode)
  ON CONFLICT (livemode, stripe_subscription_id, block_kind) DO NOTHING;

  UPDATE public.api_tier_subscription_blocks AS block
  SET stripe_customer_id = p_stripe_customer_id
  WHERE block.block_kind = 'account_deletion'
    AND block.stripe_subscription_id = ANY(v_normalized_subscription_ids)
    AND block.user_id = p_user_id
    AND block.stripe_customer_id IS NULL
    AND p_stripe_customer_id IS NOT NULL;

  IF EXISTS (
    SELECT 1
    FROM public.api_tier_subscription_blocks AS block
    WHERE block.block_kind = 'account_deletion'
      AND block.stripe_subscription_id = ANY(v_normalized_subscription_ids)
      AND (
        block.user_id <> p_user_id
        OR block.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      )
  ) THEN
    RAISE EXCEPTION 'account deletion billing block identity drifted'
      USING ERRCODE = '40001';
  END IF;

  UPDATE public.subscriptions AS subscription
  SET status = 'canceled',
      cancel_at_period_end = false,
      updated_at = pg_catalog.clock_timestamp()
  WHERE subscription.user_id = p_user_id
    AND subscription.stripe_subscription_id = ANY(v_normalized_subscription_ids);

  v_now := pg_catalog.clock_timestamp();
  UPDATE public.account_deletion_billing_operations AS operation
  SET state = 'settled',
      stripe_subscription_ids = v_normalized_subscription_ids,
      settled_at = v_now,
      updated_at = v_now
  WHERE operation.operation_id = p_operation_id
    AND operation.user_id = p_user_id
    AND operation.state = 'prepared';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account deletion billing finish lost prepared ownership';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'settled',
    'operation_id', p_operation_id,
    'user_id', p_user_id,
    'stripe_customer_id', p_stripe_customer_id,
    'stripe_subscription_ids', v_normalized_subscription_ids
  );
END
$function$;

ALTER FUNCTION public.finish_account_deletion_billing_atomic(
  uuid, uuid, text, text[]
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finish_account_deletion_billing_atomic(
  uuid, uuid, text, text[]
) FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.finish_account_deletion_billing_atomic(
  uuid, uuid, text, text[]
) TO service_role;

-- The wrapper already owns the shared recovery advisory lock. A prepared
-- billing operation is an exact, durable deletion intent and recovery must
-- wait until its remote cancellation has converged.
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
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM public.account_deletion_billing_operations AS operation
    WHERE operation.user_id = p_user_id
      AND operation.state = 'prepared'
    FOR UPDATE
  ) THEN
    RETURN 'busy';
  END IF;

  RETURN public.claim_account_recovery_admission_atomic_locked_impl(
    p_user_id,
    p_recovery_token_hash,
    p_operation_id
  );
END
$function$;

ALTER FUNCTION public.claim_account_recovery_admission_atomic(uuid, text, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_account_recovery_admission_atomic(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.claim_account_recovery_admission_atomic(uuid, text, uuid)
  TO service_role;

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

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  v_now := pg_catalog.clock_timestamp();

  IF EXISTS (
    SELECT 1
    FROM public.account_deletion_billing_operations AS operation
    WHERE operation.user_id = p_user_id
      AND operation.state = 'prepared'
    FOR UPDATE
  ) THEN
    v_status := 'billing_settlement_in_progress';
  ELSE
    SELECT profile.deleted_at, profile.deletion_scheduled_at
    INTO v_deleted_at, v_deletion_scheduled_at
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

COMMENT ON TABLE public.account_deletion_billing_operations IS
  'Durable Stripe settlement intent written atomically with a recoverable account-deletion tombstone.';
COMMENT ON FUNCTION public.prepare_account_deletion_billing_atomic(
  uuid, uuid, text, timestamptz, text, text, text[]
) IS
  'Creates the recoverable tombstone and billing blocks before any irreversible Stripe mutation.';
COMMENT ON FUNCTION public.finish_account_deletion_billing_atomic(
  uuid, uuid, text, text[]
) IS
  'Atomically seals the exact remotely settled subscription set and releases account recovery.';

DO $postflight$
DECLARE
  v_table regclass :=
    'public.account_deletion_billing_operations'::regclass;
  v_prepare regprocedure :=
    'public.prepare_account_deletion_billing_atomic(uuid,uuid,text,timestamp with time zone,text,text,text[])'::regprocedure;
  v_finish regprocedure :=
    'public.finish_account_deletion_billing_atomic(uuid,uuid,text,text[])'::regprocedure;
  v_claim regprocedure :=
    'public.claim_account_recovery_admission_atomic(uuid,text,uuid)'::regprocedure;
  v_hard_delete regprocedure :=
    'public.admit_expired_account_hard_delete_atomic(uuid)'::regprocedure;
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service_role oid := pg_catalog.to_regrole('service_role');
BEGIN
  IF v_postgres IS NULL OR v_service_role IS NULL THEN
    RAISE EXCEPTION 'account deletion billing intent roles are missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_table
      AND relation.relowner = v_postgres
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'account deletion billing operation table security drifted';
  END IF;
  IF NOT pg_catalog.has_table_privilege(v_service_role, v_table, 'SELECT')
    OR pg_catalog.has_table_privilege('authenticated', v_table, 'SELECT')
    OR pg_catalog.has_table_privilege('anon', v_table, 'SELECT')
  THEN
    RAISE EXCEPTION 'account deletion billing operation table ACL drifted';
  END IF;
  IF NOT pg_catalog.has_function_privilege(v_service_role, v_prepare, 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(v_service_role, v_finish, 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(v_service_role, v_claim, 'EXECUTE')
    OR NOT pg_catalog.has_function_privilege(v_service_role, v_hard_delete, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', v_prepare, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', v_finish, 'EXECUTE')
    OR pg_catalog.has_function_privilege('anon', v_prepare, 'EXECUTE')
    OR pg_catalog.has_function_privilege('anon', v_finish, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'account deletion billing operation function ACL drifted';
  END IF;
END
$postflight$;
