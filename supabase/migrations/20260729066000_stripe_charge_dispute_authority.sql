-- A Stripe dispute is an immediate financial reversal, not merely an alert.
-- Persist every fresh Charge/Dispute identity before projection, revoke the
-- exact locally-owned benefit atomically, and keep a durable cancellation
-- action for recurring products.  The deferred ownership trigger also closes
-- the dispute-first/payment-later ordering without granting a transient benefit
-- at transaction commit.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_required_relation text;
  v_required_function text;
BEGIN
  FOREACH v_required_relation IN ARRAY ARRAY[
    'public.stripe_payment_ownerships',
    'public.stripe_api_tier_reversal_events',
    'public.api_tier_reversal_actions',
    'public.stripe_entitlement_payments',
    'public.stripe_entitlement_effects',
    'public.stripe_lifetime_seat_reservations',
    'public.pro_entitlement_grants',
    'public.subscriptions',
    'public.tips',
    'public.tip_completion_notification_deliveries',
    'public.notifications',
    'public.group_payment_consumptions',
    'public.group_subscriptions',
    'public.group_trial_consumptions',
    'public.group_members'
  ]
  LOOP
    IF pg_catalog.to_regclass(v_required_relation) IS NULL THEN
      RAISE EXCEPTION
        'Stripe dispute authority prerequisite is missing: %',
        v_required_relation;
    END IF;
  END LOOP;

  FOREACH v_required_function IN ARRAY ARRAY[
    'public.record_api_tier_dispute_reversal_atomic(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)',
    'public.project_api_tier_financial_reversal_atomic(uuid,boolean)',
    'public.claim_api_tier_reversal_actions_atomic(uuid,integer,integer,boolean)',
    'public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamp with time zone)',
    'public.activate_recurring_entitlement_payment_atomic(uuid,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text,boolean)',
    'public.reconcile_recurring_subscription_state_atomic(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone,boolean)',
    'public.stripe_subscription_has_exact_payment_binding_v2(uuid)',
    'public.stripe_payment_ownership_is_exact_v2(uuid)',
    'public.sync_current_pro_projection_atomic(uuid)',
    'public.leave_pro_official_group_atomic(uuid)',
    'public.lock_tip_notification_authority_atomic(uuid)',
    'public.stripe_paid_launch_readiness_v2()'
  ]
  LOOP
    IF pg_catalog.to_regprocedure(v_required_function) IS NULL THEN
      RAISE EXCEPTION
        'Stripe dispute authority function is missing: %',
        v_required_function;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass(
      'public.stripe_charge_dispute_events'
    ) IS NOT NULL
    OR pg_catalog.to_regclass(
      'public.stripe_charge_dispute_projections'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.record_api_tier_dispute_reversal_pre_global_v2(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.activate_recurring_entitlement_payment_pre_dispute_v2(uuid,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text,boolean)'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.reconcile_recurring_subscription_state_pre_dispute_v2(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone,boolean)'
    ) IS NOT NULL
  THEN
    RAISE EXCEPTION
      'Stripe dispute authority already exists; audit before replay';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
  THEN
    RAISE EXCEPTION 'Stripe dispute authority roles are missing';
  END IF;
END
$preflight$;

LOCK TABLE
  public.stripe_payment_ownerships,
  public.api_tier_reversal_actions
IN ACCESS EXCLUSIVE MODE;

CREATE TABLE public.stripe_charge_dispute_events (
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
  recorded_at timestamptz NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_charge_dispute_events_pkey
    PRIMARY KEY (livemode, stripe_event_id),
  CONSTRAINT stripe_charge_dispute_events_dispute_key
    UNIQUE (livemode, stripe_dispute_id),
  CONSTRAINT stripe_charge_dispute_events_event_shape
    CHECK (
      stripe_event_id ~ '^evt_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_event_id) <= 255
      AND stripe_event_created > 0
      AND stripe_event_created <= 253402300799
    ),
  CONSTRAINT stripe_charge_dispute_events_dispute_shape
    CHECK (
      stripe_dispute_id ~ '^dp_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_dispute_id) <= 255
      AND pg_catalog.length(dispute_status) BETWEEN 1 AND 100
      AND pg_catalog.length(dispute_reason) BETWEEN 1 AND 100
    ),
  CONSTRAINT stripe_charge_dispute_events_payment_shape
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
  CONSTRAINT stripe_charge_dispute_events_amount_shape
    CHECK (
      dispute_amount > 0
      AND captured_amount > 0
      AND dispute_amount <= captured_amount
      AND currency ~ '^[a-z]{3}$'
    )
);

CREATE INDEX stripe_charge_dispute_events_charge_idx
  ON public.stripe_charge_dispute_events (
    livemode,
    stripe_charge_id,
    stripe_event_created,
    stripe_event_id
  );
CREATE INDEX stripe_charge_dispute_events_pi_idx
  ON public.stripe_charge_dispute_events (
    livemode,
    stripe_payment_intent_id,
    stripe_event_created,
    stripe_event_id
  )
  WHERE stripe_payment_intent_id IS NOT NULL;

ALTER TABLE public.stripe_charge_dispute_events OWNER TO postgres;
ALTER TABLE public.stripe_charge_dispute_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_charge_dispute_events NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_charge_dispute_events
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TABLE public.stripe_charge_dispute_projections (
  livemode boolean NOT NULL,
  stripe_event_id text NOT NULL,
  ownership_id uuid NOT NULL
    REFERENCES public.stripe_payment_ownerships(id) ON DELETE RESTRICT,
  product_kind text NOT NULL,
  result jsonb NOT NULL,
  projected_at timestamptz NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_charge_dispute_projections_pkey
    PRIMARY KEY (livemode, stripe_event_id),
  CONSTRAINT stripe_charge_dispute_projections_event_fkey
    FOREIGN KEY (livemode, stripe_event_id)
    REFERENCES public.stripe_charge_dispute_events(
      livemode,
      stripe_event_id
    )
    ON DELETE RESTRICT,
  CONSTRAINT stripe_charge_dispute_projections_kind_check
    CHECK (
      product_kind IN (
        'pro_entitlement',
        'tip',
        'group_pass',
        'api_tier'
      )
    ),
  CONSTRAINT stripe_charge_dispute_projections_result_check
    CHECK (
      pg_catalog.jsonb_typeof(result) = 'object'
      AND result ? 'status'
    )
);

CREATE INDEX stripe_charge_dispute_projections_ownership_idx
  ON public.stripe_charge_dispute_projections (
    ownership_id,
    projected_at,
    stripe_event_id
  );

ALTER TABLE public.stripe_charge_dispute_projections OWNER TO postgres;
ALTER TABLE public.stripe_charge_dispute_projections
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_charge_dispute_projections
  NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_charge_dispute_projections
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.prevent_stripe_dispute_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'Stripe dispute financial audit rows are immutable'
    USING ERRCODE = '23514';
END
$function$;

ALTER FUNCTION public.prevent_stripe_dispute_audit_mutation()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prevent_stripe_dispute_audit_mutation()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TRIGGER trg_stripe_charge_dispute_events_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_charge_dispute_events
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_dispute_audit_mutation();
CREATE TRIGGER trg_stripe_charge_dispute_projections_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_charge_dispute_projections
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_dispute_audit_mutation();

ALTER TABLE public.api_tier_reversal_actions
  ADD COLUMN product_kind text NOT NULL DEFAULT 'api_tier',
  ADD CONSTRAINT api_tier_reversal_actions_product_kind_check
    CHECK (product_kind IN ('api_tier', 'pro_entitlement'));

CREATE INDEX api_tier_reversal_actions_product_due_idx
  ON public.api_tier_reversal_actions (
    product_kind,
    livemode,
    next_attempt_at,
    id
  )
  WHERE state IN ('pending', 'leased');

CREATE OR REPLACE FUNCTION public.stripe_charge_dispute_identity_state_v2(
  p_livemode boolean,
  p_stripe_customer_id text,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_captured_amount bigint,
  p_currency text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH relevant AS (
    SELECT dispute.*
    FROM public.stripe_charge_dispute_events AS dispute
    WHERE dispute.stripe_charge_id = p_stripe_charge_id
      OR (
        p_stripe_payment_intent_id IS NOT NULL
        AND dispute.stripe_payment_intent_id =
          p_stripe_payment_intent_id
      )
  )
  SELECT CASE
    WHEN p_livemode IS NULL
      OR p_stripe_customer_id IS NULL
      OR p_stripe_charge_id IS NULL
      OR p_captured_amount IS NULL
      OR p_currency IS NULL
      THEN 'identity_conflict'
    WHEN NOT EXISTS (SELECT 1 FROM relevant)
      THEN 'none'
    WHEN EXISTS (
      SELECT 1
      FROM relevant
      WHERE livemode IS DISTINCT FROM p_livemode
        OR stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
        OR stripe_payment_intent_id IS DISTINCT FROM
          p_stripe_payment_intent_id
        OR stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
        OR captured_amount IS DISTINCT FROM p_captured_amount
        OR currency IS DISTINCT FROM p_currency
    )
      THEN 'identity_conflict'
    ELSE 'disputed'
  END
$function$;

ALTER FUNCTION public.stripe_charge_dispute_identity_state_v2(
  boolean, text, text, text, bigint, text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_charge_dispute_identity_state_v2(
  boolean, text, text, text, bigint, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.stripe_payment_ownership_has_exact_dispute_v2(
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
      JOIN public.stripe_charge_dispute_events AS dispute
        ON dispute.livemode = ownership.livemode
       AND dispute.stripe_charge_id = ownership.stripe_charge_id
       AND dispute.stripe_customer_id =
         ownership.stripe_customer_id
       AND dispute.stripe_payment_intent_id IS NOT DISTINCT FROM
         ownership.stripe_payment_intent_id
       AND dispute.captured_amount = ownership.amount_paid
       AND dispute.currency = ownership.currency
      WHERE ownership.id = p_ownership_id
        AND ownership.livemode = p_livemode
        AND dispute.stripe_event_id = p_stripe_event_id
        AND public.stripe_payment_ownership_is_exact_v2(
          ownership.id
        )
    )
$function$;

ALTER FUNCTION
  public.stripe_payment_ownership_has_exact_dispute_v2(
    uuid, boolean, text
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.stripe_payment_ownership_has_exact_dispute_v2(
    uuid, boolean, text
  )
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
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.stripe_charge_dispute_events AS dispute
                  WHERE dispute.livemode = ownership.livemode
                    AND dispute.stripe_charge_id =
                      ownership.stripe_charge_id
                    AND dispute.stripe_customer_id =
                      ownership.stripe_customer_id
                    AND dispute.stripe_payment_intent_id
                      IS NOT DISTINCT FROM
                        ownership.stripe_payment_intent_id
                    AND dispute.captured_amount =
                      ownership.amount_paid
                    AND dispute.currency = ownership.currency
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
  public.project_stripe_charge_dispute_ownership_atomic(
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
  v_dispute public.stripe_charge_dispute_events%ROWTYPE;
  v_tip public.tips%ROWTYPE;
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_consumption public.group_payment_consumptions%ROWTYPE;
  v_subscription public.group_subscriptions%ROWTYPE;
  v_member_role text;
  v_member_joined_at timestamptz;
  v_result jsonb;
  v_has_authority boolean := false;
  v_leave_ack jsonb;
  v_user_id uuid;
  v_subscription_action text := 'not_applicable';
  v_membership_action text := 'not_applicable';
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_ownership_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_event_id IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'identity_conflict'
    );
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = p_ownership_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT dispute.*
  INTO v_dispute
  FROM public.stripe_charge_dispute_events AS dispute
  WHERE dispute.livemode = p_livemode
    AND dispute.stripe_event_id = p_stripe_event_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || v_ownership.stripe_charge_id,
      0
    )
  );
  IF v_ownership.stripe_payment_intent_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-payment-identity:'
          || v_ownership.stripe_payment_intent_id,
        0
      )
    );
  END IF;
  IF v_ownership.checkout_session_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-checkout-session:' || v_ownership.checkout_session_id,
        0
      )
    );
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = p_ownership_id
  FOR UPDATE;
  SELECT dispute.*
  INTO v_dispute
  FROM public.stripe_charge_dispute_events AS dispute
  WHERE dispute.livemode = p_livemode
    AND dispute.stripe_event_id = p_stripe_event_id
  FOR SHARE;

  IF NOT FOUND
    OR NOT public.stripe_payment_ownership_has_exact_dispute_v2(
      v_ownership.id,
      p_livemode,
      p_stripe_event_id
    )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'identity_conflict'
    );
  END IF;

  CASE v_ownership.product_kind
    WHEN 'api_tier' THEN
      INSERT INTO public.stripe_api_tier_reversal_events (
        livemode,
        stripe_event_id,
        ownership_id,
        reversal_kind,
        stripe_charge_id,
        stripe_dispute_id,
        dispute_status,
        dispute_reason,
        dispute_amount,
        currency,
        stripe_event_created
      ) VALUES (
        v_dispute.livemode,
        v_dispute.stripe_event_id,
        v_ownership.id,
        'dispute',
        v_dispute.stripe_charge_id,
        v_dispute.stripe_dispute_id,
        v_dispute.dispute_status,
        v_dispute.dispute_reason,
        v_dispute.dispute_amount,
        v_dispute.currency,
        v_dispute.stripe_event_created
      )
      ON CONFLICT (livemode, stripe_event_id) DO NOTHING;

      IF NOT EXISTS (
        SELECT 1
        FROM public.stripe_api_tier_reversal_events AS reversal
        WHERE reversal.livemode = v_dispute.livemode
          AND reversal.stripe_event_id =
            v_dispute.stripe_event_id
          AND reversal.ownership_id = v_ownership.id
          AND reversal.reversal_kind = 'dispute'
          AND reversal.stripe_charge_id =
            v_dispute.stripe_charge_id
          AND reversal.stripe_dispute_id =
            v_dispute.stripe_dispute_id
          AND reversal.dispute_status =
            v_dispute.dispute_status
          AND reversal.dispute_reason =
            v_dispute.dispute_reason
          AND reversal.dispute_amount =
            v_dispute.dispute_amount
          AND reversal.currency = v_dispute.currency
          AND reversal.stripe_event_created =
            v_dispute.stripe_event_created
      ) THEN
        RETURN pg_catalog.jsonb_build_object(
          'status',
          'identity_conflict'
        );
      END IF;

      v_result :=
        public.project_api_tier_financial_reversal_atomic(
          v_ownership.id,
          true
        );

    WHEN 'tip' THEN
      PERFORM public.lock_tip_notification_authority_atomic(
        v_ownership.ledger_id
      );
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
        OR v_tip.currency IS DISTINCT FROM v_ownership.currency
        OR v_tip.status NOT IN ('completed', 'refunded')
      THEN
        RETURN pg_catalog.jsonb_build_object(
          'status',
          'identity_conflict'
        );
      END IF;

      UPDATE public.tips
      SET status = 'refunded',
          updated_at = v_now
      WHERE id = v_tip.id
        AND status = 'completed';

      -- The existing terminal trigger performs this suppression. Repeat the
      -- exact effect idempotently so readiness never relies on trigger history.
      DELETE FROM public.notifications AS notification
      WHERE notification.type = 'tip_received'
        AND notification.reference_id = v_tip.id;
      UPDATE public.tip_completion_notification_deliveries
      SET disposition = 'refund_suppressed',
          disposed_at = COALESCE(disposed_at, v_now)
      WHERE tip_id = v_tip.id
        AND disposition IN (
          'delivered',
          'recipient_deleted',
          'authority_deleted',
          'authority_unavailable'
        );

      v_result := pg_catalog.jsonb_build_object(
        'status', 'revoked',
        'tip_id', v_tip.id,
        'notification_suppressed', true
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
      THEN
        RETURN pg_catalog.jsonb_build_object(
          'status',
          'identity_conflict'
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
      IF v_payment.stripe_subscription_id IS NOT NULL THEN
        PERFORM pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended(
            'pro-stripe-subscription:'
              || v_payment.stripe_subscription_id,
            0
          )
        );
      END IF;

      PERFORM profile.id
      FROM public.user_profiles AS profile
      WHERE profile.id = v_user_id
      FOR UPDATE;

      UPDATE public.stripe_entitlement_effects
      SET status = 'superseded',
          lease_token = NULL,
          lease_expires_at = NULL,
          last_error = 'payment_disputed',
          completed_at = COALESCE(completed_at, v_now),
          updated_at = v_now
      WHERE entitlement_payment_id = v_payment.id
        AND effect_type IN (
          'payment_auto_refund',
          'pro_official_group_join',
          'pro_official_group_restore',
          'pro_purchase_alert'
        )
        AND status IN ('pending', 'processing', 'failed');

      IF v_payment.payment_kind = 'lifetime' THEN
        UPDATE public.stripe_lifetime_seat_reservations
        SET status = 'released',
            release_reason = 'payment_fully_refunded',
            released_at = v_now,
            updated_at = v_now
        WHERE user_id = v_user_id
          AND checkout_session_id =
            v_payment.checkout_session_id
          AND status = 'bound'
          AND converted_payment_id IS NULL;

        UPDATE public.pro_entitlement_grants
        SET revoked_at = COALESCE(revoked_at, v_now),
            metadata = metadata || pg_catalog.jsonb_build_object(
              'episode_closed_at', v_now,
              'episode_close_reason', 'payment_disputed',
              'dispute_event_id', v_dispute.stripe_event_id,
              'stripe_dispute_id', v_dispute.stripe_dispute_id
            ),
            updated_at = v_now
        WHERE user_id = v_user_id
          AND source = 'stripe_lifetime_payment'
          AND source_key = 'payment:' || v_payment.id::text
          AND revoked_at IS NULL;
      ELSE
        UPDATE public.pro_entitlement_grants
        SET revoked_at = COALESCE(revoked_at, v_now),
            metadata = metadata || pg_catalog.jsonb_build_object(
              'episode_closed_at', v_now,
              'episode_close_reason', 'payment_disputed',
              'dispute_event_id', v_dispute.stripe_event_id,
              'stripe_dispute_id', v_dispute.stripe_dispute_id
            ),
            updated_at = v_now
        WHERE user_id = v_user_id
          AND source = 'stripe_payment_retry_grace'
          AND metadata ->> 'stripe_subscription_id' =
            v_payment.stripe_subscription_id
          AND revoked_at IS NULL;

        INSERT INTO public.api_tier_reversal_actions (
          ownership_id,
          product_kind,
          livemode,
          user_id,
          stripe_customer_id,
          stripe_subscription_id
        ) VALUES (
          v_ownership.id,
          'pro_entitlement',
          v_payment.livemode,
          v_user_id,
          v_payment.stripe_customer_id,
          v_payment.stripe_subscription_id
        )
        ON CONFLICT DO NOTHING;

        IF NOT EXISTS (
          SELECT 1
          FROM public.api_tier_reversal_actions AS action
          WHERE action.product_kind = 'pro_entitlement'
            AND action.livemode = v_payment.livemode
            AND action.stripe_subscription_id =
              v_payment.stripe_subscription_id
            AND action.action_kind = 'cancel_subscription'
            AND action.user_id = v_user_id
            AND action.stripe_customer_id =
              v_payment.stripe_customer_id
        ) THEN
          RETURN pg_catalog.jsonb_build_object(
            'status',
            'identity_conflict'
          );
        END IF;
      END IF;

      UPDATE public.subscriptions AS subscription
      SET status = 'canceled',
          cancel_at_period_end = false,
          canceled_at = COALESCE(subscription.canceled_at, v_now),
          entitlement_trial_verified_at = NULL,
          updated_at = v_now
      WHERE subscription.user_id = v_user_id
        AND (
          subscription.entitlement_payment_id = v_payment.id
          OR (
            v_payment.payment_kind = 'recurring'
            AND subscription.stripe_subscription_id =
              v_payment.stripe_subscription_id
            AND subscription.stripe_customer_id =
              v_payment.stripe_customer_id
          )
        )
        AND subscription.status IN ('active', 'trialing');

      IF EXISTS (
        SELECT 1
        FROM public.user_profiles AS profile
        WHERE profile.id = v_user_id
          AND profile.deleted_at IS NULL
      ) THEN
        v_has_authority :=
          public.sync_current_pro_projection_atomic(v_user_id);
        IF NOT v_has_authority THEN
          v_leave_ack :=
            public.leave_pro_official_group_atomic(v_user_id);
          IF COALESCE(v_leave_ack ->> 'status', '')
            NOT IN ('left', 'not_member')
          THEN
            RAISE EXCEPTION
              'atomic official-group leave returned invalid status';
          END IF;
        END IF;
      END IF;

      v_result := pg_catalog.jsonb_build_object(
        'status',
          CASE
            WHEN v_has_authority THEN 'grant_protected'
            ELSE 'revoked'
          END,
        'user_id', v_user_id,
        'stripe_subscription_id',
          v_payment.stripe_subscription_id,
        'should_cancel',
          v_payment.payment_kind = 'recurring'
      );

    WHEN 'group_pass' THEN
      SELECT consumption.*
      INTO v_consumption
      FROM public.group_payment_consumptions AS consumption
      WHERE consumption.id = v_ownership.ledger_id;
      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object(
          'status',
          'identity_conflict'
        );
      END IF;

      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'group-membership:' || v_consumption.group_id::text
            || ':' || v_consumption.user_id::text,
          0
        )
      );
      PERFORM 1
      FROM public.group_subscriptions AS subscription
      WHERE subscription.group_id = v_consumption.group_id
        AND subscription.user_id = v_consumption.user_id
      ORDER BY subscription.id
      FOR UPDATE;
      PERFORM 1
      FROM public.group_members AS member
      WHERE member.group_id = v_consumption.group_id
        AND member.user_id = v_consumption.user_id
      FOR UPDATE;
      PERFORM 1
      FROM public.group_trial_consumptions AS trial
      WHERE trial.group_id = v_consumption.group_id
        AND trial.user_id = v_consumption.user_id
      FOR SHARE;

      SELECT consumption.*
      INTO v_consumption
      FROM public.group_payment_consumptions AS consumption
      WHERE consumption.id = v_ownership.ledger_id
      FOR UPDATE;
      IF NOT FOUND
        OR v_consumption.outcome NOT IN ('activated', 'renewed')
        OR v_consumption.result ->> 'status' NOT IN (
          'subscribed',
          'renewed'
        )
      THEN
        RETURN pg_catalog.jsonb_build_object(
          'status',
          'identity_conflict'
        );
      END IF;

      SELECT subscription.*
      INTO v_subscription
      FROM public.group_subscriptions AS subscription
      WHERE subscription.id = v_consumption.subscription_id
      FOR UPDATE;

      IF FOUND AND (
        v_subscription.group_id IS DISTINCT FROM
          v_consumption.group_id
        OR v_subscription.user_id IS DISTINCT FROM
          v_consumption.user_id
      ) THEN
        RETURN pg_catalog.jsonb_build_object(
          'status',
          'identity_conflict'
        );
      END IF;

      IF v_subscription.id IS NULL THEN
        v_subscription_action := 'already_missing';
      ELSIF v_subscription.status IN ('active', 'trialing')
        AND v_subscription.expires_at > v_now
        AND v_subscription.status = 'active'
        AND v_subscription.payment_provider = 'stripe'
        AND v_subscription.payment_reference =
          'stripe:' || v_consumption.payment_intent_id
      THEN
        UPDATE public.group_subscriptions
        SET status = 'expired',
            expires_at = LEAST(expires_at, v_now),
            cancelled_at = COALESCE(cancelled_at, v_now),
            cancel_at_period_end = false,
            updated_at = v_now
        WHERE id = v_subscription.id;
        v_subscription_action := 'expired_exact_payment';
      ELSE
        v_subscription_action := 'not_current';
      END IF;

      IF v_consumption.result ->> 'membership_status' =
        'already_member'
      THEN
        v_membership_action := 'membership_preexisting';
      ELSE
        SELECT member.role::text, member.joined_at
        INTO v_member_role, v_member_joined_at
        FROM public.group_members AS member
        WHERE member.group_id = v_consumption.group_id
          AND member.user_id = v_consumption.user_id
        FOR UPDATE;

        IF NOT FOUND THEN
          v_membership_action := 'payment_member_already_absent';
        ELSIF v_member_role <> 'member' THEN
          v_membership_action := 'membership_role_changed';
        ELSIF v_consumption.payment_member_joined_at IS NULL
          OR v_member_joined_at IS DISTINCT FROM
            v_consumption.payment_member_joined_at
        THEN
          RETURN pg_catalog.jsonb_build_object(
            'status',
            'identity_conflict'
          );
        ELSIF public.group_pass_has_nondisputed_current_authority_v3(
          v_consumption.group_id,
          v_consumption.user_id,
          v_ownership.id
        ) THEN
          v_membership_action :=
            'payment_member_retained_independent_authority';
        ELSE
          DELETE FROM public.group_members AS member
          WHERE member.group_id = v_consumption.group_id
            AND member.user_id = v_consumption.user_id
            AND member.role::text = 'member'
            AND member.joined_at =
              v_consumption.payment_member_joined_at;
          IF NOT FOUND THEN
            RAISE EXCEPTION
              'payment-created group membership changed concurrently'
              USING ERRCODE = '40001';
          END IF;
          v_membership_action := 'payment_member_deleted';
        END IF;
      END IF;

      v_result := pg_catalog.jsonb_build_object(
        'status', 'revoked',
        'subscription_id', v_consumption.subscription_id,
        'subscription_action', v_subscription_action,
        'membership_action', v_membership_action
      );

    ELSE
      v_result := pg_catalog.jsonb_build_object(
        'status',
        'identity_conflict'
      );
  END CASE;

  IF COALESCE(v_result ->> 'status', '') IN (
    '',
    'identity_conflict',
    'manual_review',
    'not_found'
  ) THEN
    RETURN v_result;
  END IF;

  INSERT INTO public.stripe_charge_dispute_projections (
    livemode,
    stripe_event_id,
    ownership_id,
    product_kind,
    result
  ) VALUES (
    v_dispute.livemode,
    v_dispute.stripe_event_id,
    v_ownership.id,
    v_ownership.product_kind,
    v_result
  )
  ON CONFLICT (livemode, stripe_event_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.stripe_charge_dispute_projections AS projection
    WHERE projection.livemode = v_dispute.livemode
      AND projection.stripe_event_id =
        v_dispute.stripe_event_id
      AND projection.ownership_id = v_ownership.id
      AND projection.product_kind =
        v_ownership.product_kind
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'identity_conflict'
    );
  END IF;

  RETURN v_result;
END
$function$;

ALTER FUNCTION
  public.project_stripe_charge_dispute_ownership_atomic(
    uuid, boolean, text
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.project_stripe_charge_dispute_ownership_atomic(
    uuid, boolean, text
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

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

  IF v_state = 'none' THEN
    RETURN NEW;
  END IF;
  IF v_state IS DISTINCT FROM 'disputed' THEN
    RAISE EXCEPTION
      'payment ownership conflicts with an earlier Stripe dispute'
      USING ERRCODE = '23514';
  END IF;

  FOR v_dispute IN
    SELECT dispute.livemode, dispute.stripe_event_id
    FROM public.stripe_charge_dispute_events AS dispute
    WHERE dispute.livemode = NEW.livemode
      AND dispute.stripe_charge_id = NEW.stripe_charge_id
      AND dispute.stripe_customer_id =
        NEW.stripe_customer_id
      AND dispute.stripe_payment_intent_id IS NOT DISTINCT FROM
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
        USING ERRCODE = '23514',
          DETAIL = pg_catalog.left(v_result::text, 1000);
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

CREATE CONSTRAINT TRIGGER
  trg_stripe_payment_ownerships_dispute_projection
AFTER INSERT ON public.stripe_payment_ownerships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION
  public.project_dispute_after_payment_ownership_insert();

CREATE OR REPLACE FUNCTION public.claim_api_tier_reversal_actions_atomic(
  p_worker_token uuid,
  p_limit integer,
  p_lease_seconds integer,
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
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_worker_token IS NULL
    OR p_limit IS NULL
    OR p_limit NOT BETWEEN 1 AND 100
    OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 30 AND 900
    OR p_livemode IS NULL
  THEN
    RAISE EXCEPTION 'reversal action claim input is invalid'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT action.id
    FROM public.api_tier_reversal_actions AS action
    WHERE action.livemode = p_livemode
      AND (
        (
          action.state = 'pending'
          AND action.next_attempt_at <= pg_catalog.clock_timestamp()
        )
        OR (
          action.state = 'leased'
          AND action.lease_expires_at <= pg_catalog.clock_timestamp()
        )
      )
    ORDER BY action.next_attempt_at, action.created_at, action.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ),
  claimed AS (
    UPDATE public.api_tier_reversal_actions AS action
    SET state = 'leased',
        attempts = action.attempts + 1,
        lease_token = p_worker_token,
        lease_expires_at = pg_catalog.clock_timestamp()
          + pg_catalog.make_interval(secs => p_lease_seconds),
        last_error = CASE
          WHEN action.state = 'leased'
            THEN COALESCE(
              action.last_error,
              'expired lease reclaimed'
            )
          ELSE action.last_error
        END,
        updated_at = pg_catalog.clock_timestamp()
    FROM candidates
    WHERE action.id = candidates.id
    RETURNING
      action.id,
      action.ownership_id,
      action.product_kind,
      action.livemode,
      action.user_id,
      action.stripe_customer_id,
      action.stripe_subscription_id,
      action.attempts,
      action.lease_token,
      action.lease_expires_at
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', claimed.id,
        'ownership_id', claimed.ownership_id,
        'product_kind', claimed.product_kind,
        'livemode', claimed.livemode,
        'user_id', claimed.user_id,
        'stripe_customer_id', claimed.stripe_customer_id,
        'stripe_subscription_id',
          claimed.stripe_subscription_id,
        'attempts', claimed.attempts,
        'lease_token', claimed.lease_token,
        'lease_expires_at', claimed.lease_expires_at
      )
      ORDER BY claimed.id
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM claimed;

  RETURN v_result;
END
$function$;

ALTER FUNCTION public.claim_api_tier_reversal_actions_atomic(
  uuid, integer, integer, boolean
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_api_tier_reversal_actions_atomic(
  uuid, integer, integer, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.claim_api_tier_reversal_actions_atomic(
  uuid, integer, integer, boolean
) TO service_role;

ALTER FUNCTION public.record_api_tier_dispute_reversal_atomic(
  boolean, text, bigint, text, text, text, bigint, text, text, text,
  text, bigint
)
RENAME TO record_api_tier_dispute_reversal_pre_global_v2;
REVOKE ALL ON FUNCTION
  public.record_api_tier_dispute_reversal_pre_global_v2(
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
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_ownership_count integer := 0;
  v_projection jsonb;
  v_api_result jsonb;
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
    OR p_dispute_status IS NULL
    OR pg_catalog.length(p_dispute_status) NOT BETWEEN 1 AND 100
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
  THEN
    RAISE EXCEPTION 'Stripe dispute identity is invalid'
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

  INSERT INTO public.stripe_charge_dispute_events (
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
    captured_amount
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
    p_captured_amount
  )
  ON CONFLICT DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.stripe_charge_dispute_events AS dispute
    WHERE dispute.livemode = p_livemode
      AND dispute.stripe_event_id = p_stripe_event_id
      AND dispute.stripe_event_created =
        p_stripe_event_created
      AND dispute.stripe_dispute_id =
        p_stripe_dispute_id
      AND dispute.dispute_status = p_dispute_status
      AND dispute.dispute_reason = p_dispute_reason
      AND dispute.dispute_amount = p_dispute_amount
      AND dispute.currency = p_currency
      AND dispute.stripe_customer_id =
        p_stripe_customer_id
      AND dispute.stripe_payment_intent_id
        IS NOT DISTINCT FROM p_stripe_payment_intent_id
      AND dispute.stripe_charge_id = p_stripe_charge_id
      AND dispute.captured_amount = p_captured_amount
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'dispute',
      p_stripe_dispute_id,
      NULL,
      'stripe_dispute_event_identity_conflict',
      'A Stripe dispute event or dispute id belongs to a different immutable Charge identity.',
      pg_catalog.jsonb_build_object(
        'event_id', p_stripe_event_id,
        'charge_id', p_stripe_charge_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'identity_conflict'
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
    -- Keep the exact event durable. The deferred ownership trigger projects it
    -- if the payment writer commits after this dispute-first observation.
    RETURN pg_catalog.jsonb_build_object('status', 'not_api');
  END IF;
  IF v_ownership_count <> 1 THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_identity',
      p_stripe_charge_id,
      NULL,
      'stripe_dispute_ownership_conflict',
      'A disputed Charge maps to multiple central Stripe ownership rows.',
      pg_catalog.jsonb_build_object(
        'dispute_id', p_stripe_dispute_id,
        'payment_intent_id', p_stripe_payment_intent_id
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'identity_conflict'
    );
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = v_ownership.id
  FOR UPDATE;

  IF public.stripe_charge_dispute_identity_state_v2(
      p_livemode,
      p_stripe_customer_id,
      p_stripe_payment_intent_id,
      p_stripe_charge_id,
      p_captured_amount,
      p_currency
    ) IS DISTINCT FROM 'disputed'
    OR NOT public.stripe_payment_ownership_has_exact_dispute_v2(
      v_ownership.id,
      p_livemode,
      p_stripe_event_id
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      p_stripe_charge_id,
      v_ownership.owner_user_id,
      'stripe_dispute_payment_identity_conflict',
      'A disputed Charge conflicts with immutable central payment ownership.',
      pg_catalog.jsonb_build_object(
        'ownership_id', v_ownership.id,
        'dispute_id', p_stripe_dispute_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'identity_conflict'
    );
  END IF;

  IF v_ownership.product_kind = 'api_tier' THEN
    v_api_result :=
      public.record_api_tier_dispute_reversal_pre_global_v2(
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
    IF COALESCE(v_api_result ->> 'status', '') <>
      'api_tier'
    THEN
      RETURN v_api_result;
    END IF;
  END IF;

  v_projection :=
    public.project_stripe_charge_dispute_ownership_atomic(
      v_ownership.id,
      p_livemode,
      p_stripe_event_id
    );
  IF COALESCE(v_projection ->> 'status', '') IN (
    '',
    'identity_conflict',
    'manual_review',
    'not_found'
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      CASE
        WHEN v_projection ->> 'status' = 'manual_review'
          THEN 'manual_review'
        ELSE 'identity_conflict'
      END
    );
  END IF;

  IF v_ownership.product_kind = 'api_tier' THEN
    RETURN v_api_result;
  END IF;

  -- Old and new application instances both understand this exact one-key
  -- acknowledgement. The durable product projection is intentionally hidden
  -- behind the compatibility status during the postdeploy migration window.
  RETURN pg_catalog.jsonb_build_object('status', 'not_api');
END
$function$;

ALTER FUNCTION public.record_api_tier_dispute_reversal_atomic(
  boolean, text, bigint, text, text, text, bigint, text, text, text,
  text, bigint
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_api_tier_dispute_reversal_atomic(
  boolean, text, bigint, text, text, text, bigint, text, text, text,
  text, bigint
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.record_api_tier_dispute_reversal_atomic(
  boolean, text, bigint, text, text, text, bigint, text, text, text,
  text, bigint
) TO service_role;

-- A mutable subscriptions row is not authority after any exact bound payment
-- was disputed, even if a delayed Stripe state webhook says "active" again.
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
      WHERE subscription.user_id = p_user_id
        AND subscription.tier = 'pro'
        AND payment.livemode IS TRUE
        AND payment.payment_status IN ('paid', 'succeeded')
        AND NOT (
          payment.refund_state = 'succeeded'
          AND payment.refund_succeeded_amount >= payment.amount_paid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.stripe_payment_ownerships AS ownership
          JOIN public.stripe_charge_dispute_events AS dispute
            ON dispute.livemode = ownership.livemode
           AND dispute.stripe_charge_id =
             ownership.stripe_charge_id
           AND dispute.stripe_customer_id =
             ownership.stripe_customer_id
           AND dispute.stripe_payment_intent_id
             IS NOT DISTINCT FROM
               ownership.stripe_payment_intent_id
           AND dispute.captured_amount = ownership.amount_paid
           AND dispute.currency = ownership.currency
          WHERE ownership.product_kind = 'pro_entitlement'
            AND ownership.ledger_id = payment.id
            AND public.stripe_payment_ownership_is_exact_v2(
              ownership.id
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.api_tier_reversal_actions AS action
          WHERE action.product_kind = 'pro_entitlement'
            AND action.livemode = payment.livemode
            AND action.stripe_subscription_id =
              payment.stripe_subscription_id
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

CREATE OR REPLACE FUNCTION public.guard_stripe_derived_pro_grant_livemode()
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
      WHERE payment.user_id = NEW.user_id
        AND payment.payment_kind = 'lifetime'
        AND payment.plan = 'lifetime'
        AND payment.livemode IS TRUE
        AND NEW.source_key = 'payment:' || payment.id::text
        AND NEW.metadata ->> 'payment_id' = payment.id::text
        AND NOT (
          payment.refund_state = 'succeeded'
          AND payment.refund_succeeded_amount >= payment.amount_paid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.stripe_payment_ownerships AS ownership
          JOIN public.stripe_charge_dispute_events AS dispute
            ON dispute.livemode = ownership.livemode
           AND dispute.stripe_charge_id =
             ownership.stripe_charge_id
           AND dispute.stripe_customer_id =
             ownership.stripe_customer_id
           AND dispute.stripe_payment_intent_id
             IS NOT DISTINCT FROM
               ownership.stripe_payment_intent_id
           AND dispute.captured_amount = ownership.amount_paid
           AND dispute.currency = ownership.currency
          WHERE ownership.product_kind = 'pro_entitlement'
            AND ownership.ledger_id = payment.id
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
      WHERE payment.user_id = NEW.user_id
        AND payment.payment_kind = 'recurring'
        AND payment.livemode IS TRUE
        AND payment.stripe_subscription_id =
          NEW.metadata ->> 'stripe_subscription_id'
        AND NOT (
          payment.refund_state = 'succeeded'
          AND payment.refund_succeeded_amount >= payment.amount_paid
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.api_tier_reversal_actions AS action
          WHERE action.product_kind = 'pro_entitlement'
            AND action.livemode = payment.livemode
            AND action.stripe_subscription_id =
              payment.stripe_subscription_id
        )
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'Stripe-derived Pro grant lacks live non-disputed authority'
    USING ERRCODE = '23514';
END
$function$;

ALTER FUNCTION public.guard_stripe_derived_pro_grant_livemode()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_stripe_derived_pro_grant_livemode()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

ALTER FUNCTION public.activate_recurring_entitlement_payment_atomic(
  uuid, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, text, boolean
)
RENAME TO activate_recurring_entitlement_payment_pre_dispute_v2;
REVOKE ALL ON FUNCTION
  public.activate_recurring_entitlement_payment_pre_dispute_v2(
    uuid, text, text, text, text, text, text, bigint, text,
    timestamptz, timestamptz, text, text, boolean
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.activate_recurring_entitlement_payment_atomic(
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

ALTER FUNCTION public.activate_recurring_entitlement_payment_atomic(
  uuid, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, text, boolean
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.activate_recurring_entitlement_payment_atomic(
  uuid, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.activate_recurring_entitlement_payment_atomic(
  uuid, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, text, boolean
) TO service_role;

ALTER FUNCTION public.reconcile_recurring_subscription_state_atomic(
  uuid, text, text, text, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz, boolean
)
RENAME TO reconcile_recurring_subscription_state_pre_dispute_v2;
REVOKE ALL ON FUNCTION
  public.reconcile_recurring_subscription_state_pre_dispute_v2(
    uuid, text, text, text, text, timestamptz, timestamptz, text,
    boolean, timestamptz, timestamptz, text, timestamptz, boolean
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.reconcile_recurring_subscription_state_atomic(
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

ALTER FUNCTION public.reconcile_recurring_subscription_state_atomic(
  uuid, text, text, text, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz, boolean
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reconcile_recurring_subscription_state_atomic(
  uuid, text, text, text, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.reconcile_recurring_subscription_state_atomic(
  uuid, text, text, text, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz, boolean
) TO service_role;

ALTER FUNCTION public.stripe_paid_launch_readiness_v2()
  RENAME TO stripe_paid_launch_readiness_pre_dispute_v2;
REVOKE ALL ON FUNCTION
  public.stripe_paid_launch_readiness_pre_dispute_v2()
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
  v_unprojected integer;
  v_identity_anomalies integer;
  v_authority_drift_delta integer;
  v_authority_drift integer;
  v_ready boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  v_base :=
    public.stripe_paid_launch_readiness_pre_dispute_v2();

  SELECT pg_catalog.count(*)::integer
  INTO v_unprojected
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
  INTO v_identity_anomalies;

  SELECT (
    (
      SELECT pg_catalog.count(*)
      FROM public.stripe_charge_dispute_projections AS projection
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.id = projection.ownership_id
      JOIN public.tips AS tip
        ON tip.id = ownership.ledger_id
      WHERE projection.livemode IS TRUE
        AND projection.product_kind = 'tip'
        AND (
          tip.status <> 'refunded'
          OR EXISTS (
            SELECT 1
            FROM public.notifications AS notification
            WHERE notification.type = 'tip_received'
              AND notification.reference_id = tip.id
          )
          OR EXISTS (
            SELECT 1
            FROM public.tip_completion_notification_deliveries
              AS delivery
            WHERE delivery.tip_id = tip.id
              AND delivery.disposition IN (
                'delivered',
                'recipient_deleted',
                'authority_deleted',
                'authority_unavailable'
              )
          )
        )
    )
    + (
      SELECT pg_catalog.count(*)
      FROM public.stripe_charge_dispute_projections AS projection
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.id = projection.ownership_id
      JOIN public.stripe_entitlement_payments AS payment
        ON payment.id = ownership.ledger_id
      WHERE projection.livemode IS TRUE
        AND projection.product_kind = 'pro_entitlement'
        AND (
          EXISTS (
            SELECT 1
            FROM public.subscriptions AS subscription
            WHERE subscription.user_id = payment.user_id
              AND subscription.status IN ('active', 'trialing')
              AND (
                subscription.entitlement_payment_id = payment.id
                OR (
                  payment.payment_kind = 'recurring'
                  AND subscription.stripe_subscription_id =
                    payment.stripe_subscription_id
                  AND subscription.stripe_customer_id =
                    payment.stripe_customer_id
                )
              )
          )
          OR EXISTS (
            SELECT 1
            FROM public.pro_entitlement_grants AS entitlement_grant
            WHERE entitlement_grant.user_id = payment.user_id
              AND entitlement_grant.revoked_at IS NULL
              AND (
                (
                  payment.payment_kind = 'lifetime'
                  AND entitlement_grant.source =
                    'stripe_lifetime_payment'
                  AND entitlement_grant.source_key =
                    'payment:' || payment.id::text
                )
                OR (
                  payment.payment_kind = 'recurring'
                  AND entitlement_grant.source =
                    'stripe_payment_retry_grace'
                  AND entitlement_grant.metadata
                    ->> 'stripe_subscription_id' =
                      payment.stripe_subscription_id
                )
              )
          )
          OR (
            payment.payment_kind = 'recurring'
            AND NOT EXISTS (
              SELECT 1
              FROM public.api_tier_reversal_actions AS action
              WHERE action.product_kind = 'pro_entitlement'
                AND action.livemode = payment.livemode
                AND action.stripe_subscription_id =
                  payment.stripe_subscription_id
                AND action.user_id = payment.user_id
                AND action.stripe_customer_id =
                  payment.stripe_customer_id
            )
          )
        )
    )
    + (
      SELECT pg_catalog.count(*)
      FROM public.stripe_charge_dispute_projections AS projection
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.id = projection.ownership_id
      JOIN public.group_payment_consumptions AS consumption
        ON consumption.id = ownership.ledger_id
      WHERE projection.livemode IS TRUE
        AND projection.product_kind = 'group_pass'
        AND (
          EXISTS (
            SELECT 1
            FROM public.group_subscriptions AS subscription
            WHERE subscription.id = consumption.subscription_id
              AND subscription.group_id = consumption.group_id
              AND subscription.user_id = consumption.user_id
              AND subscription.status IN ('active', 'trialing')
              AND subscription.expires_at >
                pg_catalog.statement_timestamp()
              AND subscription.payment_provider = 'stripe'
              AND subscription.payment_reference =
                'stripe:' || consumption.payment_intent_id
          )
          OR (
            consumption.result ->> 'membership_status' = 'joined'
            AND EXISTS (
              SELECT 1
              FROM public.group_members AS member
              WHERE member.group_id = consumption.group_id
                AND member.user_id = consumption.user_id
                AND member.role::text = 'member'
                AND member.joined_at =
                  consumption.payment_member_joined_at
            )
            AND NOT public.group_pass_has_nondisputed_current_authority_v3(
              consumption.group_id,
              consumption.user_id,
              ownership.id
            )
          )
        )
    )
  )::integer
  INTO v_authority_drift_delta;

  v_authority_drift :=
    COALESCE((v_base ->> 'authority_drift')::integer, -1)
      + v_identity_anomalies
      + v_authority_drift_delta;

  v_ready :=
    COALESCE(v_base ->> 'status', '') = 'ready'
    AND v_unprojected = 0
    AND v_identity_anomalies = 0
    AND v_authority_drift_delta = 0;

  RETURN v_base || pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_ready THEN 'ready' ELSE 'blocked' END,
    'authority_drift', v_authority_drift,
    'unprojected_charge_disputes', v_unprojected,
    'charge_dispute_identity_anomalies',
      v_identity_anomalies,
    'charge_dispute_authority_drift',
      v_authority_drift_delta
  );
END
$function$;

ALTER FUNCTION public.stripe_paid_launch_readiness_v2()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_paid_launch_readiness_v2()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.stripe_paid_launch_readiness_v2()
  TO service_role;

DO $postflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_relation pg_catalog.regclass;
  v_function pg_catalog.regprocedure;
  v_trigger_oid oid;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.stripe_charge_dispute_events'::pg_catalog.regclass,
    'public.stripe_charge_dispute_projections'::pg_catalog.regclass
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND relation.relowner = v_postgres
        AND relation.relrowsecurity
        AND NOT relation.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION
        'Stripe dispute audit relation is not owner-sealed: %',
        v_relation;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(
        COALESCE(
          (SELECT relation.relacl
           FROM pg_catalog.pg_class AS relation
           WHERE relation.oid = v_relation),
          pg_catalog.acldefault('r', v_postgres)
        )
      ) AS acl
      WHERE acl.grantee NOT IN (0, v_postgres)
    ) THEN
      RAISE EXCEPTION
        'Stripe dispute audit relation has non-owner ACL: %',
        v_relation;
    END IF;
  END LOOP;

  SELECT trigger_row.oid
  INTO v_trigger_oid
  FROM pg_catalog.pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid =
      'public.stripe_payment_ownerships'::pg_catalog.regclass
    AND trigger_row.tgname =
      'trg_stripe_payment_ownerships_dispute_projection'
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgdeferrable
    AND trigger_row.tginitdeferred;
  IF v_trigger_oid IS NULL THEN
    RAISE EXCEPTION
      'dispute-first ownership projection trigger is not deferred';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'public.api_tier_reversal_actions'::pg_catalog.regclass
      AND attribute.attname = 'product_kind'
      AND attribute.atttypid = 'pg_catalog.text'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attnotnull
      AND attribute.atthasdef
  ) THEN
    RAISE EXCEPTION
      'reversal actions are missing immutable product routing';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.prevent_stripe_dispute_audit_mutation()'::pg_catalog.regprocedure,
    'public.stripe_charge_dispute_identity_state_v2(boolean,text,text,text,bigint,text)'::pg_catalog.regprocedure,
    'public.stripe_payment_ownership_has_exact_dispute_v2(uuid,boolean,text)'::pg_catalog.regprocedure,
    'public.group_pass_has_nondisputed_current_authority_v3(uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.project_stripe_charge_dispute_ownership_atomic(uuid,boolean,text)'::pg_catalog.regprocedure,
    'public.project_dispute_after_payment_ownership_insert()'::pg_catalog.regprocedure,
    'public.record_api_tier_dispute_reversal_pre_global_v2(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)'::pg_catalog.regprocedure,
    'public.activate_recurring_entitlement_payment_pre_dispute_v2(uuid,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text,boolean)'::pg_catalog.regprocedure,
    'public.reconcile_recurring_subscription_state_pre_dispute_v2(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure,
    'public.stripe_paid_launch_readiness_pre_dispute_v2()'::pg_catalog.regprocedure
  ]
  LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.aclexplode(
        COALESCE(
          (SELECT function_row.proacl
           FROM pg_catalog.pg_proc AS function_row
           WHERE function_row.oid = v_function),
          pg_catalog.acldefault('f', v_postgres)
        )
      ) AS acl
      WHERE acl.grantee NOT IN (0, v_postgres)
    ) THEN
      RAISE EXCEPTION
        'owner-private Stripe dispute helper is executable: %',
        v_function;
    END IF;
  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    'public.record_api_tier_dispute_reversal_atomic(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)'::pg_catalog.regprocedure,
    'public.claim_api_tier_reversal_actions_atomic(uuid,integer,integer,boolean)'::pg_catalog.regprocedure,
    'public.activate_recurring_entitlement_payment_atomic(uuid,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text,boolean)'::pg_catalog.regprocedure,
    'public.reconcile_recurring_subscription_state_atomic(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone,boolean)'::pg_catalog.regprocedure,
    'public.stripe_paid_launch_readiness_v2()'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT pg_catalog.has_function_privilege(
        'service_role',
        v_function,
        'EXECUTE'
      )
      OR pg_catalog.has_function_privilege(
        'authenticated',
        v_function,
        'EXECUTE'
      )
      OR pg_catalog.has_function_privilege(
        'anon',
        v_function,
        'EXECUTE'
      )
    THEN
      RAISE EXCEPTION
        'Stripe dispute service RPC ACL drifted: %',
        v_function;
    END IF;
  END LOOP;
END
$postflight$;

COMMIT;
