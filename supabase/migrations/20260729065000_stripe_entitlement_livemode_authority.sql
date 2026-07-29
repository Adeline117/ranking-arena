-- Stripe test-mode objects and live-mode objects inhabit separate namespaces,
-- but most of the historical B2C entitlement ledgers did not persist that
-- namespace.  A test payment could therefore become indistinguishable from a
-- live payment after a key cutover.  Seal every authority and refund identity
-- to Stripe livemode before live paid launch.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_required_relation text;
  v_required_function text;
BEGIN
  FOREACH v_required_relation IN ARRAY ARRAY[
    'public.stripe_entitlement_payments',
    'public.stripe_trial_entitlements',
    'public.stripe_subscription_state_events',
    'public.stripe_entitlement_refund_events',
    'public.stripe_charge_refund_tombstones',
    'public.stripe_charge_refund_tombstone_events',
    'public.stripe_payment_ownerships',
    'public.stripe_charge_refund_observation_modes',
    'public.group_payment_consumptions',
    'public.stripe_api_tier_payments',
    'public.pro_entitlement_grants',
    'public.subscriptions',
    'public.group_subscriptions',
    'public.user_profiles'
  ]
  LOOP
    IF pg_catalog.to_regclass(v_required_relation) IS NULL THEN
      RAISE EXCEPTION
        'Stripe livemode authority prerequisite is missing: %',
        v_required_relation;
    END IF;
  END LOOP;

  FOREACH v_required_function IN ARRAY ARRAY[
    'public.activate_recurring_entitlement_payment_atomic(uuid,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text)',
    'public.activate_recurring_trial_entitlement_atomic(uuid,text,text,text,timestamp with time zone,timestamp with time zone,text)',
    'public.reconcile_recurring_subscription_state_atomic(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone)',
    'public.activate_lifetime_membership_with_identity_atomic(uuid,text,text,uuid,text,text,bigint,text,timestamp with time zone,text)',
    'public.activate_group_subscription_with_stripe_ownership_atomic(uuid,uuid,text,text,text,bigint,text,text,text)',
    'public.record_charge_refund_tombstone_with_mode_atomic(boolean,uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)',
    'public.stripe_paid_launch_readiness_v2()',
    'public.stripe_payment_ownership_is_exact_v2(uuid)',
    'public.stripe_subscription_has_exact_payment_binding_v2(uuid)',
    'public.stripe_subscription_has_exact_trial_binding_v2(uuid)',
    'public.stripe_has_current_pro_authority_v2(uuid)',
    'public.has_current_global_pro_entitlement(uuid)'
  ]
  LOOP
    IF pg_catalog.to_regprocedure(v_required_function) IS NULL THEN
      RAISE EXCEPTION
        'Stripe livemode authority function is missing: %',
        v_required_function;
    END IF;
  END LOOP;

  IF pg_catalog.to_regrole('postgres') IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
  THEN
    RAISE EXCEPTION 'Stripe livemode authority roles are missing';
  END IF;
END
$preflight$;

LOCK TABLE
  public.stripe_entitlement_payments,
  public.stripe_trial_entitlements,
  public.stripe_subscription_state_events,
  public.stripe_entitlement_refund_events,
  public.stripe_charge_refund_tombstones,
  public.stripe_charge_refund_tombstone_events,
  public.stripe_payment_ownerships,
  public.group_payment_consumptions,
  public.pro_entitlement_grants,
  public.subscriptions,
  public.group_subscriptions,
  public.user_profiles
IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.stripe_entitlement_payments
  ADD COLUMN livemode boolean;
ALTER TABLE public.stripe_trial_entitlements
  ADD COLUMN livemode boolean;
ALTER TABLE public.stripe_subscription_state_events
  ADD COLUMN livemode boolean;
ALTER TABLE public.stripe_entitlement_refund_events
  ADD COLUMN livemode boolean;
ALTER TABLE public.stripe_charge_refund_tombstones
  ADD COLUMN livemode boolean;
ALTER TABLE public.stripe_charge_refund_tombstone_events
  ADD COLUMN livemode boolean;
ALTER TABLE public.stripe_payment_ownerships
  ADD COLUMN livemode boolean;
ALTER TABLE public.group_payment_consumptions
  ADD COLUMN livemode boolean;

-- This repository is intentionally in the documented free/test pre-launch
-- phase.  Rows that predate the cutover have no cryptographic mode proof, so
-- classify them as test rather than guessing that any is live.  API-tier rows
-- and refund observations already carried an authenticated mode and are the
-- only safe sources for a more precise backfill.
UPDATE public.stripe_entitlement_payments SET livemode = false;
UPDATE public.stripe_trial_entitlements SET livemode = false;
UPDATE public.stripe_subscription_state_events SET livemode = false;
ALTER TABLE public.group_payment_consumptions
  DISABLE TRIGGER trg_group_payment_consumptions_immutable;
UPDATE public.group_payment_consumptions SET livemode = false;
ALTER TABLE public.group_payment_consumptions
  ENABLE TRIGGER trg_group_payment_consumptions_immutable;

UPDATE public.stripe_charge_refund_tombstones AS tombstone
SET livemode = COALESCE(
  (
    SELECT CASE
      WHEN pg_catalog.bool_and(observation.livemode) THEN true
      WHEN NOT pg_catalog.bool_or(observation.livemode) THEN false
      ELSE NULL
    END
    FROM public.stripe_charge_refund_observation_modes AS observation
    WHERE observation.stripe_charge_id = tombstone.stripe_charge_id
  ),
  false
);

UPDATE public.stripe_charge_refund_tombstone_events AS refund_event
SET livemode = COALESCE(
  (
    SELECT CASE
      WHEN pg_catalog.bool_and(observation.livemode) THEN true
      WHEN NOT pg_catalog.bool_or(observation.livemode) THEN false
      ELSE NULL
    END
    FROM public.stripe_charge_refund_observation_modes AS observation
    WHERE observation.stripe_event_id = refund_event.event_id
      AND observation.stripe_charge_id = refund_event.stripe_charge_id
  ),
  (
    SELECT tombstone.livemode
    FROM public.stripe_charge_refund_tombstones AS tombstone
    WHERE tombstone.stripe_charge_id = refund_event.stripe_charge_id
  ),
  false
);

UPDATE public.stripe_entitlement_refund_events AS refund_event
SET livemode = COALESCE(
  (
    SELECT CASE
      WHEN pg_catalog.bool_and(observation.livemode) THEN true
      WHEN NOT pg_catalog.bool_or(observation.livemode) THEN false
      ELSE NULL
    END
    FROM public.stripe_charge_refund_observation_modes AS observation
    WHERE observation.stripe_event_id = refund_event.event_id
  ),
  (
    SELECT payment.livemode
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.id = refund_event.entitlement_payment_id
  ),
  false
);

ALTER TABLE public.stripe_payment_ownerships
  DISABLE TRIGGER trg_stripe_payment_ownerships_immutable;
UPDATE public.stripe_payment_ownerships AS ownership
SET livemode = COALESCE(
  CASE ownership.product_kind
    WHEN 'pro_entitlement' THEN (
      SELECT payment.livemode
      FROM public.stripe_entitlement_payments AS payment
      WHERE payment.id = ownership.ledger_id
    )
    WHEN 'group_pass' THEN (
      SELECT consumption.livemode
      FROM public.group_payment_consumptions AS consumption
      WHERE consumption.id = ownership.ledger_id
    )
    WHEN 'api_tier' THEN (
      SELECT payment.livemode
      FROM public.stripe_api_tier_payments AS payment
      WHERE payment.id = ownership.ledger_id
    )
    ELSE false
  END,
  false
);
ALTER TABLE public.stripe_payment_ownerships
  ENABLE TRIGGER trg_stripe_payment_ownerships_immutable;

ALTER TABLE public.stripe_entitlement_payments
  ALTER COLUMN livemode SET NOT NULL;
ALTER TABLE public.stripe_trial_entitlements
  ALTER COLUMN livemode SET NOT NULL;
ALTER TABLE public.stripe_subscription_state_events
  ALTER COLUMN livemode SET NOT NULL;
ALTER TABLE public.stripe_entitlement_refund_events
  ALTER COLUMN livemode SET NOT NULL;
ALTER TABLE public.stripe_charge_refund_tombstones
  ALTER COLUMN livemode SET NOT NULL;
ALTER TABLE public.stripe_charge_refund_tombstone_events
  ALTER COLUMN livemode SET NOT NULL;
ALTER TABLE public.stripe_payment_ownerships
  ALTER COLUMN livemode SET NOT NULL;
ALTER TABLE public.group_payment_consumptions
  ALTER COLUMN livemode SET NOT NULL;

CREATE INDEX stripe_entitlement_payments_mode_user_idx
  ON public.stripe_entitlement_payments (livemode, user_id, id);
CREATE INDEX stripe_trial_entitlements_mode_user_idx
  ON public.stripe_trial_entitlements (livemode, user_id, id);
CREATE INDEX stripe_payment_ownerships_mode_kind_idx
  ON public.stripe_payment_ownerships (livemode, product_kind, ledger_id);
CREATE INDEX group_payment_consumptions_mode_subscription_idx
  ON public.group_payment_consumptions (livemode, subscription_id, id);

CREATE OR REPLACE FUNCTION public.enforce_stripe_livemode_context()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_context text := pg_catalog.current_setting(
    'arena.stripe_livemode',
    true
  );
  v_livemode boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND v_context IS NULL THEN
    IF NEW.livemode IS DISTINCT FROM OLD.livemode THEN
      RAISE EXCEPTION 'Stripe livemode is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF v_context IS NULL OR v_context NOT IN ('true', 'false') THEN
    RAISE EXCEPTION 'authenticated Stripe livemode context is required'
      USING ERRCODE = '23514';
  END IF;
  v_livemode := v_context::boolean;

  IF NEW.livemode IS NOT NULL
    AND NEW.livemode IS DISTINCT FROM v_livemode
  THEN
    RAISE EXCEPTION 'Stripe livemode context mismatch'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE'
    AND OLD.livemode IS DISTINCT FROM v_livemode
  THEN
    RAISE EXCEPTION 'Stripe livemode replay mismatch'
      USING ERRCODE = '23514';
  END IF;

  NEW.livemode := v_livemode;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_stripe_livemode_context()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_stripe_livemode_context()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TRIGGER trg_stripe_entitlement_payments_livemode
  BEFORE INSERT OR UPDATE ON public.stripe_entitlement_payments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_stripe_livemode_context();
CREATE TRIGGER trg_stripe_trial_entitlements_livemode
  BEFORE INSERT OR UPDATE ON public.stripe_trial_entitlements
  FOR EACH ROW EXECUTE FUNCTION public.enforce_stripe_livemode_context();
CREATE TRIGGER trg_stripe_subscription_state_events_livemode
  BEFORE INSERT OR UPDATE ON public.stripe_subscription_state_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_stripe_livemode_context();
CREATE TRIGGER trg_stripe_entitlement_refund_events_livemode
  BEFORE INSERT OR UPDATE ON public.stripe_entitlement_refund_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_stripe_livemode_context();
CREATE TRIGGER trg_stripe_charge_refund_tombstones_livemode
  BEFORE INSERT OR UPDATE ON public.stripe_charge_refund_tombstones
  FOR EACH ROW EXECUTE FUNCTION public.enforce_stripe_livemode_context();
CREATE TRIGGER trg_stripe_charge_refund_tombstone_events_livemode
  BEFORE INSERT OR UPDATE ON public.stripe_charge_refund_tombstone_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_stripe_livemode_context();
CREATE TRIGGER trg_group_payment_consumptions_livemode
  BEFORE INSERT OR UPDATE ON public.group_payment_consumptions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_stripe_livemode_context();

CREATE OR REPLACE FUNCTION public.assign_stripe_payment_ownership_livemode()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_livemode boolean;
BEGIN
  CASE NEW.product_kind
    WHEN 'pro_entitlement' THEN
      SELECT payment.livemode
      INTO v_livemode
      FROM public.stripe_entitlement_payments AS payment
      WHERE payment.id = NEW.ledger_id;
    WHEN 'group_pass' THEN
      SELECT consumption.livemode
      INTO v_livemode
      FROM public.group_payment_consumptions AS consumption
      WHERE consumption.id = NEW.ledger_id;
    WHEN 'api_tier' THEN
      SELECT payment.livemode
      INTO v_livemode
      FROM public.stripe_api_tier_payments AS payment
      WHERE payment.id = NEW.ledger_id;
    WHEN 'tip' THEN
      -- Tip Checkout is separately sealed to live keys only.
      v_livemode := true;
    ELSE
      RAISE EXCEPTION 'unsupported Stripe ownership product kind'
        USING ERRCODE = '23514';
  END CASE;

  IF v_livemode IS NULL
    OR (
      NEW.livemode IS NOT NULL
      AND NEW.livemode IS DISTINCT FROM v_livemode
    )
  THEN
    RAISE EXCEPTION 'Stripe ownership has no exact livemode authority'
      USING ERRCODE = '23514';
  END IF;

  NEW.livemode := v_livemode;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.assign_stripe_payment_ownership_livemode()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assign_stripe_payment_ownership_livemode()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TRIGGER trg_stripe_payment_ownerships_livemode
  BEFORE INSERT ON public.stripe_payment_ownerships
  FOR EACH ROW
  EXECUTE FUNCTION public.assign_stripe_payment_ownership_livemode();

-- Preserve the existing exact identity contract and add one more immutable
-- equality: ownership and its product ledger must be in the same Stripe mode.
CREATE OR REPLACE FUNCTION public.stripe_payment_ownership_is_exact_v2(
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
      FROM public.stripe_payment_ownerships AS ownership
      WHERE ownership.id = p_ownership_id
        AND (
          (
            ownership.product_kind = 'pro_entitlement'
            AND EXISTS (
              SELECT 1
              FROM public.stripe_entitlement_payments AS payment
              WHERE payment.id = ownership.ledger_id
                AND payment.livemode = ownership.livemode
                AND payment.payment_status IN ('paid', 'succeeded')
                AND payment.user_id
                  IS NOT DISTINCT FROM ownership.owner_user_id
                AND payment.stripe_customer_id =
                  ownership.stripe_customer_id
                AND payment.stripe_payment_intent_id
                  IS NOT DISTINCT FROM
                    ownership.stripe_payment_intent_id
                AND payment.stripe_charge_id =
                  ownership.stripe_charge_id
                AND payment.checkout_session_id
                  IS NOT DISTINCT FROM ownership.checkout_session_id
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
                AND tip.status IN ('completed', 'refunded')
                AND tip.from_user_id = ownership.owner_user_id
                AND tip.stripe_customer_id =
                  ownership.stripe_customer_id
                AND tip.stripe_payment_intent_id =
                  ownership.stripe_payment_intent_id
                AND tip.stripe_charge_id =
                  ownership.stripe_charge_id
                AND tip.stripe_checkout_session_id =
                  ownership.checkout_session_id
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
                AND consumption.livemode = ownership.livemode
                AND consumption.provider = 'stripe'
                AND consumption.user_id = ownership.owner_user_id
                AND consumption.stripe_customer_id =
                  ownership.stripe_customer_id
                AND consumption.payment_intent_id =
                  ownership.stripe_payment_intent_id
                AND consumption.stripe_charge_id =
                  ownership.stripe_charge_id
                AND consumption.checkout_session_id
                  IS NOT DISTINCT FROM ownership.checkout_session_id
                AND ownership.checkout_session_id IS NOT NULL
                AND consumption.amount_cents = ownership.amount_paid
                AND consumption.currency = ownership.currency
                AND consumption.outcome IN (
                  'activated',
                  'renewed',
                  'refund_blocked'
                )
                AND consumption.result ->> 'subscription_id' =
                  consumption.subscription_id::text
                AND (
                  (
                    consumption.outcome IN ('activated', 'renewed')
                    AND consumption.result ->> 'status' IN (
                      'subscribed',
                      'renewed'
                    )
                    AND (
                      (
                        consumption.result ->> 'membership_status' =
                          'joined'
                        AND consumption.payment_member_joined_at
                          IS NOT NULL
                      )
                      OR (
                        consumption.result ->> 'membership_status' =
                          'already_member'
                        AND consumption.payment_member_joined_at IS NULL
                      )
                    )
                  )
                  OR (
                    consumption.outcome = 'refund_blocked'
                    AND consumption.result ->> 'status' =
                      'refund_observed'
                    AND consumption.payment_member_joined_at IS NULL
                  )
                )
            )
          )
          OR (
            ownership.product_kind = 'api_tier'
            AND ownership.owner_user_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM public.stripe_api_tier_payments AS payment
              JOIN public.api_tier_checkout_reservations AS reservation
                ON reservation.id = payment.checkout_reservation_id
              WHERE payment.id = ownership.ledger_id
                AND payment.livemode = ownership.livemode
                AND payment.user_id = ownership.owner_user_id
                AND payment.stripe_customer_id =
                  ownership.stripe_customer_id
                AND payment.stripe_payment_intent_id
                  IS NOT DISTINCT FROM
                    ownership.stripe_payment_intent_id
                AND payment.stripe_charge_id =
                  ownership.stripe_charge_id
                AND reservation.checkout_session_id =
                  ownership.checkout_session_id
                AND payment.amount_paid = ownership.amount_paid
                AND payment.currency = ownership.currency
            )
          )
        )
    )
$function$;

ALTER FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.stripe_subscription_has_exact_payment_binding_v2(
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

ALTER FUNCTION public.stripe_subscription_has_exact_payment_binding_v2(uuid)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.stripe_subscription_has_exact_trial_binding_v2(
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
      JOIN public.stripe_trial_entitlements AS trial
        ON trial.id = subscription.entitlement_trial_id
       AND trial.user_id = subscription.user_id
      WHERE subscription.user_id = p_user_id
        AND subscription.status = 'trialing'
        AND subscription.tier = 'pro'
        AND trial.livemode IS TRUE
        AND subscription.entitlement_payment_id IS NULL
        AND subscription.entitlement_trial_verified_at = trial.verified_at
        AND subscription.stripe_customer_id = trial.stripe_customer_id
        AND subscription.stripe_subscription_id =
          trial.stripe_subscription_id
        AND subscription.plan = trial.plan
        AND subscription.current_period_start = trial.period_start
        AND subscription.current_period_end = trial.period_end
        AND trial.revoked_at IS NULL
        AND trial.period_end > pg_catalog.statement_timestamp()
    )
$function$;

ALTER FUNCTION public.stripe_subscription_has_exact_trial_binding_v2(uuid)
  OWNER TO postgres;

-- Every authorization caller must consume exact ledger authority.  The old
-- projection helper trusted an active subscriptions/profile row directly.
CREATE OR REPLACE FUNCTION public.has_current_global_pro_entitlement(
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT public.stripe_has_current_pro_authority_v2(p_actor_id)
$function$;

ALTER FUNCTION public.has_current_global_pro_entitlement(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.has_current_global_pro_entitlement(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- Remove every pre-cutover Stripe-derived authority.  Its source event is now
-- durably classified as test mode, while non-Stripe/referral grants remain
-- eligible.  Active projections are recomputed below.
CREATE TEMP TABLE stripe_livemode_quarantine_users (
  user_id uuid PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO stripe_livemode_quarantine_users (user_id)
SELECT payment.user_id
FROM public.stripe_entitlement_payments AS payment
WHERE NOT payment.livemode
  AND payment.user_id IS NOT NULL
UNION
SELECT trial.user_id
FROM public.stripe_trial_entitlements AS trial
WHERE NOT trial.livemode
UNION
SELECT entitlement_grant.user_id
FROM public.pro_entitlement_grants AS entitlement_grant
WHERE entitlement_grant.source IN (
  'stripe_lifetime_payment',
  'stripe_payment_retry_grace'
)
UNION
SELECT subscription.user_id
FROM public.subscriptions AS subscription
WHERE subscription.tier = 'pro'
  AND subscription.status IN ('active', 'trialing')
ON CONFLICT (user_id) DO NOTHING;

UPDATE public.stripe_trial_entitlements
SET revoked_at = COALESCE(
      revoked_at,
      pg_catalog.clock_timestamp()
    ),
    revoke_reason = COALESCE(
      revoke_reason,
      'pre_livemode_test_cutover'
    ),
    updated_at = pg_catalog.clock_timestamp()
WHERE NOT livemode
  AND revoked_at IS NULL;

UPDATE public.pro_entitlement_grants
SET revoked_at = COALESCE(
      revoked_at,
      pg_catalog.clock_timestamp()
    ),
    metadata = metadata || pg_catalog.jsonb_build_object(
      'livemode_cutover',
      'preexisting_test_authority_revoked',
      'livemode_cutover_migration',
      '20260729065000'
    ),
    updated_at = pg_catalog.clock_timestamp()
WHERE source IN (
    'stripe_lifetime_payment',
    'stripe_payment_retry_grace'
  )
  AND revoked_at IS NULL;

UPDATE public.subscriptions AS subscription
SET status = 'canceled',
    cancel_at_period_end = false,
    canceled_at = COALESCE(
      subscription.canceled_at,
      pg_catalog.clock_timestamp()
    ),
    entitlement_trial_verified_at = NULL,
    updated_at = pg_catalog.clock_timestamp()
WHERE subscription.tier = 'pro'
  AND subscription.status IN ('active', 'trialing')
  AND NOT public.stripe_subscription_has_exact_payment_binding_v2(
    subscription.user_id
  )
  AND NOT public.stripe_subscription_has_exact_trial_binding_v2(
    subscription.user_id
  );

UPDATE public.group_subscriptions AS group_subscription
SET status = 'cancelled',
    cancel_at_period_end = false,
    cancelled_at = COALESCE(
      group_subscription.cancelled_at,
      pg_catalog.clock_timestamp()
    ),
    updated_at = pg_catalog.clock_timestamp()
WHERE group_subscription.status IN ('active', 'trialing')
  AND EXISTS (
    SELECT 1
    FROM public.group_payment_consumptions AS consumption
    WHERE consumption.subscription_id = group_subscription.id
      AND NOT consumption.livemode
      AND consumption.outcome IN ('activated', 'renewed')
  );

DO $reconcile_pre_livemode_authority$
DECLARE
  v_user_id uuid;
  v_has_authority boolean;
  v_leave_ack jsonb;
BEGIN
  PERFORM pg_catalog.set_config(
    'request.jwt.claim.role',
    'service_role',
    true
  );

  FOR v_user_id IN
    SELECT quarantine.user_id
    FROM stripe_livemode_quarantine_users AS quarantine
    JOIN public.user_profiles AS profile
      ON profile.id = quarantine.user_id
     AND profile.deleted_at IS NULL
    ORDER BY quarantine.user_id
  LOOP
    v_has_authority :=
      public.stripe_has_current_pro_authority_v2(v_user_id);
    IF v_has_authority THEN
      PERFORM public.sync_current_pro_projection_atomic(v_user_id);
    ELSE
      UPDATE public.user_profiles
      SET subscription_tier = 'free',
          pro_plan = NULL,
          pro_expires_at = NULL,
          is_pro = false,
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = v_user_id
        AND deleted_at IS NULL;

      v_leave_ack := public.leave_pro_official_group_atomic(v_user_id);
      IF COALESCE(v_leave_ack ->> 'status', '')
        NOT IN ('left', 'not_member')
      THEN
        RAISE EXCEPTION
          'atomic official-group leave returned invalid status';
      END IF;
    END IF;
  END LOOP;
END
$reconcile_pre_livemode_authority$;

CREATE OR REPLACE FUNCTION public.guard_stripe_derived_pro_grant_livemode()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- Revocation and already-revoked audit updates never create authority.
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
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Stripe-derived Pro grant lacks live-mode authority'
    USING ERRCODE = '23514';
END
$function$;

ALTER FUNCTION public.guard_stripe_derived_pro_grant_livemode()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_stripe_derived_pro_grant_livemode()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TRIGGER trg_pro_entitlement_grants_livemode
  BEFORE INSERT OR UPDATE ON public.pro_entitlement_grants
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_stripe_derived_pro_grant_livemode();

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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL THEN
    RAISE EXCEPTION 'Stripe livemode is required' USING ERRCODE = '22023';
  END IF;
  IF NOT p_livemode THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'test_mode_non_entitling'
    );
  END IF;

  IF EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      WHERE (
          payment.stripe_invoice_id = p_stripe_invoice_id
          OR payment.stripe_charge_id = p_stripe_charge_id
          OR (
            p_stripe_payment_intent_id IS NOT NULL
            AND payment.stripe_payment_intent_id =
              p_stripe_payment_intent_id
          )
        )
        AND payment.livemode IS DISTINCT FROM p_livemode
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstones AS tombstone
      WHERE tombstone.stripe_charge_id = p_stripe_charge_id
        AND tombstone.livemode IS DISTINCT FROM p_livemode
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.stripe_livemode',
    p_livemode::text,
    true
  );
  v_result := public.activate_recurring_entitlement_payment_atomic(
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
    p_stripe_subscription_status
  );
  RETURN v_result;
END
$function$;

ALTER FUNCTION public.activate_recurring_entitlement_payment_atomic(
  uuid, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, text, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.activate_recurring_trial_entitlement_atomic(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_plan text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_stripe_subscription_status text,
  p_livemode boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL THEN
    RAISE EXCEPTION 'Stripe livemode is required' USING ERRCODE = '22023';
  END IF;
  IF NOT p_livemode THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'test_mode_non_entitling'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_trial_entitlements AS trial
    WHERE trial.stripe_subscription_id = p_stripe_subscription_id
      AND trial.period_start = p_period_start
      AND trial.period_end = p_period_end
      AND trial.livemode IS DISTINCT FROM p_livemode
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.stripe_livemode',
    p_livemode::text,
    true
  );
  RETURN public.activate_recurring_trial_entitlement_atomic(
    p_user_id,
    p_stripe_customer_id,
    p_stripe_subscription_id,
    p_plan,
    p_period_start,
    p_period_end,
    p_stripe_subscription_status
  );
END
$function$;

ALTER FUNCTION public.activate_recurring_trial_entitlement_atomic(
  uuid, text, text, text, timestamptz, timestamptz, text, boolean
) OWNER TO postgres;

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
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL THEN
    RAISE EXCEPTION 'Stripe livemode is required' USING ERRCODE = '22023';
  END IF;
  IF NOT p_livemode THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'test_mode_non_entitling'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_subscription_state_events AS state_event
    WHERE state_event.event_id = p_event_id
      AND state_event.livemode IS DISTINCT FROM p_livemode
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.stripe_livemode',
    p_livemode::text,
    true
  );
  RETURN public.reconcile_recurring_subscription_state_atomic(
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
    p_event_created_at
  );
END
$function$;

ALTER FUNCTION public.reconcile_recurring_subscription_state_atomic(
  uuid, text, text, text, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION
  public.activate_lifetime_membership_with_identity_atomic(
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
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL THEN
    RAISE EXCEPTION 'Stripe livemode is required' USING ERRCODE = '22023';
  END IF;
  IF NOT p_livemode THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'test_mode_non_entitling'
    );
  END IF;

  IF EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      WHERE (
          payment.stripe_payment_intent_id =
            p_stripe_payment_intent_id
          OR payment.stripe_charge_id = p_stripe_charge_id
          OR payment.checkout_session_id = p_checkout_session_id
        )
        AND payment.livemode IS DISTINCT FROM p_livemode
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstones AS tombstone
      WHERE tombstone.stripe_charge_id = p_stripe_charge_id
        AND tombstone.livemode IS DISTINCT FROM p_livemode
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.stripe_livemode',
    p_livemode::text,
    true
  );
  v_result :=
    public.activate_lifetime_membership_with_identity_atomic(
      p_user_id,
      p_stripe_customer_id,
      p_checkout_session_id,
      p_reservation_id,
      p_stripe_payment_intent_id,
      p_stripe_charge_id,
      p_amount_paid,
      p_currency,
      p_paid_at,
      p_payment_status
    );
  RETURN v_result;
END
$function$;

ALTER FUNCTION
  public.activate_lifetime_membership_with_identity_atomic(
    uuid, text, text, uuid, text, text, bigint, text, timestamptz,
    text, boolean
  )
OWNER TO postgres;

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
    p_livemode boolean
  )
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL THEN
    RAISE EXCEPTION 'Stripe livemode is required' USING ERRCODE = '22023';
  END IF;
  IF NOT p_livemode THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'test_mode_non_entitling'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.group_payment_consumptions AS consumption
    WHERE (
        consumption.payment_intent_id = p_payment_intent_id
        OR consumption.stripe_charge_id = p_stripe_charge_id
        OR consumption.checkout_session_id = p_checkout_session_id
      )
      AND consumption.livemode IS DISTINCT FROM p_livemode
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.stripe_livemode',
    p_livemode::text,
    true
  );
  RETURN public.activate_group_subscription_with_stripe_ownership_atomic(
    p_actor_id,
    p_group_id,
    p_tier,
    p_payment_intent_id,
    p_checkout_session_id,
    p_amount_cents,
    p_currency,
    p_stripe_charge_id,
    p_stripe_customer_id
  );
END
$function$;

ALTER FUNCTION
  public.activate_group_subscription_with_stripe_ownership_atomic(
    uuid, uuid, text, text, text, bigint, text, text, text, boolean
  )
OWNER TO postgres;

-- Only the overloads carrying authenticated Stripe mode remain remotely
-- callable.  The legacy signatures are retained as owner-private
-- implementations so rolling SQL deployment stays atomic.
REVOKE ALL ON FUNCTION public.activate_recurring_entitlement_payment_atomic(
  uuid, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.activate_recurring_trial_entitlement_atomic(
  uuid, text, text, text, timestamptz, timestamptz, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.reconcile_recurring_subscription_state_atomic(
  uuid, text, text, text, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION
  public.activate_lifetime_membership_with_identity_atomic(
    uuid, text, text, uuid, text, text, bigint, text, timestamptz, text
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION
  public.activate_group_subscription_with_stripe_ownership_atomic(
    uuid, uuid, text, text, text, bigint, text, text, text
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

GRANT EXECUTE ON FUNCTION public.activate_recurring_entitlement_payment_atomic(
  uuid, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_recurring_trial_entitlement_atomic(
  uuid, text, text, text, timestamptz, timestamptz, text, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_recurring_subscription_state_atomic(
  uuid, text, text, text, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION
  public.activate_lifetime_membership_with_identity_atomic(
    uuid, text, text, uuid, text, text, bigint, text, timestamptz,
    text, boolean
  )
TO service_role;
GRANT EXECUTE ON FUNCTION
  public.activate_group_subscription_with_stripe_ownership_atomic(
    uuid, uuid, text, text, text, bigint, text, text, text, boolean
  )
TO service_role;

ALTER FUNCTION
  public.record_charge_refund_tombstone_with_mode_atomic(
    boolean, uuid, text, text, text, boolean, bigint, text, bigint,
    text, text, timestamptz
  )
RENAME TO record_charge_refund_tombstone_pre_entitlement_livemode_v2;
REVOKE ALL ON FUNCTION
  public.record_charge_refund_tombstone_pre_entitlement_livemode_v2(
    boolean, uuid, text, text, text, boolean, bigint, text, bigint,
    text, text, timestamptz
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.record_charge_refund_tombstone_with_mode_atomic(
    p_livemode boolean,
    p_user_id uuid,
    p_stripe_customer_id text,
    p_stripe_payment_intent_id text,
    p_stripe_charge_id text,
    p_captured boolean,
    p_amount_paid bigint,
    p_currency text,
    p_refund_succeeded_amount bigint,
    p_refund_state text,
    p_refund_event_id text,
    p_refund_event_created_at timestamptz
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
  IF p_livemode IS NULL THEN
    RAISE EXCEPTION 'Stripe livemode is required' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
      SELECT 1
      FROM public.stripe_payment_ownerships AS ownership
      WHERE (
          ownership.stripe_charge_id = p_stripe_charge_id
          OR (
            p_stripe_payment_intent_id IS NOT NULL
            AND ownership.stripe_payment_intent_id =
              p_stripe_payment_intent_id
          )
        )
        AND ownership.livemode IS DISTINCT FROM p_livemode
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      WHERE (
          payment.stripe_charge_id = p_stripe_charge_id
          OR (
            p_stripe_payment_intent_id IS NOT NULL
            AND payment.stripe_payment_intent_id =
              p_stripe_payment_intent_id
          )
        )
        AND payment.livemode IS DISTINCT FROM p_livemode
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstones AS tombstone
      WHERE tombstone.stripe_charge_id = p_stripe_charge_id
        AND tombstone.livemode IS DISTINCT FROM p_livemode
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      p_stripe_charge_id,
      p_user_id,
      'stripe_refund_livemode_ownership_conflict',
      'A refund observation did not match the immutable payment mode.',
      pg_catalog.jsonb_build_object(
        'event_id', p_refund_event_id,
        'livemode', p_livemode,
        'payment_intent_id', p_stripe_payment_intent_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.stripe_livemode',
    p_livemode::text,
    true
  );
  v_result :=
    public.record_charge_refund_tombstone_pre_entitlement_livemode_v2(
      p_livemode,
      p_user_id,
      p_stripe_customer_id,
      p_stripe_payment_intent_id,
      p_stripe_charge_id,
      p_captured,
      p_amount_paid,
      p_currency,
      p_refund_succeeded_amount,
      p_refund_state,
      p_refund_event_id,
      p_refund_event_created_at
    );

  IF v_result ? 'ownership_id'
    AND NOT EXISTS (
      SELECT 1
      FROM public.stripe_payment_ownerships AS ownership
      WHERE ownership.id::text = v_result ->> 'ownership_id'
        AND ownership.livemode = p_livemode
    )
  THEN
    RAISE EXCEPTION 'refund ownership Stripe mode mismatch'
      USING ERRCODE = '23514';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.stripe_charge_refund_tombstones AS tombstone
    WHERE tombstone.stripe_charge_id = p_stripe_charge_id
      AND tombstone.livemode IS DISTINCT FROM p_livemode
  ) THEN
    RAISE EXCEPTION 'refund tombstone Stripe mode mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN v_result;
END
$function$;

ALTER FUNCTION
  public.record_charge_refund_tombstone_with_mode_atomic(
    boolean, uuid, text, text, text, boolean, bigint, text, bigint,
    text, text, timestamptz
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.record_charge_refund_tombstone_with_mode_atomic(
    boolean, uuid, text, text, text, boolean, bigint, text, bigint,
    text, text, timestamptz
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.record_charge_refund_tombstone_with_mode_atomic(
    boolean, uuid, text, text, text, boolean, bigint, text, bigint,
    text, text, timestamptz
  )
TO service_role;

ALTER FUNCTION public.stripe_paid_launch_readiness_v2()
  RENAME TO stripe_paid_launch_readiness_pre_livemode_v2;
REVOKE ALL ON FUNCTION
  public.stripe_paid_launch_readiness_pre_livemode_v2()
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
  v_test_payments integer;
  v_test_trials integer;
  v_non_live_current_pro_authorities integer;
  v_non_live_current_group_passes integer;
  v_payment_mode_anomalies integer;
  v_refund_mode_anomalies integer;
  v_group_mode_anomalies integer;
  v_authority_drift integer;
  v_ready boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  v_base := public.stripe_paid_launch_readiness_pre_livemode_v2();

  SELECT pg_catalog.count(*)::integer
  INTO v_test_payments
  FROM public.stripe_entitlement_payments AS payment
  WHERE NOT payment.livemode;

  SELECT pg_catalog.count(*)::integer
  INTO v_test_trials
  FROM public.stripe_trial_entitlements AS trial
  WHERE NOT trial.livemode;

  SELECT pg_catalog.count(*)::integer
  INTO v_non_live_current_pro_authorities
  FROM public.subscriptions AS subscription
  WHERE subscription.tier = 'pro'
    AND subscription.status IN ('active', 'trialing')
    AND (
      (
        subscription.entitlement_payment_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.stripe_entitlement_payments AS payment
          WHERE payment.id = subscription.entitlement_payment_id
            AND NOT payment.livemode
        )
      )
      OR (
        subscription.entitlement_trial_id IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM public.stripe_trial_entitlements AS trial
          WHERE trial.id = subscription.entitlement_trial_id
            AND NOT trial.livemode
        )
      )
    );

  SELECT pg_catalog.count(*)::integer
  INTO v_non_live_current_group_passes
  FROM public.group_subscriptions AS group_subscription
  WHERE group_subscription.status IN ('active', 'trialing')
    AND EXISTS (
      SELECT 1
      FROM public.group_payment_consumptions AS consumption
      WHERE consumption.subscription_id = group_subscription.id
        AND NOT consumption.livemode
        AND consumption.outcome IN ('activated', 'renewed')
    );

  SELECT pg_catalog.count(*)::integer
  INTO v_payment_mode_anomalies
  FROM public.stripe_payment_ownerships AS ownership
  WHERE CASE ownership.product_kind
    WHEN 'pro_entitlement' THEN NOT EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      WHERE payment.id = ownership.ledger_id
        AND payment.livemode = ownership.livemode
    )
    WHEN 'group_pass' THEN NOT EXISTS (
      SELECT 1
      FROM public.group_payment_consumptions AS consumption
      WHERE consumption.id = ownership.ledger_id
        AND consumption.livemode = ownership.livemode
    )
    WHEN 'api_tier' THEN NOT EXISTS (
      SELECT 1
      FROM public.stripe_api_tier_payments AS payment
      WHERE payment.id = ownership.ledger_id
        AND payment.livemode = ownership.livemode
    )
    WHEN 'tip' THEN false
    ELSE true
  END;

  SELECT (
    (
      SELECT pg_catalog.count(*)
      FROM public.stripe_charge_refund_tombstones AS tombstone
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.id = tombstone.resolution_ownership_id
      WHERE tombstone.livemode IS DISTINCT FROM ownership.livemode
    )
    + (
      SELECT pg_catalog.count(*)
      FROM public.stripe_charge_refund_tombstone_events AS refund_event
      JOIN public.stripe_charge_refund_tombstones AS tombstone
        ON tombstone.stripe_charge_id = refund_event.stripe_charge_id
      WHERE refund_event.livemode IS DISTINCT FROM tombstone.livemode
    )
    + (
      SELECT pg_catalog.count(*)
      FROM public.stripe_entitlement_refund_events AS refund_event
      JOIN public.stripe_entitlement_payments AS payment
        ON payment.id = refund_event.entitlement_payment_id
      WHERE refund_event.livemode IS DISTINCT FROM payment.livemode
    )
    + (
      SELECT pg_catalog.count(*)
      FROM public.stripe_charge_refund_observation_modes AS observation
      JOIN public.stripe_charge_refund_tombstones AS tombstone
        ON tombstone.stripe_charge_id = observation.stripe_charge_id
      WHERE observation.livemode IS DISTINCT FROM tombstone.livemode
    )
  )::integer
  INTO v_refund_mode_anomalies;

  SELECT pg_catalog.count(*)::integer
  INTO v_group_mode_anomalies
  FROM public.group_payment_consumptions AS consumption
  JOIN public.stripe_payment_ownerships AS ownership
    ON ownership.product_kind = 'group_pass'
   AND ownership.ledger_id = consumption.id
  WHERE ownership.livemode IS DISTINCT FROM consumption.livemode;

  v_authority_drift :=
    COALESCE((v_base ->> 'authority_drift')::integer, -1)
      + v_non_live_current_pro_authorities
      + v_non_live_current_group_passes
      + v_payment_mode_anomalies
      + v_refund_mode_anomalies
      + v_group_mode_anomalies;

  v_ready :=
    COALESCE(v_base ->> 'status', '') = 'ready'
    AND v_non_live_current_pro_authorities = 0
    AND v_non_live_current_group_passes = 0
    AND v_payment_mode_anomalies = 0
    AND v_refund_mode_anomalies = 0
    AND v_group_mode_anomalies = 0;

  RETURN v_base || pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_ready THEN 'ready' ELSE 'blocked' END,
    'authority_drift', v_authority_drift,
    'test_mode_entitlement_payments', v_test_payments,
    'test_mode_trial_entitlements', v_test_trials,
    'non_live_current_pro_authorities',
      v_non_live_current_pro_authorities,
    'non_live_current_group_passes',
      v_non_live_current_group_passes,
    'stripe_payment_mode_anomalies', v_payment_mode_anomalies,
    'refund_mode_anomalies', v_refund_mode_anomalies,
    'group_payment_mode_anomalies', v_group_mode_anomalies
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
  v_table text;
  v_column_attnum smallint;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'public.stripe_entitlement_payments',
    'public.stripe_trial_entitlements',
    'public.stripe_subscription_state_events',
    'public.stripe_entitlement_refund_events',
    'public.stripe_charge_refund_tombstones',
    'public.stripe_charge_refund_tombstone_events',
    'public.stripe_payment_ownerships',
    'public.group_payment_consumptions'
  ]
  LOOP
    SELECT attribute.attnum
    INTO v_column_attnum
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = pg_catalog.to_regclass(v_table)
      AND attribute.attname = 'livemode'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attnotnull;
    IF v_column_attnum IS NULL THEN
      RAISE EXCEPTION 'Stripe livemode column is not sealed: %', v_table;
    END IF;
  END LOOP;

  IF pg_catalog.has_function_privilege(
      'service_role',
      'public.activate_recurring_entitlement_payment_atomic(uuid,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.activate_recurring_trial_entitlement_atomic(uuid,text,text,text,timestamp with time zone,timestamp with time zone,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.reconcile_recurring_subscription_state_atomic(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.activate_lifetime_membership_with_identity_atomic(uuid,text,text,uuid,text,text,bigint,text,timestamp with time zone,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.activate_group_subscription_with_stripe_ownership_atomic(uuid,uuid,text,text,text,bigint,text,text,text)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'legacy Stripe entitlement writer remains executable';
  END IF;
END
$postflight$;

COMMIT;
