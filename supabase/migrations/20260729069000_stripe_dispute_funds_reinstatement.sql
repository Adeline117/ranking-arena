-- A won Stripe dispute returns funds to the account. Preserve that immutable
-- balance event, neutralize any cancellation that has not started, and restore
-- only the exact payment-owned benefit. A succeeded full refund remains an
-- independent terminal reversal and always wins over dispute reinstatement.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_required_relation text;
  v_required_function text;
BEGIN
  FOREACH v_required_relation IN ARRAY ARRAY[
    'public.stripe_charge_dispute_events',
    'public.stripe_charge_dispute_projections',
    'public.stripe_payment_ownerships',
    'public.api_tier_reversal_actions',
    'public.stripe_charge_refund_tombstones',
    'public.stripe_entitlement_payments',
    'public.stripe_api_tier_payments',
    'public.api_tier_stripe_event_ledger',
    'public.api_tier_checkout_reservations',
    'public.api_tier_subscription_blocks',
    'public.tips',
    'public.tip_completion_notification_deliveries',
    'public.notifications',
    'public.posts',
    'public.user_profiles',
    'public.pro_entitlement_grants',
    'public.subscriptions',
    'public.group_payment_consumptions',
    'public.group_subscriptions',
    'public.group_members',
    'public.group_trial_consumptions',
    'public.groups',
    'public.group_bans'
  ]
  LOOP
    IF pg_catalog.to_regclass(v_required_relation) IS NULL THEN
      RAISE EXCEPTION
        'Stripe dispute reinstatement prerequisite is missing: %',
        v_required_relation;
    END IF;
  END LOOP;

  FOREACH v_required_function IN ARRAY ARRAY[
    'public.prevent_stripe_dispute_audit_mutation()',
    'public.stripe_payment_ownership_is_exact_v2(uuid)',
    'public.project_stripe_charge_dispute_ownership_atomic(uuid,boolean,text)',
    'public.record_api_tier_dispute_reversal_atomic(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)',
    'public.apply_user_api_tier_stripe_event(uuid,uuid,uuid,text,uuid,text,text,integer,text,bigint,text,bigint,boolean,boolean,boolean,text,text,text,text)',
    'public.record_stripe_manual_review_atomic(text,text,uuid,text,text,jsonb)',
    'public.prevent_tip_payment_identity_mutation()',
    'public.prevent_tip_notification_delivery_mutation()',
    'public.sync_current_pro_projection_atomic(uuid)',
    'public.stripe_paid_launch_readiness_v2()'
  ]
  LOOP
    IF pg_catalog.to_regprocedure(v_required_function) IS NULL THEN
      RAISE EXCEPTION
        'Stripe dispute reinstatement function is missing: %',
        v_required_function;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass(
      'public.stripe_charge_dispute_reinstatement_events'
    ) IS NOT NULL
    OR pg_catalog.to_regclass(
      'public.stripe_charge_dispute_reinstatement_projections'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.record_api_tier_dispute_reversal_pre_reinstatement_v2(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)'
    ) IS NOT NULL
  THEN
    RAISE EXCEPTION
      'Stripe dispute reinstatement authority already exists; audit before replay';
  END IF;
END
$preflight$;

LOCK TABLE
  public.stripe_charge_dispute_events,
  public.stripe_charge_dispute_projections,
  public.stripe_payment_ownerships,
  public.api_tier_reversal_actions
IN ACCESS EXCLUSIVE MODE;

CREATE TABLE public.stripe_charge_dispute_reinstatement_events (
  livemode boolean NOT NULL,
  stripe_event_id text NOT NULL,
  stripe_event_created bigint NOT NULL,
  stripe_dispute_id text NOT NULL,
  dispute_status text NOT NULL,
  dispute_reason text NOT NULL,
  dispute_amount bigint NOT NULL,
  currency text NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_payment_intent_id text,
  stripe_charge_id text NOT NULL,
  captured_amount bigint NOT NULL,
  refund_succeeded_amount bigint NOT NULL,
  recorded_at timestamptz NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_charge_dispute_reinstatement_events_pkey
    PRIMARY KEY (livemode, stripe_event_id),
  CONSTRAINT stripe_charge_dispute_reinstatement_dispute_key
    UNIQUE (livemode, stripe_dispute_id),
  CONSTRAINT stripe_charge_dispute_reinstatement_event_shape
    CHECK (
      stripe_event_id ~ '^evt_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_event_id) <= 255
      AND stripe_event_created > 0
      AND stripe_event_created <= 253402300799
    ),
  CONSTRAINT stripe_charge_dispute_reinstatement_dispute_shape
    CHECK (
      stripe_dispute_id ~ '^dp_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_dispute_id) <= 255
      AND dispute_status = 'won'
      AND pg_catalog.length(dispute_reason) BETWEEN 1 AND 100
    ),
  CONSTRAINT stripe_charge_dispute_reinstatement_payment_shape
    CHECK (
      stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_customer_id) <= 255
      AND (
        stripe_payment_intent_id IS NULL
        OR (
          stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
          AND pg_catalog.length(stripe_payment_intent_id) <= 255
        )
      )
      AND stripe_charge_id ~ '^ch_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_charge_id) <= 255
    ),
  CONSTRAINT stripe_charge_dispute_reinstatement_amount_shape
    CHECK (
      dispute_amount > 0
      AND captured_amount > 0
      AND dispute_amount <= captured_amount
      AND refund_succeeded_amount BETWEEN 0 AND captured_amount
      AND currency ~ '^[a-z]{3}$'
    )
);

CREATE INDEX stripe_charge_dispute_reinstatement_charge_idx
  ON public.stripe_charge_dispute_reinstatement_events (
    livemode,
    stripe_charge_id,
    stripe_event_created,
    stripe_event_id
  );

ALTER TABLE public.stripe_charge_dispute_reinstatement_events
  OWNER TO postgres;
ALTER TABLE public.stripe_charge_dispute_reinstatement_events
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_charge_dispute_reinstatement_events
  NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE
  public.stripe_charge_dispute_reinstatement_events
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TABLE public.stripe_charge_dispute_reinstatement_projections (
  livemode boolean NOT NULL,
  stripe_event_id text NOT NULL,
  ownership_id uuid NOT NULL,
  product_kind text NOT NULL,
  result jsonb NOT NULL,
  projected_at timestamptz NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_charge_dispute_reinstatement_projections_pkey
    PRIMARY KEY (livemode, stripe_event_id),
  CONSTRAINT stripe_charge_dispute_reinstatement_projection_event_fkey
    FOREIGN KEY (livemode, stripe_event_id)
    REFERENCES public.stripe_charge_dispute_reinstatement_events(
      livemode,
      stripe_event_id
    )
    ON DELETE RESTRICT,
  CONSTRAINT stripe_dispute_reinstatement_projection_owner_fkey
    FOREIGN KEY (ownership_id)
    REFERENCES public.stripe_payment_ownerships(id)
    ON DELETE RESTRICT,
  CONSTRAINT stripe_charge_dispute_reinstatement_projection_kind_check
    CHECK (
      product_kind IN (
        'pro_entitlement',
        'tip',
        'group_pass',
        'api_tier'
      )
    ),
  CONSTRAINT stripe_charge_dispute_reinstatement_projection_result_check
    CHECK (
      pg_catalog.jsonb_typeof(result) = 'object'
      AND result ? 'status'
    )
);

CREATE INDEX stripe_charge_dispute_reinstatement_projection_owner_idx
  ON public.stripe_charge_dispute_reinstatement_projections (
    ownership_id,
    projected_at,
    stripe_event_id
  );

ALTER TABLE public.stripe_charge_dispute_reinstatement_projections
  OWNER TO postgres;
ALTER TABLE public.stripe_charge_dispute_reinstatement_projections
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_charge_dispute_reinstatement_projections
  NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE
  public.stripe_charge_dispute_reinstatement_projections
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TRIGGER trg_stripe_charge_dispute_reinstatement_events_immutable
  BEFORE UPDATE OR DELETE
  ON public.stripe_charge_dispute_reinstatement_events
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_dispute_audit_mutation();
CREATE TRIGGER
  trg_stripe_charge_dispute_reinstatement_projections_immutable
  BEFORE UPDATE OR DELETE
  ON public.stripe_charge_dispute_reinstatement_projections
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_dispute_audit_mutation();

ALTER TABLE public.api_tier_reversal_actions
  DROP CONSTRAINT api_tier_reversal_actions_state_check,
  ADD CONSTRAINT api_tier_reversal_actions_state_check
    CHECK (
      (
        state = 'pending'
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
        AND completed_disposition IS NULL
        AND completed_at IS NULL
      )
      OR (
        state = 'leased'
        AND lease_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND completed_disposition IS NULL
        AND completed_at IS NULL
      )
      OR (
        state = 'completed'
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
        AND completed_disposition IN (
          'canceled',
          'already_canceled',
          'resource_missing',
          'funds_reinstated'
        )
        AND completed_at IS NOT NULL
      )
    );

CREATE OR REPLACE FUNCTION
  public.stripe_dispute_reinstatement_matches_payment_v2(
    p_ownership_id uuid,
    p_livemode boolean,
    p_stripe_event_id text
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_ownership_id IS NOT NULL
    AND p_livemode IS NOT NULL
    AND p_stripe_event_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.stripe_payment_ownerships AS ownership
      JOIN public.stripe_charge_dispute_reinstatement_events
        AS reinstatement
        ON reinstatement.livemode = ownership.livemode
       AND reinstatement.stripe_charge_id =
         ownership.stripe_charge_id
       AND reinstatement.stripe_customer_id =
         ownership.stripe_customer_id
       AND reinstatement.stripe_payment_intent_id
         IS NOT DISTINCT FROM ownership.stripe_payment_intent_id
       AND reinstatement.captured_amount = ownership.amount_paid
       AND reinstatement.currency = ownership.currency
      JOIN public.stripe_charge_dispute_events AS dispute
        ON dispute.livemode = reinstatement.livemode
       AND dispute.stripe_dispute_id =
         reinstatement.stripe_dispute_id
       AND dispute.stripe_charge_id =
         reinstatement.stripe_charge_id
       AND dispute.stripe_customer_id =
         reinstatement.stripe_customer_id
       AND dispute.stripe_payment_intent_id
         IS NOT DISTINCT FROM reinstatement.stripe_payment_intent_id
       AND dispute.captured_amount = reinstatement.captured_amount
       AND dispute.currency = reinstatement.currency
       AND dispute.dispute_amount = reinstatement.dispute_amount
       AND dispute.dispute_reason = reinstatement.dispute_reason
      WHERE ownership.id = p_ownership_id
        AND reinstatement.livemode = p_livemode
        AND reinstatement.stripe_event_id = p_stripe_event_id
        AND reinstatement.dispute_status = 'won'
        AND public.stripe_payment_ownership_is_exact_v2(
          ownership.id
        )
    )
$function$;

ALTER FUNCTION
  public.stripe_dispute_reinstatement_matches_payment_v2(
  uuid, boolean, text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.stripe_dispute_reinstatement_matches_payment_v2(
    uuid, boolean, text
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.stripe_dispute_reinstatement_is_exact_v2(
    p_ownership_id uuid,
    p_livemode boolean,
    p_stripe_event_id text
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT public.stripe_dispute_reinstatement_matches_payment_v2(
      p_ownership_id,
      p_livemode,
      p_stripe_event_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.stripe_charge_dispute_reinstatement_events
        AS reinstatement
      WHERE reinstatement.livemode = p_livemode
        AND reinstatement.stripe_event_id = p_stripe_event_id
        AND reinstatement.refund_succeeded_amount <
          reinstatement.captured_amount
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.stripe_payment_ownerships AS ownership
      JOIN public.stripe_charge_refund_tombstones AS refund
        ON refund.livemode = ownership.livemode
       AND refund.stripe_charge_id =
         ownership.stripe_charge_id
       AND refund.stripe_customer_id =
         ownership.stripe_customer_id
       AND refund.stripe_payment_intent_id
         IS NOT DISTINCT FROM
           ownership.stripe_payment_intent_id
       AND refund.amount_paid = ownership.amount_paid
       AND refund.currency = ownership.currency
       AND refund.refund_state = 'succeeded'
       AND refund.refund_succeeded_amount >= refund.amount_paid
      WHERE ownership.id = p_ownership_id
    )
$function$;

ALTER FUNCTION public.stripe_dispute_reinstatement_is_exact_v2(
  uuid, boolean, text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.stripe_dispute_reinstatement_is_exact_v2(
    uuid, boolean, text
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.stripe_payment_ownership_has_active_dispute_v3(
    p_ownership_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_ownership_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.stripe_charge_dispute_projections AS projection
      WHERE projection.ownership_id = p_ownership_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.stripe_charge_dispute_reinstatement_events
            AS reinstatement
          WHERE public.stripe_dispute_reinstatement_is_exact_v2(
            p_ownership_id,
            reinstatement.livemode,
            reinstatement.stripe_event_id
          )
        )
    )
$function$;

ALTER FUNCTION
  public.stripe_payment_ownership_has_active_dispute_v3(uuid)
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.stripe_payment_ownership_has_active_dispute_v3(uuid)
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.group_pass_has_nondisputed_current_authority_v3(
    p_group_id uuid,
    p_user_id uuid,
    p_excluded_ownership_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_group_id IS NOT NULL
    AND p_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.group_subscriptions AS subscription
      WHERE subscription.group_id = p_group_id
        AND subscription.user_id = p_user_id
        AND subscription.status IN ('active', 'trialing')
        AND subscription.expires_at >
          pg_catalog.statement_timestamp()
        AND (
          (
            subscription.status = 'trialing'
            AND subscription.tier = 'trial'
            AND EXISTS (
              SELECT 1
              FROM public.group_trial_consumptions AS trial
              WHERE trial.group_id = subscription.group_id
                AND trial.user_id = subscription.user_id
                AND trial.subscription_id = subscription.id
            )
          )
          OR (
            subscription.status = 'active'
            AND subscription.payment_provider = 'stripe'
            AND EXISTS (
              SELECT 1
              FROM public.group_payment_consumptions AS consumption
              JOIN public.stripe_payment_ownerships AS ownership
                ON ownership.product_kind = 'group_pass'
               AND ownership.ledger_id = consumption.id
              WHERE consumption.subscription_id = subscription.id
                AND consumption.group_id = subscription.group_id
                AND consumption.user_id = subscription.user_id
                AND consumption.outcome IN ('activated', 'renewed')
                AND ownership.id IS DISTINCT FROM
                  p_excluded_ownership_id
                AND subscription.payment_reference =
                  'stripe:' || consumption.payment_intent_id
                AND public.stripe_payment_ownership_is_exact_v2(
                  ownership.id
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.stripe_charge_refund_tombstones
                    AS refund
                  WHERE refund.stripe_charge_id =
                      ownership.stripe_charge_id
                    AND refund.refund_state = 'succeeded'
                    AND refund.refund_succeeded_amount >=
                      refund.amount_paid
                )
                AND NOT
                  public.stripe_payment_ownership_has_active_dispute_v3(
                    ownership.id
                  )
            )
          )
        )
    )
$function$;

ALTER FUNCTION
  public.group_pass_has_nondisputed_current_authority_v3(
    uuid, uuid, uuid
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.group_pass_has_nondisputed_current_authority_v3(
    uuid, uuid, uuid
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.stripe_subscription_has_exact_payment_binding_v2(
    p_user_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.subscriptions AS subscription
      JOIN public.stripe_entitlement_payments AS payment
        ON payment.id = subscription.entitlement_payment_id
       AND payment.user_id = subscription.user_id
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.product_kind = 'pro_entitlement'
       AND ownership.ledger_id = payment.id
      WHERE subscription.user_id = p_user_id
        AND subscription.tier = 'pro'
        AND payment.livemode IS TRUE
        AND payment.payment_status IN ('paid', 'succeeded')
        AND public.stripe_payment_ownership_is_exact_v2(
          ownership.id
        )
        AND NOT
          public.stripe_payment_ownership_has_active_dispute_v3(
            ownership.id
          )
        AND NOT (
          payment.refund_state = 'succeeded'
          AND payment.refund_succeeded_amount >= payment.amount_paid
        )
        AND (
          (
            subscription.plan IN ('monthly', 'yearly')
            AND subscription.status IN ('active', 'trialing')
            AND payment.payment_kind = 'recurring'
            AND payment.plan = subscription.plan
            AND payment.stripe_customer_id =
              subscription.stripe_customer_id
            AND payment.stripe_subscription_id =
              subscription.stripe_subscription_id
            AND payment.period_start =
              subscription.current_period_start
            AND payment.period_end =
              subscription.current_period_end
            AND subscription.current_period_end
              > pg_catalog.statement_timestamp()
          )
          OR (
            subscription.plan = 'lifetime'
            AND subscription.status = 'active'
            AND payment.payment_kind = 'lifetime'
            AND payment.plan = 'lifetime'
            AND payment.stripe_customer_id =
              subscription.stripe_customer_id
            AND payment.checkout_session_id =
              subscription.stripe_subscription_id
            AND payment.period_start =
              subscription.current_period_start
            AND payment.period_end IS NULL
            AND subscription.current_period_end IS NULL
          )
        )
    )
$function$;

ALTER FUNCTION
  public.stripe_subscription_has_exact_payment_binding_v2(uuid)
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.stripe_subscription_has_exact_payment_binding_v2(uuid)
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.guard_stripe_derived_pro_grant_livemode()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.revoked_at IS NOT NULL
    OR NEW.source NOT IN (
      'stripe_lifetime_payment',
      'stripe_payment_retry_grace'
    )
  THEN
    RETURN NEW;
  END IF;

  IF NEW.source = 'stripe_lifetime_payment'
    AND EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.product_kind = 'pro_entitlement'
       AND ownership.ledger_id = payment.id
      WHERE payment.user_id = NEW.user_id
        AND payment.payment_kind = 'lifetime'
        AND payment.plan = 'lifetime'
        AND payment.livemode IS TRUE
        AND NEW.source_key = 'payment:' || payment.id::text
        AND NEW.metadata ->> 'payment_id' = payment.id::text
        AND public.stripe_payment_ownership_is_exact_v2(
          ownership.id
        )
        AND NOT
          public.stripe_payment_ownership_has_active_dispute_v3(
            ownership.id
          )
        AND NOT (
          payment.refund_state = 'succeeded'
          AND payment.refund_succeeded_amount >= payment.amount_paid
        )
    )
  THEN
    RETURN NEW;
  END IF;

  IF NEW.source = 'stripe_payment_retry_grace'
    AND pg_catalog.current_setting(
      'arena.stripe_livemode',
      true
    ) = 'true'
    AND EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.product_kind = 'pro_entitlement'
       AND ownership.ledger_id = payment.id
      WHERE payment.user_id = NEW.user_id
        AND payment.payment_kind = 'recurring'
        AND payment.livemode IS TRUE
        AND payment.stripe_subscription_id =
          NEW.metadata ->> 'stripe_subscription_id'
        AND public.stripe_payment_ownership_is_exact_v2(
          ownership.id
        )
        AND NOT
          public.stripe_payment_ownership_has_active_dispute_v3(
            ownership.id
          )
        AND NOT (
          payment.refund_state = 'succeeded'
          AND payment.refund_succeeded_amount >= payment.amount_paid
        )
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Stripe-derived Pro grant lacks live paid authority'
    USING ERRCODE = '23514';
END
$function$;

ALTER FUNCTION
  public.guard_stripe_derived_pro_grant_livemode()
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.guard_stripe_derived_pro_grant_livemode()
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.activate_recurring_entitlement_payment_atomic(
    p_user_id uuid,
    p_stripe_customer_id text,
    p_stripe_subscription_id text,
    p_stripe_invoice_id text,
    p_stripe_payment_intent_id text,
    p_stripe_charge_id text,
    p_plan text,
    p_amount_paid bigint,
    p_currency text,
    p_period_start timestamptz,
    p_period_end timestamptz,
    p_payment_status text,
    p_stripe_subscription_status text,
    p_livemode boolean
  )
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_result jsonb;
  v_blocked_ownership_id uuid;
  v_dispute_event_id text;
  v_projection jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  SELECT
    action.ownership_id,
    projection.stripe_event_id
  INTO v_blocked_ownership_id, v_dispute_event_id
  FROM public.api_tier_reversal_actions AS action
  JOIN public.stripe_charge_dispute_projections AS projection
    ON projection.ownership_id = action.ownership_id
   AND projection.product_kind = 'pro_entitlement'
   AND projection.livemode = action.livemode
  WHERE action.product_kind = 'pro_entitlement'
    AND action.livemode = p_livemode
    AND action.stripe_subscription_id =
      p_stripe_subscription_id
    AND public.stripe_payment_ownership_has_active_dispute_v3(
      action.ownership_id
    )
  ORDER BY projection.projected_at, projection.stripe_event_id
  LIMIT 1;

  v_result :=
    public.activate_recurring_entitlement_payment_pre_dispute_v2(
      p_user_id,
      p_stripe_customer_id,
      p_stripe_subscription_id,
      p_stripe_invoice_id,
      p_stripe_payment_intent_id,
      p_stripe_charge_id,
      p_plan,
      p_amount_paid,
      p_currency,
      p_period_start,
      p_period_end,
      p_payment_status,
      p_stripe_subscription_status,
      p_livemode
    );

  IF v_blocked_ownership_id IS NULL THEN
    RETURN v_result;
  END IF;

  v_projection :=
    public.project_stripe_charge_dispute_ownership_atomic(
      v_blocked_ownership_id,
      p_livemode,
      v_dispute_event_id
    );
  IF COALESCE(v_projection ->> 'status', '') IN (
    '',
    'identity_conflict',
    'manual_review',
    'not_found'
  ) THEN
    RAISE EXCEPTION
      'disputed Pro subscription could not be re-revoked'
      USING ERRCODE = '23514';
  END IF;

  IF COALESCE(v_result ->> 'status', '') IN (
    'identity_conflict',
    'manual_review',
    'parallel_subscription_review',
    'subject_deleted',
    'test_mode_non_entitling'
  ) THEN
    RETURN v_result;
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status',
    'refunded_payment'
  );
END
$function$;

ALTER FUNCTION
  public.activate_recurring_entitlement_payment_atomic(
    uuid, text, text, text, text, text, text, bigint, text,
    timestamptz, timestamptz, text, text, boolean
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.activate_recurring_entitlement_payment_atomic(
    uuid, text, text, text, text, text, text, bigint, text,
    timestamptz, timestamptz, text, text, boolean
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.activate_recurring_entitlement_payment_atomic(
    uuid, text, text, text, text, text, text, bigint, text,
    timestamptz, timestamptz, text, text, boolean
  )
TO service_role;

CREATE OR REPLACE FUNCTION
  public.reconcile_recurring_subscription_state_atomic(
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
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_result jsonb;
  v_blocked_ownership_id uuid;
  v_dispute_event_id text;
  v_projection jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  SELECT
    action.ownership_id,
    projection.stripe_event_id
  INTO v_blocked_ownership_id, v_dispute_event_id
  FROM public.api_tier_reversal_actions AS action
  JOIN public.stripe_charge_dispute_projections AS projection
    ON projection.ownership_id = action.ownership_id
   AND projection.product_kind = 'pro_entitlement'
   AND projection.livemode = action.livemode
  WHERE action.product_kind = 'pro_entitlement'
    AND action.livemode = p_livemode
    AND action.stripe_subscription_id =
      p_stripe_subscription_id
    AND public.stripe_payment_ownership_has_active_dispute_v3(
      action.ownership_id
    )
  ORDER BY projection.projected_at, projection.stripe_event_id
  LIMIT 1;

  v_result :=
    public.reconcile_recurring_subscription_state_pre_dispute_v2(
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
      p_event_id,
      p_event_created_at,
      p_livemode
    );

  IF v_blocked_ownership_id IS NULL THEN
    RETURN v_result;
  END IF;

  v_projection :=
    public.project_stripe_charge_dispute_ownership_atomic(
      v_blocked_ownership_id,
      p_livemode,
      v_dispute_event_id
    );
  IF COALESCE(v_projection ->> 'status', '') IN (
    '',
    'identity_conflict',
    'manual_review',
    'not_found'
  ) THEN
    RAISE EXCEPTION
      'disputed Pro state update could not be re-revoked'
      USING ERRCODE = '23514';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'revoked',
    'outcome', COALESCE(v_result ->> 'status', 'reconciled'),
    'financial_reversal', 'dispute'
  );
END
$function$;

ALTER FUNCTION
  public.reconcile_recurring_subscription_state_atomic(
    uuid, text, text, text, text, timestamptz, timestamptz, text,
    boolean, timestamptz, timestamptz, text, timestamptz, boolean
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.reconcile_recurring_subscription_state_atomic(
    uuid, text, text, text, text, timestamptz, timestamptz, text,
    boolean, timestamptz, timestamptz, text, timestamptz, boolean
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.reconcile_recurring_subscription_state_atomic(
    uuid, text, text, text, text, timestamptz, timestamptz, text,
    boolean, timestamptz, timestamptz, text, timestamptz, boolean
  )
TO service_role;

CREATE OR REPLACE FUNCTION
  public.neutralize_dispute_cancellation_for_reinstatement_atomic(
    p_ownership_id uuid
  )
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_subscription_id text;
  v_action public.api_tier_reversal_actions%ROWTYPE;
BEGIN
  IF p_ownership_id IS NULL THEN
    RETURN 'identity_conflict';
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = p_ownership_id;
  IF NOT FOUND
    OR v_ownership.product_kind NOT IN (
      'pro_entitlement',
      'api_tier'
    )
  THEN
    RETURN 'no_action';
  END IF;

  IF v_ownership.product_kind = 'pro_entitlement' THEN
    SELECT payment.stripe_subscription_id
    INTO v_subscription_id
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.id = v_ownership.ledger_id
      AND payment.payment_kind = 'recurring';
    IF NOT FOUND THEN
      RETURN 'no_action';
    END IF;
  ELSE
    SELECT payment.stripe_subscription_id
    INTO v_subscription_id
    FROM public.stripe_api_tier_payments AS payment
    WHERE payment.id = v_ownership.ledger_id;
    IF NOT FOUND THEN
      RETURN 'identity_conflict';
    END IF;
  END IF;

  SELECT action.*
  INTO v_action
  FROM public.api_tier_reversal_actions AS action
  WHERE action.product_kind = v_ownership.product_kind
    AND action.livemode = v_ownership.livemode
    AND action.stripe_subscription_id = v_subscription_id
    AND action.action_kind = 'cancel_subscription'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'identity_conflict';
  END IF;

  IF v_action.state = 'leased'
    AND v_action.lease_expires_at >
      pg_catalog.clock_timestamp()
  THEN
    RETURN 'action_in_flight';
  END IF;

  -- An expired lease has an unknown remote outcome: the Stripe cancellation
  -- may have succeeded before the worker lost its acknowledgement. Never
  -- convert that ambiguity into paid access automatically.
  IF v_action.state = 'leased' THEN
    RETURN 'manual_review';
  END IF;

  IF v_action.state = 'pending' THEN
    UPDATE public.api_tier_reversal_actions
    SET state = 'completed',
        lease_token = NULL,
        lease_expires_at = NULL,
        completed_disposition = 'funds_reinstated',
        completed_at = pg_catalog.clock_timestamp(),
        last_error = NULL,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_action.id;
    RETURN 'neutralized';
  END IF;

  IF v_action.state = 'completed' THEN
    IF v_action.completed_disposition = 'funds_reinstated' THEN
      RETURN 'already_completed:funds_reinstated';
    END IF;
    RETURN 'manual_review';
  END IF;
  RETURN 'identity_conflict';
END
$function$;

ALTER FUNCTION
  public.neutralize_dispute_cancellation_for_reinstatement_atomic(
    uuid
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.neutralize_dispute_cancellation_for_reinstatement_atomic(
    uuid
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- Preserve every existing Tip identity/lifecycle rule while admitting one
-- exact terminal transition: disputed -> won and not fully refunded.
CREATE OR REPLACE FUNCTION public.prevent_tip_payment_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF OLD.status IN ('completed', 'refunded', 'identity_conflict')
    AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND (
      NEW.post_id IS DISTINCT FROM OLD.post_id
      OR NEW.to_user_id IS DISTINCT FROM OLD.to_user_id
    )
    AND (
      NEW.post_id IS NOT DISTINCT FROM OLD.post_id
      OR (
        OLD.post_id IS NOT NULL
        AND NEW.post_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.posts AS deleted_post
          WHERE deleted_post.id = OLD.post_id
        )
      )
    )
    AND (
      NEW.to_user_id IS NOT DISTINCT FROM OLD.to_user_id
      OR (
        OLD.to_user_id IS NOT NULL
        AND NEW.to_user_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM auth.users AS deleted_recipient
          WHERE deleted_recipient.id = OLD.to_user_id
        )
      )
    )
    AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.from_user_id IS NOT DISTINCT FROM OLD.from_user_id
    AND NEW.amount_cents IS NOT DISTINCT FROM OLD.amount_cents
    AND NEW.stripe_checkout_session_id
      IS NOT DISTINCT FROM OLD.stripe_checkout_session_id
    AND NEW.stripe_payment_intent_id
      IS NOT DISTINCT FROM OLD.stripe_payment_intent_id
    AND NEW.stripe_charge_id IS NOT DISTINCT FROM OLD.stripe_charge_id
    AND NEW.stripe_customer_id IS NOT DISTINCT FROM OLD.stripe_customer_id
    AND NEW.currency IS NOT DISTINCT FROM OLD.currency
    AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
  THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'refunded'
    AND NEW.status = 'completed'
    AND pg_catalog.current_setting(
      'arena.stripe_dispute_reinstatement_tip_id',
      true
    ) = NEW.id::text
    AND pg_catalog.current_setting(
      'arena.stripe_dispute_reinstatement_event_id',
      true
    ) <> ''
    AND OLD.id = NEW.id
    AND OLD.post_id IS NOT DISTINCT FROM NEW.post_id
    AND OLD.from_user_id = NEW.from_user_id
    AND OLD.to_user_id IS NOT DISTINCT FROM NEW.to_user_id
    AND OLD.amount_cents = NEW.amount_cents
    AND OLD.stripe_checkout_session_id
      IS NOT DISTINCT FROM NEW.stripe_checkout_session_id
    AND OLD.stripe_payment_intent_id
      IS NOT DISTINCT FROM NEW.stripe_payment_intent_id
    AND OLD.stripe_charge_id IS NOT DISTINCT FROM NEW.stripe_charge_id
    AND OLD.stripe_customer_id
      IS NOT DISTINCT FROM NEW.stripe_customer_id
    AND OLD.currency IS NOT DISTINCT FROM NEW.currency
    AND OLD.completed_at IS NOT DISTINCT FROM NEW.completed_at
    AND EXISTS (
      SELECT 1
      FROM public.stripe_payment_ownerships AS ownership
      JOIN public.stripe_charge_dispute_reinstatement_events
        AS reinstatement
        ON reinstatement.stripe_event_id =
          pg_catalog.current_setting(
            'arena.stripe_dispute_reinstatement_event_id',
            true
          )
       AND public.stripe_dispute_reinstatement_is_exact_v2(
         ownership.id,
         reinstatement.livemode,
         reinstatement.stripe_event_id
       )
      WHERE ownership.product_kind = 'tip'
        AND ownership.ledger_id = NEW.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.stripe_payment_ownerships AS ownership
      JOIN public.stripe_charge_refund_tombstones AS refund
        ON refund.livemode = ownership.livemode
       AND refund.stripe_charge_id =
         ownership.stripe_charge_id
       AND refund.stripe_customer_id =
         ownership.stripe_customer_id
       AND refund.stripe_payment_intent_id
         IS NOT DISTINCT FROM
           ownership.stripe_payment_intent_id
       AND refund.amount_paid = ownership.amount_paid
       AND refund.currency = ownership.currency
       AND refund.refund_state = 'succeeded'
       AND refund.refund_succeeded_amount >=
         refund.amount_paid
      WHERE ownership.product_kind = 'tip'
        AND ownership.ledger_id = NEW.id
    )
  THEN
    RETURN NEW;
  END IF;

  -- A mixed-deploy legacy webhook can redeliver completion after the exact
  -- payment has already become refunded or quarantined. Preserve the stronger
  -- terminal state and original completion time while accepting the otherwise
  -- identical service replay.
  IF OLD.status IN ('refunded', 'identity_conflict')
    AND NEW.status = 'completed'
    AND COALESCE((SELECT auth.role()), '')
      IS NOT DISTINCT FROM 'service_role'
    AND OLD.id = NEW.id
    AND OLD.post_id IS NOT DISTINCT FROM NEW.post_id
    AND OLD.from_user_id = NEW.from_user_id
    AND OLD.to_user_id IS NOT DISTINCT FROM NEW.to_user_id
    AND OLD.amount_cents = NEW.amount_cents
    AND OLD.stripe_checkout_session_id
      IS NOT DISTINCT FROM NEW.stripe_checkout_session_id
    AND OLD.stripe_payment_intent_id
      IS NOT DISTINCT FROM NEW.stripe_payment_intent_id
    AND OLD.stripe_charge_id IS NOT DISTINCT FROM NEW.stripe_charge_id
    AND OLD.stripe_customer_id
      IS NOT DISTINCT FROM NEW.stripe_customer_id
    AND OLD.currency IS NOT DISTINCT FROM NEW.currency
  THEN
    NEW.status := OLD.status;
    NEW.completed_at := OLD.completed_at;
    RETURN NEW;
  END IF;

  IF (
      OLD.status = 'pending'
      AND NEW.status NOT IN ('pending', 'completed', 'failed')
    )
    OR (
      OLD.status = 'completed'
      AND NEW.status NOT IN (
        'completed',
        'refunded',
        'identity_conflict'
      )
    )
    OR (
      OLD.status IN ('failed', 'refunded', 'identity_conflict')
      AND NEW.status IS DISTINCT FROM OLD.status
    )
  THEN
    RAISE EXCEPTION 'tip payment status transition is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.stripe_checkout_session_id IS NOT NULL
    AND NEW.stripe_checkout_session_id
      IS DISTINCT FROM OLD.stripe_checkout_session_id
  THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-checkout-session:' || NEW.stripe_checkout_session_id,
        0
      )
    );
    IF EXISTS (
        SELECT 1
        FROM public.stripe_payment_ownerships AS ownership
        WHERE ownership.checkout_session_id =
          NEW.stripe_checkout_session_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.stripe_entitlement_payments AS payment
        WHERE payment.checkout_session_id =
          NEW.stripe_checkout_session_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.group_payment_consumptions AS consumption
        WHERE consumption.checkout_session_id =
          NEW.stripe_checkout_session_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.tips AS other_tip
        WHERE other_tip.stripe_checkout_session_id =
            NEW.stripe_checkout_session_id
          AND other_tip.id <> NEW.id
      )
    THEN
      RAISE EXCEPTION
        'tip Checkout Session is already owned by another payment'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- During the additive migration-first window, the legacy checkout webhook
  -- can replay the same completed tip while supplying a fresh wall-clock
  -- completed_at, before or after the exact writer binds Charge/Customer.
  -- Normalize the identical replay to the original terminal timestamp instead
  -- of turning a harmless Stripe redelivery into a permanent 23514 retry.
  IF OLD.status = 'completed'
    AND NEW.status = 'completed'
    AND COALESCE((SELECT auth.role()), '')
      IS NOT DISTINCT FROM 'service_role'
    AND OLD.stripe_charge_id IS NOT DISTINCT FROM NEW.stripe_charge_id
    AND OLD.stripe_customer_id
      IS NOT DISTINCT FROM NEW.stripe_customer_id
    AND OLD.currency IS NOT DISTINCT FROM NEW.currency
    AND OLD.id = NEW.id
    AND OLD.post_id IS NOT DISTINCT FROM NEW.post_id
    AND OLD.from_user_id = NEW.from_user_id
    AND OLD.to_user_id IS NOT DISTINCT FROM NEW.to_user_id
    AND OLD.amount_cents = NEW.amount_cents
    AND OLD.stripe_checkout_session_id
      IS NOT DISTINCT FROM NEW.stripe_checkout_session_id
    AND OLD.stripe_payment_intent_id
      IS NOT DISTINCT FROM NEW.stripe_payment_intent_id
  THEN
    NEW.completed_at := OLD.completed_at;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('completed', 'refunded', 'identity_conflict')
    AND (
      NEW.id IS DISTINCT FROM OLD.id
      OR NEW.post_id IS DISTINCT FROM OLD.post_id
      OR NEW.from_user_id IS DISTINCT FROM OLD.from_user_id
      OR NEW.to_user_id IS DISTINCT FROM OLD.to_user_id
      OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
      OR NEW.stripe_checkout_session_id
        IS DISTINCT FROM OLD.stripe_checkout_session_id
      OR NEW.stripe_payment_intent_id
        IS DISTINCT FROM OLD.stripe_payment_intent_id
      OR NEW.stripe_charge_id IS DISTINCT FROM OLD.stripe_charge_id
      OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    )
  THEN
    IF NOT (
      OLD.status = 'completed'
      AND NEW.status = 'completed'
      AND COALESCE((SELECT auth.role()), '')
        IS NOT DISTINCT FROM 'service_role'
      AND OLD.stripe_charge_id IS NULL
      AND OLD.stripe_customer_id IS NULL
      AND OLD.currency IS NULL
      AND NEW.stripe_charge_id IS NOT NULL
      AND NEW.stripe_customer_id IS NOT NULL
      AND NEW.currency IS NOT NULL
      AND OLD.id = NEW.id
      AND OLD.post_id IS NOT DISTINCT FROM NEW.post_id
      AND OLD.from_user_id = NEW.from_user_id
      AND OLD.to_user_id IS NOT DISTINCT FROM NEW.to_user_id
      AND OLD.amount_cents = NEW.amount_cents
      AND OLD.stripe_checkout_session_id
        IS NOT DISTINCT FROM NEW.stripe_checkout_session_id
      AND (
        OLD.stripe_payment_intent_id IS NULL
        OR OLD.stripe_payment_intent_id =
          NEW.stripe_payment_intent_id
      )
      AND (
        OLD.completed_at IS NULL
        OR OLD.completed_at = NEW.completed_at
      )
    ) THEN
      RAISE EXCEPTION 'completed tip payment identity is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.prevent_tip_payment_identity_mutation()
  OWNER TO postgres;

-- A dispute suppresses the original notification without deleting its durable
-- delivery identity. Reinstatement may reopen only that exact delivery after
-- the same won dispute has been matched to the same non-refunded payment.
CREATE OR REPLACE FUNCTION public.prevent_tip_notification_delivery_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tip completion notification deliveries are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.disposition = 'refund_suppressed'
    AND NEW.disposition = 'delivered'
    AND NEW.notification_id IS NOT NULL
    AND NEW.delivered_at IS NOT NULL
    AND NEW.disposed_at IS NULL
    AND pg_catalog.current_setting(
      'arena.stripe_dispute_reinstatement_tip_id',
      true
    ) = NEW.tip_id::text
    AND pg_catalog.current_setting(
      'arena.stripe_dispute_reinstatement_event_id',
      true
    ) <> ''
    AND (
      pg_catalog.to_jsonb(NEW)
        - 'notification_id'
        - 'delivered_at'
        - 'disposition'
        - 'disposed_at'
    ) IS NOT DISTINCT FROM (
      pg_catalog.to_jsonb(OLD)
        - 'notification_id'
        - 'delivered_at'
        - 'disposition'
        - 'disposed_at'
    )
    AND EXISTS (
      SELECT 1
      FROM public.tips AS tip
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.product_kind = 'tip'
       AND ownership.ledger_id = tip.id
      JOIN public.notifications AS notification
        ON notification.id = NEW.notification_id
       AND notification.type = 'tip_received'
       AND notification.reference_id = tip.id
       AND notification.user_id = NEW.recipient_user_id
       AND notification.actor_id = NEW.actor_user_id
       AND notification.title = NEW.title
       AND notification.message = NEW.message
       AND notification.link IS NOT DISTINCT FROM NEW.link
      WHERE tip.id = NEW.tip_id
        AND tip.status IN ('completed', 'refunded')
        AND EXISTS (
          SELECT 1
          FROM public.stripe_charge_dispute_reinstatement_events
            AS reinstatement
          WHERE reinstatement.stripe_event_id =
              pg_catalog.current_setting(
                'arena.stripe_dispute_reinstatement_event_id',
                true
              )
            AND public.stripe_dispute_reinstatement_is_exact_v2(
              ownership.id,
              reinstatement.livemode,
              reinstatement.stripe_event_id
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.stripe_charge_refund_tombstones AS refund
          WHERE refund.livemode = ownership.livemode
            AND refund.stripe_charge_id =
              ownership.stripe_charge_id
            AND refund.stripe_customer_id =
              ownership.stripe_customer_id
            AND refund.stripe_payment_intent_id
              IS NOT DISTINCT FROM
                ownership.stripe_payment_intent_id
            AND refund.amount_paid = ownership.amount_paid
            AND refund.currency = ownership.currency
            AND refund.refund_state = 'succeeded'
            AND refund.refund_succeeded_amount >=
              refund.amount_paid
        )
    )
  THEN
    RETURN NEW;
  END IF;

  IF (
    pg_catalog.to_jsonb(NEW) - 'disposition' - 'disposed_at'
  ) IS DISTINCT FROM (
    pg_catalog.to_jsonb(OLD) - 'disposition' - 'disposed_at'
  ) OR NEW.disposed_at IS NULL OR NOT (
    (
      OLD.disposition = 'delivered'
      AND NEW.disposition IN (
        'recipient_deleted',
        'authority_deleted',
        'refund_suppressed',
        'identity_conflict_suppressed'
      )
    )
    OR (
      OLD.disposition = 'recipient_deleted'
      AND NEW.disposition IN (
        'authority_deleted',
        'refund_suppressed',
        'identity_conflict_suppressed'
      )
    )
    OR (
      OLD.disposition = 'authority_deleted'
      AND NEW.disposition IN (
        'refund_suppressed',
        'identity_conflict_suppressed'
      )
    )
    OR (
      OLD.disposition = 'authority_unavailable'
      AND NEW.disposition IN (
        'refund_suppressed',
        'identity_conflict_suppressed'
      )
    )
  ) THEN
    RAISE EXCEPTION 'tip completion notification deliveries are immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.prevent_tip_notification_delivery_mutation()
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION
  public.project_stripe_charge_dispute_reinstatement_atomic(
    p_ownership_id uuid,
    p_livemode boolean,
    p_stripe_event_id text
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
AS $function$
DECLARE
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_event public.stripe_charge_dispute_reinstatement_events%ROWTYPE;
  v_result jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_full_refund boolean := false;
  v_action_status text;
  v_tip public.tips%ROWTYPE;
  v_delivery public.tip_completion_notification_deliveries%ROWTYPE;
  v_notification_id uuid;
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_user_id uuid;
  v_has_pro boolean := false;
  v_api_payment public.stripe_api_tier_payments%ROWTYPE;
  v_api_ledger public.api_tier_stripe_event_ledger%ROWTYPE;
  v_api_reservation public.api_tier_checkout_reservations%ROWTYPE;
  v_api_status text;
  v_consumption public.group_payment_consumptions%ROWTYPE;
  v_subscription public.group_subscriptions%ROWTYPE;
  v_original_expires_at timestamptz;
  v_member_status text := 'not_applicable';
BEGIN
  IF p_ownership_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_event_id IS NULL
  THEN
    RAISE EXCEPTION 'Stripe dispute reinstatement projection input is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT projection.result
  INTO v_result
  FROM public.stripe_charge_dispute_reinstatement_projections
    AS projection
  WHERE projection.livemode = p_livemode
    AND projection.stripe_event_id = p_stripe_event_id;
  IF FOUND THEN
    RETURN v_result || pg_catalog.jsonb_build_object(
      'status', 'already_restored'
    );
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = p_ownership_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_ownership.livemode IS DISTINCT FROM p_livemode
    OR NOT public.stripe_payment_ownership_is_exact_v2(
      v_ownership.id
    )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict'
    );
  END IF;

  SELECT reinstatement.*
  INTO v_event
  FROM public.stripe_charge_dispute_reinstatement_events
    AS reinstatement
  WHERE reinstatement.livemode = p_livemode
    AND reinstatement.stripe_event_id = p_stripe_event_id
  FOR UPDATE;
  IF NOT FOUND
    OR NOT public.stripe_dispute_reinstatement_matches_payment_v2(
      v_ownership.id,
      p_livemode,
      p_stripe_event_id
    )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict'
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || v_event.stripe_charge_id,
      0
    )
  );

  v_full_refund :=
    v_event.refund_succeeded_amount >= v_event.captured_amount
    OR EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstones AS refund
      WHERE refund.livemode = v_event.livemode
        AND refund.stripe_charge_id =
          v_event.stripe_charge_id
        AND refund.stripe_customer_id =
          v_event.stripe_customer_id
        AND refund.stripe_payment_intent_id
          IS NOT DISTINCT FROM
            v_event.stripe_payment_intent_id
        AND refund.amount_paid = v_event.captured_amount
        AND refund.currency = v_event.currency
        AND refund.refund_state = 'succeeded'
        AND refund.refund_succeeded_amount >=
          refund.amount_paid
    );

  IF v_full_refund THEN
    v_result := pg_catalog.jsonb_build_object(
      'status', 'refund_preserved'
    );
  ELSE
    v_action_status :=
      public.neutralize_dispute_cancellation_for_reinstatement_atomic(
        v_ownership.id
      );
    IF v_action_status = 'action_in_flight' THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'action_in_flight'
      );
    END IF;
    IF v_action_status = 'identity_conflict' THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'identity_conflict'
      );
    END IF;
    IF v_action_status = 'manual_review' THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'dispute',
        v_event.stripe_dispute_id,
        v_ownership.owner_user_id,
        'stripe_dispute_reinstatement_cancellation_outcome_unknown',
        'A won dispute cannot restore paid access until the remote subscription cancellation outcome is reconciled.',
        pg_catalog.jsonb_build_object(
          'event_id', v_event.stripe_event_id,
          'charge_id', v_event.stripe_charge_id,
          'ownership_id', v_ownership.id,
          'product_kind', v_ownership.product_kind,
          'livemode', v_event.livemode
        )
      );
      RETURN pg_catalog.jsonb_build_object(
        'status', 'manual_review'
      );
    END IF;

    CASE v_ownership.product_kind
      WHEN 'tip' THEN
        SELECT tip.*
        INTO v_tip
        FROM public.tips AS tip
        WHERE tip.id = v_ownership.ledger_id
        FOR UPDATE;
        IF NOT FOUND
          OR v_tip.from_user_id IS DISTINCT FROM
            v_ownership.owner_user_id
          OR v_tip.stripe_customer_id IS DISTINCT FROM
            v_ownership.stripe_customer_id
          OR v_tip.stripe_payment_intent_id IS DISTINCT FROM
            v_ownership.stripe_payment_intent_id
          OR v_tip.stripe_charge_id IS DISTINCT FROM
            v_ownership.stripe_charge_id
          OR v_tip.amount_cents::bigint IS DISTINCT FROM
            v_ownership.amount_paid
          OR v_tip.currency IS DISTINCT FROM
            v_ownership.currency
          OR v_tip.status NOT IN ('completed', 'refunded')
        THEN
          RETURN pg_catalog.jsonb_build_object(
            'status', 'identity_conflict'
          );
        END IF;

        SELECT delivery.*
        INTO v_delivery
        FROM public.tip_completion_notification_deliveries
          AS delivery
        WHERE delivery.tip_id = v_tip.id
        FOR UPDATE;
        IF NOT FOUND
          OR v_delivery.disposition IS DISTINCT FROM
            'refund_suppressed'
          OR v_delivery.actor_user_id IS DISTINCT FROM
            v_tip.from_user_id
          OR v_delivery.recipient_user_id IS NULL
          OR v_delivery.post_id IS NULL
          OR v_delivery.amount_cents IS DISTINCT FROM
            v_tip.amount_cents::bigint
          OR v_delivery.currency IS DISTINCT FROM
            v_tip.currency
          OR NOT EXISTS (
            SELECT 1
            FROM public.user_profiles AS recipient
            JOIN public.posts AS post
              ON post.id = v_delivery.post_id
             AND post.author_id = recipient.id
            JOIN public.user_profiles AS actor
              ON actor.id = v_delivery.actor_user_id
            WHERE recipient.id =
                v_delivery.recipient_user_id
              AND recipient.deleted_at IS NULL
              AND actor.deleted_at IS NULL
          )
        THEN
          RETURN pg_catalog.jsonb_build_object(
            'status', 'identity_conflict'
          );
        END IF;

        PERFORM pg_catalog.set_config(
          'arena.stripe_dispute_reinstatement_tip_id',
          v_tip.id::text,
          true
        );
        PERFORM pg_catalog.set_config(
          'arena.stripe_dispute_reinstatement_event_id',
          v_event.stripe_event_id,
          true
        );

        UPDATE public.tips
        SET status = 'completed',
            updated_at = v_now
        WHERE id = v_tip.id
          AND status = 'refunded';

        v_notification_id := COALESCE(
          v_delivery.notification_id,
          pg_catalog.gen_random_uuid()
        );
        INSERT INTO public.notifications (
          id,
          user_id,
          type,
          title,
          message,
          link,
          actor_id,
          reference_id,
          read,
          created_at
        ) VALUES (
          v_notification_id,
          v_delivery.recipient_user_id,
          'tip_received',
          v_delivery.title,
          v_delivery.message,
          v_delivery.link,
          v_delivery.actor_user_id,
          v_tip.id,
          false,
          v_now
        )
        ON CONFLICT DO NOTHING;

        UPDATE public.tip_completion_notification_deliveries
        SET notification_id = v_notification_id,
            disposition = 'delivered',
            delivered_at = COALESCE(delivered_at, v_now),
            disposed_at = NULL
        WHERE tip_id = v_tip.id
          AND disposition = 'refund_suppressed'
          AND EXISTS (
            SELECT 1
            FROM public.notifications AS notification
            WHERE notification.id = v_notification_id
              AND notification.type = 'tip_received'
              AND notification.reference_id = v_tip.id
              AND notification.user_id =
                v_delivery.recipient_user_id
              AND notification.actor_id =
                v_delivery.actor_user_id
              AND notification.title = v_delivery.title
              AND notification.message = v_delivery.message
              AND notification.link IS NOT DISTINCT FROM
                v_delivery.link
          );
        IF NOT FOUND THEN
          RAISE EXCEPTION
            'Stripe dispute Tip notification restoration failed'
            USING ERRCODE = '40001';
        END IF;
        PERFORM pg_catalog.set_config(
          'arena.stripe_dispute_reinstatement_tip_id',
          '',
          true
        );
        PERFORM pg_catalog.set_config(
          'arena.stripe_dispute_reinstatement_event_id',
          '',
          true
        );

        v_result := pg_catalog.jsonb_build_object(
          'status', 'restored',
          'tip_id', v_tip.id,
          'notification_restored',
            EXISTS (
              SELECT 1
              FROM public.notifications AS notification
              WHERE notification.type = 'tip_received'
                AND notification.reference_id = v_tip.id
            )
        );

      WHEN 'pro_entitlement' THEN
        SELECT payment.*
        INTO v_payment
        FROM public.stripe_entitlement_payments AS payment
        WHERE payment.id = v_ownership.ledger_id
        FOR UPDATE;
        v_user_id := COALESCE(
          v_payment.user_id,
          v_ownership.owner_user_id
        );
        IF NOT FOUND
          OR v_user_id IS NULL
          OR v_payment.user_id IS DISTINCT FROM
            v_ownership.owner_user_id
          OR v_payment.livemode IS DISTINCT FROM
            v_ownership.livemode
          OR (
            v_payment.refund_state = 'succeeded'
            AND v_payment.refund_succeeded_amount >=
              v_payment.amount_paid
          )
        THEN
          RETURN pg_catalog.jsonb_build_object(
            'status', 'identity_conflict'
          );
        END IF;

        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            'stripe-lifetime-seat-capacity',
            0
          )
        );
        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            'pro-official-group-assignment',
            0
          )
        );
        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            'pro-official-group-user:' || v_user_id::text,
            0
          )
        );

        IF v_payment.payment_kind = 'lifetime' THEN
          UPDATE public.pro_entitlement_grants
          SET revoked_at = NULL,
              metadata = metadata ||
                pg_catalog.jsonb_build_object(
                  'dispute_reinstated_at', v_now,
                  'dispute_reinstatement_event_id',
                    v_event.stripe_event_id
                ),
              updated_at = v_now
          WHERE user_id = v_user_id
            AND source = 'stripe_lifetime_payment'
            AND source_key =
              'payment:' || v_payment.id::text
            AND revoked_at IS NOT NULL
            AND metadata ->> 'episode_close_reason' =
              'payment_disputed'
            AND metadata ->> 'stripe_dispute_id' =
              v_event.stripe_dispute_id;
        ELSE
          UPDATE public.pro_entitlement_grants
          SET revoked_at = NULL,
              metadata = metadata ||
                pg_catalog.jsonb_build_object(
                  'dispute_reinstated_at', v_now,
                  'dispute_reinstatement_event_id',
                    v_event.stripe_event_id
                ),
              updated_at = v_now
          WHERE user_id = v_user_id
            AND source = 'stripe_payment_retry_grace'
            AND metadata ->> 'stripe_subscription_id' =
              v_payment.stripe_subscription_id
            AND revoked_at IS NOT NULL
            AND metadata ->> 'episode_close_reason' =
              'payment_disputed'
            AND metadata ->> 'stripe_dispute_id' =
              v_event.stripe_dispute_id;
        END IF;

        UPDATE public.subscriptions AS subscription
        SET status = 'active',
            cancel_at_period_end = false,
            canceled_at = NULL,
            entitlement_payment_id = v_payment.id,
            updated_at = v_now
        WHERE subscription.user_id = v_user_id
          AND (
            subscription.entitlement_payment_id =
              v_payment.id
            OR (
              v_payment.payment_kind = 'recurring'
              AND subscription.stripe_subscription_id =
                v_payment.stripe_subscription_id
              AND subscription.stripe_customer_id =
                v_payment.stripe_customer_id
            )
          )
          AND (
            v_payment.payment_kind = 'lifetime'
            OR v_payment.period_end >
              pg_catalog.statement_timestamp()
          );

        IF EXISTS (
          SELECT 1
          FROM public.user_profiles AS profile
          WHERE profile.id = v_user_id
            AND profile.deleted_at IS NULL
        ) THEN
          v_has_pro :=
            public.sync_current_pro_projection_atomic(v_user_id);
        END IF;

        v_result := pg_catalog.jsonb_build_object(
          'status', 'restored',
          'user_id', v_user_id,
          'pro_active', v_has_pro,
          'cancellation_status', v_action_status
        );

      WHEN 'group_pass' THEN
        SELECT consumption.*
        INTO v_consumption
        FROM public.group_payment_consumptions AS consumption
        WHERE consumption.id = v_ownership.ledger_id
        FOR UPDATE;
        IF NOT FOUND
          OR v_consumption.outcome NOT IN (
            'activated',
            'renewed'
          )
          OR v_consumption.result ->> 'status' NOT IN (
            'subscribed',
            'renewed'
          )
        THEN
          RETURN pg_catalog.jsonb_build_object(
            'status', 'identity_conflict'
          );
        END IF;

        v_original_expires_at :=
          (v_consumption.result ->> 'expires_at')::timestamptz;
        IF v_original_expires_at IS NULL THEN
          RETURN pg_catalog.jsonb_build_object(
            'status', 'identity_conflict'
          );
        END IF;

        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            'group-membership:'
              || v_consumption.group_id::text
              || ':'
              || v_consumption.user_id::text,
            0
          )
        );

        SELECT subscription.*
        INTO v_subscription
        FROM public.group_subscriptions AS subscription
        WHERE subscription.id =
          v_consumption.subscription_id
        FOR UPDATE;
        IF NOT FOUND
          OR v_subscription.group_id IS DISTINCT FROM
            v_consumption.group_id
          OR v_subscription.user_id IS DISTINCT FROM
            v_consumption.user_id
          OR v_subscription.payment_provider IS DISTINCT FROM
            'stripe'
          OR v_subscription.payment_reference IS DISTINCT FROM
            'stripe:' || v_consumption.payment_intent_id
        THEN
          RETURN pg_catalog.jsonb_build_object(
            'status', 'identity_conflict'
          );
        END IF;

        IF v_original_expires_at >
          pg_catalog.statement_timestamp()
        THEN
          UPDATE public.group_subscriptions
          SET status = 'active',
              expires_at = v_original_expires_at,
              cancelled_at = NULL,
              cancel_at_period_end = false,
              updated_at = v_now
          WHERE id = v_subscription.id;

          IF v_consumption.result ->> 'membership_status' =
            'joined'
            AND NOT EXISTS (
              SELECT 1
              FROM public.group_members AS member
              WHERE member.group_id =
                  v_consumption.group_id
                AND member.user_id =
                  v_consumption.user_id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.group_bans AS ban
              WHERE ban.group_id =
                  v_consumption.group_id
                AND ban.user_id =
                  v_consumption.user_id
            )
            AND EXISTS (
              SELECT 1
              FROM public.groups AS target_group
              WHERE target_group.id =
                  v_consumption.group_id
                AND target_group.dissolved_at IS NULL
            )
          THEN
            INSERT INTO public.group_members (
              group_id,
              user_id,
              role
            ) VALUES (
              v_consumption.group_id,
              v_consumption.user_id,
              'member'::public.member_role
            )
            ON CONFLICT (group_id, user_id) DO NOTHING;
          END IF;

          SELECT CASE
            WHEN EXISTS (
              SELECT 1
              FROM public.group_members AS member
              WHERE member.group_id =
                  v_consumption.group_id
                AND member.user_id =
                  v_consumption.user_id
            ) THEN 'present'
            ELSE 'unavailable'
          END
          INTO v_member_status;
        ELSE
          v_member_status := 'period_expired';
        END IF;

        v_result := pg_catalog.jsonb_build_object(
          'status', 'restored',
          'subscription_id', v_subscription.id,
          'period_current',
            v_original_expires_at >
              pg_catalog.statement_timestamp(),
          'membership_status', v_member_status
        );

      WHEN 'api_tier' THEN
        SELECT payment.*
        INTO v_api_payment
        FROM public.stripe_api_tier_payments AS payment
        WHERE payment.id = v_ownership.ledger_id;
        IF NOT FOUND THEN
          RETURN pg_catalog.jsonb_build_object(
            'status', 'identity_conflict'
          );
        END IF;

        DELETE FROM public.api_tier_subscription_blocks AS block
        WHERE block.livemode = v_api_payment.livemode
          AND block.stripe_subscription_id =
            v_api_payment.stripe_subscription_id
          AND block.block_kind = 'financial_reversal'
          AND block.user_id = v_api_payment.user_id
          AND block.stripe_customer_id =
            v_api_payment.stripe_customer_id;

        SELECT ledger.*
        INTO v_api_ledger
        FROM public.api_tier_stripe_event_ledger AS ledger
        WHERE ledger.user_id = v_api_payment.user_id
          AND ledger.livemode = v_api_payment.livemode
          AND ledger.stripe_subscription_id =
            v_api_payment.stripe_subscription_id
        ORDER BY
          ledger.is_terminal DESC,
          ledger.stripe_event_created DESC,
          ledger.is_active ASC,
          ledger.stripe_event_id DESC
        LIMIT 1;
        IF NOT FOUND THEN
          RETURN pg_catalog.jsonb_build_object(
            'status', 'identity_conflict'
          );
        END IF;

        SELECT reservation.*
        INTO v_api_reservation
        FROM public.api_tier_checkout_reservations AS reservation
        WHERE reservation.id =
          v_api_ledger.checkout_reservation_id;

        v_api_status :=
          public.apply_user_api_tier_stripe_event(
            v_api_ledger.user_id,
            v_api_ledger.metadata_user_id,
            v_api_ledger.metadata_supabase_user_id,
            v_api_ledger.stripe_customer_id,
            v_api_ledger.checkout_reservation_id,
            v_api_ledger.stripe_price_id,
            v_api_ledger.api_tier,
            v_api_ledger.daily_limit,
            v_api_ledger.stripe_subscription_id,
            v_api_ledger.subscription_created,
            v_api_ledger.stripe_event_id,
            v_api_ledger.stripe_event_created,
            v_api_ledger.is_active,
            v_api_ledger.is_terminal,
            v_api_ledger.livemode,
            v_api_reservation.checkout_session_id,
            v_api_reservation.api_plan,
            v_api_reservation.stripe_price_id,
            v_api_ledger.identity_source
          );

        v_result := pg_catalog.jsonb_build_object(
          'status', 'restored',
          'api_projection_status', v_api_status,
          'cancellation_status', v_action_status,
          'key_rotation_required', true
        );

      ELSE
        RETURN pg_catalog.jsonb_build_object(
          'status', 'identity_conflict'
        );
    END CASE;
  END IF;

  INSERT INTO
    public.stripe_charge_dispute_reinstatement_projections (
      livemode,
      stripe_event_id,
      ownership_id,
      product_kind,
      result
    ) VALUES (
      v_event.livemode,
      v_event.stripe_event_id,
      v_ownership.id,
      v_ownership.product_kind,
      v_result
    );

  RETURN v_result;
END
$function$;

ALTER FUNCTION
  public.project_stripe_charge_dispute_reinstatement_atomic(
    uuid, boolean, text
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.project_stripe_charge_dispute_reinstatement_atomic(
    uuid, boolean, text
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.record_stripe_charge_dispute_reinstatement_atomic(
    p_livemode boolean,
    p_stripe_event_id text,
    p_stripe_event_created bigint,
    p_stripe_dispute_id text,
    p_dispute_status text,
    p_dispute_reason text,
    p_dispute_amount bigint,
    p_currency text,
    p_stripe_customer_id text,
    p_stripe_payment_intent_id text,
    p_stripe_charge_id text,
    p_captured_amount bigint,
    p_refund_succeeded_amount bigint
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
AS $function$
DECLARE
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_ownership_count integer := 0;
  v_projection jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL
    OR p_stripe_event_id IS NULL
    OR p_stripe_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_event_id) > 255
    OR p_stripe_event_created IS NULL
    OR p_stripe_event_created <= 0
    OR p_stripe_event_created > 253402300799
    OR p_stripe_dispute_id IS NULL
    OR p_stripe_dispute_id !~ '^dp_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_dispute_id) > 255
    OR p_dispute_status IS DISTINCT FROM 'won'
    OR p_dispute_reason IS NULL
    OR pg_catalog.length(p_dispute_reason) NOT BETWEEN 1 AND 100
    OR p_dispute_amount IS NULL
    OR p_dispute_amount <= 0
    OR p_currency IS NULL
    OR p_currency !~ '^[a-z]{3}$'
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND p_stripe_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
    )
    OR p_stripe_charge_id IS NULL
    OR p_stripe_charge_id !~ '^ch_[A-Za-z0-9_]+$'
    OR p_captured_amount IS NULL
    OR p_captured_amount <= 0
    OR p_dispute_amount > p_captured_amount
    OR p_refund_succeeded_amount IS NULL
    OR p_refund_succeeded_amount < 0
    OR p_refund_succeeded_amount > p_captured_amount
  THEN
    RAISE EXCEPTION 'Stripe dispute reinstatement identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || p_stripe_charge_id,
      0
    )
  );
  IF p_stripe_payment_intent_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-payment-identity:'
          || p_stripe_payment_intent_id,
        0
      )
    );
  END IF;

  INSERT INTO
    public.stripe_charge_dispute_reinstatement_events (
      livemode,
      stripe_event_id,
      stripe_event_created,
      stripe_dispute_id,
      dispute_status,
      dispute_reason,
      dispute_amount,
      currency,
      stripe_customer_id,
      stripe_payment_intent_id,
      stripe_charge_id,
      captured_amount,
      refund_succeeded_amount
    ) VALUES (
      p_livemode,
      p_stripe_event_id,
      p_stripe_event_created,
      p_stripe_dispute_id,
      p_dispute_status,
      p_dispute_reason,
      p_dispute_amount,
      p_currency,
      p_stripe_customer_id,
      p_stripe_payment_intent_id,
      p_stripe_charge_id,
      p_captured_amount,
      p_refund_succeeded_amount
    )
  ON CONFLICT DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.stripe_charge_dispute_reinstatement_events
      AS reinstatement
    WHERE reinstatement.livemode = p_livemode
      AND reinstatement.stripe_event_id =
        p_stripe_event_id
      AND reinstatement.stripe_event_created =
        p_stripe_event_created
      AND reinstatement.stripe_dispute_id =
        p_stripe_dispute_id
      AND reinstatement.dispute_status =
        p_dispute_status
      AND reinstatement.dispute_reason =
        p_dispute_reason
      AND reinstatement.dispute_amount =
        p_dispute_amount
      AND reinstatement.currency = p_currency
      AND reinstatement.stripe_customer_id =
        p_stripe_customer_id
      AND reinstatement.stripe_payment_intent_id
        IS NOT DISTINCT FROM p_stripe_payment_intent_id
      AND reinstatement.stripe_charge_id =
        p_stripe_charge_id
      AND reinstatement.captured_amount =
        p_captured_amount
      AND reinstatement.refund_succeeded_amount =
        p_refund_succeeded_amount
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'dispute',
      p_stripe_dispute_id,
      NULL,
      'stripe_dispute_reinstatement_identity_conflict',
      'A Stripe dispute reinstatement replay changed immutable payment or refund identity.',
      pg_catalog.jsonb_build_object(
        'event_id', p_stripe_event_id,
        'charge_id', p_stripe_charge_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict'
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.stripe_charge_dispute_events AS dispute
    WHERE dispute.livemode = p_livemode
      AND dispute.stripe_dispute_id =
        p_stripe_dispute_id
      AND dispute.stripe_charge_id =
        p_stripe_charge_id
      AND dispute.stripe_customer_id =
        p_stripe_customer_id
      AND dispute.stripe_payment_intent_id
        IS NOT DISTINCT FROM p_stripe_payment_intent_id
      AND dispute.captured_amount =
        p_captured_amount
      AND dispute.currency = p_currency
      AND dispute.dispute_amount =
        p_dispute_amount
      AND dispute.dispute_reason =
        p_dispute_reason
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'awaiting_dispute_created'
    );
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    (pg_catalog.array_agg(ownership.id ORDER BY ownership.id))[1]
  INTO v_ownership_count, v_ownership.id
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.stripe_charge_id = p_stripe_charge_id
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND ownership.stripe_payment_intent_id =
        p_stripe_payment_intent_id
    );

  IF v_ownership_count = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'awaiting_dispute_created'
    );
  END IF;
  IF v_ownership_count <> 1 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict'
    );
  END IF;

  v_projection :=
    public.project_stripe_charge_dispute_reinstatement_atomic(
      v_ownership.id,
      p_livemode,
      p_stripe_event_id
    );
  IF COALESCE(v_projection ->> 'status', '') IN (
    'restored',
    'already_restored',
    'refund_preserved',
    'action_in_flight'
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      v_projection ->> 'status'
    );
  END IF;
  IF COALESCE(v_projection ->> 'status', '') =
    'manual_review'
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'manual_review'
    );
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'identity_conflict'
  );
END
$function$;

ALTER FUNCTION
  public.record_stripe_charge_dispute_reinstatement_atomic(
    boolean, text, bigint, text, text, text, bigint, text, text,
    text, text, bigint, bigint
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.record_stripe_charge_dispute_reinstatement_atomic(
    boolean, text, bigint, text, text, text, bigint, text, text,
    text, text, bigint, bigint
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.record_stripe_charge_dispute_reinstatement_atomic(
    boolean, text, bigint, text, text, text, bigint, text, text,
    text, text, bigint, bigint
  )
TO service_role;

ALTER FUNCTION public.record_api_tier_dispute_reversal_atomic(
  boolean, text, bigint, text, text, text, bigint, text, text, text,
  text, bigint
)
RENAME TO record_api_tier_dispute_reversal_pre_reinstatement_v2;
REVOKE ALL ON FUNCTION
  public.record_api_tier_dispute_reversal_pre_reinstatement_v2(
    boolean, text, bigint, text, text, text, bigint, text, text, text,
    text, bigint
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.record_api_tier_dispute_reversal_atomic(
  p_livemode boolean,
  p_stripe_event_id text,
  p_stripe_event_created bigint,
  p_stripe_dispute_id text,
  p_dispute_status text,
  p_dispute_reason text,
  p_dispute_amount bigint,
  p_currency text,
  p_stripe_customer_id text,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_captured_amount bigint
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
AS $function$
DECLARE
  v_result jsonb;
  v_ownership_id uuid;
  v_reinstatement record;
  v_projection jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  v_result :=
    public.record_api_tier_dispute_reversal_pre_reinstatement_v2(
      p_livemode,
      p_stripe_event_id,
      p_stripe_event_created,
      p_stripe_dispute_id,
      p_dispute_status,
      p_dispute_reason,
      p_dispute_amount,
      p_currency,
      p_stripe_customer_id,
      p_stripe_payment_intent_id,
      p_stripe_charge_id,
      p_captured_amount
    );

  SELECT ownership.id
  INTO v_ownership_id
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.stripe_charge_id = p_stripe_charge_id
    AND ownership.stripe_customer_id =
      p_stripe_customer_id
    AND ownership.stripe_payment_intent_id
      IS NOT DISTINCT FROM p_stripe_payment_intent_id
    AND ownership.amount_paid = p_captured_amount
    AND ownership.currency = p_currency;

  IF v_ownership_id IS NULL THEN
    RETURN v_result;
  END IF;

  FOR v_reinstatement IN
    SELECT
      reinstatement.livemode,
      reinstatement.stripe_event_id
    FROM public.stripe_charge_dispute_reinstatement_events
      AS reinstatement
    WHERE reinstatement.livemode = p_livemode
      AND reinstatement.stripe_dispute_id =
        p_stripe_dispute_id
    ORDER BY
      reinstatement.stripe_event_created,
      reinstatement.stripe_event_id
  LOOP
    v_projection :=
      public.project_stripe_charge_dispute_reinstatement_atomic(
        v_ownership_id,
        v_reinstatement.livemode,
        v_reinstatement.stripe_event_id
      );
    IF COALESCE(v_projection ->> 'status', '') IN (
      '',
      'identity_conflict',
      'manual_review',
      'not_found',
      'action_in_flight'
    ) THEN
      RAISE EXCEPTION
        'Stripe dispute reinstatement projection failed after created event'
        USING ERRCODE = '40001';
    END IF;
  END LOOP;

  RETURN v_result;
END
$function$;

ALTER FUNCTION public.record_api_tier_dispute_reversal_atomic(
  boolean, text, bigint, text, text, text, bigint, text, text, text,
  text, bigint
) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.record_api_tier_dispute_reversal_atomic(
    boolean, text, bigint, text, text, text, bigint, text, text, text,
    text, bigint
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.record_api_tier_dispute_reversal_atomic(
    boolean, text, bigint, text, text, text, bigint, text, text, text,
    text, bigint
  )
TO service_role;

CREATE OR REPLACE FUNCTION
  public.project_dispute_after_payment_ownership_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_dispute record;
  v_state text;
  v_result jsonb;
BEGIN
  v_state := public.stripe_charge_dispute_identity_state_v2(
    NEW.livemode,
    NEW.stripe_customer_id,
    NEW.stripe_payment_intent_id,
    NEW.stripe_charge_id,
    NEW.amount_paid,
    NEW.currency
  );

  IF v_state IS DISTINCT FROM 'none'
    AND v_state IS DISTINCT FROM 'disputed'
  THEN
    RAISE EXCEPTION
      'payment ownership conflicts with an earlier Stripe dispute'
      USING ERRCODE = '23514';
  END IF;

  IF v_state = 'disputed' THEN
    FOR v_dispute IN
      SELECT dispute.livemode, dispute.stripe_event_id
      FROM public.stripe_charge_dispute_events AS dispute
      WHERE dispute.livemode = NEW.livemode
        AND dispute.stripe_charge_id =
          NEW.stripe_charge_id
        AND dispute.stripe_customer_id =
          NEW.stripe_customer_id
        AND dispute.stripe_payment_intent_id
          IS NOT DISTINCT FROM
            NEW.stripe_payment_intent_id
        AND dispute.captured_amount = NEW.amount_paid
        AND dispute.currency = NEW.currency
      ORDER BY
        dispute.stripe_event_created,
        dispute.stripe_event_id
    LOOP
      v_result :=
        public.project_stripe_charge_dispute_ownership_atomic(
          NEW.id,
          v_dispute.livemode,
          v_dispute.stripe_event_id
        );
      IF COALESCE(v_result ->> 'status', '') IN (
        '',
        'identity_conflict',
        'manual_review',
        'not_found'
      ) THEN
        RAISE EXCEPTION
          'payment-first Stripe dispute projection failed'
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;

  FOR v_dispute IN
    SELECT
      reinstatement.livemode,
      reinstatement.stripe_event_id
    FROM public.stripe_charge_dispute_reinstatement_events
      AS reinstatement
    WHERE reinstatement.livemode = NEW.livemode
      AND reinstatement.stripe_charge_id =
        NEW.stripe_charge_id
      AND reinstatement.stripe_customer_id =
        NEW.stripe_customer_id
      AND reinstatement.stripe_payment_intent_id
        IS NOT DISTINCT FROM
          NEW.stripe_payment_intent_id
      AND reinstatement.captured_amount =
        NEW.amount_paid
      AND reinstatement.currency = NEW.currency
    ORDER BY
      reinstatement.stripe_event_created,
      reinstatement.stripe_event_id
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.stripe_charge_dispute_events AS dispute
      WHERE dispute.livemode = v_dispute.livemode
        AND dispute.stripe_charge_id =
          NEW.stripe_charge_id
    ) THEN
      v_result :=
        public.project_stripe_charge_dispute_reinstatement_atomic(
          NEW.id,
          v_dispute.livemode,
          v_dispute.stripe_event_id
        );
      IF COALESCE(v_result ->> 'status', '') IN (
        '',
        'identity_conflict',
        'manual_review',
        'not_found',
        'action_in_flight'
      ) THEN
        RAISE EXCEPTION
          'payment-first Stripe dispute reinstatement failed'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END
$function$;

ALTER FUNCTION
  public.project_dispute_after_payment_ownership_insert()
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.project_dispute_after_payment_ownership_insert()
FROM PUBLIC, anon, authenticated, service_role, authenticator;

ALTER FUNCTION public.stripe_paid_launch_readiness_v2()
  RENAME TO stripe_paid_launch_readiness_pre_reinstatement_v2;
REVOKE ALL ON FUNCTION
  public.stripe_paid_launch_readiness_pre_reinstatement_v2()
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
  v_unprojected_disputes integer;
  v_dispute_identity_anomalies integer;
  v_active_dispute_drift integer;
  v_unprojected_reinstatements integer;
  v_reinstatement_identity_anomalies integer;
  v_reinstatement_authority_drift integer;
  v_authority_drift integer;
  v_ready boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  v_base :=
    public.stripe_paid_launch_readiness_pre_dispute_v2();

  SELECT pg_catalog.count(*)::integer
  INTO v_unprojected_disputes
  FROM public.stripe_charge_dispute_events AS dispute
  WHERE dispute.livemode IS TRUE
    AND NOT EXISTS (
      SELECT 1
      FROM public.stripe_charge_dispute_projections AS projection
      WHERE projection.livemode = dispute.livemode
        AND projection.stripe_event_id =
          dispute.stripe_event_id
    );

  SELECT (
    (
      SELECT pg_catalog.count(*)
      FROM public.stripe_charge_dispute_events AS dispute
      WHERE dispute.livemode IS TRUE
        AND EXISTS (
          SELECT 1
          FROM public.stripe_payment_ownerships AS ownership
          WHERE ownership.stripe_charge_id =
              dispute.stripe_charge_id
            OR (
              dispute.stripe_payment_intent_id IS NOT NULL
              AND ownership.stripe_payment_intent_id =
                dispute.stripe_payment_intent_id
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.stripe_payment_ownerships AS ownership
          WHERE public.stripe_payment_ownership_has_exact_dispute_v2(
            ownership.id,
            dispute.livemode,
            dispute.stripe_event_id
          )
        )
    )
    + (
      SELECT pg_catalog.count(*)
      FROM public.stripe_charge_dispute_projections AS projection
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.id = projection.ownership_id
      WHERE projection.livemode IS TRUE
        AND (
          projection.product_kind <>
            ownership.product_kind
          OR projection.livemode <> ownership.livemode
          OR NOT public.stripe_payment_ownership_has_exact_dispute_v2(
            ownership.id,
            projection.livemode,
            projection.stripe_event_id
          )
        )
    )
  )::integer
  INTO v_dispute_identity_anomalies;

  SELECT pg_catalog.count(*)::integer
  INTO v_active_dispute_drift
  FROM public.stripe_charge_dispute_projections AS projection
  JOIN public.stripe_payment_ownerships AS ownership
    ON ownership.id = projection.ownership_id
  WHERE projection.livemode IS TRUE
    AND public.stripe_payment_ownership_has_active_dispute_v3(
      ownership.id
    )
    AND (
      (
        projection.product_kind = 'tip'
        AND EXISTS (
          SELECT 1
          FROM public.tips AS tip
          WHERE tip.id = ownership.ledger_id
            AND (
              tip.status <> 'refunded'
              OR EXISTS (
                SELECT 1
                FROM public.notifications AS notification
                WHERE notification.type = 'tip_received'
                  AND notification.reference_id = tip.id
              )
            )
        )
      )
      OR (
        projection.product_kind = 'pro_entitlement'
        AND EXISTS (
          SELECT 1
          FROM public.stripe_entitlement_payments AS payment
          WHERE payment.id = ownership.ledger_id
            AND (
              EXISTS (
                SELECT 1
                FROM public.subscriptions AS subscription
                WHERE subscription.user_id = payment.user_id
                  AND subscription.status IN ('active', 'trialing')
                  AND (
                    subscription.entitlement_payment_id =
                      payment.id
                    OR subscription.stripe_subscription_id =
                      payment.stripe_subscription_id
                  )
              )
              OR EXISTS (
                SELECT 1
                FROM public.pro_entitlement_grants AS entitlement_grant
                WHERE entitlement_grant.user_id =
                    payment.user_id
                  AND entitlement_grant.revoked_at IS NULL
                  AND (
                    entitlement_grant.source_key =
                      'payment:' || payment.id::text
                    OR entitlement_grant.metadata
                      ->> 'stripe_subscription_id' =
                        payment.stripe_subscription_id
                  )
              )
            )
        )
      )
      OR (
        projection.product_kind = 'group_pass'
        AND EXISTS (
          SELECT 1
          FROM public.group_payment_consumptions AS consumption
          WHERE consumption.id = ownership.ledger_id
            AND EXISTS (
              SELECT 1
              FROM public.group_subscriptions AS subscription
              WHERE subscription.id =
                  consumption.subscription_id
                AND subscription.status IN ('active', 'trialing')
                AND subscription.expires_at >
                  pg_catalog.statement_timestamp()
            )
        )
      )
      OR (
        projection.product_kind = 'api_tier'
        AND NOT EXISTS (
          SELECT 1
          FROM public.api_tier_reversal_actions AS action
          JOIN public.stripe_api_tier_payments AS payment
            ON payment.id = ownership.ledger_id
          WHERE action.product_kind = 'api_tier'
            AND action.livemode = payment.livemode
            AND action.stripe_subscription_id =
              payment.stripe_subscription_id
        )
      )
    );

  SELECT pg_catalog.count(*)::integer
  INTO v_unprojected_reinstatements
  FROM public.stripe_charge_dispute_reinstatement_events
    AS reinstatement
  WHERE reinstatement.livemode IS TRUE
    AND NOT EXISTS (
      SELECT 1
      FROM public.stripe_charge_dispute_reinstatement_projections
        AS projection
      WHERE projection.livemode = reinstatement.livemode
        AND projection.stripe_event_id =
          reinstatement.stripe_event_id
    );

  SELECT (
    (
      SELECT pg_catalog.count(*)
      FROM public.stripe_charge_dispute_reinstatement_events
        AS reinstatement
      WHERE reinstatement.livemode IS TRUE
        AND EXISTS (
          SELECT 1
          FROM public.stripe_payment_ownerships AS ownership
          WHERE ownership.stripe_charge_id =
              reinstatement.stripe_charge_id
            OR (
              reinstatement.stripe_payment_intent_id IS NOT NULL
              AND ownership.stripe_payment_intent_id =
                reinstatement.stripe_payment_intent_id
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.stripe_payment_ownerships AS ownership
          WHERE public.stripe_dispute_reinstatement_is_exact_v2(
            ownership.id,
            reinstatement.livemode,
            reinstatement.stripe_event_id
          )
        )
        AND reinstatement.refund_succeeded_amount <
          reinstatement.captured_amount
    )
    + (
      SELECT pg_catalog.count(*)
      FROM public.stripe_charge_dispute_reinstatement_projections
        AS projection
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.id = projection.ownership_id
      WHERE projection.livemode IS TRUE
        AND (
          projection.product_kind <>
            ownership.product_kind
          OR projection.livemode <> ownership.livemode
        )
    )
  )::integer
  INTO v_reinstatement_identity_anomalies;

  SELECT pg_catalog.count(*)::integer
  INTO v_reinstatement_authority_drift
  FROM public.stripe_charge_dispute_reinstatement_projections
    AS projection
  JOIN public.stripe_payment_ownerships AS ownership
    ON ownership.id = projection.ownership_id
  WHERE projection.livemode IS TRUE
    AND (
      COALESCE(projection.result ->> 'status', '') NOT IN (
        'restored',
        'refund_preserved'
      )
      OR (
        projection.result ->> 'status' = 'restored'
        AND (
          (
            projection.product_kind = 'tip'
            AND NOT EXISTS (
              SELECT 1
              FROM public.tips AS tip
              WHERE tip.id = ownership.ledger_id
                AND tip.status = 'completed'
            )
          )
          OR (
            projection.product_kind = 'pro_entitlement'
            AND COALESCE(
              (projection.result ->> 'pro_active')::boolean,
              false
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.stripe_entitlement_payments AS payment
              JOIN public.user_profiles AS profile
                ON profile.id = payment.user_id
              WHERE payment.id = ownership.ledger_id
                AND profile.is_pro
            )
          )
          OR (
            projection.product_kind = 'group_pass'
            AND COALESCE(
              (projection.result ->> 'period_current')::boolean,
              false
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.group_payment_consumptions AS consumption
              JOIN public.group_subscriptions AS subscription
                ON subscription.id =
                  consumption.subscription_id
              WHERE consumption.id = ownership.ledger_id
                AND subscription.status = 'active'
                AND subscription.expires_at >
                  pg_catalog.statement_timestamp()
            )
          )
          OR (
            projection.product_kind = 'api_tier'
            AND EXISTS (
              SELECT 1
              FROM public.stripe_api_tier_payments AS payment
              JOIN public.api_tier_subscription_blocks AS block
                ON block.livemode = payment.livemode
               AND block.stripe_subscription_id =
                 payment.stripe_subscription_id
               AND block.block_kind = 'financial_reversal'
              WHERE payment.id = ownership.ledger_id
            )
          )
          OR (
            projection.product_kind IN (
              'pro_entitlement',
              'api_tier'
            )
            AND EXISTS (
              SELECT 1
              FROM public.api_tier_reversal_actions AS action
              WHERE action.ownership_id = ownership.id
                AND action.state <> 'completed'
            )
          )
        )
      )
    );

  v_authority_drift :=
    COALESCE((v_base ->> 'authority_drift')::integer, -1)
      + v_dispute_identity_anomalies
      + v_active_dispute_drift
      + v_reinstatement_identity_anomalies
      + v_reinstatement_authority_drift;

  v_ready :=
    COALESCE(v_base ->> 'status', '') = 'ready'
    AND v_unprojected_disputes = 0
    AND v_dispute_identity_anomalies = 0
    AND v_active_dispute_drift = 0
    AND v_unprojected_reinstatements = 0
    AND v_reinstatement_identity_anomalies = 0
    AND v_reinstatement_authority_drift = 0;

  RETURN v_base || pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_ready THEN 'ready' ELSE 'blocked' END,
    'authority_drift', v_authority_drift,
    'unprojected_charge_disputes',
      v_unprojected_disputes,
    'charge_dispute_identity_anomalies',
      v_dispute_identity_anomalies,
    'charge_dispute_authority_drift',
      v_active_dispute_drift,
    'unprojected_dispute_reinstatements',
      v_unprojected_reinstatements,
    'dispute_reinstatement_identity_anomalies',
      v_reinstatement_identity_anomalies,
    'dispute_reinstatement_authority_drift',
      v_reinstatement_authority_drift
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
  v_relation pg_catalog.regclass;
  v_function pg_catalog.regprocedure;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.stripe_charge_dispute_reinstatement_events'::pg_catalog.regclass,
    'public.stripe_charge_dispute_reinstatement_projections'::pg_catalog.regclass
  ]
  LOOP
    IF (
      SELECT relation_owner.rolname
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_roles AS relation_owner
        ON relation_owner.oid = relation.relowner
      WHERE relation.oid = v_relation
    ) IS DISTINCT FROM 'postgres'
    THEN
      RAISE EXCEPTION
        'Stripe dispute reinstatement relation owner drifted: %',
        v_relation;
    END IF;
    IF pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) THEN
      RAISE EXCEPTION
        'Stripe dispute reinstatement ledger leaked direct service access: %',
        v_relation;
    END IF;
  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    'public.record_stripe_charge_dispute_reinstatement_atomic(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint,bigint)'::pg_catalog.regprocedure,
    'public.project_stripe_charge_dispute_reinstatement_atomic(uuid,boolean,text)'::pg_catalog.regprocedure,
    'public.stripe_dispute_reinstatement_matches_payment_v2(uuid,boolean,text)'::pg_catalog.regprocedure,
    'public.stripe_dispute_reinstatement_is_exact_v2(uuid,boolean,text)'::pg_catalog.regprocedure,
    'public.stripe_payment_ownership_has_active_dispute_v3(uuid)'::pg_catalog.regprocedure,
    'public.prevent_tip_payment_identity_mutation()'::pg_catalog.regprocedure,
    'public.prevent_tip_notification_delivery_mutation()'::pg_catalog.regprocedure
  ]
  LOOP
    IF (
      SELECT function_owner.rolname
      FROM pg_catalog.pg_proc AS function_row
      JOIN pg_catalog.pg_roles AS function_owner
        ON function_owner.oid = function_row.proowner
      WHERE function_row.oid = v_function
    ) IS DISTINCT FROM 'postgres'
    THEN
      RAISE EXCEPTION
        'Stripe dispute reinstatement function owner drifted: %',
        v_function;
    END IF;
  END LOOP;
END
$postflight$;

COMMIT;
