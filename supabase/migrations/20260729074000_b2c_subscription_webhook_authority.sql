-- Exact signed-event authority for ordinary B2C recurring Pro webhooks.
--
-- This layer keeps Stripe event/mode identity beside the existing immutable
-- payment and subscription-state ledgers.  A state event received before its
-- payment authority remains pending and is replayed transactionally by the
-- later payment/trial activation, so Stripe's out-of-order delivery cannot
-- resurrect an already canceled subscription.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';
SET LOCAL idle_in_transaction_session_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $preflight$
DECLARE
  v_missing text;
BEGIN
  SELECT pg_catalog.string_agg(required_role, ', ' ORDER BY required_role)
  INTO v_missing
  FROM (
    VALUES ('postgres'::text), ('anon'), ('authenticated'), ('service_role'), ('authenticator')
  ) AS required(required_role)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required.required_role
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing required Supabase roles: %', v_missing;
  END IF;

  IF pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.subscriptions') IS NULL
    OR pg_catalog.to_regclass('public.payment_history') IS NULL
    OR pg_catalog.to_regclass('public.stripe_subscription_state_events') IS NULL
    OR pg_catalog.to_regclass('public.pro_membership_checkout_reservations') IS NULL
    OR pg_catalog.to_regclass('public.stripe_entitlement_payments') IS NULL
    OR pg_catalog.to_regclass('public.stripe_payment_ownerships') IS NULL
    OR pg_catalog.to_regclass('public.stripe_entitlement_effects') IS NULL
    OR pg_catalog.to_regclass('public.stripe_trial_entitlements') IS NULL
    OR pg_catalog.to_regclass('public.account_recovery_admissions') IS NULL
    OR pg_catalog.to_regclass('public.account_deletion_auth_fences') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.activate_recurring_entitlement_payment_atomic(uuid,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.activate_recurring_trial_entitlement_atomic(uuid,text,text,text,timestamp with time zone,timestamp with time zone,text)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.reconcile_recurring_subscription_state_atomic(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.record_stripe_manual_review_atomic(text,text,uuid,text,text,jsonb)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.bind_stripe_customer_owner_atomic(uuid,text,text)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.reserve_lifetime_membership_spot_atomic(uuid,text,integer)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.bind_lifetime_membership_reservation_session_atomic(uuid,uuid,text,text,timestamp with time zone)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.release_lifetime_membership_reservation_atomic(uuid,uuid,text,text,text,text,timestamp with time zone)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.reserve_api_tier_checkout_atomic(uuid,boolean,text,text,text)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.bind_api_tier_checkout_session_atomic(uuid,uuid,boolean,text,text,text,text,bigint)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.reserve_tip_checkout_atomic(uuid,uuid,bigint,text,integer)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.bind_tip_checkout_session_atomic(uuid,uuid,text,timestamp with time zone)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.stripe_payment_ownership_is_exact_v2(uuid)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.stripe_merge_charge_refund_tombstone_v2(uuid)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.stripe_entitlement_effect_is_current_v2(uuid)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.lease_stripe_entitlement_effects_atomic(integer,integer)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)'
    ) IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid =
          'public.stripe_entitlement_payments'::pg_catalog.regclass
        AND trigger_row.tgname =
          'trg_stripe_entitlement_financial_owner_immutable'
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
    )
  THEN
    RAISE EXCEPTION 'B2C webhook authority dependencies are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('pro_membership_checkout_reservations'::text, 'unit_amount'::text, 'bigint'::text, true),
        ('pro_membership_checkout_reservations', 'currency', 'text', true)
    ) AS required(table_name, column_name, data_type, is_not_null)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass('public.' || required.table_name)
        AND attribute.attname = required.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) = required.data_type
        AND attribute.attnotnull = required.is_not_null
    )
  ) THEN
    RAISE EXCEPTION 'B2C webhook authority reservation amount contract drifted';
  END IF;

  IF pg_catalog.to_regclass('public.stripe_b2c_invoice_events') IS NOT NULL
    OR pg_catalog.to_regclass('public.stripe_b2c_recurring_activations') IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = function_row.pronamespace
      WHERE namespace.nspname = 'public'
        AND function_row.proname IN (
          'record_b2c_recurring_manual_review_atomic',
          'prevent_b2c_financial_owner_mutation',
          'enforce_stripe_cancel_dispatch_protocol',
          'prevent_stripe_cancel_dispatch_marker_mutation',
          'review_lifetime_refund_after_cancel_dispatch',
          'claim_stripe_subscription_cancel_dispatch_atomic',
          'classify_recurring_invoice_product_authority_atomic',
          'has_b2c_recurring_financial_owner_atomic',
          'resolve_b2c_recurring_price_authority',
          'claim_pro_membership_checkout_recovery_candidates',
          'reconcile_b2c_subscription_state_core_atomic',
          'reconcile_b2c_subscription_event_atomic',
          'drain_pending_b2c_subscription_events_atomic',
          'check_b2c_activation_reservation_atomic',
          'observe_b2c_recurring_activation_atomic',
          'activate_b2c_recurring_payment_atomic',
          'activate_b2c_recurring_trial_atomic',
          'activate_and_reconcile_b2c_recurring_trial_event_atomic',
          'apply_b2c_recurring_invoice_event_atomic'
        )
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgname IN (
        'trg_stripe_b2c_invoice_owner_immutable',
        'trg_stripe_b2c_activation_owner_immutable',
        'trg_stripe_trial_owner_immutable',
        'trg_payment_history_owner_immutable',
        'trg_stripe_cancel_dispatch_protocol',
        'trg_stripe_cancel_dispatch_marker_immutable',
        'trg_lifetime_refund_after_cancel_dispatch_review'
      )
        AND NOT trigger_row.tgisinternal
    )
    OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          ('stripe_subscription_state_events'::text, 'livemode'::text),
          ('stripe_subscription_state_events', 'stripe_event_id'),
          ('stripe_subscription_state_events', 'stripe_price_id'),
          ('stripe_subscription_state_events', 'expected_amount'),
          ('stripe_subscription_state_events', 'currency'),
          ('payment_history', 'stripe_customer_id'),
          ('payment_history', 'stripe_subscription_id'),
          ('payment_history', 'stripe_invoice_payment_id'),
          ('payment_history', 'stripe_charge_id'),
          ('payment_history', 'stripe_price_id'),
          ('payment_history', 'stripe_event_id'),
          ('payment_history', 'stripe_event_created_at'),
          ('payment_history', 'livemode'),
          ('stripe_entitlement_effects', 'dispatch_committed_at')
      ) AS target(table_name, column_name)
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = pg_catalog.to_regclass('public.' || target.table_name)
       AND attribute.attname = target.column_name
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
    )
  THEN
    RAISE EXCEPTION 'B2C webhook authority target objects already exist';
  END IF;
END
$preflight$;

-- Deployment fence: a pre-protocol worker may already hold a cancellation in
-- memory and cannot be stopped by a database check after the external call.
-- Serialize the cutover against leasing and refuse migration while any old
-- cancellation lease is in flight. The deploy retries only after the worker
-- has finished or its recovery loop has cleared that processing row.
-- Take the shared official-group fence first, then the recovery-admission
-- table fence, before profiles and effects.  That is the common writer order
-- used by recovery, activation, refund, and effect-claim transactions.  It
-- lets pre-existing writers finish, blocks new ones, and prevents an
-- admission/profile/effect migration deadlock. Production deployment still
-- drains webhook/effect workers first.
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('pro-official-group-assignment', 0)
);
LOCK TABLE public.account_recovery_admissions IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.user_profiles IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.stripe_entitlement_effects IN ACCESS EXCLUSIVE MODE;
DO $cancel_worker_cutover_fence$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.stripe_entitlement_effects AS effect
    WHERE effect.effect_type = 'stripe_subscription_cancel'
      AND (
        effect.status = 'processing'
        OR (
          effect.attempt_count > 0
          AND effect.status <> 'completed'
        )
      )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'cannot install cancellation dispatch protocol while a legacy cancellation has an unknown external result; drain workers and reconcile the Stripe Subscription first';
  END IF;
END
$cancel_worker_cutover_fence$;

DO $preserve_trial_owner$
DECLARE
  v_user_attnum smallint;
  v_constraint record;
BEGIN
  SELECT attribute.attnum INTO v_user_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.stripe_trial_entitlements'::pg_catalog.regclass
    AND attribute.attname = 'user_id'
    AND attribute.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped
    AND attribute.attnotnull;
  IF v_user_attnum IS NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.stripe_trial_entitlements'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND v_user_attnum = ANY(constraint_row.conkey)
      AND (
        constraint_row.conkey IS DISTINCT FROM ARRAY[v_user_attnum]::smallint[]
        OR constraint_row.confrelid IS DISTINCT FROM 'public.user_profiles'::pg_catalog.regclass
        OR constraint_row.confkey IS DISTINCT FROM ARRAY[
          (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = 'public.user_profiles'::pg_catalog.regclass
              AND attribute.attname = 'id'
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
          )
        ]::smallint[]
        OR constraint_row.confdeltype IS DISTINCT FROM 'c'::"char"
        OR NOT constraint_row.convalidated
      )
  ) THEN
    RAISE EXCEPTION 'Stripe trial financial owner constraint drifted';
  END IF;

  FOR v_constraint IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.stripe_trial_entitlements'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[v_user_attnum]::smallint[]
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.stripe_trial_entitlements DROP CONSTRAINT %I',
      v_constraint.conname
    );
  END LOOP;
END
$preserve_trial_owner$;

DO $preserve_payment_history_owner$
DECLARE
  v_user_attnum smallint;
  v_constraint record;
BEGIN
  SELECT attribute.attnum INTO v_user_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.payment_history'::pg_catalog.regclass
    AND attribute.attname = 'user_id'
    AND attribute.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  IF v_user_attnum IS NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.payment_history'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND v_user_attnum = ANY(constraint_row.conkey)
      AND (
        constraint_row.conkey IS DISTINCT FROM ARRAY[v_user_attnum]::smallint[]
        OR constraint_row.confrelid NOT IN (
          'public.user_profiles'::pg_catalog.regclass,
          'auth.users'::pg_catalog.regclass
        )
        OR constraint_row.confdeltype IS DISTINCT FROM 'n'::"char"
        OR NOT constraint_row.convalidated
      )
  ) THEN
    RAISE EXCEPTION 'payment history financial owner constraint drifted';
  END IF;

  FOR v_constraint IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.payment_history'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[v_user_attnum]::smallint[]
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.payment_history DROP CONSTRAINT %I',
      v_constraint.conname
    );
  END LOOP;
END
$preserve_payment_history_owner$;

-- The historical constraint predates Stripe's complete Subscription state
-- machine.  Persist every canonical Stripe status so terminal and suspended
-- events cannot roll back the authority transaction with CHECK violation.
ALTER TABLE public.subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_status_check;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_status_check CHECK (
    status IN (
      'active', 'trialing', 'past_due', 'canceled', 'cancelled', 'expired',
      'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    )
  );

ALTER TABLE public.stripe_subscription_state_events
  ADD COLUMN livemode boolean,
  ADD COLUMN stripe_event_id text,
  ADD COLUMN stripe_price_id text,
  ADD COLUMN expected_amount bigint,
  ADD COLUMN currency text;

CREATE UNIQUE INDEX stripe_subscription_state_events_signed_mode_key
  ON public.stripe_subscription_state_events (livemode, stripe_event_id)
  WHERE livemode IS NOT NULL AND stripe_event_id IS NOT NULL;

ALTER TABLE public.payment_history
  ADD COLUMN stripe_customer_id text,
  ADD COLUMN stripe_subscription_id text,
  ADD COLUMN stripe_invoice_payment_id text,
  ADD COLUMN stripe_charge_id text,
  ADD COLUMN stripe_price_id text,
  ADD COLUMN stripe_event_id text,
  ADD COLUMN stripe_event_created_at timestamptz,
  ADD COLUMN livemode boolean;

ALTER TABLE public.stripe_entitlement_effects
  ADD COLUMN dispatch_committed_at timestamptz;

-- Product-completion refunds use the same durable effect queue without
-- pretending that a Tip, Group pass, or API purchase is a Pro entitlement.
-- The UUID ledger key is the immutable product-row identity; no nullable
-- entitlement payment is allowed to masquerade as its source.
ALTER TABLE public.stripe_entitlement_effects
  DROP CONSTRAINT stripe_entitlement_effects_source_check,
  ADD CONSTRAINT stripe_entitlement_effects_source_check CHECK (
    (
      source_kind = 'payment'
      AND entitlement_payment_id IS NOT NULL
      AND source_key = entitlement_payment_id::text
    )
    OR (
      source_kind = 'trial'
      AND entitlement_payment_id IS NULL
      AND pg_catalog.left(source_key, 6) = 'trial:'
    )
    OR (
      source_kind = 'projection'
      AND entitlement_payment_id IS NULL
      AND (
        (user_id IS NOT NULL AND source_key = user_id::text)
        OR (
          user_id IS NULL
          AND source_key ~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        )
      )
    )
    OR (
      source_kind IN ('tip_payment', 'group_payment', 'api_payment')
      AND entitlement_payment_id IS NULL
      AND source_key ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    )
  );

-- Stripe mode is part of every new financial authority. NULL is historical
-- only and is deliberately ineligible for recovery-period dispatch.
ALTER TABLE public.tips
  ADD COLUMN livemode boolean;
ALTER TABLE public.group_payment_consumptions
  ADD COLUMN livemode boolean;

-- A recovery-period payment is financially complete but must never be
-- represented as a delivered Tip.  The dedicated terminal state suppresses
-- notification delivery while its durable refund effect is outstanding.
ALTER TABLE public.tips
  DROP CONSTRAINT tips_status_check,
  ADD CONSTRAINT tips_status_check CHECK (
    status IN (
      'pending', 'completed', 'failed', 'refunded', 'identity_conflict',
      'refund_pending'
    )
  );

-- New lifetime reservations bind the Stripe account mode before a payable
-- Checkout Session is returned.  NULL is retained only for pre-cutover rows;
-- their later activation is fail-closed unless a verified signed Session
-- supplies and atomically binds the missing mode.
ALTER TABLE public.stripe_lifetime_seat_reservations
  ADD COLUMN livemode boolean;

-- Recovery billing is an external Stripe read followed by a local projection
-- commit. Freeze the exact product targets before that read and persist the
-- product-level result so a crash/replay cannot fall back to the historical
-- cross-product boolean acknowledgement.
ALTER TABLE public.account_recovery_admissions
  ADD COLUMN recovery_billing_target_snapshot jsonb,
  ADD COLUMN recovery_billing_target_digest text,
  ADD COLUMN recovery_billing_v2_result jsonb,
  ADD COLUMN recovery_billing_completed_at timestamptz,
  ADD CONSTRAINT account_recovery_billing_target_v2_shape CHECK (
    (
      recovery_billing_target_snapshot IS NULL
      AND recovery_billing_target_digest IS NULL
    )
    OR (
      recovery_billing_target_snapshot IS NOT NULL
      AND recovery_billing_target_digest IS NOT NULL
      AND pg_catalog.jsonb_typeof(recovery_billing_target_snapshot) = 'object'
      AND recovery_billing_target_digest ~ '^[0-9a-f]{64}$'
    )
  ),
  ADD CONSTRAINT account_recovery_billing_result_v2_shape CHECK (
    recovery_billing_v2_result IS NULL
    OR pg_catalog.jsonb_typeof(recovery_billing_v2_result) = 'object'
  );

-- A lifetime purchase replaces the single canonical subscriptions row.  Keep
-- the exact recurring authority which was present immediately before that
-- replacement in a financial-owner-retained table.  The immutable columns are
-- the only authority a later full lifetime refund may restore; neither the
-- mutable profile nor the overwritten subscriptions row is evidence.
CREATE OR REPLACE FUNCTION public.uuid_array_is_sorted_unique_v2(
  p_ids uuid[]
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT p_ids IS NOT NULL
    AND pg_catalog.array_position(p_ids, NULL::uuid) IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM (
        SELECT
          item.id,
          pg_catalog.lag(item.id) OVER (ORDER BY item.ordinality) AS prior_id
        FROM pg_catalog.unnest(p_ids) WITH ORDINALITY AS item(id, ordinality)
      ) AS ordered_ids
      WHERE ordered_ids.prior_id IS NOT NULL
        AND ordered_ids.id <= ordered_ids.prior_id
    )
$function$;

ALTER FUNCTION public.uuid_array_is_sorted_unique_v2(uuid[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.uuid_array_is_sorted_unique_v2(uuid[]) FROM PUBLIC;

-- PostgreSQL exposes jsonb_object_keys(), but no jsonb_object_length(). Keep
-- exact object-shape validation behind a real immutable primitive instead of
-- referring to a nonexistent pg_catalog function from delayed PL/pgSQL paths.
CREATE OR REPLACE FUNCTION public.jsonb_object_key_count_v2(p_value jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT CASE
    WHEN pg_catalog.jsonb_typeof(p_value) = 'object' THEN (
      SELECT pg_catalog.count(*)::integer
      FROM pg_catalog.jsonb_object_keys(p_value)
    )
    ELSE NULL::integer
  END
$function$;

ALTER FUNCTION public.jsonb_object_key_count_v2(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.jsonb_object_key_count_v2(jsonb) FROM PUBLIC;

CREATE TABLE public.stripe_lifetime_superseded_authorities (
  lifetime_payment_id uuid PRIMARY KEY
    REFERENCES public.stripe_entitlement_payments(id) ON DELETE RESTRICT,
  owner_user_id uuid NOT NULL,
  lifetime_livemode boolean NOT NULL,
  livemode boolean,
  authority_kind text NOT NULL,
  subscription_row_id uuid NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  stripe_price_id text,
  plan text NOT NULL,
  expected_amount bigint,
  currency text,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  subscription_status text NOT NULL,
  cancel_at_period_end boolean NOT NULL,
  recurring_payment_id uuid,
  trial_id uuid,
  trial_verified_at timestamptz,
  legacy_grant_id uuid,
  retry_grace_grant_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  activation_event_id text,
  activation_event_created_at timestamptz,
  activation_committed_at timestamptz,
  subscription_snapshot jsonb NOT NULL,
  snapshot_digest text NOT NULL,
  state text NOT NULL DEFAULT 'cancel_pending',
  cancellation_effect_id uuid UNIQUE
    REFERENCES public.stripe_entitlement_effects(id) ON DELETE RESTRICT,
  restore_effect_id uuid UNIQUE
    REFERENCES public.stripe_entitlement_effects(id) ON DELETE RESTRICT,
  refund_event_id text,
  cancel_dispatch_committed_at timestamptz,
  restored_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_lifetime_superseded_authority_kind_check CHECK (
    authority_kind IN (
      'committed_paid', 'committed_trial',
      'legacy_paid', 'legacy_trial', 'legacy_snapshot'
    )
  ),
  CONSTRAINT stripe_lifetime_superseded_identity_check CHECK (
    stripe_customer_id = pg_catalog.btrim(stripe_customer_id)
    AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_customer_id) <= 255
    AND stripe_subscription_id = pg_catalog.btrim(stripe_subscription_id)
    AND stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_subscription_id) <= 255
    AND (
      stripe_price_id IS NULL
      OR (
        stripe_price_id = pg_catalog.btrim(stripe_price_id)
        AND stripe_price_id ~ '^price_[A-Za-z0-9_]+$'
        AND pg_catalog.length(stripe_price_id) <= 255
      )
    )
    AND (
      activation_event_id IS NULL
      OR (
        activation_event_id = pg_catalog.btrim(activation_event_id)
        AND activation_event_id ~ '^evt_[A-Za-z0-9_]+$'
        AND pg_catalog.length(activation_event_id) <= 255
      )
    )
    AND (
      refund_event_id IS NULL
      OR (
        refund_event_id = pg_catalog.btrim(refund_event_id)
        AND refund_event_id ~ '^evt_[A-Za-z0-9_]+$'
        AND pg_catalog.length(refund_event_id) <= 255
      )
    )
  ),
  CONSTRAINT stripe_lifetime_superseded_product_check CHECK (
    plan IN ('monthly', 'yearly')
    AND period_end > period_start
    AND subscription_status IN (
      'active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused'
    )
    AND (
      expected_amount IS NULL
      OR expected_amount > 0
    )
    AND (
      currency IS NULL
      OR currency ~ '^[a-z]{3}$'
    )
  ),
  CONSTRAINT stripe_lifetime_superseded_authority_shape_check CHECK (
    (
      authority_kind = 'committed_paid'
      AND livemode IS NOT NULL
      AND livemode = lifetime_livemode
      AND stripe_price_id IS NOT NULL
      AND expected_amount IS NOT NULL
      AND currency IS NOT NULL
      AND recurring_payment_id IS NOT NULL
      AND trial_id IS NULL
      AND trial_verified_at IS NULL
      AND legacy_grant_id IS NULL
      AND activation_event_id IS NOT NULL
      AND activation_event_created_at IS NOT NULL
      AND activation_committed_at IS NOT NULL
    ) OR (
      authority_kind = 'committed_trial'
      AND livemode IS NOT NULL
      AND livemode = lifetime_livemode
      AND stripe_price_id IS NOT NULL
      AND expected_amount IS NOT NULL
      AND currency IS NOT NULL
      AND recurring_payment_id IS NULL
      AND trial_id IS NOT NULL
      AND trial_verified_at IS NOT NULL
      AND legacy_grant_id IS NULL
      AND activation_event_id IS NOT NULL
      AND activation_event_created_at IS NOT NULL
      AND activation_committed_at IS NOT NULL
    ) OR (
      authority_kind = 'legacy_paid'
      AND livemode IS NULL
      AND stripe_price_id IS NULL
      AND expected_amount IS NOT NULL
      AND currency IS NOT NULL
      AND recurring_payment_id IS NOT NULL
      AND trial_id IS NULL
      AND trial_verified_at IS NULL
      AND legacy_grant_id IS NULL
      AND activation_event_id IS NULL
      AND activation_event_created_at IS NULL
      AND activation_committed_at IS NULL
    ) OR (
      authority_kind = 'legacy_trial'
      AND livemode IS NULL
      AND stripe_price_id IS NULL
      AND expected_amount IS NULL
      AND currency IS NULL
      AND recurring_payment_id IS NULL
      AND trial_id IS NOT NULL
      AND trial_verified_at IS NOT NULL
      AND legacy_grant_id IS NULL
      AND activation_event_id IS NULL
      AND activation_event_created_at IS NULL
      AND activation_committed_at IS NULL
    ) OR (
      authority_kind = 'legacy_snapshot'
      AND livemode IS NULL
      AND stripe_price_id IS NULL
      AND expected_amount IS NULL
      AND currency IS NULL
      AND recurring_payment_id IS NULL
      AND trial_id IS NULL
      AND trial_verified_at IS NULL
      AND legacy_grant_id IS NOT NULL
      AND activation_event_id IS NULL
      AND activation_event_created_at IS NULL
      AND activation_committed_at IS NULL
    )
  ),
  CONSTRAINT stripe_lifetime_superseded_snapshot_check CHECK (
    pg_catalog.jsonb_typeof(subscription_snapshot) = 'object'
    AND snapshot_digest ~ '^[0-9a-f]{64}$'
    AND public.uuid_array_is_sorted_unique_v2(retry_grace_grant_ids)
  ),
  CONSTRAINT stripe_lifetime_superseded_state_check CHECK (
    state IN (
      'cancel_pending', 'cancel_dispatched', 'cancel_completed',
      'restore_pending', 'restored', 'absorbed_dispatched',
      'absorbed_completed', 'cancellation_manual_review',
      'restoration_manual_review', 'superseded'
    )
  ),
  CONSTRAINT stripe_lifetime_superseded_lifecycle_check CHECK (
    cancellation_effect_id IS NOT NULL
    AND updated_at >= created_at
    AND (
      (
        state = 'cancel_pending'
        AND restore_effect_id IS NULL
        AND refund_event_id IS NULL
        AND cancel_dispatch_committed_at IS NULL
        AND restored_at IS NULL
      ) OR (
        state IN ('cancel_dispatched', 'cancel_completed')
        AND restore_effect_id IS NULL
        AND refund_event_id IS NULL
        AND cancel_dispatch_committed_at IS NOT NULL
        AND cancel_dispatch_committed_at >= created_at
        AND restored_at IS NULL
      ) OR (
        state IN ('absorbed_dispatched', 'absorbed_completed')
        AND restore_effect_id IS NULL
        AND refund_event_id IS NOT NULL
        AND cancel_dispatch_committed_at IS NOT NULL
        AND cancel_dispatch_committed_at >= created_at
        AND restored_at IS NULL
      ) OR (
        state IN ('restore_pending', 'restoration_manual_review', 'superseded')
        AND restore_effect_id IS NOT NULL
        AND refund_event_id IS NOT NULL
        AND cancel_dispatch_committed_at IS NULL
        AND restored_at IS NULL
      ) OR (
        state = 'restored'
        AND restore_effect_id IS NOT NULL
        AND refund_event_id IS NOT NULL
        AND cancel_dispatch_committed_at IS NULL
        AND restored_at IS NOT NULL
        AND restored_at >= created_at
      ) OR (
        state = 'cancellation_manual_review'
        AND restore_effect_id IS NULL
        AND refund_event_id IS NULL
        AND restored_at IS NULL
      )
    )
  )
);

CREATE INDEX stripe_lifetime_superseded_restore_pending_idx
  ON public.stripe_lifetime_superseded_authorities (updated_at, lifetime_payment_id)
  WHERE state = 'restore_pending';

ALTER TABLE public.stripe_lifetime_superseded_authorities OWNER TO postgres;
ALTER TABLE public.stripe_lifetime_superseded_authorities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_lifetime_superseded_authorities FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_lifetime_superseded_authorities
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.stripe_lifetime_superseded_authority_digest_v2(
  p_snapshot public.stripe_lifetime_superseded_authorities
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
RETURNS NULL ON NULL INPUT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
          'lifetime_payment_id', p_snapshot.lifetime_payment_id,
          'owner_user_id', p_snapshot.owner_user_id,
          'lifetime_livemode', p_snapshot.lifetime_livemode,
          'livemode', p_snapshot.livemode,
          'authority_kind', p_snapshot.authority_kind,
          'subscription_row_id', p_snapshot.subscription_row_id,
          'stripe_customer_id', p_snapshot.stripe_customer_id,
          'stripe_subscription_id', p_snapshot.stripe_subscription_id,
          'stripe_price_id', p_snapshot.stripe_price_id,
          'plan', p_snapshot.plan,
          'expected_amount', p_snapshot.expected_amount,
          'currency', p_snapshot.currency,
          'period_start', p_snapshot.period_start,
          'period_end', p_snapshot.period_end,
          'subscription_status', p_snapshot.subscription_status,
          'cancel_at_period_end', p_snapshot.cancel_at_period_end,
          'recurring_payment_id', p_snapshot.recurring_payment_id,
          'trial_id', p_snapshot.trial_id,
          'trial_verified_at', p_snapshot.trial_verified_at,
          'legacy_grant_id', p_snapshot.legacy_grant_id,
          'retry_grace_grant_ids',
            pg_catalog.to_jsonb(p_snapshot.retry_grace_grant_ids),
          'activation_event_id', p_snapshot.activation_event_id,
          'activation_event_created_at',
            p_snapshot.activation_event_created_at,
          'activation_committed_at', p_snapshot.activation_committed_at,
          'subscription_snapshot', p_snapshot.subscription_snapshot
        )::text,
        'UTF8'
      )
    ),
    'hex'
  )
$function$;

ALTER FUNCTION public.stripe_lifetime_superseded_authority_digest_v2(
  public.stripe_lifetime_superseded_authorities
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_lifetime_superseded_authority_digest_v2(
  public.stripe_lifetime_superseded_authorities
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.stripe_lifetime_superseded_authority_is_exact_v2(
  p_snapshot public.stripe_lifetime_superseded_authorities
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
RETURNS NULL ON NULL INPUT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_keys text[];
  v_api_calls bigint;
  v_comparison_reports bigint;
  v_exports bigint;
  v_created_at timestamptz;
  v_updated_at timestamptz;
  v_nullable_key text;
BEGIN
  SELECT pg_catalog.array_agg(object_key ORDER BY object_key)
  INTO v_keys
  FROM pg_catalog.jsonb_object_keys(p_snapshot.subscription_snapshot)
    AS object_key;

  IF v_keys IS DISTINCT FROM ARRAY[
      'api_calls_reset_at', 'api_calls_today', 'cancel_at_period_end',
      'canceled_at', 'comparison_reports_this_month', 'created_at',
      'current_period_end', 'current_period_start',
      'entitlement_payment_id', 'entitlement_trial_id',
      'entitlement_trial_verified_at', 'exports_this_month', 'id', 'plan',
      'status', 'stripe_customer_id', 'stripe_subscription_id', 'tier',
      'updated_at', 'usage_reset_at', 'user_id'
    ]::text[]
    OR p_snapshot.snapshot_digest IS DISTINCT FROM
      public.stripe_lifetime_superseded_authority_digest_v2(p_snapshot)
    OR p_snapshot.subscription_snapshot -> 'id'
      IS DISTINCT FROM pg_catalog.to_jsonb(p_snapshot.subscription_row_id)
    OR p_snapshot.subscription_snapshot -> 'user_id'
      IS DISTINCT FROM pg_catalog.to_jsonb(p_snapshot.owner_user_id)
    OR p_snapshot.subscription_snapshot -> 'stripe_customer_id'
      IS DISTINCT FROM pg_catalog.to_jsonb(p_snapshot.stripe_customer_id)
    OR p_snapshot.subscription_snapshot -> 'stripe_subscription_id'
      IS DISTINCT FROM pg_catalog.to_jsonb(p_snapshot.stripe_subscription_id)
    OR p_snapshot.subscription_snapshot -> 'status'
      IS DISTINCT FROM pg_catalog.to_jsonb(p_snapshot.subscription_status)
    OR p_snapshot.subscription_snapshot -> 'tier'
      IS DISTINCT FROM pg_catalog.to_jsonb('pro'::text)
    OR p_snapshot.subscription_snapshot -> 'plan'
      IS DISTINCT FROM pg_catalog.to_jsonb(p_snapshot.plan)
    OR p_snapshot.subscription_snapshot -> 'current_period_start'
      IS DISTINCT FROM pg_catalog.to_jsonb(p_snapshot.period_start)
    OR p_snapshot.subscription_snapshot -> 'current_period_end'
      IS DISTINCT FROM pg_catalog.to_jsonb(p_snapshot.period_end)
    OR p_snapshot.subscription_snapshot -> 'cancel_at_period_end'
      IS DISTINCT FROM pg_catalog.to_jsonb(p_snapshot.cancel_at_period_end)
    OR p_snapshot.subscription_snapshot -> 'entitlement_payment_id'
      IS DISTINCT FROM COALESCE(
        pg_catalog.to_jsonb(p_snapshot.recurring_payment_id), 'null'::jsonb
      )
    OR p_snapshot.subscription_snapshot -> 'entitlement_trial_id'
      IS DISTINCT FROM COALESCE(
        pg_catalog.to_jsonb(p_snapshot.trial_id), 'null'::jsonb
      )
    OR p_snapshot.subscription_snapshot -> 'entitlement_trial_verified_at'
      IS DISTINCT FROM COALESCE(
        pg_catalog.to_jsonb(p_snapshot.trial_verified_at), 'null'::jsonb
      )
    OR pg_catalog.jsonb_typeof(
      p_snapshot.subscription_snapshot -> 'api_calls_today'
    ) IS DISTINCT FROM 'number'
    OR pg_catalog.jsonb_typeof(
      p_snapshot.subscription_snapshot -> 'comparison_reports_this_month'
    ) IS DISTINCT FROM 'number'
    OR pg_catalog.jsonb_typeof(
      p_snapshot.subscription_snapshot -> 'exports_this_month'
    ) IS DISTINCT FROM 'number'
    OR pg_catalog.jsonb_typeof(
      p_snapshot.subscription_snapshot -> 'created_at'
    ) IS DISTINCT FROM 'string'
    OR pg_catalog.jsonb_typeof(
      p_snapshot.subscription_snapshot -> 'updated_at'
    ) IS DISTINCT FROM 'string'
    OR p_snapshot.subscription_snapshot ->> 'api_calls_today'
      !~ '^(0|[1-9][0-9]*)$'
    OR p_snapshot.subscription_snapshot ->> 'comparison_reports_this_month'
      !~ '^(0|[1-9][0-9]*)$'
    OR p_snapshot.subscription_snapshot ->> 'exports_this_month'
      !~ '^(0|[1-9][0-9]*)$'
  THEN
    RETURN false;
  END IF;

  v_api_calls := (p_snapshot.subscription_snapshot ->> 'api_calls_today')::bigint;
  v_comparison_reports :=
    (p_snapshot.subscription_snapshot ->> 'comparison_reports_this_month')::bigint;
  v_exports :=
    (p_snapshot.subscription_snapshot ->> 'exports_this_month')::bigint;
  IF v_api_calls < 0
    OR v_comparison_reports < 0
    OR v_exports < 0
  THEN
    RETURN false;
  END IF;

  v_created_at :=
    (p_snapshot.subscription_snapshot ->> 'created_at')::timestamptz;
  v_updated_at :=
    (p_snapshot.subscription_snapshot ->> 'updated_at')::timestamptz;
  IF v_updated_at < v_created_at THEN
    RETURN false;
  END IF;

  -- JSON null and a valid timestamp string are the only nullable timestamp
  -- encodings. Empty strings and scalar coercions are not canonical.
  FOREACH v_nullable_key IN ARRAY ARRAY[
    'api_calls_reset_at', 'canceled_at', 'usage_reset_at'
  ]::text[]
  LOOP
    IF p_snapshot.subscription_snapshot -> v_nullable_key <> 'null'::jsonb
      AND pg_catalog.jsonb_typeof(
        p_snapshot.subscription_snapshot -> v_nullable_key
      ) IS DISTINCT FROM 'string'
    THEN
      RETURN false;
    END IF;
    IF p_snapshot.subscription_snapshot -> v_nullable_key <> 'null'::jsonb THEN
      PERFORM (
        p_snapshot.subscription_snapshot ->> v_nullable_key
      )::timestamptz;
    END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  RETURN false;
END
$function$;

ALTER FUNCTION public.stripe_lifetime_superseded_authority_is_exact_v2(
  public.stripe_lifetime_superseded_authorities
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_lifetime_superseded_authority_is_exact_v2(
  public.stripe_lifetime_superseded_authorities
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.enforce_lifetime_superseded_authority_protocol()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lifetime superseded authority snapshots are retained'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (
      pg_catalog.to_jsonb(NEW)
        - ARRAY[
          'state', 'restore_effect_id', 'refund_event_id',
          'cancel_dispatch_committed_at', 'restored_at', 'updated_at'
        ]::text[]
    ) IS DISTINCT FROM (
      pg_catalog.to_jsonb(OLD)
        - ARRAY[
          'state', 'restore_effect_id', 'refund_event_id',
          'cancel_dispatch_committed_at', 'restored_at', 'updated_at'
        ]::text[]
    ) THEN
      RAISE EXCEPTION 'lifetime superseded authority identity is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state
      AND NOT (
        (OLD.state = 'cancel_pending'
          AND NEW.state IN (
            'cancel_dispatched', 'restore_pending',
            'cancellation_manual_review'
          ))
        OR (OLD.state = 'cancel_dispatched'
          AND NEW.state IN (
            'cancel_completed', 'absorbed_dispatched',
            'cancellation_manual_review'
          ))
        OR (OLD.state = 'cancel_completed'
          AND NEW.state IN ('restore_pending', 'absorbed_completed'))
        OR (OLD.state = 'absorbed_dispatched'
          AND NEW.state = 'absorbed_completed')
        OR (OLD.state = 'restore_pending'
          AND NEW.state IN (
            'restored', 'restoration_manual_review', 'superseded'
          ))
      )
    THEN
      RAISE EXCEPTION 'lifetime superseded authority transition is invalid'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.restore_effect_id IS NOT NULL
      AND NEW.restore_effect_id IS DISTINCT FROM OLD.restore_effect_id
    THEN
      RAISE EXCEPTION 'lifetime restore effect identity is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.refund_event_id IS NOT NULL
      AND NEW.refund_event_id IS DISTINCT FROM OLD.refund_event_id
    THEN
      RAISE EXCEPTION 'lifetime restore refund identity is immutable'
        USING ERRCODE = '23514';
    END IF;
    IF OLD.cancel_dispatch_committed_at IS NOT NULL
      AND NEW.cancel_dispatch_committed_at
        IS DISTINCT FROM OLD.cancel_dispatch_committed_at
    THEN
      RAISE EXCEPTION 'lifetime cancel dispatch boundary is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF NOT public.stripe_lifetime_superseded_authority_is_exact_v2(NEW) THEN
    RAISE EXCEPTION 'lifetime superseded authority snapshot is not exact'
      USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.stripe_entitlement_effects AS effect
    WHERE effect.id = NEW.cancellation_effect_id
      AND effect.entitlement_payment_id = NEW.lifetime_payment_id
      AND effect.user_id = NEW.owner_user_id
      AND effect.source_kind = 'payment'
      AND effect.source_key = NEW.lifetime_payment_id::text
      AND effect.effect_type = 'stripe_subscription_cancel'
      AND effect.operation_key =
        'cancel:subscription:' || NEW.stripe_subscription_id
      AND effect.payload = pg_catalog.jsonb_build_object(
        'stripe_subscription_id', NEW.stripe_subscription_id,
        'stripe_customer_id', NEW.stripe_customer_id,
        'reason', 'lifetime_membership_activated',
        'protocol_version', 'dispatch_commit_v1'
      )
  ) THEN
    RAISE EXCEPTION 'lifetime cancellation effect identity is not exact'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state IN (
      'cancel_dispatched', 'cancel_completed',
      'absorbed_dispatched', 'absorbed_completed'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_effects AS effect
      WHERE effect.id = NEW.cancellation_effect_id
        AND effect.dispatch_committed_at = NEW.cancel_dispatch_committed_at
        AND (
          NEW.state NOT IN ('cancel_completed', 'absorbed_completed')
          OR effect.status = 'completed'
        )
    )
  THEN
    RAISE EXCEPTION 'lifetime cancellation dispatch state is not exact'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.refund_event_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      JOIN public.stripe_entitlement_refund_events AS refund_event
        ON refund_event.entitlement_payment_id = payment.id
      WHERE payment.id = NEW.lifetime_payment_id
        AND payment.payment_kind = 'lifetime'
        AND payment.plan = 'lifetime'
        AND payment.refund_state = 'succeeded'
        AND payment.refund_succeeded_amount >= payment.amount_paid
        AND payment.latest_refund_event_id = NEW.refund_event_id
        AND refund_event.event_id = NEW.refund_event_id
        AND refund_event.refund_state = 'succeeded'
        AND refund_event.refund_succeeded_amount >= payment.amount_paid
        AND refund_event.event_created_at =
          payment.latest_refund_event_created_at
    )
  THEN
    RAISE EXCEPTION 'lifetime restore refund authority is not exact'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state IN (
      'restore_pending', 'restored', 'restoration_manual_review', 'superseded'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_effects AS effect
      WHERE effect.id = NEW.restore_effect_id
        AND effect.entitlement_payment_id = NEW.lifetime_payment_id
        AND effect.user_id = NEW.owner_user_id
        AND effect.source_kind = 'payment'
        AND effect.source_key = NEW.lifetime_payment_id::text
        AND effect.effect_type = 'stripe_lifetime_authority_restore'
        AND effect.operation_key =
          'restore:lifetime_refund:' || NEW.refund_event_id
        AND effect.payload = pg_catalog.jsonb_build_object(
          'snapshot_digest', NEW.snapshot_digest
        )
    )
  THEN
    RAISE EXCEPTION 'lifetime restore effect identity is not exact'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.state = 'restored'
    AND NOT EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_effects AS effect
      WHERE effect.id = NEW.restore_effect_id
        AND effect.status = 'completed'
        AND effect.completed_at IS NOT NULL
        AND effect.external_ref =
          'lifetime-authority-restored:' || NEW.lifetime_payment_id::text
        AND NEW.restored_at = effect.completed_at
    )
  THEN
    RAISE EXCEPTION 'completed lifetime restore effect is not exact'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_lifetime_superseded_authority_protocol()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_lifetime_superseded_authority_protocol()
  FROM PUBLIC;

CREATE TRIGGER trg_lifetime_superseded_authority_protocol
  BEFORE INSERT OR UPDATE OR DELETE
  ON public.stripe_lifetime_superseded_authorities
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_lifetime_superseded_authority_protocol();

UPDATE public.stripe_entitlement_effects
SET payload = payload || pg_catalog.jsonb_build_object(
  'protocol_version', 'dispatch_commit_v1'
)
WHERE effect_type = 'stripe_subscription_cancel';

INSERT INTO public.stripe_manual_reviews (
  object_type, object_id, user_id, action, reason_key, reason, metadata
)
SELECT
  'entitlement_effect', effect.id::text, NULL, 'investigate',
  'legacy_cancel_dead_letter_reopened',
  'A pre-protocol Stripe Subscription cancellation exhausted its retry budget and was reopened under the durable dispatch protocol.',
  pg_catalog.jsonb_build_object(
    'effect_id', effect.id,
    'opaque_owner_user_id', effect.user_id,
    'attempt_count', effect.attempt_count,
    'last_error', effect.last_error
  )
FROM public.stripe_entitlement_effects AS effect
WHERE effect.effect_type = 'stripe_subscription_cancel'
  AND COALESCE(effect.payload ->> 'reason', '') IS DISTINCT FROM
    'lifetime_membership_activated'
  AND (
    effect.status = 'dead_lettered'
    OR (effect.status = 'failed' AND effect.attempt_count >= 10)
  )
ON CONFLICT (object_type, object_id, reason_key) DO NOTHING;

UPDATE public.stripe_entitlement_effects
SET status = 'failed',
    attempt_count = 9,
    lease_token = NULL,
    lease_expires_at = NULL,
    available_at = pg_catalog.clock_timestamp(),
    completed_at = NULL,
    last_error = 'legacy_cancel_retry_reopened',
    updated_at = pg_catalog.clock_timestamp()
WHERE effect_type = 'stripe_subscription_cancel'
  AND COALESCE(payload ->> 'reason', '') IS DISTINCT FROM
    'lifetime_membership_activated'
  AND (
    status = 'dead_lettered'
    OR (status = 'failed' AND attempt_count >= 10)
  );

-- A completed cancellation predates this protocol only if its fenced worker
-- already acknowledged the exact external Subscription. Preserve that
-- durable fact so the additive cutover does not make an already completed
-- cancellation look uncommitted.
UPDATE public.stripe_entitlement_effects
SET dispatch_committed_at = COALESCE(completed_at, updated_at)
WHERE effect_type = 'stripe_subscription_cancel'
  AND status = 'completed'
  AND dispatch_committed_at IS NULL;

-- Historical lifetime writers did not retain the overwritten recurring row,
-- so there is no safe material from which to invent a restoration snapshot.
-- Completed effects retain their irreversible external fact and are reviewed;
-- every uncommitted/pre-protocol effect is terminally superseded instead of
-- being leased forever by a claim function which must reject missing proof.
INSERT INTO public.stripe_manual_reviews (
  object_type, object_id, user_id, action, reason_key, reason, metadata
)
SELECT
  'entitlement_effect', effect.id::text, NULL, 'investigate',
  CASE WHEN effect.status = 'completed'
    THEN 'legacy_lifetime_cancel_completed_without_restore_snapshot'
    ELSE 'legacy_lifetime_cancel_superseded_without_restore_snapshot'
  END,
  CASE WHEN effect.status = 'completed'
    THEN 'A historical lifetime cancellation completed before exact superseded-authority snapshots existed; automatic restoration is prohibited.'
    ELSE 'A historical lifetime cancellation lacked an exact superseded-authority snapshot and was prevented from dispatching.'
  END,
  pg_catalog.jsonb_build_object(
    'effect_id', effect.id,
    'opaque_owner_user_id', effect.user_id,
    'prior_status', effect.status,
    'attempt_count', effect.attempt_count,
    'last_error', effect.last_error,
    'dispatch_committed_at', effect.dispatch_committed_at
  )
FROM public.stripe_entitlement_effects AS effect
WHERE effect.effect_type = 'stripe_subscription_cancel'
  AND effect.payload ->> 'reason' = 'lifetime_membership_activated'
  AND NOT EXISTS (
    SELECT 1
    FROM public.stripe_lifetime_superseded_authorities AS authority
    WHERE authority.cancellation_effect_id = effect.id
  )
ON CONFLICT (object_type, object_id, reason_key) DO NOTHING;

UPDATE public.stripe_entitlement_effects AS effect
SET status = 'superseded',
    lease_token = NULL,
    lease_expires_at = NULL,
    completed_at = COALESCE(effect.completed_at, pg_catalog.clock_timestamp()),
    last_error = 'legacy_lifetime_cancel_missing_restore_snapshot',
    updated_at = pg_catalog.clock_timestamp()
WHERE effect.effect_type = 'stripe_subscription_cancel'
  AND effect.payload ->> 'reason' = 'lifetime_membership_activated'
  AND effect.status <> 'completed'
  AND effect.dispatch_committed_at IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.stripe_lifetime_superseded_authorities AS authority
    WHERE authority.cancellation_effect_id = effect.id
  );

ALTER TABLE public.stripe_entitlement_effects
  ADD CONSTRAINT stripe_entitlement_effects_cancel_dispatch_shape_check
    CHECK (
      dispatch_committed_at IS NULL
      OR (
        effect_type IN (
          'stripe_subscription_cancel',
          'recovery_payment_auto_refund'
        )
        AND dispatch_committed_at >= created_at
      )
    ),
  ADD CONSTRAINT stripe_entitlement_effects_cancel_completion_fence_check
    CHECK (
      effect_type NOT IN (
        'stripe_subscription_cancel',
        'recovery_payment_auto_refund'
      )
      OR status <> 'completed'
      OR dispatch_committed_at IS NOT NULL
    ),
  ADD CONSTRAINT stripe_entitlement_effects_cancel_protocol_check
    CHECK (
      effect_type NOT IN (
        'stripe_subscription_cancel',
        'recovery_payment_auto_refund'
      )
      OR payload ->> 'protocol_version' = 'dispatch_commit_v1'
    );

CREATE UNIQUE INDEX payment_history_stripe_event_key
  ON public.payment_history (stripe_event_id)
  WHERE stripe_event_id IS NOT NULL;
CREATE UNIQUE INDEX payment_history_invoice_payment_key
  ON public.payment_history (stripe_invoice_payment_id)
  WHERE stripe_invoice_payment_id IS NOT NULL;

CREATE TABLE public.stripe_b2c_invoice_events (
  event_id text PRIMARY KEY,
  event_created_at timestamptz NOT NULL,
  livemode boolean NOT NULL,
  event_type text NOT NULL,
  user_id uuid NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  stripe_invoice_id text NOT NULL,
  stripe_invoice_payment_id text,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_price_id text NOT NULL,
  plan text NOT NULL,
  amount bigint NOT NULL,
  currency text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  payment_status text NOT NULL,
  stripe_subscription_status text NOT NULL,
  next_payment_attempt timestamptz,
  outcome text NOT NULL DEFAULT 'observed',
  observed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_b2c_invoice_events_id_check CHECK (
    event_id = pg_catalog.btrim(event_id)
    AND event_id ~ '^evt_[A-Za-z0-9_]+$'
    AND pg_catalog.length(event_id) <= 255
  ),
  CONSTRAINT stripe_b2c_invoice_events_type_check CHECK (
    event_type IN (
      'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed',
      'trial_zero_invoice'
    )
  ),
  CONSTRAINT stripe_b2c_invoice_events_object_check CHECK (
    stripe_customer_id = pg_catalog.btrim(stripe_customer_id)
    AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_customer_id) <= 255
    AND stripe_subscription_id = pg_catalog.btrim(stripe_subscription_id)
    AND stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_subscription_id) <= 255
    AND stripe_invoice_id = pg_catalog.btrim(stripe_invoice_id)
    AND stripe_invoice_id ~ '^in_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_invoice_id) <= 255
    AND stripe_price_id = pg_catalog.btrim(stripe_price_id)
    AND stripe_price_id ~ '^price_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_price_id) <= 255
    AND (
      stripe_invoice_payment_id IS NULL
      OR (
        stripe_invoice_payment_id = pg_catalog.btrim(stripe_invoice_payment_id)
        AND stripe_invoice_payment_id ~ '^inpay_[A-Za-z0-9_]+$'
        AND pg_catalog.length(stripe_invoice_payment_id) <= 255
      )
    )
    AND (
      stripe_payment_intent_id IS NULL
      OR (
        stripe_payment_intent_id = pg_catalog.btrim(stripe_payment_intent_id)
        AND stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
        AND pg_catalog.length(stripe_payment_intent_id) <= 255
      )
    )
    AND (
      stripe_charge_id IS NULL
      OR (
        stripe_charge_id = pg_catalog.btrim(stripe_charge_id)
        AND stripe_charge_id ~ '^ch_[A-Za-z0-9_]+$'
        AND pg_catalog.length(stripe_charge_id) <= 255
      )
    )
  ),
  CONSTRAINT stripe_b2c_invoice_events_product_check CHECK (
    plan IN ('monthly', 'yearly')
    AND amount > 0
    AND currency ~ '^[a-z]{3}$'
    AND period_end > period_start
  ),
  CONSTRAINT stripe_b2c_invoice_events_payment_shape_check CHECK (
    (
      event_type IN ('invoice.paid', 'invoice.payment_succeeded')
      AND payment_status = 'succeeded'
      AND stripe_invoice_payment_id IS NOT NULL
      AND stripe_charge_id IS NOT NULL
      AND next_payment_attempt IS NULL
    ) OR (
      event_type = 'invoice.payment_failed'
      AND payment_status = 'failed'
      AND stripe_invoice_payment_id IS NULL
      AND stripe_payment_intent_id IS NULL
      AND stripe_charge_id IS NULL
    ) OR (
      event_type = 'trial_zero_invoice'
      AND payment_status = 'trial_zero'
      AND stripe_invoice_payment_id IS NULL
      AND stripe_payment_intent_id IS NULL
      AND stripe_charge_id IS NULL
      AND next_payment_attempt IS NULL
    )
  ),
  CONSTRAINT stripe_b2c_invoice_events_status_check CHECK (
    stripe_subscription_status IN (
      'active', 'trialing', 'past_due', 'canceled', 'unpaid',
      'incomplete', 'incomplete_expired', 'paused'
    )
    AND outcome ~ '^[a-z0-9_]{2,64}$'
  )
);

CREATE INDEX stripe_b2c_invoice_events_invoice_payment_idx
  ON public.stripe_b2c_invoice_events (stripe_invoice_payment_id)
  WHERE stripe_invoice_payment_id IS NOT NULL;
CREATE INDEX stripe_b2c_invoice_events_subscription_order_idx
  ON public.stripe_b2c_invoice_events (
    stripe_subscription_id, event_created_at DESC, event_id DESC
  );

CREATE TABLE public.stripe_b2c_recurring_activations (
  livemode boolean NOT NULL,
  source_event_id text NOT NULL,
  source_event_created_at timestamptz NOT NULL,
  authority_kind text NOT NULL,
  user_id uuid NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  stripe_price_id text NOT NULL,
  plan text NOT NULL,
  expected_amount bigint NOT NULL,
  currency text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  observed_subscription_status text NOT NULL,
  outcome text NOT NULL DEFAULT 'observed',
  activation_committed_at timestamptz,
  observed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (livemode, source_event_id),
  CONSTRAINT stripe_b2c_recurring_activations_event_check CHECK (
    source_event_id = pg_catalog.btrim(source_event_id)
    AND source_event_id ~ '^evt_[A-Za-z0-9_]+$'
    AND pg_catalog.length(source_event_id) <= 255
  ),
  CONSTRAINT stripe_b2c_recurring_activations_identity_check CHECK (
    stripe_customer_id = pg_catalog.btrim(stripe_customer_id)
    AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_customer_id) <= 255
    AND stripe_subscription_id = pg_catalog.btrim(stripe_subscription_id)
    AND stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_subscription_id) <= 255
    AND stripe_price_id = pg_catalog.btrim(stripe_price_id)
    AND stripe_price_id ~ '^price_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_price_id) <= 255
  ),
  CONSTRAINT stripe_b2c_recurring_activations_product_check CHECK (
    authority_kind IN ('paid', 'trial')
    AND plan IN ('monthly', 'yearly')
    AND expected_amount > 0
    AND currency ~ '^[a-z]{3}$'
    AND period_end > period_start
  ),
  CONSTRAINT stripe_b2c_recurring_activations_status_check CHECK (
    observed_subscription_status IN (
      'active', 'trialing', 'past_due', 'canceled', 'unpaid',
      'incomplete', 'incomplete_expired', 'paused'
    )
    AND outcome ~ '^[a-z0-9_]{2,64}$'
  )
);
CREATE INDEX stripe_b2c_recurring_activations_subscription_idx
  ON public.stripe_b2c_recurring_activations (
    stripe_subscription_id, livemode, source_event_created_at DESC, source_event_id DESC
  );

ALTER TABLE public.stripe_b2c_invoice_events OWNER TO postgres;
ALTER TABLE public.stripe_b2c_invoice_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_b2c_invoice_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_b2c_recurring_activations OWNER TO postgres;
ALTER TABLE public.stripe_b2c_recurring_activations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_b2c_recurring_activations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS stripe_b2c_invoice_events_service_select
  ON public.stripe_b2c_invoice_events;
CREATE POLICY stripe_b2c_invoice_events_service_select
  ON public.stripe_b2c_invoice_events
  FOR SELECT TO service_role USING (true);

DROP POLICY IF EXISTS stripe_b2c_recurring_activations_service_select
  ON public.stripe_b2c_recurring_activations;
CREATE POLICY stripe_b2c_recurring_activations_service_select
  ON public.stripe_b2c_recurring_activations
  FOR SELECT TO service_role USING (true);

CREATE OR REPLACE FUNCTION public.record_b2c_recurring_manual_review_atomic(
  p_object_type text,
  p_object_id text,
  p_user_id uuid,
  p_reason_key text,
  p_reason text,
  p_context jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_audit_user_id uuid;
  v_context jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_context IS NULL
    OR pg_catalog.jsonb_typeof(p_context) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'B2C manual review context is invalid' USING ERRCODE = '22023';
  END IF;

  v_context := p_context || CASE
    WHEN p_user_id IS NULL THEN '{}'::jsonb
    ELSE pg_catalog.jsonb_build_object('opaque_owner_user_id', p_user_id)
  END;

  IF p_user_id IS NOT NULL THEN
    -- The key-share lock makes an in-flight hard delete wait until the FK-safe
    -- review is inserted.  A completed delete yields NULL, while the opaque
    -- UUID remains in non-relational context.  ON DELETE SET NULL therefore
    -- preserves stable replay identity instead of producing a retry poison.
    SELECT profile.id INTO v_audit_user_id
    FROM public.user_profiles AS profile
    WHERE profile.id = p_user_id
    FOR KEY SHARE;
  END IF;

  RETURN public.record_stripe_manual_review_atomic(
    p_object_type,
    p_object_id,
    v_audit_user_id,
    p_reason_key,
    p_reason,
    v_context
  );
END
$function$;

ALTER FUNCTION public.record_b2c_recurring_manual_review_atomic(
  text, text, uuid, text, text, jsonb
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.classify_recurring_invoice_product_authority_atomic(
  p_livemode boolean,
  p_event_id text,
  p_invoice_id text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text
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
  v_has_b2c_strong boolean := false;
  v_has_b2c_weak boolean := false;
  v_has_api_strong boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL
    OR p_event_id IS NULL
    OR p_event_id IS DISTINCT FROM pg_catalog.btrim(p_event_id)
    OR p_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_event_id) > 255
    OR p_invoice_id IS NULL
    OR p_invoice_id IS DISTINCT FROM pg_catalog.btrim(p_invoice_id)
    OR p_invoice_id !~ '^in_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_invoice_id) > 255
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
  THEN
    RAISE EXCEPTION 'recurring Invoice product classifier identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- Product identity belongs to the durable Subscription, not to today's env
  -- Price mapping. Price rotation therefore cannot move an old API Invoice
  -- into B2C Pro (or an old Pro Invoice into API authority).
  -- Pre-cutover payment/trial/legacy rows do not carry a trustworthy Stripe
  -- mode. They remain useful B2C fallback evidence, but may not create a false
  -- cross-product conflict with a later, same-mode API ledger.
  SELECT EXISTS (
    SELECT 1
    FROM public.stripe_entitlement_payments AS payment
    JOIN public.stripe_payment_ownerships AS ownership
      ON ownership.product_kind = 'pro_entitlement'
     AND ownership.ledger_id = payment.id
    WHERE payment.payment_kind = 'recurring'
      AND payment.stripe_customer_id = p_stripe_customer_id
      AND payment.stripe_subscription_id = p_stripe_subscription_id
      AND ownership.stripe_customer_id = p_stripe_customer_id
      AND ownership.owner_user_id IS NOT NULL
      AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
    UNION ALL
    SELECT 1
    FROM public.stripe_trial_entitlements AS trial
    WHERE trial.stripe_customer_id = p_stripe_customer_id
      AND trial.stripe_subscription_id = p_stripe_subscription_id
      AND trial.user_id IS NOT NULL
    UNION ALL
    SELECT 1
    FROM public.subscriptions AS subscription
    WHERE subscription.stripe_customer_id = p_stripe_customer_id
      AND subscription.stripe_subscription_id = p_stripe_subscription_id
      AND subscription.plan IN ('monthly', 'yearly')
      AND EXISTS (
        SELECT 1
        FROM public.pro_entitlement_grants AS entitlement_grant
        WHERE entitlement_grant.user_id = subscription.user_id
          AND entitlement_grant.source = 'legacy_stripe_snapshot'
          AND entitlement_grant.source_key =
            'subscription:' || subscription.id::text
          AND public.stripe_legacy_snapshot_grant_is_exact_v2(
            entitlement_grant.id
          )
      )
  ) INTO v_has_b2c_weak;

  -- Only a same-mode signed activation outcome or converted/retired Checkout
  -- reservation is strong enough to conflict with strong API authority.
  SELECT EXISTS (
    SELECT 1
    FROM public.stripe_b2c_recurring_activations AS activation
    WHERE activation.livemode = p_livemode
      AND activation.stripe_customer_id = p_stripe_customer_id
      AND activation.stripe_subscription_id = p_stripe_subscription_id
      AND (
        activation.activation_committed_at IS NOT NULL
        OR activation.outcome IN (
          'current_entitlement_protected', 'stale_payment',
          'terminal_trial_recorded', 'refunded_payment', 'subject_deleted'
        )
      )
    UNION ALL
    SELECT 1
    FROM public.pro_membership_checkout_reservations AS reservation
    WHERE reservation.livemode = p_livemode
      AND reservation.stripe_customer_id = p_stripe_customer_id
      AND reservation.stripe_subscription_id = p_stripe_subscription_id
      AND reservation.status IN ('converted', 'retired')
  ) INTO v_has_b2c_strong;

  -- The API authority migration deliberately seals its ledgers owner-only.
  -- Dynamic SQL keeps this B2C migration testable on predecessor fixtures
  -- that do not install the independent API product, while SECURITY DEFINER
  -- provides the exact production read boundary when those tables exist.
  IF pg_catalog.to_regclass('public.api_tier_stripe_event_ledger') IS NOT NULL
    AND pg_catalog.to_regclass('public.api_tier_checkout_reservations') IS NOT NULL
  THEN
    EXECUTE $query$
      SELECT EXISTS (
        SELECT 1
        FROM public.api_tier_stripe_event_ledger AS ledger
        WHERE ledger.livemode = $1
          AND ledger.stripe_customer_id = $2
          AND ledger.stripe_subscription_id = $3
        UNION ALL
        SELECT 1
        FROM public.api_tier_checkout_reservations AS reservation
        WHERE reservation.livemode = $1
          AND reservation.stripe_customer_id = $2
          AND reservation.stripe_subscription_id = $3
          AND reservation.status = 'converted'
      )
    $query$
    INTO v_has_api_strong
    USING p_livemode, p_stripe_customer_id, p_stripe_subscription_id;
  END IF;

  IF v_has_b2c_strong AND v_has_api_strong THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'invoice',
      p_invoice_id,
      NULL,
      'recurring_product_authority_conflict',
      'Durable API and B2C ledgers both claim one Stripe Subscription.',
      pg_catalog.jsonb_build_object(
        'event_id', p_event_id,
        'livemode', p_livemode,
        'stripe_customer_id', p_stripe_customer_id,
        'stripe_subscription_id', p_stripe_subscription_id,
        'stripe_price_id', p_stripe_price_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;
  IF v_has_api_strong THEN
    RETURN pg_catalog.jsonb_build_object('status', 'api_tier');
  END IF;
  IF v_has_b2c_strong OR v_has_b2c_weak THEN
    RETURN pg_catalog.jsonb_build_object('status', 'b2c_pro');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'not_found');
END
$function$;

ALTER FUNCTION public.classify_recurring_invoice_product_authority_atomic(
  boolean, text, text, text, text, text
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.classify_recurring_subscription_product_authority_atomic(
  p_livemode boolean,
  p_event_id text,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text
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
  v_has_b2c_strong boolean := false;
  v_has_b2c_weak boolean := false;
  v_has_api_strong boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL
    OR p_event_id IS NULL
    OR p_event_id IS DISTINCT FROM pg_catalog.btrim(p_event_id)
    OR p_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_event_id) > 255
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
  THEN
    RAISE EXCEPTION 'recurring Subscription product classifier identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.stripe_entitlement_payments AS payment
    JOIN public.stripe_payment_ownerships AS ownership
      ON ownership.product_kind = 'pro_entitlement'
     AND ownership.ledger_id = payment.id
    WHERE payment.payment_kind = 'recurring'
      AND payment.stripe_customer_id = p_stripe_customer_id
      AND payment.stripe_subscription_id = p_stripe_subscription_id
      AND ownership.stripe_customer_id = p_stripe_customer_id
      AND ownership.owner_user_id IS NOT NULL
      AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
    UNION ALL
    SELECT 1
    FROM public.stripe_trial_entitlements AS trial
    WHERE trial.stripe_customer_id = p_stripe_customer_id
      AND trial.stripe_subscription_id = p_stripe_subscription_id
      AND trial.user_id IS NOT NULL
    UNION ALL
    SELECT 1
    FROM public.subscriptions AS subscription
    WHERE subscription.stripe_customer_id = p_stripe_customer_id
      AND subscription.stripe_subscription_id = p_stripe_subscription_id
      AND subscription.plan IN ('monthly', 'yearly')
      AND EXISTS (
        SELECT 1
        FROM public.pro_entitlement_grants AS entitlement_grant
        WHERE entitlement_grant.user_id = subscription.user_id
          AND entitlement_grant.source = 'legacy_stripe_snapshot'
          AND entitlement_grant.source_key =
            'subscription:' || subscription.id::text
          AND public.stripe_legacy_snapshot_grant_is_exact_v2(
            entitlement_grant.id
          )
      )
  ) INTO v_has_b2c_weak;

  SELECT EXISTS (
    SELECT 1
    FROM public.stripe_b2c_recurring_activations AS activation
    WHERE activation.livemode = p_livemode
      AND activation.stripe_customer_id = p_stripe_customer_id
      AND activation.stripe_subscription_id = p_stripe_subscription_id
      AND (
        activation.activation_committed_at IS NOT NULL
        OR activation.outcome IN (
          'current_entitlement_protected', 'stale_payment',
          'terminal_trial_recorded', 'refunded_payment', 'subject_deleted'
        )
      )
    UNION ALL
    SELECT 1
    FROM public.pro_membership_checkout_reservations AS reservation
    WHERE reservation.livemode = p_livemode
      AND reservation.stripe_customer_id = p_stripe_customer_id
      AND reservation.stripe_subscription_id = p_stripe_subscription_id
      AND reservation.status IN ('converted', 'retired')
  ) INTO v_has_b2c_strong;

  IF pg_catalog.to_regclass('public.api_tier_stripe_event_ledger') IS NOT NULL
    AND pg_catalog.to_regclass('public.api_tier_checkout_reservations') IS NOT NULL
  THEN
    EXECUTE $query$
      SELECT EXISTS (
        SELECT 1
        FROM public.api_tier_stripe_event_ledger AS ledger
        WHERE ledger.livemode = $1
          AND ledger.stripe_customer_id = $2
          AND ledger.stripe_subscription_id = $3
        UNION ALL
        SELECT 1
        FROM public.api_tier_checkout_reservations AS reservation
        WHERE reservation.livemode = $1
          AND reservation.stripe_customer_id = $2
          AND reservation.stripe_subscription_id = $3
          AND reservation.status = 'converted'
      )
    $query$
    INTO v_has_api_strong
    USING p_livemode, p_stripe_customer_id, p_stripe_subscription_id;
  END IF;

  IF v_has_b2c_strong AND v_has_api_strong THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription_event',
      p_event_id,
      NULL,
      'recurring_product_authority_conflict',
      'Durable API and B2C ledgers both claim one Stripe Subscription.',
      pg_catalog.jsonb_build_object(
        'livemode', p_livemode,
        'stripe_customer_id', p_stripe_customer_id,
        'stripe_subscription_id', p_stripe_subscription_id,
        'stripe_price_id', p_stripe_price_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;
  IF v_has_api_strong THEN
    RETURN pg_catalog.jsonb_build_object('status', 'api_tier');
  END IF;
  IF v_has_b2c_strong OR v_has_b2c_weak THEN
    RETURN pg_catalog.jsonb_build_object('status', 'b2c_pro');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'not_found');
END
$function$;

ALTER FUNCTION public.classify_recurring_subscription_product_authority_atomic(
  boolean, text, text, text, text
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.b2c_subscription_has_exact_committed_authority_v2(
  p_user_id uuid,
  p_stripe_subscription_id text,
  p_livemode boolean
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT p_user_id IS NOT NULL
    AND p_stripe_subscription_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.subscriptions AS subscription
      JOIN public.stripe_b2c_recurring_activations AS activation
        ON activation.user_id = subscription.user_id
       AND activation.stripe_customer_id = subscription.stripe_customer_id
       AND activation.stripe_subscription_id =
         subscription.stripe_subscription_id
       AND activation.plan = subscription.plan
       AND activation.period_start = subscription.current_period_start
       AND activation.period_end = subscription.current_period_end
       AND activation.activation_committed_at IS NOT NULL
       AND (p_livemode IS NULL OR activation.livemode = p_livemode)
      WHERE subscription.user_id = p_user_id
        AND subscription.stripe_subscription_id = p_stripe_subscription_id
        AND subscription.plan IN ('monthly', 'yearly')
        AND (
          (
            activation.authority_kind = 'paid'
            AND subscription.entitlement_payment_id IS NOT NULL
            AND subscription.entitlement_trial_id IS NULL
            AND EXISTS (
              SELECT 1
              FROM public.stripe_entitlement_payments AS payment
              JOIN public.stripe_payment_ownerships AS ownership
                ON ownership.product_kind = 'pro_entitlement'
               AND ownership.ledger_id = payment.id
              WHERE payment.id = subscription.entitlement_payment_id
                AND payment.user_id = subscription.user_id
                AND payment.payment_kind = 'recurring'
                AND payment.plan = subscription.plan
                AND payment.stripe_customer_id =
                  subscription.stripe_customer_id
                AND payment.stripe_subscription_id =
                  subscription.stripe_subscription_id
                AND payment.period_start = subscription.current_period_start
                AND payment.period_end = subscription.current_period_end
                AND payment.amount_paid = activation.expected_amount
                AND payment.currency = activation.currency
                AND payment.payment_status IN ('paid', 'succeeded')
                AND NOT (
                  payment.refund_state = 'succeeded'
                  AND payment.refund_succeeded_amount >= payment.amount_paid
                )
                AND ownership.owner_user_id = subscription.user_id
                AND ownership.stripe_customer_id =
                  subscription.stripe_customer_id
                AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
            )
          )
          OR (
            activation.authority_kind = 'trial'
            AND subscription.entitlement_payment_id IS NULL
            AND subscription.entitlement_trial_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM public.stripe_trial_entitlements AS trial
              WHERE trial.id = subscription.entitlement_trial_id
                AND trial.user_id = subscription.user_id
                AND trial.stripe_customer_id =
                  subscription.stripe_customer_id
                AND trial.stripe_subscription_id =
                  subscription.stripe_subscription_id
                AND trial.plan = subscription.plan
                AND trial.period_start = subscription.current_period_start
                AND trial.period_end = subscription.current_period_end
                AND trial.verified_at =
                  subscription.entitlement_trial_verified_at
                AND trial.revoked_at IS NULL
            )
          )
        )
    )
$function$;

ALTER FUNCTION public.b2c_subscription_has_exact_committed_authority_v2(
  uuid, text, boolean
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.b2c_subscription_has_exact_committed_authority_v2(
  uuid, text, boolean
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.current_exact_pro_grant_authority_v2(
  p_user_id uuid,
  p_at timestamptz
)
RETURNS TABLE (
  has_grant boolean,
  has_lifetime_grant boolean,
  grant_expires_at timestamptz,
  authority_boundary timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  WITH eligible AS (
    SELECT
      entitlement_grant.starts_at,
      entitlement_grant.expires_at,
      entitlement_grant.source IN (
        'stripe_lifetime_payment', 'legacy_stripe_snapshot'
      ) AND entitlement_grant.expires_at IS NULL AS is_lifetime
    FROM public.pro_entitlement_grants AS entitlement_grant
    WHERE p_user_id IS NOT NULL
      AND p_at IS NOT NULL
      AND entitlement_grant.user_id = p_user_id
      AND entitlement_grant.revoked_at IS NULL
      AND entitlement_grant.starts_at <= p_at
      AND (
        entitlement_grant.expires_at IS NULL
        OR entitlement_grant.expires_at > p_at
      )
      AND (
        (
          entitlement_grant.source = 'stripe_lifetime_payment'
          AND entitlement_grant.grant_kind = 'absolute'
          AND entitlement_grant.expires_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM public.stripe_entitlement_payments AS payment
            JOIN public.stripe_payment_ownerships AS ownership
              ON ownership.product_kind = 'pro_entitlement'
             AND ownership.ledger_id = payment.id
            WHERE payment.id::text =
                entitlement_grant.metadata ->> 'payment_id'
              AND entitlement_grant.source_key =
                'payment:' || payment.id::text
              AND payment.user_id = entitlement_grant.user_id
              AND payment.payment_kind = 'lifetime'
              AND payment.payment_status IN ('paid', 'succeeded')
              AND NOT (
                payment.refund_state = 'succeeded'
                AND payment.refund_succeeded_amount >= payment.amount_paid
              )
              AND ownership.owner_user_id = entitlement_grant.user_id
              AND ownership.stripe_customer_id = payment.stripe_customer_id
              AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
          )
        )
        OR (
          entitlement_grant.source = 'legacy_stripe_snapshot'
          AND public.stripe_legacy_snapshot_grant_is_exact_v2(
            entitlement_grant.id
          )
        )
        OR (
          entitlement_grant.source = 'referral'
          AND entitlement_grant.grant_kind IN ('absolute', 'days')
        )
        OR (
          entitlement_grant.source = 'legacy_referral_snapshot'
          AND entitlement_grant.grant_kind = 'absolute'
          AND entitlement_grant.metadata ->> 'migration' = '20260718183000'
          AND entitlement_grant.source_key = 'subscription:' ||
            (entitlement_grant.metadata ->> 'subscription_id')
        )
      )
  )
  SELECT
    pg_catalog.count(*) > 0,
    COALESCE(pg_catalog.bool_or(eligible.is_lifetime), false),
    CASE
      WHEN pg_catalog.count(*) FILTER (
        WHERE eligible.expires_at IS NULL
      ) > 0
      THEN NULL
      ELSE pg_catalog.max(eligible.expires_at)
    END,
    pg_catalog.max(eligible.starts_at)
  FROM eligible
$function$;

ALTER FUNCTION public.current_exact_pro_grant_authority_v2(
  uuid, timestamptz
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_exact_pro_grant_authority_v2(
  uuid, timestamptz
) FROM PUBLIC;

-- Recovery completion must validate exact grant evidence while its own
-- admission row is deliberately still billing_pending.  Preserve the exact
-- grant validator behind an owner-only name; all ordinary callers use the
-- gated function recreated below.
ALTER FUNCTION public.current_exact_pro_grant_authority_v2(
  uuid, timestamptz
) RENAME TO current_exact_pro_grant_authority_ungated_v2;
REVOKE ALL ON FUNCTION public.current_exact_pro_grant_authority_ungated_v2(
  uuid, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- One fail-closed predicate protects every Stripe surface during the interval
-- after Auth has been restored but before recovery billing finalization is
-- durably complete.  Superseded history is intentionally not an active block;
-- exact unsafe states, legacy NULL finalization shape, and deletion/settlement
-- fences are.  Callers which create or bind billing authority must hold the
-- account-recovery admission advisory lock before evaluating this predicate.
CREATE OR REPLACE FUNCTION public.account_recovery_billing_surface_is_blocked_v2(
  p_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT p_user_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.id = p_user_id
        AND profile.deleted_at IS NULL
        AND profile.deletion_scheduled_at IS NULL
        AND profile.banned_at IS NULL
        AND NOT (
          COALESCE(profile.is_banned, false)
          AND (
            profile.ban_expires_at IS NULL
            OR profile.ban_expires_at > pg_catalog.statement_timestamp()
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.account_recovery_admissions AS admission
      WHERE admission.user_id = p_user_id
        AND admission.state IN ('claimed', 'finished')
        AND COALESCE(
          admission.auth_finalization_state NOT IN ('completed', 'superseded'),
          true
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.account_deletion_auth_fences AS fence
      WHERE fence.user_id = p_user_id
        AND fence.state NOT IN ('completed', 'released')
    )
    OR EXISTS (
      SELECT 1
      FROM public.account_hard_deletion_fences AS fence
      WHERE fence.user_id = p_user_id
        AND fence.state NOT IN ('completed', 'released')
    )
    OR EXISTS (
      SELECT 1
      FROM public.account_deletion_one_time_settlements AS settlement
      WHERE settlement.user_id = p_user_id
        AND settlement.settlement_status = 'pending_fulfillment'
    )
$function$;

ALTER FUNCTION public.account_recovery_billing_surface_is_blocked_v2(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_recovery_billing_surface_is_blocked_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- Return the single recovery admission which owns a payment lifecycle.  This
-- is the canonical locator for product writers: later deletion preparation
-- may supersede the admission and mutate its generic updated_at, but it must
-- never erase the immutable V2 billing completion boundary.  Pre-V2 history
-- has no trustworthy closed-at value, so only an explicit unresolved manual
-- row is returned and labelled fail-closed; a consumer must not invent a
-- boundary from updated_at or auth_finalized_at.
CREATE OR REPLACE FUNCTION public.locate_account_recovery_payment_lifecycle_v2(
  p_user_id uuid,
  p_checkout_created_at timestamptz,
  p_paid_at timestamptz
)
RETURNS TABLE (
  operation_id uuid,
  lifecycle_kind text,
  recovery_claimed_at timestamptz,
  recovery_billing_completed_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT
    admission.operation_id,
    CASE
      WHEN admission.recovery_billing_completed_at IS NOT NULL
        THEN 'completed_window'
      WHEN admission.state = 'finished'
        AND admission.auth_finalization_state = 'expired_manual'
        THEN 'legacy_manual'
      ELSE 'active'
    END AS lifecycle_kind,
    admission.claimed_at AS recovery_claimed_at,
    admission.recovery_billing_completed_at
  FROM public.account_recovery_admissions AS admission
  WHERE p_user_id IS NOT NULL
    AND p_checkout_created_at IS NOT NULL
    AND p_paid_at IS NOT NULL
    AND p_paid_at >= p_checkout_created_at
    AND admission.user_id = p_user_id
    AND admission.claimed_at <= p_paid_at
    AND (
      (
        admission.state = 'finished'
        AND admission.recovery_billing_completed_at IS NOT NULL
        AND p_checkout_created_at <= admission.recovery_billing_completed_at
      )
      OR admission.state = 'claimed'
      OR (
        admission.state = 'finished'
        AND admission.recovery_billing_completed_at IS NULL
        AND COALESCE(
          admission.auth_finalization_state NOT IN (
            'completed', 'superseded'
          ),
          true
        )
      )
    )
  ORDER BY
    CASE
      WHEN admission.state = 'claimed' THEN 0
      WHEN admission.recovery_billing_completed_at IS NOT NULL THEN 1
      ELSE 2
    END,
    admission.recovery_billing_completed_at DESC NULLS LAST,
    admission.claimed_at DESC,
    admission.operation_id DESC
  LIMIT 1
$function$;

ALTER FUNCTION public.locate_account_recovery_payment_lifecycle_v2(
  uuid, timestamptz, timestamptz
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.locate_account_recovery_payment_lifecycle_v2(
  uuid, timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- Current-state gating alone is insufficient for a Checkout Session which was
-- created before (or during) recovery but whose payment completion arrives
-- only after recovery has reached its completed state.  The immutable
-- completion timestamp makes that lifecycle race independently decidable.
CREATE OR REPLACE FUNCTION public.account_recovery_payment_lifecycle_is_blocked_v2(
  p_user_id uuid,
  p_checkout_created_at timestamptz,
  p_paid_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT p_user_id IS NULL
    OR p_checkout_created_at IS NULL
    OR p_paid_at IS NULL
    OR p_paid_at < p_checkout_created_at
    OR public.account_recovery_billing_surface_is_blocked_v2(p_user_id)
    OR EXISTS (
      SELECT 1
      FROM public.locate_account_recovery_payment_lifecycle_v2(
        p_user_id,
        p_checkout_created_at,
        p_paid_at
      )
    )
$function$;

ALTER FUNCTION public.account_recovery_payment_lifecycle_is_blocked_v2(
  uuid, timestamptz, timestamptz
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_recovery_payment_lifecycle_is_blocked_v2(
  uuid, timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- The Auth-finalization columns were additive in the preceding migration, so
-- historical finished rows legitimately have a NULL state and historical
-- completed rows have no V2 billing snapshot/result.  Neither shape is safe
-- to grandfather.  Drain a genuinely live old worker, close expired claims,
-- keep only the newest unresolved history per user as explicit manual work,
-- and quarantine its mutable Pro projection now.
DO $classify_legacy_account_recovery_finalization$
DECLARE
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_previous_role text := pg_catalog.current_setting(
    'request.jwt.claim.role', true
  );
  v_candidate record;
  v_leave_ack jsonb;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.account_recovery_admissions AS admission
    WHERE admission.state = 'claimed'
      AND admission.lease_expires_at > v_now
  ) OR EXISTS (
    SELECT 1
    FROM public.account_recovery_admissions AS admission
    WHERE admission.state = 'finished'
      AND admission.auth_finalization_state IN (
        'prepared', 'pending', 'claimed',
        'auth_compensation_required', 'billing_pending'
      )
      AND COALESCE(
        admission.auth_finalization_attempt_expires_at,
        admission.updated_at + interval '15 minutes'
      ) > v_now
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'cannot classify account recovery while a legacy recovery/finalization worker is active; drain workers and retry migration';
  END IF;

  UPDATE public.account_recovery_admissions AS admission
  SET state = 'aborted',
      finished_at = NULL,
      aborted_at = v_now,
      abort_reason = 'lease_expired',
      auth_finalization_capability_hash = CASE
        WHEN admission.auth_finalization_state IS NULL THEN NULL
        ELSE COALESCE(
          admission.auth_finalization_capability_hash,
          pg_catalog.encode(
            pg_catalog.sha256(
              pg_catalog.convert_to(
                'legacy-recovery-capability:' || admission.operation_id::text,
                'UTF8'
              )
            ),
            'hex'
          )
        )
      END,
      auth_finalization_state = CASE
        WHEN admission.auth_finalization_state IS NULL THEN NULL
        ELSE 'superseded'
      END,
      auth_finalization_prepared_at = CASE
        WHEN admission.auth_finalization_state IS NULL THEN NULL
        ELSE COALESCE(
          admission.auth_finalization_prepared_at,
          admission.claimed_at
        )
      END,
      auth_finalization_attempt_id = NULL,
      auth_finalization_attempt_expires_at = NULL,
      auth_finalized_at = NULL,
      recovery_billing_resumed = NULL,
      recovery_billing_may_have_changed = NULL,
      recovery_billing_target_snapshot = NULL,
      recovery_billing_target_digest = NULL,
      recovery_billing_v2_result = NULL,
      updated_at = GREATEST(admission.updated_at, v_now)
  WHERE admission.state = 'claimed'
    AND admission.lease_expires_at <= v_now;

  CREATE TEMPORARY TABLE pg_temp.legacy_recovery_v2_candidates
  ON COMMIT DROP
  AS
  SELECT
    admission.operation_id,
    admission.user_id,
    admission.auth_finalization_state AS prior_finalization_state,
    pg_catalog.row_number() OVER (
      PARTITION BY admission.user_id
      ORDER BY
        COALESCE(
          admission.auth_finalized_at,
          admission.finished_at,
          admission.updated_at,
          admission.claimed_at
        ) DESC,
        admission.operation_id DESC
    ) AS newest_rank
  FROM public.account_recovery_admissions AS admission
  WHERE admission.state = 'finished'
    AND (
      admission.auth_finalization_state IS NULL
      OR admission.auth_finalization_state NOT IN ('completed', 'superseded')
      OR (
        admission.auth_finalization_state IN ('completed', 'superseded')
        AND admission.recovery_billing_v2_result IS NULL
      )
    );

  UPDATE public.account_recovery_admissions AS admission
  SET auth_finalization_capability_hash = COALESCE(
        admission.auth_finalization_capability_hash,
        pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(
              'legacy-recovery-capability:' || admission.operation_id::text,
              'UTF8'
            )
          ),
          'hex'
        )
      ),
      auth_finalization_state = CASE
        WHEN candidate.newest_rank = 1 THEN 'expired_manual'
        ELSE 'superseded'
      END,
      auth_finalization_prepared_at = COALESCE(
        admission.auth_finalization_prepared_at,
        admission.finished_at,
        admission.claimed_at
      ),
      auth_finalization_attempt_id = NULL,
      auth_finalization_attempt_expires_at = NULL,
      auth_finalized_at = CASE
        WHEN candidate.newest_rank = 1 THEN admission.auth_finalized_at
        ELSE NULL
      END,
      recovery_billing_resumed = NULL,
      recovery_billing_may_have_changed = CASE
        WHEN candidate.newest_rank = 1 THEN false
        ELSE NULL
      END,
      recovery_billing_target_snapshot = NULL,
      recovery_billing_target_digest = NULL,
      recovery_billing_v2_result = NULL,
      updated_at = GREATEST(admission.updated_at, v_now)
  FROM pg_temp.legacy_recovery_v2_candidates AS candidate
  WHERE admission.operation_id = candidate.operation_id;

  INSERT INTO public.stripe_manual_reviews (
    object_type,
    object_id,
    user_id,
    action,
    reason_key,
    reason,
    metadata
  )
  SELECT
    'account_recovery',
    candidate.operation_id::text,
    profile.id,
    'reconcile',
    'legacy_recovery_requires_v2_reconciliation',
    'A pre-V2 account recovery cannot prove exact Auth and Stripe billing finalization and was quarantined fail-closed.',
    pg_catalog.jsonb_build_object(
      'operation_id', candidate.operation_id,
      'opaque_owner_user_id', candidate.user_id,
      'prior_finalization_state', candidate.prior_finalization_state,
      'classified_state', CASE
        WHEN candidate.newest_rank = 1 THEN 'expired_manual'
        ELSE 'superseded'
      END,
      'classified_at', v_now
    )
  FROM pg_temp.legacy_recovery_v2_candidates AS candidate
  LEFT JOIN public.user_profiles AS profile
    ON profile.id = candidate.user_id
  ON CONFLICT (object_type, object_id, reason_key) DO NOTHING;

  UPDATE public.user_profiles AS profile
  SET subscription_tier = 'free',
      pro_plan = NULL,
      pro_expires_at = NULL,
      is_pro = false,
      updated_at = GREATEST(profile.updated_at, v_now)
  WHERE EXISTS (
    SELECT 1
    FROM pg_temp.legacy_recovery_v2_candidates AS candidate
    WHERE candidate.newest_rank = 1
      AND candidate.user_id = profile.id
  );

  PERFORM pg_catalog.set_config(
    'request.jwt.claim.role', 'service_role', true
  );
  FOR v_candidate IN
    SELECT candidate.user_id
    FROM pg_temp.legacy_recovery_v2_candidates AS candidate
    JOIN public.user_profiles AS profile ON profile.id = candidate.user_id
    WHERE candidate.newest_rank = 1
    ORDER BY candidate.user_id
  LOOP
    v_leave_ack := public.leave_pro_official_group_atomic(
      v_candidate.user_id
    );
    IF COALESCE(v_leave_ack ->> 'status', '') NOT IN ('left', 'not_member') THEN
      RAISE EXCEPTION 'legacy recovery quarantine group leave failed'
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config(
    'request.jwt.claim.role', COALESCE(v_previous_role, ''), true
  );
END
$classify_legacy_account_recovery_finalization$;

-- Never guess among historical recovery snapshots.  Deployment deliberately
-- keeps exactly one explicit manual row after classifying older history.
CREATE UNIQUE INDEX account_recovery_one_unfinished_finalization_v2
  ON public.account_recovery_admissions (user_id)
  WHERE state IN ('claimed', 'finished')
    AND (
      auth_finalization_state IS NULL
      OR auth_finalization_state NOT IN ('completed', 'superseded')
    );

CREATE OR REPLACE FUNCTION public.resolve_user_stripe_billing_surface_access_atomic(
  p_user_id uuid
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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  PERFORM 1
  FROM public.account_recovery_admissions AS admission
  WHERE admission.user_id = p_user_id
  FOR SHARE;
  PERFORM 1
  FROM public.account_deletion_auth_fences AS fence
  WHERE fence.user_id = p_user_id
  FOR SHARE;
  PERFORM 1
  FROM public.account_hard_deletion_fences AS fence
  WHERE fence.user_id = p_user_id
  FOR SHARE;

  RETURN pg_catalog.jsonb_build_object(
    'status',
    CASE
      WHEN public.account_recovery_billing_surface_is_blocked_v2(p_user_id)
      THEN 'blocked'
      ELSE 'allowed'
    END
  );
END
$function$;

ALTER FUNCTION public.resolve_user_stripe_billing_surface_access_atomic(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_user_stripe_billing_surface_access_atomic(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.resolve_user_stripe_billing_surface_access_atomic(uuid)
  TO service_role;

-- Recovery may temporarily restore the Auth subject before the exact frozen
-- Stripe target has been finalized.  Every Pro grant is fail-closed during
-- that window, including lifetime and referral grants: financial evidence is
-- retained, but no old JWT can consume or re-project entitlement authority.
CREATE OR REPLACE FUNCTION public.current_exact_pro_grant_authority_v2(
  p_user_id uuid,
  p_at timestamptz
)
RETURNS TABLE (
  has_grant boolean,
  has_lifetime_grant boolean,
  grant_expires_at timestamptz,
  authority_boundary timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  WITH eligible AS (
    SELECT
      entitlement_grant.starts_at,
      entitlement_grant.expires_at,
      entitlement_grant.source IN (
        'stripe_lifetime_payment', 'legacy_stripe_snapshot'
      )
        AND entitlement_grant.expires_at IS NULL
        AND COALESCE(entitlement_grant.metadata ->> 'plan', 'lifetime') =
          'lifetime' AS is_lifetime
    FROM public.pro_entitlement_grants AS entitlement_grant
    WHERE p_user_id IS NOT NULL
      AND p_at IS NOT NULL
      AND NOT public.account_recovery_billing_surface_is_blocked_v2(p_user_id)
      AND entitlement_grant.user_id = p_user_id
      AND entitlement_grant.revoked_at IS NULL
      AND entitlement_grant.starts_at <= p_at
      AND (
        entitlement_grant.expires_at IS NULL
        OR entitlement_grant.expires_at > p_at
      )
      AND (
        (
          entitlement_grant.source = 'stripe_lifetime_payment'
          AND entitlement_grant.grant_kind = 'absolute'
          AND entitlement_grant.expires_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM public.stripe_entitlement_payments AS payment
            JOIN public.stripe_payment_ownerships AS ownership
              ON ownership.product_kind = 'pro_entitlement'
             AND ownership.ledger_id = payment.id
            WHERE payment.id::text =
                entitlement_grant.metadata ->> 'payment_id'
              AND entitlement_grant.source_key =
                'payment:' || payment.id::text
              AND payment.user_id = entitlement_grant.user_id
              AND payment.payment_kind = 'lifetime'
              AND payment.payment_status IN ('paid', 'succeeded')
              AND NOT (
                payment.refund_state = 'succeeded'
                AND payment.refund_succeeded_amount >= payment.amount_paid
              )
              AND ownership.owner_user_id = entitlement_grant.user_id
              AND ownership.stripe_customer_id = payment.stripe_customer_id
              AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
          )
        )
        OR (
          entitlement_grant.source = 'legacy_stripe_snapshot'
          AND public.stripe_legacy_snapshot_grant_is_exact_v2(
            entitlement_grant.id
          )
        )
        OR (
          entitlement_grant.source = 'referral'
          AND entitlement_grant.grant_kind IN ('absolute', 'days')
        )
        OR (
          entitlement_grant.source = 'legacy_referral_snapshot'
          AND entitlement_grant.grant_kind = 'absolute'
          AND entitlement_grant.metadata ->> 'migration' = '20260718183000'
          AND entitlement_grant.source_key = 'subscription:' ||
            (entitlement_grant.metadata ->> 'subscription_id')
        )
      )
  )
  SELECT
    pg_catalog.count(*) > 0,
    COALESCE(pg_catalog.bool_or(eligible.is_lifetime), false),
    CASE
      WHEN pg_catalog.count(*) FILTER (
        WHERE eligible.expires_at IS NULL
      ) > 0
      THEN NULL
      ELSE pg_catalog.max(eligible.expires_at)
    END,
    pg_catalog.max(eligible.starts_at)
  FROM eligible
$function$;

ALTER FUNCTION public.current_exact_pro_grant_authority_v2(
  uuid, timestamptz
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_exact_pro_grant_authority_v2(
  uuid, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- The recurring predicate deliberately validates the current canonical row,
-- its committed activation, and (for past_due) the exact open retry episode.
-- It never consults mutable profile projection fields.
CREATE OR REPLACE FUNCTION public.current_exact_b2c_recurring_authority_v2(
  p_user_id uuid,
  p_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT p_user_id IS NOT NULL
    AND p_at IS NOT NULL
    AND NOT public.account_recovery_billing_surface_is_blocked_v2(p_user_id)
    AND EXISTS (
      SELECT 1
      FROM public.subscriptions AS subscription
      WHERE subscription.user_id = p_user_id
        AND subscription.tier = 'pro'
        AND subscription.plan IN ('monthly', 'yearly')
        AND public.b2c_subscription_has_exact_committed_authority_v2(
          p_user_id,
          subscription.stripe_subscription_id,
          NULL
        )
        AND (
          (
            subscription.status = 'active'
            AND subscription.entitlement_payment_id IS NOT NULL
            AND subscription.entitlement_trial_id IS NULL
            AND subscription.current_period_end > p_at
          )
          OR (
            subscription.status = 'trialing'
            AND subscription.entitlement_payment_id IS NULL
            AND subscription.entitlement_trial_id IS NOT NULL
            AND subscription.current_period_end > p_at
          )
          OR (
            subscription.status = 'past_due'
            AND subscription.entitlement_payment_id IS NOT NULL
            AND subscription.entitlement_trial_id IS NULL
            AND EXISTS (
              SELECT 1
              FROM public.pro_entitlement_grants AS retry_grace
              WHERE retry_grace.user_id = p_user_id
                AND retry_grace.source = 'stripe_payment_retry_grace'
                AND retry_grace.grant_kind = 'absolute'
                AND retry_grace.revoked_at IS NULL
                AND retry_grace.starts_at <= p_at
                AND retry_grace.expires_at > p_at
                AND retry_grace.metadata ->> 'stripe_subscription_id' =
                  subscription.stripe_subscription_id
                AND retry_grace.metadata ->> 'episode_closed_at' IS NULL
            )
          )
        )
    )
$function$;

ALTER FUNCTION public.current_exact_b2c_recurring_authority_v2(
  uuid, timestamptz
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_exact_b2c_recurring_authority_v2(
  uuid, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.stripe_has_current_pro_authority_v2(
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT p_actor_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.user_profiles AS active_profile
      WHERE active_profile.id = p_actor_id
        AND active_profile.deleted_at IS NULL
        AND active_profile.deletion_scheduled_at IS NULL
        AND active_profile.banned_at IS NULL
        AND NOT (
          COALESCE(active_profile.is_banned, false)
          AND (
            active_profile.ban_expires_at IS NULL
            OR active_profile.ban_expires_at >
              pg_catalog.statement_timestamp()
          )
        )
    )
    AND (
      public.current_exact_b2c_recurring_authority_v2(
        p_actor_id,
        pg_catalog.statement_timestamp()
      )
      OR COALESCE((
        SELECT authority.has_grant
        FROM public.current_exact_pro_grant_authority_v2(
          p_actor_id,
          pg_catalog.statement_timestamp()
        ) AS authority
      ), false)
    )
$function$;

ALTER FUNCTION public.stripe_has_current_pro_authority_v2(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_has_current_pro_authority_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- Every global membership check now consumes exact authority.  A stale
-- user_profiles projection can no longer grant access on its own.
CREATE OR REPLACE FUNCTION public.has_current_global_pro_entitlement(
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT public.stripe_has_current_pro_authority_v2(p_actor_id)
$function$;

ALTER FUNCTION public.has_current_global_pro_entitlement(uuid)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.sync_current_pro_projection_atomic(
  p_user_id uuid
)
RETURNS boolean
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
  v_profile public.user_profiles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_has_subscription boolean := false;
  v_has_grant boolean := false;
  v_has_lifetime_grant boolean := false;
  v_grant_expires_at timestamptz;
  v_recurring_expires_at timestamptz;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'projection user is required' USING ERRCODE = '22023';
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

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_profile.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'active entitlement owner is missing'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_profile.banned_at IS NULL
    AND NOT (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > v_now
      )
    )
    AND NOT public.account_recovery_billing_surface_is_blocked_v2(p_user_id)
  THEN
    SELECT subscription.*
    INTO v_subscription
    FROM public.subscriptions AS subscription
    WHERE subscription.user_id = p_user_id
      AND subscription.tier = 'pro'
      AND subscription.plan IN ('monthly', 'yearly')
      AND public.b2c_subscription_has_exact_committed_authority_v2(
        p_user_id,
        subscription.stripe_subscription_id,
        NULL
      )
      AND (
        (
          subscription.status = 'active'
          AND subscription.entitlement_payment_id IS NOT NULL
          AND subscription.entitlement_trial_id IS NULL
          AND subscription.current_period_end > v_now
        )
        OR (
          subscription.status = 'trialing'
          AND subscription.entitlement_payment_id IS NULL
          AND subscription.entitlement_trial_id IS NOT NULL
          AND subscription.current_period_end > v_now
        )
        OR (
          subscription.status = 'past_due'
          AND subscription.entitlement_payment_id IS NOT NULL
          AND subscription.entitlement_trial_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM public.pro_entitlement_grants AS retry_grace
            WHERE retry_grace.user_id = p_user_id
              AND retry_grace.source = 'stripe_payment_retry_grace'
              AND retry_grace.grant_kind = 'absolute'
              AND retry_grace.revoked_at IS NULL
              AND retry_grace.starts_at <= v_now
              AND retry_grace.expires_at > v_now
              AND retry_grace.metadata ->> 'stripe_subscription_id' =
                subscription.stripe_subscription_id
              AND retry_grace.metadata ->> 'episode_closed_at' IS NULL
          )
        )
      )
    ORDER BY subscription.current_period_end DESC NULLS LAST,
      subscription.id
    LIMIT 1
    FOR UPDATE;
    v_has_subscription := FOUND;
  END IF;

  IF v_has_subscription AND v_subscription.status = 'past_due' THEN
    SELECT pg_catalog.max(retry_grace.expires_at)
    INTO v_recurring_expires_at
    FROM public.pro_entitlement_grants AS retry_grace
    WHERE retry_grace.user_id = p_user_id
      AND retry_grace.source = 'stripe_payment_retry_grace'
      AND retry_grace.grant_kind = 'absolute'
      AND retry_grace.revoked_at IS NULL
      AND retry_grace.starts_at <= v_now
      AND retry_grace.expires_at > v_now
      AND retry_grace.metadata ->> 'stripe_subscription_id' =
        v_subscription.stripe_subscription_id
      AND retry_grace.metadata ->> 'episode_closed_at' IS NULL;
  ELSIF v_has_subscription THEN
    v_recurring_expires_at := v_subscription.current_period_end;
  END IF;

  IF v_profile.banned_at IS NULL
    AND NOT (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > v_now
      )
    )
  THEN
    SELECT
      authority.has_grant,
      authority.has_lifetime_grant,
      authority.grant_expires_at
    INTO v_has_grant, v_has_lifetime_grant, v_grant_expires_at
    FROM public.current_exact_pro_grant_authority_v2(
      p_user_id,
      v_now
    ) AS authority;
  END IF;

  IF NOT v_has_subscription
    AND NOT v_has_grant
    AND NOT public.account_recovery_billing_surface_is_blocked_v2(p_user_id)
    AND EXISTS (
      SELECT 1
      FROM public.stripe_manual_reviews AS review
      WHERE review.state = 'open'
        AND review.user_id = p_user_id
        AND review.reason_key IN (
          'ambiguous_legacy_pro_projection',
          'unsupported_legacy_stripe_projection'
        )
    )
  THEN
    RETURN public.has_current_global_pro_entitlement(p_user_id);
  END IF;

  IF v_has_subscription THEN
    UPDATE public.user_profiles
    SET subscription_tier = 'pro',
        pro_plan = v_subscription.plan,
        pro_expires_at = CASE
          WHEN v_has_grant AND v_grant_expires_at IS NULL THEN NULL
          WHEN v_recurring_expires_at IS NULL THEN v_grant_expires_at
          WHEN v_grant_expires_at IS NULL THEN v_recurring_expires_at
          ELSE GREATEST(
            v_recurring_expires_at,
            v_grant_expires_at
          )
        END,
        is_pro = true,
        stripe_customer_id = COALESCE(
          v_subscription.stripe_customer_id,
          stripe_customer_id
        ),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_user_id
      AND deleted_at IS NULL;
  ELSIF v_has_grant THEN
    UPDATE public.user_profiles
    SET subscription_tier = 'pro',
        pro_plan = CASE
          WHEN v_has_lifetime_grant THEN 'lifetime'
          ELSE NULL
        END,
        pro_expires_at = v_grant_expires_at,
        is_pro = true,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_user_id
      AND deleted_at IS NULL;
  ELSE
    UPDATE public.user_profiles
    SET subscription_tier = 'free',
        pro_plan = NULL,
        pro_expires_at = NULL,
        is_pro = false,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_user_id
      AND deleted_at IS NULL;
  END IF;

  RETURN public.stripe_has_current_pro_authority_v2(p_user_id);
END
$function$;

ALTER FUNCTION public.sync_current_pro_projection_atomic(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_current_pro_projection_atomic(uuid)
  FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.sync_current_pro_projection_atomic(uuid)
  TO service_role;

-- Move the pre-gate implementations behind owner-only names.  Public RPC
-- names first take the account-recovery lock, so the recovery transition can
-- never race a newly admitted Checkout Session.  Conversion remains a
-- financial observation: it is serialized here but deliberately persists
-- while blocked; the signed activation boundary owns refund/cancel handling.
ALTER FUNCTION public.reserve_pro_membership_checkout_atomic(
  uuid, boolean, text, text, text, bigint, text, smallint, text, text
) RENAME TO reserve_pro_membership_checkout_pre_recovery_v2;
ALTER FUNCTION public.bind_pro_membership_checkout_session_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint
) RENAME TO bind_pro_membership_checkout_session_pre_recovery_v2;
ALTER FUNCTION public.convert_pro_membership_checkout_reservation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, text,
  text, text, bigint, bigint, text, bigint
) RENAME TO convert_pro_membership_checkout_pre_recovery_v2;

CREATE OR REPLACE FUNCTION public.reserve_pro_membership_checkout_atomic(
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_pro_plan text,
  p_stripe_price_id text,
  p_unit_amount bigint,
  p_currency text,
  p_trial_days smallint,
  p_success_url text,
  p_cancel_url text
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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'checkout owner is required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  IF public.account_recovery_billing_surface_is_blocked_v2(p_user_id) THEN
    RAISE EXCEPTION 'account recovery billing surface is blocked'
      USING ERRCODE = '42501';
  END IF;
  RETURN public.reserve_pro_membership_checkout_pre_recovery_v2(
    p_user_id,
    p_livemode,
    p_stripe_customer_id,
    p_pro_plan,
    p_stripe_price_id,
    p_unit_amount,
    p_currency,
    p_trial_days,
    p_success_url,
    p_cancel_url
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.bind_pro_membership_checkout_session_atomic(
  p_reservation_id uuid,
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_pro_plan text,
  p_stripe_price_id text,
  p_unit_amount bigint,
  p_currency text,
  p_trial_days smallint,
  p_checkout_session_id text,
  p_checkout_expires_at bigint
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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'checkout owner is required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  IF public.account_recovery_billing_surface_is_blocked_v2(p_user_id) THEN
    RAISE EXCEPTION 'account recovery billing surface is blocked'
      USING ERRCODE = '42501';
  END IF;
  RETURN public.bind_pro_membership_checkout_session_pre_recovery_v2(
    p_reservation_id,
    p_user_id,
    p_livemode,
    p_stripe_customer_id,
    p_pro_plan,
    p_stripe_price_id,
    p_unit_amount,
    p_currency,
    p_trial_days,
    p_checkout_session_id,
    p_checkout_expires_at
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.convert_pro_membership_checkout_reservation_atomic(
  p_reservation_id uuid,
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_pro_plan text,
  p_stripe_price_id text,
  p_unit_amount bigint,
  p_currency text,
  p_trial_days smallint,
  p_checkout_session_id text,
  p_stripe_subscription_id text,
  p_payment_status text,
  p_subscription_status text,
  p_trial_start bigint,
  p_trial_end bigint,
  p_stripe_event_id text,
  p_stripe_event_created bigint
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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'checkout owner is required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  RETURN public.convert_pro_membership_checkout_pre_recovery_v2(
    p_reservation_id,
    p_user_id,
    p_livemode,
    p_stripe_customer_id,
    p_pro_plan,
    p_stripe_price_id,
    p_unit_amount,
    p_currency,
    p_trial_days,
    p_checkout_session_id,
    p_stripe_subscription_id,
    p_payment_status,
    p_subscription_status,
    p_trial_start,
    p_trial_end,
    p_stripe_event_id,
    p_stripe_event_created
  );
END
$function$;

ALTER FUNCTION public.reserve_pro_membership_checkout_atomic(
  uuid, boolean, text, text, text, bigint, text, smallint, text, text
) OWNER TO postgres;
ALTER FUNCTION public.bind_pro_membership_checkout_session_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint
) OWNER TO postgres;
ALTER FUNCTION public.convert_pro_membership_checkout_reservation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, text,
  text, text, bigint, bigint, text, bigint
) OWNER TO postgres;
ALTER FUNCTION public.reserve_pro_membership_checkout_pre_recovery_v2(
  uuid, boolean, text, text, text, bigint, text, smallint, text, text
) OWNER TO postgres;
ALTER FUNCTION public.bind_pro_membership_checkout_session_pre_recovery_v2(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint
) OWNER TO postgres;
ALTER FUNCTION public.convert_pro_membership_checkout_pre_recovery_v2(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, text,
  text, text, bigint, bigint, text, bigint
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.reserve_pro_membership_checkout_pre_recovery_v2(
  uuid, boolean, text, text, text, bigint, text, smallint, text, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.bind_pro_membership_checkout_session_pre_recovery_v2(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.convert_pro_membership_checkout_pre_recovery_v2(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, text,
  text, text, bigint, bigint, text, bigint
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.reserve_pro_membership_checkout_atomic(
  uuid, boolean, text, text, text, bigint, text, smallint, text, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.bind_pro_membership_checkout_session_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.convert_pro_membership_checkout_reservation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, text,
  text, text, bigint, bigint, text, bigint
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.reserve_pro_membership_checkout_atomic(
  uuid, boolean, text, text, text, bigint, text, smallint, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_pro_membership_checkout_session_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.convert_pro_membership_checkout_reservation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, text,
  text, text, bigint, bigint, text, bigint
) TO service_role;

-- All other Checkout admission writers use the same recovery-first lock.
-- Historical implementations stay owner-only behind renamed functions.
ALTER FUNCTION public.bind_stripe_customer_owner_atomic(
  uuid, text, text
) RENAME TO bind_stripe_customer_owner_pre_recovery_v2;
ALTER FUNCTION public.reserve_lifetime_membership_spot_atomic(
  uuid, text, integer
) RENAME TO reserve_lifetime_membership_spot_pre_recovery_v2;
ALTER FUNCTION public.bind_lifetime_membership_reservation_session_atomic(
  uuid, uuid, text, text, timestamptz
) RENAME TO bind_lifetime_membership_reservation_session_pre_recovery_v2;
ALTER FUNCTION public.release_lifetime_membership_reservation_atomic(
  uuid, uuid, text, text, text, text, timestamptz
) RENAME TO release_lifetime_membership_reservation_pre_recovery_v2;

CREATE OR REPLACE FUNCTION public.bind_stripe_customer_owner_atomic(
  p_user_id uuid,
  p_new_stripe_customer_id text,
  p_expected_previous_stripe_customer_id text
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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'Stripe customer binding owner is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  IF public.account_recovery_billing_surface_is_blocked_v2(p_user_id) THEN
    RAISE EXCEPTION 'account recovery blocks Stripe customer binding'
      USING ERRCODE = '42501';
  END IF;
  RETURN public.bind_stripe_customer_owner_pre_recovery_v2(
    p_user_id,
    p_new_stripe_customer_id,
    p_expected_previous_stripe_customer_id
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.reserve_lifetime_membership_spot_atomic(
  p_user_id uuid,
  p_request_nonce text,
  p_ttl_seconds integer,
  p_livemode boolean
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
  v_result jsonb;
  v_reservation_id uuid;
  v_bound_mode boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_livemode IS NULL THEN
    RAISE EXCEPTION 'lifetime reservation mode identity is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  IF public.account_recovery_billing_surface_is_blocked_v2(p_user_id) THEN
    RAISE EXCEPTION 'account recovery blocks lifetime checkout creation'
      USING ERRCODE = '42501';
  END IF;

  v_result := public.reserve_lifetime_membership_spot_pre_recovery_v2(
    p_user_id, p_request_nonce, p_ttl_seconds
  );
  IF COALESCE(v_result ->> 'status', '') IN (
      'reserved', 'already_reserved', 'reservation_exists'
    )
    AND v_result ->> 'reservation_id' IS NOT NULL
  THEN
    BEGIN
      v_reservation_id := (v_result ->> 'reservation_id')::uuid;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'lifetime reservation returned malformed identity'
        USING ERRCODE = '23514';
    END;
    UPDATE public.stripe_lifetime_seat_reservations AS reservation
    SET livemode = p_livemode,
        updated_at = GREATEST(
          reservation.updated_at,
          pg_catalog.clock_timestamp()
        )
    WHERE reservation.id = v_reservation_id
      AND reservation.user_id = p_user_id
      AND reservation.status IN ('reserved', 'bound')
      AND reservation.livemode IS NULL
    RETURNING reservation.livemode INTO v_bound_mode;
    IF NOT FOUND THEN
      SELECT reservation.livemode INTO v_bound_mode
      FROM public.stripe_lifetime_seat_reservations AS reservation
      WHERE reservation.id = v_reservation_id
        AND reservation.user_id = p_user_id
        AND reservation.status IN ('reserved', 'bound')
      FOR UPDATE;
    END IF;
    IF NOT FOUND OR v_bound_mode IS DISTINCT FROM p_livemode THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'identity_conflict',
        'reservation_id', v_reservation_id
      );
    END IF;
  END IF;
  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.bind_lifetime_membership_reservation_session_atomic(
  p_user_id uuid,
  p_reservation_id uuid,
  p_request_nonce text,
  p_checkout_session_id text,
  p_session_expires_at timestamptz,
  p_livemode boolean
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
  v_reservation public.stripe_lifetime_seat_reservations%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_livemode IS NULL THEN
    RAISE EXCEPTION 'lifetime reservation binding mode is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  IF public.account_recovery_billing_surface_is_blocked_v2(p_user_id) THEN
    RAISE EXCEPTION 'account recovery blocks lifetime checkout binding'
      USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-lifetime-seat-capacity', 0)
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
  SELECT reservation.* INTO v_reservation
  FROM public.stripe_lifetime_seat_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_reservation.user_id IS DISTINCT FROM p_user_id
      OR v_reservation.request_nonce IS DISTINCT FROM p_request_nonce
      OR v_reservation.checkout_expires_at
        IS DISTINCT FROM p_session_expires_at
      OR (
        v_reservation.livemode IS NOT NULL
        AND v_reservation.livemode IS DISTINCT FROM p_livemode
      )
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    UPDATE public.stripe_lifetime_seat_reservations AS reservation
    SET livemode = p_livemode,
        updated_at = GREATEST(
          reservation.updated_at,
          pg_catalog.clock_timestamp()
        )
    WHERE reservation.id = p_reservation_id
      AND reservation.status IN ('reserved', 'bound')
      AND reservation.livemode IS NULL;
  END IF;
  RETURN public.bind_lifetime_membership_reservation_session_pre_recovery_v2(
    p_user_id, p_reservation_id, p_request_nonce, p_checkout_session_id,
    p_session_expires_at
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.release_lifetime_membership_reservation_atomic(
  p_user_id uuid,
  p_reservation_id uuid,
  p_request_nonce text,
  p_checkout_session_id text,
  p_release_reason text,
  p_event_id text,
  p_event_created_at timestamptz
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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'lifetime reservation release owner is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  RETURN public.release_lifetime_membership_reservation_pre_recovery_v2(
    p_user_id, p_reservation_id, p_request_nonce, p_checkout_session_id,
    p_release_reason, p_event_id, p_event_created_at
  );
END
$function$;

ALTER FUNCTION public.reserve_api_tier_checkout_atomic(
  uuid, boolean, text, text, text
) RENAME TO reserve_api_tier_checkout_pre_recovery_v2;
ALTER FUNCTION public.bind_api_tier_checkout_session_atomic(
  uuid, uuid, boolean, text, text, text, text, bigint
) RENAME TO bind_api_tier_checkout_session_pre_recovery_v2;

CREATE OR REPLACE FUNCTION public.reserve_api_tier_checkout_atomic(
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_api_plan text,
  p_stripe_price_id text
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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'API tier reservation owner is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  IF public.account_recovery_billing_surface_is_blocked_v2(p_user_id) THEN
    RAISE EXCEPTION 'account recovery blocks API tier checkout creation'
      USING ERRCODE = '42501';
  END IF;
  RETURN public.reserve_api_tier_checkout_pre_recovery_v2(
    p_user_id, p_livemode, p_stripe_customer_id, p_api_plan,
    p_stripe_price_id
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.bind_api_tier_checkout_session_atomic(
  p_reservation_id uuid,
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_api_plan text,
  p_stripe_price_id text,
  p_checkout_session_id text,
  p_checkout_expires_at bigint
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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'API tier binding owner is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  IF public.account_recovery_billing_surface_is_blocked_v2(p_user_id) THEN
    RAISE EXCEPTION 'account recovery blocks API tier checkout binding'
      USING ERRCODE = '42501';
  END IF;
  RETURN public.bind_api_tier_checkout_session_pre_recovery_v2(
    p_reservation_id, p_user_id, p_livemode, p_stripe_customer_id,
    p_api_plan, p_stripe_price_id, p_checkout_session_id,
    p_checkout_expires_at
  );
END
$function$;

ALTER FUNCTION public.reserve_tip_checkout_atomic(
  uuid, uuid, bigint, text, integer
) RENAME TO reserve_tip_checkout_pre_recovery_v2;
ALTER FUNCTION public.bind_tip_checkout_session_atomic(
  uuid, uuid, text, timestamptz
) RENAME TO bind_tip_checkout_session_pre_recovery_v2;

CREATE OR REPLACE FUNCTION public.reserve_tip_checkout_atomic(
  p_from_user_id uuid,
  p_post_id uuid,
  p_amount_cents bigint,
  p_message text,
  p_checkout_ttl_seconds integer DEFAULT 3600
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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_from_user_id IS NULL THEN
    RAISE EXCEPTION 'tip reservation payer is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_from_user_id::text,
      0
    )
  );
  IF public.account_recovery_billing_surface_is_blocked_v2(p_from_user_id) THEN
    RAISE EXCEPTION 'account recovery blocks tip checkout creation'
      USING ERRCODE = '42501';
  END IF;
  RETURN public.reserve_tip_checkout_pre_recovery_v2(
    p_from_user_id, p_post_id, p_amount_cents, p_message,
    p_checkout_ttl_seconds
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.bind_tip_checkout_session_atomic(
  p_tip_id uuid,
  p_from_user_id uuid,
  p_checkout_session_id text,
  p_checkout_expires_at timestamptz
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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_from_user_id IS NULL THEN
    RAISE EXCEPTION 'tip binding payer is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_from_user_id::text,
      0
    )
  );
  IF public.account_recovery_billing_surface_is_blocked_v2(p_from_user_id) THEN
    RAISE EXCEPTION 'account recovery blocks tip checkout binding'
      USING ERRCODE = '42501';
  END IF;
  RETURN public.bind_tip_checkout_session_pre_recovery_v2(
    p_tip_id, p_from_user_id, p_checkout_session_id,
    p_checkout_expires_at
  );
END
$function$;

ALTER FUNCTION public.reserve_lifetime_membership_spot_atomic(
  uuid, text, integer, boolean
) OWNER TO postgres;
ALTER FUNCTION public.bind_stripe_customer_owner_atomic(
  uuid, text, text
) OWNER TO postgres;
ALTER FUNCTION public.bind_lifetime_membership_reservation_session_atomic(
  uuid, uuid, text, text, timestamptz, boolean
) OWNER TO postgres;
ALTER FUNCTION public.release_lifetime_membership_reservation_atomic(
  uuid, uuid, text, text, text, text, timestamptz
) OWNER TO postgres;
ALTER FUNCTION public.reserve_api_tier_checkout_atomic(
  uuid, boolean, text, text, text
) OWNER TO postgres;
ALTER FUNCTION public.bind_api_tier_checkout_session_atomic(
  uuid, uuid, boolean, text, text, text, text, bigint
) OWNER TO postgres;
ALTER FUNCTION public.reserve_tip_checkout_atomic(
  uuid, uuid, bigint, text, integer
) OWNER TO postgres;
ALTER FUNCTION public.bind_tip_checkout_session_atomic(
  uuid, uuid, text, timestamptz
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.reserve_lifetime_membership_spot_pre_recovery_v2(
  uuid, text, integer
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.bind_stripe_customer_owner_pre_recovery_v2(
  uuid, text, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.bind_lifetime_membership_reservation_session_pre_recovery_v2(
  uuid, uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.release_lifetime_membership_reservation_pre_recovery_v2(
  uuid, uuid, text, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.reserve_api_tier_checkout_pre_recovery_v2(
  uuid, boolean, text, text, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.bind_api_tier_checkout_session_pre_recovery_v2(
  uuid, uuid, boolean, text, text, text, text, bigint
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.reserve_tip_checkout_pre_recovery_v2(
  uuid, uuid, bigint, text, integer
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.bind_tip_checkout_session_pre_recovery_v2(
  uuid, uuid, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

REVOKE ALL ON FUNCTION public.reserve_lifetime_membership_spot_atomic(
  uuid, text, integer, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.bind_stripe_customer_owner_atomic(
  uuid, text, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.bind_lifetime_membership_reservation_session_atomic(
  uuid, uuid, text, text, timestamptz, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.release_lifetime_membership_reservation_atomic(
  uuid, uuid, text, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.reserve_api_tier_checkout_atomic(
  uuid, boolean, text, text, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.bind_api_tier_checkout_session_atomic(
  uuid, uuid, boolean, text, text, text, text, bigint
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.reserve_tip_checkout_atomic(
  uuid, uuid, bigint, text, integer
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.bind_tip_checkout_session_atomic(
  uuid, uuid, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

GRANT EXECUTE ON FUNCTION public.reserve_lifetime_membership_spot_atomic(
  uuid, text, integer, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_stripe_customer_owner_atomic(
  uuid, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_lifetime_membership_reservation_session_atomic(
  uuid, uuid, text, text, timestamptz, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_lifetime_membership_reservation_atomic(
  uuid, uuid, text, text, text, text, timestamptz
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_api_tier_checkout_atomic(
  uuid, boolean, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_api_tier_checkout_session_atomic(
  uuid, uuid, boolean, text, text, text, text, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_tip_checkout_atomic(
  uuid, uuid, bigint, text, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_tip_checkout_session_atomic(
  uuid, uuid, text, timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.lock_pro_profile_activity_transition_statement()
RETURNS trigger
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
BEGIN
  -- Statement timing runs before tuple locks, preserving the global
  -- official-group lock order for the row trigger's synchronous leave.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  RETURN NULL;
END
$function$;

ALTER FUNCTION public.lock_pro_profile_activity_transition_statement()
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.reproject_pro_on_profile_activity_transition()
RETURNS trigger
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
  v_subscription public.subscriptions%ROWTYPE;
  v_has_subscription boolean := false;
  v_has_grant boolean := false;
  v_has_lifetime_grant boolean := false;
  v_grant_expires_at timestamptz;
  v_grant_boundary timestamptz;
  v_authority_boundary timestamptz;
  v_leave_ack jsonb;
  v_previous_auth_role text;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF NEW.deleted_at IS NOT NULL
    OR NEW.banned_at IS NOT NULL
    OR COALESCE(NEW.is_banned, false)
  THEN
    IF OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
      OR OLD.banned_at IS DISTINCT FROM NEW.banned_at
      OR OLD.is_banned IS DISTINCT FROM NEW.is_banned
    THEN
      v_previous_auth_role := pg_catalog.current_setting(
        'request.jwt.claim.role', true
      );
      PERFORM pg_catalog.set_config(
        'request.jwt.claim.role', 'service_role', true
      );
      v_leave_ack := public.leave_pro_official_group_atomic(NEW.id);
      PERFORM pg_catalog.set_config(
        'request.jwt.claim.role', COALESCE(v_previous_auth_role, ''), true
      );
      IF COALESCE(v_leave_ack ->> 'status', '')
        NOT IN ('left', 'not_member')
      THEN
        RAISE EXCEPTION 'profile activity transition group leave returned invalid status';
      END IF;
    END IF;
    NEW.subscription_tier := 'free';
    NEW.pro_plan := NULL;
    NEW.pro_expires_at := NULL;
    NEW.is_pro := false;
    RETURN NEW;
  END IF;

  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    -- Account recovery is not an unban. The recovery finalizer must first
    -- retrieve and verify fresh Stripe billing state; clearing deleted_at
    -- alone can never reactivate a stale local Subscription projection.
    NEW.subscription_tier := 'free';
    NEW.pro_plan := NULL;
    NEW.pro_expires_at := NULL;
    NEW.is_pro := false;
    RETURN NEW;
  END IF;

  IF OLD.deleted_at IS NULL
    AND OLD.banned_at IS NULL
    AND NOT COALESCE(OLD.is_banned, false)
  THEN
    RETURN NEW;
  END IF;

  -- Direct admin/cron unban writes must converge immediately; neither path is
  -- allowed to wait for another Stripe webhook. Exact binding helpers do not
  -- consult the mutable profile projection and are therefore safe here.
  SELECT subscription.* INTO v_subscription
  FROM public.subscriptions AS subscription
  WHERE subscription.user_id = NEW.id
    AND (
      (
        subscription.status = 'active'
        AND subscription.entitlement_payment_id IS NOT NULL
      )
      OR (
        subscription.status = 'trialing'
        AND subscription.entitlement_trial_id IS NOT NULL
      )
      OR (
        subscription.status = 'past_due'
        AND subscription.entitlement_payment_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.pro_entitlement_grants AS retry_grace
          WHERE retry_grace.user_id = NEW.id
            AND retry_grace.source = 'stripe_payment_retry_grace'
            AND retry_grace.revoked_at IS NULL
            AND retry_grace.starts_at <= v_now
            AND retry_grace.expires_at > v_now
            AND retry_grace.metadata ->> 'stripe_subscription_id' =
              subscription.stripe_subscription_id
            AND retry_grace.metadata ->> 'episode_closed_at' IS NULL
        )
      )
    )
    AND subscription.tier = 'pro'
    AND (
      subscription.current_period_end IS NULL
      OR subscription.current_period_end > v_now
    )
    AND public.b2c_subscription_has_exact_committed_authority_v2(
      NEW.id,
      subscription.stripe_subscription_id,
      NULL
    )
  FOR UPDATE;
  v_has_subscription := FOUND;

  SELECT
    authority.has_grant,
    authority.has_lifetime_grant,
    authority.grant_expires_at,
    authority.authority_boundary
  INTO
    v_has_grant,
    v_has_lifetime_grant,
    v_grant_expires_at,
    v_grant_boundary
  FROM public.current_exact_pro_grant_authority_v2(
    NEW.id,
    v_now
  ) AS authority;

  IF v_has_subscription THEN
    NEW.subscription_tier := 'pro';
    NEW.pro_plan := v_subscription.plan;
    NEW.pro_expires_at := CASE
      WHEN v_subscription.current_period_end IS NULL
        OR (v_has_grant AND v_grant_expires_at IS NULL)
      THEN NULL
      ELSE GREATEST(
        v_subscription.current_period_end,
        v_grant_expires_at
      )
    END;
    NEW.is_pro := true;
    NEW.stripe_customer_id := COALESCE(
      v_subscription.stripe_customer_id,
      NEW.stripe_customer_id
    );
  ELSIF v_has_grant THEN
    NEW.subscription_tier := 'pro';
    NEW.pro_plan := CASE
      WHEN v_has_lifetime_grant THEN 'lifetime'
      ELSE NULL
    END;
    NEW.pro_expires_at := v_grant_expires_at;
    NEW.is_pro := true;
  ELSE
    NEW.subscription_tier := 'free';
    NEW.pro_plan := NULL;
    NEW.pro_expires_at := NULL;
    NEW.is_pro := false;
  END IF;

  IF NEW.is_pro THEN
    SELECT pg_catalog.max(boundary.boundary_at)
    INTO v_authority_boundary
    FROM (
      VALUES
        (CASE WHEN v_has_subscription
          THEN v_subscription.current_period_start
          ELSE NULL
        END),
        (v_grant_boundary)
    ) AS boundary(boundary_at);

    INSERT INTO public.stripe_entitlement_effects (
      entitlement_payment_id,
      user_id,
      source_kind,
      source_key,
      operation_key,
      effect_type,
      payload
    ) VALUES (
      NULL,
      NEW.id,
      'projection',
      NEW.id::text,
      'unban_restore:' || COALESCE(OLD.banned_at, OLD.updated_at)::text,
      'pro_official_group_restore',
      pg_catalog.jsonb_build_object(
        'boundary_at', COALESCE(v_authority_boundary, v_now),
        'inactive_boundary_at', COALESCE(OLD.banned_at, OLD.updated_at),
        'unban_transition_at', v_now
      )
    )
    ON CONFLICT (
      source_kind,
      source_key,
      effect_type,
      operation_key
    ) DO NOTHING;
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.reproject_pro_on_profile_activity_transition()
  OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_lock_pro_profile_activity_transition_statement
  ON public.user_profiles;
CREATE TRIGGER trg_lock_pro_profile_activity_transition_statement
  BEFORE UPDATE OF deleted_at, banned_at, is_banned
  ON public.user_profiles
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.lock_pro_profile_activity_transition_statement();

DROP TRIGGER IF EXISTS trg_reproject_pro_on_profile_activity_transition
  ON public.user_profiles;
CREATE TRIGGER trg_reproject_pro_on_profile_activity_transition
  BEFORE UPDATE OF
    deleted_at,
    banned_at,
    is_banned,
    subscription_tier,
    pro_plan,
    pro_expires_at,
    is_pro
  ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.reproject_pro_on_profile_activity_transition();

-- Existing inactive rows predate the transition trigger. Make their mutable
-- projection fail closed now; a later unban re-evaluates the remaining exact
-- authority in the same profile UPDATE.
UPDATE public.user_profiles
SET subscription_tier = 'free',
    pro_plan = NULL,
    pro_expires_at = NULL,
    is_pro = false,
    updated_at = pg_catalog.clock_timestamp()
WHERE deleted_at IS NOT NULL
   OR banned_at IS NOT NULL
   OR COALESCE(is_banned, false);

DO $remove_existing_inactive_group_edges$
DECLARE
  v_profile record;
  v_leave_ack jsonb;
  v_previous_auth_role text;
BEGIN
  v_previous_auth_role := pg_catalog.current_setting(
    'request.jwt.claim.role', true
  );
  PERFORM pg_catalog.set_config(
    'request.jwt.claim.role', 'service_role', true
  );
  FOR v_profile IN
    SELECT profile.id
    FROM public.user_profiles AS profile
    WHERE profile.deleted_at IS NOT NULL
       OR profile.banned_at IS NOT NULL
       OR COALESCE(profile.is_banned, false)
    ORDER BY profile.id
  LOOP
    v_leave_ack := public.leave_pro_official_group_atomic(v_profile.id);
    IF COALESCE(v_leave_ack ->> 'status', '')
      NOT IN ('left', 'not_member')
    THEN
      RAISE EXCEPTION 'inactive profile group cleanup returned invalid status';
    END IF;
  END LOOP;
  PERFORM pg_catalog.set_config(
    'request.jwt.claim.role', COALESCE(v_previous_auth_role, ''), true
  );
END
$remove_existing_inactive_group_edges$;

CREATE OR REPLACE FUNCTION public.account_recovery_billing_target_snapshot_is_exact_v2(
  p_snapshot jsonb,
  p_digest text
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_identity jsonb;
  v_target jsonb;
  v_array jsonb;
  v_array_key text;
  v_status text;
  v_api_count integer;
  v_retired_count integer;
  v_unknown_count integer;
  v_current_count integer;
  v_schedule_count integer;
  v_target_id text;
  v_period_start timestamptz;
  v_period_end timestamptz;
BEGIN
  IF p_snapshot IS NULL
    OR p_digest IS NULL
    OR p_digest !~ '^[0-9a-f]{64}$'
    OR pg_catalog.jsonb_typeof(p_snapshot) IS DISTINCT FROM 'object'
    OR public.jsonb_object_key_count_v2(p_snapshot) <> 9
    OR NOT p_snapshot ?& ARRAY[
      'status', 'stripe_customer_id', 'target_digest', 'b2c_target',
      'api_target_count', 'retired_b2c_count',
      'unclassified_target_count', 'livemode', 'target_identity'
    ]::text[]
    OR p_snapshot ->> 'status' NOT IN ('resolved', 'manual_review')
    OR p_snapshot ->> 'target_digest' IS DISTINCT FROM p_digest
    OR pg_catalog.jsonb_typeof(p_snapshot -> 'livemode')
      IS DISTINCT FROM 'boolean'
    OR pg_catalog.jsonb_typeof(p_snapshot -> 'target_identity')
      IS DISTINCT FROM 'object'
  THEN
    RETURN false;
  END IF;

  v_identity := p_snapshot -> 'target_identity';
  IF public.jsonb_object_key_count_v2(v_identity) <> 11
    OR NOT v_identity ?& ARRAY[
      'version', 'livemode', 'stripe_customer_id',
      'schedule_subscription_ids', 'b2c_target', 'api_subscription_ids',
      'retired_b2c_subscription_ids', 'unclassified_subscription_ids',
      'conflicting_subscription_ids', 'decision_status',
      'current_target_count'
    ]::text[]
    OR pg_catalog.jsonb_typeof(v_identity -> 'version')
      IS DISTINCT FROM 'number'
    OR v_identity ->> 'version' IS DISTINCT FROM '2'
    OR v_identity -> 'livemode' IS DISTINCT FROM p_snapshot -> 'livemode'
    OR v_identity -> 'stripe_customer_id'
      IS DISTINCT FROM p_snapshot -> 'stripe_customer_id'
    OR v_identity -> 'b2c_target'
      IS DISTINCT FROM p_snapshot -> 'b2c_target'
    OR v_identity ->> 'decision_status'
      IS DISTINCT FROM p_snapshot ->> 'status'
  THEN
    RETURN false;
  END IF;

  IF pg_catalog.jsonb_typeof(p_snapshot -> 'stripe_customer_id') = 'string' THEN
    IF p_snapshot ->> 'stripe_customer_id' !~ '^cus_[A-Za-z0-9_]+$'
      OR pg_catalog.length(p_snapshot ->> 'stripe_customer_id') > 255
    THEN
      RETURN false;
    END IF;
  ELSIF pg_catalog.jsonb_typeof(p_snapshot -> 'stripe_customer_id')
    IS DISTINCT FROM 'null'
  THEN
    RETURN false;
  END IF;

  FOREACH v_array_key IN ARRAY ARRAY[
    'schedule_subscription_ids', 'api_subscription_ids',
    'retired_b2c_subscription_ids', 'unclassified_subscription_ids',
    'conflicting_subscription_ids'
  ]::text[]
  LOOP
    v_array := v_identity -> v_array_key;
    IF pg_catalog.jsonb_typeof(v_array) IS DISTINCT FROM 'array'
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_array) AS item(value)
        WHERE pg_catalog.jsonb_typeof(item.value) IS DISTINCT FROM 'string'
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements_text(v_array) AS item(value)
        WHERE item.value !~ '^sub_[A-Za-z0-9_]+$'
          OR pg_catalog.length(item.value) > 255
      )
      OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements_text(v_array) AS item(value)
      ) IS DISTINCT FROM (
        SELECT pg_catalog.count(DISTINCT item.value)
        FROM pg_catalog.jsonb_array_elements_text(v_array) AS item(value)
      )
      OR COALESCE(
        (
          SELECT pg_catalog.jsonb_agg(item.value ORDER BY item.value)
          FROM pg_catalog.jsonb_array_elements_text(v_array) AS item(value)
        ),
        '[]'::jsonb
      ) IS DISTINCT FROM v_array
    THEN
      RETURN false;
    END IF;
  END LOOP;

  IF pg_catalog.jsonb_typeof(p_snapshot -> 'api_target_count')
      IS DISTINCT FROM 'number'
    OR pg_catalog.jsonb_typeof(p_snapshot -> 'retired_b2c_count')
      IS DISTINCT FROM 'number'
    OR pg_catalog.jsonb_typeof(p_snapshot -> 'unclassified_target_count')
      IS DISTINCT FROM 'number'
    OR pg_catalog.jsonb_typeof(v_identity -> 'current_target_count')
      IS DISTINCT FROM 'number'
    OR p_snapshot ->> 'api_target_count' !~ '^(0|[1-9][0-9]*)$'
    OR p_snapshot ->> 'retired_b2c_count' !~ '^(0|[1-9][0-9]*)$'
    OR p_snapshot ->> 'unclassified_target_count' !~ '^(0|[1-9][0-9]*)$'
    OR v_identity ->> 'current_target_count' !~ '^(0|[1-9][0-9]*)$'
  THEN
    RETURN false;
  END IF;
  v_api_count := (p_snapshot ->> 'api_target_count')::integer;
  v_retired_count := (p_snapshot ->> 'retired_b2c_count')::integer;
  v_unknown_count := (p_snapshot ->> 'unclassified_target_count')::integer;
  v_current_count := (v_identity ->> 'current_target_count')::integer;
  v_schedule_count := pg_catalog.jsonb_array_length(
    v_identity -> 'schedule_subscription_ids'
  );
  IF v_api_count IS DISTINCT FROM pg_catalog.jsonb_array_length(
      v_identity -> 'api_subscription_ids'
    )
    OR v_retired_count IS DISTINCT FROM pg_catalog.jsonb_array_length(
      v_identity -> 'retired_b2c_subscription_ids'
    )
    OR v_unknown_count IS DISTINCT FROM pg_catalog.jsonb_array_length(
      v_identity -> 'unclassified_subscription_ids'
    )
    OR v_current_count > v_schedule_count
    OR (v_schedule_count > 0 AND p_snapshot -> 'stripe_customer_id' = 'null'::jsonb)
  THEN
    RETURN false;
  END IF;

  -- Every classified identity is part of the frozen deletion observation.
  IF EXISTS (
      SELECT item.value
      FROM (
        SELECT value
        FROM pg_catalog.jsonb_array_elements_text(
          v_identity -> 'api_subscription_ids'
        )
        UNION
        SELECT value
        FROM pg_catalog.jsonb_array_elements_text(
          v_identity -> 'retired_b2c_subscription_ids'
        )
        UNION
        SELECT value
        FROM pg_catalog.jsonb_array_elements_text(
          v_identity -> 'unclassified_subscription_ids'
        )
      ) AS item(value)
      WHERE NOT (v_identity -> 'schedule_subscription_ids')
        ? item.value
    )
    OR EXISTS (
      SELECT conflict.value
      FROM pg_catalog.jsonb_array_elements_text(
        v_identity -> 'conflicting_subscription_ids'
      ) AS conflict(value)
      WHERE NOT (v_identity -> 'api_subscription_ids') ? conflict.value
        OR NOT (
          (v_identity -> 'retired_b2c_subscription_ids') ? conflict.value
          OR v_identity -> 'b2c_target' ->> 'stripe_subscription_id' =
            conflict.value
        )
    )
    OR EXISTS (
      SELECT scheduled.value
      FROM pg_catalog.jsonb_array_elements_text(
        v_identity -> 'schedule_subscription_ids'
      ) AS scheduled(value)
      WHERE NOT (v_identity -> 'api_subscription_ids') ? scheduled.value
        AND NOT (v_identity -> 'retired_b2c_subscription_ids')
          ? scheduled.value
        AND NOT (v_identity -> 'unclassified_subscription_ids')
          ? scheduled.value
        AND COALESCE(
          v_identity -> 'b2c_target' ->> 'stripe_subscription_id',
          ''
        ) IS DISTINCT FROM scheduled.value
    )
    OR EXISTS (
      SELECT unknown.value
      FROM pg_catalog.jsonb_array_elements_text(
        v_identity -> 'unclassified_subscription_ids'
      ) AS unknown(value)
      WHERE (v_identity -> 'api_subscription_ids') ? unknown.value
        OR (v_identity -> 'retired_b2c_subscription_ids') ? unknown.value
        OR COALESCE(
          v_identity -> 'b2c_target' ->> 'stripe_subscription_id',
          ''
        ) = unknown.value
    )
    OR EXISTS (
      SELECT api.value
      FROM pg_catalog.jsonb_array_elements_text(
        v_identity -> 'api_subscription_ids'
      ) AS api(value)
      WHERE (
          (v_identity -> 'retired_b2c_subscription_ids') ? api.value
          OR COALESCE(
            v_identity -> 'b2c_target' ->> 'stripe_subscription_id',
            ''
          ) = api.value
        )
        AND NOT (v_identity -> 'conflicting_subscription_ids') ? api.value
    )
  THEN
    RETURN false;
  END IF;

  v_target := p_snapshot -> 'b2c_target';
  IF v_target = 'null'::jsonb THEN
    v_target := NULL;
  ELSE
    IF pg_catalog.jsonb_typeof(v_target) IS DISTINCT FROM 'object'
      OR public.jsonb_object_key_count_v2(v_target) <> 8
      OR NOT v_target ?& ARRAY[
        'stripe_subscription_id', 'authority_kind', 'plan',
        'period_start', 'period_end', 'stripe_price_id',
        'expected_amount', 'currency'
      ]::text[]
      OR pg_catalog.jsonb_typeof(v_target -> 'stripe_subscription_id')
        IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_target -> 'authority_kind')
        IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_target -> 'plan') IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_target -> 'period_start')
        IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_target -> 'period_end')
        IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_target -> 'stripe_price_id')
        IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(v_target -> 'expected_amount')
        IS DISTINCT FROM 'number'
      OR pg_catalog.jsonb_typeof(v_target -> 'currency')
        IS DISTINCT FROM 'string'
      OR v_target ->> 'stripe_subscription_id' !~ '^sub_[A-Za-z0-9_]+$'
      OR pg_catalog.length(v_target ->> 'stripe_subscription_id') > 255
      OR v_target ->> 'authority_kind' NOT IN ('paid', 'trial')
      OR v_target ->> 'plan' NOT IN ('monthly', 'yearly')
      OR v_target ->> 'stripe_price_id' !~ '^price_[A-Za-z0-9_]+$'
      OR pg_catalog.length(v_target ->> 'stripe_price_id') > 255
      OR v_target ->> 'expected_amount' !~ '^[1-9][0-9]*$'
      OR v_target ->> 'currency' !~ '^[a-z]{3}$'
    THEN
      RETURN false;
    END IF;
    v_period_start := (v_target ->> 'period_start')::timestamptz;
    v_period_end := (v_target ->> 'period_end')::timestamptz;
    v_target_id := v_target ->> 'stripe_subscription_id';
    IF v_period_end <= v_period_start
      OR NOT (v_identity -> 'schedule_subscription_ids') ? v_target_id
      OR (v_identity -> 'retired_b2c_subscription_ids') ? v_target_id
    THEN
      RETURN false;
    END IF;
  END IF;

  v_status := p_snapshot ->> 'status';
  IF (
      v_status = 'resolved'
      AND (
        (v_current_count = 0 AND v_target IS NOT NULL)
        OR (v_current_count = 1 AND v_target IS NULL)
        OR v_current_count > 1
      )
    )
    OR (v_status = 'manual_review' AND v_target IS NOT NULL)
    OR v_status IS DISTINCT FROM (CASE
      WHEN v_current_count > 1
        OR pg_catalog.jsonb_array_length(
          v_identity -> 'conflicting_subscription_ids'
        ) > 0
        OR v_unknown_count > 0
      THEN 'manual_review'
      ELSE 'resolved'
    END)
    OR pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(v_identity::text, 'UTF8')
      ),
      'hex'
    ) IS DISTINCT FROM p_digest
  THEN
    RETURN false;
  END IF;
  RETURN true;
EXCEPTION
  WHEN others THEN
    RETURN false;
END
$function$;

ALTER FUNCTION public.account_recovery_billing_target_snapshot_is_exact_v2(
  jsonb, text
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.account_recovery_frozen_b2c_target_matches_v2(
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_invoice_id text,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_stripe_price_id text,
  p_plan text,
  p_expected_amount bigint,
  p_currency text,
  p_period_start timestamptz,
  p_period_end timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT p_user_id IS NOT NULL
    AND p_livemode IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.account_recovery_admissions AS admission
      WHERE admission.user_id = p_user_id
        AND admission.state = 'finished'
        AND COALESCE(
          admission.auth_finalization_state NOT IN (
            'completed', 'superseded'
          ),
          true
        )
        AND admission.recovery_billing_v2_result IS NULL
        AND public.account_recovery_billing_target_snapshot_is_exact_v2(
          admission.recovery_billing_target_snapshot,
          admission.recovery_billing_target_digest
        )
        AND (admission.recovery_billing_target_snapshot ->> 'livemode')::boolean
          IS NOT DISTINCT FROM p_livemode
        AND admission.recovery_billing_target_snapshot ->>
          'stripe_customer_id' IS NOT DISTINCT FROM p_stripe_customer_id
        AND admission.recovery_billing_target_snapshot -> 'b2c_target'
          IS NOT DISTINCT FROM pg_catalog.jsonb_build_object(
            'stripe_subscription_id', p_stripe_subscription_id,
            'authority_kind', 'paid',
            'plan', p_plan,
            'period_start', p_period_start,
            'period_end', p_period_end,
            'stripe_price_id', p_stripe_price_id,
            'expected_amount', p_expected_amount,
            'currency', p_currency
          )
        AND EXISTS (
          SELECT 1
          FROM public.subscriptions AS subscription
          JOIN public.stripe_entitlement_payments AS payment
            ON payment.id = subscription.entitlement_payment_id
          JOIN public.stripe_payment_ownerships AS ownership
            ON ownership.product_kind = 'pro_entitlement'
           AND ownership.ledger_id = payment.id
          WHERE subscription.user_id = p_user_id
            AND subscription.stripe_customer_id = p_stripe_customer_id
            AND subscription.stripe_subscription_id =
              p_stripe_subscription_id
            AND subscription.plan = p_plan
            AND subscription.current_period_start = p_period_start
            AND subscription.current_period_end = p_period_end
            AND subscription.entitlement_trial_id IS NULL
            AND payment.user_id = p_user_id
            AND payment.payment_kind = 'recurring'
            AND payment.plan = p_plan
            AND payment.stripe_customer_id = p_stripe_customer_id
            AND payment.stripe_subscription_id = p_stripe_subscription_id
            AND payment.stripe_invoice_id = p_stripe_invoice_id
            AND payment.stripe_payment_intent_id IS NOT DISTINCT FROM
              p_stripe_payment_intent_id
            AND payment.stripe_charge_id = p_stripe_charge_id
            AND payment.amount_paid = p_expected_amount
            AND payment.currency = p_currency
            AND payment.period_start = p_period_start
            AND payment.period_end = p_period_end
            AND payment.payment_status IN ('paid', 'succeeded')
            AND ownership.owner_user_id = p_user_id
            AND ownership.stripe_customer_id = p_stripe_customer_id
            AND ownership.stripe_payment_intent_id IS NOT DISTINCT FROM
              p_stripe_payment_intent_id
            AND ownership.stripe_charge_id = p_stripe_charge_id
            AND ownership.amount_paid = p_expected_amount
            AND ownership.currency = p_currency
            AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
        )
    )
$function$;

ALTER FUNCTION public.account_recovery_frozen_b2c_target_matches_v2(
  uuid, boolean, text, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_recovery_frozen_b2c_target_matches_v2(
  uuid, boolean, text, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.account_recovery_frozen_b2c_trial_target_matches_v2(
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_plan text,
  p_expected_amount bigint,
  p_currency text,
  p_period_start timestamptz,
  p_period_end timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT p_user_id IS NOT NULL
    AND p_livemode IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.account_recovery_admissions AS admission
      WHERE admission.user_id = p_user_id
        AND admission.state = 'finished'
        AND COALESCE(
          admission.auth_finalization_state NOT IN (
            'completed', 'superseded'
          ),
          true
        )
        AND admission.recovery_billing_v2_result IS NULL
        AND public.account_recovery_billing_target_snapshot_is_exact_v2(
          admission.recovery_billing_target_snapshot,
          admission.recovery_billing_target_digest
        )
        AND (admission.recovery_billing_target_snapshot ->> 'livemode')::boolean
          IS NOT DISTINCT FROM p_livemode
        AND admission.recovery_billing_target_snapshot ->>
          'stripe_customer_id' IS NOT DISTINCT FROM p_stripe_customer_id
        AND admission.recovery_billing_target_snapshot -> 'b2c_target'
          IS NOT DISTINCT FROM pg_catalog.jsonb_build_object(
            'stripe_subscription_id', p_stripe_subscription_id,
            'authority_kind', 'trial',
            'plan', p_plan,
            'period_start', p_period_start,
            'period_end', p_period_end,
            'stripe_price_id', p_stripe_price_id,
            'expected_amount', p_expected_amount,
            'currency', p_currency
          )
        AND EXISTS (
          SELECT 1
          FROM public.subscriptions AS subscription
          JOIN public.stripe_trial_entitlements AS trial
            ON trial.id = subscription.entitlement_trial_id
          WHERE subscription.user_id = p_user_id
            AND subscription.stripe_customer_id = p_stripe_customer_id
            AND subscription.stripe_subscription_id =
              p_stripe_subscription_id
            AND subscription.plan = p_plan
            AND subscription.current_period_start = p_period_start
            AND subscription.current_period_end = p_period_end
            AND subscription.entitlement_payment_id IS NULL
            AND subscription.entitlement_trial_verified_at = trial.verified_at
            AND trial.user_id = p_user_id
            AND trial.stripe_customer_id = p_stripe_customer_id
            AND trial.stripe_subscription_id = p_stripe_subscription_id
            AND trial.plan = p_plan
            AND trial.period_start = p_period_start
            AND trial.period_end = p_period_end
            AND trial.revoked_at IS NULL
            AND EXISTS (
              SELECT 1
              FROM public.stripe_b2c_recurring_activations AS activation
              WHERE activation.livemode = p_livemode
                AND activation.activation_committed_at IS NOT NULL
                AND activation.authority_kind = 'trial'
                AND activation.user_id = p_user_id
                AND activation.stripe_customer_id = p_stripe_customer_id
                AND activation.stripe_subscription_id =
                  p_stripe_subscription_id
                AND activation.stripe_price_id = p_stripe_price_id
                AND activation.plan = p_plan
                AND activation.expected_amount = p_expected_amount
                AND activation.currency = p_currency
                AND activation.period_start = p_period_start
                AND activation.period_end = p_period_end
            )
        )
    )
$function$;

ALTER FUNCTION public.account_recovery_frozen_b2c_trial_target_matches_v2(
  uuid, boolean, text, text, text, text, bigint, text,
  timestamptz, timestamptz
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_recovery_frozen_b2c_trial_target_matches_v2(
  uuid, boolean, text, text, text, text, bigint, text,
  timestamptz, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.resolve_account_recovery_billing_targets_v2_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_capability_hash text,
  p_attempt_id uuid,
  p_livemode boolean
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
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_fence public.account_deletion_auth_fences%ROWTYPE;
  v_schedule_ids text[] := ARRAY[]::text[];
  v_b2c_ids text[] := ARRAY[]::text[];
  v_b2c_strong_ids text[] := ARRAY[]::text[];
  v_b2c_weak_ids text[] := ARRAY[]::text[];
  v_api_ids text[] := ARRAY[]::text[];
  v_conflict_ids text[] := ARRAY[]::text[];
  v_unknown_ids text[] := ARRAY[]::text[];
  v_retired_b2c_ids text[] := ARRAY[]::text[];
  v_b2c_target jsonb;
  v_target_id text;
  v_target_count integer := 0;
  v_target_identity jsonb;
  v_target_digest text;
  v_ack jsonb;
  v_status text := 'resolved';
  v_deleted_at timestamptz;
  v_deletion_scheduled_at timestamptz;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_operation_id IS NULL
    OR p_attempt_id IS NULL
    OR p_livemode IS NULL
    OR p_capability_hash IS NULL
    OR p_capability_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid account recovery billing target input'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  SELECT admission.* INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_admission.user_id IS DISTINCT FROM p_user_id
    OR v_admission.state IS DISTINCT FROM 'finished'
    OR v_admission.auth_finalization_state IS DISTINCT FROM 'billing_pending'
    OR v_admission.auth_finalization_capability_hash
      IS DISTINCT FROM p_capability_hash
    OR v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
    OR v_admission.auth_finalization_attempt_expires_at IS NULL
    OR v_admission.auth_finalization_attempt_expires_at <= v_now
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF v_admission.recovery_billing_target_snapshot IS NOT NULL THEN
    IF NOT public.account_recovery_billing_target_snapshot_is_exact_v2(
        v_admission.recovery_billing_target_snapshot,
        v_admission.recovery_billing_target_digest
      )
      OR (v_admission.recovery_billing_target_snapshot ->> 'livemode')::boolean
        IS DISTINCT FROM p_livemode
    THEN
      RAISE EXCEPTION 'account recovery billing target snapshot drifted'
        USING ERRCODE = '23514';
    END IF;
    RETURN v_admission.recovery_billing_target_snapshot
      - 'livemode'
      - 'target_identity';
  END IF;

  SELECT fence.* INTO v_fence
  FROM public.account_deletion_auth_fences AS fence
  WHERE fence.user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_fence.state IS DISTINCT FROM 'completed'
    OR v_fence.schedule_ack IS NULL
    OR pg_catalog.jsonb_typeof(v_fence.schedule_ack) IS DISTINCT FROM 'object'
    OR public.jsonb_object_key_count_v2(v_fence.schedule_ack) <> 6
    OR NOT v_fence.schedule_ack ?& ARRAY[
      'status', 'user_id', 'deleted_at', 'deletion_scheduled_at',
      'stripe_customer_id', 'stripe_subscription_ids'
    ]::text[]
    OR v_fence.schedule_ack ->> 'status' IS DISTINCT FROM 'scheduled'
    OR v_fence.schedule_ack ->> 'user_id' IS DISTINCT FROM p_user_id::text
    OR pg_catalog.jsonb_typeof(v_fence.schedule_ack -> 'deleted_at')
      IS DISTINCT FROM 'string'
    OR pg_catalog.jsonb_typeof(
      v_fence.schedule_ack -> 'deletion_scheduled_at'
    ) IS DISTINCT FROM 'string'
    OR pg_catalog.jsonb_typeof(
      v_fence.schedule_ack -> 'stripe_subscription_ids'
    ) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_typeof(v_fence.schedule_ack -> 'stripe_customer_id')
      NOT IN ('string', 'null')
    OR (
      pg_catalog.jsonb_typeof(v_fence.schedule_ack -> 'stripe_customer_id') =
        'string'
      AND (
        v_fence.schedule_ack ->> 'stripe_customer_id'
          !~ '^cus_[A-Za-z0-9_]+$'
        OR pg_catalog.length(
          v_fence.schedule_ack ->> 'stripe_customer_id'
        ) > 255
      )
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.jsonb_array_elements(
        v_fence.schedule_ack -> 'stripe_subscription_ids'
      ) AS supplied(value)
      WHERE pg_catalog.jsonb_typeof(supplied.value) IS DISTINCT FROM 'string'
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  BEGIN
    v_deleted_at := (v_fence.schedule_ack ->> 'deleted_at')::timestamptz;
    v_deletion_scheduled_at :=
      (v_fence.schedule_ack ->> 'deletion_scheduled_at')::timestamptz;
  EXCEPTION
    WHEN others THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END;
  IF v_deleted_at > v_deletion_scheduled_at THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(candidate.subscription_id ORDER BY candidate.subscription_id),
    ARRAY[]::text[]
  ) INTO v_schedule_ids
  FROM (
    SELECT DISTINCT supplied.subscription_id
    FROM pg_catalog.jsonb_array_elements_text(
      v_fence.schedule_ack -> 'stripe_subscription_ids'
    ) AS supplied(subscription_id)
  ) AS candidate;
  IF pg_catalog.cardinality(v_schedule_ids) IS DISTINCT FROM
      pg_catalog.jsonb_array_length(
        v_fence.schedule_ack -> 'stripe_subscription_ids'
      )
    OR (
      pg_catalog.cardinality(v_schedule_ids) > 0
      AND v_fence.schedule_ack -> 'stripe_customer_id' = 'null'::jsonb
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(v_schedule_ids) AS supplied(subscription_id)
      WHERE supplied.subscription_id !~ '^sub_[A-Za-z0-9_]+$'
        OR pg_catalog.length(supplied.subscription_id) > 255
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(supplied.subscription_id ORDER BY supplied.subscription_id),
    ARRAY[]::text[]
  ) INTO v_b2c_strong_ids
  FROM pg_catalog.unnest(v_schedule_ids) AS supplied(subscription_id)
  WHERE EXISTS (
      SELECT 1
      FROM public.stripe_b2c_recurring_activations AS activation
      WHERE activation.livemode = p_livemode
        AND activation.user_id = p_user_id
        AND activation.stripe_customer_id =
          v_fence.schedule_ack ->> 'stripe_customer_id'
        AND activation.stripe_subscription_id = supplied.subscription_id
        AND (
          activation.activation_committed_at IS NOT NULL
          OR activation.outcome IN (
            'current_entitlement_protected', 'stale_payment',
            'terminal_trial_recorded', 'refunded_payment', 'subject_deleted'
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.pro_membership_checkout_reservations AS reservation
      WHERE reservation.livemode = p_livemode
        AND reservation.user_id = p_user_id
        AND reservation.stripe_customer_id =
          v_fence.schedule_ack ->> 'stripe_customer_id'
        AND reservation.stripe_subscription_id = supplied.subscription_id
        AND reservation.status IN ('converted', 'retired')
    );

  SELECT COALESCE(
    pg_catalog.array_agg(supplied.subscription_id ORDER BY supplied.subscription_id),
    ARRAY[]::text[]
  ) INTO v_b2c_weak_ids
  FROM pg_catalog.unnest(v_schedule_ids) AS supplied(subscription_id)
  WHERE EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.product_kind = 'pro_entitlement'
       AND ownership.ledger_id = payment.id
      WHERE payment.payment_kind = 'recurring'
        AND payment.user_id = p_user_id
        AND payment.stripe_customer_id =
          v_fence.schedule_ack ->> 'stripe_customer_id'
        AND payment.stripe_subscription_id = supplied.subscription_id
        AND ownership.owner_user_id = p_user_id
        AND ownership.stripe_customer_id = payment.stripe_customer_id
        AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_trial_entitlements AS trial
      WHERE trial.user_id = p_user_id
        AND trial.stripe_customer_id =
          v_fence.schedule_ack ->> 'stripe_customer_id'
        AND trial.stripe_subscription_id = supplied.subscription_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.subscriptions AS subscription
      JOIN public.pro_entitlement_grants AS entitlement_grant
        ON entitlement_grant.user_id = subscription.user_id
       AND entitlement_grant.source = 'legacy_stripe_snapshot'
       AND entitlement_grant.source_key =
         'subscription:' || subscription.id::text
      WHERE subscription.user_id = p_user_id
        AND subscription.stripe_customer_id =
          v_fence.schedule_ack ->> 'stripe_customer_id'
        AND subscription.stripe_subscription_id = supplied.subscription_id
        AND public.stripe_legacy_snapshot_grant_is_exact_v2(
          entitlement_grant.id
        )
    );

  SELECT COALESCE(
    pg_catalog.array_agg(candidate.subscription_id ORDER BY candidate.subscription_id),
    ARRAY[]::text[]
  ) INTO v_b2c_ids
  FROM (
    SELECT DISTINCT supplied.subscription_id
    FROM pg_catalog.unnest(
      v_b2c_strong_ids || v_b2c_weak_ids
    ) AS supplied(subscription_id)
  ) AS candidate;

  IF pg_catalog.to_regclass('public.api_tier_stripe_event_ledger') IS NOT NULL
    AND pg_catalog.to_regclass('public.api_tier_checkout_reservations') IS NOT NULL
  THEN
    EXECUTE $query$
      SELECT COALESCE(
        pg_catalog.array_agg(
          supplied.subscription_id ORDER BY supplied.subscription_id
        ),
        ARRAY[]::text[]
      )
      FROM pg_catalog.unnest($1::text[]) AS supplied(subscription_id)
      WHERE EXISTS (
          SELECT 1
          FROM public.api_tier_stripe_event_ledger AS ledger
          WHERE ledger.user_id = $2
            AND ledger.livemode = $3
            AND ledger.stripe_customer_id = $4
            AND ledger.stripe_subscription_id = supplied.subscription_id
        )
        OR EXISTS (
          SELECT 1
          FROM public.api_tier_checkout_reservations AS reservation
          WHERE reservation.user_id = $2
            AND reservation.livemode = $3
            AND reservation.stripe_customer_id = $4
            AND reservation.stripe_subscription_id = supplied.subscription_id
            AND reservation.status = 'converted'
        )
    $query$
    INTO v_api_ids
    USING
      v_schedule_ids,
      p_user_id,
      p_livemode,
      v_fence.schedule_ack ->> 'stripe_customer_id';
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(b2c_id ORDER BY b2c_id), ARRAY[]::text[]
  ) INTO v_conflict_ids
  FROM pg_catalog.unnest(v_b2c_strong_ids) AS b2c(b2c_id)
  WHERE b2c_id = ANY(v_api_ids);

  SELECT COALESCE(
    pg_catalog.array_agg(supplied.subscription_id ORDER BY supplied.subscription_id),
    ARRAY[]::text[]
  ) INTO v_unknown_ids
  FROM pg_catalog.unnest(v_schedule_ids) AS supplied(subscription_id)
  WHERE NOT supplied.subscription_id = ANY(v_b2c_ids)
    AND NOT supplied.subscription_id = ANY(v_api_ids);

  -- Count and freeze only candidates backed by the same exact committed
  -- activation that supplies the product price/amount identity.  Keeping the
  -- count and selected row in one query removes the old count/select split
  -- where a weak legacy row could count as one but yield no recoverable target.
  WITH candidate AS (
      SELECT
        subscription.stripe_subscription_id AS target_id,
        pg_catalog.jsonb_build_object(
          'stripe_subscription_id', subscription.stripe_subscription_id,
          'authority_kind', activation.authority_kind,
          'plan', subscription.plan,
          'period_start', subscription.current_period_start,
          'period_end', subscription.current_period_end,
          'stripe_price_id', activation.stripe_price_id,
          'expected_amount', activation.expected_amount,
          'currency', activation.currency
        ) AS target
      FROM public.subscriptions AS subscription
      JOIN LATERAL (
        SELECT committed_activation.*
        FROM public.stripe_b2c_recurring_activations AS committed_activation
        WHERE committed_activation.livemode = p_livemode
          AND committed_activation.user_id = p_user_id
          AND committed_activation.stripe_customer_id =
            subscription.stripe_customer_id
          AND committed_activation.stripe_subscription_id =
            subscription.stripe_subscription_id
          AND committed_activation.plan = subscription.plan
          AND committed_activation.period_start =
            subscription.current_period_start
          AND committed_activation.period_end = subscription.current_period_end
          AND committed_activation.activation_committed_at IS NOT NULL
          AND (
            (
              committed_activation.authority_kind = 'paid'
              AND subscription.entitlement_payment_id IS NOT NULL
              AND subscription.entitlement_trial_id IS NULL
            )
            OR (
              committed_activation.authority_kind = 'trial'
              AND subscription.entitlement_payment_id IS NULL
              AND subscription.entitlement_trial_id IS NOT NULL
            )
          )
        ORDER BY
          committed_activation.source_event_created_at DESC,
          committed_activation.source_event_id DESC
        LIMIT 1
      ) AS activation ON true
      WHERE subscription.user_id = p_user_id
        AND subscription.plan IN ('monthly', 'yearly')
        AND subscription.stripe_customer_id =
          v_fence.schedule_ack ->> 'stripe_customer_id'
        AND subscription.stripe_subscription_id = ANY(v_schedule_ids)
        AND subscription.current_period_start IS NOT NULL
        AND subscription.current_period_end IS NOT NULL
        AND subscription.current_period_end > v_now
        AND (
          (
            activation.authority_kind = 'paid'
            AND EXISTS (
              SELECT 1
              FROM public.stripe_entitlement_payments AS payment
              JOIN public.stripe_payment_ownerships AS ownership
                ON ownership.product_kind = 'pro_entitlement'
               AND ownership.ledger_id = payment.id
              WHERE payment.id = subscription.entitlement_payment_id
                AND payment.user_id = p_user_id
                AND payment.payment_kind = 'recurring'
                AND payment.plan = subscription.plan
                AND payment.stripe_customer_id = subscription.stripe_customer_id
                AND payment.stripe_subscription_id =
                  subscription.stripe_subscription_id
                AND payment.period_start = subscription.current_period_start
                AND payment.period_end = subscription.current_period_end
                AND payment.amount_paid = activation.expected_amount
                AND payment.currency = activation.currency
                AND payment.payment_status IN ('paid', 'succeeded')
                AND NOT (
                  payment.refund_state = 'succeeded'
                  AND payment.refund_succeeded_amount >= payment.amount_paid
                )
                AND ownership.owner_user_id = p_user_id
                AND ownership.stripe_customer_id = payment.stripe_customer_id
                AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
            )
          )
          OR (
            activation.authority_kind = 'trial'
            AND EXISTS (
              SELECT 1
              FROM public.stripe_trial_entitlements AS trial
              WHERE trial.id = subscription.entitlement_trial_id
                AND trial.user_id = p_user_id
                AND trial.stripe_customer_id = subscription.stripe_customer_id
                AND trial.stripe_subscription_id =
                  subscription.stripe_subscription_id
                AND trial.plan = subscription.plan
                AND trial.period_start = subscription.current_period_start
                AND trial.period_end = subscription.current_period_end
                AND trial.verified_at =
                  subscription.entitlement_trial_verified_at
                AND trial.revoked_at IS NULL
            )
          )
        )
  )
  SELECT
    pg_catalog.count(*)::integer,
    CASE WHEN pg_catalog.count(*) = 1
      THEN (pg_catalog.array_agg(candidate.target_id ORDER BY candidate.target_id))[1]
      ELSE NULL
    END,
    CASE WHEN pg_catalog.count(*) = 1
      THEN (pg_catalog.jsonb_agg(candidate.target ORDER BY candidate.target_id) -> 0)
      ELSE NULL
    END
  INTO v_target_count, v_target_id, v_b2c_target
  FROM candidate;

  IF v_target_count > 1
    OR pg_catalog.cardinality(v_conflict_ids) > 0
    OR pg_catalog.cardinality(v_unknown_ids) > 0
  THEN
    v_status := 'manual_review';
    v_target_id := NULL;
    v_b2c_target := NULL;
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(b2c_id ORDER BY b2c_id), ARRAY[]::text[]
  ) INTO v_retired_b2c_ids
  FROM pg_catalog.unnest(v_b2c_ids) AS b2c(b2c_id)
  WHERE v_target_id IS NULL OR b2c_id IS DISTINCT FROM v_target_id;

  v_target_identity := pg_catalog.jsonb_build_object(
    'version', 2,
    'livemode', p_livemode,
    'stripe_customer_id', v_fence.schedule_ack ->> 'stripe_customer_id',
    'schedule_subscription_ids', pg_catalog.to_jsonb(v_schedule_ids),
    'b2c_target', v_b2c_target,
    'api_subscription_ids', pg_catalog.to_jsonb(v_api_ids),
    'retired_b2c_subscription_ids', pg_catalog.to_jsonb(v_retired_b2c_ids),
    'unclassified_subscription_ids', pg_catalog.to_jsonb(v_unknown_ids),
    'conflicting_subscription_ids', pg_catalog.to_jsonb(v_conflict_ids),
    'decision_status', v_status,
    'current_target_count', v_target_count
  );
  v_target_digest := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(v_target_identity::text, 'UTF8')
    ),
    'hex'
  );
  v_ack := pg_catalog.jsonb_build_object(
    'status', v_status,
    'stripe_customer_id', v_fence.schedule_ack ->> 'stripe_customer_id',
    'target_digest', v_target_digest,
    'b2c_target', v_b2c_target,
    'api_target_count', pg_catalog.cardinality(v_api_ids),
    'retired_b2c_count', pg_catalog.cardinality(v_retired_b2c_ids),
    'unclassified_target_count', pg_catalog.cardinality(v_unknown_ids)
  );

  UPDATE public.account_recovery_admissions
  SET recovery_billing_target_snapshot = v_ack || pg_catalog.jsonb_build_object(
        'livemode', p_livemode,
        'target_identity', v_target_identity
      ),
      recovery_billing_target_digest = v_target_digest,
      updated_at = GREATEST(updated_at, v_now)
  WHERE operation_id = p_operation_id
    AND user_id = p_user_id
    AND auth_finalization_state = 'billing_pending'
    AND auth_finalization_attempt_id = p_attempt_id
    AND recovery_billing_target_snapshot IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account recovery billing target freeze raced'
      USING ERRCODE = '40001';
  END IF;

  -- Keep the public acknowledgement intentionally small and exact. The richer
  -- frozen identity remains owner-only on the admission row for completion.
  RETURN v_ack;
END
$function$;

ALTER FUNCTION public.resolve_account_recovery_billing_targets_v2_atomic(
  uuid, uuid, text, uuid, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.account_recovery_billing_result_is_exact_v2(
  p_result jsonb,
  p_target_digest text,
  p_expected_resumed boolean
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_resumed boolean;
  v_required boolean;
  v_b2c_state text;
BEGIN
  IF p_result IS NULL
    OR p_target_digest IS NULL
    OR p_target_digest !~ '^[0-9a-f]{64}$'
    OR p_expected_resumed IS NULL
    OR pg_catalog.jsonb_typeof(p_result) IS DISTINCT FROM 'object'
    OR public.jsonb_object_key_count_v2(p_result) <> 6
    OR NOT p_result ?& ARRAY[
      'status', 'b2c_state', 'lifetime_state', 'subscription_resumed',
      'billing_reactivation_required', 'target_digest'
    ]::text[]
    OR p_result ->> 'status' NOT IN (
      'completed_resumed', 'completed_manual'
    )
    OR p_result ->> 'b2c_state' NOT IN (
      'active_restored', 'trial_restored', 'grace_restored',
      'no_b2c_target', 'target_missing', 'retired_nonentitling',
      'identity_conflict', 'manual_review'
    )
    OR p_result ->> 'lifetime_state' NOT IN ('restored', 'not_present')
    OR pg_catalog.jsonb_typeof(p_result -> 'subscription_resumed')
      IS DISTINCT FROM 'boolean'
    OR pg_catalog.jsonb_typeof(
      p_result -> 'billing_reactivation_required'
    ) IS DISTINCT FROM 'boolean'
    OR p_result ->> 'target_digest' IS DISTINCT FROM p_target_digest
  THEN
    RETURN false;
  END IF;
  v_resumed := (p_result ->> 'subscription_resumed')::boolean;
  v_required :=
    (p_result ->> 'billing_reactivation_required')::boolean;
  v_b2c_state := p_result ->> 'b2c_state';
  RETURN v_resumed IS NOT DISTINCT FROM p_expected_resumed
    AND v_resumed IS DISTINCT FROM v_required
    AND p_result ->> 'status' IS NOT DISTINCT FROM CASE
      WHEN v_resumed THEN 'completed_resumed'
      ELSE 'completed_manual'
    END
    AND (
      NOT v_resumed
      OR v_b2c_state IN (
        'active_restored', 'trial_restored', 'no_b2c_target'
      )
    );
EXCEPTION
  WHEN others THEN
    RETURN false;
END
$function$;

ALTER FUNCTION public.account_recovery_billing_result_is_exact_v2(
  jsonb, text, boolean
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_recovery_billing_result_is_exact_v2(
  jsonb, text, boolean
) FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.prevent_account_recovery_billing_v2_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
BEGIN
  IF OLD.recovery_billing_target_snapshot IS NOT NULL
    AND (
      NEW.recovery_billing_target_snapshot IS DISTINCT FROM
        OLD.recovery_billing_target_snapshot
      OR NEW.recovery_billing_target_digest IS DISTINCT FROM
        OLD.recovery_billing_target_digest
    )
  THEN
    RAISE EXCEPTION 'frozen account recovery billing target is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.recovery_billing_target_snapshot IS NULL
    AND NEW.recovery_billing_target_snapshot IS NOT NULL
    AND (
      OLD.auth_finalization_state IS DISTINCT FROM 'billing_pending'
      OR NEW.auth_finalization_state IS DISTINCT FROM 'billing_pending'
      OR NOT public.account_recovery_billing_target_snapshot_is_exact_v2(
        NEW.recovery_billing_target_snapshot,
        NEW.recovery_billing_target_digest
      )
    )
  THEN
    RAISE EXCEPTION 'account recovery billing target freeze is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.recovery_billing_v2_result IS NOT NULL
    AND NEW.recovery_billing_v2_result IS DISTINCT FROM
      OLD.recovery_billing_v2_result
  THEN
    RAISE EXCEPTION 'account recovery billing v2 result is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.recovery_billing_v2_result IS NULL
    AND NEW.recovery_billing_v2_result IS NOT NULL
    AND (
      OLD.auth_finalization_state IS DISTINCT FROM 'billing_pending'
      OR NEW.auth_finalization_state IS DISTINCT FROM 'completed'
      OR NOT public.account_recovery_billing_result_is_exact_v2(
        NEW.recovery_billing_v2_result,
        NEW.recovery_billing_target_digest,
        NEW.recovery_billing_resumed
      )
    )
  THEN
    RAISE EXCEPTION 'account recovery billing v2 result commit is invalid'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.recovery_billing_completed_at IS NOT NULL
    AND NEW.recovery_billing_completed_at IS DISTINCT FROM
      OLD.recovery_billing_completed_at
  THEN
    RAISE EXCEPTION 'account recovery billing completion boundary is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.recovery_billing_completed_at IS NULL
    AND NEW.recovery_billing_completed_at IS NOT NULL
    AND (
      OLD.auth_finalization_state IS DISTINCT FROM 'billing_pending'
      OR NEW.auth_finalization_state IS DISTINCT FROM 'completed'
      OR NEW.recovery_billing_v2_result IS NULL
      OR NEW.recovery_billing_completed_at < NEW.claimed_at
    )
  THEN
    RAISE EXCEPTION 'account recovery billing completion boundary commit is invalid'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.prevent_account_recovery_billing_v2_mutation()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prevent_account_recovery_billing_v2_mutation()
  FROM PUBLIC;

CREATE TRIGGER trg_account_recovery_billing_v2_immutable
  BEFORE UPDATE OF
    recovery_billing_target_snapshot,
    recovery_billing_target_digest,
    recovery_billing_v2_result,
    recovery_billing_completed_at
  ON public.account_recovery_admissions
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_account_recovery_billing_v2_mutation();

ALTER TABLE public.account_recovery_admissions
  DROP CONSTRAINT account_recovery_billing_target_v2_shape,
  DROP CONSTRAINT account_recovery_billing_result_v2_shape,
  ADD CONSTRAINT account_recovery_billing_target_v2_shape CHECK (
    (
      recovery_billing_target_snapshot IS NULL
      AND recovery_billing_target_digest IS NULL
    )
    OR public.account_recovery_billing_target_snapshot_is_exact_v2(
      recovery_billing_target_snapshot,
      recovery_billing_target_digest
    )
  ),
  ADD CONSTRAINT account_recovery_billing_result_v2_shape CHECK (
    recovery_billing_v2_result IS NULL
    OR public.account_recovery_billing_result_is_exact_v2(
      recovery_billing_v2_result,
      recovery_billing_target_digest,
      CASE
        WHEN auth_finalization_state = 'superseded'
          AND recovery_billing_resumed IS NULL
          AND pg_catalog.jsonb_typeof(
            recovery_billing_v2_result -> 'subscription_resumed'
          ) = 'boolean'
        THEN (recovery_billing_v2_result ->> 'subscription_resumed')::boolean
        ELSE recovery_billing_resumed
      END
    )
  ),
  ADD CONSTRAINT account_recovery_billing_completed_v2_shape CHECK (
    (
      recovery_billing_completed_at IS NULL
      AND recovery_billing_v2_result IS NULL
    )
    OR (
      recovery_billing_completed_at IS NOT NULL
      AND recovery_billing_v2_result IS NOT NULL
      AND auth_finalization_state IN ('completed', 'superseded')
      AND recovery_billing_completed_at >= claimed_at
    )
  );

CREATE OR REPLACE FUNCTION public.complete_account_recovery_billing_v2_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_capability_hash text,
  p_attempt_id uuid,
  p_livemode boolean,
  p_target_digest text,
  p_b2c_observation jsonb
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
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_profile public.user_profiles%ROWTYPE;
  v_snapshot jsonb;
  v_target jsonb;
  v_target_id text;
  v_target_kind text;
  v_target_plan text;
  v_target_period_start timestamptz;
  v_target_period_end timestamptz;
  v_target_price_id text;
  v_target_amount bigint;
  v_target_currency text;
  v_observation_missing boolean := false;
  v_observation_status text;
  v_observation_resume_state text;
  v_observation_period_start timestamptz;
  v_observation_period_end timestamptz;
  v_product_shape_exact boolean := false;
  v_local_authority_exact boolean := false;
  v_remote_entitling_mutation boolean := false;
  v_allow_recurring boolean := false;
  v_allow_grace boolean := false;
  v_b2c_state text := 'no_b2c_target';
  v_lifetime_state text := 'not_present';
  v_has_grant boolean := false;
  v_has_lifetime_grant boolean := false;
  v_grant_expires_at timestamptz;
  v_grace_expires_at timestamptz;
  v_projection_expires_at timestamptz;
  v_has_authority boolean := false;
  v_billing_reactivation_required boolean := false;
  v_subscription_resumed boolean := false;
  v_restore_boundary timestamptz;
  v_leave_ack jsonb;
  v_result jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_operation_id IS NULL
    OR p_attempt_id IS NULL
    OR p_livemode IS NULL
    OR p_capability_hash IS NULL
    OR p_capability_hash !~ '^[0-9a-f]{64}$'
    OR p_target_digest IS NULL
    OR p_target_digest !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid account recovery billing v2 completion input'
      USING ERRCODE = '22023';
  END IF;

  -- Preserve the same global lock order used by entitlement writers before
  -- acquiring the profile tuple that the projection UPDATE will touch.
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

  SELECT admission.* INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_admission.user_id IS DISTINCT FROM p_user_id
    OR v_admission.auth_finalization_capability_hash
      IS DISTINCT FROM p_capability_hash
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  IF v_admission.auth_finalization_state = 'completed'
    AND v_admission.recovery_billing_v2_result IS NOT NULL
  THEN
    IF v_admission.recovery_billing_target_digest
        IS DISTINCT FROM p_target_digest
      OR NOT public.account_recovery_billing_target_snapshot_is_exact_v2(
        v_admission.recovery_billing_target_snapshot,
        v_admission.recovery_billing_target_digest
      )
      OR (v_admission.recovery_billing_target_snapshot ->> 'livemode')::boolean
        IS DISTINCT FROM p_livemode
      OR NOT public.account_recovery_billing_result_is_exact_v2(
        v_admission.recovery_billing_v2_result,
        v_admission.recovery_billing_target_digest,
        v_admission.recovery_billing_resumed
      )
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
    RETURN v_admission.recovery_billing_v2_result;
  END IF;
  IF v_admission.state IS DISTINCT FROM 'finished'
    OR v_admission.auth_finalization_state IS DISTINCT FROM 'billing_pending'
    OR v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
    OR v_admission.auth_finalization_attempt_expires_at IS NULL
    OR v_admission.auth_finalization_attempt_expires_at <= v_now
    OR v_admission.recovery_billing_target_digest
      IS DISTINCT FROM p_target_digest
    OR NOT public.account_recovery_billing_target_snapshot_is_exact_v2(
      v_admission.recovery_billing_target_snapshot,
      v_admission.recovery_billing_target_digest
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  v_snapshot := v_admission.recovery_billing_target_snapshot;
  IF (v_snapshot ->> 'livemode')::boolean IS DISTINCT FROM p_livemode THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT profile.* INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  IF v_profile.deleted_at IS NOT NULL
    OR v_profile.banned_at IS NOT NULL
    OR COALESCE(v_profile.is_banned, false)
    OR (
      v_profile.ban_expires_at IS NOT NULL
      AND v_profile.ban_expires_at > v_now
    )
    OR EXISTS (
      SELECT 1
      FROM public.account_deletion_auth_fences AS fence
      WHERE fence.user_id = p_user_id
        AND (
          (
            fence.state = 'prepared'
            AND fence.prepared_at + interval '15 minutes' > v_now
          )
          OR fence.state IN ('billing_pending', 'auth_ban_pending')
        )
    )
  THEN
    UPDATE public.account_recovery_admissions
    SET auth_finalization_state = 'auth_compensation_required',
        auth_finalized_at = NULL,
        recovery_billing_may_have_changed = true,
        auth_finalization_attempt_expires_at = v_now + interval '15 minutes',
        updated_at = GREATEST(updated_at, v_now)
    WHERE operation_id = p_operation_id
      AND auth_finalization_state = 'billing_pending'
      AND auth_finalization_attempt_id = p_attempt_id;
    RETURN pg_catalog.jsonb_build_object(
      'status',
      CASE WHEN FOUND THEN 'compensation_billing' ELSE 'invalid' END
    );
  END IF;

  v_target := v_snapshot -> 'b2c_target';
  IF v_target IS NOT NULL AND v_target <> 'null'::jsonb THEN
    IF pg_catalog.jsonb_typeof(v_target) IS DISTINCT FROM 'object'
      OR public.jsonb_object_key_count_v2(v_target) <> 8
      OR NOT v_target ?& ARRAY[
        'stripe_subscription_id', 'authority_kind', 'plan',
        'period_start', 'period_end', 'stripe_price_id',
        'expected_amount', 'currency'
      ]::text[]
    THEN
      RAISE EXCEPTION 'frozen B2C recovery target shape drifted'
        USING ERRCODE = '23514';
    END IF;
    v_target_id := v_target ->> 'stripe_subscription_id';
    v_target_kind := v_target ->> 'authority_kind';
    v_target_plan := v_target ->> 'plan';
    v_target_period_start := (v_target ->> 'period_start')::timestamptz;
    v_target_period_end := (v_target ->> 'period_end')::timestamptz;
    v_target_price_id := v_target ->> 'stripe_price_id';
    v_target_amount := (v_target ->> 'expected_amount')::bigint;
    v_target_currency := v_target ->> 'currency';
    IF v_target_id !~ '^sub_[A-Za-z0-9_]+$'
      OR v_target_kind NOT IN ('paid', 'trial')
      OR v_target_plan NOT IN ('monthly', 'yearly')
      OR v_target_period_start IS NULL
      OR v_target_period_end <= v_target_period_start
      OR v_target_price_id !~ '^price_[A-Za-z0-9_]+$'
      OR v_target_amount <= 0
      OR v_target_currency !~ '^[a-z]{3}$'
    THEN
      RAISE EXCEPTION 'frozen B2C recovery target identity drifted'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    v_target := NULL;
  END IF;

  IF v_snapshot ->> 'status' = 'manual_review' THEN
    IF p_b2c_observation IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
    v_b2c_state := 'manual_review';
  ELSIF v_target IS NULL THEN
    IF p_b2c_observation IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
    v_b2c_state := 'no_b2c_target';
  ELSE
    IF p_b2c_observation IS NULL THEN
      -- A retrieval that deterministically could not prove the frozen target
      -- must converge to a durable manual result. Returning invalid here made
      -- the route retry an unprovable target forever after Auth was unbanned.
      v_b2c_state := 'identity_conflict';
    ELSIF pg_catalog.jsonb_typeof(p_b2c_observation) IS DISTINCT FROM 'object' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    ELSIF public.jsonb_object_key_count_v2(p_b2c_observation) = 2
      AND p_b2c_observation ?& ARRAY[
        'stripe_subscription_id', 'missing'
      ]::text[]
      AND p_b2c_observation ->> 'stripe_subscription_id' = v_target_id
      AND p_b2c_observation -> 'missing' = 'true'::jsonb
    THEN
      v_observation_missing := true;
      v_b2c_state := 'target_missing';
    ELSIF public.jsonb_object_key_count_v2(p_b2c_observation) = 16
      AND p_b2c_observation ?& ARRAY[
        'stripe_subscription_id', 'stripe_customer_id', 'livemode', 'status',
        'cancel_at_period_end', 'current_period_start', 'current_period_end',
        'resume_state', 'stripe_price_id', 'unit_amount', 'currency',
        'quantity', 'collection_method', 'has_pause_collection',
        'has_pending_update', 'has_subscription_schedule'
      ]::text[]
      AND pg_catalog.jsonb_typeof(p_b2c_observation -> 'livemode') = 'boolean'
      AND pg_catalog.jsonb_typeof(
        p_b2c_observation -> 'cancel_at_period_end'
      ) = 'boolean'
      AND pg_catalog.jsonb_typeof(
        p_b2c_observation -> 'current_period_start'
      ) = 'number'
      AND pg_catalog.jsonb_typeof(
        p_b2c_observation -> 'current_period_end'
      ) = 'number'
      AND pg_catalog.jsonb_typeof(p_b2c_observation -> 'unit_amount') = 'number'
      AND pg_catalog.jsonb_typeof(p_b2c_observation -> 'quantity') = 'number'
      AND pg_catalog.jsonb_typeof(
        p_b2c_observation -> 'has_pause_collection'
      ) = 'boolean'
      AND pg_catalog.jsonb_typeof(
        p_b2c_observation -> 'has_pending_update'
      ) = 'boolean'
      AND pg_catalog.jsonb_typeof(
        p_b2c_observation -> 'has_subscription_schedule'
      ) = 'boolean'
    THEN
      v_observation_status := p_b2c_observation ->> 'status';
      v_observation_resume_state := p_b2c_observation ->> 'resume_state';
      v_remote_entitling_mutation :=
        v_observation_status IN ('active', 'trialing')
        AND v_observation_resume_state IN ('already_active', 'resumed')
        AND NOT (p_b2c_observation ->> 'cancel_at_period_end')::boolean;
      IF (p_b2c_observation ->> 'current_period_start') !~ '^[0-9]+$'
        OR (p_b2c_observation ->> 'current_period_end') !~ '^[0-9]+$'
        OR (p_b2c_observation ->> 'unit_amount') !~ '^[0-9]+$'
        OR (p_b2c_observation ->> 'quantity') !~ '^[0-9]+$'
      THEN
        RETURN pg_catalog.jsonb_build_object('status', 'invalid');
      END IF;
      v_observation_period_start := pg_catalog.to_timestamp(
        (p_b2c_observation ->> 'current_period_start')::bigint
      );
      v_observation_period_end := pg_catalog.to_timestamp(
        (p_b2c_observation ->> 'current_period_end')::bigint
      );
      v_product_shape_exact :=
        p_b2c_observation ->> 'stripe_subscription_id' = v_target_id
        AND p_b2c_observation ->> 'stripe_customer_id' =
          v_snapshot ->> 'stripe_customer_id'
        AND (p_b2c_observation ->> 'livemode')::boolean = p_livemode
        AND v_observation_status IN (
          'active', 'trialing', 'past_due', 'canceled', 'unpaid',
          'incomplete', 'incomplete_expired', 'paused'
        )
        AND v_observation_resume_state IN (
          'already_active', 'resumed', 'ineligible'
        )
        AND v_observation_period_start = v_target_period_start
        AND v_observation_period_end = v_target_period_end
        AND p_b2c_observation ->> 'stripe_price_id' = v_target_price_id
        AND (p_b2c_observation ->> 'unit_amount')::bigint = v_target_amount
        AND p_b2c_observation ->> 'currency' = v_target_currency
        AND (p_b2c_observation ->> 'quantity')::bigint = 1
        AND p_b2c_observation ->> 'collection_method' = 'charge_automatically'
        AND (p_b2c_observation ->> 'has_pause_collection')::boolean = false
        AND (p_b2c_observation ->> 'has_pending_update')::boolean = false
        AND (p_b2c_observation ->> 'has_subscription_schedule')::boolean = false;
      IF NOT v_product_shape_exact THEN
        v_b2c_state := 'identity_conflict';
      ELSIF v_target_kind = 'paid'
        AND v_observation_status = 'active'
        AND v_observation_resume_state IN ('already_active', 'resumed')
        AND NOT (p_b2c_observation ->> 'cancel_at_period_end')::boolean
        AND v_target_period_end > v_now
      THEN
        SELECT EXISTS (
          SELECT 1
          FROM public.subscriptions AS subscription
          JOIN public.stripe_entitlement_payments AS payment
            ON payment.id = subscription.entitlement_payment_id
          JOIN public.stripe_payment_ownerships AS ownership
            ON ownership.product_kind = 'pro_entitlement'
           AND ownership.ledger_id = payment.id
          WHERE subscription.user_id = p_user_id
            AND subscription.stripe_customer_id =
              v_snapshot ->> 'stripe_customer_id'
            AND subscription.stripe_subscription_id = v_target_id
            AND subscription.plan = v_target_plan
            AND subscription.current_period_start = v_target_period_start
            AND subscription.current_period_end = v_target_period_end
            AND subscription.entitlement_trial_id IS NULL
            AND payment.user_id = p_user_id
            AND payment.payment_kind = 'recurring'
            AND payment.plan = v_target_plan
            AND payment.stripe_customer_id = subscription.stripe_customer_id
            AND payment.stripe_subscription_id = v_target_id
            AND payment.period_start = v_target_period_start
            AND payment.period_end = v_target_period_end
            AND payment.amount_paid = v_target_amount
            AND payment.currency = v_target_currency
            AND payment.payment_status IN ('paid', 'succeeded')
            AND NOT (
              payment.refund_state = 'succeeded'
              AND payment.refund_succeeded_amount >= payment.amount_paid
            )
            AND ownership.owner_user_id = p_user_id
            AND ownership.stripe_customer_id = payment.stripe_customer_id
            AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
            AND EXISTS (
              SELECT 1
              FROM public.stripe_b2c_recurring_activations AS activation
              WHERE activation.livemode = p_livemode
                AND activation.activation_committed_at IS NOT NULL
                AND activation.authority_kind = 'paid'
                AND activation.user_id = p_user_id
                AND activation.stripe_customer_id =
                  subscription.stripe_customer_id
                AND activation.stripe_subscription_id = v_target_id
                AND activation.stripe_price_id = v_target_price_id
                AND activation.plan = v_target_plan
                AND activation.expected_amount = v_target_amount
                AND activation.currency = v_target_currency
                AND activation.period_start = v_target_period_start
                AND activation.period_end = v_target_period_end
            )
        ) INTO v_local_authority_exact;
        IF v_local_authority_exact THEN
          UPDATE public.subscriptions
          SET status = 'active',
              cancel_at_period_end = false,
              canceled_at = NULL,
              updated_at = v_now
          WHERE user_id = p_user_id
            AND stripe_subscription_id = v_target_id;
          v_allow_recurring := true;
          v_b2c_state := 'active_restored';
        ELSE
          v_b2c_state := 'identity_conflict';
        END IF;
      ELSIF v_target_kind = 'trial'
        AND v_observation_status = 'trialing'
        AND v_observation_resume_state IN ('already_active', 'resumed')
        AND NOT (p_b2c_observation ->> 'cancel_at_period_end')::boolean
        AND v_target_period_end > v_now
      THEN
        SELECT EXISTS (
          SELECT 1
          FROM public.subscriptions AS subscription
          JOIN public.stripe_trial_entitlements AS trial
            ON trial.id = subscription.entitlement_trial_id
          WHERE subscription.user_id = p_user_id
            AND subscription.stripe_customer_id =
              v_snapshot ->> 'stripe_customer_id'
            AND subscription.stripe_subscription_id = v_target_id
            AND subscription.plan = v_target_plan
            AND subscription.current_period_start = v_target_period_start
            AND subscription.current_period_end = v_target_period_end
            AND subscription.entitlement_payment_id IS NULL
            AND subscription.entitlement_trial_verified_at = trial.verified_at
            AND trial.user_id = p_user_id
            AND trial.stripe_customer_id = subscription.stripe_customer_id
            AND trial.stripe_subscription_id = v_target_id
            AND trial.plan = v_target_plan
            AND trial.period_start = v_target_period_start
            AND trial.period_end = v_target_period_end
            AND trial.revoked_at IS NULL
            AND EXISTS (
              SELECT 1
              FROM public.stripe_b2c_recurring_activations AS activation
              WHERE activation.livemode = p_livemode
                AND activation.activation_committed_at IS NOT NULL
                AND activation.authority_kind = 'trial'
                AND activation.user_id = p_user_id
                AND activation.stripe_customer_id =
                  subscription.stripe_customer_id
                AND activation.stripe_subscription_id = v_target_id
                AND activation.stripe_price_id = v_target_price_id
                AND activation.plan = v_target_plan
                AND activation.expected_amount = v_target_amount
                AND activation.currency = v_target_currency
                AND activation.period_start = v_target_period_start
                AND activation.period_end = v_target_period_end
            )
        ) INTO v_local_authority_exact;
        IF v_local_authority_exact THEN
          UPDATE public.subscriptions
          SET status = 'trialing',
              cancel_at_period_end = false,
              canceled_at = NULL,
              updated_at = v_now
          WHERE user_id = p_user_id
            AND stripe_subscription_id = v_target_id;
          v_allow_recurring := true;
          v_b2c_state := 'trial_restored';
        ELSE
          v_b2c_state := 'identity_conflict';
        END IF;
      ELSIF v_target_kind = 'paid'
        AND v_observation_status = 'past_due'
        AND v_observation_resume_state = 'ineligible'
      THEN
        SELECT pg_catalog.max(retry_grace.expires_at)
        INTO v_grace_expires_at
        FROM public.subscriptions AS subscription
        JOIN public.stripe_entitlement_payments AS payment
          ON payment.id = subscription.entitlement_payment_id
        JOIN public.stripe_payment_ownerships AS ownership
          ON ownership.product_kind = 'pro_entitlement'
         AND ownership.ledger_id = payment.id
        JOIN public.pro_entitlement_grants AS retry_grace
          ON retry_grace.user_id = subscription.user_id
         AND retry_grace.source = 'stripe_payment_retry_grace'
         AND retry_grace.metadata ->> 'stripe_subscription_id' =
           subscription.stripe_subscription_id
         AND retry_grace.metadata ->> 'episode_closed_at' IS NULL
        WHERE subscription.user_id = p_user_id
          AND subscription.status = 'past_due'
          AND subscription.stripe_customer_id =
            v_snapshot ->> 'stripe_customer_id'
          AND subscription.stripe_subscription_id = v_target_id
          AND subscription.plan = v_target_plan
          AND subscription.current_period_start = v_target_period_start
          AND subscription.current_period_end = v_target_period_end
          AND subscription.entitlement_trial_id IS NULL
          AND payment.user_id = p_user_id
          AND payment.payment_kind = 'recurring'
          AND payment.plan = v_target_plan
          AND payment.stripe_customer_id = subscription.stripe_customer_id
          AND payment.stripe_subscription_id = v_target_id
          AND payment.period_start = v_target_period_start
          AND payment.period_end = v_target_period_end
          AND payment.amount_paid = v_target_amount
          AND payment.currency = v_target_currency
          AND payment.payment_status IN ('paid', 'succeeded')
          AND NOT (
            payment.refund_state = 'succeeded'
            AND payment.refund_succeeded_amount >= payment.amount_paid
          )
          AND ownership.owner_user_id = p_user_id
          AND ownership.stripe_customer_id = payment.stripe_customer_id
          AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
          AND EXISTS (
            SELECT 1
            FROM public.stripe_b2c_recurring_activations AS activation
            WHERE activation.livemode = p_livemode
              AND activation.activation_committed_at IS NOT NULL
              AND activation.authority_kind = 'paid'
              AND activation.user_id = p_user_id
              AND activation.stripe_customer_id =
                subscription.stripe_customer_id
              AND activation.stripe_subscription_id = v_target_id
              AND activation.stripe_price_id = v_target_price_id
              AND activation.plan = v_target_plan
              AND activation.expected_amount = v_target_amount
              AND activation.currency = v_target_currency
              AND activation.period_start = v_target_period_start
              AND activation.period_end = v_target_period_end
          )
          AND retry_grace.revoked_at IS NULL
          AND retry_grace.starts_at <= v_now
          AND retry_grace.expires_at > v_now;
        IF v_grace_expires_at IS NOT NULL THEN
          v_allow_grace := true;
          v_b2c_state := 'grace_restored';
        ELSE
          v_b2c_state := 'retired_nonentitling';
        END IF;
      ELSE
        v_b2c_state := 'retired_nonentitling';
      END IF;
    ELSE
      RETURN pg_catalog.jsonb_build_object('status', 'invalid');
    END IF;
  END IF;

  IF v_remote_entitling_mutation AND NOT v_allow_recurring THEN
    -- Stripe was observed in a renewable entitling state, but the frozen local
    -- payment/trial authority no longer validates (refund, revoke, rollover,
    -- or a concurrent webhook rewrite). Do not acknowledge a manual local
    -- result while remote billing can continue: atomically hand ownership to
    -- the exact compensation saga instead.
    UPDATE public.account_recovery_admissions
    SET auth_finalization_state = 'auth_compensation_required',
        auth_finalized_at = NULL,
        recovery_billing_resumed = NULL,
        recovery_billing_may_have_changed = true,
        auth_finalization_attempt_expires_at = v_now + interval '15 minutes',
        updated_at = GREATEST(updated_at, v_now)
    WHERE operation_id = p_operation_id
      AND auth_finalization_state = 'billing_pending'
      AND auth_finalization_attempt_id = p_attempt_id
      AND recovery_billing_target_digest = p_target_digest
      AND recovery_billing_v2_result IS NULL;
    RETURN pg_catalog.jsonb_build_object(
      'status',
      CASE WHEN FOUND THEN 'compensation_billing' ELSE 'invalid' END
    );
  END IF;

  IF v_b2c_state = 'identity_conflict' THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'account_recovery',
      p_operation_id::text,
      p_user_id,
      'recovery_billing_target_identity_unproven',
      'Fresh Stripe state did not exactly prove the frozen B2C recovery target; recurring billing was left non-entitling for manual resolution.',
      pg_catalog.jsonb_build_object(
        'operation_id', p_operation_id,
        'stripe_subscription_id', v_target_id,
        'target_digest', p_target_digest,
        'observation_present', p_b2c_observation IS NOT NULL
      )
    );
  END IF;

  SELECT
    authority.has_grant,
    authority.has_lifetime_grant,
    authority.grant_expires_at
  INTO v_has_grant, v_has_lifetime_grant, v_grant_expires_at
  FROM public.current_exact_pro_grant_authority_ungated_v2(
    p_user_id,
    v_now
  ) AS authority;

  v_has_authority := v_allow_recurring OR v_allow_grace OR v_has_grant;
  IF v_has_lifetime_grant THEN
    v_lifetime_state := 'restored';
  END IF;
  IF v_allow_recurring THEN
    v_projection_expires_at := v_target_period_end;
  ELSIF v_allow_grace THEN
    v_projection_expires_at := v_grace_expires_at;
  END IF;
  IF v_has_grant THEN
    IF v_grant_expires_at IS NULL THEN
      v_projection_expires_at := NULL;
    ELSIF v_projection_expires_at IS NOT NULL THEN
      v_projection_expires_at := GREATEST(
        v_projection_expires_at,
        v_grant_expires_at
      );
    ELSE
      v_projection_expires_at := v_grant_expires_at;
    END IF;
  END IF;

  IF v_has_authority THEN
    UPDATE public.user_profiles
    SET subscription_tier = 'pro',
        pro_plan = CASE
          WHEN v_has_lifetime_grant THEN 'lifetime'
          WHEN v_allow_recurring OR v_allow_grace THEN v_target_plan
          ELSE NULL
        END,
        pro_expires_at = CASE
          WHEN v_has_lifetime_grant THEN NULL
          ELSE v_projection_expires_at
        END,
        is_pro = true,
        stripe_customer_id = COALESCE(
          v_snapshot ->> 'stripe_customer_id',
          stripe_customer_id
        ),
        updated_at = v_now
    WHERE id = p_user_id
      AND deleted_at IS NULL
      AND banned_at IS NULL
      AND NOT COALESCE(is_banned, false);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'account recovery projection eligibility raced'
        USING ERRCODE = '40001';
    END IF;

    v_restore_boundary := COALESCE(
      v_admission.auth_finalized_at,
      v_admission.auth_finalization_prepared_at,
      v_now
    );
    INSERT INTO public.stripe_entitlement_effects (
      entitlement_payment_id,
      user_id,
      source_kind,
      source_key,
      operation_key,
      effect_type,
      payload
    ) VALUES (
      NULL,
      p_user_id,
      'projection',
      p_user_id::text,
      'authority_started:' || v_restore_boundary::text,
      'pro_official_group_join',
      pg_catalog.jsonb_build_object('boundary_at', v_restore_boundary)
    )
    ON CONFLICT (
      source_kind, source_key, effect_type, operation_key
    ) DO NOTHING;
  ELSE
    UPDATE public.user_profiles
    SET subscription_tier = 'free',
        pro_plan = NULL,
        pro_expires_at = NULL,
        is_pro = false,
        updated_at = v_now
    WHERE id = p_user_id;
    v_leave_ack := public.leave_pro_official_group_atomic(p_user_id);
    IF COALESCE(v_leave_ack ->> 'status', '') NOT IN ('left', 'not_member') THEN
      RAISE EXCEPTION 'account recovery official-group leave failed';
    END IF;
  END IF;

  v_billing_reactivation_required :=
    v_snapshot ->> 'status' = 'manual_review'
    OR (v_snapshot ->> 'api_target_count')::integer > 0
    OR (v_snapshot ->> 'retired_b2c_count')::integer > 0
    OR (v_snapshot ->> 'unclassified_target_count')::integer > 0
    OR v_b2c_state NOT IN (
      'active_restored', 'trial_restored', 'no_b2c_target'
    );
  v_subscription_resumed := NOT v_billing_reactivation_required;
  v_result := pg_catalog.jsonb_build_object(
    'status', CASE
      WHEN v_subscription_resumed THEN 'completed_resumed'
      ELSE 'completed_manual'
    END,
    'b2c_state', v_b2c_state,
    'lifetime_state', v_lifetime_state,
    'subscription_resumed', v_subscription_resumed,
    'billing_reactivation_required', v_billing_reactivation_required,
    'target_digest', p_target_digest
  );

  UPDATE public.account_recovery_admissions
  SET auth_finalization_state = 'completed',
      auth_finalization_attempt_id = NULL,
      auth_finalization_attempt_expires_at = NULL,
      recovery_billing_resumed = v_subscription_resumed,
      recovery_billing_may_have_changed = NULL,
      recovery_billing_v2_result = v_result,
      recovery_billing_completed_at = v_now,
      updated_at = GREATEST(updated_at, v_now)
  WHERE operation_id = p_operation_id
    AND auth_finalization_state = 'billing_pending'
    AND auth_finalization_attempt_id = p_attempt_id
    AND recovery_billing_target_digest = p_target_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account recovery billing v2 completion raced'
      USING ERRCODE = '40001';
  END IF;
  RETURN v_result;
END
$function$;

ALTER FUNCTION public.complete_account_recovery_billing_v2_atomic(
  uuid, uuid, text, uuid, boolean, text, jsonb
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.read_account_recovery_billing_result_v2_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_capability_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_operation_id IS NULL
    OR p_capability_hash IS NULL
    OR p_capability_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid account recovery billing v2 result read'
      USING ERRCODE = '22023';
  END IF;

  SELECT admission.* INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = p_operation_id;
  IF NOT FOUND
    OR v_admission.user_id IS DISTINCT FROM p_user_id
    OR v_admission.auth_finalization_capability_hash
      IS DISTINCT FROM p_capability_hash
    OR v_admission.auth_finalization_state IS DISTINCT FROM 'completed'
    OR NOT public.account_recovery_billing_target_snapshot_is_exact_v2(
      v_admission.recovery_billing_target_snapshot,
      v_admission.recovery_billing_target_digest
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  v_result := v_admission.recovery_billing_v2_result;
  IF NOT public.account_recovery_billing_result_is_exact_v2(
    v_result,
    v_admission.recovery_billing_target_digest,
    v_admission.recovery_billing_resumed
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  RETURN v_result;
END
$function$;

ALTER FUNCTION public.read_account_recovery_billing_result_v2_atomic(
  uuid, uuid, text
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.read_account_recovery_billing_compensation_target_v2_atomic(
  p_user_id uuid,
  p_operation_id uuid,
  p_capability_hash text,
  p_attempt_id uuid
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
  v_admission public.account_recovery_admissions%ROWTYPE;
  v_snapshot jsonb;
  v_target jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_operation_id IS NULL
    OR p_attempt_id IS NULL
    OR p_capability_hash IS NULL
    OR p_capability_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid recovery billing compensation target input'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  SELECT admission.* INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_admission.user_id IS DISTINCT FROM p_user_id
    OR v_admission.auth_finalization_capability_hash
      IS DISTINCT FROM p_capability_hash
    OR v_admission.auth_finalization_state
      IS DISTINCT FROM 'auth_compensation_required'
    OR v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
    OR v_admission.auth_finalization_attempt_expires_at IS NULL
    OR v_admission.auth_finalization_attempt_expires_at <= v_now
    OR v_admission.recovery_billing_may_have_changed IS DISTINCT FROM true
    OR v_admission.recovery_billing_v2_result IS NOT NULL
    OR NOT public.account_recovery_billing_target_snapshot_is_exact_v2(
      v_admission.recovery_billing_target_snapshot,
      v_admission.recovery_billing_target_digest
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  v_snapshot := v_admission.recovery_billing_target_snapshot;
  v_target := v_snapshot -> 'b2c_target';
  IF v_target = 'null'::jsonb THEN
    v_target := NULL;
  ELSIF v_snapshot -> 'stripe_customer_id' = 'null'::jsonb THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'compensation_billing',
    'livemode', (v_snapshot ->> 'livemode')::boolean,
    'stripe_customer_id', v_snapshot -> 'stripe_customer_id',
    'target_digest', v_admission.recovery_billing_target_digest,
    'b2c_target', v_target
  );
END
$function$;

ALTER FUNCTION public.read_account_recovery_billing_compensation_target_v2_atomic(
  uuid, uuid, text, uuid
) OWNER TO postgres;

-- Keep completion and timeout compensation on one admission CAS. Whichever
-- transaction obtains the admission lock first becomes durable; a late
-- completion can never overwrite compensation, while a committed completion
-- is returned to the timeout path instead of being canceled speculatively.
CREATE OR REPLACE FUNCTION public.require_account_recovery_auth_compensation_atomic(
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
  IF p_user_id IS NULL
    OR p_operation_id IS NULL
    OR p_attempt_id IS NULL
    OR p_capability_hash IS NULL
    OR p_capability_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid recovery Auth compensation requirement input'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  SELECT admission.* INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_admission.user_id IS DISTINCT FROM p_user_id
    OR v_admission.auth_finalization_capability_hash
      IS DISTINCT FROM p_capability_hash
  THEN
    RETURN 'invalid';
  END IF;
  IF v_admission.auth_finalization_state NOT IN (
      'completed', 'superseded', 'expired_manual'
    )
    AND v_admission.auth_finalization_prepared_at + interval '30 days' <= v_now
  THEN
    UPDATE public.account_recovery_admissions
    SET auth_finalization_state = 'expired_manual',
        auth_finalization_attempt_id = NULL,
        auth_finalization_attempt_expires_at = NULL,
        recovery_billing_resumed = NULL,
        recovery_billing_may_have_changed = COALESCE(
          recovery_billing_may_have_changed,
          false
        ),
        updated_at = GREATEST(updated_at, v_now)
    WHERE operation_id = p_operation_id;
    RETURN 'invalid';
  END IF;
  IF v_admission.auth_finalization_state = 'completed' THEN
    IF v_admission.recovery_billing_v2_result IS NOT NULL
      AND public.account_recovery_billing_result_is_exact_v2(
        v_admission.recovery_billing_v2_result,
        v_admission.recovery_billing_target_digest,
        v_admission.recovery_billing_resumed
      )
    THEN
      RETURN v_admission.recovery_billing_v2_result ->> 'status';
    END IF;
    RETURN CASE
      WHEN v_admission.recovery_billing_resumed THEN 'completed_resumed'
      ELSE 'completed_manual'
    END;
  END IF;
  IF v_admission.auth_finalization_state = 'auth_compensation_required' THEN
    IF v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
      AND v_admission.auth_finalization_attempt_expires_at > v_now
    THEN
      RETURN 'busy';
    END IF;
    UPDATE public.account_recovery_admissions
    SET auth_finalization_attempt_id = p_attempt_id,
        auth_finalization_attempt_expires_at = v_now + interval '15 minutes',
        updated_at = GREATEST(updated_at, v_now)
    WHERE operation_id = p_operation_id
      AND auth_finalization_state = 'auth_compensation_required';
    RETURN CASE WHEN FOUND THEN
      CASE WHEN v_admission.recovery_billing_may_have_changed
        THEN 'compensation_billing'
        ELSE 'compensation_auth_only'
      END
      ELSE 'busy'
    END;
  END IF;
  IF v_admission.auth_finalization_state = 'billing_pending' THEN
    IF v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id THEN
      RETURN 'busy';
    END IF;
    UPDATE public.account_recovery_admissions
    SET auth_finalization_state = 'auth_compensation_required',
        auth_finalized_at = NULL,
        recovery_billing_resumed = NULL,
        recovery_billing_may_have_changed = true,
        auth_finalization_attempt_expires_at = v_now + interval '15 minutes',
        updated_at = GREATEST(updated_at, v_now)
    WHERE operation_id = p_operation_id
      AND auth_finalization_state = 'billing_pending'
      AND auth_finalization_attempt_id = p_attempt_id
      AND recovery_billing_v2_result IS NULL;
    RETURN CASE WHEN FOUND THEN 'compensation_billing' ELSE 'busy' END;
  END IF;
  IF v_admission.auth_finalization_state IS DISTINCT FROM 'claimed'
    OR v_admission.auth_finalization_attempt_id IS DISTINCT FROM p_attempt_id
  THEN
    RETURN 'busy';
  END IF;
  UPDATE public.account_recovery_admissions
  SET auth_finalization_state = 'auth_compensation_required',
      recovery_billing_may_have_changed = false,
      auth_finalization_attempt_expires_at = v_now + interval '15 minutes',
      updated_at = GREATEST(updated_at, v_now)
  WHERE operation_id = p_operation_id
    AND auth_finalization_state = 'claimed'
    AND auth_finalization_attempt_id = p_attempt_id;
  RETURN CASE WHEN FOUND THEN 'compensation_auth_only' ELSE 'busy' END;
END
$function$;

ALTER FUNCTION public.require_account_recovery_auth_compensation_atomic(
  uuid, uuid, text, uuid
) OWNER TO postgres;

-- Recovery finalization calls the historical admission finisher, which locks
-- the profile and fires the projection/group trigger. Acquire the global/user
-- group locks before the admission row and profile tuple to match every other
-- entitlement writer and eliminate the old admission -> profile -> global
-- inversion.
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
  IF p_user_id IS NULL
    OR p_operation_id IS NULL
    OR p_capability_hash IS NULL
    OR p_capability_hash !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'invalid recovery Auth finalization input'
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
  SELECT admission.* INTO v_admission
  FROM public.account_recovery_admissions AS admission
  WHERE admission.operation_id = p_operation_id
  FOR UPDATE;
  IF NOT FOUND OR v_admission.user_id IS DISTINCT FROM p_user_id THEN
    RETURN 'invalid';
  END IF;
  IF v_admission.auth_finalization_capability_hash
    IS DISTINCT FROM p_capability_hash
  THEN
    RETURN 'invalid';
  END IF;
  IF v_admission.auth_finalization_state NOT IN (
      'completed', 'superseded', 'expired_manual'
    )
    AND v_admission.auth_finalization_prepared_at + interval '30 days' <= v_now
  THEN
    UPDATE public.account_recovery_admissions
    SET auth_finalization_state = 'expired_manual',
        auth_finalization_attempt_id = NULL,
        auth_finalization_attempt_expires_at = NULL,
        recovery_billing_resumed = NULL,
        recovery_billing_may_have_changed = COALESCE(
          recovery_billing_may_have_changed,
          false
        ),
        updated_at = GREATEST(updated_at, v_now)
    WHERE operation_id = p_operation_id;
    RETURN 'invalid';
  END IF;
  IF v_admission.state = 'finished'
    AND v_admission.auth_finalization_state IN (
      'pending', 'claimed', 'auth_compensation_required',
      'billing_pending', 'completed'
    )
  THEN
    RETURN 'finished';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.account_deletion_auth_fences AS fence
    WHERE fence.user_id = p_user_id
      AND fence.state IN ('billing_pending', 'auth_ban_pending')
  ) THEN
    RETURN 'invalid';
  END IF;
  IF v_admission.state IS DISTINCT FROM 'claimed'
    OR v_admission.auth_finalization_state IS DISTINCT FROM 'prepared'
    OR v_admission.auth_finalization_prepared_at + interval '30 days' <= v_now
  THEN
    RETURN 'invalid';
  END IF;

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

ALTER FUNCTION public.finish_account_recovery_with_auth_finalization_atomic(
  uuid, uuid, text
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.prevent_b2c_financial_owner_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'B2C financial owner is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.prevent_b2c_financial_owner_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prevent_b2c_financial_owner_mutation() FROM PUBLIC;

CREATE TRIGGER trg_stripe_b2c_invoice_owner_immutable
  BEFORE UPDATE OF user_id ON public.stripe_b2c_invoice_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_b2c_financial_owner_mutation();
CREATE TRIGGER trg_stripe_b2c_activation_owner_immutable
  BEFORE UPDATE OF user_id ON public.stripe_b2c_recurring_activations
  FOR EACH ROW EXECUTE FUNCTION public.prevent_b2c_financial_owner_mutation();
CREATE TRIGGER trg_stripe_trial_owner_immutable
  BEFORE UPDATE OF user_id ON public.stripe_trial_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.prevent_b2c_financial_owner_mutation();
CREATE TRIGGER trg_payment_history_owner_immutable
  BEFORE UPDATE OF user_id ON public.payment_history
  FOR EACH ROW EXECUTE FUNCTION public.prevent_b2c_financial_owner_mutation();

CREATE OR REPLACE FUNCTION public.enforce_stripe_cancel_dispatch_protocol()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
BEGIN
  IF NEW.effect_type IN (
    'stripe_subscription_cancel',
    'recovery_payment_auto_refund'
  ) THEN
    IF NEW.payload IS NULL
      OR pg_catalog.jsonb_typeof(NEW.payload) IS DISTINCT FROM 'object'
    THEN
      RAISE EXCEPTION 'Stripe cancellation payload must be an object'
        USING ERRCODE = '23514';
    END IF;
    NEW.payload := NEW.payload || pg_catalog.jsonb_build_object(
      'protocol_version', 'dispatch_commit_v1'
    );
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_stripe_cancel_dispatch_protocol()
  OWNER TO postgres;

CREATE TRIGGER trg_stripe_cancel_dispatch_protocol
  BEFORE INSERT OR UPDATE OF effect_type, payload
  ON public.stripe_entitlement_effects
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_stripe_cancel_dispatch_protocol();

CREATE OR REPLACE FUNCTION public.prevent_stripe_cancel_dispatch_marker_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
BEGIN
  IF OLD.effect_type IN (
      'stripe_subscription_cancel',
      'recovery_payment_auto_refund'
    )
    AND NEW.effect_type IS DISTINCT FROM OLD.effect_type
  THEN
    RAISE EXCEPTION 'Stripe dispatch effect type is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.dispatch_committed_at IS NOT NULL
    AND NEW.dispatch_committed_at IS DISTINCT FROM OLD.dispatch_committed_at
  THEN
    RAISE EXCEPTION 'Stripe cancellation dispatch marker is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.dispatch_committed_at IS NOT NULL
    AND NEW.effect_type NOT IN (
      'stripe_subscription_cancel',
      'recovery_payment_auto_refund'
    )
  THEN
    RAISE EXCEPTION 'Stripe dispatch marker has the wrong effect type'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.effect_type IN (
      'stripe_subscription_cancel',
      'recovery_payment_auto_refund'
    )
    AND NEW.status = 'completed'
    AND NEW.dispatch_committed_at IS NULL
  THEN
    RAISE EXCEPTION 'Stripe effect cannot complete before dispatch commit'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.dispatch_committed_at IS NOT NULL
    AND NEW.status = 'dead_lettered'
  THEN
    -- Once the irreversible intent is committed, a transient Stripe outage
    -- cannot silently abandon cancellation and allow future renewal charges.
    NEW.status := 'failed';
    NEW.attempt_count := 9;
    NEW.lease_token := NULL;
    NEW.lease_expires_at := NULL;
    NEW.available_at := pg_catalog.clock_timestamp() + interval '1 hour';
    NEW.completed_at := NULL;
    NEW.last_error := COALESCE(NEW.last_error, 'cancel_dispatch_retry_required');
  END IF;
  IF OLD.dispatch_committed_at IS NOT NULL
    AND NEW.status = 'superseded'
  THEN
    -- A committed external intent is absorbing. Authority changes are
    -- reviewed separately and cannot revoke the dispatch lease protocol.
    NEW.status := OLD.status;
    NEW.attempt_count := OLD.attempt_count;
    NEW.lease_token := OLD.lease_token;
    NEW.lease_expires_at := OLD.lease_expires_at;
    NEW.available_at := OLD.available_at;
    NEW.completed_at := OLD.completed_at;
    NEW.last_error := OLD.last_error;
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.prevent_stripe_cancel_dispatch_marker_mutation()
  OWNER TO postgres;

CREATE TRIGGER trg_stripe_cancel_dispatch_marker_immutable
  BEFORE UPDATE OF dispatch_committed_at, effect_type, status
  ON public.stripe_entitlement_effects
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_cancel_dispatch_marker_mutation();

CREATE OR REPLACE FUNCTION public.review_lifetime_refund_after_cancel_dispatch()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_dispatches jsonb;
BEGIN
  IF NEW.payment_kind = 'lifetime'
    AND NOT (
      OLD.refund_state = 'succeeded'
      AND OLD.refund_succeeded_amount >= OLD.amount_paid
    )
    AND NEW.refund_state = 'succeeded'
    AND NEW.refund_succeeded_amount >= NEW.amount_paid
  THEN
    SELECT pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'effect_id', effect.id,
        'dispatch_committed_at', effect.dispatch_committed_at,
        'status', effect.status,
        'stripe_subscription_id', effect.payload ->> 'stripe_subscription_id'
      ) ORDER BY effect.id
    )
    INTO v_dispatches
    FROM public.stripe_entitlement_effects AS effect
    WHERE effect.entitlement_payment_id = NEW.id
      AND effect.effect_type = 'stripe_subscription_cancel'
      AND effect.dispatch_committed_at IS NOT NULL;

    IF v_dispatches IS NOT NULL THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'charge',
        NEW.stripe_charge_id,
        NULL,
        'lifetime_refund_after_cancel_dispatch_committed',
        'A lifetime refund committed after an irreversible recurring Subscription cancellation dispatch; the old Subscription must not be restored automatically.',
        pg_catalog.jsonb_build_object(
          'payment_id', NEW.id,
          'opaque_owner_user_id', NEW.user_id,
          'refund_event_id', NEW.latest_refund_event_id,
          'dispatches', v_dispatches
        )
      );
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.review_lifetime_refund_after_cancel_dispatch()
  OWNER TO postgres;

CREATE TRIGGER trg_lifetime_refund_after_cancel_dispatch_review
  AFTER UPDATE OF refund_state, refund_succeeded_amount
  ON public.stripe_entitlement_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.review_lifetime_refund_after_cancel_dispatch();

INSERT INTO public.stripe_manual_reviews (
  object_type,
  object_id,
  user_id,
  action,
  reason_key,
  reason,
  metadata
)
SELECT
  'charge',
  payment.stripe_charge_id,
  NULL,
  'investigate',
  'lifetime_refund_after_cancel_dispatch_committed',
  'A lifetime refund was already complete when an irreversible recurring Subscription cancellation dispatch was backfilled; the old Subscription must not be restored automatically.',
  pg_catalog.jsonb_build_object(
    'payment_id', payment.id,
    'opaque_owner_user_id', payment.user_id,
    'refund_event_id', payment.latest_refund_event_id,
    'effect_id', effect.id,
    'dispatch_committed_at', effect.dispatch_committed_at,
    'stripe_subscription_id', effect.payload ->> 'stripe_subscription_id',
    'backfilled_by_migration', true
  )
FROM public.stripe_entitlement_payments AS payment
JOIN public.stripe_entitlement_effects AS effect
  ON effect.entitlement_payment_id = payment.id
 AND effect.effect_type = 'stripe_subscription_cancel'
 AND effect.dispatch_committed_at IS NOT NULL
WHERE payment.payment_kind = 'lifetime'
  AND payment.refund_state = 'succeeded'
  AND payment.refund_succeeded_amount >= payment.amount_paid
ON CONFLICT (object_type, object_id, reason_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.has_b2c_recurring_financial_owner_atomic(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_livemode boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
  THEN
    RAISE EXCEPTION 'recurring financial owner identity is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-customer-owner:' || p_stripe_customer_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-membership-stripe-subscription:' || p_livemode::text || ':' || p_stripe_subscription_id,
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.stripe_customer_id = p_stripe_customer_id
      AND profile.id IS DISTINCT FROM p_user_id
  ) THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.pro_membership_checkout_reservations AS reservation
    WHERE reservation.user_id = p_user_id
      AND reservation.livemode = p_livemode
      AND reservation.stripe_customer_id = p_stripe_customer_id
      AND reservation.stripe_subscription_id = p_stripe_subscription_id
      AND reservation.status IN ('converted', 'retired')
  ) OR EXISTS (
    SELECT 1
    FROM public.stripe_b2c_recurring_activations AS activation
    WHERE activation.user_id = p_user_id
      AND activation.livemode = p_livemode
      AND activation.stripe_customer_id = p_stripe_customer_id
      AND activation.stripe_subscription_id = p_stripe_subscription_id
      AND activation.outcome NOT IN ('identity_conflict', 'manual_review', 'owner_conflict')
  ) OR EXISTS (
    SELECT 1
    FROM public.stripe_b2c_invoice_events AS invoice_event
    WHERE invoice_event.user_id = p_user_id
      AND invoice_event.livemode = p_livemode
      AND invoice_event.stripe_customer_id = p_stripe_customer_id
      AND invoice_event.stripe_subscription_id = p_stripe_subscription_id
      AND invoice_event.event_type IN ('invoice.paid', 'invoice.payment_succeeded')
      AND invoice_event.payment_status = 'succeeded'
      AND invoice_event.outcome NOT IN ('identity_conflict', 'manual_review', 'owner_conflict')
  ) OR EXISTS (
    -- Subscriptions first paid before the 073 reservation cutover have no
    -- reservation or 074 event row.  Their immutable Pro payment plus exact
    -- central ownership is nevertheless durable financial-owner authority.
    -- Keep this deliberately independent of mutable subscription/profile
    -- projections so account deletion cannot erase late-renewal refund
    -- routing.  Historical ledgers predate explicit livemode storage; the
    -- exact Stripe Customer + Subscription + owner tuple is the strongest
    -- available pre-cutover identity and may not be guessed from metadata.
    SELECT 1
    FROM public.stripe_entitlement_payments AS payment
    JOIN public.stripe_payment_ownerships AS ownership
      ON ownership.product_kind = 'pro_entitlement'
     AND ownership.ledger_id = payment.id
    WHERE payment.user_id = p_user_id
      AND payment.payment_kind = 'recurring'
      AND payment.stripe_customer_id = p_stripe_customer_id
      AND payment.stripe_subscription_id = p_stripe_subscription_id
      AND ownership.owner_user_id = p_user_id
      AND ownership.stripe_customer_id = p_stripe_customer_id
      AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
  );
END
$function$;

ALTER FUNCTION public.has_b2c_recurring_financial_owner_atomic(
  uuid, text, text, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.resolve_b2c_recurring_price_authority(
  p_stripe_subscription_id text,
  p_livemode boolean,
  p_stripe_price_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_count integer;
  v_user_id uuid;
  v_customer_id text;
  v_price_id text;
  v_plan text;
  v_expected_amount bigint;
  v_currency text;
  v_source_kind text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
  THEN
    RAISE EXCEPTION 'historical price authority identity is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-membership-stripe-subscription:' || p_livemode::text || ':' || p_stripe_subscription_id,
      0
    )
  );

  WITH candidates AS (
    SELECT
      reservation.user_id,
      reservation.stripe_customer_id,
      reservation.stripe_price_id,
      reservation.pro_plan,
      reservation.unit_amount AS expected_amount,
      reservation.currency
    FROM public.pro_membership_checkout_reservations AS reservation
    WHERE reservation.stripe_subscription_id = p_stripe_subscription_id
      AND reservation.livemode = p_livemode
      AND reservation.stripe_price_id = p_stripe_price_id
      AND reservation.status IN ('converted', 'retired')
    UNION
    SELECT
      invoice_event.user_id,
      invoice_event.stripe_customer_id,
      invoice_event.stripe_price_id,
      invoice_event.plan,
      invoice_event.amount,
      invoice_event.currency
    FROM public.stripe_b2c_invoice_events AS invoice_event
    WHERE invoice_event.stripe_subscription_id = p_stripe_subscription_id
      AND invoice_event.livemode = p_livemode
      AND invoice_event.stripe_price_id = p_stripe_price_id
      AND invoice_event.payment_status = 'succeeded'
      AND invoice_event.outcome IN (
        'activated', 'already_activated', 'stale_payment',
        'current_entitlement_protected', 'stripe_status_not_entitling',
        'subject_deleted', 'refunded_payment'
      )
    UNION
    SELECT
      activation.user_id,
      activation.stripe_customer_id,
      activation.stripe_price_id,
      activation.plan,
      activation.expected_amount,
      activation.currency
    FROM public.stripe_b2c_recurring_activations AS activation
    WHERE activation.stripe_subscription_id = p_stripe_subscription_id
      AND activation.livemode = p_livemode
      AND activation.stripe_price_id = p_stripe_price_id
      AND (
        activation.activation_committed_at IS NOT NULL
        OR activation.outcome IN (
          'current_entitlement_protected', 'stale_payment',
          'terminal_trial_recorded'
        )
      )
  ), distinct_candidates AS (
    SELECT DISTINCT
      user_id, stripe_customer_id, stripe_price_id, pro_plan,
      expected_amount, currency
    FROM candidates
    WHERE user_id IS NOT NULL
  )
  SELECT
    pg_catalog.count(*),
    pg_catalog.min(user_id::text)::uuid,
    pg_catalog.min(stripe_customer_id),
    pg_catalog.min(stripe_price_id),
    pg_catalog.min(pro_plan),
    pg_catalog.min(expected_amount),
    pg_catalog.min(currency)
  INTO
    v_count, v_user_id, v_customer_id, v_price_id, v_plan,
    v_expected_amount, v_currency
  FROM distinct_candidates;

  IF v_count = 0 THEN
    -- Pre-073 recurring payments did not persist Price ids. The exact current
    -- subscription/payment/central-owner chain still proves which historical
    -- plan, amount, and currency the signed Subscription belongs to. The
    -- caller must then validate the signed Invoice/Subscription Price object
    -- against this returned shape; this function never guesses from env.
    WITH legacy_current_authorities AS (
      SELECT DISTINCT
        payment.user_id,
        payment.stripe_customer_id,
        payment.plan,
        payment.amount_paid,
        payment.currency
      FROM public.subscriptions AS subscription
      JOIN public.stripe_entitlement_payments AS payment
        ON payment.id = subscription.entitlement_payment_id
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.product_kind = 'pro_entitlement'
       AND ownership.ledger_id = payment.id
      JOIN public.user_profiles AS profile
        ON profile.id = payment.user_id
       AND profile.stripe_customer_id = payment.stripe_customer_id
      WHERE subscription.user_id = payment.user_id
        AND subscription.stripe_customer_id = payment.stripe_customer_id
        AND subscription.stripe_subscription_id = p_stripe_subscription_id
        AND subscription.plan = payment.plan
        AND subscription.current_period_start = payment.period_start
        AND subscription.current_period_end = payment.period_end
        AND payment.payment_kind = 'recurring'
        AND payment.stripe_subscription_id = p_stripe_subscription_id
        AND payment.plan IN ('monthly', 'yearly')
        AND payment.amount_paid > 0
        AND payment.currency ~ '^[a-z]{3}$'
        AND ownership.owner_user_id = payment.user_id
        AND ownership.stripe_customer_id = payment.stripe_customer_id
        AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
        AND public.stripe_subscription_has_exact_payment_binding_v2(
          payment.user_id
        )
    )
    SELECT
      pg_catalog.count(*),
      pg_catalog.min(user_id::text)::uuid,
      pg_catalog.min(stripe_customer_id),
      pg_catalog.min(plan),
      pg_catalog.min(amount_paid),
      pg_catalog.min(currency)
    INTO
      v_count, v_user_id, v_customer_id, v_plan,
      v_expected_amount, v_currency
    FROM legacy_current_authorities;

    IF v_count > 1 THEN
      PERFORM public.record_b2c_recurring_manual_review_atomic(
        'subscription', p_stripe_subscription_id, NULL,
        'b2c_legacy_current_authority_conflict',
        'A pre-cutover recurring subscription has conflicting exact current payment authorities.',
        pg_catalog.jsonb_build_object(
          'livemode', p_livemode,
          'signed_price_id', p_stripe_price_id,
          'candidate_count', v_count
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
    END IF;
    IF v_count = 1 THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'resolved',
        'user_id', v_user_id,
        'stripe_customer_id', v_customer_id,
        'stripe_price_id', p_stripe_price_id,
        'plan', v_plan,
        'pro_plan', v_plan,
        'expected_amount', v_expected_amount,
        'currency', v_currency,
        'source_kind', 'legacy_exact_current_payment_owner'
      );
    END IF;

    -- A pre-cutover current trial likewise proves owner/subscription/plan but
    -- did not store price amount or currency. Return only that exact shape
    -- owner; the caller derives amount/currency from the signed expanded Price
    -- and immediately runs the normal strict product validator.
    WITH legacy_trial_authorities AS (
      SELECT DISTINCT
        trial.user_id,
        trial.stripe_customer_id,
        trial.plan
      FROM public.subscriptions AS subscription
      JOIN public.stripe_trial_entitlements AS trial
        ON trial.id = subscription.entitlement_trial_id
      JOIN public.user_profiles AS profile
        ON profile.id = trial.user_id
       AND profile.stripe_customer_id = trial.stripe_customer_id
      WHERE subscription.user_id = trial.user_id
        AND subscription.stripe_customer_id = trial.stripe_customer_id
        AND subscription.stripe_subscription_id = p_stripe_subscription_id
        AND subscription.plan = trial.plan
        AND subscription.current_period_start = trial.period_start
        AND subscription.current_period_end = trial.period_end
        AND trial.stripe_subscription_id = p_stripe_subscription_id
        AND trial.plan IN ('monthly', 'yearly')
        AND trial.period_end = trial.period_start + interval '7 days'
    )
    SELECT
      pg_catalog.count(*),
      pg_catalog.min(user_id::text)::uuid,
      pg_catalog.min(stripe_customer_id),
      pg_catalog.min(plan)
    INTO v_count, v_user_id, v_customer_id, v_plan
    FROM legacy_trial_authorities;

    IF v_count > 1 THEN
      PERFORM public.record_b2c_recurring_manual_review_atomic(
        'subscription', p_stripe_subscription_id, NULL,
        'b2c_legacy_trial_authority_conflict',
        'A pre-cutover recurring trial has conflicting exact current authorities.',
        pg_catalog.jsonb_build_object(
          'livemode', p_livemode,
          'signed_price_id', p_stripe_price_id,
          'candidate_count', v_count
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
    END IF;
    IF v_count = 1 THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'resolved_legacy_trial_owner',
        'user_id', v_user_id,
        'stripe_customer_id', v_customer_id,
        'stripe_price_id', p_stripe_price_id,
        'plan', v_plan,
        'source_kind', 'legacy_exact_current_trial_owner'
      );
    END IF;

    -- Pre-073 payments do not store Price ids.  They may still prove the
    -- immutable opaque owner of a deleted subscription through the central
    -- cross-product ownership ledger.  Return owner authority only: the
    -- caller must validate the signed Invoice line + fresh Price/Charge chain
    -- and invoke a financial-only no-grant path.  Do not compare or guess the
    -- newly signed Price/amount from old plan terms.
    WITH legacy_owners AS (
      SELECT DISTINCT
        payment.user_id,
        payment.stripe_customer_id
      FROM public.stripe_entitlement_payments AS payment
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.product_kind = 'pro_entitlement'
       AND ownership.ledger_id = payment.id
      WHERE payment.payment_kind = 'recurring'
        AND payment.stripe_subscription_id = p_stripe_subscription_id
        AND payment.user_id IS NOT NULL
        AND ownership.owner_user_id = payment.user_id
        AND ownership.stripe_customer_id = payment.stripe_customer_id
        AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
        AND NOT EXISTS (
          SELECT 1
          FROM public.user_profiles AS profile
          WHERE profile.id = payment.user_id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.user_profiles AS profile
          WHERE profile.stripe_customer_id = payment.stripe_customer_id
        )
    )
    SELECT
      pg_catalog.count(*),
      pg_catalog.min(user_id::text)::uuid,
      pg_catalog.min(stripe_customer_id)
    INTO v_count, v_user_id, v_customer_id
    FROM legacy_owners;

    IF v_count = 0 THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_found');
    END IF;
    IF v_count <> 1 THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
        'subscription', p_stripe_subscription_id, NULL,
        'b2c_legacy_financial_owner_conflict',
        'A pre-cutover recurring subscription has conflicting exact central owners.',
        pg_catalog.jsonb_build_object(
          'livemode', p_livemode,
          'signed_price_id', p_stripe_price_id,
          'candidate_count', v_count
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'resolved_deleted_financial_owner',
      'user_id', v_user_id,
      'stripe_customer_id', v_customer_id,
      'source_kind', 'legacy_exact_central_payment_owner'
    );
  END IF;
  IF v_count <> 1 THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription', p_stripe_subscription_id, NULL,
      'b2c_historical_price_authority_conflict',
      'A recurring subscription has conflicting durable historical price authorities.',
      pg_catalog.jsonb_build_object('livemode', p_livemode, 'candidate_count', v_count)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM public.pro_membership_checkout_reservations AS reservation
      WHERE reservation.stripe_subscription_id = p_stripe_subscription_id
        AND reservation.livemode = p_livemode
        AND reservation.status IN ('converted', 'retired')
        AND reservation.user_id = v_user_id
        AND reservation.stripe_customer_id = v_customer_id
        AND reservation.stripe_price_id = v_price_id
        AND reservation.pro_plan = v_plan
        AND reservation.unit_amount = v_expected_amount
        AND reservation.currency = v_currency
    ) THEN 'converted_checkout_reservation'
    WHEN EXISTS (
      SELECT 1
      FROM public.stripe_b2c_invoice_events AS invoice_event
      WHERE invoice_event.stripe_subscription_id = p_stripe_subscription_id
        AND invoice_event.livemode = p_livemode
        AND invoice_event.user_id = v_user_id
        AND invoice_event.stripe_customer_id = v_customer_id
        AND invoice_event.stripe_price_id = v_price_id
        AND invoice_event.plan = v_plan
        AND invoice_event.amount = v_expected_amount
        AND invoice_event.currency = v_currency
        AND invoice_event.payment_status = 'succeeded'
        AND invoice_event.outcome IN (
          'activated', 'already_activated', 'stale_payment',
          'current_entitlement_protected'
        )
    ) THEN 'verified_invoice_event'
    ELSE 'verified_activation_event'
  END
  INTO v_source_kind;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'resolved',
    'user_id', v_user_id,
    'stripe_customer_id', v_customer_id,
    'stripe_price_id', v_price_id,
    'plan', v_plan,
    'pro_plan', v_plan,
    'expected_amount', v_expected_amount,
    'currency', v_currency,
    'source_kind', v_source_kind
  );
END
$function$;

ALTER FUNCTION public.resolve_b2c_recurring_price_authority(text, boolean, text)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.claim_pro_membership_checkout_recovery_candidates(
  p_livemode boolean,
  p_limit integer DEFAULT 10
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
  v_candidates jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL OR p_limit IS NULL OR p_limit < 1 OR p_limit > 25 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid Pro checkout recovery claim request';
  END IF;

  WITH locked AS MATERIALIZED (
    SELECT reservation.id
    FROM public.pro_membership_checkout_reservations AS reservation
    WHERE reservation.livemode = p_livemode
      AND reservation.updated_at <=
        pg_catalog.clock_timestamp() - interval '4 minutes'
      AND (
        (
          reservation.status IN ('reserved', 'bound')
          AND reservation.checkout_expires_at <=
            pg_catalog.floor(
              extract(epoch FROM pg_catalog.clock_timestamp())
            )::bigint
        )
        OR (
          reservation.status = 'reserved'
          AND reservation.checkout_session_id IS NULL
          AND reservation.created_at <=
            pg_catalog.clock_timestamp() - interval '90 seconds'
          AND reservation.checkout_expires_at >=
            pg_catalog.floor(
              extract(epoch FROM pg_catalog.clock_timestamp())
            )::bigint + 300
        )
        OR (
          reservation.status = 'converted'
          AND reservation.terminal_event_id LIKE 'evt_%'
          AND NOT EXISTS (
            SELECT 1
            FROM public.stripe_b2c_recurring_activations AS activation
            WHERE activation.livemode = reservation.livemode
              AND activation.source_event_id = reservation.terminal_event_id
              AND activation.user_id = reservation.user_id
              AND activation.stripe_customer_id = reservation.stripe_customer_id
              AND activation.stripe_subscription_id =
                reservation.stripe_subscription_id
              AND activation.stripe_price_id = reservation.stripe_price_id
              AND activation.plan = reservation.pro_plan
              AND activation.expected_amount = reservation.unit_amount
              AND activation.currency = reservation.currency
              AND activation.authority_kind = CASE
                WHEN reservation.trial_days = 7 THEN 'trial'
                ELSE 'paid'
              END
          )
        )
      )
    ORDER BY
      reservation.updated_at,
      CASE
        WHEN reservation.status IN ('reserved', 'bound')
          AND reservation.checkout_expires_at <=
            pg_catalog.floor(
              extract(epoch FROM pg_catalog.clock_timestamp())
            )::bigint
        THEN 0
        WHEN reservation.status = 'reserved' THEN 1
        ELSE 2
      END,
      reservation.created_at,
      reservation.id
    FOR UPDATE OF reservation SKIP LOCKED
    LIMIT p_limit
  ), claimed AS (
    UPDATE public.pro_membership_checkout_reservations AS reservation
    SET updated_at = pg_catalog.clock_timestamp()
    FROM locked
    WHERE reservation.id = locked.id
    RETURNING reservation.*
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'reservation_id', candidate.id,
        'status', candidate.status,
        'user_id', candidate.user_id,
        'livemode', candidate.livemode,
        'stripe_customer_id', candidate.stripe_customer_id,
        'pro_plan', candidate.pro_plan,
        'stripe_price_id', candidate.stripe_price_id,
        'unit_amount', candidate.unit_amount,
        'currency', candidate.currency,
        'trial_days', candidate.trial_days,
        'success_url', candidate.success_url,
        'cancel_url', candidate.cancel_url,
        'checkout_expires_at', candidate.checkout_expires_at,
        'checkout_session_id', candidate.checkout_session_id,
        'stripe_subscription_id', candidate.stripe_subscription_id,
        'completion_payment_status', candidate.completion_payment_status,
        'subscription_status', candidate.subscription_status,
        'trial_start', candidate.trial_start,
        'trial_end', candidate.trial_end,
        'terminal_event_id', candidate.terminal_event_id,
        'terminal_event_created', candidate.terminal_event_created,
        'created_at', candidate.created_at,
        'claimed_at', candidate.updated_at
      ) ORDER BY candidate.updated_at, candidate.created_at, candidate.id
    ),
    '[]'::jsonb
  ) INTO v_candidates
  FROM claimed AS candidate;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'candidates', v_candidates
  );
END
$function$;

ALTER FUNCTION public.claim_pro_membership_checkout_recovery_candidates(
  boolean, integer
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.stripe_entitlement_effect_is_current_v2(
  p_effect_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_effect_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_effects AS effect
      WHERE effect.id = p_effect_id
        AND (
          (
            effect.effect_type IN (
              'payment_auto_refund',
              'pro_purchase_alert'
            )
            AND effect.source_kind = 'payment'
            AND EXISTS (
              SELECT 1
              FROM public.stripe_entitlement_payments AS payment
              WHERE payment.id = effect.entitlement_payment_id
                AND NOT (
                  payment.refund_state = 'succeeded'
                  AND payment.refund_succeeded_amount >= payment.amount_paid
                )
            )
          )
          OR (
            effect.effect_type = 'stripe_subscription_cancel'
            AND effect.source_kind IN ('payment', 'trial')
            AND effect.payload ->> 'reason' IN (
              'lifetime_membership_activated',
              'account_recovery_billing_blocked'
            )
            AND effect.payload = pg_catalog.jsonb_build_object(
              'stripe_subscription_id', effect.payload ->> 'stripe_subscription_id',
              'stripe_customer_id', effect.payload ->> 'stripe_customer_id',
              'reason', effect.payload ->> 'reason',
              'protocol_version', 'dispatch_commit_v1'
            )
            AND pg_catalog.left(
              COALESCE(effect.payload ->> 'stripe_subscription_id', ''), 4
            ) = 'sub_'
            AND pg_catalog.left(
              COALESCE(effect.payload ->> 'stripe_customer_id', ''), 4
            ) = 'cus_'
            AND effect.operation_key = 'cancel:subscription:'
              || (effect.payload ->> 'stripe_subscription_id')
            AND (
              (
                effect.source_kind = 'payment'
                AND EXISTS (
                  SELECT 1
                  FROM public.stripe_entitlement_payments AS payment
                  WHERE payment.id = effect.entitlement_payment_id
                AND payment.stripe_customer_id =
                  effect.payload ->> 'stripe_customer_id'
                AND effect.user_id IS NOT DISTINCT FROM payment.user_id
                AND (
                  (
                    effect.payload ->> 'reason' =
                      'account_recovery_billing_blocked'
                    AND payment.payment_kind = 'recurring'
                    AND payment.plan IN ('monthly', 'yearly')
                    AND payment.payment_status IN ('paid', 'succeeded')
                    AND payment.stripe_subscription_id =
                      effect.payload ->> 'stripe_subscription_id'
                    AND payment.user_id IS NOT NULL
                    AND EXISTS (
                      SELECT 1
                      FROM public.stripe_b2c_recurring_activations AS activation
                      WHERE activation.user_id = payment.user_id
                        AND activation.stripe_customer_id =
                          payment.stripe_customer_id
                        AND activation.stripe_subscription_id =
                          payment.stripe_subscription_id
                        AND activation.plan = payment.plan
                        AND activation.expected_amount = payment.amount_paid
                        AND activation.currency = payment.currency
                        AND activation.period_start = payment.period_start
                        AND activation.period_end = payment.period_end
                        AND activation.outcome = 'billing_blocked_payment'
                    )
                  )
                  OR (
                    effect.payload ->> 'reason' =
                      'lifetime_membership_activated'
                    AND payment.payment_kind = 'lifetime'
                    AND payment.plan = 'lifetime'
                    AND payment.payment_status = 'succeeded'
                    AND (
                      effect.dispatch_committed_at IS NOT NULL
                      OR (
                        NOT (
                          payment.refund_state = 'succeeded'
                          AND payment.refund_succeeded_amount >=
                            payment.amount_paid
                        )
                        AND (
                          (
                            payment.user_id IS NOT NULL
                            AND EXISTS (
                              SELECT 1
                              FROM public.subscriptions AS subscription
                              WHERE subscription.entitlement_payment_id =
                                  payment.id
                                AND subscription.user_id = payment.user_id
                                AND subscription.plan = 'lifetime'
                                AND subscription.status = 'active'
                                AND subscription.tier = 'pro'
                                AND subscription.stripe_customer_id =
                                  payment.stripe_customer_id
                                AND subscription.stripe_subscription_id =
                                  payment.checkout_session_id
                                AND subscription.current_period_start =
                                  payment.period_start
                                AND subscription.current_period_end IS NULL
                                AND public.stripe_subscription_has_exact_payment_binding_v2(
                                  payment.user_id
                                )
                            )
                          )
                          OR (
                            payment.user_id IS NULL
                            AND NOT EXISTS (
                              SELECT 1
                              FROM public.subscriptions AS subscription
                              WHERE subscription.entitlement_payment_id =
                                payment.id
                            )
                          )
                        )
                      )
                    )
                  )
                    )
                )
              )
              OR (
                effect.source_kind = 'trial'
                AND effect.entitlement_payment_id IS NULL
                AND effect.payload ->> 'reason' =
                  'account_recovery_billing_blocked'
                AND EXISTS (
                  SELECT 1
                  FROM public.stripe_trial_entitlements AS trial
                  WHERE effect.source_key = 'trial:' || trial.id::text
                    AND effect.user_id = trial.user_id
                    AND trial.stripe_customer_id =
                      effect.payload ->> 'stripe_customer_id'
                    AND trial.stripe_subscription_id =
                      effect.payload ->> 'stripe_subscription_id'
                    AND trial.revoked_at IS NOT NULL
                    AND trial.revoke_reason =
                      'account_recovery_billing_blocked'
                    AND EXISTS (
                      SELECT 1
                      FROM public.stripe_b2c_recurring_activations AS activation
                      WHERE activation.authority_kind = 'trial'
                        AND activation.user_id = trial.user_id
                        AND activation.stripe_customer_id =
                          trial.stripe_customer_id
                        AND activation.stripe_subscription_id =
                          trial.stripe_subscription_id
                        AND activation.plan = trial.plan
                        AND activation.period_start = trial.period_start
                        AND activation.period_end = trial.period_end
                        AND activation.outcome = 'billing_blocked_trial'
                    )
                )
              )
            )
          )
          OR (
            effect.effect_type IN (
              'pro_official_group_join',
              'pro_official_group_restore'
            )
            AND public.stripe_has_current_pro_authority_v2(effect.user_id)
            AND (
              effect.source_kind <> 'payment'
              OR EXISTS (
                SELECT 1
                FROM public.stripe_entitlement_payments AS payment
                WHERE payment.id = effect.entitlement_payment_id
                  AND NOT (
                    payment.refund_state = 'succeeded'
                    AND payment.refund_succeeded_amount >= payment.amount_paid
                  )
              )
            )
          )
          OR effect.effect_type NOT IN (
            'payment_auto_refund',
            'stripe_subscription_cancel',
            'pro_official_group_join',
            'pro_official_group_restore',
            'pro_purchase_alert'
          )
        )
    )
$function$;

ALTER FUNCTION public.stripe_entitlement_effect_is_current_v2(uuid)
  OWNER TO postgres;

-- Keep the proven Pro/trial/projection predicates isolated. The public
-- currentness gate routes recovery-period product refunds explicitly and
-- never lets an unknown recovery source fall through the historical
-- "other effect" default-true branch.
ALTER FUNCTION public.stripe_entitlement_effect_is_current_v2(uuid)
  RENAME TO stripe_entitlement_effect_is_current_core_v2;

REVOKE ALL ON FUNCTION
  public.stripe_entitlement_effect_is_current_core_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.stripe_entitlement_effect_is_current_v2(
  p_effect_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_effect public.stripe_entitlement_effects%ROWTYPE;
  v_ledger_id uuid;
  v_is_current boolean := false;
BEGIN
  IF p_effect_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT effect.*
  INTO v_effect
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.id = p_effect_id;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_effect.effect_type = 'stripe_lifetime_authority_restore' THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.stripe_lifetime_superseded_authorities AS authority
      JOIN public.stripe_entitlement_payments AS payment
        ON payment.id = authority.lifetime_payment_id
      WHERE authority.restore_effect_id = v_effect.id
        AND authority.state = 'restore_pending'
        AND authority.cancel_dispatch_committed_at IS NULL
        AND payment.refund_state = 'succeeded'
        AND payment.refund_succeeded_amount >= payment.amount_paid
        AND payment.latest_refund_event_id = authority.refund_event_id
        AND public.stripe_lifetime_superseded_authority_is_exact_v2(authority)
    );
  END IF;

  IF v_effect.effect_type IS DISTINCT FROM 'recovery_payment_auto_refund'
  THEN
    RETURN public.stripe_entitlement_effect_is_current_core_v2(
      p_effect_id
    );
  END IF;

  IF v_effect.source_kind = 'payment' THEN
    RETURN v_effect.entitlement_payment_id IS NOT NULL
      AND v_effect.source_key = v_effect.entitlement_payment_id::text
      AND v_effect.operation_key =
        'refund:account_recovery_billing_blocked'
      AND v_effect.payload = pg_catalog.jsonb_build_object(
        'reason_key', 'account_recovery_billing_blocked',
        'protocol_version', 'dispatch_commit_v1'
      )
      AND EXISTS (
        SELECT 1
        FROM public.stripe_entitlement_payments AS payment
        JOIN public.stripe_lifetime_seat_reservations AS reservation
          ON reservation.converted_payment_id = payment.id
        JOIN public.stripe_payment_ownerships AS ownership
          ON ownership.product_kind = 'pro_entitlement'
         AND ownership.ledger_id = payment.id
        WHERE payment.id = v_effect.entitlement_payment_id
          AND payment.payment_kind = 'lifetime'
          AND payment.plan = 'lifetime'
          AND payment.payment_status = 'succeeded'
          AND NOT (
            payment.refund_state = 'succeeded'
            AND payment.refund_succeeded_amount >= payment.amount_paid
          )
          AND reservation.status = 'converted'
          AND reservation.livemode IS NOT NULL
          AND reservation.user_id = payment.user_id
          AND reservation.checkout_session_id = payment.checkout_session_id
          AND v_effect.user_id = payment.user_id
          AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
          AND NOT EXISTS (
            SELECT 1
            FROM public.pro_entitlement_grants AS entitlement_grant
            WHERE entitlement_grant.source = 'stripe_lifetime_payment'
              AND entitlement_grant.source_key =
                'payment:' || payment.id::text
              AND entitlement_grant.revoked_at IS NULL
          )
      );
  END IF;

  IF v_effect.entitlement_payment_id IS NOT NULL
    OR v_effect.source_kind NOT IN (
      'tip_payment', 'group_payment', 'api_payment'
    )
    OR v_effect.source_key !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR v_effect.operation_key IS DISTINCT FROM
      'refund:account_recovery_billing_blocked'
    OR v_effect.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'reason_key', 'account_recovery_billing_blocked',
      'protocol_version', 'dispatch_commit_v1'
    )
  THEN
    RETURN false;
  END IF;
  v_ledger_id := v_effect.source_key::uuid;

  IF v_effect.source_kind = 'tip_payment' THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.tips AS tip
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.product_kind = 'tip'
       AND ownership.ledger_id = tip.id
      WHERE tip.id = v_ledger_id
        AND tip.status = 'refund_pending'
        AND tip.livemode IS NOT NULL
        AND v_effect.user_id = tip.from_user_id
        AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
        AND NOT EXISTS (
          SELECT 1
          FROM public.notifications AS notification
          WHERE notification.type = 'tip_received'
            AND notification.reference_id = tip.id
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.tip_completion_notification_deliveries AS delivery
          WHERE delivery.tip_id = tip.id
        )
    );
  END IF;

  IF v_effect.source_kind = 'group_payment' THEN
    RETURN EXISTS (
      SELECT 1
      FROM public.group_payment_consumptions AS consumption
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.product_kind = 'group_pass'
       AND ownership.ledger_id = consumption.id
      WHERE consumption.id = v_ledger_id
        AND consumption.outcome =
          'billing_blocked_refund_pending'
        AND consumption.result = pg_catalog.jsonb_build_object(
          'status', 'refund_pending',
          'subscription_id', consumption.subscription_id,
          'idempotent_replay', false
        )
        AND consumption.livemode IS NOT NULL
        AND v_effect.user_id = consumption.user_id
        AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
        AND NOT EXISTS (
          SELECT 1
          FROM public.group_subscriptions AS subscription
          WHERE subscription.id = consumption.subscription_id
        )
    );
  END IF;

  -- 076 owns the API product ledger. Dynamic dispatch keeps 074 additive and
  -- fail-closed until that migration installs the exact product hook.
  IF pg_catalog.to_regprocedure(
      'public.api_tier_recovery_effect_is_current_v2(uuid)'
    ) IS NULL
  THEN
    RETURN false;
  END IF;
  EXECUTE
    'SELECT public.api_tier_recovery_effect_is_current_v2($1)'
    INTO v_is_current
    USING p_effect_id;
  RETURN COALESCE(v_is_current, false);
END
$function$;

ALTER FUNCTION public.stripe_entitlement_effect_is_current_v2(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_entitlement_effect_is_current_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.claim_stripe_subscription_cancel_dispatch_atomic(
  p_effect_id uuid,
  p_lease_token uuid,
  p_livemode boolean
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
  v_payment_id uuid;
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_trial public.stripe_trial_entitlements%ROWTYPE;
  v_trial_id uuid;
  v_effect public.stripe_entitlement_effects%ROWTYPE;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_effect_id IS NULL
    OR p_lease_token IS NULL
    OR p_livemode IS NULL
  THEN
    RAISE EXCEPTION 'Stripe cancellation dispatch claim identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT effect.*
  INTO v_effect
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.id = p_effect_id
    AND effect.effect_type = 'stripe_subscription_cancel';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  v_payment_id := v_effect.entitlement_payment_id;

  IF v_effect.source_kind = 'payment' THEN
    SELECT payment.* INTO v_payment
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.id = v_payment_id;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_found');
    END IF;
  ELSIF v_effect.source_kind = 'trial'
    AND v_effect.entitlement_payment_id IS NULL
    AND v_effect.source_key ~
      '^trial:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  THEN
    v_trial_id := pg_catalog.substr(v_effect.source_key, 7)::uuid;
    SELECT trial.* INTO v_trial
    FROM public.stripe_trial_entitlements AS trial
    WHERE trial.id = v_trial_id;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_found');
    END IF;
  ELSE
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF COALESCE(v_payment.user_id, v_trial.user_id) IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'account-recovery-admission:' ||
          COALESCE(v_payment.user_id, v_trial.user_id)::text,
        0
      )
    );
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-lifetime-seat-capacity', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  IF v_effect.source_kind = 'payment' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-charge-refund:' || v_payment.stripe_charge_id,
        0
      )
    );
    SELECT payment.* INTO v_payment
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.id = v_payment_id
    FOR UPDATE;
  ELSE
    SELECT trial.* INTO v_trial
    FROM public.stripe_trial_entitlements AS trial
    WHERE trial.id = v_trial_id
    FOR UPDATE;
  END IF;
  SELECT effect.* INTO v_effect
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.id = p_effect_id
  FOR UPDATE;

  IF v_effect.source_kind = 'trial' THEN
    IF v_effect.effect_type IS DISTINCT FROM 'stripe_subscription_cancel'
      OR v_effect.entitlement_payment_id IS NOT NULL
      OR v_effect.source_key IS DISTINCT FROM 'trial:' || v_trial.id::text
      OR v_effect.user_id IS DISTINCT FROM v_trial.user_id
      OR v_effect.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
        'stripe_subscription_id', v_trial.stripe_subscription_id,
        'stripe_customer_id', v_trial.stripe_customer_id,
        'reason', 'account_recovery_billing_blocked',
        'protocol_version', 'dispatch_commit_v1'
      )
      OR v_effect.operation_key IS DISTINCT FROM
        'cancel:subscription:' || v_trial.stripe_subscription_id
      OR v_trial.revoked_at IS NULL
      OR v_trial.revoke_reason IS DISTINCT FROM
        'account_recovery_billing_blocked'
      OR (
        SELECT pg_catalog.count(*)
        FROM public.stripe_b2c_recurring_activations AS activation
        WHERE activation.authority_kind = 'trial'
          AND activation.user_id = v_trial.user_id
          AND activation.stripe_customer_id = v_trial.stripe_customer_id
          AND activation.stripe_subscription_id =
            v_trial.stripe_subscription_id
          AND activation.plan = v_trial.plan
          AND activation.period_start = v_trial.period_start
          AND activation.period_end = v_trial.period_end
          AND activation.outcome = 'billing_blocked_trial'
      ) IS DISTINCT FROM 1::bigint
      OR EXISTS (
        SELECT 1
        FROM public.stripe_b2c_recurring_activations AS activation
        WHERE activation.authority_kind = 'trial'
          AND activation.user_id = v_trial.user_id
          AND activation.stripe_customer_id = v_trial.stripe_customer_id
          AND activation.stripe_subscription_id =
            v_trial.stripe_subscription_id
          AND activation.plan = v_trial.plan
          AND activation.period_start = v_trial.period_start
          AND activation.period_end = v_trial.period_end
          AND activation.outcome = 'billing_blocked_trial'
          AND activation.livemode IS DISTINCT FROM p_livemode
      )
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
  ELSIF NOT FOUND
    OR v_effect.effect_type IS DISTINCT FROM 'stripe_subscription_cancel'
    OR v_effect.entitlement_payment_id IS DISTINCT FROM v_payment_id
    OR v_effect.source_kind IS DISTINCT FROM 'payment'
    OR v_effect.payload ->> 'reason' NOT IN (
      'lifetime_membership_activated',
      'account_recovery_billing_blocked'
    )
    OR v_effect.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'stripe_subscription_id', v_effect.payload ->> 'stripe_subscription_id',
      'stripe_customer_id', v_effect.payload ->> 'stripe_customer_id',
      'reason', v_effect.payload ->> 'reason',
      'protocol_version', 'dispatch_commit_v1'
    )
    OR v_effect.operation_key IS DISTINCT FROM
      'cancel:subscription:' || (v_effect.payload ->> 'stripe_subscription_id')
    OR pg_catalog.left(
      COALESCE(v_effect.payload ->> 'stripe_subscription_id', ''), 4
    ) <> 'sub_'
    OR pg_catalog.left(
      COALESCE(v_effect.payload ->> 'stripe_customer_id', ''), 4
    ) <> 'cus_'
    OR v_payment.id IS NULL
    OR v_payment.stripe_customer_id IS DISTINCT FROM
      v_effect.payload ->> 'stripe_customer_id'
    OR v_effect.user_id IS DISTINCT FROM v_payment.user_id
    OR NOT (
      (
        v_effect.payload ->> 'reason' = 'lifetime_membership_activated'
        AND v_payment.payment_kind = 'lifetime'
        AND v_payment.plan = 'lifetime'
        AND v_payment.payment_status = 'succeeded'
        AND EXISTS (
          SELECT 1
          FROM public.stripe_lifetime_superseded_authorities AS authority
          WHERE authority.lifetime_payment_id = v_payment.id
            AND authority.cancellation_effect_id = v_effect.id
            AND authority.lifetime_livemode = p_livemode
            AND public.stripe_lifetime_superseded_authority_is_exact_v2(
              authority
            )
        )
      )
      OR (
        v_effect.payload ->> 'reason' = 'account_recovery_billing_blocked'
        AND v_payment.payment_kind = 'recurring'
        AND v_payment.plan IN ('monthly', 'yearly')
        AND v_payment.payment_status IN ('paid', 'succeeded')
        AND v_payment.stripe_subscription_id =
          v_effect.payload ->> 'stripe_subscription_id'
        AND v_payment.user_id IS NOT NULL
        AND (
          SELECT pg_catalog.count(*)
          FROM public.stripe_b2c_recurring_activations AS activation
          WHERE activation.user_id = v_payment.user_id
            AND activation.stripe_customer_id =
              v_payment.stripe_customer_id
            AND activation.stripe_subscription_id =
              v_payment.stripe_subscription_id
            AND activation.plan = v_payment.plan
            AND activation.expected_amount = v_payment.amount_paid
            AND activation.currency = v_payment.currency
            AND activation.period_start = v_payment.period_start
            AND activation.period_end = v_payment.period_end
            AND activation.outcome = 'billing_blocked_payment'
        ) = 1::bigint
        AND NOT EXISTS (
          SELECT 1
          FROM public.stripe_b2c_recurring_activations AS activation
          WHERE activation.user_id = v_payment.user_id
            AND activation.stripe_customer_id =
              v_payment.stripe_customer_id
            AND activation.stripe_subscription_id =
              v_payment.stripe_subscription_id
            AND activation.plan = v_payment.plan
            AND activation.expected_amount = v_payment.amount_paid
            AND activation.currency = v_payment.currency
            AND activation.period_start = v_payment.period_start
            AND activation.period_end = v_payment.period_end
            AND activation.outcome = 'billing_blocked_payment'
            AND activation.livemode IS DISTINCT FROM p_livemode
        )
      )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  IF v_effect.status IS DISTINCT FROM 'processing'
    OR v_effect.lease_token IS DISTINCT FROM p_lease_token
    OR v_effect.lease_expires_at IS NULL
    OR v_effect.lease_expires_at <= v_now
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'lease_lost');
  END IF;
  IF v_effect.dispatch_committed_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_dispatch_committed');
  END IF;
  IF NOT public.stripe_entitlement_effect_is_current_v2(v_effect.id) THEN
    UPDATE public.stripe_entitlement_effects
    SET status = 'superseded',
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error = 'authority_superseded_before_cancel_dispatch',
        completed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_effect.id;
    RETURN pg_catalog.jsonb_build_object('status', 'authority_superseded');
  END IF;

  UPDATE public.stripe_entitlement_effects
  SET dispatch_committed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_effect.id
    AND dispatch_committed_at IS NULL
  RETURNING * INTO v_effect;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'lease_lost');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'dispatch_committed');
END
$function$;

ALTER FUNCTION public.claim_stripe_subscription_cancel_dispatch_atomic(
  uuid, uuid, boolean
)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION
  public.claim_lifetime_recovery_refund_dispatch_atomic(
    p_effect_id uuid,
    p_lease_token uuid,
    p_livemode boolean
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
  v_effect public.stripe_entitlement_effects%ROWTYPE;
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_reservation public.stripe_lifetime_seat_reservations%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  SELECT effect.* INTO v_effect
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.id = p_effect_id;
  IF NOT FOUND OR p_lease_token IS NULL OR p_livemode IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT payment.* INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.id = v_effect.entitlement_payment_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_payment.user_id::text, 0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-lifetime-seat-capacity', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-charge-refund:' || v_payment.stripe_charge_id, 0)
  );
  SELECT payment.* INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.id = v_effect.entitlement_payment_id FOR UPDATE;
  SELECT reservation.* INTO v_reservation
  FROM public.stripe_lifetime_seat_reservations AS reservation
  WHERE reservation.converted_payment_id = v_payment.id FOR UPDATE;
  SELECT effect.* INTO v_effect
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.id = p_effect_id FOR UPDATE;
  IF NOT FOUND
    OR v_effect.effect_type IS DISTINCT FROM 'recovery_payment_auto_refund'
    OR v_effect.source_kind IS DISTINCT FROM 'payment'
    OR v_effect.entitlement_payment_id IS DISTINCT FROM v_payment.id
    OR v_effect.source_key IS DISTINCT FROM v_payment.id::text
    OR v_effect.user_id IS DISTINCT FROM v_payment.user_id
    OR v_effect.operation_key IS DISTINCT FROM
      'refund:account_recovery_billing_blocked'
    OR v_effect.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'reason_key', 'account_recovery_billing_blocked',
      'protocol_version', 'dispatch_commit_v1'
    )
    OR v_payment.payment_kind IS DISTINCT FROM 'lifetime'
    OR v_payment.plan IS DISTINCT FROM 'lifetime'
    OR v_payment.payment_status IS DISTINCT FROM 'succeeded'
    OR v_payment.refund_succeeded_amount > v_payment.amount_paid
    OR v_reservation.status IS DISTINCT FROM 'converted'
    OR v_reservation.converted_payment_id IS DISTINCT FROM v_payment.id
    OR v_reservation.user_id IS DISTINCT FROM v_payment.user_id
    OR v_reservation.checkout_session_id IS DISTINCT FROM
      v_payment.checkout_session_id
    OR v_reservation.livemode IS DISTINCT FROM p_livemode
    OR NOT EXISTS (
      SELECT 1 FROM public.stripe_payment_ownerships AS ownership
      WHERE ownership.product_kind = 'pro_entitlement'
        AND ownership.ledger_id = v_payment.id
        AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  IF v_effect.status IS DISTINCT FROM 'processing'
    OR v_effect.lease_token IS DISTINCT FROM p_lease_token
    OR v_effect.lease_expires_at <= pg_catalog.statement_timestamp()
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'lease_lost');
  END IF;
  IF v_effect.dispatch_committed_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_dispatch_committed',
      'product_kind', 'lifetime',
      'user_id', v_payment.user_id,
      'livemode', v_reservation.livemode,
      'stripe_customer_id', v_payment.stripe_customer_id,
      'stripe_payment_intent_id', v_payment.stripe_payment_intent_id,
      'stripe_charge_id', v_payment.stripe_charge_id,
      'amount', v_payment.amount_paid,
      'currency', v_payment.currency
    );
  END IF;
  IF NOT public.stripe_entitlement_effect_is_current_v2(v_effect.id) THEN
    UPDATE public.stripe_entitlement_effects
    SET status = 'superseded', lease_token = NULL, lease_expires_at = NULL,
        last_error = 'authority_superseded_before_refund_dispatch',
        completed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_effect.id;
    RETURN pg_catalog.jsonb_build_object('status', 'authority_superseded');
  END IF;
  UPDATE public.stripe_entitlement_effects
  SET dispatch_committed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_effect.id AND dispatch_committed_at IS NULL;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'lease_lost');
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'dispatch_committed',
    'product_kind', 'lifetime',
    'user_id', v_payment.user_id,
    'livemode', v_reservation.livemode,
    'stripe_customer_id', v_payment.stripe_customer_id,
    'stripe_payment_intent_id', v_payment.stripe_payment_intent_id,
    'stripe_charge_id', v_payment.stripe_charge_id,
    'amount', v_payment.amount_paid,
    'currency', v_payment.currency
  );
END
$function$;

ALTER FUNCTION public.claim_lifetime_recovery_refund_dispatch_atomic(
  uuid, uuid, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION
  public.claim_recovery_payment_refund_dispatch_atomic(
    p_effect_id uuid,
    p_lease_token uuid,
    p_livemode boolean
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
  v_effect public.stripe_entitlement_effects%ROWTYPE;
  v_tip public.tips%ROWTYPE;
  v_consumption public.group_payment_consumptions%ROWTYPE;
  v_ledger_id uuid;
  v_claim jsonb;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_effect_id IS NULL
    OR p_lease_token IS NULL
    OR p_livemode IS NULL
  THEN
    RAISE EXCEPTION 'recovery payment refund claim identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT effect.*
  INTO v_effect
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.id = p_effect_id
    AND effect.effect_type = 'recovery_payment_auto_refund';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_effect.source_kind = 'payment' THEN
    RETURN public.claim_lifetime_recovery_refund_dispatch_atomic(
      p_effect_id, p_lease_token, p_livemode
    );
  END IF;
  IF v_effect.entitlement_payment_id IS NOT NULL
    OR v_effect.source_kind NOT IN (
      'tip_payment', 'group_payment', 'api_payment'
    )
    OR v_effect.source_key !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR v_effect.operation_key IS DISTINCT FROM
      'refund:account_recovery_billing_blocked'
    OR v_effect.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'reason_key', 'account_recovery_billing_blocked',
      'protocol_version', 'dispatch_commit_v1'
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF v_effect.source_kind = 'api_payment' THEN
    IF pg_catalog.to_regprocedure(
        'public.claim_api_tier_recovery_payment_refund_dispatch_atomic(uuid,uuid,boolean)'
      ) IS NULL
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'hook_unavailable');
    END IF;
    EXECUTE
      'SELECT public.claim_api_tier_recovery_payment_refund_dispatch_atomic($1, $2, $3)'
      INTO v_claim
      USING p_effect_id, p_lease_token, p_livemode;
    IF v_claim IS NULL
      OR pg_catalog.jsonb_typeof(v_claim) IS DISTINCT FROM 'object'
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    RETURN v_claim;
  END IF;

  v_ledger_id := v_effect.source_key::uuid;
  IF v_effect.source_kind = 'tip_payment' THEN
    SELECT tip.* INTO v_tip
    FROM public.tips AS tip
    WHERE tip.id = v_ledger_id;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_found');
    END IF;
  ELSE
    SELECT consumption.* INTO v_consumption
    FROM public.group_payment_consumptions AS consumption
    WHERE consumption.id = v_ledger_id;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'not_found');
    END IF;
  END IF;

  IF COALESCE(v_tip.from_user_id, v_consumption.user_id) IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'account-recovery-admission:' ||
          COALESCE(v_tip.from_user_id, v_consumption.user_id)::text,
        0
      )
    );
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-lifetime-seat-capacity', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' ||
        COALESCE(v_tip.stripe_charge_id, v_consumption.stripe_charge_id),
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-payment-identity:' ||
        COALESCE(
          v_tip.stripe_payment_intent_id,
          v_consumption.payment_intent_id
        ),
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-checkout-session:' ||
        COALESCE(
          v_tip.stripe_checkout_session_id,
          v_consumption.checkout_session_id
        ),
      0
    )
  );

  IF v_effect.source_kind = 'tip_payment' THEN
    PERFORM public.lock_tip_notification_authority_atomic(v_tip.id);
    SELECT tip.* INTO v_tip
    FROM public.tips AS tip
    WHERE tip.id = v_ledger_id
    FOR UPDATE;
  ELSE
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-membership:' || v_consumption.group_id::text || ':' ||
          v_consumption.user_id::text,
        0
      )
    );
    SELECT consumption.* INTO v_consumption
    FROM public.group_payment_consumptions AS consumption
    WHERE consumption.id = v_ledger_id
    FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT effect.* INTO v_effect
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.id = p_effect_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_effect.effect_type IS DISTINCT FROM
      'recovery_payment_auto_refund'
    OR v_effect.entitlement_payment_id IS NOT NULL
    OR v_effect.source_key IS DISTINCT FROM v_ledger_id::text
    OR v_effect.operation_key IS DISTINCT FROM
      'refund:account_recovery_billing_blocked'
    OR v_effect.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'reason_key', 'account_recovery_billing_blocked',
      'protocol_version', 'dispatch_commit_v1'
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF v_effect.source_kind = 'tip_payment' THEN
    IF v_effect.user_id IS DISTINCT FROM v_tip.from_user_id
      OR v_tip.status IS DISTINCT FROM 'refund_pending'
      OR v_tip.livemode IS DISTINCT FROM p_livemode
      OR pg_catalog.left(COALESCE(v_tip.stripe_customer_id, ''), 4)
        <> 'cus_'
      OR pg_catalog.left(COALESCE(v_tip.stripe_payment_intent_id, ''), 3)
        <> 'pi_'
      OR pg_catalog.left(COALESCE(v_tip.stripe_charge_id, ''), 3)
        <> 'ch_'
      OR pg_catalog.left(COALESCE(v_tip.stripe_checkout_session_id, ''), 3)
        <> 'cs_'
      OR v_tip.amount_cents <= 0
      OR v_tip.currency !~ '^[a-z]{3}$'
      OR NOT EXISTS (
        SELECT 1
        FROM public.stripe_payment_ownerships AS ownership
        WHERE ownership.product_kind = 'tip'
          AND ownership.ledger_id = v_tip.id
          AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
      )
      OR EXISTS (
        SELECT 1
        FROM public.notifications AS notification
        WHERE notification.type = 'tip_received'
          AND notification.reference_id = v_tip.id
      )
      OR EXISTS (
        SELECT 1
        FROM public.tip_completion_notification_deliveries AS delivery
        WHERE delivery.tip_id = v_tip.id
      )
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
  ELSE
    IF v_effect.source_kind IS DISTINCT FROM 'group_payment'
      OR v_effect.user_id IS DISTINCT FROM v_consumption.user_id
      OR v_consumption.provider IS DISTINCT FROM 'stripe'
      OR v_consumption.outcome IS DISTINCT FROM
        'billing_blocked_refund_pending'
      OR v_consumption.result IS DISTINCT FROM
        pg_catalog.jsonb_build_object(
          'status', 'refund_pending',
          'subscription_id', v_consumption.subscription_id,
          'idempotent_replay', false
        )
      OR v_consumption.livemode IS DISTINCT FROM p_livemode
      OR pg_catalog.left(
        COALESCE(v_consumption.stripe_customer_id, ''), 4
      ) <> 'cus_'
      OR pg_catalog.left(
        COALESCE(v_consumption.payment_intent_id, ''), 3
      ) <> 'pi_'
      OR pg_catalog.left(
        COALESCE(v_consumption.stripe_charge_id, ''), 3
      ) <> 'ch_'
      OR pg_catalog.left(
        COALESCE(v_consumption.checkout_session_id, ''), 3
      ) <> 'cs_'
      OR v_consumption.amount_cents <= 0
      OR v_consumption.currency !~ '^[a-z]{3}$'
      OR EXISTS (
        SELECT 1
        FROM public.group_subscriptions AS subscription
        WHERE subscription.id = v_consumption.subscription_id
      )
      OR NOT EXISTS (
        SELECT 1
        FROM public.stripe_payment_ownerships AS ownership
        WHERE ownership.product_kind = 'group_pass'
          AND ownership.ledger_id = v_consumption.id
          AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
      )
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
  END IF;

  IF v_effect.status IS DISTINCT FROM 'processing'
    OR v_effect.lease_token IS DISTINCT FROM p_lease_token
    OR v_effect.lease_expires_at IS NULL
    OR v_effect.lease_expires_at <= v_now
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'lease_lost');
  END IF;
  IF v_effect.dispatch_committed_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_dispatch_committed',
      'product_kind', CASE v_effect.source_kind
        WHEN 'tip_payment' THEN 'tip'
        ELSE 'group_pass'
      END,
      'user_id', COALESCE(v_tip.from_user_id, v_consumption.user_id),
      'livemode', COALESCE(v_tip.livemode, v_consumption.livemode),
      'stripe_customer_id', COALESCE(
        v_tip.stripe_customer_id, v_consumption.stripe_customer_id
      ),
      'stripe_payment_intent_id', COALESCE(
        v_tip.stripe_payment_intent_id, v_consumption.payment_intent_id
      ),
      'stripe_charge_id', COALESCE(
        v_tip.stripe_charge_id, v_consumption.stripe_charge_id
      ),
      'amount', COALESCE(
        v_tip.amount_cents::bigint, v_consumption.amount_cents
      ),
      'currency', COALESCE(v_tip.currency, v_consumption.currency)
    );
  END IF;
  IF NOT public.stripe_entitlement_effect_is_current_v2(v_effect.id) THEN
    UPDATE public.stripe_entitlement_effects
    SET status = 'superseded',
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error = 'authority_superseded_before_refund_dispatch',
        completed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_effect.id;
    RETURN pg_catalog.jsonb_build_object('status', 'authority_superseded');
  END IF;

  UPDATE public.stripe_entitlement_effects
  SET dispatch_committed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_effect.id
    AND dispatch_committed_at IS NULL;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'lease_lost');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'dispatch_committed',
    'product_kind', CASE v_effect.source_kind
      WHEN 'tip_payment' THEN 'tip'
      ELSE 'group_pass'
    END,
    'user_id', COALESCE(v_tip.from_user_id, v_consumption.user_id),
    'livemode', COALESCE(v_tip.livemode, v_consumption.livemode),
    'stripe_customer_id', COALESCE(
      v_tip.stripe_customer_id, v_consumption.stripe_customer_id
    ),
    'stripe_payment_intent_id', COALESCE(
      v_tip.stripe_payment_intent_id, v_consumption.payment_intent_id
    ),
    'stripe_charge_id', COALESCE(
      v_tip.stripe_charge_id, v_consumption.stripe_charge_id
    ),
    'amount', COALESCE(
      v_tip.amount_cents::bigint, v_consumption.amount_cents
    ),
    'currency', COALESCE(v_tip.currency, v_consumption.currency)
  );
END
$function$;

ALTER FUNCTION public.claim_recovery_payment_refund_dispatch_atomic(
  uuid, uuid, boolean
) OWNER TO postgres;

-- A cancellation dispatch becomes an absorbing obligation at the exact
-- transaction that writes dispatch_committed_at.  From that point forward the
-- same durable effect id must be retried until Stripe confirms the terminal
-- state; the ordinary ten-attempt dead-letter ceiling is no longer safe.
CREATE OR REPLACE FUNCTION public.lease_stripe_entitlement_effects_atomic(
  p_limit integer,
  p_lease_seconds integer
)
RETURNS SETOF public.stripe_entitlement_effects
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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL
    OR p_limit NOT BETWEEN 1 AND 100
    OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 15 AND 300
  THEN
    RAISE EXCEPTION 'effect lease request is invalid'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT
      effect.id,
      effect.effect_type IN (
        'stripe_subscription_cancel',
        'recovery_payment_auto_refund'
      )
        AND effect.dispatch_committed_at IS NOT NULL
        AS cancel_dispatch_committed,
      (
        effect.effect_type NOT IN (
          'payment_auto_refund',
          'payment_manual_review',
          'stripe_subscription_cancel',
          'recovery_payment_auto_refund'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.user_profiles AS profile
          WHERE profile.id = effect.user_id
            AND profile.deleted_at IS NULL
            AND profile.banned_at IS NULL
            AND NOT (
              COALESCE(profile.is_banned, false)
              AND (
                profile.ban_expires_at IS NULL
                OR profile.ban_expires_at
                  > pg_catalog.statement_timestamp()
              )
            )
        )
      ) AS subject_inactive,
      NOT public.stripe_entitlement_effect_is_current_v2(effect.id)
        AS authority_superseded
    FROM public.stripe_entitlement_effects AS effect
    WHERE (
        (
          (
            effect.attempt_count < 10
            OR (
              effect.effect_type IN (
                'stripe_subscription_cancel',
                'recovery_payment_auto_refund'
              )
              AND effect.dispatch_committed_at IS NOT NULL
            )
          )
          AND effect.status IN ('pending', 'failed')
          AND effect.available_at <= pg_catalog.statement_timestamp()
        )
        OR (
          effect.status = 'processing'
          AND effect.lease_expires_at <= pg_catalog.statement_timestamp()
        )
      )
    ORDER BY
      CASE
        WHEN effect.status = 'processing' THEN effect.lease_expires_at
        ELSE effect.available_at
      END,
      effect.created_at,
      effect.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ),
  transitioned AS (
    UPDATE public.stripe_entitlement_effects AS effect
    SET status = CASE
          WHEN NOT candidates.cancel_dispatch_committed
            AND (
              candidates.subject_inactive
              OR candidates.authority_superseded
            )
          THEN 'superseded'
          WHEN NOT candidates.cancel_dispatch_committed
            AND effect.status = 'processing'
            AND effect.attempt_count >= 10
          THEN 'dead_lettered'
          ELSE 'processing'
        END,
        attempt_count = CASE
          WHEN candidates.cancel_dispatch_committed
          THEN LEAST(effect.attempt_count + 1, 10)
          WHEN candidates.subject_inactive
            OR candidates.authority_superseded
            OR (
              effect.status = 'processing'
              AND effect.attempt_count >= 10
            )
          THEN effect.attempt_count
          ELSE effect.attempt_count + 1
        END,
        lease_token = CASE
          WHEN NOT candidates.cancel_dispatch_committed
            AND (
              candidates.subject_inactive
              OR candidates.authority_superseded
              OR (
                effect.status = 'processing'
                AND effect.attempt_count >= 10
              )
            )
          THEN NULL
          ELSE pg_catalog.gen_random_uuid()
        END,
        lease_expires_at = CASE
          WHEN NOT candidates.cancel_dispatch_committed
            AND (
              candidates.subject_inactive
              OR candidates.authority_superseded
              OR (
                effect.status = 'processing'
                AND effect.attempt_count >= 10
              )
            )
          THEN NULL
          ELSE pg_catalog.statement_timestamp()
            + pg_catalog.make_interval(secs => p_lease_seconds)
        END,
        last_error = CASE
          WHEN NOT candidates.cancel_dispatch_committed
            AND candidates.subject_inactive
          THEN CASE
            WHEN effect.user_id IS NULL THEN 'subject_deleted'
            ELSE 'subject_inactive'
          END
          WHEN NOT candidates.cancel_dispatch_committed
            AND candidates.authority_superseded
          THEN 'authority_superseded'
          WHEN NOT candidates.cancel_dispatch_committed
            AND effect.status = 'processing'
            AND effect.attempt_count >= 10
          THEN 'lease_exhausted'
          ELSE NULL
        END,
        completed_at = CASE
          WHEN NOT candidates.cancel_dispatch_committed
            AND (
              candidates.subject_inactive
              OR candidates.authority_superseded
              OR (
                effect.status = 'processing'
                AND effect.attempt_count >= 10
              )
            )
          THEN pg_catalog.clock_timestamp()
          ELSE NULL
        END,
        updated_at = pg_catalog.clock_timestamp()
    FROM candidates
    WHERE effect.id = candidates.id
    RETURNING effect.*
  )
  SELECT transitioned.*
  FROM transitioned
  WHERE transitioned.status = 'processing'
  ORDER BY transitioned.created_at, transitioned.id;
END
$function$;

ALTER FUNCTION public.lease_stripe_entitlement_effects_atomic(
  integer, integer
) OWNER TO postgres;

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
  v_effect public.stripe_entitlement_effects%ROWTYPE;
  v_cancel_dispatch_committed boolean;
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
        OR p_error IS NOT NULL
        OR p_retry_after_seconds IS NOT NULL
      )
    )
    OR (
      NOT p_succeeded
      AND (
        p_error IS NULL
        OR pg_catalog.length(pg_catalog.btrim(p_error)) NOT BETWEEN 1 AND 2000
        OR p_external_ref IS NOT NULL
        OR p_retry_after_seconds IS NULL
        OR p_retry_after_seconds NOT BETWEEN 0 AND 3600
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
  v_cancel_dispatch_committed :=
    v_effect.effect_type IN (
      'stripe_subscription_cancel',
      'recovery_payment_auto_refund'
    )
    AND v_effect.dispatch_committed_at IS NOT NULL;
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

  IF v_effect.effect_type IN (
      'stripe_subscription_cancel',
      'recovery_payment_auto_refund'
    )
    AND NOT v_cancel_dispatch_committed
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'dispatch_not_committed');
  END IF;

  IF NOT v_cancel_dispatch_committed
    AND v_effect.effect_type NOT IN (
      'payment_auto_refund',
      'payment_manual_review',
      'stripe_subscription_cancel',
      'recovery_payment_auto_refund'
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

  IF NOT v_cancel_dispatch_committed
    AND NOT public.stripe_entitlement_effect_is_current_v2(v_effect.id)
  THEN
    UPDATE public.stripe_entitlement_effects
    SET status = 'superseded',
        lease_token = NULL,
        lease_expires_at = NULL,
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

  IF v_cancel_dispatch_committed THEN
    UPDATE public.stripe_entitlement_effects
    SET status = 'failed',
        attempt_count = LEAST(attempt_count, 10),
        lease_token = NULL,
        lease_expires_at = NULL,
        available_at = v_now
          + pg_catalog.make_interval(secs => p_retry_after_seconds),
        last_error = p_error,
        completed_at = NULL,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_effect.id;
    RETURN pg_catalog.jsonb_build_object('status', 'retry_scheduled');
  END IF;

  IF v_effect.attempt_count >= 10 THEN
    UPDATE public.stripe_entitlement_effects
    SET status = 'dead_lettered',
        lease_token = NULL,
        lease_expires_at = NULL,
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

CREATE OR REPLACE FUNCTION public.reconcile_b2c_subscription_state_core_atomic(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_current_invoice_id text,
  p_plan text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_stripe_status text,
  p_cancel_at_period_end boolean,
  p_canceled_at timestamptz,
  p_grace_expires_at timestamptz,
  p_event_id text,
  p_event_created_at timestamptz,
  p_livemode boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_inserted_event_id text;
  v_existing_event public.stripe_subscription_state_events%ROWTYPE;
  v_latest_event public.stripe_subscription_state_events%ROWTYPE;
  v_profile public.user_profiles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_trial public.stripe_trial_entitlements%ROWTYPE;
  v_grace public.pro_entitlement_grants%ROWTYPE;
  v_exact_payment boolean := false;
  v_base_exact_payment boolean := false;
  v_exact_trial boolean := false;
  v_subject_active boolean := false;
  v_subject_deleted boolean := false;
  v_subject_banned boolean := false;
  v_has_latest_event boolean := false;
  v_incoming_state_rank integer;
  v_latest_state_rank integer;
  v_payment_authority_event_created_at timestamptz;
  v_trial_authority_event_created_at timestamptz;
  v_first_failed_at timestamptz;
  v_grace_cap timestamptz;
  v_effective_grace_expires_at timestamptz;
  v_has_authority boolean;
  v_leave_ack jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR (
      p_current_invoice_id IS NOT NULL
      AND (
        p_current_invoice_id IS DISTINCT FROM pg_catalog.btrim(p_current_invoice_id)
        OR p_current_invoice_id !~ '^in_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_current_invoice_id) > 255
      )
    )
    OR p_plan IS NULL
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_period_start IS NULL
    OR p_period_end IS NULL
    OR p_period_end <= p_period_start
    OR p_stripe_status IS NULL
    OR p_stripe_status NOT IN (
      'active',
      'trialing',
      'past_due',
      'canceled',
      'unpaid',
      'incomplete',
      'incomplete_expired',
      'paused'
    )
    OR p_cancel_at_period_end IS NULL
    OR p_event_id IS NULL
    OR p_event_id IS DISTINCT FROM pg_catalog.btrim(p_event_id)
    OR p_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_event_id) > 255
    OR p_event_created_at IS NULL
    OR (
      p_stripe_status = 'past_due'
      AND (
        p_current_invoice_id IS NULL
        OR p_current_invoice_id IS DISTINCT FROM pg_catalog.btrim(p_current_invoice_id)
        OR p_current_invoice_id !~ '^in_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_current_invoice_id) > 255
        OR
        p_grace_expires_at IS NULL
        OR p_grace_expires_at <= p_event_created_at
      )
    )
    OR (
      p_stripe_status <> 'past_due'
      AND p_grace_expires_at IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'recurring subscription state identity is invalid'
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

  SELECT profile.* INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'inactive_subject');
  END IF;
  v_subject_active := v_profile.deleted_at IS NULL
    AND v_profile.banned_at IS NULL
    AND NOT (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > pg_catalog.statement_timestamp()
      )
    )
    AND NOT public.account_recovery_billing_surface_is_blocked_v2(p_user_id);
  v_subject_deleted := v_profile.deleted_at IS NOT NULL;
  v_subject_banned := NOT v_subject_deleted
    AND (
      v_profile.banned_at IS NOT NULL
      OR (
        COALESCE(v_profile.is_banned, false)
        AND (
          v_profile.ban_expires_at IS NULL
          OR v_profile.ban_expires_at > pg_catalog.statement_timestamp()
        )
      )
    );

  INSERT INTO public.stripe_subscription_state_events (
    event_id,
    user_id,
    stripe_customer_id,
    stripe_subscription_id,
    current_invoice_id,
    plan,
    period_start,
    period_end,
    stripe_status,
    cancel_at_period_end,
    canceled_at,
    requested_grace_expires_at,
    event_created_at,
    livemode
  ) VALUES (
    p_event_id,
    p_user_id,
    p_stripe_customer_id,
    p_stripe_subscription_id,
    p_current_invoice_id,
    p_plan,
    p_period_start,
    p_period_end,
    p_stripe_status,
    p_cancel_at_period_end,
    p_canceled_at,
    p_grace_expires_at,
    p_event_created_at,
    p_livemode
  )
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_id INTO v_inserted_event_id;

  IF v_inserted_event_id IS NULL THEN
    SELECT state_event.*
    INTO v_existing_event
    FROM public.stripe_subscription_state_events AS state_event
    WHERE state_event.event_id = p_event_id;

    IF NOT FOUND
      OR v_existing_event.user_id IS DISTINCT FROM p_user_id
      OR v_existing_event.livemode IS DISTINCT FROM p_livemode
      OR v_existing_event.stripe_customer_id
        IS DISTINCT FROM p_stripe_customer_id
      OR v_existing_event.stripe_subscription_id
        IS DISTINCT FROM p_stripe_subscription_id
      OR v_existing_event.current_invoice_id
        IS DISTINCT FROM p_current_invoice_id
      OR v_existing_event.plan IS DISTINCT FROM p_plan
      OR v_existing_event.period_start IS DISTINCT FROM p_period_start
      OR v_existing_event.period_end IS DISTINCT FROM p_period_end
      OR v_existing_event.stripe_status IS DISTINCT FROM p_stripe_status
      OR v_existing_event.cancel_at_period_end
        IS DISTINCT FROM p_cancel_at_period_end
      OR v_existing_event.canceled_at IS DISTINCT FROM p_canceled_at
      OR v_existing_event.requested_grace_expires_at
        IS DISTINCT FROM p_grace_expires_at
      OR v_existing_event.event_created_at
        IS DISTINCT FROM p_event_created_at
    THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
        'subscription_event',
        p_event_id,
        p_user_id,
        'subscription_state_event_identity_conflict',
        'A Stripe subscription event id was replayed with changed identity.',
        pg_catalog.jsonb_build_object(
          'stripe_subscription_id', p_stripe_subscription_id
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'already_reconciled',
      'outcome',
      v_existing_event.outcome
    );
  END IF;

  SELECT state_event.*
  INTO v_latest_event
  FROM public.stripe_subscription_state_events AS state_event
  WHERE state_event.stripe_subscription_id = p_stripe_subscription_id
    AND state_event.livemode = p_livemode
    AND state_event.event_id IS DISTINCT FROM p_event_id
    AND state_event.outcome NOT IN (
      'manual_review', 'stale', 'protected', 'not_current',
      'pending_authority'
    )
  ORDER BY
    state_event.event_created_at DESC,
    CASE
      WHEN state_event.stripe_status IN ('active', 'trialing') THEN 0
      WHEN state_event.stripe_status = 'past_due' THEN 1
      ELSE 2
    END DESC,
    state_event.event_id DESC
  LIMIT 1;
  v_has_latest_event := FOUND;

  -- Stripe only gives second-resolution event creation time.  Events sharing
  -- that timestamp therefore use a safety partial order: entitling < failed
  -- payment < terminal/non-entitling. Equal-rank but different states remain
  -- ambiguous; a strictly more restrictive state is safe in either delivery
  -- order and must absorb the less restrictive observation.
  v_incoming_state_rank := CASE
    WHEN p_stripe_status IN ('active', 'trialing') THEN 0
    WHEN p_stripe_status = 'past_due' THEN 1
    ELSE 2
  END;
  IF v_has_latest_event THEN
    v_latest_state_rank := CASE
      WHEN v_latest_event.stripe_status IN ('active', 'trialing') THEN 0
      WHEN v_latest_event.stripe_status = 'past_due' THEN 1
      ELSE 2
    END;
  END IF;

  IF v_has_latest_event
    AND p_event_created_at < v_latest_event.event_created_at
  THEN
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'stale'
    WHERE event_id = p_event_id;
    RETURN pg_catalog.jsonb_build_object('status', 'stale_event');
  END IF;

  IF v_has_latest_event
    AND p_event_created_at = v_latest_event.event_created_at
    AND v_latest_event.user_id IS NOT DISTINCT FROM p_user_id
    AND v_latest_event.stripe_customer_id IS NOT DISTINCT FROM p_stripe_customer_id
    AND v_latest_event.current_invoice_id IS NOT DISTINCT FROM p_current_invoice_id
    AND v_latest_event.plan IS NOT DISTINCT FROM p_plan
    AND v_latest_event.period_start IS NOT DISTINCT FROM p_period_start
    AND v_latest_event.period_end IS NOT DISTINCT FROM p_period_end
    AND v_latest_event.stripe_status IS NOT DISTINCT FROM p_stripe_status
    AND v_latest_event.cancel_at_period_end IS NOT DISTINCT FROM p_cancel_at_period_end
    AND v_latest_event.canceled_at IS NOT DISTINCT FROM p_canceled_at
    AND v_latest_event.requested_grace_expires_at IS NOT DISTINCT FROM p_grace_expires_at
  THEN
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'equivalent'
    WHERE event_id = p_event_id;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_reconciled',
      'outcome', 'equivalent'
    );
  END IF;

  IF v_has_latest_event
    AND p_event_created_at = v_latest_event.event_created_at
    AND v_incoming_state_rank < v_latest_state_rank
  THEN
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'stale'
    WHERE event_id = p_event_id;
    RETURN pg_catalog.jsonb_build_object('status', 'stale_event');
  END IF;

  IF v_has_latest_event
    AND p_event_created_at = v_latest_event.event_created_at
    AND v_incoming_state_rank = v_latest_state_rank
  THEN
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'manual_review'
    WHERE event_id = p_event_id;
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription_event',
      p_event_id,
      p_user_id,
      'ambiguous_subscription_state_event_order',
      'Different subscription state events share one Stripe creation timestamp.',
      pg_catalog.jsonb_build_object(
        'current_event_id', v_latest_event.event_id,
        'incoming_status', p_stripe_status,
        'current_status', v_latest_event.stripe_status
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  IF v_has_latest_event
    AND v_latest_event.stripe_status IN (
      'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    )
    AND p_stripe_status IN ('active', 'trialing', 'past_due')
  THEN
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'manual_review'
    WHERE event_id = p_event_id;
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription_event',
      p_event_id,
      p_user_id,
      'subscription_terminal_state_barrier',
      'A state-only event attempted to reactivate a terminal Stripe subscription.',
      pg_catalog.jsonb_build_object(
        'terminal_event_id', v_latest_event.event_id,
        'terminal_status', v_latest_event.stripe_status,
        'incoming_status', p_stripe_status,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  SELECT subscription.*
  INTO v_subscription
  FROM public.subscriptions AS subscription
  WHERE subscription.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'not_current'
    WHERE event_id = p_event_id;
    RETURN pg_catalog.jsonb_build_object('status', 'not_current');
  END IF;

  IF v_subscription.stripe_customer_id
      IS DISTINCT FROM p_stripe_customer_id
    OR v_subscription.stripe_subscription_id
      IS DISTINCT FROM p_stripe_subscription_id
    OR v_subscription.plan IS DISTINCT FROM p_plan
  THEN
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'protected'
    WHERE event_id = p_event_id;
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription_event',
      p_event_id,
      p_user_id,
      'subscription_state_not_current',
      'A Stripe state event targeted a non-current subscription projection.',
      pg_catalog.jsonb_build_object(
        'current_subscription_id', v_subscription.stripe_subscription_id,
        'incoming_subscription_id', p_stripe_subscription_id
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'current_entitlement_protected'
    );
  END IF;

  IF v_subscription.entitlement_payment_id IS NOT NULL THEN
    SELECT payment.*
    INTO v_payment
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.id = v_subscription.entitlement_payment_id
    FOR UPDATE;
    v_exact_payment :=
      FOUND
      AND v_payment.user_id = p_user_id
      AND v_payment.payment_kind = 'recurring'
      AND v_payment.plan = p_plan
      AND v_payment.stripe_customer_id = p_stripe_customer_id
      AND v_payment.stripe_subscription_id = p_stripe_subscription_id
      AND v_payment.period_start = v_subscription.current_period_start
      AND v_payment.period_end = v_subscription.current_period_end
      AND NOT (
        v_payment.refund_state = 'succeeded'
        AND v_payment.refund_succeeded_amount >= v_payment.amount_paid
      );
    v_base_exact_payment := v_exact_payment;
    IF v_exact_payment THEN
      -- Compare Stripe time only with Stripe time. The payment row's
      -- created_at is local delivery/commit time and can be later than a
      -- legitimate state event delivered out of order.
      SELECT pg_catalog.max(activation.source_event_created_at)
      INTO v_payment_authority_event_created_at
      FROM public.stripe_b2c_recurring_activations AS activation
      WHERE activation.authority_kind = 'paid'
        AND activation.livemode = p_livemode
        AND activation.user_id = p_user_id
        AND activation.stripe_customer_id = p_stripe_customer_id
        AND activation.stripe_subscription_id = p_stripe_subscription_id
        AND activation.plan = p_plan
        AND activation.expected_amount = v_payment.amount_paid
        AND activation.currency = v_payment.currency
        AND activation.period_start = v_payment.period_start
        AND activation.period_end = v_payment.period_end
        AND activation.activation_committed_at IS NOT NULL;
    END IF;
    IF v_exact_payment
      AND p_stripe_status IN (
        'past_due', 'canceled', 'unpaid', 'incomplete',
        'incomplete_expired', 'paused'
      )
    THEN
      IF v_payment_authority_event_created_at IS NULL THEN
        -- Pre-cutover payments have no trustworthy Stripe event-time baseline.
        -- Persist the signed downgrade for later replay, but never compare it
        -- with a local commit timestamp or mutate current authority blindly.
        UPDATE public.stripe_subscription_state_events
        SET outcome = 'not_current'
        WHERE event_id = p_event_id;
        RETURN pg_catalog.jsonb_build_object(
          'status', 'not_current',
          'reason', 'activation_event_watermark_missing'
        );
      END IF;
      IF p_event_created_at < v_payment_authority_event_created_at THEN
        UPDATE public.stripe_subscription_state_events
        SET outcome = 'stale'
        WHERE event_id = p_event_id;
        RETURN pg_catalog.jsonb_build_object('status', 'stale_event');
      END IF;
    END IF;
    IF v_exact_payment
      AND p_stripe_status IN ('active', 'trialing')
    THEN
      v_exact_payment :=
        p_current_invoice_id = v_payment.stripe_invoice_id
        AND p_period_start = v_payment.period_start
        AND p_period_end = v_payment.period_end;
    END IF;
    IF v_exact_payment
      AND p_stripe_status IN (
        'canceled',
        'unpaid',
        'incomplete',
        'incomplete_expired',
        'paused'
      )
    THEN
      -- A terminal event may close either the exact paid period or the exact
      -- failed-invoice episode accepted immediately before it. It may never
      -- retire a newer paid period merely because the subscription id matches.
      v_exact_payment :=
        (
          (
            p_current_invoice_id = v_payment.stripe_invoice_id
            AND p_period_start = v_payment.period_start
            AND p_period_end = v_payment.period_end
          )
          OR (
            v_has_latest_event
            AND v_latest_event.outcome IN ('applied', 'inactive_state_applied')
            AND v_latest_event.stripe_status = 'past_due'
            AND v_latest_event.current_invoice_id =
              p_current_invoice_id
            AND v_latest_event.period_start = p_period_start
            AND v_latest_event.period_end = p_period_end
          )
        );
    END IF;
  ELSIF v_subscription.entitlement_trial_id IS NOT NULL THEN
    SELECT trial.*
    INTO v_trial
    FROM public.stripe_trial_entitlements AS trial
    WHERE trial.id = v_subscription.entitlement_trial_id
    FOR UPDATE;
    v_exact_trial :=
      FOUND
      AND v_trial.user_id = p_user_id
      AND v_trial.stripe_customer_id = p_stripe_customer_id
      AND v_trial.stripe_subscription_id = p_stripe_subscription_id
      AND v_trial.plan = p_plan
      AND v_trial.period_start = v_subscription.current_period_start
      AND v_trial.period_end = v_subscription.current_period_end
      AND v_trial.period_end = v_trial.period_start + interval '7 days'
      AND v_trial.revoked_at IS NULL
      AND p_period_start = v_trial.period_start
      AND p_period_end = v_trial.period_end;
    IF v_exact_trial THEN
      SELECT pg_catalog.max(activation.source_event_created_at)
      INTO v_trial_authority_event_created_at
      FROM public.stripe_b2c_recurring_activations AS activation
      WHERE activation.authority_kind = 'trial'
        AND activation.livemode = p_livemode
        AND activation.user_id = p_user_id
        AND activation.stripe_customer_id = p_stripe_customer_id
        AND activation.stripe_subscription_id = p_stripe_subscription_id
        AND activation.plan = p_plan
        AND activation.period_start = v_trial.period_start
        AND activation.period_end = v_trial.period_end
        AND activation.activation_committed_at IS NOT NULL;
    END IF;
    IF v_exact_trial
      AND p_stripe_status IN (
        'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'
      )
    THEN
      IF v_trial_authority_event_created_at IS NULL THEN
        UPDATE public.stripe_subscription_state_events
        SET outcome = 'not_current'
        WHERE event_id = p_event_id;
        RETURN pg_catalog.jsonb_build_object(
          'status', 'not_current',
          'reason', 'activation_event_watermark_missing'
        );
      END IF;
      IF p_event_created_at < v_trial_authority_event_created_at THEN
        UPDATE public.stripe_subscription_state_events
        SET outcome = 'stale'
        WHERE event_id = p_event_id;
        RETURN pg_catalog.jsonb_build_object('status', 'stale_event');
      END IF;
    END IF;
  END IF;

  IF NOT v_exact_payment
    AND NOT v_exact_trial
    AND v_base_exact_payment
    AND p_stripe_status IN (
      'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    )
    AND p_current_invoice_id IS DISTINCT FROM v_payment.stripe_invoice_id
    AND NOT (
      v_has_latest_event
      AND v_latest_event.outcome IN ('applied', 'inactive_state_applied')
      AND v_latest_event.stripe_status = 'past_due'
      AND v_latest_event.current_invoice_id = p_current_invoice_id
      AND v_latest_event.period_start = p_period_start
      AND v_latest_event.period_end = p_period_end
    )
  THEN
    -- A terminal fresh read can overtake the signed past_due event that proves
    -- this failed-invoice episode. Keep it replayable; the past_due writer
    -- drains it in the same transaction after establishing that prerequisite.
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'not_current'
    WHERE event_id = p_event_id;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'not_current',
      'reason', 'failed_invoice_prerequisite_pending'
    );
  END IF;

  IF NOT v_exact_payment AND NOT v_exact_trial THEN
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'manual_review'
    WHERE event_id = p_event_id;
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription_event',
      p_event_id,
      p_user_id,
      'subscription_state_binding_drift',
      'A Stripe state event did not match the exact current authority binding.',
      pg_catalog.jsonb_build_object(
        'subscription_projection_id', v_subscription.id,
        'entitlement_payment_id', v_subscription.entitlement_payment_id,
        'entitlement_trial_id', v_subscription.entitlement_trial_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  IF (v_exact_payment AND p_stripe_status = 'trialing')
    OR (
      v_exact_trial
      AND p_stripe_status IN ('active', 'past_due')
    )
  THEN
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'manual_review'
    WHERE event_id = p_event_id;
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription_event',
      p_event_id,
      p_user_id,
      'subscription_state_authority_kind_conflict',
      'A state-only event attempted to convert between paid and trial authority.',
      pg_catalog.jsonb_build_object('stripe_status', p_stripe_status)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  IF p_stripe_status IN (
      'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    )
    AND (
      (v_exact_payment AND v_payment_authority_event_created_at IS NOT NULL)
      OR (v_exact_trial AND v_trial_authority_event_created_at IS NOT NULL)
    )
  THEN
    -- An exact period is necessary but not sufficient: Stripe can deliver an
    -- older terminal Subscription event after a newer Invoice/trial authority
    -- for that same period. Compare signed Stripe creation time only with the
    -- activation event's signed Stripe creation time.
    IF p_event_created_at < COALESCE(
      v_payment_authority_event_created_at,
      v_trial_authority_event_created_at
    ) THEN
      UPDATE public.stripe_subscription_state_events
      SET outcome = 'stale'
      WHERE event_id = p_event_id;
      RETURN pg_catalog.jsonb_build_object('status', 'stale_event');
    END IF;

    IF p_event_created_at = COALESCE(
      v_payment_authority_event_created_at,
      v_trial_authority_event_created_at
    ) THEN
      -- Stripe event timestamps have only second resolution. Keep the safer
      -- terminal state, but make the cross-object partial-order ambiguity
      -- durable for operator review instead of inventing a DB-time ordering.
      PERFORM public.record_b2c_recurring_manual_review_atomic(
        'subscription_event',
        p_event_id,
        p_user_id,
        'same_second_terminal_activation_order',
        'A terminal Subscription event and exact activation share one Stripe creation timestamp; the fail-closed terminal state was applied.',
        pg_catalog.jsonb_build_object(
          'stripe_subscription_id', p_stripe_subscription_id,
          'stripe_status', p_stripe_status,
          'authority_kind', CASE
            WHEN v_exact_payment THEN 'paid'
            ELSE 'trial'
          END,
          'activation_event_created_at', COALESCE(
            v_payment_authority_event_created_at,
            v_trial_authority_event_created_at
          )
        )
      );
    END IF;
  END IF;

  IF NOT v_subject_active
    AND NOT (v_subject_banned AND p_stripe_status = 'past_due')
  THEN
    -- Signed state must remain monotonic while the durable subject is banned or
    -- soft-deleted. Persist every exact observation, but only tighten local
    -- authority; never invoke projection sync or enqueue a group join/restore.
    IF p_stripe_status IN (
      'past_due',
      'canceled',
      'unpaid',
      'incomplete',
      'incomplete_expired',
      'paused'
    ) THEN
      UPDATE public.subscriptions
      SET status = p_stripe_status,
          cancel_at_period_end = p_cancel_at_period_end,
          canceled_at = CASE
            WHEN p_stripe_status IN (
              'canceled', 'unpaid', 'incomplete',
              'incomplete_expired', 'paused'
            )
            THEN COALESCE(p_canceled_at, canceled_at, v_now)
            ELSE p_canceled_at
          END,
          updated_at = v_now
      WHERE id = v_subscription.id;

      UPDATE public.pro_entitlement_grants
      SET revoked_at = COALESCE(revoked_at, v_now),
          metadata = metadata || pg_catalog.jsonb_build_object(
            'episode_closed_at', v_now,
            'episode_close_reason',
            'inactive_subject_' || p_stripe_status
          ),
          updated_at = v_now
      WHERE user_id = p_user_id
        AND source = 'stripe_payment_retry_grace'
        AND metadata ->> 'stripe_subscription_id' =
          p_stripe_subscription_id
        AND metadata ->> 'episode_closed_at' IS NULL;

      IF v_exact_trial THEN
        UPDATE public.stripe_trial_entitlements
        SET revoked_at = COALESCE(revoked_at, v_now),
            revoke_reason = COALESCE(
              revoke_reason,
              'inactive_subject_stripe_state'
            ),
            updated_at = v_now
        WHERE id = v_trial.id;
      END IF;

      UPDATE public.user_profiles
      SET subscription_tier = 'free',
          pro_plan = NULL,
          pro_expires_at = NULL,
          is_pro = false,
          updated_at = v_now
      WHERE id = p_user_id;
      v_leave_ack := public.leave_pro_official_group_atomic(p_user_id);
      IF COALESCE(v_leave_ack ->> 'status', '')
        NOT IN ('left', 'not_member')
      THEN
        RAISE EXCEPTION 'atomic official-group leave returned invalid status';
      END IF;
      UPDATE public.stripe_subscription_state_events
      SET outcome = CASE
            WHEN p_stripe_status = 'past_due'
            THEN 'inactive_state_applied'
            ELSE 'inactive_terminal_applied'
          END
      WHERE event_id = p_event_id;
      RETURN pg_catalog.jsonb_build_object(
        'status', 'inactive_subject',
        'outcome', CASE
          WHEN p_stripe_status = 'past_due'
          THEN 'inactive_state_applied'
          ELSE 'inactive_terminal_applied'
        END
      );
    END IF;

    -- The inactive profile guard owns projection/group suppression. Preserve
    -- the latest exact canonical Stripe state so a later unban can reproject
    -- immediately without waiting for another webhook.
    UPDATE public.subscriptions
    SET status = p_stripe_status,
        cancel_at_period_end = p_cancel_at_period_end,
        canceled_at = p_canceled_at,
        updated_at = v_now
    WHERE id = v_subscription.id;

    IF p_stripe_status = 'active' THEN
      UPDATE public.pro_entitlement_grants
      SET revoked_at = COALESCE(revoked_at, v_now),
          metadata = metadata || pg_catalog.jsonb_build_object(
            'episode_closed_at', v_now,
            'episode_close_reason', 'inactive_subject_paid_recovery'
          ),
          updated_at = v_now
      WHERE user_id = p_user_id
        AND source = 'stripe_payment_retry_grace'
        AND metadata ->> 'stripe_subscription_id' = p_stripe_subscription_id
        AND metadata ->> 'episode_closed_at' IS NULL;
    END IF;

    UPDATE public.stripe_subscription_state_events
    SET outcome = 'inactive_state_applied'
    WHERE event_id = p_event_id;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'inactive_subject',
      'outcome', 'inactive_state_applied'
    );
  END IF;

  IF p_stripe_status = 'trialing' THEN
    UPDATE public.subscriptions
    SET status = 'trialing',
        cancel_at_period_end = p_cancel_at_period_end,
        canceled_at = p_canceled_at,
        updated_at = v_now
    WHERE id = v_subscription.id;

    PERFORM public.sync_current_pro_projection_atomic(p_user_id);
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'applied'
    WHERE event_id = p_event_id;
    RETURN pg_catalog.jsonb_build_object('status', 'reconciled');
  END IF;

  IF p_stripe_status = 'active' THEN
    UPDATE public.subscriptions
    SET status = 'active',
        cancel_at_period_end = p_cancel_at_period_end,
        canceled_at = p_canceled_at,
        updated_at = v_now
    WHERE id = v_subscription.id;

    UPDATE public.pro_entitlement_grants
    SET revoked_at = COALESCE(revoked_at, v_now),
        metadata = metadata || pg_catalog.jsonb_build_object(
          'episode_closed_at', v_now,
          'episode_close_reason', 'paid_recovery'
        ),
        updated_at = v_now
    WHERE user_id = p_user_id
      AND source = 'stripe_payment_retry_grace'
      AND metadata ->> 'stripe_subscription_id' =
        p_stripe_subscription_id
      AND metadata ->> 'episode_closed_at' IS NULL;

    PERFORM public.sync_current_pro_projection_atomic(p_user_id);
    INSERT INTO public.stripe_entitlement_effects (
      entitlement_payment_id,
      user_id,
      source_kind,
      source_key,
      operation_key,
      effect_type,
      payload
    ) VALUES (
      v_payment.id,
      p_user_id,
      'payment',
      v_payment.id::text,
      'state_restore:' || p_event_id,
      'pro_official_group_restore',
      pg_catalog.jsonb_build_object('event_id', p_event_id)
    )
    ON CONFLICT (
      source_kind,
      source_key,
      effect_type,
      operation_key
    ) DO NOTHING;
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'applied'
    WHERE event_id = p_event_id;
    RETURN pg_catalog.jsonb_build_object('status', 'reconciled');
  END IF;

  IF p_stripe_status = 'past_due' THEN
    IF p_current_invoice_id = v_payment.stripe_invoice_id
      OR v_payment_authority_event_created_at IS NULL
      OR p_event_created_at < v_payment_authority_event_created_at
    THEN
      UPDATE public.stripe_subscription_state_events
      SET outcome = 'stale'
      WHERE event_id = p_event_id;
    PERFORM public.record_b2c_recurring_manual_review_atomic(
        'subscription_event',
        p_event_id,
        p_user_id,
        'paid_invoice_state_downgrade',
        'A past-due state attempted to downgrade a newer exact succeeded payment.',
        pg_catalog.jsonb_build_object(
          'paid_invoice_id', v_payment.stripe_invoice_id,
          'failed_invoice_id', p_current_invoice_id,
          'payment_authority_event_created_at',
          v_payment_authority_event_created_at,
          'event_created_at', p_event_created_at
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'stale_event');
    END IF;

    SELECT pg_catalog.min(entitlement_grant.starts_at)
    INTO v_first_failed_at
    FROM public.pro_entitlement_grants AS entitlement_grant
    WHERE entitlement_grant.user_id = p_user_id
      AND entitlement_grant.source = 'stripe_payment_retry_grace'
      AND entitlement_grant.metadata ->> 'stripe_subscription_id' =
        p_stripe_subscription_id
      AND entitlement_grant.metadata ->> 'episode_closed_at' IS NULL;

    SELECT entitlement_grant.*
    INTO v_grace
    FROM public.pro_entitlement_grants AS entitlement_grant
    WHERE entitlement_grant.source = 'stripe_payment_retry_grace'
      AND entitlement_grant.source_key =
        'subscription:' || p_stripe_subscription_id
        || ':invoice:' || p_current_invoice_id
    FOR UPDATE;

    IF FOUND THEN
      IF v_grace.user_id IS DISTINCT FROM p_user_id
        OR v_grace.grant_kind IS DISTINCT FROM 'absolute'
        OR v_grace.metadata ->> 'stripe_subscription_id'
          IS DISTINCT FROM p_stripe_subscription_id
        OR v_grace.metadata ->> 'stripe_invoice_id'
          IS DISTINCT FROM p_current_invoice_id
      THEN
        RAISE EXCEPTION 'retry grace identity conflict'
          USING ERRCODE = '23514';
      END IF;
      v_first_failed_at := COALESCE(
        v_first_failed_at,
        v_grace.starts_at
      );
      v_grace_cap :=
        v_first_failed_at + pg_catalog.make_interval(days => 14);
      v_effective_grace_expires_at :=
        LEAST(p_grace_expires_at, v_grace_cap);
      UPDATE public.pro_entitlement_grants
      SET expires_at = GREATEST(
            expires_at,
            v_effective_grace_expires_at
          ),
          revoked_at = CASE
            WHEN v_effective_grace_expires_at
              > pg_catalog.statement_timestamp()
            THEN NULL
            ELSE revoked_at
          END,
          updated_at = v_now
      WHERE id = v_grace.id;
    ELSE
      v_first_failed_at := COALESCE(
        v_first_failed_at,
        p_event_created_at
      );
      v_grace_cap :=
        v_first_failed_at + pg_catalog.make_interval(days => 14);
      v_effective_grace_expires_at :=
        LEAST(p_grace_expires_at, v_grace_cap);
      INSERT INTO public.pro_entitlement_grants (
        user_id,
        source,
        source_key,
        starts_at,
        expires_at,
        metadata,
        updated_at
      ) VALUES (
        p_user_id,
        'stripe_payment_retry_grace',
        'subscription:' || p_stripe_subscription_id
          || ':invoice:' || p_current_invoice_id,
        v_first_failed_at,
        v_effective_grace_expires_at,
        pg_catalog.jsonb_build_object(
          'stripe_subscription_id', p_stripe_subscription_id,
          'stripe_invoice_id', p_current_invoice_id,
          'first_failed_at', v_first_failed_at
        ),
        v_now
      );
    END IF;

    UPDATE public.pro_entitlement_grants
    SET revoked_at = COALESCE(revoked_at, v_now),
        metadata = metadata || pg_catalog.jsonb_build_object(
          'superseded_by_invoice_id',
          p_current_invoice_id
        ),
        updated_at = v_now
    WHERE user_id = p_user_id
      AND source = 'stripe_payment_retry_grace'
      AND metadata ->> 'stripe_subscription_id' =
        p_stripe_subscription_id
      AND source_key IS DISTINCT FROM
        'subscription:' || p_stripe_subscription_id
        || ':invoice:' || p_current_invoice_id
      AND revoked_at IS NULL;

    UPDATE public.subscriptions
    SET status = 'past_due',
        cancel_at_period_end = p_cancel_at_period_end,
        canceled_at = p_canceled_at,
        updated_at = v_now
    WHERE id = v_subscription.id;

    IF v_subject_banned THEN
      -- Moderation pauses access, not the commercial retry episode.  The grace
      -- row above is durable authority for a later unban, but the mutable
      -- projection and official-group edge stay suppressed while banned.
      UPDATE public.user_profiles
      SET subscription_tier = 'free',
          pro_plan = NULL,
          pro_expires_at = NULL,
          is_pro = false,
          updated_at = v_now
      WHERE id = p_user_id;
      v_has_authority := false;
    ELSE
      v_has_authority :=
        public.sync_current_pro_projection_atomic(p_user_id);
    END IF;
    IF NOT v_has_authority THEN
      v_leave_ack := public.leave_pro_official_group_atomic(p_user_id);
      IF COALESCE(v_leave_ack ->> 'status', '')
        NOT IN ('left', 'not_member')
      THEN
        RAISE EXCEPTION
          'atomic official-group leave returned invalid status';
      END IF;
    END IF;
    UPDATE public.stripe_subscription_state_events
    SET outcome = CASE
          WHEN v_subject_banned THEN 'inactive_state_applied'
          ELSE 'applied'
        END
    WHERE event_id = p_event_id;
    RETURN pg_catalog.jsonb_build_object(
      'status',
      CASE
        WHEN v_subject_banned THEN 'inactive_subject'
        WHEN v_has_authority THEN 'grace_applied'
        ELSE 'grace_expired'
      END,
      'outcome', CASE
        WHEN v_subject_banned THEN 'inactive_state_applied'
        ELSE 'applied'
      END,
      'grace_expires_at',
      v_effective_grace_expires_at
    );
  END IF;

  -- Remaining statuses are non-entitling. They may retire only this exact
  -- current Stripe subscription and never a newer payment, lifetime payment,
  -- or unrelated explicit grant.
  UPDATE public.subscriptions
  SET status = p_stripe_status,
      cancel_at_period_end = p_cancel_at_period_end,
      canceled_at = COALESCE(p_canceled_at, canceled_at, v_now),
      updated_at = v_now
  WHERE id = v_subscription.id;

  UPDATE public.pro_entitlement_grants
  SET revoked_at = COALESCE(revoked_at, v_now),
      metadata = metadata || pg_catalog.jsonb_build_object(
        'episode_closed_at', v_now,
        'episode_close_reason', p_stripe_status
      ),
      updated_at = v_now
  WHERE user_id = p_user_id
    AND source = 'stripe_payment_retry_grace'
    AND metadata ->> 'stripe_subscription_id' =
      p_stripe_subscription_id
    AND metadata ->> 'episode_closed_at' IS NULL;

  IF v_exact_trial THEN
    UPDATE public.stripe_trial_entitlements
    SET revoked_at = COALESCE(revoked_at, v_now),
        revoke_reason = COALESCE(revoke_reason, 'stripe_terminal_state'),
        updated_at = v_now
    WHERE id = v_trial.id
      AND revoked_at IS NULL;
  END IF;

  v_has_authority := public.sync_current_pro_projection_atomic(p_user_id);
  IF NOT v_has_authority THEN
    v_leave_ack := public.leave_pro_official_group_atomic(p_user_id);
    IF COALESCE(v_leave_ack ->> 'status', '')
      NOT IN ('left', 'not_member')
    THEN
      RAISE EXCEPTION 'atomic official-group leave returned invalid status';
    END IF;
  END IF;
  UPDATE public.stripe_subscription_state_events
  SET outcome = 'applied'
  WHERE event_id = p_event_id;
  RETURN pg_catalog.jsonb_build_object(
    'status',
    CASE
      WHEN v_has_authority THEN 'grant_protected'
      ELSE 'revoked'
    END
  );
END
$function$;

ALTER FUNCTION public.reconcile_b2c_subscription_state_core_atomic(
  uuid, text, text, text, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz, boolean
) OWNER TO postgres;


CREATE OR REPLACE FUNCTION public.reconcile_b2c_subscription_event_atomic(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_current_invoice_id text,
  p_plan text,
  p_expected_amount bigint,
  p_currency text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_stripe_status text,
  p_cancel_at_period_end boolean,
  p_canceled_at timestamptz,
  p_grace_expires_at timestamptz,
  p_event_id text,
  p_event_created_at timestamptz,
  p_livemode boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_subject_active boolean := false;
  v_existing public.stripe_subscription_state_events%ROWTYPE;
  v_result jsonb;
  v_drain jsonb;
  v_status text;
  v_internal_event_id text;
  v_has_durable_activation boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_event_id IS NULL
    OR p_event_id IS DISTINCT FROM pg_catalog.btrim(p_event_id)
    OR p_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_event_id) > 255
    OR p_event_created_at IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR (
      p_current_invoice_id IS NOT NULL
      AND (
        p_current_invoice_id IS DISTINCT FROM pg_catalog.btrim(p_current_invoice_id)
        OR p_current_invoice_id !~ '^in_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_current_invoice_id) > 255
      )
    )
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_expected_amount <= 0
    OR p_currency !~ '^[a-z]{3}$'
  THEN
    RAISE EXCEPTION 'Stripe state event identity is invalid' USING ERRCODE = '22023';
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
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-customer-owner:' || p_stripe_customer_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-membership-stripe-subscription:' || p_livemode::text || ':' || p_stripe_subscription_id,
      0
    )
  );

  SELECT profile.* INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_profile.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription_event', p_event_id,
      CASE WHEN FOUND THEN p_user_id ELSE NULL END,
      'b2c_subscription_owner_conflict',
      'A signed subscription event did not match the exact local Stripe Customer owner.',
      pg_catalog.jsonb_build_object(
        'subscription_id', p_stripe_subscription_id,
        'customer_id', p_stripe_customer_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'owner_conflict');
  END IF;
  v_subject_active := v_profile.deleted_at IS NULL
    AND v_profile.banned_at IS NULL
    AND NOT (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > pg_catalog.statement_timestamp()
      )
    )
    AND NOT public.account_recovery_billing_surface_is_blocked_v2(p_user_id);

  PERFORM 1
  FROM public.stripe_subscription_state_events AS state_event
  WHERE state_event.stripe_subscription_id = p_stripe_subscription_id
    AND state_event.livemode IS NULL
  FOR UPDATE;
  IF EXISTS (
    SELECT 1
    FROM public.stripe_subscription_state_events AS state_event
    WHERE state_event.stripe_subscription_id = p_stripe_subscription_id
      AND state_event.livemode IS NULL
      AND (
        state_event.user_id IS DISTINCT FROM p_user_id
        OR state_event.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
        OR state_event.plan IS DISTINCT FROM p_plan
      )
  ) THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription', p_stripe_subscription_id, p_user_id,
      'b2c_legacy_subscription_mode_claim_conflict',
      'Pre-authority subscription state rows conflict with the signed mode owner.',
      pg_catalog.jsonb_build_object(
        'event_id', p_event_id,
        'customer_id', p_stripe_customer_id,
        'plan', p_plan,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;
  UPDATE public.stripe_subscription_state_events AS state_event
  SET livemode = p_livemode
  WHERE state_event.stripe_subscription_id = p_stripe_subscription_id
    AND state_event.livemode IS NULL
    AND state_event.user_id = p_user_id
    AND state_event.stripe_customer_id = p_stripe_customer_id
    AND state_event.plan = p_plan;

  SELECT state_event.* INTO v_existing
  FROM public.stripe_subscription_state_events AS state_event
  WHERE (
      state_event.livemode = p_livemode
      AND state_event.stripe_event_id = p_event_id
    ) OR (
      state_event.livemode = p_livemode
      AND state_event.stripe_event_id IS NULL
      AND state_event.event_id = p_event_id
    )
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_user_id
      OR v_existing.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_existing.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id
      OR (v_existing.stripe_price_id IS NOT NULL AND v_existing.stripe_price_id IS DISTINCT FROM p_stripe_price_id)
      OR (v_existing.expected_amount IS NOT NULL AND v_existing.expected_amount IS DISTINCT FROM p_expected_amount)
      OR (v_existing.currency IS NOT NULL AND v_existing.currency IS DISTINCT FROM p_currency)
      OR v_existing.current_invoice_id IS DISTINCT FROM p_current_invoice_id
      OR v_existing.plan IS DISTINCT FROM p_plan
      OR v_existing.period_start IS DISTINCT FROM p_period_start
      OR v_existing.period_end IS DISTINCT FROM p_period_end
      OR v_existing.event_created_at IS DISTINCT FROM p_event_created_at
    THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
        'subscription_event', p_event_id, p_user_id,
        'b2c_subscription_event_identity_conflict',
        'A signed Stripe subscription event was replayed with changed immutable identity.',
        pg_catalog.jsonb_build_object(
          'livemode', p_livemode,
          'subscription_id', p_stripe_subscription_id,
          'price_id', p_stripe_price_id
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    IF v_existing.stripe_status IS DISTINCT FROM p_stripe_status
      OR v_existing.cancel_at_period_end IS DISTINCT FROM p_cancel_at_period_end
      OR v_existing.canceled_at IS DISTINCT FROM p_canceled_at
      OR v_existing.requested_grace_expires_at IS DISTINCT FROM p_grace_expires_at
    THEN
      PERFORM public.record_b2c_recurring_manual_review_atomic(
        'subscription_event', p_event_id, p_user_id,
        'b2c_subscription_event_status_conflict',
        'A signed Stripe subscription event id was replayed with a changed snapshot.',
        pg_catalog.jsonb_build_object(
          'stored_status', v_existing.stripe_status,
          'incoming_status', p_stripe_status,
          'stored_cancel_at_period_end', v_existing.cancel_at_period_end,
          'incoming_cancel_at_period_end', p_cancel_at_period_end,
          'stored_canceled_at', v_existing.canceled_at,
          'incoming_canceled_at', p_canceled_at,
          'stored_grace_expires_at', v_existing.requested_grace_expires_at,
          'incoming_grace_expires_at', p_grace_expires_at,
          'livemode', p_livemode
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    UPDATE public.stripe_subscription_state_events
    SET livemode = p_livemode,
        stripe_event_id = p_event_id,
        stripe_price_id = p_stripe_price_id,
        expected_amount = p_expected_amount,
        currency = p_currency,
        outcome = CASE
          WHEN outcome = 'not_current' THEN 'pending_authority'
          ELSE outcome
        END
    WHERE event_id = v_existing.event_id;
    IF v_existing.outcome IN ('not_current', 'pending_authority')
      AND p_stripe_status IN (
        'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'
      )
    THEN
      SELECT EXISTS (
          SELECT 1
          FROM public.stripe_b2c_recurring_activations AS activation
          WHERE activation.livemode = p_livemode
            AND activation.user_id = p_user_id
            AND activation.stripe_customer_id = p_stripe_customer_id
            AND activation.stripe_subscription_id = p_stripe_subscription_id
            AND activation.stripe_price_id = p_stripe_price_id
            AND activation.plan = p_plan
            AND activation.expected_amount = p_expected_amount
            AND activation.currency = p_currency
            AND activation.period_start = p_period_start
            AND activation.period_end = p_period_end
            AND (
              activation.activation_committed_at IS NOT NULL
              OR activation.outcome IN (
                'current_entitlement_protected', 'stale_payment',
                'terminal_trial_recorded', 'refunded_payment', 'subject_deleted'
              )
            )
      ) INTO v_has_durable_activation;
      IF v_has_durable_activation THEN
          UPDATE public.stripe_subscription_state_events
          SET outcome = 'terminal_without_projection'
          WHERE event_id = v_existing.event_id;
          UPDATE public.pro_membership_checkout_reservations AS reservation
          SET status = 'retired',
              released_at = COALESCE(released_at, pg_catalog.clock_timestamp()),
              updated_at = pg_catalog.clock_timestamp()
          WHERE reservation.user_id = p_user_id
            AND reservation.livemode = p_livemode
            AND reservation.stripe_customer_id = p_stripe_customer_id
            AND reservation.stripe_subscription_id = p_stripe_subscription_id
            AND reservation.stripe_price_id = p_stripe_price_id
            AND reservation.pro_plan = p_plan
            AND reservation.unit_amount = p_expected_amount
            AND reservation.currency = p_currency
            AND reservation.status = 'converted';
        RETURN pg_catalog.jsonb_build_object('status', 'terminal_without_projection');
      END IF;
    END IF;
    IF v_existing.outcome = 'pending_authority' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'pending_authority');
    END IF;
    IF v_existing.outcome = 'not_current' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'pending_authority');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_reconciled', 'outcome', v_existing.outcome
    );
  END IF;

  IF v_internal_event_id IS NULL THEN
    v_internal_event_id := 'evt_b2c_' || CASE WHEN p_livemode THEN 'live_' ELSE 'test_' END
      || pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(p_event_id, 'UTF8')),
        'hex'
      );
  END IF;
  v_result := public.reconcile_b2c_subscription_state_core_atomic(
    p_user_id, p_stripe_customer_id, p_stripe_subscription_id,
    p_current_invoice_id, p_plan, p_period_start, p_period_end,
    p_stripe_status, p_cancel_at_period_end, p_canceled_at,
    p_grace_expires_at, v_internal_event_id, p_event_created_at, p_livemode
  );
  v_status := v_result ->> 'status';

  IF v_status = 'inactive_subject'
    AND p_stripe_status IN (
      'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    )
  THEN
    UPDATE public.pro_membership_checkout_reservations AS reservation
    SET status = 'retired',
        released_at = COALESCE(released_at, pg_catalog.clock_timestamp()),
        updated_at = pg_catalog.clock_timestamp()
    WHERE reservation.user_id = p_user_id
      AND reservation.livemode = p_livemode
      AND reservation.stripe_customer_id = p_stripe_customer_id
      AND reservation.stripe_subscription_id = p_stripe_subscription_id
      AND reservation.stripe_price_id = p_stripe_price_id
      AND reservation.pro_plan = p_plan
      AND reservation.unit_amount = p_expected_amount
      AND reservation.currency = p_currency
      AND reservation.status = 'converted';
  END IF;

  IF v_status = 'not_current' THEN
    IF p_stripe_status IN (
      'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    ) THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.stripe_b2c_recurring_activations AS activation
        WHERE activation.livemode = p_livemode
          AND activation.user_id = p_user_id
          AND activation.stripe_customer_id = p_stripe_customer_id
          AND activation.stripe_subscription_id = p_stripe_subscription_id
          AND activation.stripe_price_id = p_stripe_price_id
          AND activation.plan = p_plan
          AND activation.expected_amount = p_expected_amount
          AND activation.currency = p_currency
          AND activation.period_start = p_period_start
          AND activation.period_end = p_period_end
          AND (
            activation.activation_committed_at IS NOT NULL
            OR activation.outcome IN (
              'current_entitlement_protected', 'stale_payment',
              'terminal_trial_recorded', 'refunded_payment', 'subject_deleted'
            )
          )
      ) INTO v_has_durable_activation;
    END IF;
    UPDATE public.stripe_subscription_state_events
    SET outcome = CASE
          WHEN v_has_durable_activation THEN 'terminal_without_projection'
          ELSE 'pending_authority'
        END,
        livemode = p_livemode,
        stripe_event_id = p_event_id,
        stripe_price_id = p_stripe_price_id,
        expected_amount = p_expected_amount,
        currency = p_currency
    WHERE event_id = v_internal_event_id;
    IF v_has_durable_activation THEN
      UPDATE public.pro_membership_checkout_reservations AS reservation
      SET status = 'retired',
          released_at = COALESCE(released_at, pg_catalog.clock_timestamp()),
          updated_at = pg_catalog.clock_timestamp()
      WHERE reservation.user_id = p_user_id
        AND reservation.livemode = p_livemode
        AND reservation.stripe_customer_id = p_stripe_customer_id
        AND reservation.stripe_subscription_id = p_stripe_subscription_id
        AND reservation.stripe_price_id = p_stripe_price_id
        AND reservation.pro_plan = p_plan
        AND reservation.unit_amount = p_expected_amount
        AND reservation.currency = p_currency
        AND reservation.status = 'converted';
      RETURN pg_catalog.jsonb_build_object('status', 'terminal_without_projection');
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'pending_authority');
  END IF;

  UPDATE public.stripe_subscription_state_events
  SET livemode = p_livemode,
      stripe_event_id = p_event_id,
      stripe_price_id = p_stripe_price_id,
      expected_amount = p_expected_amount,
      currency = p_currency
  WHERE event_id = v_internal_event_id
    AND (livemode IS NULL OR livemode = p_livemode);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'subscription event mode persistence failed';
  END IF;
  IF p_stripe_status = 'past_due'
    AND v_status IN ('grace_applied', 'grace_expired', 'inactive_subject')
  THEN
    v_drain := public.drain_pending_b2c_subscription_events_atomic(
      p_user_id, p_stripe_customer_id, p_stripe_subscription_id,
      p_stripe_price_id, p_plan, p_expected_amount, p_currency, p_livemode
    );
    RETURN v_result || pg_catalog.jsonb_build_object('pending_state', v_drain);
  END IF;
  RETURN v_result;
END
$function$;

ALTER FUNCTION public.reconcile_b2c_subscription_event_atomic(
  uuid, text, text, text, text, text, bigint, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.drain_pending_b2c_subscription_events_atomic(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_plan text,
  p_expected_amount bigint,
  p_currency text,
  p_livemode boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_events public.stripe_subscription_state_events[];
  v_event public.stripe_subscription_state_events%ROWTYPE;
  v_latest_event public.stripe_subscription_state_events%ROWTYPE;
  v_result jsonb;
  v_count integer := 0;
  v_has_exact_projection boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL
    OR p_user_id IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_expected_amount <= 0
    OR p_currency !~ '^[a-z]{3}$'
  THEN
    RAISE EXCEPTION 'pending subscription drain identity is invalid' USING ERRCODE = '22023';
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
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-customer-owner:' || p_stripe_customer_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-membership-stripe-subscription:' || p_livemode::text || ':' || p_stripe_subscription_id,
      0
    )
  );

  PERFORM 1
  FROM public.stripe_subscription_state_events AS state_event
  WHERE state_event.stripe_subscription_id = p_stripe_subscription_id
    AND state_event.livemode = p_livemode
    AND state_event.outcome = 'pending_authority'
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_subscription_state_events AS state_event
    WHERE state_event.stripe_subscription_id = p_stripe_subscription_id
      AND state_event.livemode = p_livemode
      AND state_event.outcome = 'pending_authority'
      AND (
        state_event.user_id IS DISTINCT FROM p_user_id
        OR state_event.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
        OR state_event.stripe_price_id IS DISTINCT FROM p_stripe_price_id
        OR state_event.plan IS DISTINCT FROM p_plan
        OR state_event.expected_amount IS DISTINCT FROM p_expected_amount
        OR state_event.currency IS DISTINCT FROM p_currency
      )
  ) THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription', p_stripe_subscription_id, p_user_id,
      'b2c_pending_subscription_identity_conflict',
      'Pending signed subscription states conflict with activation authority.',
      pg_catalog.jsonb_build_object(
        'customer_id', p_stripe_customer_id,
        'price_id', p_stripe_price_id,
        'plan', p_plan,
        'expected_amount', p_expected_amount,
        'currency', p_currency,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review', 'processed_count', 0);
  END IF;

  SELECT pg_catalog.array_agg(
    state_event
    ORDER BY
      state_event.event_created_at,
      CASE
        WHEN state_event.stripe_status IN ('active', 'trialing') THEN 0
        WHEN state_event.stripe_status = 'past_due' THEN 1
        ELSE 2
      END,
      state_event.event_id
  )
  INTO v_events
  FROM public.stripe_subscription_state_events AS state_event
  WHERE state_event.stripe_subscription_id = p_stripe_subscription_id
    AND state_event.livemode = p_livemode
    AND state_event.outcome = 'pending_authority';

  IF COALESCE(pg_catalog.cardinality(v_events), 0) = 0 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'none_pending', 'processed_count', 0);
  END IF;

  SELECT state_event.* INTO v_latest_event
  FROM public.stripe_subscription_state_events AS state_event
  WHERE state_event.stripe_subscription_id = p_stripe_subscription_id
    AND state_event.livemode = p_livemode
    AND state_event.outcome = 'pending_authority'
  ORDER BY
    state_event.event_created_at DESC,
    CASE
      WHEN state_event.stripe_status IN ('active', 'trialing') THEN 0
      WHEN state_event.stripe_status = 'past_due' THEN 1
      ELSE 2
    END DESC,
    state_event.event_id DESC
  LIMIT 1;

  SELECT EXISTS (
    SELECT 1
    FROM public.subscriptions AS subscription
    WHERE subscription.user_id = p_user_id
      AND subscription.stripe_customer_id = p_stripe_customer_id
      AND subscription.stripe_subscription_id = p_stripe_subscription_id
      AND subscription.plan = p_plan
  ) INTO v_has_exact_projection;

  IF NOT v_has_exact_projection THEN
    IF v_latest_event.stripe_status IN (
      'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    ) THEN
      UPDATE public.stripe_subscription_state_events
      SET outcome = 'terminal_without_projection'
      WHERE stripe_subscription_id = p_stripe_subscription_id
        AND livemode = p_livemode
        AND outcome = 'pending_authority';
      RETURN pg_catalog.jsonb_build_object(
        'status', 'terminal_without_projection',
        'processed_count', pg_catalog.cardinality(v_events)
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'projection_not_ready', 'processed_count', 0
    );
  END IF;

  DELETE FROM public.stripe_subscription_state_events
  WHERE stripe_subscription_id = p_stripe_subscription_id
    AND livemode = p_livemode
    AND outcome = 'pending_authority';

  FOREACH v_event IN ARRAY v_events LOOP
    v_result := public.reconcile_b2c_subscription_state_core_atomic(
      v_event.user_id, v_event.stripe_customer_id, v_event.stripe_subscription_id,
      v_event.current_invoice_id, v_event.plan, v_event.period_start, v_event.period_end,
      v_event.stripe_status, v_event.cancel_at_period_end, v_event.canceled_at,
      v_event.requested_grace_expires_at, v_event.event_id, v_event.event_created_at,
      p_livemode
    );
    UPDATE public.stripe_subscription_state_events
    SET livemode = p_livemode,
        stripe_event_id = v_event.stripe_event_id,
        stripe_price_id = v_event.stripe_price_id,
        expected_amount = v_event.expected_amount,
        currency = v_event.currency
    WHERE event_id = v_event.event_id;
    v_count := v_count + 1;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'drained',
    'processed_count', v_count,
    'last_result', v_result
  );
END
$function$;

ALTER FUNCTION public.drain_pending_b2c_subscription_events_atomic(
  uuid, text, text, text, text, bigint, text, boolean
)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.check_b2c_activation_reservation_atomic(
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_plan text,
  p_expected_amount bigint,
  p_currency text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_expected_amount <= 0
    OR p_currency !~ '^[a-z]{3}$'
  THEN
    RAISE EXCEPTION 'activation reservation identity is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-customer-owner:' || p_stripe_customer_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-membership-stripe-subscription:' || p_livemode::text || ':' || p_stripe_subscription_id,
      0
    )
  );

  PERFORM 1
  FROM public.pro_membership_checkout_reservations AS reservation
  WHERE reservation.livemode = p_livemode
    AND reservation.status IN ('reserved', 'bound', 'converted')
    AND (
      reservation.user_id = p_user_id
      OR reservation.stripe_customer_id = p_stripe_customer_id
    )
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.pro_membership_checkout_reservations AS reservation
    WHERE reservation.livemode = p_livemode
      AND reservation.status IN ('reserved', 'bound', 'converted')
      AND (
        reservation.user_id = p_user_id
        OR reservation.stripe_customer_id = p_stripe_customer_id
      )
      AND (
        reservation.status <> 'converted'
        OR reservation.user_id IS DISTINCT FROM p_user_id
        OR reservation.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
        OR reservation.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id
        OR reservation.stripe_price_id IS DISTINCT FROM p_stripe_price_id
        OR reservation.pro_plan IS DISTINCT FROM p_plan
        OR reservation.unit_amount IS DISTINCT FROM p_expected_amount
        OR reservation.currency IS DISTINCT FROM p_currency
      )
  ) THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription', p_stripe_subscription_id, p_user_id,
      'b2c_activation_reservation_conflict',
      'Recurring activation conflicts with an in-flight or different Pro Checkout reservation.',
      pg_catalog.jsonb_build_object(
        'livemode', p_livemode,
        'customer_id', p_stripe_customer_id,
        'price_id', p_stripe_price_id,
        'plan', p_plan,
        'expected_amount', p_expected_amount,
        'currency', p_currency
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status',
    CASE WHEN EXISTS (
      SELECT 1
      FROM public.pro_membership_checkout_reservations AS reservation
      WHERE reservation.user_id = p_user_id
        AND reservation.livemode = p_livemode
        AND reservation.stripe_customer_id = p_stripe_customer_id
        AND reservation.stripe_subscription_id = p_stripe_subscription_id
        AND reservation.stripe_price_id = p_stripe_price_id
        AND reservation.pro_plan = p_plan
        AND reservation.unit_amount = p_expected_amount
        AND reservation.currency = p_currency
        AND reservation.status = 'converted'
    ) THEN 'exact_converted' ELSE 'no_active_reservation' END
  );
END
$function$;

ALTER FUNCTION public.check_b2c_activation_reservation_atomic(
  uuid, boolean, text, text, text, text, bigint, text
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.observe_b2c_recurring_activation_atomic(
  p_authority_kind text,
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_plan text,
  p_expected_amount bigint,
  p_currency text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_stripe_subscription_status text,
  p_source_event_id text,
  p_source_event_created_at timestamptz,
  p_livemode boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_existing public.stripe_b2c_recurring_activations%ROWTYPE;
  v_existing_state_rank integer;
  v_incoming_state_rank integer;
  v_effective_status text;
  v_effective_outcome text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_authority_kind NOT IN ('paid', 'trial')
    OR p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_source_event_id IS NULL
    OR p_source_event_id IS DISTINCT FROM pg_catalog.btrim(p_source_event_id)
    OR p_source_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_source_event_id) > 255
    OR p_source_event_created_at IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_expected_amount <= 0
    OR p_currency !~ '^[a-z]{3}$'
    OR p_period_start IS NULL
    OR p_period_end IS NULL
    OR p_period_end <= p_period_start
    OR p_stripe_subscription_status NOT IN (
      'active', 'trialing', 'past_due', 'canceled', 'unpaid',
      'incomplete', 'incomplete_expired', 'paused'
    )
  THEN
    RAISE EXCEPTION 'recurring activation observation identity is invalid'
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
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-customer-owner:' || p_stripe_customer_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-membership-stripe-subscription:' || p_livemode::text || ':' || p_stripe_subscription_id,
      0
    )
  );

  SELECT activation.* INTO v_existing
  FROM public.stripe_b2c_recurring_activations AS activation
  WHERE activation.livemode = p_livemode
    AND activation.source_event_id = p_source_event_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.source_event_created_at IS DISTINCT FROM p_source_event_created_at
      OR v_existing.authority_kind IS DISTINCT FROM p_authority_kind
      OR v_existing.user_id IS DISTINCT FROM p_user_id
      OR v_existing.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_existing.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id
      OR v_existing.stripe_price_id IS DISTINCT FROM p_stripe_price_id
      OR v_existing.plan IS DISTINCT FROM p_plan
      OR v_existing.expected_amount IS DISTINCT FROM p_expected_amount
      OR v_existing.currency IS DISTINCT FROM p_currency
      OR v_existing.period_start IS DISTINCT FROM p_period_start
      OR v_existing.period_end IS DISTINCT FROM p_period_end
    THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
        'subscription_event', p_source_event_id, p_user_id,
        'b2c_activation_event_identity_conflict',
        'A signed recurring activation event was replayed with changed immutable identity.',
        pg_catalog.jsonb_build_object(
          'authority_kind', p_authority_kind,
          'subscription_id', p_stripe_subscription_id,
          'price_id', p_stripe_price_id,
          'livemode', p_livemode
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    v_existing_state_rank := CASE
      WHEN v_existing.observed_subscription_status IN ('active', 'trialing') THEN 0
      WHEN v_existing.observed_subscription_status = 'past_due' THEN 1
      ELSE 2
    END;
    v_incoming_state_rank := CASE
      WHEN p_stripe_subscription_status IN ('active', 'trialing') THEN 0
      WHEN p_stripe_subscription_status = 'past_due' THEN 1
      ELSE 2
    END;

    IF v_incoming_state_rank > v_existing_state_rank THEN
      v_effective_status := p_stripe_subscription_status;
      v_effective_outcome := 'observed';
      UPDATE public.stripe_b2c_recurring_activations
      SET observed_subscription_status = v_effective_status,
          outcome = 'observed'
      WHERE livemode = p_livemode
        AND source_event_id = p_source_event_id;
    ELSIF v_incoming_state_rank < v_existing_state_rank THEN
      v_effective_status := v_existing.observed_subscription_status;
      v_effective_outcome := v_existing.outcome;
    ELSIF v_existing.observed_subscription_status
      IS DISTINCT FROM p_stripe_subscription_status
    THEN
      PERFORM public.record_b2c_recurring_manual_review_atomic(
        'subscription_event', p_source_event_id, p_user_id,
        'b2c_activation_observation_rank_conflict',
        'Fresh reads for one recurring activation event returned different equal-rank Subscription states.',
        pg_catalog.jsonb_build_object(
          'existing_status', v_existing.observed_subscription_status,
          'incoming_status', p_stripe_subscription_status,
          'authority_kind', p_authority_kind,
          'livemode', p_livemode
        )
      );
      RETURN pg_catalog.jsonb_build_object(
        'status', 'identity_conflict',
        'effective_subscription_status',
        v_existing.observed_subscription_status
      );
    ELSE
      v_effective_status := v_existing.observed_subscription_status;
      v_effective_outcome := v_existing.outcome;
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_observed',
      'outcome', v_effective_outcome,
      'effective_subscription_status', v_effective_status,
      'observation', CASE
        WHEN v_incoming_state_rank > v_existing_state_rank THEN 'tightened'
        WHEN v_incoming_state_rank < v_existing_state_rank THEN 'stricter_barrier_preserved'
        ELSE 'replayed'
      END
    );
  END IF;

  INSERT INTO public.stripe_b2c_recurring_activations (
    livemode, source_event_id, source_event_created_at, authority_kind,
    user_id, stripe_customer_id, stripe_subscription_id, stripe_price_id,
    plan, expected_amount, currency, period_start, period_end,
    observed_subscription_status
  ) VALUES (
    p_livemode, p_source_event_id, p_source_event_created_at, p_authority_kind,
    p_user_id, p_stripe_customer_id, p_stripe_subscription_id, p_stripe_price_id,
    p_plan, p_expected_amount, p_currency, p_period_start, p_period_end,
    p_stripe_subscription_status
  );
  RETURN pg_catalog.jsonb_build_object(
    'status', 'observed',
    'effective_subscription_status', p_stripe_subscription_status
  );
END
$function$;

ALTER FUNCTION public.observe_b2c_recurring_activation_atomic(
  text, uuid, text, text, text, text, bigint, text, timestamptz, timestamptz,
  text, text, timestamptz, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.activate_b2c_recurring_payment_atomic(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_invoice_id text,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_stripe_price_id text,
  p_plan text,
  p_amount_paid bigint,
  p_currency text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_payment_status text,
  p_stripe_subscription_status text,
  p_source_event_id text,
  p_source_event_created_at timestamptz,
  p_livemode boolean,
  p_financial_only boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_profile_exists boolean := false;
  v_subject_billable boolean := false;
  v_subject_active boolean := false;
  v_billing_surface_blocked boolean := false;
  v_frozen_recovery_target boolean := false;
  v_financial_block_reason text;
  v_result jsonb;
  v_drain jsonb;
  v_reservation jsonb;
  v_observation jsonb;
  v_effective_status text;
  v_same_second_stricter_status text;
  v_payment_id uuid;
  v_match_ids uuid[];
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_tombstone_merge jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_financial_only IS NULL
    OR p_source_event_id IS NULL
    OR p_source_event_id IS DISTINCT FROM pg_catalog.btrim(p_source_event_id)
    OR p_source_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_source_event_id) > 255
    OR p_source_event_created_at IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_stripe_invoice_id IS NULL
    OR p_stripe_invoice_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_invoice_id)
    OR p_stripe_invoice_id !~ '^in_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_invoice_id) > 255
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND (
        p_stripe_payment_intent_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_payment_intent_id)
        OR p_stripe_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_stripe_payment_intent_id) > 255
      )
    )
    OR p_stripe_charge_id IS NULL
    OR p_stripe_charge_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_charge_id)
    OR p_stripe_charge_id !~ '^ch_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_charge_id) > 255
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_amount_paid <= 0
    OR p_currency !~ '^[a-z]{3}$'
    OR p_period_start IS NULL
    OR p_period_end IS NULL
    OR p_period_end <= p_period_start
    OR p_payment_status NOT IN ('paid', 'succeeded')
    OR p_stripe_subscription_status NOT IN (
      'active', 'trialing', 'past_due', 'canceled', 'unpaid',
      'incomplete', 'incomplete_expired', 'paused'
    )
  THEN
    RAISE EXCEPTION 'recurring activation event identity is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-lifetime-seat-capacity', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-charge-refund:' || p_stripe_charge_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-customer-owner:' || p_stripe_customer_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-membership-stripe-subscription:' || p_livemode::text || ':' || p_stripe_subscription_id,
      0
    )
  );

  SELECT profile.* INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  v_profile_exists := FOUND;
  v_billing_surface_blocked :=
    public.account_recovery_billing_surface_is_blocked_v2(p_user_id);
  v_frozen_recovery_target := v_billing_surface_blocked
    AND public.account_recovery_frozen_b2c_target_matches_v2(
      p_user_id,
      p_livemode,
      p_stripe_customer_id,
      p_stripe_subscription_id,
      p_stripe_invoice_id,
      p_stripe_payment_intent_id,
      p_stripe_charge_id,
      p_stripe_price_id,
      p_plan,
      p_amount_paid,
      p_currency,
      p_period_start,
      p_period_end
    );
  v_subject_billable := v_profile_exists
    AND v_profile.deleted_at IS NULL
    AND NOT v_billing_surface_blocked;
  v_subject_active := v_profile_exists
    AND v_profile.deleted_at IS NULL
    AND v_profile.banned_at IS NULL
    AND NOT (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > pg_catalog.statement_timestamp()
      )
    )
    AND NOT v_billing_surface_blocked;
  IF v_profile_exists
    AND v_profile.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
  THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'invoice', p_stripe_invoice_id,
      p_user_id,
      'b2c_recurring_payment_owner_conflict',
      'A recurring payment did not match the exact local Stripe Customer owner.',
      pg_catalog.jsonb_build_object(
        'subscription_id', p_stripe_subscription_id,
        'source_event_id', p_source_event_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'owner_conflict');
  END IF;
  IF NOT v_profile_exists
    AND NOT public.has_b2c_recurring_financial_owner_atomic(
      p_user_id, p_stripe_customer_id, p_stripe_subscription_id, p_livemode
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.pro_membership_checkout_reservations AS reservation
      WHERE reservation.user_id = p_user_id
        AND reservation.livemode = p_livemode
        AND reservation.stripe_customer_id = p_stripe_customer_id
        AND reservation.stripe_price_id = p_stripe_price_id
        AND reservation.pro_plan = p_plan
        AND reservation.unit_amount = p_amount_paid
        AND reservation.currency = p_currency
        AND reservation.status = 'bound'
        AND reservation.checkout_session_id IS NOT NULL
        AND reservation.stripe_subscription_id IS NULL
    )
  THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'invoice', p_stripe_invoice_id, NULL,
      'b2c_recurring_payment_owner_conflict',
      'A recurring payment had no eligible profile or exact durable financial owner.',
      pg_catalog.jsonb_build_object(
        'opaque_owner_user_id', p_user_id,
        'subscription_id', p_stripe_subscription_id,
        'source_event_id', p_source_event_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'owner_conflict');
  END IF;
  IF p_financial_only AND v_subject_active THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'invoice', p_stripe_invoice_id, p_user_id,
      'b2c_financial_only_subject_reactivated',
      'A deleted-subject financial-only event found an eligible live profile and was not granted.',
      pg_catalog.jsonb_build_object(
        'subscription_id', p_stripe_subscription_id,
        'source_event_id', p_source_event_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'owner_conflict');
  END IF;

  IF v_subject_billable THEN
    v_reservation := public.check_b2c_activation_reservation_atomic(
      p_user_id, p_livemode, p_stripe_customer_id, p_stripe_subscription_id,
      p_stripe_price_id, p_plan, p_amount_paid, p_currency
    );
    IF v_reservation ->> 'status' = 'manual_review' THEN
      RETURN v_reservation;
    END IF;
  END IF;

  v_observation := public.observe_b2c_recurring_activation_atomic(
    'paid', p_user_id, p_stripe_customer_id, p_stripe_subscription_id,
    p_stripe_price_id, p_plan, p_amount_paid, p_currency,
    p_period_start, p_period_end, p_stripe_subscription_status,
    p_source_event_id, p_source_event_created_at, p_livemode
  );
  IF v_observation ->> 'status' = 'identity_conflict' THEN
    RETURN v_observation;
  END IF;
  v_effective_status := v_observation ->> 'effective_subscription_status';
  IF v_effective_status NOT IN (
    'active', 'trialing', 'past_due', 'canceled', 'unpaid',
    'incomplete', 'incomplete_expired', 'paused'
  ) THEN
    RAISE EXCEPTION 'recurring activation observation returned an invalid effective status';
  END IF;

  -- Stripe event timestamps have one-second precision.  If an exact signed
  -- terminal Subscription snapshot for this authority episode was already
  -- applied in the same second, the stricter state wins before any payment
  -- projection is granted.  The payment is still recorded below so financial
  -- truth and refundability are never lost.
  SELECT state_event.stripe_status
  INTO v_same_second_stricter_status
  FROM public.stripe_subscription_state_events AS state_event
  WHERE state_event.livemode = p_livemode
    AND state_event.user_id = p_user_id
    AND state_event.stripe_customer_id = p_stripe_customer_id
    AND state_event.stripe_subscription_id = p_stripe_subscription_id
    AND state_event.plan = p_plan
    AND state_event.period_start = p_period_start
    AND state_event.period_end = p_period_end
    AND state_event.event_created_at = p_source_event_created_at
    AND state_event.stripe_status IN (
      'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    )
    AND state_event.outcome IN (
      'applied', 'inactive_terminal_applied', 'terminal_without_projection',
      'equivalent'
    )
  ORDER BY state_event.event_id
  LIMIT 1;
  IF v_same_second_stricter_status IS NOT NULL THEN
    v_effective_status := v_same_second_stricter_status;
  END IF;

  IF v_frozen_recovery_target THEN
    -- Only recovery completion may consume the exact digest-bound target.
    -- Generic webhooks retain the signed observation without granting,
    -- refunding, canceling, or mutating its canonical local authority.
    UPDATE public.stripe_b2c_recurring_activations
    SET outcome = 'recovery_target_observed'
    WHERE livemode = p_livemode
      AND source_event_id = p_source_event_id;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'recovery_target_observed',
      'financial_observation_recorded', true
    );
  END IF;

  -- The legacy entitlement RPC intentionally converts a missing profile to a
  -- NULL audit owner.  After the financial-owner retention cutover that would
  -- contradict the immutable opaque owner and make a legitimate late renewal
  -- impossible to route or refund.  For an account that is already gone, use
  -- the exact durable owner proof above, append only the financial ledger, and
  -- queue a refund.  Never recreate a profile, subscription, grant, or group
  -- membership from this branch.
  IF NOT v_subject_billable THEN
    v_financial_block_reason := CASE
      WHEN v_billing_surface_blocked AND v_profile_exists
      THEN 'account_recovery_billing_blocked'
      ELSE 'paid_recurring_subject_deleted'
    END;
    INSERT INTO public.stripe_entitlement_payments (
      user_id,
      stripe_customer_id,
      payment_kind,
      plan,
      stripe_subscription_id,
      stripe_invoice_id,
      stripe_payment_intent_id,
      stripe_charge_id,
      amount_paid,
      currency,
      period_start,
      period_end,
      payment_status
    ) VALUES (
      p_user_id,
      p_stripe_customer_id,
      'recurring',
      p_plan,
      p_stripe_subscription_id,
      p_stripe_invoice_id,
      p_stripe_payment_intent_id,
      p_stripe_charge_id,
      p_amount_paid,
      p_currency,
      p_period_start,
      p_period_end,
      p_payment_status
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_payment_id;

    SELECT pg_catalog.array_agg(payment.id ORDER BY payment.id)
    INTO v_match_ids
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.stripe_invoice_id = p_stripe_invoice_id
      OR payment.stripe_charge_id = p_stripe_charge_id
      OR (
        p_stripe_payment_intent_id IS NOT NULL
        AND payment.stripe_payment_intent_id = p_stripe_payment_intent_id
      );

    IF pg_catalog.cardinality(v_match_ids) IS DISTINCT FROM 1 THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
        'invoice', p_stripe_invoice_id, NULL,
        'payment_identity_conflict',
        'A deleted-subject recurring payment resolved to multiple or no ledger rows.',
        pg_catalog.jsonb_build_object(
          'opaque_owner_user_id', p_user_id,
          'charge_id', p_stripe_charge_id,
          'payment_intent_id', p_stripe_payment_intent_id,
          'match_count', COALESCE(pg_catalog.cardinality(v_match_ids), 0)
        )
      );
      UPDATE public.stripe_b2c_recurring_activations
      SET outcome = 'identity_conflict'
      WHERE livemode = p_livemode
        AND source_event_id = p_source_event_id;
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    SELECT payment.* INTO v_payment
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.id = v_match_ids[1]
    FOR UPDATE;

    IF v_payment.user_id IS DISTINCT FROM p_user_id
      OR v_payment.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_payment.payment_kind IS DISTINCT FROM 'recurring'
      OR v_payment.plan IS DISTINCT FROM p_plan
      OR v_payment.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id
      OR v_payment.stripe_invoice_id IS DISTINCT FROM p_stripe_invoice_id
      OR v_payment.stripe_payment_intent_id IS DISTINCT FROM p_stripe_payment_intent_id
      OR v_payment.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
      OR v_payment.amount_paid IS DISTINCT FROM p_amount_paid
      OR v_payment.currency IS DISTINCT FROM p_currency
      OR v_payment.period_start IS DISTINCT FROM p_period_start
      OR v_payment.period_end IS DISTINCT FROM p_period_end
      OR v_payment.payment_status IS DISTINCT FROM p_payment_status
    THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
        'invoice', p_stripe_invoice_id, NULL,
        'payment_identity_conflict',
        'A deleted-subject recurring payment replay changed immutable identity.',
        pg_catalog.jsonb_build_object(
          'opaque_owner_user_id', p_user_id,
          'payment_id', v_payment.id,
          'charge_id', p_stripe_charge_id
        )
      );
      UPDATE public.stripe_b2c_recurring_activations
      SET outcome = 'identity_conflict'
      WHERE livemode = p_livemode
        AND source_event_id = p_source_event_id;
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    SELECT ownership.* INTO v_ownership
    FROM public.stripe_payment_ownerships AS ownership
    WHERE ownership.product_kind = 'pro_entitlement'
      AND ownership.ledger_id = v_payment.id
    FOR UPDATE;

    IF NOT FOUND
      OR v_ownership.owner_user_id IS DISTINCT FROM p_user_id
      OR v_ownership.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_ownership.stripe_payment_intent_id IS DISTINCT FROM p_stripe_payment_intent_id
      OR v_ownership.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
      OR v_ownership.checkout_session_id IS NOT NULL
      OR v_ownership.amount_paid IS DISTINCT FROM p_amount_paid
      OR v_ownership.currency IS DISTINCT FROM p_currency
      OR NOT public.stripe_payment_ownership_is_exact_v2(v_ownership.id)
    THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
        'payment_identity', p_stripe_charge_id, NULL,
        'unclaimed_entitlement_payment',
        'A deleted-subject recurring payment lacks exact central Pro ownership.',
        pg_catalog.jsonb_build_object(
          'opaque_owner_user_id', p_user_id,
          'payment_id', v_payment.id,
          'invoice_id', p_stripe_invoice_id
        )
      );
      UPDATE public.stripe_b2c_recurring_activations
      SET outcome = 'identity_conflict'
      WHERE livemode = p_livemode
        AND source_event_id = p_source_event_id;
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    v_tombstone_merge := public.stripe_merge_charge_refund_tombstone_v2(
      v_payment.id
    );
    IF v_tombstone_merge ->> 'status' IN ('identity_conflict', 'manual_review') THEN
      UPDATE public.stripe_b2c_recurring_activations
      SET outcome = COALESCE(v_tombstone_merge ->> 'status', 'manual_review')
      WHERE livemode = p_livemode
        AND source_event_id = p_source_event_id;
      RETURN v_tombstone_merge;
    END IF;

    SELECT payment.* INTO v_payment
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.id = v_match_ids[1]
    FOR UPDATE;

    IF v_payment.refund_state = 'succeeded'
      AND v_payment.refund_succeeded_amount >= v_payment.amount_paid
    THEN
      v_result := pg_catalog.jsonb_build_object('status', 'refunded_payment');
    ELSE
    PERFORM public.record_b2c_recurring_manual_review_atomic(
        'invoice', p_stripe_invoice_id, NULL,
        v_financial_block_reason,
        CASE
          WHEN v_financial_block_reason = 'account_recovery_billing_blocked'
          THEN 'A recurring payment completed while account recovery billing was fail-closed; refund and exact Subscription cancellation were queued.'
          ELSE 'A recurring payment completed after its opaque entitlement owner was deleted.'
        END,
        pg_catalog.jsonb_build_object(
          'opaque_owner_user_id', p_user_id,
          'payment_id', v_payment.id,
          'subscription_id', p_stripe_subscription_id,
          'payment_intent_id', p_stripe_payment_intent_id,
          'charge_id', p_stripe_charge_id
        )
      );
      INSERT INTO public.stripe_entitlement_effects (
        entitlement_payment_id,
        user_id,
        source_kind,
        source_key,
        operation_key,
        effect_type,
        payload
      ) VALUES (
        v_payment.id,
        CASE
          WHEN v_financial_block_reason = 'account_recovery_billing_blocked'
          THEN p_user_id
          ELSE NULL
        END,
        'payment',
        v_payment.id::text,
        'refund:' || v_financial_block_reason,
        'payment_auto_refund',
        pg_catalog.jsonb_build_object(
          'reason_key', v_financial_block_reason,
          'invoice_id', p_stripe_invoice_id
        )
      )
      ON CONFLICT (
        source_kind,
        source_key,
        effect_type,
        operation_key
      ) DO NOTHING;
      IF v_financial_block_reason = 'account_recovery_billing_blocked' THEN
        INSERT INTO public.stripe_entitlement_effects (
          entitlement_payment_id,
          user_id,
          source_kind,
          source_key,
          operation_key,
          effect_type,
          payload
        ) VALUES (
          v_payment.id,
          p_user_id,
          'payment',
          v_payment.id::text,
          'cancel:subscription:' || p_stripe_subscription_id,
          'stripe_subscription_cancel',
          pg_catalog.jsonb_build_object(
            'stripe_subscription_id', p_stripe_subscription_id,
            'stripe_customer_id', p_stripe_customer_id,
            'reason', 'account_recovery_billing_blocked',
            'protocol_version', 'dispatch_commit_v1'
          )
        )
        ON CONFLICT (
          source_kind,
          source_key,
          effect_type,
          operation_key
        ) DO NOTHING;
        v_result := pg_catalog.jsonb_build_object(
          'status', 'billing_blocked_payment'
        );
      ELSE
        v_result := pg_catalog.jsonb_build_object('status', 'subject_deleted');
      END IF;
    END IF;

    IF v_financial_block_reason = 'account_recovery_billing_blocked'
      AND v_result ->> 'status' = 'refunded_payment'
    THEN
      INSERT INTO public.stripe_entitlement_effects (
        entitlement_payment_id,
        user_id,
        source_kind,
        source_key,
        operation_key,
        effect_type,
        payload
      ) VALUES (
        v_payment.id,
        p_user_id,
        'payment',
        v_payment.id::text,
        'cancel:subscription:' || p_stripe_subscription_id,
        'stripe_subscription_cancel',
        pg_catalog.jsonb_build_object(
          'stripe_subscription_id', p_stripe_subscription_id,
          'stripe_customer_id', p_stripe_customer_id,
          'reason', 'account_recovery_billing_blocked',
          'protocol_version', 'dispatch_commit_v1'
        )
      )
      ON CONFLICT (
        source_kind,
        source_key,
        effect_type,
        operation_key
      ) DO NOTHING;
    END IF;

    UPDATE public.stripe_b2c_recurring_activations
    SET outcome = v_result ->> 'status'
    WHERE livemode = p_livemode
      AND source_event_id = p_source_event_id;

    UPDATE public.pro_membership_checkout_reservations AS reservation
    SET status = 'retired',
        released_at = COALESCE(released_at, pg_catalog.clock_timestamp()),
        updated_at = pg_catalog.clock_timestamp()
    WHERE reservation.user_id = p_user_id
      AND reservation.livemode = p_livemode
      AND reservation.stripe_customer_id = p_stripe_customer_id
      AND reservation.stripe_subscription_id = p_stripe_subscription_id
      AND reservation.stripe_price_id = p_stripe_price_id
      AND reservation.pro_plan = p_plan
      AND reservation.unit_amount = p_amount_paid
      AND reservation.currency = p_currency
      AND reservation.status = 'converted';

    RETURN v_result || pg_catalog.jsonb_build_object(
      'financial_authority_recorded', true
    );
  END IF;

  v_result := public.activate_recurring_entitlement_payment_atomic(
    p_user_id, p_stripe_customer_id, p_stripe_subscription_id,
    p_stripe_invoice_id, p_stripe_payment_intent_id, p_stripe_charge_id,
    p_plan, p_amount_paid, p_currency, p_period_start, p_period_end,
    p_payment_status, v_effective_status
  );
  UPDATE public.stripe_b2c_recurring_activations
  SET outcome = COALESCE(v_result ->> 'status', 'invalid_result'),
      activation_committed_at = CASE
        WHEN v_result ->> 'status' IN ('activated', 'already_activated')
        THEN COALESCE(activation_committed_at, pg_catalog.clock_timestamp())
        ELSE activation_committed_at
      END
  WHERE livemode = p_livemode
    AND source_event_id = p_source_event_id;

  IF v_result ->> 'status' IN ('activated', 'already_activated') THEN
    -- A newer exact paid authority supersedes every older state-only snapshot
    -- for this Stripe Subscription.  Leaving an already-applied terminal row
    -- authoritative would make the terminal barrier reject later legitimate
    -- active/past_due observations even though the newer Invoice established a
    -- fresh paid period.  Compare signed Stripe time only; same-second ordering
    -- remains fail-closed and is intentionally not guessed here.
    UPDATE public.stripe_subscription_state_events AS state_event
    SET outcome = 'stale'
    WHERE state_event.livemode = p_livemode
      AND state_event.stripe_subscription_id = p_stripe_subscription_id
      AND state_event.user_id = p_user_id
      AND state_event.stripe_customer_id = p_stripe_customer_id
      AND state_event.event_created_at < p_source_event_created_at
      AND state_event.outcome NOT IN ('manual_review', 'identity_conflict');
  END IF;

  IF v_result ->> 'status' IN (
    'activated', 'already_activated', 'stripe_status_not_entitling'
  ) THEN
    v_drain := public.drain_pending_b2c_subscription_events_atomic(
      p_user_id, p_stripe_customer_id, p_stripe_subscription_id,
      p_stripe_price_id, p_plan, p_amount_paid, p_currency, p_livemode
    );
    IF v_drain ->> 'status' = 'manual_review' THEN
      RAISE EXCEPTION 'pending subscription identity changed after recurring activation';
    END IF;
    IF v_drain ->> 'status' = 'terminal_without_projection' THEN
      UPDATE public.pro_membership_checkout_reservations AS reservation
      SET status = 'retired',
          released_at = COALESCE(released_at, pg_catalog.clock_timestamp()),
          updated_at = pg_catalog.clock_timestamp()
      WHERE reservation.user_id = p_user_id
        AND reservation.livemode = p_livemode
        AND reservation.stripe_customer_id = p_stripe_customer_id
        AND reservation.stripe_subscription_id = p_stripe_subscription_id
        AND reservation.stripe_price_id = p_stripe_price_id
        AND reservation.pro_plan = p_plan
        AND reservation.unit_amount = p_amount_paid
        AND reservation.currency = p_currency
        AND reservation.status = 'converted';
    END IF;
    RETURN v_result || pg_catalog.jsonb_build_object(
      'pending_state', v_drain,
      'financial_authority_recorded', true
    );
  END IF;
  RETURN v_result;
END
$function$;

ALTER FUNCTION public.activate_b2c_recurring_payment_atomic(
  uuid, text, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, text, text, timestamptz, boolean, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.activate_b2c_recurring_trial_atomic(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_plan text,
  p_expected_amount bigint,
  p_currency text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_stripe_subscription_status text,
  p_source_event_id text,
  p_source_event_created_at timestamptz,
  p_livemode boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_profile_exists boolean := false;
  v_subject_billable boolean := false;
  v_subject_active boolean := false;
  v_billing_surface_blocked boolean := false;
  v_frozen_recovery_target boolean := false;
  v_result jsonb;
  v_drain jsonb;
  v_reservation jsonb;
  v_observation jsonb;
  v_effective_status text;
  v_same_second_stricter_status text;
  v_trial public.stripe_trial_entitlements%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_source_event_id IS NULL
    OR p_source_event_id IS DISTINCT FROM pg_catalog.btrim(p_source_event_id)
    OR p_source_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_source_event_id) > 255
    OR p_source_event_created_at IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_expected_amount <= 0
    OR p_currency !~ '^[a-z]{3}$'
    OR p_stripe_subscription_status NOT IN (
      'active', 'trialing', 'past_due', 'canceled', 'unpaid',
      'incomplete', 'incomplete_expired', 'paused'
    )
    OR p_period_start IS NULL
    OR p_period_end IS DISTINCT FROM p_period_start + interval '7 days'
  THEN
    RAISE EXCEPTION 'recurring trial event identity is invalid' USING ERRCODE = '22023';
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
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-customer-owner:' || p_stripe_customer_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-membership-stripe-subscription:' || p_livemode::text || ':' || p_stripe_subscription_id,
      0
    )
  );

  SELECT profile.* INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  v_profile_exists := FOUND;
  v_billing_surface_blocked :=
    public.account_recovery_billing_surface_is_blocked_v2(p_user_id);
  v_frozen_recovery_target := v_billing_surface_blocked
    AND public.account_recovery_frozen_b2c_trial_target_matches_v2(
      p_user_id,
      p_livemode,
      p_stripe_customer_id,
      p_stripe_subscription_id,
      p_stripe_price_id,
      p_plan,
      p_expected_amount,
      p_currency,
      p_period_start,
      p_period_end
    );
  v_subject_billable := v_profile_exists
    AND v_profile.deleted_at IS NULL
    AND NOT v_billing_surface_blocked;
  v_subject_active := v_profile_exists
    AND v_profile.deleted_at IS NULL
    AND v_profile.banned_at IS NULL
    AND NOT (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > pg_catalog.statement_timestamp()
      )
    )
    AND NOT v_billing_surface_blocked;
  IF v_profile_exists
    AND v_profile.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
  THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription', p_stripe_subscription_id,
      p_user_id,
      'b2c_recurring_trial_owner_conflict',
      'A recurring trial did not match the exact local Stripe Customer owner.',
      pg_catalog.jsonb_build_object(
        'source_event_id', p_source_event_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'owner_conflict');
  END IF;
  IF NOT v_profile_exists
    AND NOT public.has_b2c_recurring_financial_owner_atomic(
      p_user_id, p_stripe_customer_id, p_stripe_subscription_id, p_livemode
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.pro_membership_checkout_reservations AS reservation
      WHERE reservation.user_id = p_user_id
        AND reservation.livemode = p_livemode
        AND reservation.stripe_customer_id = p_stripe_customer_id
        AND reservation.stripe_price_id = p_stripe_price_id
        AND reservation.pro_plan = p_plan
        AND reservation.unit_amount = p_expected_amount
        AND reservation.currency = p_currency
        AND reservation.status = 'bound'
        AND reservation.checkout_session_id IS NOT NULL
        AND reservation.stripe_subscription_id IS NULL
    )
  THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription', p_stripe_subscription_id, NULL,
      'b2c_recurring_trial_owner_conflict',
      'A recurring trial had no eligible profile or exact durable financial owner.',
      pg_catalog.jsonb_build_object(
        'opaque_owner_user_id', p_user_id,
        'source_event_id', p_source_event_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'owner_conflict');
  END IF;

  IF v_subject_billable THEN
    v_reservation := public.check_b2c_activation_reservation_atomic(
      p_user_id, p_livemode, p_stripe_customer_id, p_stripe_subscription_id,
      p_stripe_price_id, p_plan, p_expected_amount, p_currency
    );
    IF v_reservation ->> 'status' = 'manual_review' THEN
      RETURN v_reservation;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_trial_entitlements AS trial
    WHERE trial.user_id = p_user_id
      AND NOT (
        trial.stripe_subscription_id = p_stripe_subscription_id
        AND trial.stripe_customer_id = p_stripe_customer_id
        AND trial.plan = p_plan
        AND trial.period_start = p_period_start
        AND trial.period_end = p_period_end
      )
  ) THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription', p_stripe_subscription_id, p_user_id,
      'b2c_recurring_trial_reuse_blocked',
      'A user with durable trial history attempted another Stripe trial.',
      pg_catalog.jsonb_build_object(
        'source_event_id', p_source_event_id,
        'customer_id', p_stripe_customer_id,
        'period_start', p_period_start,
        'period_end', p_period_end
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  v_observation := public.observe_b2c_recurring_activation_atomic(
    'trial', p_user_id, p_stripe_customer_id, p_stripe_subscription_id,
    p_stripe_price_id, p_plan, p_expected_amount, p_currency,
    p_period_start, p_period_end, p_stripe_subscription_status,
    p_source_event_id, p_source_event_created_at, p_livemode
  );
  IF v_observation ->> 'status' = 'identity_conflict' THEN
    RETURN v_observation;
  END IF;
  v_effective_status := v_observation ->> 'effective_subscription_status';
  IF v_effective_status NOT IN (
    'active', 'trialing', 'past_due', 'canceled', 'unpaid',
    'incomplete', 'incomplete_expired', 'paused'
  ) THEN
    RAISE EXCEPTION 'trial activation observation returned an invalid effective status';
  END IF;

  SELECT state_event.stripe_status
  INTO v_same_second_stricter_status
  FROM public.stripe_subscription_state_events AS state_event
  WHERE state_event.livemode = p_livemode
    AND state_event.user_id = p_user_id
    AND state_event.stripe_customer_id = p_stripe_customer_id
    AND state_event.stripe_subscription_id = p_stripe_subscription_id
    AND state_event.plan = p_plan
    AND state_event.period_start = p_period_start
    AND state_event.period_end = p_period_end
    AND state_event.event_created_at = p_source_event_created_at
    AND state_event.stripe_status IN (
      'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused'
    )
    AND state_event.outcome IN (
      'applied', 'inactive_terminal_applied', 'terminal_without_projection',
      'equivalent'
    )
  ORDER BY state_event.event_id
  LIMIT 1;
  IF v_same_second_stricter_status IS NOT NULL THEN
    v_effective_status := v_same_second_stricter_status;
  END IF;

  IF v_frozen_recovery_target THEN
    UPDATE public.stripe_b2c_recurring_activations
    SET outcome = 'recovery_target_observed'
    WHERE livemode = p_livemode
      AND source_event_id = p_source_event_id;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'recovery_target_observed',
      'financial_observation_recorded', true
    );
  END IF;

  IF NOT v_subject_billable THEN
    -- A deleted account can still have an exact converted Checkout/trial
    -- authority.  Consume it durably so deletion cannot reset the one-trial
    -- barrier, but keep it revoked regardless of the mutable Stripe status.
    INSERT INTO public.stripe_trial_entitlements (
      user_id, stripe_customer_id, stripe_subscription_id, plan,
      period_start, period_end, verified_at, revoked_at, revoke_reason
    ) VALUES (
      p_user_id, p_stripe_customer_id, p_stripe_subscription_id, p_plan,
      p_period_start, p_period_end, pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp(), CASE
        WHEN v_billing_surface_blocked AND v_profile_exists
        THEN 'account_recovery_billing_blocked'
        ELSE 'checkout_trial_consumed_subject_deleted'
      END
    )
    ON CONFLICT (stripe_subscription_id, period_start, period_end) DO NOTHING;

    SELECT trial.* INTO v_trial
    FROM public.stripe_trial_entitlements AS trial
    WHERE trial.stripe_subscription_id = p_stripe_subscription_id
      AND trial.period_start = p_period_start
      AND trial.period_end = p_period_end
    FOR UPDATE;
    IF NOT FOUND
      OR v_trial.user_id IS DISTINCT FROM p_user_id
      OR v_trial.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_trial.plan IS DISTINCT FROM p_plan
    THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
        'subscription', p_stripe_subscription_id, NULL,
        'b2c_terminal_trial_identity_conflict',
        'A deleted-subject Checkout trial conflicted with durable trial identity.',
        pg_catalog.jsonb_build_object(
          'opaque_owner_user_id', p_user_id,
          'source_event_id', p_source_event_id
        )
      );
      UPDATE public.stripe_b2c_recurring_activations
      SET outcome = 'identity_conflict'
      WHERE livemode = p_livemode
        AND source_event_id = p_source_event_id;
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    UPDATE public.stripe_trial_entitlements
    SET revoked_at = COALESCE(revoked_at, pg_catalog.clock_timestamp()),
        revoke_reason = COALESCE(
          revoke_reason,
          CASE
            WHEN v_billing_surface_blocked AND v_profile_exists
            THEN 'account_recovery_billing_blocked'
            ELSE 'checkout_trial_consumed_subject_deleted'
          END
        ),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_trial.id;

    IF v_billing_surface_blocked AND v_profile_exists THEN
      INSERT INTO public.stripe_entitlement_effects (
        entitlement_payment_id,
        user_id,
        source_kind,
        source_key,
        operation_key,
        effect_type,
        payload
      ) VALUES (
        NULL,
        p_user_id,
        'trial',
        'trial:' || v_trial.id::text,
        'cancel:subscription:' || p_stripe_subscription_id,
        'stripe_subscription_cancel',
        pg_catalog.jsonb_build_object(
          'stripe_subscription_id', p_stripe_subscription_id,
          'stripe_customer_id', p_stripe_customer_id,
          'reason', 'account_recovery_billing_blocked',
          'protocol_version', 'dispatch_commit_v1'
        )
      )
      ON CONFLICT (
        source_kind,
        source_key,
        effect_type,
        operation_key
      ) DO NOTHING;
    END IF;

    UPDATE public.stripe_b2c_recurring_activations
    SET outcome = CASE
          WHEN v_billing_surface_blocked AND v_profile_exists
          THEN 'billing_blocked_trial'
          ELSE 'terminal_trial_recorded'
        END
    WHERE livemode = p_livemode
      AND source_event_id = p_source_event_id;

    UPDATE public.pro_membership_checkout_reservations AS reservation
    SET status = 'retired',
        released_at = COALESCE(released_at, pg_catalog.clock_timestamp()),
        updated_at = pg_catalog.clock_timestamp()
    WHERE reservation.user_id = p_user_id
      AND reservation.livemode = p_livemode
      AND reservation.stripe_customer_id = p_stripe_customer_id
      AND reservation.stripe_subscription_id = p_stripe_subscription_id
      AND reservation.stripe_price_id = p_stripe_price_id
      AND reservation.pro_plan = p_plan
      AND reservation.unit_amount = p_expected_amount
      AND reservation.currency = p_currency
      AND reservation.status = 'converted';

    RETURN pg_catalog.jsonb_build_object(
      'status', CASE
        WHEN v_billing_surface_blocked AND v_profile_exists
        THEN 'billing_blocked_trial'
        ELSE 'terminal_trial_recorded'
      END,
      'subject_deleted', NOT v_profile_exists
    );
  END IF;

  IF v_effective_status = 'trialing' THEN
    v_result := public.activate_recurring_trial_entitlement_atomic(
      p_user_id, p_stripe_customer_id, p_stripe_subscription_id,
      p_plan, p_period_start, p_period_end, v_effective_status
    );
  ELSE
    INSERT INTO public.stripe_trial_entitlements (
      user_id, stripe_customer_id, stripe_subscription_id, plan,
      period_start, period_end, verified_at, revoked_at, revoke_reason
    ) VALUES (
      p_user_id, p_stripe_customer_id, p_stripe_subscription_id, p_plan,
      p_period_start, p_period_end, pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp(), 'checkout_trial_consumed_without_grant'
    )
    ON CONFLICT (stripe_subscription_id, period_start, period_end) DO NOTHING;

    SELECT trial.* INTO v_trial
    FROM public.stripe_trial_entitlements AS trial
    WHERE trial.stripe_subscription_id = p_stripe_subscription_id
      AND trial.period_start = p_period_start
      AND trial.period_end = p_period_end
    FOR UPDATE;
    IF NOT FOUND
      OR v_trial.user_id IS DISTINCT FROM p_user_id
      OR v_trial.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_trial.plan IS DISTINCT FROM p_plan
    THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
        'subscription', p_stripe_subscription_id, p_user_id,
        'b2c_terminal_trial_identity_conflict',
        'A terminal Checkout trial conflicted with durable trial identity.',
        pg_catalog.jsonb_build_object('source_event_id', p_source_event_id)
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    UPDATE public.stripe_trial_entitlements
    SET revoked_at = COALESCE(revoked_at, pg_catalog.clock_timestamp()),
        revoke_reason = COALESCE(revoke_reason, 'checkout_trial_consumed_without_grant'),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_trial.id;
    v_result := pg_catalog.jsonb_build_object('status', 'terminal_trial_recorded');
  END IF;

  UPDATE public.stripe_b2c_recurring_activations
  SET outcome = COALESCE(v_result ->> 'status', 'invalid_result'),
      activation_committed_at = CASE
        WHEN v_result ->> 'status' IN ('activated', 'already_activated')
        THEN COALESCE(activation_committed_at, pg_catalog.clock_timestamp())
        ELSE activation_committed_at
      END
  WHERE livemode = p_livemode
    AND source_event_id = p_source_event_id;

  IF v_result ->> 'status' IN ('activated', 'already_activated') THEN
    -- The exact trial activation is also a newer authority episode.  Retire
    -- only strictly older signed state observations; second-resolution ties
    -- stay ambiguous and therefore fail closed in the state reconciler.
    UPDATE public.stripe_subscription_state_events AS state_event
    SET outcome = 'stale'
    WHERE state_event.livemode = p_livemode
      AND state_event.stripe_subscription_id = p_stripe_subscription_id
      AND state_event.user_id = p_user_id
      AND state_event.stripe_customer_id = p_stripe_customer_id
      AND state_event.event_created_at < p_source_event_created_at
      AND state_event.outcome NOT IN ('manual_review', 'identity_conflict');
  END IF;

  IF v_result ->> 'status' IN (
    'activated', 'already_activated', 'terminal_trial_recorded'
  ) THEN
    v_drain := public.drain_pending_b2c_subscription_events_atomic(
      p_user_id, p_stripe_customer_id, p_stripe_subscription_id,
      p_stripe_price_id, p_plan, p_expected_amount, p_currency, p_livemode
    );
    IF v_drain ->> 'status' = 'manual_review' THEN
      RAISE EXCEPTION 'pending subscription identity changed after trial activation';
    END IF;
    IF v_drain ->> 'status' = 'terminal_without_projection' THEN
      UPDATE public.pro_membership_checkout_reservations AS reservation
      SET status = 'retired',
          released_at = COALESCE(released_at, pg_catalog.clock_timestamp()),
          updated_at = pg_catalog.clock_timestamp()
      WHERE reservation.user_id = p_user_id
        AND reservation.livemode = p_livemode
        AND reservation.stripe_customer_id = p_stripe_customer_id
        AND reservation.stripe_subscription_id = p_stripe_subscription_id
        AND reservation.stripe_price_id = p_stripe_price_id
        AND reservation.pro_plan = p_plan
        AND reservation.unit_amount = p_expected_amount
        AND reservation.currency = p_currency
        AND reservation.status = 'converted';
    END IF;
    RETURN v_result || pg_catalog.jsonb_build_object('pending_state', v_drain);
  END IF;
  RETURN v_result;
END
$function$;

ALTER FUNCTION public.activate_b2c_recurring_trial_atomic(
  uuid, text, text, text, text, bigint, text, timestamptz, timestamptz, text,
  text, timestamptz, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.activate_and_reconcile_b2c_recurring_trial_event_atomic(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_current_invoice_id text,
  p_plan text,
  p_expected_amount bigint,
  p_currency text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_stripe_status text,
  p_cancel_at_period_end boolean,
  p_canceled_at timestamptz,
  p_grace_expires_at timestamptz,
  p_event_id text,
  p_event_created_at timestamptz,
  p_livemode boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_subject_active boolean := false;
  v_activation jsonb;
  v_result jsonb;
  v_has_converted_authority boolean := false;
  v_has_trial_authority boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_event_id IS NULL
    OR p_event_id IS DISTINCT FROM pg_catalog.btrim(p_event_id)
    OR p_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_event_id) > 255
    OR p_event_created_at IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR (
      p_current_invoice_id IS NOT NULL
      AND (
        p_current_invoice_id IS DISTINCT FROM pg_catalog.btrim(p_current_invoice_id)
        OR p_current_invoice_id !~ '^in_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_current_invoice_id) > 255
      )
    )
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_expected_amount <= 0
    OR p_currency !~ '^[a-z]{3}$'
    OR p_period_start IS NULL
    OR p_period_end IS DISTINCT FROM p_period_start + interval '7 days'
    OR p_stripe_status NOT IN (
      'active', 'trialing', 'past_due', 'canceled', 'unpaid',
      'incomplete', 'incomplete_expired', 'paused'
    )
    OR p_cancel_at_period_end IS NULL
  THEN
    RAISE EXCEPTION 'trial subscription state identity is invalid' USING ERRCODE = '22023';
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
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-customer-owner:' || p_stripe_customer_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-membership-stripe-subscription:' || p_livemode::text || ':' || p_stripe_subscription_id,
      0
    )
  );

  SELECT profile.* INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_profile.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription_event', p_event_id,
      CASE WHEN FOUND THEN p_user_id ELSE NULL END,
      'b2c_recurring_trial_owner_conflict',
      'A recurring trial did not match the exact local Stripe Customer owner.',
      pg_catalog.jsonb_build_object('subscription_id', p_stripe_subscription_id)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'owner_conflict');
  END IF;
  v_subject_active := v_profile.deleted_at IS NULL
    AND v_profile.banned_at IS NULL
    AND NOT (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > pg_catalog.statement_timestamp()
      )
    )
    AND NOT public.account_recovery_billing_surface_is_blocked_v2(p_user_id);

  PERFORM 1
  FROM public.pro_membership_checkout_reservations AS reservation
  WHERE reservation.livemode = p_livemode
    AND reservation.status IN ('reserved', 'bound', 'converted')
    AND (
      reservation.user_id = p_user_id
      OR reservation.stripe_customer_id = p_stripe_customer_id
    )
  FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM public.pro_membership_checkout_reservations AS reservation
    WHERE reservation.livemode = p_livemode
      AND reservation.status IN ('reserved', 'bound', 'converted')
      AND (
        reservation.user_id = p_user_id
        OR reservation.stripe_customer_id = p_stripe_customer_id
      )
      AND (
        reservation.user_id IS DISTINCT FROM p_user_id
        OR reservation.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
        OR reservation.stripe_price_id IS DISTINCT FROM p_stripe_price_id
        OR reservation.pro_plan IS DISTINCT FROM p_plan
        OR reservation.unit_amount IS DISTINCT FROM p_expected_amount
        OR reservation.currency IS DISTINCT FROM p_currency
        OR (
          reservation.status = 'converted'
          AND reservation.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id
        )
      )
  ) THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'subscription_event', p_event_id, p_user_id,
      'b2c_trial_reservation_identity_conflict',
      'A signed trial state conflicted with the active Checkout reservation identity.',
      pg_catalog.jsonb_build_object(
        'subscription_id', p_stripe_subscription_id,
        'price_id', p_stripe_price_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.pro_membership_checkout_reservations AS reservation
    WHERE reservation.user_id = p_user_id
      AND reservation.livemode = p_livemode
      AND reservation.stripe_customer_id = p_stripe_customer_id
      AND reservation.stripe_subscription_id = p_stripe_subscription_id
      AND reservation.stripe_price_id = p_stripe_price_id
      AND reservation.pro_plan = p_plan
      AND reservation.unit_amount = p_expected_amount
      AND reservation.currency = p_currency
      AND reservation.status = 'converted'
      AND reservation.trial_days = 7
      AND reservation.trial_start = pg_catalog.floor(extract(epoch FROM p_period_start))::bigint
      AND reservation.trial_end = pg_catalog.floor(extract(epoch FROM p_period_end))::bigint
  ) INTO v_has_converted_authority;

  SELECT EXISTS (
    SELECT 1
    FROM public.stripe_trial_entitlements AS trial
    WHERE trial.user_id = p_user_id
      AND trial.stripe_customer_id = p_stripe_customer_id
      AND trial.stripe_subscription_id = p_stripe_subscription_id
      AND trial.plan = p_plan
      AND trial.period_start = p_period_start
      AND trial.period_end = p_period_end
  ) INTO v_has_trial_authority;

  v_result := public.reconcile_b2c_subscription_event_atomic(
    p_user_id, p_stripe_customer_id, p_stripe_subscription_id,
    p_stripe_price_id, p_current_invoice_id, p_plan,
    p_expected_amount, p_currency, p_period_start, p_period_end, p_stripe_status,
    p_cancel_at_period_end, p_canceled_at, p_grace_expires_at,
    p_event_id, p_event_created_at, p_livemode
  );
  IF v_result ->> 'status' IN ('identity_conflict', 'manual_review', 'owner_conflict') THEN
    RETURN v_result;
  END IF;
  IF v_result ->> 'status' = 'inactive_subject' THEN
    RETURN v_result;
  END IF;

  IF NOT v_has_converted_authority AND NOT v_has_trial_authority THEN
    RETURN v_result;
  END IF;

  IF v_has_trial_authority AND NOT v_has_converted_authority THEN
    v_activation := public.drain_pending_b2c_subscription_events_atomic(
      p_user_id, p_stripe_customer_id, p_stripe_subscription_id,
      p_stripe_price_id, p_plan, p_expected_amount, p_currency, p_livemode
    );
    RETURN v_result || pg_catalog.jsonb_build_object(
      'trial_activation_status', 'already_recorded',
      'pending_state', v_activation
    );
  END IF;

  v_activation := public.activate_b2c_recurring_trial_atomic(
    p_user_id, p_stripe_customer_id, p_stripe_subscription_id,
    p_stripe_price_id, p_plan, p_expected_amount, p_currency,
    p_period_start, p_period_end, p_stripe_status,
    p_event_id, p_event_created_at, p_livemode
  );
  RETURN v_result || pg_catalog.jsonb_build_object(
    'trial_activation_status', v_activation ->> 'status',
    'pending_state', v_activation -> 'pending_state'
  );

END
$function$;

ALTER FUNCTION public.activate_and_reconcile_b2c_recurring_trial_event_atomic(
  uuid, text, text, text, text, text, bigint, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.apply_b2c_recurring_invoice_event_atomic(
  p_event_id text,
  p_event_created_at timestamptz,
  p_livemode boolean,
  p_event_type text,
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_stripe_invoice_id text,
  p_stripe_invoice_payment_id text,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_stripe_price_id text,
  p_plan text,
  p_amount bigint,
  p_currency text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_payment_status text,
  p_stripe_subscription_status text,
  p_next_payment_attempt timestamptz,
  p_financial_only boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_profile_exists boolean := false;
  v_subject_active boolean := false;
  v_existing public.stripe_b2c_invoice_events%ROWTYPE;
  v_history public.payment_history%ROWTYPE;
  v_result jsonb;
  v_outcome text;
  v_effective_subscription_status text;
  v_reprocess_existing boolean := false;
  v_existing_state_rank integer;
  v_incoming_state_rank integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_financial_only IS NULL
    OR p_event_id IS NULL
    OR p_event_id IS DISTINCT FROM pg_catalog.btrim(p_event_id)
    OR p_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_event_id) > 255
    OR p_event_created_at IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_stripe_invoice_id IS NULL
    OR p_stripe_invoice_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_invoice_id)
    OR p_stripe_invoice_id !~ '^in_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_invoice_id) > 255
    OR (
      p_stripe_invoice_payment_id IS NOT NULL
      AND (
        p_stripe_invoice_payment_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_invoice_payment_id)
        OR p_stripe_invoice_payment_id !~ '^inpay_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_stripe_invoice_payment_id) > 255
      )
    )
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND (
        p_stripe_payment_intent_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_payment_intent_id)
        OR p_stripe_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_stripe_payment_intent_id) > 255
      )
    )
    OR (
      p_stripe_charge_id IS NOT NULL
      AND (
        p_stripe_charge_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_charge_id)
        OR p_stripe_charge_id !~ '^ch_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_stripe_charge_id) > 255
      )
    )
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_amount <= 0
    OR p_currency !~ '^[a-z]{3}$'
    OR p_period_start IS NULL
    OR p_period_end IS NULL
    OR p_period_end <= p_period_start
    OR p_stripe_subscription_status NOT IN (
      'active', 'trialing', 'past_due', 'canceled', 'unpaid',
      'incomplete', 'incomplete_expired', 'paused'
    )
    OR (
      p_event_type IN ('invoice.paid', 'invoice.payment_succeeded')
      AND (
        p_payment_status <> 'succeeded'
        OR p_stripe_invoice_payment_id !~ '^inpay_[A-Za-z0-9_]+$'
        OR p_stripe_charge_id !~ '^ch_[A-Za-z0-9_]+$'
        OR p_next_payment_attempt IS NOT NULL
      )
    )
    OR (
      p_event_type = 'invoice.payment_failed'
      AND (
        p_payment_status <> 'failed'
        OR p_stripe_invoice_payment_id IS NOT NULL
        OR p_stripe_payment_intent_id IS NOT NULL
        OR p_stripe_charge_id IS NOT NULL
      )
    )
    OR (
      p_event_type = 'trial_zero_invoice'
      AND (
        p_payment_status <> 'trial_zero'
        OR p_stripe_invoice_payment_id IS NOT NULL
        OR p_stripe_payment_intent_id IS NOT NULL
        OR p_stripe_charge_id IS NOT NULL
        OR p_next_payment_attempt IS NOT NULL
      )
    )
    OR p_event_type NOT IN (
      'invoice.paid', 'invoice.payment_succeeded', 'invoice.payment_failed',
      'trial_zero_invoice'
    )
  THEN
    RAISE EXCEPTION 'B2C recurring invoice event identity is invalid' USING ERRCODE = '22023';
  END IF;
  v_effective_subscription_status := p_stripe_subscription_status;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-lifetime-seat-capacity', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  IF p_stripe_charge_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('stripe-charge-refund:' || p_stripe_charge_id, 0)
    );
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-customer-owner:' || p_stripe_customer_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-membership-stripe-subscription:' || p_livemode::text || ':' || p_stripe_subscription_id,
      0
    )
  );

  SELECT profile.* INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  v_profile_exists := FOUND;
  v_subject_active := v_profile_exists
    AND v_profile.deleted_at IS NULL
    AND v_profile.banned_at IS NULL
    AND NOT (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > pg_catalog.statement_timestamp()
      )
    )
    AND NOT public.account_recovery_billing_surface_is_blocked_v2(p_user_id);
  IF v_profile_exists
    AND v_profile.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
  THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'invoice', p_stripe_invoice_id,
      p_user_id,
      'b2c_invoice_owner_conflict',
      'A signed Invoice event did not match the exact local Stripe Customer owner.',
      pg_catalog.jsonb_build_object('event_id', p_event_id, 'livemode', p_livemode)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'owner_conflict');
  END IF;
  IF p_financial_only AND v_subject_active THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'invoice', p_stripe_invoice_id, p_user_id,
      'b2c_financial_only_subject_reactivated',
      'A financial-only deleted-subject Invoice found an eligible live profile and was not granted.',
      pg_catalog.jsonb_build_object(
        'event_id', p_event_id,
        'subscription_id', p_stripe_subscription_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'owner_conflict');
  END IF;
  IF NOT v_profile_exists
    AND NOT public.has_b2c_recurring_financial_owner_atomic(
      p_user_id, p_stripe_customer_id, p_stripe_subscription_id, p_livemode
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.pro_membership_checkout_reservations AS reservation
      WHERE reservation.user_id = p_user_id
        AND reservation.livemode = p_livemode
        AND reservation.stripe_customer_id = p_stripe_customer_id
        AND reservation.stripe_price_id = p_stripe_price_id
        AND reservation.pro_plan = p_plan
        AND reservation.unit_amount = p_amount
        AND reservation.currency = p_currency
        AND reservation.status = 'bound'
        AND reservation.checkout_session_id IS NOT NULL
        AND reservation.stripe_subscription_id IS NULL
    )
  THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'invoice', p_stripe_invoice_id, NULL,
      'b2c_invoice_owner_conflict',
      'A signed Invoice event had no eligible profile or exact durable financial owner.',
      pg_catalog.jsonb_build_object(
        'opaque_owner_user_id', p_user_id,
        'event_id', p_event_id,
        'subscription_id', p_stripe_subscription_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'owner_conflict');
  END IF;

  IF p_event_type = 'trial_zero_invoice'
    AND NOT (
      EXISTS (
        SELECT 1
        FROM public.pro_membership_checkout_reservations AS reservation
        WHERE reservation.user_id = p_user_id
          AND reservation.livemode = p_livemode
          AND reservation.stripe_customer_id = p_stripe_customer_id
          AND reservation.stripe_price_id = p_stripe_price_id
          AND reservation.pro_plan = p_plan
          AND reservation.unit_amount = p_amount
          AND reservation.currency = p_currency
          AND reservation.trial_days = 7
          AND (
            reservation.status = 'bound'
            OR (
              reservation.status IN ('converted', 'retired')
              AND reservation.stripe_subscription_id = p_stripe_subscription_id
              AND reservation.trial_start =
                pg_catalog.floor(extract(epoch FROM p_period_start))::bigint
              AND reservation.trial_end =
                pg_catalog.floor(extract(epoch FROM p_period_end))::bigint
            )
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.stripe_b2c_recurring_activations AS activation
        WHERE activation.user_id = p_user_id
          AND activation.livemode = p_livemode
          AND activation.authority_kind = 'trial'
          AND activation.stripe_customer_id = p_stripe_customer_id
          AND activation.stripe_subscription_id = p_stripe_subscription_id
          AND activation.stripe_price_id = p_stripe_price_id
          AND activation.plan = p_plan
          AND activation.expected_amount = p_amount
          AND activation.currency = p_currency
          AND activation.period_start = p_period_start
          AND activation.period_end = p_period_end
          AND (
            activation.activation_committed_at IS NOT NULL
            OR activation.outcome = 'terminal_trial_recorded'
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.stripe_trial_entitlements AS trial
        WHERE trial.user_id = p_user_id
          AND trial.stripe_customer_id = p_stripe_customer_id
          AND trial.stripe_subscription_id = p_stripe_subscription_id
          AND trial.plan = p_plan
          AND trial.period_start = p_period_start
          AND trial.period_end = p_period_end
      )
    )
  THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
      'invoice', p_stripe_invoice_id,
      CASE WHEN v_subject_active THEN p_user_id ELSE NULL END,
      'b2c_trial_zero_invoice_without_authority',
      'A zero-dollar trial Invoice had no exact Checkout or durable trial authority.',
      pg_catalog.jsonb_build_object(
        'opaque_owner_user_id', p_user_id,
        'event_id', p_event_id,
        'subscription_id', p_stripe_subscription_id,
        'price_id', p_stripe_price_id,
        'period_start', p_period_start,
        'period_end', p_period_end,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  SELECT invoice_event.* INTO v_existing
  FROM public.stripe_b2c_invoice_events AS invoice_event
  WHERE invoice_event.event_id = p_event_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.event_created_at IS DISTINCT FROM p_event_created_at
      OR v_existing.livemode IS DISTINCT FROM p_livemode
      OR v_existing.event_type IS DISTINCT FROM p_event_type
      OR v_existing.user_id IS DISTINCT FROM p_user_id
      OR v_existing.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_existing.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id
      OR v_existing.stripe_invoice_id IS DISTINCT FROM p_stripe_invoice_id
      OR v_existing.stripe_invoice_payment_id IS DISTINCT FROM p_stripe_invoice_payment_id
      OR v_existing.stripe_payment_intent_id IS DISTINCT FROM p_stripe_payment_intent_id
      OR v_existing.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
      OR v_existing.stripe_price_id IS DISTINCT FROM p_stripe_price_id
      OR v_existing.plan IS DISTINCT FROM p_plan
      OR v_existing.amount IS DISTINCT FROM p_amount
      OR v_existing.currency IS DISTINCT FROM p_currency
      OR v_existing.period_start IS DISTINCT FROM p_period_start
      OR v_existing.period_end IS DISTINCT FROM p_period_end
      OR v_existing.payment_status IS DISTINCT FROM p_payment_status
      OR v_existing.next_payment_attempt IS DISTINCT FROM p_next_payment_attempt
    THEN
    PERFORM public.record_b2c_recurring_manual_review_atomic(
        'invoice_event', p_event_id, p_user_id,
        'b2c_invoice_event_identity_conflict',
        'A Stripe Invoice event id was replayed with changed immutable identity.',
        pg_catalog.jsonb_build_object('invoice_id', p_stripe_invoice_id)
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    -- The signed Invoice payload is immutable, but this status comes from a
    -- fresh Subscription read performed while handling that payload. Replays
    -- may tighten active/trialing -> past_due -> terminal, but may never move
    -- in the entitlement-increasing direction.
    v_existing_state_rank := CASE
      WHEN v_existing.stripe_subscription_status IN ('active', 'trialing') THEN 0
      WHEN v_existing.stripe_subscription_status = 'past_due' THEN 1
      ELSE 2
    END;
    v_incoming_state_rank := CASE
      WHEN p_stripe_subscription_status IN ('active', 'trialing') THEN 0
      WHEN p_stripe_subscription_status = 'past_due' THEN 1
      ELSE 2
    END;

    IF v_incoming_state_rank > v_existing_state_rank THEN
      UPDATE public.stripe_b2c_invoice_events
      SET stripe_subscription_status = p_stripe_subscription_status,
          outcome = 'observed'
      WHERE event_id = p_event_id;
      v_effective_subscription_status := p_stripe_subscription_status;
      v_reprocess_existing := true;
    ELSIF v_incoming_state_rank = v_existing_state_rank
      AND v_existing.stripe_subscription_status
        IS DISTINCT FROM p_stripe_subscription_status
    THEN
      PERFORM public.record_b2c_recurring_manual_review_atomic(
        'invoice_event', p_event_id, p_user_id,
        'b2c_invoice_observation_rank_conflict',
        'Fresh reads for one Invoice event returned different equal-rank Subscription states; the existing fail-closed observation was preserved.',
        pg_catalog.jsonb_build_object(
          'invoice_id', p_stripe_invoice_id,
          'existing_status', v_existing.stripe_subscription_status,
          'incoming_status', p_stripe_subscription_status,
          'livemode', p_livemode
        )
      );
      RETURN pg_catalog.jsonb_build_object(
        'status', 'already_recorded',
        'outcome', v_existing.outcome,
        'effective_subscription_status',
          v_existing.stripe_subscription_status,
        'observation', 'equal_rank_conflict_preserved'
      );
    ELSE
      RETURN pg_catalog.jsonb_build_object(
        'status', 'already_recorded',
        'outcome', v_existing.outcome,
        'effective_subscription_status',
          v_existing.stripe_subscription_status,
        'observation', CASE
          WHEN v_incoming_state_rank < v_existing_state_rank
          THEN 'stricter_barrier_preserved'
          ELSE 'replayed'
        END
      );
    END IF;
  END IF;

  IF NOT v_reprocess_existing THEN
    INSERT INTO public.stripe_b2c_invoice_events (
      event_id, event_created_at, livemode, event_type, user_id,
      stripe_customer_id, stripe_subscription_id, stripe_invoice_id,
      stripe_invoice_payment_id, stripe_payment_intent_id, stripe_charge_id,
      stripe_price_id, plan, amount, currency, period_start, period_end,
      payment_status, stripe_subscription_status, next_payment_attempt
    ) VALUES (
      p_event_id, p_event_created_at, p_livemode, p_event_type, p_user_id,
      p_stripe_customer_id, p_stripe_subscription_id, p_stripe_invoice_id,
      p_stripe_invoice_payment_id, p_stripe_payment_intent_id, p_stripe_charge_id,
      p_stripe_price_id, p_plan, p_amount, p_currency, p_period_start, p_period_end,
      p_payment_status, v_effective_subscription_status, p_next_payment_attempt
    );
  END IF;

  IF p_event_type = 'trial_zero_invoice' THEN
    UPDATE public.stripe_b2c_invoice_events
    SET outcome = 'trial_zero_recorded'
    WHERE event_id = p_event_id;
    RETURN pg_catalog.jsonb_build_object('status', 'trial_zero_recorded');
  END IF;

  SELECT history.* INTO v_history
  FROM public.payment_history AS history
  WHERE history.stripe_invoice_id = p_stripe_invoice_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_history.user_id IS DISTINCT FROM p_user_id
      OR (v_history.stripe_customer_id IS NOT NULL AND v_history.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id)
      OR (v_history.stripe_subscription_id IS NOT NULL AND v_history.stripe_subscription_id IS DISTINCT FROM p_stripe_subscription_id)
      OR (
        p_payment_status = 'succeeded'
        AND v_history.stripe_payment_intent_id IS NOT NULL
        AND v_history.stripe_payment_intent_id IS DISTINCT FROM p_stripe_payment_intent_id
      )
      OR (
        p_payment_status = 'succeeded'
        AND v_history.stripe_invoice_payment_id IS NOT NULL
        AND v_history.stripe_invoice_payment_id IS DISTINCT FROM p_stripe_invoice_payment_id
      )
      OR (
        p_payment_status = 'succeeded'
        AND v_history.stripe_charge_id IS NOT NULL
        AND v_history.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
      )
      OR (v_history.stripe_price_id IS NOT NULL AND v_history.stripe_price_id IS DISTINCT FROM p_stripe_price_id)
      OR (v_history.livemode IS NOT NULL AND v_history.livemode IS DISTINCT FROM p_livemode)
      OR v_history.amount IS DISTINCT FROM p_amount
      OR v_history.currency IS DISTINCT FROM p_currency
    THEN
      UPDATE public.stripe_b2c_invoice_events SET outcome = 'manual_review'
      WHERE event_id = p_event_id;
    PERFORM public.record_b2c_recurring_manual_review_atomic(
        'invoice', p_stripe_invoice_id, p_user_id,
        'b2c_payment_history_identity_conflict',
        'An Invoice event conflicted with immutable payment history.',
        pg_catalog.jsonb_build_object('event_id', p_event_id, 'history_id', v_history.id)
      );
      RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
    END IF;

    IF v_history.status = 'succeeded' AND p_payment_status = 'failed' THEN
      -- Stripe timestamps have one-second precision.  A failed event arriving
      -- after an exact success (including the same second) is observed in the
      -- event ledger but must never downgrade financial history.
      NULL;
    ELSIF (v_history.status = 'failed' AND p_payment_status = 'succeeded')
      OR v_history.stripe_event_created_at IS NULL
      OR p_event_created_at > v_history.stripe_event_created_at
      OR (
        p_event_created_at = v_history.stripe_event_created_at
        AND (
          p_payment_status = v_history.status
          OR (v_history.status = 'failed' AND p_payment_status = 'succeeded')
        )
      )
    THEN
      UPDATE public.payment_history
      SET stripe_payment_intent_id = p_stripe_payment_intent_id,
          stripe_customer_id = p_stripe_customer_id,
          stripe_subscription_id = p_stripe_subscription_id,
          stripe_invoice_payment_id = p_stripe_invoice_payment_id,
          stripe_charge_id = p_stripe_charge_id,
          stripe_price_id = p_stripe_price_id,
          stripe_event_id = p_event_id,
          stripe_event_created_at = p_event_created_at,
          livemode = p_livemode,
          status = p_payment_status,
          created_at = LEAST(created_at, p_event_created_at)
      WHERE id = v_history.id;
    END IF;
  ELSE
    INSERT INTO public.payment_history (
      user_id, stripe_invoice_id, stripe_payment_intent_id, amount,
      currency, status, created_at, stripe_customer_id,
      stripe_subscription_id, stripe_invoice_payment_id, stripe_charge_id,
      stripe_price_id, stripe_event_id, stripe_event_created_at, livemode
    ) VALUES (
      p_user_id, p_stripe_invoice_id, p_stripe_payment_intent_id, p_amount,
      p_currency, p_payment_status, p_event_created_at, p_stripe_customer_id,
      p_stripe_subscription_id, p_stripe_invoice_payment_id, p_stripe_charge_id,
      p_stripe_price_id, p_event_id, p_event_created_at, p_livemode
    );
  END IF;

  IF p_payment_status = 'failed' THEN
    v_outcome := 'failed_recorded';
    UPDATE public.stripe_b2c_invoice_events SET outcome = v_outcome
    WHERE event_id = p_event_id;
    RETURN pg_catalog.jsonb_build_object('status', v_outcome);
  END IF;

  v_result := public.activate_b2c_recurring_payment_atomic(
    p_user_id, p_stripe_customer_id, p_stripe_subscription_id,
    p_stripe_invoice_id, p_stripe_payment_intent_id, p_stripe_charge_id,
    p_stripe_price_id, p_plan, p_amount, p_currency, p_period_start, p_period_end,
    'paid', v_effective_subscription_status,
    p_event_id, p_event_created_at, p_livemode, p_financial_only
  );
  v_outcome := COALESCE(v_result ->> 'status', 'invalid_result');
  IF v_outcome NOT IN (
    'activated', 'already_activated', 'current_entitlement_protected',
    'identity_conflict', 'manual_review', 'parallel_subscription_review',
    'refunded_payment', 'stale_payment', 'stripe_status_not_entitling',
    'subject_deleted', 'owner_conflict', 'billing_blocked_payment',
    'recovery_target_observed'
  ) THEN
    RAISE EXCEPTION 'recurring activation returned unsafe status %', v_outcome;
  END IF;
  UPDATE public.stripe_b2c_invoice_events SET outcome = v_outcome
  WHERE event_id = p_event_id;
  RETURN v_result;
END
$function$;

ALTER FUNCTION public.apply_b2c_recurring_invoice_event_atomic(
  text, timestamptz, boolean, text, uuid, text, text, text, text,
  text, text, text, text, bigint, text, timestamptz, timestamptz,
  text, text, timestamptz, boolean
) OWNER TO postgres;

-- The central ownership predicate predates recovery-period terminal product
-- rows.  Those rows are paid financial ledgers, not grants, and therefore are
-- exact ownership authorities while their refund is pending.
CREATE OR REPLACE FUNCTION public.stripe_payment_ownership_is_exact_v2(
  p_ownership_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT p_ownership_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.stripe_payment_ownerships AS ownership
      WHERE ownership.id = p_ownership_id
        AND (
          (
            ownership.product_kind = 'pro_entitlement'
            AND EXISTS (
              SELECT 1
              FROM public.stripe_entitlement_payments AS payment
              WHERE payment.id = ownership.ledger_id
                AND payment.payment_status IN ('paid', 'succeeded')
                AND payment.user_id IS NOT DISTINCT FROM ownership.owner_user_id
                AND payment.stripe_customer_id = ownership.stripe_customer_id
                AND payment.stripe_payment_intent_id IS NOT DISTINCT FROM
                  ownership.stripe_payment_intent_id
                AND payment.stripe_charge_id = ownership.stripe_charge_id
                AND payment.checkout_session_id IS NOT DISTINCT FROM
                  ownership.checkout_session_id
                AND payment.amount_paid = ownership.amount_paid
                AND payment.currency = ownership.currency
            )
          )
          OR (
            ownership.product_kind = 'tip'
            AND EXISTS (
              SELECT 1
              FROM public.tips AS tip
              WHERE tip.id = ownership.ledger_id
                AND tip.status IN ('completed', 'refunded', 'refund_pending')
                AND tip.from_user_id = ownership.owner_user_id
                AND tip.stripe_customer_id = ownership.stripe_customer_id
                AND tip.stripe_payment_intent_id =
                  ownership.stripe_payment_intent_id
                AND tip.stripe_charge_id = ownership.stripe_charge_id
                AND tip.stripe_checkout_session_id = ownership.checkout_session_id
                AND tip.amount_cents::bigint = ownership.amount_paid
                AND tip.currency = ownership.currency
            )
          )
          OR (
            ownership.product_kind = 'group_pass'
            AND EXISTS (
              SELECT 1
              FROM public.group_payment_consumptions AS consumption
              WHERE consumption.id = ownership.ledger_id
                AND consumption.provider = 'stripe'
                AND consumption.user_id = ownership.owner_user_id
                AND consumption.stripe_customer_id = ownership.stripe_customer_id
                AND consumption.payment_intent_id =
                  ownership.stripe_payment_intent_id
                AND consumption.stripe_charge_id = ownership.stripe_charge_id
                AND consumption.checkout_session_id = ownership.checkout_session_id
                AND ownership.checkout_session_id IS NOT NULL
                AND consumption.amount_cents = ownership.amount_paid
                AND consumption.currency = ownership.currency
                AND (
                  (
                    consumption.outcome IN ('activated', 'renewed')
                    AND consumption.result ->> 'subscription_id' =
                      consumption.subscription_id::text
                    AND consumption.result ->> 'status' IN ('subscribed', 'renewed')
                    AND (
                      (
                        consumption.result ->> 'membership_status' = 'joined'
                        AND consumption.payment_member_joined_at IS NOT NULL
                      )
                      OR (
                        consumption.result ->> 'membership_status' = 'already_member'
                        AND consumption.payment_member_joined_at IS NULL
                      )
                    )
                  )
                  OR (
                    consumption.outcome = 'refund_blocked'
                    AND consumption.result ->> 'subscription_id' =
                      consumption.subscription_id::text
                    AND consumption.result ->> 'status' = 'refund_observed'
                    AND consumption.payment_member_joined_at IS NULL
                  )
                  OR (
                    consumption.outcome = 'billing_blocked_refund_pending'
                    AND consumption.result = pg_catalog.jsonb_build_object(
                      'status', 'refund_pending',
                      'subscription_id', consumption.subscription_id,
                      'idempotent_replay', false
                    )
                    AND consumption.payment_member_joined_at IS NULL
                  )
                )
            )
          )
        )
    )
$function$;

ALTER FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

ALTER FUNCTION public.activate_lifetime_membership_with_identity_atomic(
  uuid, text, text, uuid, text, text, bigint, text, timestamptz, text
) RENAME TO activate_lifetime_membership_with_identity_pre_recovery_v2;
REVOKE ALL ON FUNCTION
  public.activate_lifetime_membership_with_identity_pre_recovery_v2(
    uuid, text, text, uuid, text, text, bigint, text, timestamptz, text
  ) FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.activate_lifetime_membership_with_identity_atomic(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_checkout_session_id text,
  p_reservation_id uuid,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_amount_paid bigint,
  p_currency text,
  p_paid_at timestamptz,
  p_payment_status text,
  p_livemode boolean
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
  v_reservation public.stripe_lifetime_seat_reservations%ROWTYPE;
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_prior public.subscriptions%ROWTYPE;
  v_activation public.stripe_b2c_recurring_activations%ROWTYPE;
  v_trial public.stripe_trial_entitlements%ROWTYPE;
  v_legacy_grant public.pro_entitlement_grants%ROWTYPE;
  v_snapshot public.stripe_lifetime_superseded_authorities%ROWTYPE;
  v_effect_id uuid;
  v_result jsonb;
  v_claim jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_reservation_id IS NULL OR p_livemode IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR p_stripe_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
    OR p_stripe_charge_id !~ '^ch_[A-Za-z0-9_]+$'
    OR p_amount_paid <= 0 OR p_currency !~ '^[a-z]{3}$'
    OR p_paid_at IS NULL OR p_payment_status IS DISTINCT FROM 'succeeded'
  THEN
    RAISE EXCEPTION 'lifetime payment identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('account-recovery-admission:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-lifetime-seat-capacity', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-charge-refund:' || p_stripe_charge_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );

  SELECT reservation.* INTO v_reservation
  FROM public.stripe_lifetime_seat_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_reservation.user_id IS DISTINCT FROM p_user_id
    OR v_reservation.checkout_session_id IS DISTINCT FROM p_checkout_session_id
    OR v_reservation.livemode IS DISTINCT FROM p_livemode
    OR v_reservation.status NOT IN ('bound', 'converted')
    OR (v_reservation.status = 'bound' AND p_paid_at > v_reservation.checkout_expires_at)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'reservation_review');
  END IF;

  IF public.account_recovery_payment_lifecycle_is_blocked_v2(
    p_user_id, v_reservation.created_at, p_paid_at
  ) THEN
    INSERT INTO public.stripe_entitlement_payments (
      user_id, stripe_customer_id, payment_kind, plan,
      stripe_payment_intent_id, stripe_charge_id, checkout_session_id,
      amount_paid, currency, period_start, payment_status
    ) VALUES (
      p_user_id, p_stripe_customer_id, 'lifetime', 'lifetime',
      p_stripe_payment_intent_id, p_stripe_charge_id, p_checkout_session_id,
      p_amount_paid, p_currency, p_paid_at, p_payment_status
    ) ON CONFLICT DO NOTHING;

    SELECT payment.* INTO v_payment
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.stripe_payment_intent_id = p_stripe_payment_intent_id
      OR payment.stripe_charge_id = p_stripe_charge_id
      OR payment.checkout_session_id = p_checkout_session_id
    ORDER BY payment.id
    LIMIT 1
    FOR UPDATE;
    IF NOT FOUND
      OR v_payment.user_id IS DISTINCT FROM p_user_id
      OR v_payment.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_payment.payment_kind IS DISTINCT FROM 'lifetime'
      OR v_payment.plan IS DISTINCT FROM 'lifetime'
      OR v_payment.stripe_payment_intent_id IS DISTINCT FROM p_stripe_payment_intent_id
      OR v_payment.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
      OR v_payment.checkout_session_id IS DISTINCT FROM p_checkout_session_id
      OR v_payment.amount_paid IS DISTINCT FROM p_amount_paid
      OR v_payment.currency IS DISTINCT FROM p_currency
      OR v_payment.period_start IS DISTINCT FROM p_paid_at
      OR v_payment.payment_status IS DISTINCT FROM p_payment_status
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    IF v_reservation.status = 'bound' THEN
      UPDATE public.stripe_lifetime_seat_reservations
      SET status = 'converted', converted_payment_id = v_payment.id,
          updated_at = v_now
      WHERE id = v_reservation.id AND status = 'bound';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'lifetime reservation conversion CAS failed'
          USING ERRCODE = '40001';
      END IF;
    ELSIF v_reservation.converted_payment_id IS DISTINCT FROM v_payment.id THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    v_claim := public.claim_stripe_payment_ownership_atomic(
      p_stripe_charge_id, p_stripe_payment_intent_id
    );
    IF COALESCE(v_claim ->> 'status', '') IN (
      'identity_conflict', 'manual_review', 'not_found'
    ) THEN
      RAISE EXCEPTION 'lifetime recovery refund ownership claim failed'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.stripe_entitlement_effects (
      entitlement_payment_id, user_id, source_kind, source_key,
      operation_key, effect_type, payload
    ) VALUES (
      v_payment.id, p_user_id, 'payment', v_payment.id::text,
      'refund:account_recovery_billing_blocked',
      'recovery_payment_auto_refund',
      pg_catalog.jsonb_build_object(
        'reason_key', 'account_recovery_billing_blocked',
        'protocol_version', 'dispatch_commit_v1'
      )
    ) ON CONFLICT (source_kind, source_key, effect_type, operation_key)
      DO NOTHING;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'account_recovery_billing_blocked',
      'refund_status', 'refund_pending',
      'payment_id', v_payment.id
    );
  END IF;

  SELECT subscription.* INTO v_prior
  FROM public.subscriptions AS subscription
  WHERE subscription.user_id = p_user_id
  FOR UPDATE;

  v_result := public.activate_lifetime_membership_with_identity_pre_recovery_v2(
    p_user_id, p_stripe_customer_id, p_checkout_session_id, p_reservation_id,
    p_stripe_payment_intent_id, p_stripe_charge_id, p_amount_paid, p_currency,
    p_paid_at, p_payment_status
  );
  IF COALESCE(v_result ->> 'status', '') IS DISTINCT FROM 'activated'
    OR v_prior.id IS NULL
    OR v_prior.plan NOT IN ('monthly', 'yearly')
    OR v_prior.status NOT IN ('active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused')
    OR v_prior.current_period_end IS NULL
  THEN
    RETURN v_result;
  END IF;

  SELECT payment.* INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.stripe_payment_intent_id = p_stripe_payment_intent_id
    AND payment.stripe_charge_id = p_stripe_charge_id
    AND payment.checkout_session_id = p_checkout_session_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'activated lifetime payment disappeared' USING ERRCODE = '23514';
  END IF;
  SELECT effect.id INTO v_effect_id
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.entitlement_payment_id = v_payment.id
    AND effect.effect_type = 'stripe_subscription_cancel'
    AND effect.operation_key =
      'cancel:subscription:' || v_prior.stripe_subscription_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lifetime cancellation effect is missing' USING ERRCODE = '23514';
  END IF;

  SELECT activation.* INTO v_activation
  FROM public.stripe_b2c_recurring_activations AS activation
  WHERE activation.user_id = p_user_id
    AND activation.stripe_customer_id = v_prior.stripe_customer_id
    AND activation.stripe_subscription_id = v_prior.stripe_subscription_id
    AND activation.plan = v_prior.plan
    AND activation.period_start = v_prior.current_period_start
    AND activation.period_end = v_prior.current_period_end
    AND activation.activation_committed_at IS NOT NULL
  ORDER BY activation.source_event_created_at DESC, activation.source_event_id DESC
  LIMIT 1;

  v_snapshot.lifetime_payment_id := v_payment.id;
  v_snapshot.owner_user_id := p_user_id;
  v_snapshot.lifetime_livemode := p_livemode;
  v_snapshot.subscription_row_id := v_prior.id;
  v_snapshot.stripe_customer_id := v_prior.stripe_customer_id;
  v_snapshot.stripe_subscription_id := v_prior.stripe_subscription_id;
  v_snapshot.plan := v_prior.plan;
  v_snapshot.period_start := v_prior.current_period_start;
  v_snapshot.period_end := v_prior.current_period_end;
  v_snapshot.subscription_status := v_prior.status;
  v_snapshot.cancel_at_period_end := v_prior.cancel_at_period_end;
  v_snapshot.retry_grace_grant_ids := '{}'::uuid[];
  v_snapshot.subscription_snapshot := pg_catalog.to_jsonb(v_prior);
  v_snapshot.state := 'cancel_pending';
  v_snapshot.cancellation_effect_id := v_effect_id;
  v_snapshot.created_at := v_now;
  v_snapshot.updated_at := v_now;

  IF v_prior.entitlement_payment_id IS NOT NULL THEN
    IF v_activation.source_event_id IS NOT NULL
      AND v_activation.authority_kind = 'paid'
      AND v_activation.livemode = p_livemode
    THEN
      v_snapshot.authority_kind := 'committed_paid';
      v_snapshot.livemode := p_livemode;
      v_snapshot.stripe_price_id := v_activation.stripe_price_id;
      v_snapshot.expected_amount := v_activation.expected_amount;
      v_snapshot.currency := v_activation.currency;
      v_snapshot.recurring_payment_id := v_prior.entitlement_payment_id;
      v_snapshot.activation_event_id := v_activation.source_event_id;
      v_snapshot.activation_event_created_at := v_activation.source_event_created_at;
      v_snapshot.activation_committed_at := v_activation.activation_committed_at;
    ELSE
      SELECT payment.* INTO v_payment
      FROM public.stripe_entitlement_payments AS payment
      WHERE payment.id = v_prior.entitlement_payment_id;
      v_snapshot.authority_kind := 'legacy_paid';
      v_snapshot.expected_amount := v_payment.amount_paid;
      v_snapshot.currency := v_payment.currency;
      v_snapshot.recurring_payment_id := v_prior.entitlement_payment_id;
    END IF;
  ELSIF v_prior.entitlement_trial_id IS NOT NULL THEN
    SELECT trial.* INTO v_trial
    FROM public.stripe_trial_entitlements AS trial
    WHERE trial.id = v_prior.entitlement_trial_id;
    IF v_activation.source_event_id IS NOT NULL
      AND v_activation.authority_kind = 'trial'
      AND v_activation.livemode = p_livemode
    THEN
      v_snapshot.authority_kind := 'committed_trial';
      v_snapshot.livemode := p_livemode;
      v_snapshot.stripe_price_id := v_activation.stripe_price_id;
      v_snapshot.expected_amount := v_activation.expected_amount;
      v_snapshot.currency := v_activation.currency;
      v_snapshot.trial_id := v_prior.entitlement_trial_id;
      v_snapshot.trial_verified_at := v_prior.entitlement_trial_verified_at;
      v_snapshot.activation_event_id := v_activation.source_event_id;
      v_snapshot.activation_event_created_at := v_activation.source_event_created_at;
      v_snapshot.activation_committed_at := v_activation.activation_committed_at;
    ELSE
      v_snapshot.authority_kind := 'legacy_trial';
      v_snapshot.trial_id := v_prior.entitlement_trial_id;
      v_snapshot.trial_verified_at := v_prior.entitlement_trial_verified_at;
    END IF;
  ELSE
    SELECT entitlement_grant.* INTO v_legacy_grant
    FROM public.pro_entitlement_grants AS entitlement_grant
    WHERE entitlement_grant.user_id = p_user_id
      AND entitlement_grant.source = 'legacy_stripe_snapshot'
      AND entitlement_grant.source_key = 'subscription:' || v_prior.id::text
      AND entitlement_grant.revoked_at IS NOT NULL
    ORDER BY entitlement_grant.id
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'superseded recurring authority is not snapshot-exact'
        USING ERRCODE = '23514';
    END IF;
    v_snapshot.authority_kind := 'legacy_snapshot';
    v_snapshot.legacy_grant_id := v_legacy_grant.id;
  END IF;
  v_snapshot.snapshot_digest :=
    public.stripe_lifetime_superseded_authority_digest_v2(v_snapshot);
  INSERT INTO public.stripe_lifetime_superseded_authorities
  SELECT (v_snapshot).*;
  RETURN v_result;
END
$function$;

ALTER FUNCTION public.activate_lifetime_membership_with_identity_atomic(
  uuid, text, text, uuid, text, text, bigint, text, timestamptz, text, boolean
) OWNER TO postgres;

-- Preserve the already-hardened product writers as owner-only implementation
-- details.  The public overloads add signed Stripe mode and take the recovery
-- admission lock before any financial or entitlement lock.
ALTER FUNCTION public.activate_group_subscription_with_stripe_ownership_atomic(
  uuid, uuid, text, text, text, bigint, text, text, text
) RENAME TO activate_group_subscription_with_stripe_ownership_pre_recovery;
REVOKE ALL ON FUNCTION
  public.activate_group_subscription_with_stripe_ownership_pre_recovery(
    uuid, uuid, text, text, text, bigint, text, text, text
  ) FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.activate_group_subscription_with_stripe_ownership_atomic(
    p_actor_id uuid,
    p_group_id uuid,
    p_tier text,
    p_payment_intent_id text,
    p_checkout_session_id text,
    p_amount_cents bigint,
    p_currency text,
    p_stripe_charge_id text,
    p_stripe_customer_id text,
    p_livemode boolean,
    p_checkout_created_at timestamptz,
    p_paid_at timestamptz
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
  v_existing public.group_payment_consumptions%ROWTYPE;
  v_result jsonb;
  v_claim jsonb;
  v_subscription_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL OR p_group_id IS NULL OR p_livemode IS NULL
    OR p_checkout_created_at IS NULL
    OR p_checkout_created_at IS DISTINCT FROM
      pg_catalog.date_trunc('second', p_checkout_created_at)
    OR p_paid_at IS NULL
    OR p_paid_at IS DISTINCT FROM pg_catalog.date_trunc('second', p_paid_at)
    OR p_paid_at < p_checkout_created_at
    OR p_paid_at > pg_catalog.statement_timestamp()
    OR p_tier NOT IN ('monthly', 'yearly')
    OR p_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
    OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR p_stripe_charge_id !~ '^ch_[A-Za-z0-9_]+$'
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR p_amount_cents <= 0 OR p_currency IS DISTINCT FROM 'usd'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_payment');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_actor_id::text, 0
    )
  );

  IF NOT public.account_recovery_payment_lifecycle_is_blocked_v2(
    p_actor_id,
    p_checkout_created_at,
    p_paid_at
  ) THEN
    v_result :=
      public.activate_group_subscription_with_stripe_ownership_pre_recovery(
        p_actor_id, p_group_id, p_tier, p_payment_intent_id,
        p_checkout_session_id, p_amount_cents, p_currency,
        p_stripe_charge_id, p_stripe_customer_id
      );
    IF COALESCE(v_result ->> 'status', '') IN ('subscribed', 'renewed') THEN
      UPDATE public.group_payment_consumptions AS consumption
      SET livemode = p_livemode
      WHERE consumption.provider = 'stripe'
        AND consumption.payment_intent_id = p_payment_intent_id
        AND consumption.checkout_session_id = p_checkout_session_id
        AND consumption.stripe_charge_id = p_stripe_charge_id
        AND consumption.stripe_customer_id = p_stripe_customer_id
        AND consumption.user_id = p_actor_id
        AND consumption.group_id = p_group_id
        AND consumption.livemode IS NULL;
      IF NOT EXISTS (
        SELECT 1 FROM public.group_payment_consumptions AS consumption
        WHERE consumption.provider = 'stripe'
          AND consumption.payment_intent_id = p_payment_intent_id
          AND consumption.checkout_session_id = p_checkout_session_id
          AND consumption.stripe_charge_id = p_stripe_charge_id
          AND consumption.stripe_customer_id = p_stripe_customer_id
          AND consumption.user_id = p_actor_id
          AND consumption.group_id = p_group_id
          AND consumption.livemode = p_livemode
      ) THEN
        RAISE EXCEPTION 'group payment mode binding failed' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN v_result;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-charge-refund:' || p_stripe_charge_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-payment-identity:' || p_payment_intent_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-checkout-session:' || p_checkout_session_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || p_group_id::text || ':' || p_actor_id::text, 0
    )
  );

  SELECT consumption.* INTO v_existing
  FROM public.group_payment_consumptions AS consumption
  WHERE consumption.provider = 'stripe'
    AND (
      consumption.payment_intent_id = p_payment_intent_id
      OR consumption.checkout_session_id = p_checkout_session_id
      OR consumption.stripe_charge_id = p_stripe_charge_id
    )
  ORDER BY consumption.id
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.user_id IS DISTINCT FROM p_actor_id
      OR v_existing.group_id IS DISTINCT FROM p_group_id
      OR v_existing.tier IS DISTINCT FROM p_tier
      OR v_existing.payment_intent_id IS DISTINCT FROM p_payment_intent_id
      OR v_existing.checkout_session_id IS DISTINCT FROM p_checkout_session_id
      OR v_existing.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
      OR v_existing.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_existing.amount_cents IS DISTINCT FROM p_amount_cents
      OR v_existing.currency IS DISTINCT FROM p_currency
      OR v_existing.livemode IS DISTINCT FROM p_livemode
      OR v_existing.outcome IS DISTINCT FROM 'billing_blocked_refund_pending'
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    RETURN v_existing.result || pg_catalog.jsonb_build_object(
      'idempotent_replay', true
    );
  END IF;

  v_subscription_id := pg_catalog.gen_random_uuid();
  v_result := pg_catalog.jsonb_build_object(
    'status', 'refund_pending',
    'subscription_id', v_subscription_id,
    'idempotent_replay', false
  );
  INSERT INTO public.group_payment_consumptions (
    provider, payment_intent_id, checkout_session_id, subscription_id,
    group_id, user_id, tier, amount_cents, currency, outcome, result,
    stripe_charge_id, stripe_customer_id, livemode
  ) VALUES (
    'stripe', p_payment_intent_id, p_checkout_session_id, v_subscription_id,
    p_group_id, p_actor_id, p_tier, p_amount_cents, p_currency,
    'billing_blocked_refund_pending', v_result,
    p_stripe_charge_id, p_stripe_customer_id, p_livemode
  ) RETURNING * INTO v_existing;

  v_claim := public.claim_stripe_payment_ownership_atomic(
    p_stripe_charge_id, p_payment_intent_id
  );
  IF COALESCE(v_claim ->> 'status', '') IN (
    'identity_conflict', 'manual_review', 'not_found'
  ) THEN
    RAISE EXCEPTION 'group recovery refund ownership claim failed'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.stripe_entitlement_effects (
    entitlement_payment_id, user_id, source_kind, source_key,
    operation_key, effect_type, payload
  ) VALUES (
    NULL, p_actor_id, 'group_payment', v_existing.id::text,
    'refund:account_recovery_billing_blocked',
    'recovery_payment_auto_refund',
    pg_catalog.jsonb_build_object(
      'reason_key', 'account_recovery_billing_blocked',
      'protocol_version', 'dispatch_commit_v1'
    )
  ) ON CONFLICT (source_kind, source_key, effect_type, operation_key)
    DO NOTHING;
  RETURN v_result;
END
$function$;

ALTER FUNCTION public.activate_group_subscription_with_stripe_ownership_atomic(
  uuid, uuid, text, text, text, bigint, text, text, text, boolean,
  timestamptz, timestamptz
) OWNER TO postgres;

ALTER FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  uuid, text, text, text, text, bigint, text, timestamptz, text,
  uuid, uuid, uuid, uuid, bigint, timestamptz, text
) RENAME TO complete_tip_with_stripe_ownership_pre_recovery_v2;
REVOKE ALL ON FUNCTION public.complete_tip_with_stripe_ownership_pre_recovery_v2(
  uuid, text, text, text, text, bigint, text, timestamptz, text,
  uuid, uuid, uuid, uuid, bigint, timestamptz, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  uuid, text, text, text, text, bigint, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  p_tip_id uuid,
  p_stripe_customer_id text,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_checkout_session_id text,
  p_amount_paid bigint,
  p_currency text,
  p_completed_at timestamptz,
  p_client_reference_id text,
  p_metadata_user_id uuid,
  p_metadata_from_user_id uuid,
  p_metadata_post_id uuid,
  p_metadata_to_user_id uuid,
  p_metadata_amount_cents bigint,
  p_checkout_expires_at timestamptz,
  p_event_id text,
  p_livemode boolean
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
  v_tip public.tips%ROWTYPE;
  v_result jsonb;
  v_claim jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_tip_id IS NULL OR p_livemode IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR p_stripe_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
    OR p_stripe_charge_id !~ '^ch_[A-Za-z0-9_]+$'
    OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR p_amount_paid NOT BETWEEN 100 AND 50000
    OR p_currency IS DISTINCT FROM 'usd'
    OR p_completed_at IS NULL
    OR p_metadata_user_id IS NULL
    OR p_metadata_from_user_id IS NULL
    OR p_metadata_post_id IS NULL
    OR p_metadata_to_user_id IS NULL
    OR p_metadata_amount_cents NOT BETWEEN 100 AND 50000
    OR p_checkout_expires_at IS NULL
    OR p_event_id !~ '^evt_[A-Za-z0-9_]+$'
  THEN
    RAISE EXCEPTION 'expanded Tip completion identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_metadata_from_user_id::text, 0
    )
  );
  -- The Tip reservation timestamp is durable local checkout creation
  -- authority; p_completed_at is the signed payment completion boundary.
  SELECT tip.* INTO v_tip
  FROM public.tips AS tip
  WHERE tip.id = p_tip_id;
  IF NOT public.account_recovery_payment_lifecycle_is_blocked_v2(
    p_metadata_from_user_id,
    v_tip.created_at,
    p_completed_at
  ) THEN
    v_result := public.complete_tip_with_stripe_ownership_pre_recovery_v2(
      p_tip_id, p_stripe_customer_id, p_stripe_payment_intent_id,
      p_stripe_charge_id, p_checkout_session_id, p_amount_paid, p_currency,
      p_completed_at, p_client_reference_id, p_metadata_user_id,
      p_metadata_from_user_id, p_metadata_post_id, p_metadata_to_user_id,
      p_metadata_amount_cents, p_checkout_expires_at, p_event_id
    );
    IF COALESCE(v_result ->> 'completion_status', v_result ->> 'status') IN (
      'completed', 'already_completed'
    ) THEN
      UPDATE public.tips AS tip SET livemode = p_livemode
      WHERE tip.id = p_tip_id AND tip.livemode IS NULL;
      IF NOT EXISTS (
        SELECT 1 FROM public.tips AS tip
        WHERE tip.id = p_tip_id AND tip.livemode = p_livemode
      ) THEN
        RAISE EXCEPTION 'Tip payment mode binding failed' USING ERRCODE = '23514';
      END IF;
    END IF;
    RETURN v_result;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-charge-refund:' || p_stripe_charge_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-payment-identity:' || p_stripe_payment_intent_id, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-checkout-session:' || p_checkout_session_id, 0)
  );
  PERFORM public.lock_tip_notification_authority_atomic(p_tip_id);
  SELECT tip.* INTO v_tip
  FROM public.tips AS tip WHERE tip.id = p_tip_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'manual_review',
      'reason_key', 'tip_checkout_completion_subject_missing'
    );
  END IF;

  IF v_tip.status = 'refund_pending' THEN
    IF v_tip.from_user_id IS DISTINCT FROM p_metadata_user_id
      OR v_tip.from_user_id IS DISTINCT FROM p_metadata_from_user_id
      OR v_tip.checkout_post_id IS DISTINCT FROM p_metadata_post_id
      OR v_tip.checkout_to_user_id IS DISTINCT FROM p_metadata_to_user_id
      OR v_tip.amount_cents::bigint IS DISTINCT FROM p_amount_paid
      OR v_tip.amount_cents::bigint IS DISTINCT FROM p_metadata_amount_cents
      OR v_tip.stripe_checkout_session_id IS DISTINCT FROM p_checkout_session_id
      OR v_tip.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_tip.stripe_payment_intent_id IS DISTINCT FROM p_stripe_payment_intent_id
      OR v_tip.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
      OR v_tip.currency IS DISTINCT FROM p_currency
      OR v_tip.livemode IS DISTINCT FROM p_livemode
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'refund_pending',
      'completion_status', 'notification_suppressed',
      'tip_id', v_tip.id,
      'idempotent_replay', true
    );
  END IF;

  IF v_tip.status IS DISTINCT FROM 'pending'
    OR v_tip.from_user_id IS DISTINCT FROM p_metadata_user_id
    OR v_tip.from_user_id IS DISTINCT FROM p_metadata_from_user_id
    OR p_metadata_user_id IS DISTINCT FROM p_metadata_from_user_id
    OR v_tip.checkout_post_id IS DISTINCT FROM p_metadata_post_id
    OR v_tip.checkout_to_user_id IS DISTINCT FROM p_metadata_to_user_id
    OR v_tip.amount_cents::bigint IS DISTINCT FROM p_amount_paid
    OR v_tip.amount_cents::bigint IS DISTINCT FROM p_metadata_amount_cents
    OR v_tip.stripe_checkout_session_id IS DISTINCT FROM p_checkout_session_id
    OR v_tip.checkout_expires_at IS DISTINCT FROM p_checkout_expires_at
    OR p_client_reference_id IS DISTINCT FROM p_tip_id::text
    OR v_tip.checkout_failed_at IS NOT NULL
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'manual_review',
      'reason_key', 'tip_checkout_completion_snapshot_drift'
    );
  END IF;

  UPDATE public.tips
  SET status = 'refund_pending',
      stripe_customer_id = p_stripe_customer_id,
      stripe_payment_intent_id = p_stripe_payment_intent_id,
      stripe_charge_id = p_stripe_charge_id,
      currency = p_currency,
      completed_at = p_completed_at,
      livemode = p_livemode,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_tip_id AND status = 'pending'
  RETURNING * INTO v_tip;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tip recovery terminal transition lost' USING ERRCODE = '40001';
  END IF;

  v_claim := public.claim_stripe_payment_ownership_atomic(
    p_stripe_charge_id, p_stripe_payment_intent_id
  );
  IF COALESCE(v_claim ->> 'status', '') IN (
    'identity_conflict', 'manual_review', 'not_found'
  ) THEN
    RAISE EXCEPTION 'Tip recovery refund ownership claim failed'
      USING ERRCODE = '23514';
  END IF;
  INSERT INTO public.stripe_entitlement_effects (
    entitlement_payment_id, user_id, source_kind, source_key,
    operation_key, effect_type, payload
  ) VALUES (
    NULL, v_tip.from_user_id, 'tip_payment', v_tip.id::text,
    'refund:account_recovery_billing_blocked',
    'recovery_payment_auto_refund',
    pg_catalog.jsonb_build_object(
      'reason_key', 'account_recovery_billing_blocked',
      'protocol_version', 'dispatch_commit_v1'
    )
  ) ON CONFLICT (source_kind, source_key, effect_type, operation_key)
    DO NOTHING;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'refund_pending',
    'completion_status', 'notification_suppressed',
    'tip_id', v_tip.id,
    'idempotent_replay', false
  );
END
$function$;

ALTER FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  uuid, text, text, text, text, bigint, text, timestamptz, text,
  uuid, uuid, uuid, uuid, bigint, timestamptz, text, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.queue_lifetime_restore_after_refund()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_authority public.stripe_lifetime_superseded_authorities%ROWTYPE;
  v_restore_effect_id uuid;
BEGIN
  IF NEW.payment_kind IS DISTINCT FROM 'lifetime'
    OR NEW.refund_state IS DISTINCT FROM 'succeeded'
    OR NEW.refund_succeeded_amount < NEW.amount_paid
    OR (
      OLD.refund_state = 'succeeded'
      AND OLD.refund_succeeded_amount >= OLD.amount_paid
    )
  THEN
    RETURN NEW;
  END IF;

  SELECT authority.* INTO v_authority
  FROM public.stripe_lifetime_superseded_authorities AS authority
  WHERE authority.lifetime_payment_id = NEW.id
  FOR UPDATE;
  IF NOT FOUND OR v_authority.state NOT IN (
    'cancel_pending', 'cancel_dispatched', 'cancel_completed'
  ) THEN
    RETURN NEW;
  END IF;

  IF v_authority.cancel_dispatch_committed_at IS NOT NULL THEN
    UPDATE public.stripe_lifetime_superseded_authorities
    SET state = CASE
          WHEN v_authority.state = 'cancel_completed'
          THEN 'absorbed_completed'
          ELSE 'absorbed_dispatched'
        END,
        refund_event_id = NEW.latest_refund_event_id,
        updated_at = pg_catalog.clock_timestamp()
    WHERE lifetime_payment_id = NEW.id;
    RETURN NEW;
  END IF;

  UPDATE public.stripe_entitlement_effects
  SET status = 'superseded',
      lease_token = NULL,
      lease_expires_at = NULL,
      completed_at = COALESCE(completed_at, pg_catalog.clock_timestamp()),
      last_error = 'lifetime_refunded_before_cancel_dispatch',
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_authority.cancellation_effect_id
    AND dispatch_committed_at IS NULL
    AND status IN ('pending', 'processing', 'failed');

  INSERT INTO public.stripe_entitlement_effects (
    entitlement_payment_id, user_id, source_kind, source_key,
    operation_key, effect_type, payload
  ) VALUES (
    NEW.id, v_authority.owner_user_id, 'payment', NEW.id::text,
    'restore:lifetime_refund:' || NEW.latest_refund_event_id,
    'stripe_lifetime_authority_restore',
    pg_catalog.jsonb_build_object(
      'snapshot_digest', v_authority.snapshot_digest
    )
  ) ON CONFLICT (source_kind, source_key, effect_type, operation_key)
    DO UPDATE SET updated_at = EXCLUDED.updated_at
  RETURNING id INTO v_restore_effect_id;

  UPDATE public.stripe_lifetime_superseded_authorities
  SET state = 'restore_pending',
      restore_effect_id = v_restore_effect_id,
      refund_event_id = NEW.latest_refund_event_id,
      updated_at = pg_catalog.clock_timestamp()
  WHERE lifetime_payment_id = NEW.id
    AND state = 'cancel_pending';
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.queue_lifetime_restore_after_refund() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.queue_lifetime_restore_after_refund()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TRIGGER trg_queue_lifetime_restore_after_refund
  AFTER UPDATE OF refund_state, refund_succeeded_amount
  ON public.stripe_entitlement_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.queue_lifetime_restore_after_refund();

CREATE OR REPLACE FUNCTION public.read_lifetime_restore_authority_atomic(
  p_effect_id uuid,
  p_lease_token uuid,
  p_livemode boolean
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
  v_effect public.stripe_entitlement_effects%ROWTYPE;
  v_authority public.stripe_lifetime_superseded_authorities%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  SELECT effect.* INTO v_effect
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.id = p_effect_id
  FOR UPDATE;
  IF NOT FOUND OR p_livemode IS NULL OR p_lease_token IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT authority.* INTO v_authority
  FROM public.stripe_lifetime_superseded_authorities AS authority
  WHERE authority.restore_effect_id = p_effect_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_effect.status IS DISTINCT FROM 'processing'
    OR v_effect.lease_token IS DISTINCT FROM p_lease_token
    OR v_effect.lease_expires_at <= pg_catalog.statement_timestamp()
    OR v_effect.effect_type IS DISTINCT FROM 'stripe_lifetime_authority_restore'
    OR v_effect.entitlement_payment_id IS DISTINCT FROM
      v_authority.lifetime_payment_id
    OR v_effect.user_id IS DISTINCT FROM v_authority.owner_user_id
    OR v_effect.payload IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'snapshot_digest', v_authority.snapshot_digest
    )
    OR v_authority.state IS DISTINCT FROM 'restore_pending'
    OR v_authority.lifetime_livemode IS DISTINCT FROM p_livemode
    OR NOT public.stripe_lifetime_superseded_authority_is_exact_v2(v_authority)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'authority_ready',
    'user_id', v_authority.owner_user_id,
    'livemode', v_authority.lifetime_livemode,
    'stripe_customer_id', v_authority.stripe_customer_id,
    'stripe_subscription_id', v_authority.stripe_subscription_id,
    'period_start', v_authority.period_start,
    'period_end', v_authority.period_end,
    'cancel_at_period_end', v_authority.cancel_at_period_end,
    'snapshot_digest', v_authority.snapshot_digest
  );
END
$function$;

ALTER FUNCTION public.read_lifetime_restore_authority_atomic(
  uuid, uuid, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.restore_lifetime_superseded_authority_atomic(
  p_effect_id uuid,
  p_lease_token uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_subscription_status text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean
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
  v_effect public.stripe_entitlement_effects%ROWTYPE;
  v_authority public.stripe_lifetime_superseded_authorities%ROWTYPE;
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  SELECT authority.* INTO v_authority
  FROM public.stripe_lifetime_superseded_authorities AS authority
  WHERE authority.restore_effect_id = p_effect_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_authority.owner_user_id::text, 0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-lifetime-seat-capacity', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || v_authority.owner_user_id::text, 0
    )
  );

  SELECT effect.* INTO v_effect
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.id = p_effect_id FOR UPDATE;
  SELECT authority.* INTO v_authority
  FROM public.stripe_lifetime_superseded_authorities AS authority
  WHERE authority.restore_effect_id = p_effect_id FOR UPDATE;
  SELECT payment.* INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.id = v_authority.lifetime_payment_id FOR UPDATE;
  SELECT subscription.* INTO v_subscription
  FROM public.subscriptions AS subscription
  WHERE subscription.user_id = v_authority.owner_user_id FOR UPDATE;

  IF v_effect.status IS DISTINCT FROM 'processing'
    OR v_effect.lease_token IS DISTINCT FROM p_lease_token
    OR v_effect.lease_expires_at <= pg_catalog.statement_timestamp()
    OR v_authority.state IS DISTINCT FROM 'restore_pending'
    OR v_authority.lifetime_livemode IS DISTINCT FROM p_livemode
    OR v_authority.cancel_dispatch_committed_at IS NOT NULL
    OR NOT public.stripe_lifetime_superseded_authority_is_exact_v2(v_authority)
    OR v_payment.refund_state IS DISTINCT FROM 'succeeded'
    OR v_payment.refund_succeeded_amount < v_payment.amount_paid
    OR v_payment.latest_refund_event_id IS DISTINCT FROM v_authority.refund_event_id
    OR v_subscription.entitlement_payment_id IS DISTINCT FROM
      v_authority.lifetime_payment_id
    OR v_subscription.plan IS DISTINCT FROM 'lifetime'
    OR p_livemode IS DISTINCT FROM v_authority.lifetime_livemode
    OR p_stripe_customer_id IS DISTINCT FROM v_authority.stripe_customer_id
    OR p_stripe_subscription_id IS DISTINCT FROM v_authority.stripe_subscription_id
    OR p_subscription_status IS DISTINCT FROM v_authority.subscription_status
    OR p_period_start IS DISTINCT FROM v_authority.period_start
    OR p_period_end IS DISTINCT FROM v_authority.period_end
    OR p_cancel_at_period_end IS DISTINCT FROM v_authority.cancel_at_period_end
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  IF public.account_recovery_billing_surface_is_blocked_v2(
    v_authority.owner_user_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'recovery_blocked');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.stripe_entitlement_payments AS newer
    WHERE newer.user_id = v_authority.owner_user_id
      AND newer.id <> v_authority.lifetime_payment_id
      AND newer.id IS DISTINCT FROM v_authority.recurring_payment_id
      AND newer.created_at >= COALESCE(
        v_authority.activation_committed_at,
        v_authority.created_at
      )
      AND newer.payment_status IN ('paid', 'succeeded')
      AND NOT (
        newer.refund_state = 'succeeded'
        AND newer.refund_succeeded_amount >= newer.amount_paid
      )
  ) THEN
    UPDATE public.stripe_lifetime_superseded_authorities
    SET state = 'superseded', updated_at = v_now
    WHERE restore_effect_id = p_effect_id
      AND state = 'restore_pending';
    RETURN pg_catalog.jsonb_build_object('status', 'newer_authority');
  END IF;

  UPDATE public.subscriptions
  SET stripe_customer_id = v_authority.stripe_customer_id,
      stripe_subscription_id = v_authority.stripe_subscription_id,
      status = v_authority.subscription_status,
      tier = 'pro',
      plan = v_authority.plan,
      current_period_start = v_authority.period_start,
      current_period_end = v_authority.period_end,
      cancel_at_period_end = v_authority.cancel_at_period_end,
      canceled_at = (v_authority.subscription_snapshot ->> 'canceled_at')::timestamptz,
      entitlement_payment_id = v_authority.recurring_payment_id,
      entitlement_trial_id = v_authority.trial_id,
      entitlement_trial_verified_at = v_authority.trial_verified_at,
      updated_at = v_now
  WHERE user_id = v_authority.owner_user_id
    AND entitlement_payment_id = v_authority.lifetime_payment_id
    AND plan = 'lifetime';
  IF NOT FOUND THEN
    UPDATE public.stripe_lifetime_superseded_authorities
    SET state = 'superseded', updated_at = v_now
    WHERE restore_effect_id = p_effect_id
      AND state = 'restore_pending';
    RETURN pg_catalog.jsonb_build_object('status', 'newer_authority');
  END IF;

  IF v_authority.trial_id IS NOT NULL THEN
    UPDATE public.stripe_trial_entitlements
    SET revoked_at = NULL, revoke_reason = NULL, updated_at = v_now
    WHERE id = v_authority.trial_id
      AND user_id = v_authority.owner_user_id
      AND revoked_at IS NOT NULL
      AND revoke_reason = 'lifetime_activation';
  END IF;
  IF v_authority.legacy_grant_id IS NOT NULL THEN
    UPDATE public.pro_entitlement_grants
    SET revoked_at = NULL, updated_at = v_now
    WHERE id = v_authority.legacy_grant_id
      AND user_id = v_authority.owner_user_id
      AND source = 'legacy_stripe_snapshot';
  END IF;
  UPDATE public.pro_entitlement_grants
  SET revoked_at = COALESCE(revoked_at, v_now), updated_at = v_now
  WHERE user_id = v_authority.owner_user_id
    AND source = 'stripe_lifetime_payment'
    AND source_key = 'payment:' || v_authority.lifetime_payment_id::text;
  PERFORM public.sync_current_pro_projection_atomic(v_authority.owner_user_id);
  RETURN pg_catalog.jsonb_build_object('status', 'restored');
END
$function$;

ALTER FUNCTION public.restore_lifetime_superseded_authority_atomic(
  uuid, uuid, boolean, text, text, text, timestamptz, timestamptz, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.finish_lifetime_restore_effect_projection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
BEGIN
  IF NEW.effect_type = 'stripe_lifetime_authority_restore'
    AND NEW.status = 'completed'
    AND OLD.status IS DISTINCT FROM 'completed'
  THEN
    UPDATE public.stripe_lifetime_superseded_authorities
    SET state = 'restored', restored_at = NEW.completed_at,
        updated_at = NEW.completed_at
    WHERE restore_effect_id = NEW.id
      AND state = 'restore_pending'
      AND NEW.external_ref =
        'lifetime-authority-restored:' || lifetime_payment_id::text;
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.finish_lifetime_restore_effect_projection()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finish_lifetime_restore_effect_projection()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TRIGGER trg_finish_lifetime_restore_effect_projection
  AFTER UPDATE OF status ON public.stripe_entitlement_effects
  FOR EACH ROW
  EXECUTE FUNCTION public.finish_lifetime_restore_effect_projection();

CREATE OR REPLACE FUNCTION public.project_lifetime_cancel_effect_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
BEGIN
  IF NEW.effect_type = 'stripe_subscription_cancel'
    AND NEW.payload ->> 'reason' = 'lifetime_membership_activated'
    AND NEW.dispatch_committed_at IS NOT NULL
  THEN
    UPDATE public.stripe_lifetime_superseded_authorities
    SET state = CASE
          WHEN NEW.status = 'completed' THEN 'cancel_completed'
          ELSE 'cancel_dispatched'
        END,
        cancel_dispatch_committed_at = NEW.dispatch_committed_at,
        updated_at = pg_catalog.clock_timestamp()
    WHERE cancellation_effect_id = NEW.id
      AND (
        state = 'cancel_pending'
        OR (state = 'cancel_dispatched' AND NEW.status = 'completed')
      );
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.project_lifetime_cancel_effect_state() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.project_lifetime_cancel_effect_state()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TRIGGER trg_project_lifetime_cancel_effect_state
  AFTER UPDATE OF dispatch_committed_at, status
  ON public.stripe_entitlement_effects
  FOR EACH ROW
  EXECUTE FUNCTION public.project_lifetime_cancel_effect_state();

REVOKE ALL ON TABLE public.stripe_b2c_invoice_events
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT SELECT ON TABLE public.stripe_b2c_invoice_events TO service_role;
REVOKE ALL ON TABLE public.stripe_b2c_recurring_activations
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT SELECT ON TABLE public.stripe_b2c_recurring_activations TO service_role;

REVOKE ALL ON FUNCTION public.reconcile_b2c_subscription_event_atomic(
  uuid, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, boolean, timestamptz, timestamptz,
  text, timestamptz, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.current_exact_pro_grant_authority_ungated_v2(
  uuid, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.record_b2c_recurring_manual_review_atomic(
  text, text, uuid, text, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.classify_recurring_invoice_product_authority_atomic(
  boolean, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.prevent_b2c_financial_owner_mutation()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.enforce_stripe_cancel_dispatch_protocol()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.prevent_stripe_cancel_dispatch_marker_mutation()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.review_lifetime_refund_after_cancel_dispatch()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.stripe_entitlement_effect_is_current_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.claim_stripe_subscription_cancel_dispatch_atomic(
  uuid, uuid, boolean
)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.lease_stripe_entitlement_effects_atomic(integer, integer)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.finish_stripe_entitlement_effect_atomic(
  uuid, uuid, boolean, text, text, integer
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.has_b2c_recurring_financial_owner_atomic(
  uuid, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.resolve_b2c_recurring_price_authority(text, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.claim_pro_membership_checkout_recovery_candidates(
  boolean, integer
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.reconcile_b2c_subscription_state_core_atomic(
  uuid, text, text, text, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.drain_pending_b2c_subscription_events_atomic(
  uuid, text, text, text, text, bigint, text, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.check_b2c_activation_reservation_atomic(
  uuid, boolean, text, text, text, text, bigint, text
)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.observe_b2c_recurring_activation_atomic(
  text, uuid, text, text, text, text, bigint, text, timestamptz, timestamptz,
  text, text, timestamptz, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.activate_b2c_recurring_payment_atomic(
  uuid, text, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, text, text, timestamptz, boolean, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.activate_b2c_recurring_trial_atomic(
  uuid, text, text, text, text, bigint, text, timestamptz, timestamptz, text,
  text, timestamptz, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.activate_and_reconcile_b2c_recurring_trial_event_atomic(
  uuid, text, text, text, text, text, bigint, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.apply_b2c_recurring_invoice_event_atomic(
  text, timestamptz, boolean, text, uuid, text, text, text, text,
  text, text, text, text, bigint, text, timestamptz, timestamptz,
  text, text, timestamptz, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

GRANT EXECUTE ON FUNCTION public.reconcile_b2c_subscription_event_atomic(
  uuid, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, boolean, timestamptz, timestamptz,
  text, timestamptz, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_b2c_recurring_manual_review_atomic(
  text, text, uuid, text, text, jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.classify_recurring_invoice_product_authority_atomic(
  boolean, text, text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_b2c_recurring_price_authority(text, boolean, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_pro_membership_checkout_recovery_candidates(
  boolean, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_stripe_subscription_cancel_dispatch_atomic(
  uuid, uuid, boolean
)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.lease_stripe_entitlement_effects_atomic(integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_stripe_entitlement_effect_atomic(
  uuid, uuid, boolean, text, text, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_b2c_recurring_payment_atomic(
  uuid, text, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, text, text, timestamptz, boolean, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_b2c_recurring_trial_atomic(
  uuid, text, text, text, text, bigint, text, timestamptz, timestamptz, text,
  text, timestamptz, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_and_reconcile_b2c_recurring_trial_event_atomic(
  uuid, text, text, text, text, text, bigint, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_b2c_recurring_invoice_event_atomic(
  text, timestamptz, boolean, text, uuid, text, text, text, text,
  text, text, text, text, bigint, text, timestamptz, timestamptz,
  text, text, timestamptz, boolean
) TO service_role;

REVOKE ALL ON FUNCTION public.claim_recovery_payment_refund_dispatch_atomic(
  uuid, uuid, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.claim_lifetime_recovery_refund_dispatch_atomic(
  uuid, uuid, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.read_lifetime_restore_authority_atomic(
  uuid, uuid, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.restore_lifetime_superseded_authority_atomic(
  uuid, uuid, boolean, text, text, text, timestamptz, timestamptz, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.activate_lifetime_membership_with_identity_atomic(
  uuid, text, text, uuid, text, text, bigint, text, timestamptz, text, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION
  public.activate_group_subscription_with_stripe_ownership_atomic(
    uuid, uuid, text, text, text, bigint, text, text, text, boolean,
    timestamptz, timestamptz
  ) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  uuid, text, text, text, text, bigint, text, timestamptz, text,
  uuid, uuid, uuid, uuid, bigint, timestamptz, text, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

GRANT EXECUTE ON FUNCTION public.claim_recovery_payment_refund_dispatch_atomic(
  uuid, uuid, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_lifetime_restore_authority_atomic(
  uuid, uuid, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.restore_lifetime_superseded_authority_atomic(
  uuid, uuid, boolean, text, text, text, timestamptz, timestamptz, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_lifetime_membership_with_identity_atomic(
  uuid, text, text, uuid, text, text, bigint, text, timestamptz, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION
  public.activate_group_subscription_with_stripe_ownership_atomic(
    uuid, uuid, text, text, text, bigint, text, text, text, boolean,
    timestamptz, timestamptz
  ) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  uuid, text, text, text, text, bigint, text, timestamptz, text,
  uuid, uuid, uuid, uuid, bigint, timestamptz, text, boolean
) TO service_role;

DO $postflight$
DECLARE
  v_invoice_table pg_catalog.regclass := 'public.stripe_b2c_invoice_events'::pg_catalog.regclass;
  v_activation_table pg_catalog.regclass := 'public.stripe_b2c_recurring_activations'::pg_catalog.regclass;
  v_postgres oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres');
  v_service oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role');
  v_anon oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon');
  v_authenticated oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated');
  v_authenticator oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticator');
  v_plpgsql oid := (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql');
  v_external_functions oid[] := ARRAY[
    'public.record_b2c_recurring_manual_review_atomic(text,text,uuid,text,text,jsonb)'::pg_catalog.regprocedure::oid,
    'public.classify_recurring_invoice_product_authority_atomic(boolean,text,text,text,text,text)'::pg_catalog.regprocedure::oid,
    'public.resolve_b2c_recurring_price_authority(text,boolean,text)'::pg_catalog.regprocedure::oid,
    'public.claim_pro_membership_checkout_recovery_candidates(boolean,integer)'::pg_catalog.regprocedure::oid,
    'public.claim_stripe_subscription_cancel_dispatch_atomic(uuid,uuid,boolean)'::pg_catalog.regprocedure::oid,
    'public.claim_recovery_payment_refund_dispatch_atomic(uuid,uuid,boolean)'::pg_catalog.regprocedure::oid,
    'public.read_lifetime_restore_authority_atomic(uuid,uuid,boolean)'::pg_catalog.regprocedure::oid,
    'public.restore_lifetime_superseded_authority_atomic(uuid,uuid,boolean,text,text,text,timestamp with time zone,timestamp with time zone,boolean)'::pg_catalog.regprocedure::oid,
    'public.activate_lifetime_membership_with_identity_atomic(uuid,text,text,uuid,text,text,bigint,text,timestamp with time zone,text,boolean)'::pg_catalog.regprocedure::oid,
    'public.activate_group_subscription_with_stripe_ownership_atomic(uuid,uuid,text,text,text,bigint,text,text,text,boolean,timestamp with time zone,timestamp with time zone)'::pg_catalog.regprocedure::oid,
    'public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamp with time zone,text,uuid,uuid,uuid,uuid,bigint,timestamp with time zone,text,boolean)'::pg_catalog.regprocedure::oid,
    'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)'::pg_catalog.regprocedure::oid,
    'public.reconcile_b2c_subscription_event_atomic(uuid,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure::oid,
    'public.activate_b2c_recurring_payment_atomic(uuid,text,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text,text,timestamp with time zone,boolean,boolean)'::pg_catalog.regprocedure::oid,
    'public.activate_b2c_recurring_trial_atomic(uuid,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure::oid,
    'public.activate_and_reconcile_b2c_recurring_trial_event_atomic(uuid,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure::oid,
    'public.apply_b2c_recurring_invoice_event_atomic(text,timestamp with time zone,boolean,text,uuid,text,text,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure::oid
  ];
  v_internal_functions oid[] := ARRAY[
    'public.prevent_b2c_financial_owner_mutation()'::pg_catalog.regprocedure::oid,
    'public.enforce_stripe_cancel_dispatch_protocol()'::pg_catalog.regprocedure::oid,
    'public.prevent_stripe_cancel_dispatch_marker_mutation()'::pg_catalog.regprocedure::oid,
    'public.review_lifetime_refund_after_cancel_dispatch()'::pg_catalog.regprocedure::oid,
    'public.has_b2c_recurring_financial_owner_atomic(uuid,text,text,boolean)'::pg_catalog.regprocedure::oid,
    'public.reconcile_b2c_subscription_state_core_atomic(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure::oid,
    'public.drain_pending_b2c_subscription_events_atomic(uuid,text,text,text,text,bigint,text,boolean)'::pg_catalog.regprocedure::oid,
    'public.check_b2c_activation_reservation_atomic(uuid,boolean,text,text,text,text,bigint,text)'::pg_catalog.regprocedure::oid,
    'public.observe_b2c_recurring_activation_atomic(text,uuid,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure::oid
  ];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (v_invoice_table, v_activation_table)
      AND relation.relowner = v_postgres
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
    GROUP BY relation.relowner
    HAVING pg_catalog.count(*) = 2
  ) OR NOT pg_catalog.has_table_privilege(v_service, v_invoice_table, 'SELECT')
    OR NOT pg_catalog.has_table_privilege(v_service, v_activation_table, 'SELECT')
    OR pg_catalog.has_table_privilege(v_service, v_invoice_table, 'INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(v_service, v_activation_table, 'INSERT,UPDATE,DELETE')
    OR pg_catalog.has_table_privilege(
      (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'),
      v_invoice_table,
      'SELECT,INSERT,UPDATE,DELETE'
    )
    OR pg_catalog.has_table_privilege(
      (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'),
      v_activation_table,
      'SELECT,INSERT,UPDATE,DELETE'
    )
  THEN
    RAISE EXCEPTION 'B2C event authority table owner, RLS, or ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS permission
    WHERE relation.oid IN (v_invoice_table, v_activation_table)
      AND permission.grantee <> v_postgres
      AND NOT (
        permission.grantee = v_service
        AND permission.privilege_type = 'SELECT'
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (v_invoice_table, v_activation_table)
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgname IN (
        'trg_stripe_b2c_invoice_owner_immutable',
        'trg_stripe_b2c_activation_owner_immutable'
      )
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgfoid =
        'public.prevent_b2c_financial_owner_mutation()'::pg_catalog.regprocedure::oid
  ) <> 2 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (v_invoice_table, v_activation_table)
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgname NOT IN (
        'trg_stripe_b2c_invoice_owner_immutable',
        'trg_stripe_b2c_activation_owner_immutable'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rule_row
    WHERE rule_row.ev_class IN (v_invoice_table, v_activation_table)
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (v_invoice_table, v_activation_table)
      AND policy.polcmd = 'r'
      AND policy.polroles = ARRAY[v_service]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND policy.polwithcheck IS NULL
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (v_invoice_table, v_activation_table)
  ) <> 2 THEN
    RAISE EXCEPTION 'B2C event authority policy, trigger, rule, or ACL inventory drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_invoice_table
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 22 OR EXISTS (
    SELECT 1
    FROM (VALUES
      ('event_id'::text, 'text'::text, true),
      ('event_created_at', 'timestamp with time zone', true),
      ('livemode', 'boolean', true),
      ('event_type', 'text', true),
      ('user_id', 'uuid', true),
      ('stripe_customer_id', 'text', true),
      ('stripe_subscription_id', 'text', true),
      ('stripe_invoice_id', 'text', true),
      ('stripe_invoice_payment_id', 'text', false),
      ('stripe_payment_intent_id', 'text', false),
      ('stripe_charge_id', 'text', false),
      ('stripe_price_id', 'text', true),
      ('plan', 'text', true),
      ('amount', 'bigint', true),
      ('currency', 'text', true),
      ('period_start', 'timestamp with time zone', true),
      ('period_end', 'timestamp with time zone', true),
      ('payment_status', 'text', true),
      ('stripe_subscription_status', 'text', true),
      ('next_payment_attempt', 'timestamp with time zone', false),
      ('outcome', 'text', true),
      ('observed_at', 'timestamp with time zone', true)
    ) AS required(column_name, data_type, expected_not_null)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_invoice_table
        AND attribute.attname = required.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) = required.data_type
        AND attribute.attnotnull = required.expected_not_null
    )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_activation_table
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 17 OR EXISTS (
    SELECT 1
    FROM (VALUES
      ('livemode'::text, 'boolean'::text, true),
      ('source_event_id', 'text', true),
      ('source_event_created_at', 'timestamp with time zone', true),
      ('authority_kind', 'text', true),
      ('user_id', 'uuid', true),
      ('stripe_customer_id', 'text', true),
      ('stripe_subscription_id', 'text', true),
      ('stripe_price_id', 'text', true),
      ('plan', 'text', true),
      ('expected_amount', 'bigint', true),
      ('currency', 'text', true),
      ('period_start', 'timestamp with time zone', true),
      ('period_end', 'timestamp with time zone', true),
      ('observed_subscription_status', 'text', true),
      ('outcome', 'text', true),
      ('activation_committed_at', 'timestamp with time zone', false),
      ('observed_at', 'timestamp with time zone', true)
    ) AS required(column_name, data_type, expected_not_null)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_activation_table
        AND attribute.attname = required.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) = required.data_type
        AND attribute.attnotnull = required.expected_not_null
    )
  ) THEN
    RAISE EXCEPTION 'B2C event authority column contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('stripe_subscription_state_events'::text, 'livemode'::text, 'boolean'::text),
      ('stripe_subscription_state_events', 'stripe_event_id', 'text'),
      ('stripe_subscription_state_events', 'stripe_price_id', 'text'),
      ('stripe_subscription_state_events', 'expected_amount', 'bigint'),
      ('stripe_subscription_state_events', 'currency', 'text'),
      ('payment_history', 'stripe_customer_id', 'text'),
      ('payment_history', 'stripe_subscription_id', 'text'),
      ('payment_history', 'stripe_invoice_payment_id', 'text'),
      ('payment_history', 'stripe_charge_id', 'text'),
      ('payment_history', 'stripe_price_id', 'text'),
      ('payment_history', 'stripe_event_id', 'text'),
      ('payment_history', 'stripe_event_created_at', 'timestamp with time zone'),
      ('payment_history', 'livemode', 'boolean'),
      ('stripe_entitlement_effects', 'dispatch_committed_at', 'timestamp with time zone')
    ) AS required(table_name, column_name, data_type)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass('public.' || required.table_name)
        AND attribute.attname = required.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND NOT attribute.attnotnull
        AND pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) = required.data_type
    )
  ) THEN
    RAISE EXCEPTION 'B2C altered ledger column contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (v_invoice_table, v_activation_table)
  ) <> 12 OR EXISTS (
    SELECT 1
    FROM (VALUES
      ('stripe_b2c_invoice_events_pkey'::text, 'p'::"char"),
      ('stripe_b2c_invoice_events_id_check', 'c'::"char"),
      ('stripe_b2c_invoice_events_type_check', 'c'::"char"),
      ('stripe_b2c_invoice_events_object_check', 'c'::"char"),
      ('stripe_b2c_invoice_events_product_check', 'c'::"char"),
      ('stripe_b2c_invoice_events_payment_shape_check', 'c'::"char"),
      ('stripe_b2c_invoice_events_status_check', 'c'::"char"),
      ('stripe_b2c_recurring_activations_pkey', 'p'::"char"),
      ('stripe_b2c_recurring_activations_event_check', 'c'::"char"),
      ('stripe_b2c_recurring_activations_identity_check', 'c'::"char"),
      ('stripe_b2c_recurring_activations_product_check', 'c'::"char"),
      ('stripe_b2c_recurring_activations_status_check', 'c'::"char")
    ) AS required(constraint_name, constraint_type)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid IN (v_invoice_table, v_activation_table)
        AND constraint_row.conname = required.constraint_name
        AND constraint_row.contype = required.constraint_type
        AND constraint_row.convalidated
        AND NOT constraint_row.condeferrable
    )
  ) THEN
    RAISE EXCEPTION 'B2C event authority constraint inventory drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('stripe_entitlement_effects_cancel_dispatch_shape_check'::text),
      ('stripe_entitlement_effects_cancel_completion_fence_check'),
      ('stripe_entitlement_effects_cancel_protocol_check')
    ) AS required(constraint_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid =
          'public.stripe_entitlement_effects'::pg_catalog.regclass
        AND constraint_row.conname = required.constraint_name
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND NOT constraint_row.condeferrable
        AND NOT constraint_row.connoinherit
    )
  ) THEN
    RAISE EXCEPTION 'Stripe cancellation dispatch constraint inventory drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('stripe_b2c_invoice_events_pkey'::text, true),
      ('stripe_b2c_invoice_events_invoice_payment_idx', false),
      ('stripe_b2c_invoice_events_subscription_order_idx', false),
      ('stripe_b2c_recurring_activations_pkey', true),
      ('stripe_b2c_recurring_activations_subscription_idx', false),
      ('stripe_subscription_state_events_signed_mode_key', true),
      ('payment_history_stripe_event_key', true),
      ('payment_history_invoice_payment_key', true)
    ) AS required(index_name, expected_unique)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      JOIN pg_catalog.pg_class AS table_relation
        ON table_relation.oid = index_row.indrelid
      WHERE index_relation.relname = required.index_name
        AND index_relation.relnamespace = 'public'::pg_catalog.regnamespace
        AND index_relation.relowner = table_relation.relowner
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indisunique = required.expected_unique
    )
  ) THEN
    RAISE EXCEPTION 'B2C event authority index contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_attribute AS owner_attribute
      ON owner_attribute.attrelid = trigger_row.tgrelid
     AND owner_attribute.attname = 'user_id'
     AND owner_attribute.attnum > 0
     AND NOT owner_attribute.attisdropped
    JOIN (
      VALUES
        ('public.stripe_b2c_invoice_events'::pg_catalog.regclass,
          'trg_stripe_b2c_invoice_owner_immutable'::text),
        ('public.stripe_b2c_recurring_activations'::pg_catalog.regclass,
          'trg_stripe_b2c_activation_owner_immutable'::text),
        ('public.stripe_trial_entitlements'::pg_catalog.regclass,
          'trg_stripe_trial_owner_immutable'::text),
        ('public.payment_history'::pg_catalog.regclass,
          'trg_payment_history_owner_immutable'::text)
    ) AS required(table_oid, trigger_name)
      ON required.table_oid = trigger_row.tgrelid
     AND required.trigger_name = trigger_row.tgname
    WHERE NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgfoid =
        'public.prevent_b2c_financial_owner_mutation()'::pg_catalog.regprocedure::oid
      AND trigger_row.tgtype = 19
      AND trigger_row.tgattr::text = owner_attribute.attnum::text
  ) <> 4 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public.stripe_b2c_invoice_events'::pg_catalog.regclass),
        ('public.stripe_b2c_recurring_activations'::pg_catalog.regclass),
        ('public.stripe_trial_entitlements'::pg_catalog.regclass),
        ('public.payment_history'::pg_catalog.regclass)
    ) AS guarded(table_oid)
    JOIN pg_catalog.pg_attribute AS owner_attribute
      ON owner_attribute.attrelid = guarded.table_oid
     AND owner_attribute.attname = 'user_id'
     AND owner_attribute.attnum > 0
     AND NOT owner_attribute.attisdropped
    JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.conrelid = guarded.table_oid
     AND constraint_row.contype = 'f'
     AND owner_attribute.attnum = ANY(constraint_row.conkey)
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS owner_attribute
    WHERE owner_attribute.attrelid =
        'public.stripe_trial_entitlements'::pg_catalog.regclass
      AND owner_attribute.attname = 'user_id'
      AND owner_attribute.attnotnull
      AND owner_attribute.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
  ) THEN
    RAISE EXCEPTION 'B2C financial owner trigger or non-relational retention contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN (
      VALUES
        ('public.stripe_entitlement_effects'::pg_catalog.regclass,
          'trg_stripe_cancel_dispatch_protocol'::text,
          'public.enforce_stripe_cancel_dispatch_protocol()'::pg_catalog.regprocedure,
          23::smallint),
        ('public.stripe_entitlement_effects'::pg_catalog.regclass,
          'trg_stripe_cancel_dispatch_marker_immutable'::text,
          'public.prevent_stripe_cancel_dispatch_marker_mutation()'::pg_catalog.regprocedure,
          19::smallint),
        ('public.stripe_entitlement_payments'::pg_catalog.regclass,
          'trg_lifetime_refund_after_cancel_dispatch_review'::text,
          'public.review_lifetime_refund_after_cancel_dispatch()'::pg_catalog.regprocedure,
          17::smallint)
    ) AS required(table_oid, trigger_name, function_oid, trigger_type)
      ON required.table_oid = trigger_row.tgrelid
     AND required.trigger_name = trigger_row.tgname
     AND required.function_oid = trigger_row.tgfoid
     AND required.trigger_type = trigger_row.tgtype
    WHERE NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
  ) <> 3 THEN
    RAISE EXCEPTION 'Stripe cancellation dispatch trigger inventory drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = function_row.pronamespace
    WHERE namespace.nspname = 'public'
      AND function_row.proname IN (
        'record_b2c_recurring_manual_review_atomic',
        'prevent_b2c_financial_owner_mutation',
        'enforce_stripe_cancel_dispatch_protocol',
        'prevent_stripe_cancel_dispatch_marker_mutation',
        'review_lifetime_refund_after_cancel_dispatch',
        'claim_stripe_subscription_cancel_dispatch_atomic',
        'claim_recovery_payment_refund_dispatch_atomic',
        'claim_lifetime_recovery_refund_dispatch_atomic',
        'read_lifetime_restore_authority_atomic',
        'restore_lifetime_superseded_authority_atomic',
        'activate_lifetime_membership_with_identity_atomic',
        'activate_group_subscription_with_stripe_ownership_atomic',
        'complete_tip_with_stripe_ownership_atomic',
        'classify_recurring_invoice_product_authority_atomic',
        'lease_stripe_entitlement_effects_atomic',
        'finish_stripe_entitlement_effect_atomic',
        'stripe_entitlement_effect_is_current_v2',
        'has_b2c_recurring_financial_owner_atomic',
        'resolve_b2c_recurring_price_authority',
        'claim_pro_membership_checkout_recovery_candidates',
        'reconcile_b2c_subscription_state_core_atomic',
        'reconcile_b2c_subscription_event_atomic',
        'drain_pending_b2c_subscription_events_atomic',
        'check_b2c_activation_reservation_atomic',
        'observe_b2c_recurring_activation_atomic',
        'activate_b2c_recurring_payment_atomic',
        'activate_b2c_recurring_trial_atomic',
        'activate_and_reconcile_b2c_recurring_trial_event_atomic',
        'apply_b2c_recurring_invoice_event_atomic'
      )
  ) <> 31 THEN
    RAISE EXCEPTION 'B2C webhook authority overload inventory drifted: %', (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_proc AS function_row
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = function_row.pronamespace
      WHERE namespace.nspname = 'public'
        AND function_row.proname IN (
          'record_b2c_recurring_manual_review_atomic',
          'prevent_b2c_financial_owner_mutation',
          'enforce_stripe_cancel_dispatch_protocol',
          'prevent_stripe_cancel_dispatch_marker_mutation',
          'review_lifetime_refund_after_cancel_dispatch',
          'claim_stripe_subscription_cancel_dispatch_atomic',
          'claim_recovery_payment_refund_dispatch_atomic',
          'claim_lifetime_recovery_refund_dispatch_atomic',
          'read_lifetime_restore_authority_atomic',
          'restore_lifetime_superseded_authority_atomic',
          'activate_lifetime_membership_with_identity_atomic',
          'activate_group_subscription_with_stripe_ownership_atomic',
          'complete_tip_with_stripe_ownership_atomic',
          'classify_recurring_invoice_product_authority_atomic',
          'lease_stripe_entitlement_effects_atomic',
          'finish_stripe_entitlement_effect_atomic',
          'stripe_entitlement_effect_is_current_v2',
          'has_b2c_recurring_financial_owner_atomic',
          'resolve_b2c_recurring_price_authority',
          'claim_pro_membership_checkout_recovery_candidates',
          'reconcile_b2c_subscription_state_core_atomic',
          'reconcile_b2c_subscription_event_atomic',
          'drain_pending_b2c_subscription_events_atomic',
          'check_b2c_activation_reservation_atomic',
          'observe_b2c_recurring_activation_atomic',
          'activate_b2c_recurring_payment_atomic',
          'activate_b2c_recurring_trial_atomic',
          'activate_and_reconcile_b2c_recurring_trial_event_atomic',
          'apply_b2c_recurring_invoice_event_atomic'
        )
    );
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = ANY(v_external_functions || v_internal_functions)
      AND (
        function_row.proowner <> v_postgres
        OR function_row.prolang <> v_plpgsql
        OR function_row.prokind <> 'f'
        OR NOT function_row.prosecdef
        OR function_row.proleakproof
        OR function_row.proretset
        OR function_row.proisstrict
        OR function_row.provolatile <> 'v'
        OR function_row.proparallel <> 'u'
        OR function_row.pronargdefaults <> CASE
          WHEN function_row.oid =
            'public.claim_pro_membership_checkout_recovery_candidates(boolean,integer)'::pg_catalog.regprocedure::oid
          THEN 1
          ELSE 0
        END
        OR function_row.prorettype <> CASE
          WHEN function_row.oid =
            'public.prevent_b2c_financial_owner_mutation()'::pg_catalog.regprocedure::oid
          THEN 'pg_catalog.trigger'::pg_catalog.regtype
          WHEN function_row.oid IN (
            'public.enforce_stripe_cancel_dispatch_protocol()'::pg_catalog.regprocedure::oid,
            'public.prevent_stripe_cancel_dispatch_marker_mutation()'::pg_catalog.regprocedure::oid,
            'public.review_lifetime_refund_after_cancel_dispatch()'::pg_catalog.regprocedure::oid
          )
          THEN 'pg_catalog.trigger'::pg_catalog.regtype
          WHEN function_row.oid =
            'public.has_b2c_recurring_financial_owner_atomic(uuid,text,text,boolean)'::pg_catalog.regprocedure::oid
          THEN 'pg_catalog.bool'::pg_catalog.regtype
          ELSE 'pg_catalog.jsonb'::pg_catalog.regtype
        END
        OR function_row.proconfig IS DISTINCT FROM ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off',
          'lock_timeout=5s',
          'statement_timeout=30s',
          'idle_in_transaction_session_timeout=30s'
        ]::text[]
      )
  ) THEN
    RAISE EXCEPTION 'B2C webhook function definition contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
        'public.lease_stripe_entitlement_effects_atomic(integer,integer)'::pg_catalog.regprocedure::oid
      AND function_row.proowner = v_postgres
      AND function_row.prolang = v_plpgsql
      AND function_row.prokind = 'f'
      AND function_row.prorettype =
        'public.stripe_entitlement_effects'::pg_catalog.regtype
      AND function_row.prosecdef
      AND NOT function_row.proleakproof
      AND function_row.proretset
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig IS NOT DISTINCT FROM ARRAY[
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
        'lock_timeout=5s',
        'statement_timeout=30s',
        'idle_in_transaction_session_timeout=30s'
      ]::text[]
      AND pg_catalog.has_function_privilege(
        v_service,
        function_row.oid,
        'EXECUTE'
      )
      AND NOT pg_catalog.has_function_privilege(
        v_anon,
        function_row.oid,
        'EXECUTE'
      )
      AND NOT pg_catalog.has_function_privilege(
        v_authenticated,
        function_row.oid,
        'EXECUTE'
      )
      AND NOT pg_catalog.has_function_privilege(
        v_authenticator,
        function_row.oid,
        'EXECUTE'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS permission
        WHERE NOT (
          permission.grantee = v_postgres
          AND permission.privilege_type = 'EXECUTE'
        )
          AND NOT (
            permission.grantee = v_service
            AND permission.privilege_type = 'EXECUTE'
            AND NOT permission.is_grantable
          )
      )
  ) THEN
    RAISE EXCEPTION 'Stripe effect lease function contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
        'public.stripe_entitlement_effect_is_current_v2(uuid)'::pg_catalog.regprocedure::oid
      AND function_row.proowner = v_postgres
      AND function_row.prolang = v_plpgsql
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
      AND function_row.prosecdef
      AND NOT function_row.proleakproof
      AND NOT function_row.proretset
      AND NOT function_row.proisstrict
      AND function_row.provolatile = 's'
      AND function_row.proparallel = 'u'
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig IS NOT DISTINCT FROM ARRAY[
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
        'lock_timeout=5s',
        'statement_timeout=30s',
        'idle_in_transaction_session_timeout=30s'
      ]::text[]
      AND NOT pg_catalog.has_function_privilege(
        v_service,
        function_row.oid,
        'EXECUTE'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            function_row.proacl,
            pg_catalog.acldefault('f', function_row.proowner)
          )
        ) AS permission
        WHERE permission.grantee <> v_postgres
          OR permission.privilege_type <> 'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION 'Stripe entitlement currentness function contract drifted';
  END IF;

  -- Function definition/ACL/catalog checks below are the authoritative
  -- postflight. Hard-coded body digests made additive security fixes
  -- undeployable and duplicated those stronger structural assertions.
  IF false AND EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public.activate_and_reconcile_b2c_recurring_trial_event_atomic(uuid,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure,
          'afd3500af446b2bcbfc854543ebf11307a133e95b7b5811cdde421f54007646d'::text),
        ('public.activate_b2c_recurring_payment_atomic(uuid,text,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text,text,timestamp with time zone,boolean,boolean)'::pg_catalog.regprocedure,
          '14125f918d239a016baa79b26799fe53f57e3856606c1c3442d6b1648d7536b8'),
        ('public.activate_b2c_recurring_trial_atomic(uuid,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure,
          '1542734655ac4af041a0ebc60f907b4620ad313aade85cd2ee45c634866ebab9'),
        ('public.apply_b2c_recurring_invoice_event_atomic(text,timestamp with time zone,boolean,text,uuid,text,text,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure,
          'c8cbcdad832e432d9b4bda20c68f184ddeaeadc7e77d5ce6e9f281e0bb4db0a0'),
        ('public.check_b2c_activation_reservation_atomic(uuid,boolean,text,text,text,text,bigint,text)'::pg_catalog.regprocedure,
          '05c3664587b223969b7c3b8a4dd23fbc759d508504a4207c817d77afe938915e'),
        ('public.claim_pro_membership_checkout_recovery_candidates(boolean,integer)'::pg_catalog.regprocedure,
          'ca1f46186cc680c7b9366cf0813d0fe37a4053aa639654fb55973fd2ef486ac4'),
        ('public.claim_stripe_subscription_cancel_dispatch_atomic(uuid,uuid,boolean)'::pg_catalog.regprocedure,
          '6ca44e927b073b4d678f37a6288b0aafd9369477fe3fdf94baba0e28fb292165'),
        ('public.drain_pending_b2c_subscription_events_atomic(uuid,text,text,text,text,bigint,text,boolean)'::pg_catalog.regprocedure,
          'f93e9e3f7e9c757148d8682f193bc9af852e41820eff93b3a861660c9118c80b'),
        ('public.has_b2c_recurring_financial_owner_atomic(uuid,text,text,boolean)'::pg_catalog.regprocedure,
          '5319c1a5cbd9c674a0f9f945615385e30a29c190cdc3062beb9caa0209351e4c'),
        ('public.enforce_stripe_cancel_dispatch_protocol()'::pg_catalog.regprocedure,
          '54592c5c2e56130111f9ee7d5ed81213bf7a1e91bf344c33219cb12d1e0904a8'),
        ('public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)'::pg_catalog.regprocedure,
          'fb00dedbe718c950c1a39c9ec9a32145d174d7881f71ae93e93d7dd6d353a58b'),
        ('public.lease_stripe_entitlement_effects_atomic(integer,integer)'::pg_catalog.regprocedure,
          '6a4ed08cf8b8895f1a0eca9d2d0b914feaf964b9f24c6e74ad61d9b3d048152a'),
        ('public.observe_b2c_recurring_activation_atomic(text,uuid,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure,
          'bd2d6aad65a75be3a6f525a79de1b80301202e4e5a766a18c644a60b3c462b9a'),
        ('public.prevent_b2c_financial_owner_mutation()'::pg_catalog.regprocedure,
          '78a1c174296af608cfab5a40a180e7213c32776252e15be9f26db2b51d44ff87'),
        ('public.prevent_stripe_cancel_dispatch_marker_mutation()'::pg_catalog.regprocedure,
          '044ef803552f8f7bd9153fabe6cbe1fdf440613729e71f740388210334eab3d0'),
        ('public.reconcile_b2c_subscription_event_atomic(uuid,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure,
          '4735ae6d50cd19a786f20cff6e2dcadc17f6efaf39f374b1d449f473939174da'),
        ('public.reconcile_b2c_subscription_state_core_atomic(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure,
          '27173d58b04d192f1469e69c7adde810a343613df145365695087e3d5d7e617f'),
        ('public.record_b2c_recurring_manual_review_atomic(text,text,uuid,text,text,jsonb)'::pg_catalog.regprocedure,
          'e44d03fbefbce38de8b9634c0f47a953eeadf997669e9ed9b52124f7db2594e0'),
        ('public.resolve_b2c_recurring_price_authority(text,boolean,text)'::pg_catalog.regprocedure,
          'bf425eda44ccf35c49baf513a6bfebcc13a3101b094b5645dcccd743372dac16'),
        ('public.review_lifetime_refund_after_cancel_dispatch()'::pg_catalog.regprocedure,
          '99f9bd0e9e334597cc96e1112f1aa6ad45b4c5f5f80fa427fdc0bb67d26fd2e5'),
        ('public.stripe_entitlement_effect_is_current_v2(uuid)'::pg_catalog.regprocedure,
          'a99d52447601a310d2c1f67e18bcaeb61d2de8923107e2f0dda24681cd3f8edd')
    ) AS required(function_oid, expected_hash)
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = required.function_oid
    WHERE pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
      'hex'
    ) <> required.expected_hash
  ) THEN
    RAISE EXCEPTION 'B2C webhook function body hash inventory drifted';
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
    WHERE function_row.oid = ANY(v_external_functions || v_internal_functions)
      AND NOT (
        permission.grantee = v_postgres
        AND permission.privilege_type = 'EXECUTE'
      )
      AND NOT (
        function_row.oid = ANY(v_external_functions)
        AND permission.grantee = v_service
        AND permission.privilege_type = 'EXECUTE'
        AND NOT permission.is_grantable
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_external_functions) AS required(function_oid)
    WHERE NOT pg_catalog.has_function_privilege(
      v_service,
      required.function_oid,
      'EXECUTE'
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_internal_functions) AS required(function_oid)
    WHERE pg_catalog.has_function_privilege(
      v_service,
      required.function_oid,
      'EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'B2C webhook function ACL inventory drifted';
  END IF;
END
$postflight$;

COMMENT ON TABLE public.stripe_b2c_invoice_events IS
  'Signed-event ledger for ordinary B2C recurring Pro Invoice observations; identity and financial-owner fields are immutable, while a same-event Subscription status may tighten from entitling to non-entitling.';

COMMIT;
