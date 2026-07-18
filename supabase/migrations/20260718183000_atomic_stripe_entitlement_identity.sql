-- Stripe entitlement authority is payment-period scoped.
--
-- A subscriptions row is only the current projection. Paid authority lives in
-- stripe_entitlement_payments and subscriptions.entitlement_payment_id binds
-- the exact invoice/Checkout payment that currently owns that projection.
-- Non-Stripe authority lives in pro_entitlement_grants with a stable source
-- key and explicit expiry. user_profiles flags are projections, never sources.
--
-- Refund events are append-only. The payment row separately stores the latest
-- authoritative aggregate so an old invoice on the same Stripe subscription
-- cannot revoke a newer paid period, a refund received before activation leaves
-- a durable tombstone, and a later failed refund can restore only the exact
-- current recurring payment after Stripe confirms the subscription is active.

BEGIN;

DO $preflight$
DECLARE
  v_has_ambiguous_referral_marker boolean := false;
  v_subscription_user_index pg_catalog.regclass;
BEGIN
  IF to_regclass('public.subscriptions') IS NULL
    OR to_regclass('public.user_profiles') IS NULL
    OR to_regclass('public.payment_history') IS NULL
  THEN
    RAISE EXCEPTION 'Stripe entitlement authority prerequisites are missing';
  END IF;
  IF to_regprocedure('public.leave_pro_official_group_atomic(uuid)') IS NULL THEN
    RAISE EXCEPTION 'atomic Pro official-group leave prerequisite is missing';
  END IF;
  v_subscription_user_index :=
    to_regclass('public.idx_subscriptions_user_id');
  IF v_subscription_user_index IS NULL THEN
    RAISE EXCEPTION
      'subscriptions.user_id exact conflict-target contract is missing';
  END IF;
  IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_row
      WHERE index_row.indexrelid = v_subscription_user_index
        AND (
          NOT index_row.indisunique
          OR NOT index_row.indisvalid
          OR NOT index_row.indisready
          OR index_row.indpred IS NOT NULL
          OR index_row.indexprs IS NOT NULL
          OR index_row.indnkeyatts <> 1
          OR index_row.indkey[0] <> (
            SELECT attribute.attnum
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid =
                'public.subscriptions'::pg_catalog.regclass
              AND attribute.attname = 'user_id'
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
          )
        )
    ) OR EXISTS (
      SELECT subscription.user_id
      FROM public.subscriptions AS subscription
      GROUP BY subscription.user_id
      HAVING pg_catalog.count(*) > 1
    )
  THEN
    RAISE EXCEPTION
      'subscriptions.user_id exact conflict-target contract is missing';
  END IF;
  IF EXISTS (
    SELECT subscription.stripe_subscription_id
    FROM public.subscriptions AS subscription
    WHERE subscription.stripe_subscription_id IS NOT NULL
    GROUP BY subscription.stripe_subscription_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate Stripe subscription projection identity';
  END IF;
  IF EXISTS (
    SELECT profile.stripe_customer_id
    FROM public.user_profiles AS profile
    WHERE profile.stripe_customer_id IS NOT NULL
    GROUP BY profile.stripe_customer_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate Stripe customer profile identity';
  END IF;

  -- grantProDays historically extended an existing subscriptions row without
  -- recording how many days belonged to the referral. Those rows cannot be
  -- reconstructed safely. Production was verified at zero before launch; any
  -- non-zero environment must be repaired with an explicit absolute expiry.
  IF to_regclass('public.referral_rewards') IS NOT NULL THEN
    EXECUTE
      'SELECT EXISTS (SELECT 1 FROM public.referral_rewards)'
      INTO v_has_ambiguous_referral_marker;
  END IF;
  IF NOT v_has_ambiguous_referral_marker
    AND to_regclass('public.referral_attributions') IS NOT NULL
  THEN
    EXECUTE
      'SELECT EXISTS (
         SELECT 1
         FROM public.referral_attributions
         WHERE friend_granted
       )'
      INTO v_has_ambiguous_referral_marker;
  END IF;
  IF v_has_ambiguous_referral_marker THEN
    RAISE EXCEPTION
      'legacy referral rewards require an explicit grant-expiry backfill';
  END IF;
END
$preflight$;

-- PostgREST emits ON CONFLICT(column) for the payment_history webhook upserts.
-- PostgreSQL cannot infer a plain column target from the historical partial
-- indexes and raises 42P10. Add separate regular UNIQUE indexes so predeploy is
-- strictly additive; regular unique indexes still permit multiple NULL values.
CREATE UNIQUE INDEX uq_payment_history_invoice_conflict_target
  ON public.payment_history (stripe_invoice_id);

CREATE UNIQUE INDEX uq_payment_history_pi_conflict_target
  ON public.payment_history (stripe_payment_intent_id);

CREATE UNIQUE INDEX uq_subscriptions_stripe_subscription_identity
  ON public.subscriptions (stripe_subscription_id);

CREATE UNIQUE INDEX uq_user_profiles_stripe_customer_identity
  ON public.user_profiles (stripe_customer_id);

CREATE TABLE public.stripe_entitlement_payments (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid
    REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  stripe_customer_id text NOT NULL,
  payment_kind text NOT NULL,
  plan text NOT NULL,
  stripe_subscription_id text,
  stripe_invoice_id text,
  stripe_payment_intent_id text,
  stripe_charge_id text NOT NULL,
  checkout_session_id text,
  amount_paid bigint NOT NULL,
  currency text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz,
  payment_status text NOT NULL,
  refund_succeeded_amount bigint NOT NULL DEFAULT 0,
  refund_state text NOT NULL DEFAULT 'none',
  latest_refund_event_id text,
  latest_refund_event_created_at timestamptz,
  refund_snapshot_event_id text,
  refund_snapshot_event_created_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_entitlement_payments_kind_check
    CHECK (payment_kind IN ('recurring', 'lifetime')),
  CONSTRAINT stripe_entitlement_payments_plan_check
    CHECK (
      (payment_kind = 'recurring' AND plan IN ('monthly', 'yearly'))
      OR (payment_kind = 'lifetime' AND plan = 'lifetime')
    ),
  CONSTRAINT stripe_entitlement_payments_shape_check
    CHECK (
      (
        payment_kind = 'recurring'
        AND stripe_subscription_id IS NOT NULL
        AND stripe_invoice_id IS NOT NULL
        AND checkout_session_id IS NULL
        AND period_end IS NOT NULL
        AND period_end > period_start
      )
      OR (
        payment_kind = 'lifetime'
        AND stripe_subscription_id IS NULL
        AND stripe_invoice_id IS NULL
        AND stripe_payment_intent_id IS NOT NULL
        AND checkout_session_id IS NOT NULL
        AND period_end IS NULL
      )
    ),
  CONSTRAINT stripe_entitlement_payments_amount_check
    CHECK (
      amount_paid > 0
      AND refund_succeeded_amount >= 0
      AND refund_succeeded_amount <= amount_paid
    ),
  CONSTRAINT stripe_entitlement_payments_currency_check
    CHECK (currency ~ '^[a-z]{3}$'),
  CONSTRAINT stripe_entitlement_payments_status_check
    CHECK (payment_status IN ('paid', 'succeeded')),
  CONSTRAINT stripe_entitlement_payments_refund_state_check
    CHECK (
      refund_state IN (
        'none',
        'pending',
        'requires_action',
        'succeeded',
        'failed',
        'canceled'
      )
    ),
  CONSTRAINT stripe_entitlement_payments_refund_event_check
    CHECK (
      (latest_refund_event_id IS NULL)
        = (latest_refund_event_created_at IS NULL)
    ),
  CONSTRAINT stripe_entitlement_payments_refund_snapshot_check
    CHECK (
      (refund_snapshot_event_id IS NULL)
        = (refund_snapshot_event_created_at IS NULL)
    ),
  CONSTRAINT stripe_entitlement_payments_pi_key
    UNIQUE (stripe_payment_intent_id),
  CONSTRAINT stripe_entitlement_payments_charge_key
    UNIQUE (stripe_charge_id)
);

CREATE UNIQUE INDEX stripe_entitlement_payments_invoice_key
  ON public.stripe_entitlement_payments (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX stripe_entitlement_payments_session_key
  ON public.stripe_entitlement_payments (checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;
CREATE INDEX stripe_entitlement_payments_user_period_idx
  ON public.stripe_entitlement_payments (user_id, period_start DESC, id);

-- Modern Stripe API versions can emit a refunded direct Charge with no
-- PaymentIntent and no reverse Charge.invoice link. Preserve its exact
-- financial aggregate without inventing subscription/period identity. A later
-- invoice activation merges this tombstone by the immutable Charge id.
CREATE TABLE public.stripe_charge_refund_tombstones (
  stripe_charge_id text PRIMARY KEY,
  stripe_customer_id text NOT NULL,
  stripe_payment_intent_id text,
  captured boolean NOT NULL,
  amount_paid bigint NOT NULL,
  currency text NOT NULL,
  refund_succeeded_amount bigint NOT NULL,
  refund_state text NOT NULL,
  latest_refund_event_id text NOT NULL,
  latest_refund_event_created_at timestamptz NOT NULL,
  refund_snapshot_event_id text NOT NULL,
  refund_snapshot_event_created_at timestamptz NOT NULL,
  merged_payment_id uuid
    REFERENCES public.stripe_entitlement_payments(id) ON DELETE RESTRICT,
  resolution_kind text NOT NULL DEFAULT 'unclassified',
  resolution_reference text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_charge_refund_tombstones_charge_check
    CHECK (pg_catalog.left(stripe_charge_id, 3) = 'ch_'),
  CONSTRAINT stripe_charge_refund_tombstones_customer_check
    CHECK (pg_catalog.left(stripe_customer_id, 4) = 'cus_'),
  CONSTRAINT stripe_charge_refund_tombstones_pi_check
    CHECK (
      stripe_payment_intent_id IS NULL
      OR pg_catalog.left(stripe_payment_intent_id, 3) = 'pi_'
    ),
  CONSTRAINT stripe_charge_refund_tombstones_amount_check
    CHECK (
      amount_paid > 0
      AND refund_succeeded_amount >= 0
      AND refund_succeeded_amount <= amount_paid
    ),
  CONSTRAINT stripe_charge_refund_tombstones_currency_check
    CHECK (currency ~ '^[a-z]{3}$'),
  CONSTRAINT stripe_charge_refund_tombstones_state_check
    CHECK (
      refund_state IN (
        'pending',
        'requires_action',
        'succeeded',
        'failed',
        'canceled'
      )
    ),
  CONSTRAINT stripe_charge_refund_tombstones_event_check
    CHECK (
      pg_catalog.left(latest_refund_event_id, 4) = 'evt_'
      AND pg_catalog.left(refund_snapshot_event_id, 4) = 'evt_'
    ),
  CONSTRAINT stripe_charge_refund_tombstones_resolution_check
    CHECK (
      (
        resolution_kind = 'unclassified'
        AND merged_payment_id IS NULL
        AND resolution_reference IS NULL
      )
      OR (
        resolution_kind = 'entitlement_payment'
        AND merged_payment_id IS NOT NULL
        AND resolution_reference =
          'payment:' || merged_payment_id::text
      )
    )
);
CREATE UNIQUE INDEX stripe_charge_refund_tombstones_payment_key
  ON public.stripe_charge_refund_tombstones (merged_payment_id)
  WHERE merged_payment_id IS NOT NULL;

CREATE TABLE public.stripe_charge_refund_tombstone_events (
  event_id text PRIMARY KEY,
  stripe_charge_id text NOT NULL
    REFERENCES public.stripe_charge_refund_tombstones(stripe_charge_id)
    ON DELETE RESTRICT,
  refund_state text NOT NULL,
  refund_succeeded_amount bigint NOT NULL,
  event_created_at timestamptz NOT NULL,
  observations jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_charge_refund_tombstone_events_id_check
    CHECK (pg_catalog.left(event_id, 4) = 'evt_'),
  CONSTRAINT stripe_charge_refund_tombstone_events_state_check
    CHECK (
      refund_state IN (
        'pending',
        'requires_action',
        'succeeded',
        'failed',
        'canceled'
      )
    ),
  CONSTRAINT stripe_charge_refund_tombstone_events_amount_check
    CHECK (refund_succeeded_amount >= 0),
  CONSTRAINT stripe_charge_refund_tombstone_events_observations_check
    CHECK (pg_catalog.jsonb_typeof(observations) = 'array')
);

CREATE TABLE public.stripe_lifetime_seat_reservations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  -- This immutable identity intentionally has no profile FK. A bound Stripe
  -- Checkout Session remains payable after account deletion and must continue
  -- consuming capacity until Stripe proves it expired or its payment converts.
  user_id uuid NOT NULL,
  request_nonce text NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  checkout_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  checkout_session_id text,
  converted_payment_id uuid
    REFERENCES public.stripe_entitlement_payments(id) ON DELETE RESTRICT,
  release_reason text,
  release_event_id text,
  release_event_created_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  released_at timestamptz,
  CONSTRAINT stripe_lifetime_seat_reservations_nonce_check
    CHECK (
      pg_catalog.length(pg_catalog.btrim(request_nonce)) BETWEEN 8 AND 128
      AND request_nonce ~ '^[A-Za-z0-9_.:-]+$'
    ),
  CONSTRAINT stripe_lifetime_seat_reservations_status_check
    CHECK (
      status IN ('reserved', 'bound', 'converted', 'released', 'expired')
    ),
  CONSTRAINT stripe_lifetime_seat_reservations_expiry_check
    CHECK (
      expires_at = checkout_expires_at
        + pg_catalog.make_interval(mins => 15)
    ),
  CONSTRAINT stripe_lifetime_seat_reservations_session_check
    CHECK (
      checkout_session_id IS NULL
      OR pg_catalog.left(checkout_session_id, 3) = 'cs_'
    ),
  CONSTRAINT stripe_lifetime_seat_reservations_release_reason_check
    CHECK (
      release_reason IS NULL
      OR (
        pg_catalog.length(pg_catalog.btrim(release_reason))
          BETWEEN 1 AND 255
        AND release_reason ~ '^[a-z0-9_:-]+$'
      )
    ),
  CONSTRAINT stripe_lifetime_seat_reservations_shape_check
    CHECK (
      (
        status = 'reserved'
        AND checkout_session_id IS NULL
        AND converted_payment_id IS NULL
        AND released_at IS NULL
        AND release_reason IS NULL
        AND release_event_id IS NULL
        AND release_event_created_at IS NULL
      )
      OR (
        status = 'bound'
        AND checkout_session_id IS NOT NULL
        AND converted_payment_id IS NULL
        AND released_at IS NULL
        AND release_reason IS NULL
        AND release_event_id IS NULL
        AND release_event_created_at IS NULL
      )
      OR (
        status = 'converted'
        AND checkout_session_id IS NOT NULL
        AND converted_payment_id IS NOT NULL
        AND released_at IS NULL
        AND release_reason IS NULL
        AND release_event_id IS NULL
        AND release_event_created_at IS NULL
      )
      OR (
        status = 'expired'
        AND checkout_session_id IS NULL
        AND converted_payment_id IS NULL
        AND released_at IS NOT NULL
        AND release_reason = 'lease_expired'
        AND release_event_id IS NULL
        AND release_event_created_at IS NULL
      )
      OR (
        status = 'released'
        AND converted_payment_id IS NULL
        AND released_at IS NOT NULL
        AND release_reason IS NOT NULL
        AND (
          (
            release_reason IN (
              'stripe_checkout_create_failed',
              'stripe_checkout_abandoned'
            )
            AND checkout_session_id IS NULL
            AND release_event_id IS NULL
            AND release_event_created_at IS NULL
          )
          OR (
            release_reason = 'stripe_checkout_session_expired'
            AND checkout_session_id IS NOT NULL
            AND pg_catalog.left(release_event_id, 4) = 'evt_'
            AND release_event_created_at IS NOT NULL
          )
          OR (
            release_reason IN (
              'payment_refunded_before_activation',
              'payment_fully_refunded'
            )
            AND checkout_session_id IS NOT NULL
            AND release_event_id IS NULL
            AND release_event_created_at IS NULL
          )
        )
      )
    ),
  CONSTRAINT stripe_lifetime_seat_reservations_user_nonce_key
    UNIQUE (user_id, request_nonce)
);
CREATE UNIQUE INDEX stripe_lifetime_seat_reservations_active_user_key
  ON public.stripe_lifetime_seat_reservations (user_id)
  WHERE status IN ('reserved', 'bound');
CREATE UNIQUE INDEX stripe_lifetime_seat_reservations_session_key
  ON public.stripe_lifetime_seat_reservations (checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX stripe_lifetime_seat_reservations_payment_key
  ON public.stripe_lifetime_seat_reservations (converted_payment_id)
  WHERE converted_payment_id IS NOT NULL;
CREATE UNIQUE INDEX stripe_lifetime_seat_reservations_release_event_key
  ON public.stripe_lifetime_seat_reservations (release_event_id)
  WHERE release_event_id IS NOT NULL;
CREATE INDEX stripe_lifetime_seat_reservations_active_expiry_idx
  ON public.stripe_lifetime_seat_reservations (expires_at, id)
  WHERE status IN ('reserved', 'bound');

-- Historical lifetime seats are durable commercial claims, not entitlement
-- child rows. Keep their immutable identity after profile/subscription cascade;
-- an operator may release one only after separate Stripe refund verification.
CREATE TABLE public.stripe_legacy_lifetime_seat_claims (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  legacy_subscription_id uuid NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  status text NOT NULL DEFAULT 'claimed',
  release_reference text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  released_at timestamptz,
  CONSTRAINT stripe_legacy_lifetime_seat_claims_status_check
    CHECK (status IN ('claimed', 'released')),
  CONSTRAINT stripe_legacy_lifetime_seat_claims_identity_check
    CHECK (
      pg_catalog.left(stripe_customer_id, 4) = 'cus_'
      AND pg_catalog.length(pg_catalog.btrim(stripe_subscription_id))
        BETWEEN 3 AND 255
    ),
  CONSTRAINT stripe_legacy_lifetime_seat_claims_shape_check
    CHECK (
      (
        status = 'claimed'
        AND release_reference IS NULL
        AND released_at IS NULL
      )
      OR (
        status = 'released'
        AND pg_catalog.length(pg_catalog.btrim(release_reference))
          BETWEEN 3 AND 255
        AND released_at IS NOT NULL
      )
    ),
  CONSTRAINT stripe_legacy_lifetime_seat_claims_user_key UNIQUE (user_id),
  CONSTRAINT stripe_legacy_lifetime_seat_claims_subscription_key
    UNIQUE (legacy_subscription_id)
);
CREATE UNIQUE INDEX stripe_legacy_lifetime_seat_claims_stripe_subscription_key
  ON public.stripe_legacy_lifetime_seat_claims (stripe_subscription_id);

CREATE TABLE public.stripe_trial_entitlements (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL
    REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  plan text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  verified_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_trial_entitlements_customer_check
    CHECK (pg_catalog.left(stripe_customer_id, 4) = 'cus_'),
  CONSTRAINT stripe_trial_entitlements_subscription_check
    CHECK (pg_catalog.left(stripe_subscription_id, 4) = 'sub_'),
  CONSTRAINT stripe_trial_entitlements_plan_check
    CHECK (plan IN ('monthly', 'yearly')),
  CONSTRAINT stripe_trial_entitlements_period_check
    CHECK (period_end > period_start),
  CONSTRAINT stripe_trial_entitlements_revoke_check
    CHECK (
      (revoked_at IS NULL AND revoke_reason IS NULL)
      OR (
        revoked_at IS NOT NULL
        AND pg_catalog.length(pg_catalog.btrim(revoke_reason))
          BETWEEN 1 AND 255
      )
    ),
  CONSTRAINT stripe_trial_entitlements_identity_version_key
    UNIQUE (stripe_subscription_id, period_start, period_end)
);
CREATE INDEX stripe_trial_entitlements_subscription_idx
  ON public.stripe_trial_entitlements (stripe_subscription_id, id);
CREATE INDEX stripe_trial_entitlements_user_current_idx
  ON public.stripe_trial_entitlements (user_id, period_end, id)
  WHERE revoked_at IS NULL;

CREATE TABLE public.stripe_subscription_state_events (
  event_id text PRIMARY KEY,
  user_id uuid
    REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  current_invoice_id text,
  plan text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  stripe_status text NOT NULL,
  cancel_at_period_end boolean NOT NULL,
  canceled_at timestamptz,
  requested_grace_expires_at timestamptz,
  event_created_at timestamptz NOT NULL,
  outcome text NOT NULL DEFAULT 'observed',
  observed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_subscription_state_events_id_check
    CHECK (pg_catalog.left(event_id, 4) = 'evt_'),
  CONSTRAINT stripe_subscription_state_events_customer_check
    CHECK (pg_catalog.left(stripe_customer_id, 4) = 'cus_'),
  CONSTRAINT stripe_subscription_state_events_subscription_check
    CHECK (pg_catalog.left(stripe_subscription_id, 4) = 'sub_'),
  CONSTRAINT stripe_subscription_state_events_invoice_check
    CHECK (
      current_invoice_id IS NULL
      OR pg_catalog.left(current_invoice_id, 3) = 'in_'
    ),
  CONSTRAINT stripe_subscription_state_events_plan_check
    CHECK (plan IN ('monthly', 'yearly')),
  CONSTRAINT stripe_subscription_state_events_period_check
    CHECK (period_end > period_start),
  CONSTRAINT stripe_subscription_state_events_status_check
    CHECK (
      stripe_status IN (
        'active',
        'trialing',
        'past_due',
        'canceled',
        'unpaid',
        'incomplete',
        'incomplete_expired',
        'paused'
      )
    ),
  CONSTRAINT stripe_subscription_state_events_grace_check
    CHECK (
      (
        stripe_status = 'past_due'
        AND requested_grace_expires_at IS NOT NULL
        AND requested_grace_expires_at > event_created_at
      )
      OR (
        stripe_status <> 'past_due'
        AND requested_grace_expires_at IS NULL
      )
    ),
  CONSTRAINT stripe_subscription_state_events_outcome_check
    CHECK (outcome ~ '^[a-z0-9_]{2,64}$')
);
CREATE INDEX stripe_subscription_state_events_subscription_idx
  ON public.stripe_subscription_state_events (
    stripe_subscription_id,
    event_created_at DESC,
    event_id
  );

CREATE TABLE public.pro_entitlement_grants (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL
    REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  source text NOT NULL,
  source_key text NOT NULL,
  starts_at timestamptz NOT NULL,
  expires_at timestamptz,
  revoked_at timestamptz,
  grant_kind text NOT NULL DEFAULT 'absolute',
  granted_days integer,
  granted_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT pro_entitlement_grants_source_check
    CHECK (source ~ '^[a-z0-9_]{2,64}$'),
  CONSTRAINT pro_entitlement_grants_source_key_check
    CHECK (
      pg_catalog.length(pg_catalog.btrim(source_key)) BETWEEN 1 AND 255
    ),
  CONSTRAINT pro_entitlement_grants_period_check
    CHECK (expires_at IS NULL OR expires_at > starts_at),
  CONSTRAINT pro_entitlement_grants_kind_check
    CHECK (
      (
        grant_kind = 'absolute'
        AND granted_days IS NULL
        AND granted_at IS NULL
      )
      OR (
        grant_kind = 'days'
        AND granted_days BETWEEN 1 AND 3650
        AND granted_at IS NOT NULL
        AND expires_at IS NOT NULL
      )
    ),
  CONSTRAINT pro_entitlement_grants_metadata_check
    CHECK (pg_catalog.jsonb_typeof(metadata) = 'object'),
  CONSTRAINT pro_entitlement_grants_source_key_unique
    UNIQUE (source, source_key)
);
CREATE INDEX pro_entitlement_grants_user_current_idx
  ON public.pro_entitlement_grants (user_id, expires_at, id)
  WHERE revoked_at IS NULL;
CREATE INDEX pro_entitlement_grants_due_start_idx
  ON public.pro_entitlement_grants (starts_at, user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX user_profiles_pro_projection_due_idx
  ON public.user_profiles (pro_expires_at, id)
  WHERE is_pro AND pro_expires_at IS NOT NULL;

CREATE TABLE public.stripe_manual_reviews (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  object_type text NOT NULL,
  object_id text NOT NULL,
  user_id uuid
    REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  action text NOT NULL DEFAULT 'investigate',
  reason_key text NOT NULL,
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'open',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  resolved_at timestamptz,
  CONSTRAINT stripe_manual_reviews_object_type_check
    CHECK (object_type ~ '^[a-z0-9_]{2,64}$'),
  CONSTRAINT stripe_manual_reviews_object_id_check
    CHECK (
      pg_catalog.length(pg_catalog.btrim(object_id)) BETWEEN 1 AND 255
    ),
  CONSTRAINT stripe_manual_reviews_action_check
    CHECK (action ~ '^[a-z0-9_]{2,64}$'),
  CONSTRAINT stripe_manual_reviews_reason_key_check
    CHECK (reason_key ~ '^[a-z0-9_:-]{2,96}$'),
  CONSTRAINT stripe_manual_reviews_reason_check
    CHECK (pg_catalog.length(pg_catalog.btrim(reason)) BETWEEN 1 AND 2000),
  CONSTRAINT stripe_manual_reviews_state_check
    CHECK (state IN ('open', 'resolved', 'dismissed')),
  CONSTRAINT stripe_manual_reviews_metadata_check
    CHECK (pg_catalog.jsonb_typeof(metadata) = 'object'),
  CONSTRAINT stripe_manual_reviews_stable_key
    UNIQUE (object_type, object_id, reason_key)
);
CREATE INDEX stripe_manual_reviews_open_idx
  ON public.stripe_manual_reviews (created_at, id)
  WHERE state = 'open';

-- PREDEPLOY quarantine: preserve the old canonical access projection so the
-- application can migrate, but never guess v2 authority for a Stripe-shaped
-- row whose plan/period identity is incomplete. The frozen snapshot makes the
-- required operator decision auditable and readiness/cutover remain blocked.
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
  'subscription',
  subscription.id::text,
  subscription.user_id,
  'reconcile',
  'unsupported_legacy_stripe_projection',
  'An active legacy Stripe projection lacks a supported commercial identity.',
  pg_catalog.jsonb_build_object(
    'user_id', subscription.user_id,
    'stripe_customer_id', subscription.stripe_customer_id,
    'stripe_subscription_id', subscription.stripe_subscription_id,
    'status', subscription.status,
    'tier', subscription.tier,
    'plan', subscription.plan,
    'current_period_start', subscription.current_period_start,
    'current_period_end', subscription.current_period_end,
    'cancel_at_period_end', subscription.cancel_at_period_end,
    'profile_subscription_tier', profile.subscription_tier,
    'profile_pro_plan', profile.pro_plan,
    'profile_pro_expires_at', profile.pro_expires_at,
    'profile_is_pro', profile.is_pro,
    'profile_stripe_customer_id', profile.stripe_customer_id,
    'profile_stripe_subscription_id', profile.stripe_subscription_id,
    'captured_at', pg_catalog.statement_timestamp()
  )
FROM public.subscriptions AS subscription
JOIN public.user_profiles AS profile
  ON profile.id = subscription.user_id
WHERE subscription.status IN ('active', 'trialing')
  AND subscription.tier = 'pro'
  AND (
    subscription.stripe_customer_id IS NOT NULL
    OR subscription.stripe_subscription_id IS NOT NULL
  )
  AND NOT COALESCE((
    pg_catalog.left(
      COALESCE(subscription.stripe_customer_id, ''),
      4
    ) = 'cus_'
    AND (
      (
        subscription.status = 'active'
        AND subscription.plan = 'lifetime'
        AND pg_catalog.length(
          pg_catalog.btrim(
            COALESCE(subscription.stripe_subscription_id, '')
          )
        ) BETWEEN 3 AND 255
        AND subscription.current_period_end IS NULL
      )
      OR (
        subscription.status IN ('active', 'trialing')
        AND subscription.plan IN ('monthly', 'yearly')
        AND pg_catalog.left(
          COALESCE(subscription.stripe_subscription_id, ''),
          4
        ) = 'sub_'
        AND subscription.current_period_start IS NOT NULL
        AND subscription.current_period_end
          > pg_catalog.statement_timestamp()
      )
    )
  ), false)
ON CONFLICT (object_type, object_id, reason_key) DO NOTHING;

CREATE TABLE public.stripe_entitlement_refund_events (
  event_id text PRIMARY KEY,
  entitlement_payment_id uuid NOT NULL
    REFERENCES public.stripe_entitlement_payments(id) ON DELETE RESTRICT,
  user_id uuid
    REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  refund_state text NOT NULL,
  refund_succeeded_amount bigint NOT NULL,
  stripe_subscription_status text,
  event_created_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  observations jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT stripe_entitlement_refund_events_id_check
    CHECK (pg_catalog.left(event_id, 4) = 'evt_'),
  CONSTRAINT stripe_entitlement_refund_events_state_check
    CHECK (
      refund_state IN (
        'pending',
        'requires_action',
        'succeeded',
        'failed',
        'canceled'
      )
    ),
  CONSTRAINT stripe_entitlement_refund_events_amount_check
    CHECK (refund_succeeded_amount >= 0),
  CONSTRAINT stripe_entitlement_refund_events_observations_check
    CHECK (pg_catalog.jsonb_typeof(observations) = 'array')
);
CREATE INDEX stripe_entitlement_refund_events_payment_idx
  ON public.stripe_entitlement_refund_events (
    entitlement_payment_id,
    event_created_at,
    event_id
  );

CREATE TABLE public.stripe_entitlement_effects (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  entitlement_payment_id uuid
    REFERENCES public.stripe_entitlement_payments(id) ON DELETE RESTRICT,
  user_id uuid
    REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  source_kind text NOT NULL,
  source_key text NOT NULL,
  operation_key text NOT NULL,
  effect_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamptz,
  external_ref text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  CONSTRAINT stripe_entitlement_effects_type_check
    CHECK (effect_type ~ '^[a-z0-9_]{2,96}$'),
  CONSTRAINT stripe_entitlement_effects_operation_key_check
    CHECK (
      pg_catalog.length(pg_catalog.btrim(operation_key)) BETWEEN 1 AND 255
    ),
  CONSTRAINT stripe_entitlement_effects_source_check
    CHECK (
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
            AND source_key
              ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          )
        )
      )
    ),
  CONSTRAINT stripe_entitlement_effects_status_check
    CHECK (
      status IN (
        'pending',
        'processing',
        'completed',
        'failed',
        'superseded',
        'dead_lettered'
      )
    ),
  CONSTRAINT stripe_entitlement_effects_attempt_check
    CHECK (attempt_count >= 0),
  CONSTRAINT stripe_entitlement_effects_payload_check
    CHECK (pg_catalog.jsonb_typeof(payload) = 'object'),
  CONSTRAINT stripe_entitlement_effects_lease_check
    CHECK (
      (
        status = 'processing'
        AND lease_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
      )
      OR (
        status <> 'processing'
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
      )
    ),
  CONSTRAINT stripe_entitlement_effects_source_type_unique
    UNIQUE (source_kind, source_key, effect_type, operation_key)
);
CREATE INDEX stripe_entitlement_effects_pending_idx
  ON public.stripe_entitlement_effects (available_at, created_at, id)
  WHERE status IN ('pending', 'failed');
CREATE INDEX stripe_entitlement_effects_expired_processing_idx
  ON public.stripe_entitlement_effects (lease_expires_at, created_at, id)
  WHERE status = 'processing';

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS entitlement_payment_id uuid;
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS entitlement_trial_verified_at timestamptz;
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS entitlement_trial_id uuid;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_entitlement_payment_fkey
  FOREIGN KEY (entitlement_payment_id)
  REFERENCES public.stripe_entitlement_payments(id)
  ON DELETE RESTRICT;
ALTER TABLE public.subscriptions
  ADD CONSTRAINT subscriptions_entitlement_trial_fkey
  FOREIGN KEY (entitlement_trial_id)
  REFERENCES public.stripe_trial_entitlements(id)
  ON DELETE SET NULL;
CREATE UNIQUE INDEX subscriptions_entitlement_payment_key
  ON public.subscriptions (entitlement_payment_id)
  WHERE entitlement_payment_id IS NOT NULL;
CREATE UNIQUE INDEX subscriptions_entitlement_trial_key
  ON public.subscriptions (entitlement_trial_id)
  WHERE entitlement_trial_id IS NOT NULL;

-- Preserve pre-ledger paid Stripe access as explicit, auditable legacy grants.
-- These grants are revoked when the first exact paid period is bound. Refunds
-- never guess that a legacy row belongs to an invoice.
INSERT INTO public.pro_entitlement_grants (
  user_id,
  source,
  source_key,
  starts_at,
  expires_at,
  metadata
)
SELECT
  subscription.user_id,
  'legacy_stripe_snapshot',
  'subscription:' || subscription.id::text,
  COALESCE(
    subscription.current_period_start,
    pg_catalog.statement_timestamp()
  ),
  CASE
    WHEN subscription.plan = 'lifetime' THEN NULL
    ELSE subscription.current_period_end
  END,
  pg_catalog.jsonb_build_object(
    'subscription_id', subscription.id,
    'stripe_subscription_id', subscription.stripe_subscription_id,
    'plan', subscription.plan,
    'migration', '20260718183000'
  )
FROM public.subscriptions AS subscription
WHERE subscription.status = 'active'
  AND subscription.tier = 'pro'
  AND subscription.plan IN ('monthly', 'yearly', 'lifetime')
  AND subscription.stripe_customer_id IS NOT NULL
  AND subscription.stripe_subscription_id IS NOT NULL
  AND (
    subscription.plan = 'lifetime'
    OR subscription.current_period_end > pg_catalog.statement_timestamp()
  )
ON CONFLICT (source, source_key) DO NOTHING;

-- A lifetime sale consumes one of the advertised 200 seats even if its owner
-- is later hard-deleted and the subscription/grant rows cascade away. Snapshot
-- each surviving pre-ledger lifetime sale into a relation with deliberately no
-- profile FK. Releasing one requires a separately verified operator workflow.
INSERT INTO public.stripe_legacy_lifetime_seat_claims (
  user_id,
  legacy_subscription_id,
  stripe_customer_id,
  stripe_subscription_id,
  status
)
SELECT
  subscription.user_id,
  subscription.id,
  subscription.stripe_customer_id,
  subscription.stripe_subscription_id,
  'claimed'
FROM public.subscriptions AS subscription
WHERE subscription.status = 'active'
  AND subscription.tier = 'pro'
  AND subscription.plan = 'lifetime'
  AND subscription.entitlement_payment_id IS NULL
  AND subscription.stripe_customer_id IS NOT NULL
  AND subscription.stripe_subscription_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- Existing exact Stripe trials are preserved in an immutable identity snapshot
-- rather than trusting a mutable timestamp marker on subscriptions.
INSERT INTO public.stripe_trial_entitlements (
  user_id,
  stripe_customer_id,
  stripe_subscription_id,
  plan,
  period_start,
  period_end,
  verified_at
)
SELECT
  subscription.user_id,
  subscription.stripe_customer_id,
  subscription.stripe_subscription_id,
  subscription.plan,
  subscription.current_period_start,
  subscription.current_period_end,
  pg_catalog.statement_timestamp()
FROM public.subscriptions AS subscription
WHERE subscription.status = 'trialing'
  AND subscription.tier = 'pro'
  AND subscription.plan IN ('monthly', 'yearly')
  AND subscription.stripe_customer_id IS NOT NULL
  AND subscription.stripe_subscription_id IS NOT NULL
  AND subscription.current_period_start IS NOT NULL
  AND subscription.current_period_end > pg_catalog.statement_timestamp()
ON CONFLICT (stripe_subscription_id, period_start, period_end) DO NOTHING;

UPDATE public.subscriptions AS subscription
SET entitlement_trial_id = trial.id,
    entitlement_trial_verified_at = trial.verified_at
FROM public.stripe_trial_entitlements AS trial
WHERE trial.user_id = subscription.user_id
  AND trial.stripe_customer_id = subscription.stripe_customer_id
  AND trial.stripe_subscription_id = subscription.stripe_subscription_id
  AND trial.plan = subscription.plan
  AND trial.period_start = subscription.current_period_start
  AND trial.period_end = subscription.current_period_end
  AND trial.revoked_at IS NULL;

DO $legacy_profile_markers$
BEGIN
  -- The only safely recognizable historical is_pro shape is the referral-only
  -- row written by grantProDays when no subscription existed. Anything else
  -- needs an explicit operator decision rather than an indefinite guessed grant.
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
    'profile',
    profile.id::text,
    profile.id,
    'reconcile',
    'ambiguous_legacy_pro_projection',
    'A legacy Pro projection lacks reconstructable grant provenance.',
    pg_catalog.jsonb_build_object(
      'user_id', profile.id,
      'subscription_tier', profile.subscription_tier,
      'pro_plan', profile.pro_plan,
      'pro_expires_at', profile.pro_expires_at,
      'is_pro', profile.is_pro,
      'stripe_customer_id', profile.stripe_customer_id,
      'stripe_subscription_id', profile.stripe_subscription_id,
      'captured_at', pg_catalog.statement_timestamp()
    )
    FROM public.user_profiles AS profile
    WHERE COALESCE(profile.is_pro, false)
      AND NOT EXISTS (
        SELECT 1
        FROM public.stripe_manual_reviews AS review
        WHERE review.user_id = profile.id
          AND review.reason_key =
            'unsupported_legacy_stripe_projection'
          AND review.state = 'open'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.pro_entitlement_grants AS entitlement_grant
        WHERE entitlement_grant.user_id = profile.id
          AND entitlement_grant.source = 'legacy_stripe_snapshot'
          AND entitlement_grant.revoked_at IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.stripe_trial_entitlements AS trial
        WHERE trial.user_id = profile.id
          AND trial.revoked_at IS NULL
          AND trial.period_end > pg_catalog.statement_timestamp()
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.subscriptions AS subscription
        WHERE subscription.user_id = profile.id
          AND subscription.status IN ('active', 'trialing')
          AND subscription.tier = 'pro'
          AND subscription.plan IS NULL
          AND subscription.stripe_customer_id IS NULL
          AND subscription.stripe_subscription_id IS NULL
          AND subscription.current_period_end
            > pg_catalog.statement_timestamp()
      )
  ON CONFLICT (object_type, object_id, reason_key) DO NOTHING;

  INSERT INTO public.pro_entitlement_grants (
    user_id,
    source,
    source_key,
    starts_at,
    expires_at,
    metadata
  )
  SELECT
    subscription.user_id,
    'legacy_referral_snapshot',
    'subscription:' || subscription.id::text,
    COALESCE(
      subscription.current_period_start,
      pg_catalog.statement_timestamp()
    ),
    subscription.current_period_end,
    pg_catalog.jsonb_build_object(
      'subscription_id', subscription.id,
      'migration', '20260718183000'
    )
  FROM public.subscriptions AS subscription
  JOIN public.user_profiles AS profile
    ON profile.id = subscription.user_id
  WHERE COALESCE(profile.is_pro, false)
    AND subscription.status IN ('active', 'trialing')
    AND subscription.tier = 'pro'
    AND subscription.plan IS NULL
    AND subscription.stripe_customer_id IS NULL
    AND subscription.stripe_subscription_id IS NULL
    AND subscription.current_period_end
      > pg_catalog.statement_timestamp()
  ON CONFLICT (source, source_key) DO NOTHING;
END
$legacy_profile_markers$;

ALTER TABLE public.stripe_entitlement_payments OWNER TO postgres;
ALTER TABLE public.stripe_charge_refund_tombstones OWNER TO postgres;
ALTER TABLE public.stripe_charge_refund_tombstone_events OWNER TO postgres;
ALTER TABLE public.stripe_lifetime_seat_reservations OWNER TO postgres;
ALTER TABLE public.stripe_legacy_lifetime_seat_claims OWNER TO postgres;
ALTER TABLE public.stripe_trial_entitlements OWNER TO postgres;
ALTER TABLE public.stripe_subscription_state_events OWNER TO postgres;
ALTER TABLE public.pro_entitlement_grants OWNER TO postgres;
ALTER TABLE public.stripe_manual_reviews OWNER TO postgres;
ALTER TABLE public.stripe_entitlement_refund_events OWNER TO postgres;
ALTER TABLE public.stripe_entitlement_effects OWNER TO postgres;

ALTER TABLE public.stripe_entitlement_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_entitlement_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_charge_refund_tombstones
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_charge_refund_tombstones
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_charge_refund_tombstone_events
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_charge_refund_tombstone_events
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_lifetime_seat_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_lifetime_seat_reservations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_legacy_lifetime_seat_claims
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_legacy_lifetime_seat_claims
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_trial_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_trial_entitlements FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_subscription_state_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_subscription_state_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.pro_entitlement_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pro_entitlement_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_manual_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_manual_reviews FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_entitlement_refund_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_entitlement_refund_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_entitlement_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_entitlement_effects FORCE ROW LEVEL SECURITY;

CREATE POLICY stripe_entitlement_payments_service_select
  ON public.stripe_entitlement_payments
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY stripe_charge_refund_tombstones_service_select
  ON public.stripe_charge_refund_tombstones
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY stripe_charge_refund_tombstone_events_service_select
  ON public.stripe_charge_refund_tombstone_events
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY stripe_lifetime_seat_reservations_service_select
  ON public.stripe_lifetime_seat_reservations
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY stripe_legacy_lifetime_seat_claims_service_select
  ON public.stripe_legacy_lifetime_seat_claims
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY stripe_trial_entitlements_service_select
  ON public.stripe_trial_entitlements
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY stripe_subscription_state_events_service_select
  ON public.stripe_subscription_state_events
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY pro_entitlement_grants_service_select
  ON public.pro_entitlement_grants
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY stripe_manual_reviews_service_select
  ON public.stripe_manual_reviews
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY stripe_entitlement_refund_events_service_select
  ON public.stripe_entitlement_refund_events
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY stripe_entitlement_effects_service_select
  ON public.stripe_entitlement_effects
  FOR SELECT TO service_role
  USING (true);

REVOKE ALL ON TABLE
  public.stripe_entitlement_payments,
  public.stripe_charge_refund_tombstones,
  public.stripe_charge_refund_tombstone_events,
  public.stripe_lifetime_seat_reservations,
  public.stripe_legacy_lifetime_seat_claims,
  public.stripe_trial_entitlements,
  public.stripe_subscription_state_events,
  public.pro_entitlement_grants,
  public.stripe_manual_reviews,
  public.stripe_entitlement_refund_events,
  public.stripe_entitlement_effects
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT SELECT ON TABLE
  public.stripe_entitlement_payments,
  public.stripe_charge_refund_tombstones,
  public.stripe_charge_refund_tombstone_events,
  public.stripe_lifetime_seat_reservations,
  public.stripe_legacy_lifetime_seat_claims,
  public.stripe_trial_entitlements,
  public.stripe_subscription_state_events,
  public.pro_entitlement_grants,
  public.stripe_manual_reviews,
  public.stripe_entitlement_refund_events,
  public.stripe_entitlement_effects
TO service_role;

CREATE OR REPLACE FUNCTION public.record_stripe_manual_review_atomic(
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
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_inserted_id uuid;
  v_existing public.stripe_manual_reviews%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_object_type IS NULL
    OR p_object_type !~ '^[a-z0-9_]{2,64}$'
    OR p_object_id IS NULL
    OR pg_catalog.length(pg_catalog.btrim(p_object_id)) NOT BETWEEN 1 AND 255
    OR p_reason_key IS NULL
    OR p_reason_key !~ '^[a-z0-9_:-]{2,96}$'
    OR p_reason IS NULL
    OR pg_catalog.length(pg_catalog.btrim(p_reason)) NOT BETWEEN 1 AND 2000
    OR p_context IS NULL
    OR pg_catalog.jsonb_typeof(p_context) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'manual review identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.stripe_manual_reviews (
    object_type,
    object_id,
    user_id,
    action,
    reason_key,
    reason,
    metadata
  ) VALUES (
    p_object_type,
    p_object_id,
    p_user_id,
    'investigate',
    p_reason_key,
    p_reason,
    p_context
  )
  ON CONFLICT (object_type, object_id, reason_key) DO NOTHING
  RETURNING id INTO v_inserted_id;

  IF v_inserted_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'recorded');
  END IF;

  SELECT review.*
  INTO v_existing
  FROM public.stripe_manual_reviews AS review
  WHERE review.object_type = p_object_type
    AND review.object_id = p_object_id
    AND review.reason_key = p_reason_key
  FOR UPDATE;

  IF NOT FOUND
    OR v_existing.user_id IS DISTINCT FROM p_user_id
  THEN
    RAISE EXCEPTION 'manual review stable key identity conflict'
      USING ERRCODE = '23514';
  END IF;

  RETURN pg_catalog.jsonb_build_object('status', 'already_recorded');
END
$function$;

ALTER FUNCTION public.record_stripe_manual_review_atomic(
  text, text, uuid, text, text, jsonb
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.bind_stripe_customer_owner_atomic(
  p_user_id uuid,
  p_new_stripe_customer_id text,
  p_expected_previous_stripe_customer_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_conflicting_user_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR pg_catalog.left(
      COALESCE(p_new_stripe_customer_id, ''),
      4
    ) <> 'cus_'
    OR (
      p_expected_previous_stripe_customer_id IS NOT NULL
      AND pg_catalog.left(
        p_expected_previous_stripe_customer_id,
        4
      ) <> 'cus_'
    )
  THEN
    RAISE EXCEPTION 'Stripe customer owner binding is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- Match the global entitlement writer lock prefix, then serialize ownership
  -- of this customer id. This prevents two checkouts from linking one Stripe
  -- Customer to different B2C accounts.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_user_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-customer-owner:' || p_new_stripe_customer_id,
      0
    )
  );

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active Stripe customer owner is missing'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_profile.stripe_customer_id = p_new_stripe_customer_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_bound');
  END IF;

  IF v_profile.stripe_customer_id
      IS DISTINCT FROM p_expected_previous_stripe_customer_id
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict'
    );
  END IF;

  SELECT profile.id
  INTO v_conflicting_user_id
  FROM public.user_profiles AS profile
  WHERE profile.stripe_customer_id = p_new_stripe_customer_id
    AND profile.id IS DISTINCT FROM p_user_id
  FOR UPDATE;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict'
    );
  END IF;

  UPDATE public.user_profiles
  SET stripe_customer_id = p_new_stripe_customer_id,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_user_id
    AND deleted_at IS NULL
    AND stripe_customer_id
      IS NOT DISTINCT FROM p_expected_previous_stripe_customer_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict'
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object('status', 'bound');
END
$function$;

ALTER FUNCTION public.bind_stripe_customer_owner_atomic(uuid, text, text)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.record_charge_refund_tombstone_atomic(
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
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_tombstone public.stripe_charge_refund_tombstones%ROWTYPE;
  v_event public.stripe_charge_refund_tombstone_events%ROWTYPE;
  v_audit_user_id uuid;
  v_inserted_event_id text;
  v_existing_payment_id uuid;
  v_same_observation boolean := false;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.left(COALESCE(p_stripe_customer_id, ''), 4) <> 'cus_'
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND pg_catalog.left(p_stripe_payment_intent_id, 3) <> 'pi_'
    )
    OR pg_catalog.left(COALESCE(p_stripe_charge_id, ''), 3) <> 'ch_'
    OR p_captured IS DISTINCT FROM true
    OR p_amount_paid IS NULL
    OR p_amount_paid <= 0
    OR p_currency IS NULL
    OR p_currency !~ '^[a-z]{3}$'
    OR p_refund_succeeded_amount IS NULL
    OR p_refund_succeeded_amount < 0
    OR p_refund_succeeded_amount > p_amount_paid
    OR (
      p_refund_succeeded_amount = p_amount_paid
      AND p_refund_state IS DISTINCT FROM 'succeeded'
    )
    OR p_refund_state NOT IN (
      'pending',
      'requires_action',
      'succeeded',
      'failed',
      'canceled'
    )
    OR pg_catalog.left(COALESCE(p_refund_event_id, ''), 4) <> 'evt_'
    OR p_refund_event_created_at IS NULL
  THEN
    RAISE EXCEPTION 'Charge refund tombstone identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- Fixed lock order shared with activation/refund and the cutover fence.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-lifetime-seat-capacity', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-refund-event:' || p_refund_event_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || p_stripe_charge_id,
      0
    )
  );
  IF p_user_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'pro-official-group-user:' || p_user_id::text,
        0
      )
    );
    SELECT profile.id
    INTO v_audit_user_id
    FROM public.user_profiles AS profile
    WHERE profile.id = p_user_id
      AND profile.deleted_at IS NULL
    FOR UPDATE;
  END IF;

  SELECT payment.id
  INTO v_existing_payment_id
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.stripe_charge_id = p_stripe_charge_id
  FOR UPDATE;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'payment_reconciliation_required',
      'entitlement_payment_id', v_existing_payment_id
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_entitlement_refund_events AS refund_event
    WHERE refund_event.event_id = p_refund_event_id
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'refund',
      p_refund_event_id,
      v_audit_user_id,
      'refund_event_identity_conflict',
      'A refund event already belongs to a classified entitlement payment.',
      pg_catalog.jsonb_build_object(
        'stripe_charge_id', p_stripe_charge_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
    WHERE tombstone_event.event_id = p_refund_event_id
      AND tombstone_event.stripe_charge_id
        IS DISTINCT FROM p_stripe_charge_id
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'refund',
      p_refund_event_id,
      v_audit_user_id,
      'refund_event_identity_conflict',
      'A refund event already belongs to another Charge tombstone.',
      pg_catalog.jsonb_build_object(
        'stripe_charge_id', p_stripe_charge_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  INSERT INTO public.stripe_charge_refund_tombstones (
    stripe_charge_id,
    stripe_customer_id,
    stripe_payment_intent_id,
    captured,
    amount_paid,
    currency,
    refund_succeeded_amount,
    refund_state,
    latest_refund_event_id,
    latest_refund_event_created_at,
    refund_snapshot_event_id,
    refund_snapshot_event_created_at
  ) VALUES (
    p_stripe_charge_id,
    p_stripe_customer_id,
    p_stripe_payment_intent_id,
    p_captured,
    p_amount_paid,
    p_currency,
    p_refund_succeeded_amount,
    p_refund_state,
    p_refund_event_id,
    p_refund_event_created_at,
    p_refund_event_id,
    p_refund_event_created_at
  )
  ON CONFLICT (stripe_charge_id) DO NOTHING;

  SELECT tombstone.*
  INTO v_tombstone
  FROM public.stripe_charge_refund_tombstones AS tombstone
  WHERE tombstone.stripe_charge_id = p_stripe_charge_id
  FOR UPDATE;

  IF v_tombstone.stripe_customer_id
      IS DISTINCT FROM p_stripe_customer_id
    OR v_tombstone.stripe_payment_intent_id
      IS DISTINCT FROM p_stripe_payment_intent_id
    OR v_tombstone.captured IS DISTINCT FROM p_captured
    OR v_tombstone.amount_paid IS DISTINCT FROM p_amount_paid
    OR v_tombstone.currency IS DISTINCT FROM p_currency
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      p_stripe_charge_id,
      v_audit_user_id,
      'charge_refund_tombstone_identity_conflict',
      'A refunded Charge replay changed immutable financial identity.',
      pg_catalog.jsonb_build_object(
        'event_id', p_refund_event_id,
        'existing_customer_id', v_tombstone.stripe_customer_id,
        'incoming_customer_id', p_stripe_customer_id,
        'existing_payment_intent_id',
          v_tombstone.stripe_payment_intent_id,
        'incoming_payment_intent_id', p_stripe_payment_intent_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  INSERT INTO public.stripe_charge_refund_tombstone_events (
    event_id,
    stripe_charge_id,
    refund_state,
    refund_succeeded_amount,
    event_created_at,
    observations
  ) VALUES (
    p_refund_event_id,
    p_stripe_charge_id,
    p_refund_state,
    p_refund_succeeded_amount,
    p_refund_event_created_at,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'refund_state', p_refund_state,
        'refund_succeeded_amount', p_refund_succeeded_amount
      )
    )
  )
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_id INTO v_inserted_event_id;

  SELECT tombstone_event.*
  INTO v_event
  FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
  WHERE tombstone_event.event_id = p_refund_event_id
  FOR UPDATE;
  IF v_event.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
    OR v_event.event_created_at IS DISTINCT FROM p_refund_event_created_at
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'refund',
      p_refund_event_id,
      v_audit_user_id,
      'refund_event_identity_conflict',
      'A Charge refund event id was rebound to another immutable identity.',
      pg_catalog.jsonb_build_object(
        'stripe_charge_id', p_stripe_charge_id,
        'existing_stripe_charge_id', v_event.stripe_charge_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  v_same_observation :=
    v_inserted_event_id IS NULL
    AND v_event.observations @>
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'refund_state', p_refund_state,
          'refund_succeeded_amount', p_refund_succeeded_amount
        )
      );
  IF v_inserted_event_id IS NULL
    AND NOT v_same_observation
  THEN
    UPDATE public.stripe_charge_refund_tombstone_events
    SET refund_state = p_refund_state,
        refund_succeeded_amount = p_refund_succeeded_amount,
        observations = observations || pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'refund_state', p_refund_state,
            'refund_succeeded_amount', p_refund_succeeded_amount
          )
        ),
        observed_at = v_now
    WHERE event_id = p_refund_event_id;
  END IF;

  IF v_tombstone.refund_state = 'succeeded'
    AND v_tombstone.refund_succeeded_amount >= v_tombstone.amount_paid
    AND NOT (
      p_refund_state = 'succeeded'
      AND p_refund_succeeded_amount >= p_amount_paid
    )
  THEN
    -- A full succeeded aggregate is financially terminal. Preserve its
    -- applied snapshot, but retain the later event identity as the max-seen
    -- watermark and raise a durable review for the contradictory observation.
    UPDATE public.stripe_charge_refund_tombstones
    SET latest_refund_event_id = CASE
          WHEN p_refund_event_created_at
            > latest_refund_event_created_at
          THEN p_refund_event_id
          ELSE latest_refund_event_id
        END,
        latest_refund_event_created_at = GREATEST(
          latest_refund_event_created_at,
          p_refund_event_created_at
        ),
        updated_at = v_now
    WHERE stripe_charge_id = p_stripe_charge_id;

    PERFORM public.record_stripe_manual_review_atomic(
      'refund',
      p_refund_event_id,
      v_audit_user_id,
      'full_refund_terminal_conflict',
      'A later Charge aggregate attempted to reduce a fully succeeded refund.',
      pg_catalog.jsonb_build_object(
        'stripe_charge_id', p_stripe_charge_id,
        'incoming_refund_state', p_refund_state,
        'incoming_refund_succeeded_amount',
          p_refund_succeeded_amount,
        'applied_refund_state', v_tombstone.refund_state,
        'applied_refund_succeeded_amount',
          v_tombstone.refund_succeeded_amount
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'full_refund_terminal');
  END IF;

  IF p_refund_succeeded_amount
      < v_tombstone.refund_succeeded_amount
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'refund',
      p_refund_event_id,
      v_audit_user_id,
      'charge_refund_aggregate_decreased',
      'A fresh Charge aggregate attempted to decrease refunded amount.',
      pg_catalog.jsonb_build_object(
        'stripe_charge_id', p_stripe_charge_id,
        'existing_refund_succeeded_amount',
          v_tombstone.refund_succeeded_amount,
        'incoming_refund_succeeded_amount',
          p_refund_succeeded_amount
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  IF p_refund_event_created_at
      < v_tombstone.latest_refund_event_created_at
    AND p_refund_succeeded_amount =
      v_tombstone.refund_succeeded_amount
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'stale_observation');
  END IF;

  UPDATE public.stripe_charge_refund_tombstones
  SET refund_succeeded_amount = p_refund_succeeded_amount,
      refund_state = p_refund_state,
      latest_refund_event_id = CASE
        WHEN p_refund_event_created_at
          >= latest_refund_event_created_at
        THEN p_refund_event_id
        ELSE latest_refund_event_id
      END,
      latest_refund_event_created_at = GREATEST(
        latest_refund_event_created_at,
        p_refund_event_created_at
      ),
      refund_snapshot_event_id = p_refund_event_id,
      refund_snapshot_event_created_at =
        p_refund_event_created_at,
      updated_at = v_now
  WHERE stripe_charge_id = p_stripe_charge_id
  RETURNING * INTO v_tombstone;

  IF v_tombstone.merged_payment_id IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'payment_reconciliation_required',
      'entitlement_payment_id', v_tombstone.merged_payment_id
    );
  END IF;
  IF v_inserted_event_id IS NULL
    AND v_same_observation
    AND v_tombstone.refund_succeeded_amount =
      p_refund_succeeded_amount
    AND v_tombstone.refund_state = p_refund_state
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_recorded');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'recorded');
END
$function$;

ALTER FUNCTION public.record_charge_refund_tombstone_atomic(
  uuid, text, text, text, boolean, bigint, text, bigint, text, text,
  timestamptz
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.stripe_merge_charge_refund_tombstone_v2(
  p_payment_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_tombstone public.stripe_charge_refund_tombstones%ROWTYPE;
BEGIN
  IF p_payment_id IS NULL THEN
    RAISE EXCEPTION 'entitlement payment merge identity is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT payment.*
  INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.id = p_payment_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entitlement payment merge target is missing'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT tombstone.*
  INTO v_tombstone
  FROM public.stripe_charge_refund_tombstones AS tombstone
  WHERE tombstone.stripe_charge_id = v_payment.stripe_charge_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'no_tombstone');
  END IF;

  IF (
      v_tombstone.merged_payment_id IS NOT NULL
      AND v_tombstone.merged_payment_id IS DISTINCT FROM v_payment.id
    )
    OR v_tombstone.stripe_customer_id
      IS DISTINCT FROM v_payment.stripe_customer_id
    OR v_tombstone.stripe_payment_intent_id
      IS DISTINCT FROM v_payment.stripe_payment_intent_id
    OR v_tombstone.amount_paid IS DISTINCT FROM v_payment.amount_paid
    OR v_tombstone.currency IS DISTINCT FROM v_payment.currency
    OR NOT v_tombstone.captured
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_payment.stripe_charge_id,
      v_payment.user_id,
      'charge_refund_tombstone_merge_identity_conflict',
      'A Charge refund tombstone conflicted with entitlement payment identity.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'resolution_kind', v_tombstone.resolution_kind,
        'merged_payment_id', v_tombstone.merged_payment_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF v_tombstone.resolution_kind = 'entitlement_payment'
    AND v_tombstone.merged_payment_id = v_payment.id
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_merged');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
    JOIN public.stripe_entitlement_refund_events AS refund_event
      ON refund_event.event_id = tombstone_event.event_id
    WHERE tombstone_event.stripe_charge_id =
        v_tombstone.stripe_charge_id
      AND (
        refund_event.entitlement_payment_id IS DISTINCT FROM v_payment.id
        OR refund_event.event_created_at
          IS DISTINCT FROM tombstone_event.event_created_at
      )
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_payment.stripe_charge_id,
      v_payment.user_id,
      'charge_refund_event_merge_identity_conflict',
      'A tombstone refund event already belongs to another payment.',
      pg_catalog.jsonb_build_object('payment_id', v_payment.id)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF v_tombstone.refund_succeeded_amount
      < v_payment.refund_succeeded_amount
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_payment.stripe_charge_id,
      v_payment.user_id,
      'charge_refund_tombstone_merge_aggregate_conflict',
      'A tombstone aggregate was older than the payment refund aggregate.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'payment_refund_succeeded_amount',
          v_payment.refund_succeeded_amount,
        'tombstone_refund_succeeded_amount',
          v_tombstone.refund_succeeded_amount
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  UPDATE public.stripe_entitlement_payments
  SET refund_succeeded_amount = v_tombstone.refund_succeeded_amount,
      refund_state = v_tombstone.refund_state,
      latest_refund_event_id = v_tombstone.latest_refund_event_id,
      latest_refund_event_created_at =
        v_tombstone.latest_refund_event_created_at,
      refund_snapshot_event_id = v_tombstone.refund_snapshot_event_id,
      refund_snapshot_event_created_at =
        v_tombstone.refund_snapshot_event_created_at,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_payment.id
  RETURNING * INTO v_payment;

  INSERT INTO public.stripe_entitlement_refund_events (
    event_id,
    entitlement_payment_id,
    user_id,
    refund_state,
    refund_succeeded_amount,
    stripe_subscription_status,
    event_created_at,
    observations
  )
  SELECT
    tombstone_event.event_id,
    v_payment.id,
    v_payment.user_id,
    tombstone_event.refund_state,
    tombstone_event.refund_succeeded_amount,
    NULL,
    tombstone_event.event_created_at,
    tombstone_event.observations
  FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
  WHERE tombstone_event.stripe_charge_id = v_tombstone.stripe_charge_id
  ON CONFLICT (event_id) DO NOTHING;

  UPDATE public.stripe_entitlement_refund_events AS refund_event
  SET observations = (
        SELECT pg_catalog.jsonb_agg(DISTINCT observation.value)
        FROM pg_catalog.jsonb_array_elements(
          refund_event.observations || tombstone_event.observations
        ) AS observation(value)
      ),
      observed_at = pg_catalog.clock_timestamp()
  FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
  WHERE tombstone_event.stripe_charge_id = v_tombstone.stripe_charge_id
    AND refund_event.event_id = tombstone_event.event_id
    AND refund_event.entitlement_payment_id = v_payment.id
    AND refund_event.event_created_at = tombstone_event.event_created_at;

  UPDATE public.stripe_charge_refund_tombstones
  SET merged_payment_id = v_payment.id,
      resolution_kind = 'entitlement_payment',
      resolution_reference = 'payment:' || v_payment.id::text,
      updated_at = pg_catalog.clock_timestamp()
  WHERE stripe_charge_id = v_tombstone.stripe_charge_id;

  IF v_payment.refund_state = 'succeeded'
    AND v_payment.refund_succeeded_amount >= v_payment.amount_paid
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'refunded_payment');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'merged');
END
$function$;

ALTER FUNCTION public.stripe_merge_charge_refund_tombstone_v2(uuid)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.stripe_lifetime_claimed_seat_count_v2()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT (
    (
      SELECT pg_catalog.count(*)
      FROM public.stripe_entitlement_payments AS payment
      WHERE payment.payment_kind = 'lifetime'
        AND NOT (
          payment.refund_state = 'succeeded'
          AND payment.refund_succeeded_amount >= payment.amount_paid
        )
    )
    + (
      SELECT pg_catalog.count(*)
      FROM public.stripe_lifetime_seat_reservations AS reservation
      WHERE (
          reservation.status = 'reserved'
          AND reservation.expires_at > pg_catalog.statement_timestamp()
        )
        OR (
          reservation.status = 'bound'
          AND NOT EXISTS (
            SELECT 1
            FROM public.stripe_entitlement_payments AS payment
            WHERE payment.payment_kind = 'lifetime'
              AND payment.checkout_session_id =
                reservation.checkout_session_id
              AND NOT (
                payment.refund_state = 'succeeded'
                AND payment.refund_succeeded_amount >= payment.amount_paid
              )
          )
        )
    )
    + (
      SELECT pg_catalog.count(*)
      FROM public.stripe_legacy_lifetime_seat_claims AS legacy_claim
      WHERE legacy_claim.status = 'claimed'
    )
    + (
      SELECT pg_catalog.count(*)
      FROM public.subscriptions AS subscription
      WHERE subscription.status = 'active'
        AND subscription.tier = 'pro'
        AND subscription.plan = 'lifetime'
        AND subscription.entitlement_payment_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.stripe_legacy_lifetime_seat_claims AS legacy_claim
          WHERE legacy_claim.legacy_subscription_id = subscription.id
            AND legacy_claim.user_id = subscription.user_id
            AND legacy_claim.status = 'claimed'
        )
    )
  )::integer
$function$;

ALTER FUNCTION public.stripe_lifetime_claimed_seat_count_v2()
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.reserve_lifetime_membership_spot_atomic(
  p_user_id uuid,
  p_request_nonce text,
  p_ttl_seconds integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_existing public.stripe_lifetime_seat_reservations%ROWTYPE;
  v_reservation public.stripe_lifetime_seat_reservations%ROWTYPE;
  v_claimed_count integer;
  v_now timestamptz :=
    pg_catalog.date_trunc('second', pg_catalog.clock_timestamp());
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_request_nonce IS NULL
    OR pg_catalog.length(pg_catalog.btrim(p_request_nonce))
      NOT BETWEEN 8 AND 128
    OR p_request_nonce !~ '^[A-Za-z0-9_.:-]+$'
    OR p_ttl_seconds IS NULL
    OR p_ttl_seconds NOT BETWEEN 1800 AND 86400
  THEN
    RAISE EXCEPTION 'lifetime reservation request is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- This lock spans only the short database transaction. The durable row, not
  -- the advisory lock, reserves capacity while Stripe Checkout is created.
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

  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active lifetime reservation owner is missing'
      USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.stripe_lifetime_seat_reservations
  SET status = 'expired',
      release_reason = 'lease_expired',
      released_at = v_now,
      updated_at = v_now
  WHERE status = 'reserved'
    AND expires_at <= v_now;

  SELECT reservation.*
  INTO v_existing
  FROM public.stripe_lifetime_seat_reservations AS reservation
  WHERE reservation.user_id = p_user_id
    AND reservation.request_nonce = p_request_nonce
  FOR UPDATE;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      CASE
        WHEN v_existing.status = 'converted' THEN 'already_converted'
        WHEN v_existing.status IN ('reserved', 'bound')
          THEN 'already_reserved'
        ELSE v_existing.status
      END,
      'reservation_id',
      v_existing.id,
      'reservation_status',
      v_existing.status,
      'expires_at',
      v_existing.expires_at,
      'checkout_expires_at',
      v_existing.checkout_expires_at,
      'checkout_session_id',
      v_existing.checkout_session_id,
      'converted_payment_id',
      v_existing.converted_payment_id
    );
  END IF;

  IF EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      WHERE payment.user_id = p_user_id
        AND payment.payment_kind = 'lifetime'
        AND NOT (
          payment.refund_state = 'succeeded'
          AND payment.refund_succeeded_amount >= payment.amount_paid
        )
    ) OR EXISTS (
      SELECT 1
      FROM public.pro_entitlement_grants AS entitlement_grant
      WHERE entitlement_grant.user_id = p_user_id
        AND entitlement_grant.source = 'legacy_stripe_snapshot'
        AND entitlement_grant.expires_at IS NULL
        AND entitlement_grant.revoked_at IS NULL
        AND entitlement_grant.metadata ->> 'plan' = 'lifetime'
    ) OR EXISTS (
      SELECT 1
      FROM public.subscriptions AS subscription
      WHERE subscription.user_id = p_user_id
        AND subscription.status = 'active'
        AND subscription.tier = 'pro'
        AND subscription.plan = 'lifetime'
        AND subscription.entitlement_payment_id IS NULL
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_entitled');
  END IF;

  SELECT reservation.*
  INTO v_existing
  FROM public.stripe_lifetime_seat_reservations AS reservation
  WHERE reservation.user_id = p_user_id
    AND reservation.status IN ('reserved', 'bound')
    AND (
      reservation.status = 'bound'
      OR reservation.expires_at > v_now
    )
  FOR UPDATE;
  IF FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'reservation_exists',
      'reservation_id',
      v_existing.id,
      'reservation_status',
      v_existing.status,
      'expires_at',
      v_existing.expires_at,
      'checkout_expires_at',
      v_existing.checkout_expires_at,
      'checkout_session_id',
      v_existing.checkout_session_id
    );
  END IF;

  SELECT public.stripe_lifetime_claimed_seat_count_v2()
  INTO v_claimed_count;

  IF v_claimed_count >= 200 THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'sold_out',
      'claimed_count',
      v_claimed_count,
      'capacity',
      200
    );
  END IF;

  INSERT INTO public.stripe_lifetime_seat_reservations (
    user_id,
    request_nonce,
    status,
    checkout_expires_at,
    expires_at,
    updated_at
  ) VALUES (
    p_user_id,
    p_request_nonce,
    'reserved',
    v_now + pg_catalog.make_interval(secs => p_ttl_seconds),
    v_now + pg_catalog.make_interval(secs => p_ttl_seconds)
      + pg_catalog.make_interval(mins => 15),
    v_now
  )
  RETURNING * INTO v_reservation;

  RETURN pg_catalog.jsonb_build_object(
    'status',
    'reserved',
    'reservation_id',
    v_reservation.id,
    'expires_at',
    v_reservation.expires_at,
    'checkout_expires_at',
    v_reservation.checkout_expires_at,
    'claimed_count',
    v_claimed_count + 1,
    'capacity',
    200
  );
END
$function$;

ALTER FUNCTION public.reserve_lifetime_membership_spot_atomic(
  uuid, text, integer
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.bind_lifetime_membership_reservation_session_atomic(
  p_user_id uuid,
  p_reservation_id uuid,
  p_request_nonce text,
  p_checkout_session_id text,
  p_session_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_reservation public.stripe_lifetime_seat_reservations%ROWTYPE;
  v_now timestamptz :=
    pg_catalog.date_trunc('second', pg_catalog.clock_timestamp());
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_reservation_id IS NULL
    OR p_request_nonce IS NULL
    OR pg_catalog.length(pg_catalog.btrim(p_request_nonce))
      NOT BETWEEN 8 AND 128
    OR pg_catalog.left(COALESCE(p_checkout_session_id, ''), 3) <> 'cs_'
    OR p_session_expires_at IS NULL
  THEN
    RAISE EXCEPTION 'lifetime reservation binding is invalid'
      USING ERRCODE = '22023';
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
  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active lifetime reservation owner is missing'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT reservation.*
  INTO v_reservation
  FROM public.stripe_lifetime_seat_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_reservation.user_id IS DISTINCT FROM p_user_id
    OR v_reservation.request_nonce IS DISTINCT FROM p_request_nonce
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  IF v_reservation.checkout_expires_at
    IS DISTINCT FROM p_session_expires_at
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'expiry_conflict');
  END IF;
  IF v_reservation.status = 'converted' THEN
    IF v_reservation.checkout_session_id IS DISTINCT FROM p_checkout_session_id
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'already_converted',
      'converted_payment_id',
      v_reservation.converted_payment_id
    );
  END IF;
  IF v_reservation.status = 'bound' THEN
    IF v_reservation.checkout_session_id = p_checkout_session_id THEN
      RETURN pg_catalog.jsonb_build_object('status', 'already_bound');
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  IF v_reservation.status IS DISTINCT FROM 'reserved' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      v_reservation.status
    );
  END IF;
  IF v_reservation.expires_at <= v_now THEN
    UPDATE public.stripe_lifetime_seat_reservations
    SET status = 'expired',
        release_reason = 'lease_expired',
        released_at = v_now,
        updated_at = v_now
    WHERE id = v_reservation.id
      AND status = 'reserved';
    RETURN pg_catalog.jsonb_build_object('status', 'expired');
  END IF;

  UPDATE public.stripe_lifetime_seat_reservations
  SET status = 'bound',
      checkout_session_id = p_checkout_session_id,
      updated_at = v_now
  WHERE id = v_reservation.id
    AND status = 'reserved'
    AND checkout_session_id IS NULL;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'reservation_lost');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'bound');
END
$function$;

ALTER FUNCTION public.bind_lifetime_membership_reservation_session_atomic(
  uuid, uuid, text, text, timestamptz
) OWNER TO postgres;

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
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_reservation public.stripe_lifetime_seat_reservations%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_reservation_id IS NULL
    OR p_request_nonce IS NULL
    OR p_release_reason NOT IN (
      'stripe_checkout_create_failed',
      'stripe_checkout_abandoned',
      'stripe_checkout_session_expired'
    )
    OR (
      p_release_reason IN (
        'stripe_checkout_create_failed',
        'stripe_checkout_abandoned'
      )
      AND (
        p_checkout_session_id IS NOT NULL
        OR p_event_id IS NOT NULL
        OR p_event_created_at IS NOT NULL
      )
    )
    OR (
      p_release_reason = 'stripe_checkout_session_expired'
      AND (
        pg_catalog.left(COALESCE(p_checkout_session_id, ''), 3) <> 'cs_'
        OR pg_catalog.left(COALESCE(p_event_id, ''), 4) <> 'evt_'
        OR p_event_created_at IS NULL
        OR p_event_created_at
          > pg_catalog.statement_timestamp()
            + pg_catalog.make_interval(mins => 5)
      )
    )
  THEN
    RAISE EXCEPTION 'lifetime reservation release is invalid'
      USING ERRCODE = '22023';
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
  -- A deleted owner must not trap a bound seat forever. Lock the profile when
  -- it still exists, but exact reservation identity remains independently
  -- durable and is sufficient for a verified Checkout expiration.
  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  SELECT reservation.*
  INTO v_reservation
  FROM public.stripe_lifetime_seat_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_reservation.user_id IS DISTINCT FROM p_user_id
    OR v_reservation.request_nonce IS DISTINCT FROM p_request_nonce
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  IF v_reservation.status = 'converted' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_converted');
  END IF;
  IF v_reservation.status IN ('released', 'expired') THEN
    IF v_reservation.status = 'released'
      AND (
        v_reservation.release_reason IS DISTINCT FROM p_release_reason
        OR v_reservation.checkout_session_id
          IS DISTINCT FROM p_checkout_session_id
        OR v_reservation.release_event_id IS DISTINCT FROM p_event_id
        OR v_reservation.release_event_created_at
          IS DISTINCT FROM p_event_created_at
      )
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'already_' || v_reservation.status
    );
  END IF;
  IF (
      v_reservation.status = 'reserved'
      AND p_release_reason NOT IN (
        'stripe_checkout_create_failed',
        'stripe_checkout_abandoned'
      )
    )
    OR (
      v_reservation.status = 'bound'
      AND (
        p_release_reason IS DISTINCT FROM
          'stripe_checkout_session_expired'
        OR v_reservation.checkout_session_id
          IS DISTINCT FROM p_checkout_session_id
        OR p_event_created_at < v_reservation.checkout_expires_at
      )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'release_not_verified');
  END IF;

  UPDATE public.stripe_lifetime_seat_reservations
  SET status = 'released',
      release_reason = p_release_reason,
      release_event_id = p_event_id,
      release_event_created_at = p_event_created_at,
      released_at = v_now,
      updated_at = v_now
  WHERE id = v_reservation.id
    AND status IN ('reserved', 'bound');
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'reservation_lost');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'released');
END
$function$;

ALTER FUNCTION public.release_lifetime_membership_reservation_atomic(
  uuid, uuid, text, text, text, text, timestamptz
) OWNER TO postgres;

-- Rolling deploy compatibility: old application instances still call these
-- signatures until the app cutover. Preserve their OIDs, but fail the legacy
-- pre-check closed so no old instance can create a new identity-poor paid
-- Checkout Session after this migration. The reservation-aware app does not
-- call this function.
CREATE OR REPLACE FUNCTION public.check_lifetime_spots_available(
  max_spots integer DEFAULT 200
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF max_spots IS NULL OR max_spots NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'lifetime capacity is invalid' USING ERRCODE = '22023';
  END IF;

  RETURN false;
END
$function$;

ALTER FUNCTION public.check_lifetime_spots_available(integer)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.activate_lifetime_membership(
  p_user_id uuid,
  p_stripe_customer_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_subscription_id uuid;
  v_subscription public.subscriptions%ROWTYPE;
  v_had_exact_legacy boolean := false;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR pg_catalog.left(COALESCE(p_stripe_customer_id, ''), 4) <> 'cus_'
  THEN
    RAISE EXCEPTION 'legacy lifetime identity is invalid'
      USING ERRCODE = '22023';
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

  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active user profile not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_lifetime_seat_reservations AS reservation
    WHERE reservation.user_id = p_user_id
      AND reservation.status IN ('reserved', 'bound')
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'legacy_lifetime',
      'user:' || p_user_id::text,
      p_user_id,
      'legacy_lifetime_reservation_conflict',
      'A legacy lifetime activation raced an identity-complete reservation.',
      pg_catalog.jsonb_build_object(
        'stripe_customer_id', p_stripe_customer_id,
        'action_required', 'verify_payment_and_refund_or_reconcile'
      )
    );
    RETURN;
  END IF;

  IF EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      WHERE payment.user_id = p_user_id
        AND payment.payment_kind = 'lifetime'
        AND NOT (
          payment.refund_state = 'succeeded'
          AND payment.refund_succeeded_amount >= payment.amount_paid
        )
    )
  THEN
    RETURN;
  END IF;

  SELECT subscription.*
  INTO v_subscription
  FROM public.subscriptions AS subscription
  WHERE subscription.user_id = p_user_id
    AND subscription.status = 'active'
    AND subscription.tier = 'pro'
    AND subscription.plan = 'lifetime'
    AND subscription.entitlement_payment_id IS NULL
  FOR UPDATE;

  IF FOUND THEN
    v_subscription_id := v_subscription.id;
    IF v_subscription.stripe_customer_id
        IS DISTINCT FROM p_stripe_customer_id
    THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'legacy_lifetime',
        'subscription:' || v_subscription_id::text,
        p_user_id,
        'legacy_lifetime_customer_identity_conflict',
        'A legacy activation customer conflicted with the current lifetime row.',
        pg_catalog.jsonb_build_object(
          'requested_customer_id', p_stripe_customer_id,
          'subscription_customer_id', v_subscription.stripe_customer_id
        )
      );
      RETURN;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM public.pro_entitlement_grants AS entitlement_grant
      WHERE entitlement_grant.user_id = p_user_id
        AND entitlement_grant.source = 'legacy_stripe_snapshot'
        AND entitlement_grant.source_key =
          'subscription:' || v_subscription_id::text
        AND entitlement_grant.revoked_at IS NULL
        AND entitlement_grant.expires_at IS NULL
        AND entitlement_grant.metadata ->> 'subscription_id' =
          v_subscription_id::text
        AND entitlement_grant.metadata ->> 'stripe_subscription_id' =
          v_subscription.stripe_subscription_id
        AND entitlement_grant.metadata ->> 'plan' = 'lifetime'
        AND entitlement_grant.metadata ->> 'migration' =
          '20260718183000'
    ) INTO v_had_exact_legacy;

    INSERT INTO public.stripe_legacy_lifetime_seat_claims (
      user_id,
      legacy_subscription_id,
      stripe_customer_id,
      stripe_subscription_id,
      status
    ) VALUES (
      p_user_id,
      v_subscription_id,
      v_subscription.stripe_customer_id,
      v_subscription.stripe_subscription_id,
      'claimed'
    )
    ON CONFLICT DO NOTHING;

    IF NOT EXISTS (
      SELECT 1
      FROM public.stripe_legacy_lifetime_seat_claims AS legacy_claim
      WHERE legacy_claim.user_id = p_user_id
        AND legacy_claim.legacy_subscription_id = v_subscription_id
        AND legacy_claim.stripe_customer_id =
          v_subscription.stripe_customer_id
        AND legacy_claim.stripe_subscription_id =
          v_subscription.stripe_subscription_id
        AND legacy_claim.status = 'claimed'
    ) THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'legacy_lifetime',
        'subscription:' || v_subscription_id::text,
        p_user_id,
        'legacy_lifetime_seat_claim_identity_conflict',
        'A legacy lifetime subscription conflicted with its durable seat claim.',
        pg_catalog.jsonb_build_object(
          'stripe_customer_id', p_stripe_customer_id,
          'action_required', 'verify_legacy_payment_and_seat_claim'
        )
      );
      RETURN;
    END IF;

    INSERT INTO public.pro_entitlement_grants (
      user_id,
      source,
      source_key,
      starts_at,
      expires_at,
      metadata
    ) VALUES (
      p_user_id,
      'legacy_stripe_snapshot',
      'subscription:' || v_subscription_id::text,
      v_now,
      NULL,
      pg_catalog.jsonb_build_object(
        'subscription_id', v_subscription_id,
        'stripe_subscription_id',
          v_subscription.stripe_subscription_id,
        'plan', 'lifetime',
        'migration', '20260718183000_rolling_legacy_writer'
      )
    )
    ON CONFLICT (source, source_key) DO NOTHING;
    IF NOT v_had_exact_legacy THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'legacy_lifetime',
        'subscription:' || v_subscription_id::text,
        p_user_id,
        'legacy_lifetime_requires_exact_reconciliation',
        'A rolling legacy lifetime activation lacks immutable payment identity.',
        pg_catalog.jsonb_build_object(
          'stripe_customer_id', p_stripe_customer_id,
          'action_required', 'bind_exact_payment_or_verify_and_refund'
        )
      );
    END IF;
    PERFORM public.sync_current_pro_projection_atomic(p_user_id);
    RETURN;
  END IF;

  IF public.stripe_lifetime_claimed_seat_count_v2() >= 200 THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'legacy_lifetime',
      'user:' || p_user_id::text,
      p_user_id,
      'legacy_lifetime_sold_out_paid_review',
      'A legacy lifetime activation arrived after all 200 seats were claimed.',
      pg_catalog.jsonb_build_object(
        'stripe_customer_id', p_stripe_customer_id,
        'action_required', 'verify_payment_and_refund'
      )
    );
    RETURN;
  END IF;

  INSERT INTO public.subscriptions (
    user_id,
    stripe_customer_id,
    stripe_subscription_id,
    status,
    tier,
    plan,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    updated_at
  ) VALUES (
    p_user_id,
    p_stripe_customer_id,
    'lifetime_' || p_user_id::text,
    'active',
    'pro',
    'lifetime',
    v_now,
    NULL,
    false,
    v_now
  )
  ON CONFLICT (user_id) DO UPDATE
  SET stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      status = EXCLUDED.status,
      tier = EXCLUDED.tier,
      plan = EXCLUDED.plan,
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = NULL,
      cancel_at_period_end = false,
      canceled_at = NULL,
      entitlement_payment_id = NULL,
      entitlement_trial_id = NULL,
      entitlement_trial_verified_at = NULL,
      updated_at = v_now
  RETURNING id INTO v_subscription_id;

  INSERT INTO public.stripe_legacy_lifetime_seat_claims (
    user_id,
    legacy_subscription_id,
    stripe_customer_id,
    stripe_subscription_id,
    status
  ) VALUES (
    p_user_id,
    v_subscription_id,
    p_stripe_customer_id,
    'lifetime_' || p_user_id::text,
    'claimed'
  )
  ON CONFLICT DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.stripe_legacy_lifetime_seat_claims AS legacy_claim
    WHERE legacy_claim.user_id = p_user_id
      AND legacy_claim.legacy_subscription_id = v_subscription_id
      AND legacy_claim.stripe_customer_id = p_stripe_customer_id
      AND legacy_claim.stripe_subscription_id =
        'lifetime_' || p_user_id::text
      AND legacy_claim.status = 'claimed'
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'legacy_lifetime',
      'subscription:' || v_subscription_id::text,
      p_user_id,
      'legacy_lifetime_seat_claim_identity_conflict',
      'A legacy lifetime subscription conflicted with its durable seat claim.',
      pg_catalog.jsonb_build_object(
        'stripe_customer_id', p_stripe_customer_id,
        'action_required', 'verify_legacy_payment_and_seat_claim'
      )
    );
    RETURN;
  END IF;

  INSERT INTO public.pro_entitlement_grants (
    user_id,
    source,
    source_key,
    starts_at,
    expires_at,
    metadata
  ) VALUES (
    p_user_id,
    'legacy_stripe_snapshot',
    'subscription:' || v_subscription_id::text,
    v_now,
    NULL,
    pg_catalog.jsonb_build_object(
      'subscription_id', v_subscription_id,
      'stripe_subscription_id', 'lifetime_' || p_user_id::text,
      'plan', 'lifetime',
      'migration', '20260718183000_rolling_legacy_writer'
    )
  )
  ON CONFLICT (source, source_key) DO NOTHING;

  PERFORM public.record_stripe_manual_review_atomic(
    'legacy_lifetime',
    'subscription:' || v_subscription_id::text,
    p_user_id,
    'legacy_lifetime_requires_exact_reconciliation',
    'A rolling legacy lifetime activation lacks immutable payment identity.',
    pg_catalog.jsonb_build_object(
      'stripe_customer_id', p_stripe_customer_id,
      'action_required', 'bind_exact_payment_or_verify_and_refund'
    )
  );
  PERFORM public.sync_current_pro_projection_atomic(p_user_id);
END
$function$;

ALTER FUNCTION public.activate_lifetime_membership(uuid, text)
  OWNER TO postgres;

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

CREATE OR REPLACE FUNCTION public.stripe_legacy_snapshot_grant_is_exact_v2(
  p_grant_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_grant_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.pro_entitlement_grants AS entitlement_grant
      JOIN public.subscriptions AS subscription
        ON entitlement_grant.user_id = subscription.user_id
       AND entitlement_grant.source_key =
         'subscription:' || subscription.id::text
      WHERE entitlement_grant.id = p_grant_id
        AND entitlement_grant.source = 'legacy_stripe_snapshot'
        AND entitlement_grant.revoked_at IS NULL
        AND subscription.entitlement_payment_id IS NULL
        AND subscription.entitlement_trial_id IS NULL
        AND subscription.status = 'active'
        AND subscription.tier = 'pro'
        AND subscription.plan IN ('monthly', 'yearly', 'lifetime')
        AND subscription.stripe_customer_id IS NOT NULL
        AND subscription.stripe_subscription_id IS NOT NULL
        AND (
          subscription.current_period_start IS NULL
          OR entitlement_grant.starts_at =
            subscription.current_period_start
          OR entitlement_grant.metadata ->> 'migration' =
            '20260718183000_rolling_legacy_writer'
        )
        AND entitlement_grant.expires_at IS NOT DISTINCT FROM
          CASE
            WHEN subscription.plan = 'lifetime' THEN NULL
            ELSE subscription.current_period_end
          END
        AND entitlement_grant.metadata ->> 'subscription_id' =
          subscription.id::text
        AND entitlement_grant.metadata ->> 'stripe_subscription_id' =
          subscription.stripe_subscription_id
        AND entitlement_grant.metadata ->> 'plan' = subscription.plan
        AND entitlement_grant.metadata ->> 'migration' IN (
          '20260718183000',
          '20260718183000_rolling_legacy_writer'
        )
        AND (
          subscription.plan <> 'lifetime'
          OR EXISTS (
            SELECT 1
            FROM public.stripe_legacy_lifetime_seat_claims AS legacy_claim
            WHERE legacy_claim.user_id = subscription.user_id
              AND legacy_claim.legacy_subscription_id = subscription.id
              AND legacy_claim.stripe_customer_id =
                subscription.stripe_customer_id
              AND legacy_claim.stripe_subscription_id =
                subscription.stripe_subscription_id
              AND legacy_claim.status = 'claimed'
          )
        )
    )
$function$;

ALTER FUNCTION public.stripe_legacy_snapshot_grant_is_exact_v2(uuid)
  OWNER TO postgres;

-- Keep the canonical has_current_global_pro_entitlement contract untouched
-- during the additive deploy. Old application instances still write the
-- historical projection shape until the application cutover is complete.
-- New Stripe authority RPCs use this owner-only v2 predicate instead.
CREATE OR REPLACE FUNCTION public.stripe_has_current_pro_authority_v2(
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_actor_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.user_profiles AS active_profile
      WHERE active_profile.id = p_actor_id
        AND active_profile.deleted_at IS NULL
        AND active_profile.banned_at IS NULL
        AND NOT (
          COALESCE(active_profile.is_banned, false)
          AND (
            active_profile.ban_expires_at IS NULL
            OR active_profile.ban_expires_at
              > pg_catalog.statement_timestamp()
          )
        )
    )
    AND (
      EXISTS (
        SELECT 1
        FROM public.subscriptions AS subscription
        WHERE subscription.user_id = p_actor_id
          AND subscription.status IN ('active', 'trialing')
          AND subscription.tier = 'pro'
          AND (
            subscription.current_period_end IS NULL
            OR subscription.current_period_end
              > pg_catalog.statement_timestamp()
          )
          AND (
            (
              subscription.entitlement_payment_id IS NOT NULL
              AND public.stripe_subscription_has_exact_payment_binding_v2(
                p_actor_id
              )
            )
            OR (
              subscription.entitlement_payment_id IS NULL
              AND public.stripe_subscription_has_exact_trial_binding_v2(
                p_actor_id
              )
            )
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.pro_entitlement_grants AS entitlement_grant
        WHERE entitlement_grant.user_id = p_actor_id
          AND entitlement_grant.revoked_at IS NULL
          AND entitlement_grant.starts_at
            <= pg_catalog.statement_timestamp()
          AND (
            entitlement_grant.expires_at IS NULL
            OR entitlement_grant.expires_at
              > pg_catalog.statement_timestamp()
          )
      )
    )
$function$;

ALTER FUNCTION public.stripe_has_current_pro_authority_v2(uuid)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.sync_current_pro_projection_atomic(
  p_user_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_subscription public.subscriptions%ROWTYPE;
  v_has_subscription boolean := false;
  v_has_grant boolean := false;
  v_has_lifetime_grant boolean := false;
  v_grant_expires_at timestamptz;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'projection user is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_user_id::text,
      0
    )
  );

  -- Every entitlement writer takes locks in the same order. In particular,
  -- lock the profile before child rows so an auth.users cascade cannot form a
  -- profile -> grant/payment versus grant/payment -> profile deadlock.
  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active entitlement owner is missing'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT subscription.*
  INTO v_subscription
  FROM public.subscriptions AS subscription
  WHERE subscription.user_id = p_user_id
    AND subscription.status IN ('active', 'trialing')
    AND subscription.tier = 'pro'
    AND (
      subscription.current_period_end IS NULL
      OR subscription.current_period_end > v_now
    )
    AND (
      (
        subscription.entitlement_payment_id IS NOT NULL
        AND public.stripe_subscription_has_exact_payment_binding_v2(
          p_user_id
        )
      )
      OR (
        subscription.entitlement_payment_id IS NULL
        AND public.stripe_subscription_has_exact_trial_binding_v2(
          p_user_id
        )
      )
    )
  FOR UPDATE;
  v_has_subscription := FOUND;

  SELECT
    pg_catalog.count(*) > 0,
    COALESCE(
      pg_catalog.bool_or(
        entitlement_grant.source = 'stripe_lifetime_payment'
        OR (
          entitlement_grant.source = 'legacy_stripe_snapshot'
          AND entitlement_grant.metadata ->> 'plan' = 'lifetime'
        )
      ),
      false
    ),
    CASE
      WHEN pg_catalog.count(*) FILTER (
        WHERE entitlement_grant.expires_at IS NULL
      ) > 0
      THEN NULL
      ELSE pg_catalog.max(entitlement_grant.expires_at)
    END
  INTO v_has_grant, v_has_lifetime_grant, v_grant_expires_at
  FROM public.pro_entitlement_grants AS entitlement_grant
  WHERE entitlement_grant.user_id = p_user_id
    AND entitlement_grant.revoked_at IS NULL
    AND entitlement_grant.starts_at <= v_now
    AND (
      entitlement_grant.expires_at IS NULL
      OR entitlement_grant.expires_at > v_now
    );

  -- During PREDEPLOY an unsupported legacy Stripe projection retains its old
  -- canonical access but has deliberately no v2 authority. Preserve that
  -- projection until the durable review is resolved; exact payment/trial/grant
  -- authority, once established, takes precedence and may be projected.
  IF NOT v_has_subscription
    AND NOT v_has_grant
    AND EXISTS (
      SELECT 1
      FROM public.stripe_manual_reviews AS review
      WHERE review.state = 'open'
        AND (
          (
            review.object_type = 'profile'
            AND review.object_id = p_user_id::text
            AND review.user_id = p_user_id
            AND review.reason_key =
              'ambiguous_legacy_pro_projection'
          )
          OR (
            review.object_type = 'subscription'
            AND review.user_id = p_user_id
            AND review.reason_key =
              'unsupported_legacy_stripe_projection'
            AND EXISTS (
              SELECT 1
              FROM public.subscriptions AS quarantined_subscription
              WHERE quarantined_subscription.id::text =
                  review.object_id
                AND quarantined_subscription.user_id = p_user_id
            )
          )
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
          WHEN v_subscription.current_period_end IS NULL
            OR (
              v_has_grant
              AND v_grant_expires_at IS NULL
            )
          THEN NULL
          ELSE GREATEST(
            v_subscription.current_period_end,
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
        -- A refunded current lifetime payment may leave another independently
        -- paid lifetime grant as authority. Preserve the customer-facing plan
        -- projection instead of presenting permanent authority as plan-less.
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

CREATE OR REPLACE FUNCTION public.reconcile_due_pro_entitlement_projections_atomic(
  p_limit integer,
  p_after_user_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_user_id uuid;
  v_last_user_id uuid;
  v_processed integer := 0;
  v_authority_count integer := 0;
  v_was_pro boolean;
  v_has_authority boolean;
  v_has_more boolean := false;
  v_boundary_at timestamptz;
  v_leave_ack jsonb;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'projection reconciliation limit is invalid'
      USING ERRCODE = '22023';
  END IF;

  FOR v_user_id IN
    SELECT profile.id
    FROM public.user_profiles AS profile
    WHERE profile.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.stripe_manual_reviews AS review
        WHERE review.user_id = profile.id
          AND review.state = 'open'
          AND review.reason_key IN (
            'unsupported_legacy_stripe_projection',
            'ambiguous_legacy_pro_projection'
          )
      )
      -- A narrow "due" predicate can miss plan/customer/expiry drift while
      -- is_pro remains true. Page every non-quarantined active profile so one
      -- complete cursor sweep converges the exact six-field projection.
      AND (
        p_after_user_id IS NULL
        OR profile.id > p_after_user_id
      )
    ORDER BY profile.id
    LIMIT p_limit
  LOOP
    SELECT COALESCE(profile.is_pro, false)
    INTO v_was_pro
    FROM public.user_profiles AS profile
    WHERE profile.id = v_user_id;

    v_has_authority :=
      public.sync_current_pro_projection_atomic(v_user_id);
    IF v_has_authority THEN
      v_authority_count := v_authority_count + 1;
    END IF;

    IF v_was_pro AND NOT v_has_authority THEN
      v_leave_ack := public.leave_pro_official_group_atomic(v_user_id);
      IF v_leave_ack ->> 'status' NOT IN ('left', 'not_member') THEN
        RAISE EXCEPTION
          'atomic official-group leave returned invalid status';
      END IF;
    ELSIF NOT v_was_pro AND v_has_authority THEN
      SELECT pg_catalog.max(boundary.boundary_at)
      INTO v_boundary_at
      FROM (
        SELECT entitlement_grant.starts_at AS boundary_at
        FROM public.pro_entitlement_grants AS entitlement_grant
        WHERE entitlement_grant.user_id = v_user_id
          AND entitlement_grant.revoked_at IS NULL
          AND entitlement_grant.starts_at <= v_now
          AND (
            entitlement_grant.expires_at IS NULL
            OR entitlement_grant.expires_at > v_now
          )
        UNION ALL
        SELECT subscription.current_period_start
        FROM public.subscriptions AS subscription
        WHERE subscription.user_id = v_user_id
          AND subscription.status IN ('active', 'trialing')
          AND subscription.tier = 'pro'
          AND (
            subscription.current_period_end IS NULL
            OR subscription.current_period_end > v_now
          )
      ) AS boundary;

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
        v_user_id,
        'projection',
        v_user_id::text,
        'authority_started:'
          || COALESCE(v_boundary_at, v_now)::text,
        'pro_official_group_join',
        pg_catalog.jsonb_build_object(
          'boundary_at', COALESCE(v_boundary_at, v_now)
        )
      )
      ON CONFLICT (
        source_kind,
        source_key,
        effect_type,
        operation_key
      ) DO NOTHING;
    END IF;

    v_processed := v_processed + 1;
    v_last_user_id := v_user_id;
  END LOOP;

  IF v_last_user_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.stripe_manual_reviews AS review
          WHERE review.user_id = profile.id
            AND review.state = 'open'
            AND review.reason_key IN (
              'unsupported_legacy_stripe_projection',
              'ambiguous_legacy_pro_projection'
            )
        )
        AND profile.id > v_last_user_id
    ) INTO v_has_more;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'reconciled',
    'processed_count', v_processed,
    'authority_count', v_authority_count,
    'next_cursor', v_last_user_id,
    'has_more', v_has_more
  );
END
$function$;

ALTER FUNCTION public.reconcile_due_pro_entitlement_projections_atomic(
  integer, uuid
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.upsert_pro_entitlement_grant_atomic(
  p_user_id uuid,
  p_source text,
  p_source_key text,
  p_starts_at timestamptz,
  p_expires_at timestamptz,
  p_metadata jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_grant public.pro_entitlement_grants%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_source IS NULL
    OR p_source IS DISTINCT FROM 'referral'
    OR p_source_key IS NULL
    OR pg_catalog.length(pg_catalog.btrim(p_source_key)) NOT BETWEEN 1 AND 255
    OR p_starts_at IS NULL
    OR (p_expires_at IS NOT NULL AND p_expires_at <= p_starts_at)
    OR p_metadata IS NULL
    OR pg_catalog.jsonb_typeof(p_metadata) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'grant identity is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_user_id::text,
      0
    )
  );

  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active grant owner is missing'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT entitlement_grant.*
  INTO v_grant
  FROM public.pro_entitlement_grants AS entitlement_grant
  WHERE entitlement_grant.source = p_source
    AND entitlement_grant.source_key = p_source_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_grant.user_id IS DISTINCT FROM p_user_id THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'grant',
        p_source || ':' || p_source_key,
        v_grant.user_id,
        'grant_identity_conflict',
        'A stable grant source key was replayed for another user.',
        pg_catalog.jsonb_build_object(
          'existing_user_id', v_grant.user_id,
          'requested_user_id', p_user_id
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    IF v_grant.grant_kind IS DISTINCT FROM 'absolute' THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'grant',
        p_source || ':' || p_source_key,
        v_grant.user_id,
        'grant_identity_conflict',
        'A stable days-grant key was replayed through the absolute grant RPC.',
        pg_catalog.jsonb_build_object(
          'existing_grant_kind', v_grant.grant_kind,
          'requested_grant_kind', 'absolute'
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    IF v_grant.revoked_at IS NOT NULL THEN
      RETURN pg_catalog.jsonb_build_object('status', 'revoked_grant');
    END IF;
    IF v_grant.starts_at IS NOT DISTINCT FROM p_starts_at
      AND v_grant.expires_at IS NOT DISTINCT FROM p_expires_at
      AND v_grant.metadata IS NOT DISTINCT FROM p_metadata
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'already_granted');
    END IF;
    IF v_grant.expires_at IS NULL
      OR (
        p_expires_at IS NOT NULL
        AND p_expires_at <= v_grant.expires_at
      )
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'stale_grant');
    END IF;

    UPDATE public.pro_entitlement_grants
    SET starts_at = LEAST(starts_at, p_starts_at),
        expires_at = p_expires_at,
        metadata = p_metadata,
        updated_at = v_now
    WHERE id = v_grant.id;
    PERFORM public.sync_current_pro_projection_atomic(p_user_id);
    RETURN pg_catalog.jsonb_build_object('status', 'extended');
  END IF;

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
    p_source,
    p_source_key,
    p_starts_at,
    p_expires_at,
    p_metadata,
    v_now
  );
  PERFORM public.sync_current_pro_projection_atomic(p_user_id);
  RETURN pg_catalog.jsonb_build_object('status', 'granted');
END
$function$;

ALTER FUNCTION public.upsert_pro_entitlement_grant_atomic(
  uuid, text, text, timestamptz, timestamptz, jsonb
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.grant_pro_entitlement_days_atomic(
  p_user_id uuid,
  p_source text,
  p_source_key text,
  p_days integer,
  p_granted_at timestamptz,
  p_metadata jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_grant public.pro_entitlement_grants%ROWTYPE;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_effective_granted_at timestamptz;
  v_payment_period_end timestamptz;
  v_finite_grant_end timestamptz;
  v_base timestamptz;
  v_expires_at timestamptz;
  v_review_object_id text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_source IS NULL
    OR p_source IS DISTINCT FROM 'referral'
    OR p_source_key IS NULL
    OR pg_catalog.length(pg_catalog.btrim(p_source_key)) NOT BETWEEN 1 AND 255
    OR p_days IS NULL
    OR p_days NOT BETWEEN 1 AND 3650
    OR p_granted_at IS NULL
    OR p_granted_at > pg_catalog.statement_timestamp()
      + pg_catalog.make_interval(mins => 5)
    OR p_metadata IS NULL
    OR pg_catalog.jsonb_typeof(p_metadata) IS DISTINCT FROM 'object'
  THEN
    RAISE EXCEPTION 'days grant identity is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_user_id::text,
      0
    )
  );

  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active grant owner is missing'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT payment.period_end
  INTO v_payment_period_end
  FROM public.subscriptions AS subscription
  JOIN public.stripe_entitlement_payments AS payment
    ON payment.id = subscription.entitlement_payment_id
   AND payment.user_id = subscription.user_id
  WHERE subscription.user_id = p_user_id
    AND subscription.status IN ('active', 'trialing')
    AND subscription.tier = 'pro'
    AND subscription.plan IN ('monthly', 'yearly')
    AND payment.payment_kind = 'recurring'
    AND payment.period_end = subscription.current_period_end
    AND public.stripe_subscription_has_exact_payment_binding_v2(p_user_id)
    AND NOT (
      payment.refund_state = 'succeeded'
      AND payment.refund_succeeded_amount >= payment.amount_paid
    );

  SELECT entitlement_grant.*
  INTO v_grant
  FROM public.pro_entitlement_grants AS entitlement_grant
  WHERE entitlement_grant.source = p_source
    AND entitlement_grant.source_key = p_source_key
  FOR UPDATE;

  IF FOUND THEN
    IF v_grant.user_id IS NOT DISTINCT FROM p_user_id
      AND v_grant.grant_kind = 'days'
      AND v_grant.granted_days IS NOT DISTINCT FROM p_days
      AND v_grant.granted_at IS NOT DISTINCT FROM p_granted_at
      AND v_grant.metadata IS NOT DISTINCT FROM p_metadata
    THEN
      IF v_grant.revoked_at IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('status', 'revoked_grant');
      END IF;
      RETURN pg_catalog.jsonb_build_object('status', 'already_granted');
    END IF;

    v_review_object_id :=
      p_source || ':' || pg_catalog.left(p_source_key, 140) || ':'
      || pg_catalog.md5(p_source_key);
    PERFORM public.record_stripe_manual_review_atomic(
      'grant',
      v_review_object_id,
      v_grant.user_id,
      'grant_days_identity_conflict',
      'A stable days-grant key was replayed with different identity.',
      pg_catalog.jsonb_build_object(
        'source', p_source,
        'source_key', p_source_key,
        'existing_user_id', v_grant.user_id,
        'requested_user_id', p_user_id,
        'existing_grant_kind', v_grant.grant_kind,
        'existing_days', v_grant.granted_days,
        'requested_days', p_days,
        'existing_granted_at', v_grant.granted_at,
        'requested_granted_at', p_granted_at,
        'existing_metadata', v_grant.metadata,
        'requested_metadata', p_metadata
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  v_effective_granted_at := GREATEST(p_granted_at, v_now);

  SELECT pg_catalog.max(entitlement_grant.expires_at)
  INTO v_finite_grant_end
  FROM public.pro_entitlement_grants AS entitlement_grant
  WHERE entitlement_grant.user_id = p_user_id
    AND entitlement_grant.revoked_at IS NULL
    AND entitlement_grant.expires_at IS NOT NULL
    AND entitlement_grant.starts_at <= v_effective_granted_at
    AND entitlement_grant.expires_at > v_effective_granted_at;

  v_base := GREATEST(
    v_effective_granted_at,
    COALESCE(v_payment_period_end, v_effective_granted_at),
    COALESCE(v_finite_grant_end, v_effective_granted_at)
  );
  v_expires_at :=
    v_base + pg_catalog.make_interval(days => p_days);

  INSERT INTO public.pro_entitlement_grants (
    user_id,
    source,
    source_key,
    starts_at,
    expires_at,
    grant_kind,
    granted_days,
    granted_at,
    metadata,
    updated_at
  ) VALUES (
    p_user_id,
    p_source,
    p_source_key,
    v_base,
    v_expires_at,
    'days',
    p_days,
    p_granted_at,
    p_metadata,
    pg_catalog.clock_timestamp()
  );

  PERFORM public.sync_current_pro_projection_atomic(p_user_id);
  RETURN pg_catalog.jsonb_build_object('status', 'granted');
END
$function$;

ALTER FUNCTION public.grant_pro_entitlement_days_atomic(
  uuid, text, text, integer, timestamptz, jsonb
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.revoke_pro_entitlement_grant_atomic(
  p_user_id uuid,
  p_source text,
  p_source_key text,
  p_revoked_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_grant public.pro_entitlement_grants%ROWTYPE;
  v_has_authority boolean;
  v_leave_ack jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_source IS NULL
    OR p_source IS DISTINCT FROM 'referral'
    OR p_source_key IS NULL
    OR p_revoked_at IS NULL
  THEN
    RAISE EXCEPTION 'grant revocation identity is required'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_user_id::text,
      0
    )
  );

  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active grant owner is missing'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT entitlement_grant.*
  INTO v_grant
  FROM public.pro_entitlement_grants AS entitlement_grant
  WHERE entitlement_grant.source = p_source
    AND entitlement_grant.source_key = p_source_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_grant.user_id IS DISTINCT FROM p_user_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  IF v_grant.revoked_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_revoked');
  END IF;

  UPDATE public.pro_entitlement_grants
  SET revoked_at = p_revoked_at,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_grant.id;

  v_has_authority := public.sync_current_pro_projection_atomic(p_user_id);
  IF v_has_authority THEN
    RETURN pg_catalog.jsonb_build_object('status', 'entitlement_preserved');
  END IF;

  v_leave_ack := public.leave_pro_official_group_atomic(p_user_id);
  IF v_leave_ack ->> 'status' NOT IN ('left', 'not_member') THEN
    RAISE EXCEPTION 'atomic official-group leave returned invalid status';
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'revoked');
END
$function$;

ALTER FUNCTION public.revoke_pro_entitlement_grant_atomic(
  uuid, text, text, timestamptz
) OWNER TO postgres;

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
  p_stripe_subscription_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_payment_id uuid;
  v_match_ids uuid[];
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_current_payment public.stripe_entitlement_payments%ROWTYPE;
  v_identity_user_id uuid;
  v_profile_exists boolean := false;
  v_subject_active boolean := false;
  v_audit_user_id uuid;
  v_tombstone_merge jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR pg_catalog.left(COALESCE(p_stripe_customer_id, ''), 4) <> 'cus_'
    OR pg_catalog.left(COALESCE(p_stripe_subscription_id, ''), 4) <> 'sub_'
    OR pg_catalog.left(COALESCE(p_stripe_invoice_id, ''), 3) <> 'in_'
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND pg_catalog.left(p_stripe_payment_intent_id, 3) <> 'pi_'
    )
    OR pg_catalog.left(COALESCE(p_stripe_charge_id, ''), 3) <> 'ch_'
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_amount_paid IS NULL
    OR p_amount_paid <= 0
    OR p_currency IS NULL
    OR p_currency !~ '^[a-z]{3}$'
    OR p_period_start IS NULL
    OR p_period_end IS NULL
    OR p_period_end <= p_period_start
    OR p_stripe_subscription_status NOT IN (
      'active',
      'trialing',
      'past_due',
      'canceled',
      'unpaid',
      'incomplete',
      'incomplete_expired',
      'paused'
    )
  THEN
    RAISE EXCEPTION 'recurring payment identity is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF p_payment_status NOT IN ('paid', 'succeeded') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'stripe_status_not_entitling'
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
      'stripe-charge-refund:' || p_stripe_charge_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_user_id::text,
      0
    )
  );

  SELECT profile.deleted_at IS NULL
  INTO v_subject_active
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  v_profile_exists := FOUND;
  v_subject_active :=
    v_profile_exists AND COALESCE(v_subject_active, false);
  v_audit_user_id :=
    CASE WHEN v_profile_exists THEN p_user_id ELSE NULL END;

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
    v_audit_user_id,
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
  WHERE payment.stripe_payment_intent_id = p_stripe_payment_intent_id
    OR payment.stripe_charge_id = p_stripe_charge_id
    OR payment.stripe_invoice_id = p_stripe_invoice_id;

  IF pg_catalog.cardinality(v_match_ids) IS DISTINCT FROM 1 THEN
    PERFORM public.record_stripe_manual_review_atomic(
      CASE
        WHEN p_stripe_payment_intent_id IS NULL THEN 'charge'
        ELSE 'payment_intent'
      END,
      COALESCE(p_stripe_payment_intent_id, p_stripe_charge_id),
      v_audit_user_id,
      'payment_identity_conflict',
      'Recurring payment identifiers resolve to multiple or no ledger rows.',
      pg_catalog.jsonb_build_object(
        'charge_id', p_stripe_charge_id,
        'invoice_id', p_stripe_invoice_id,
        'match_count', COALESCE(pg_catalog.cardinality(v_match_ids), 0)
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT payment.*
  INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.id = v_match_ids[1]
  FOR UPDATE;

  IF v_payment.user_id IS DISTINCT FROM v_audit_user_id
    OR v_payment.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
    OR v_payment.payment_kind IS DISTINCT FROM 'recurring'
    OR v_payment.plan IS DISTINCT FROM p_plan
    OR v_payment.stripe_subscription_id
      IS DISTINCT FROM p_stripe_subscription_id
    OR v_payment.stripe_invoice_id IS DISTINCT FROM p_stripe_invoice_id
    OR v_payment.stripe_payment_intent_id
      IS DISTINCT FROM p_stripe_payment_intent_id
    OR v_payment.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
    OR v_payment.amount_paid IS DISTINCT FROM p_amount_paid
    OR v_payment.currency IS DISTINCT FROM p_currency
    OR v_payment.period_start IS DISTINCT FROM p_period_start
    OR v_payment.period_end IS DISTINCT FROM p_period_end
    OR v_payment.payment_status IS DISTINCT FROM p_payment_status
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      CASE
        WHEN p_stripe_payment_intent_id IS NULL THEN 'charge'
        ELSE 'payment_intent'
      END,
      COALESCE(p_stripe_payment_intent_id, p_stripe_charge_id),
      v_audit_user_id,
      'payment_identity_conflict',
      'Recurring payment replay changed immutable ledger identity.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'charge_id', p_stripe_charge_id,
        'invoice_id', p_stripe_invoice_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  v_tombstone_merge :=
    public.stripe_merge_charge_refund_tombstone_v2(
      v_payment.id
    );
  IF v_tombstone_merge ->> 'status' IN (
    'identity_conflict',
    'manual_review'
  ) THEN
    RETURN v_tombstone_merge;
  END IF;
  SELECT payment.*
  INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.id = v_match_ids[1]
  FOR UPDATE;

  IF v_payment.refund_state = 'succeeded'
    AND v_payment.refund_succeeded_amount >= v_payment.amount_paid
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'refunded_payment');
  END IF;

  IF NOT v_subject_active THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'invoice',
      p_stripe_invoice_id,
      v_audit_user_id,
      'paid_recurring_subject_deleted',
      'A recurring payment completed after its entitlement owner was deleted.',
      pg_catalog.jsonb_build_object(
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
      v_audit_user_id,
      'payment',
      v_payment.id::text,
      'refund:subject_deleted',
      'payment_auto_refund',
      pg_catalog.jsonb_build_object(
        'reason_key', 'paid_recurring_subject_deleted',
        'invoice_id', p_stripe_invoice_id
      )
    )
    ON CONFLICT (
      source_kind,
      source_key,
      effect_type,
      operation_key
    ) DO NOTHING;
    RETURN pg_catalog.jsonb_build_object('status', 'subject_deleted');
  END IF;

  SELECT profile.id
  INTO v_identity_user_id
  FROM public.user_profiles AS profile
  WHERE profile.stripe_customer_id = p_stripe_customer_id
    AND profile.id IS DISTINCT FROM p_user_id
  FOR UPDATE;
  IF FOUND THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'customer',
      p_stripe_customer_id,
      v_identity_user_id,
      'stripe_customer_identity_conflict',
      'A paid Stripe customer id was replayed for another user.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'requested_user_id', p_user_id,
        'existing_user_id', v_identity_user_id
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
      p_user_id,
      'payment',
      v_payment.id::text,
      'review:stripe_customer_identity_conflict',
      'payment_manual_review',
      pg_catalog.jsonb_build_object(
        'reason_key', 'stripe_customer_identity_conflict'
      )
    )
    ON CONFLICT (
      source_kind,
      source_key,
      effect_type,
      operation_key
    ) DO NOTHING;
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT subscription.user_id
  INTO v_identity_user_id
  FROM public.subscriptions AS subscription
  WHERE subscription.stripe_subscription_id = p_stripe_subscription_id
    AND subscription.user_id IS DISTINCT FROM p_user_id
  FOR UPDATE;
  IF FOUND THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'subscription',
      p_stripe_subscription_id,
      v_identity_user_id,
      'stripe_subscription_identity_conflict',
      'A paid Stripe subscription id was replayed for another user.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'requested_user_id', p_user_id,
        'existing_user_id', v_identity_user_id
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
      p_user_id,
      'payment',
      v_payment.id::text,
      'review:stripe_subscription_identity_conflict',
      'payment_manual_review',
      pg_catalog.jsonb_build_object(
        'reason_key', 'stripe_subscription_identity_conflict'
      )
    )
    ON CONFLICT (
      source_kind,
      source_key,
      effect_type,
      operation_key
    ) DO NOTHING;
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF p_stripe_subscription_status NOT IN ('active', 'trialing') THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'invoice',
      p_stripe_invoice_id,
      p_user_id,
      'paid_recurring_status_not_entitling',
      'A paid recurring invoice arrived with a non-entitling subscription status.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'subscription_status', p_stripe_subscription_status
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
      p_user_id,
      'payment',
      v_payment.id::text,
      'review:paid_recurring_status_not_entitling',
      'payment_manual_review',
      pg_catalog.jsonb_build_object(
        'reason_key', 'paid_recurring_status_not_entitling'
      )
    )
    ON CONFLICT (
      source_kind,
      source_key,
      effect_type,
      operation_key
    ) DO NOTHING;
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'stripe_status_not_entitling'
    );
  END IF;

  SELECT subscription.*
  INTO v_subscription
  FROM public.subscriptions AS subscription
  WHERE subscription.user_id = p_user_id
  FOR UPDATE;

  -- A renewal invoice for the same Stripe subscription may advance the exact
  -- current period. A paid invoice from a different Stripe subscription is a
  -- parallel purchase: ledger it, preserve the current authority, and require
  -- an operator to decide which subscription should remain canonical.
  IF FOUND
    AND v_subscription.status IN ('active', 'trialing')
    AND v_subscription.plan IN ('monthly', 'yearly')
    AND v_subscription.stripe_subscription_id
      IS DISTINCT FROM p_stripe_subscription_id
    AND (
      (
        v_subscription.entitlement_payment_id IS NOT NULL
        AND public.stripe_subscription_has_exact_payment_binding_v2(p_user_id)
      )
      OR (
        v_subscription.entitlement_payment_id IS NULL
        AND public.stripe_subscription_has_exact_trial_binding_v2(p_user_id)
      )
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'invoice',
      p_stripe_invoice_id,
      p_user_id,
      'parallel_recurring_subscription',
      'A paid invoice belongs to a second Stripe subscription while another exact authority is current.',
      pg_catalog.jsonb_build_object(
        'incoming_payment_id', v_payment.id,
        'incoming_subscription_id', p_stripe_subscription_id,
        'current_subscription_id', v_subscription.stripe_subscription_id,
        'current_projection_id', v_subscription.id
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
      p_user_id,
      'payment',
      v_payment.id::text,
      'review:parallel_recurring_subscription',
      'payment_manual_review',
      pg_catalog.jsonb_build_object(
        'reason_key', 'parallel_recurring_subscription'
      )
    )
    ON CONFLICT (
      source_kind,
      source_key,
      effect_type,
      operation_key
    ) DO NOTHING;
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'parallel_subscription_review'
    );
  END IF;

  IF FOUND
    AND v_subscription.entitlement_payment_id = v_payment.id
    AND v_subscription.status IN ('active', 'trialing')
    AND public.stripe_subscription_has_exact_payment_binding_v2(p_user_id)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_activated');
  END IF;

  IF FOUND
    AND v_subscription.status IN ('active', 'trialing')
    AND v_subscription.plan = 'lifetime'
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      p_stripe_charge_id,
      p_user_id,
      'recurring_purchase_conflicts_with_lifetime',
      'A recurring payment succeeded while lifetime authority was current.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'current_subscription_id', v_subscription.id
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
      p_user_id,
      'payment',
      v_payment.id::text,
      'review:recurring_purchase_conflicts_with_lifetime',
      'payment_manual_review',
      pg_catalog.jsonb_build_object(
        'reason_key', 'recurring_purchase_conflicts_with_lifetime'
      )
    )
    ON CONFLICT (
      source_kind,
      source_key,
      effect_type,
      operation_key
    ) DO NOTHING;
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'current_entitlement_protected'
    );
  END IF;

  IF FOUND
    AND v_subscription.entitlement_payment_id IS NOT NULL
    AND v_subscription.entitlement_payment_id IS DISTINCT FROM v_payment.id
  THEN
    SELECT payment.*
    INTO v_current_payment
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.id = v_subscription.entitlement_payment_id
    FOR UPDATE;
    IF FOUND
      AND v_payment.period_start <= v_current_payment.period_start
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'stale_payment');
    END IF;
  ELSIF FOUND
    AND v_subscription.status IN ('active', 'trialing')
    AND v_subscription.current_period_start IS NOT NULL
    AND v_subscription.plan IN ('monthly', 'yearly')
    AND p_period_start < v_subscription.current_period_start
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'stale_payment');
  END IF;

  INSERT INTO public.subscriptions (
    user_id,
    stripe_customer_id,
    stripe_subscription_id,
    status,
    tier,
    plan,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    canceled_at,
    entitlement_payment_id,
    entitlement_trial_id,
    entitlement_trial_verified_at,
    updated_at
  ) VALUES (
    p_user_id,
    p_stripe_customer_id,
    p_stripe_subscription_id,
    p_stripe_subscription_status,
    'pro',
    p_plan,
    p_period_start,
    p_period_end,
    false,
    NULL,
    v_payment.id,
    NULL,
    NULL,
    v_now
  )
  ON CONFLICT (user_id) DO UPDATE
  SET stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      status = EXCLUDED.status,
      tier = EXCLUDED.tier,
      plan = EXCLUDED.plan,
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      cancel_at_period_end = false,
      canceled_at = NULL,
      entitlement_payment_id = EXCLUDED.entitlement_payment_id,
      entitlement_trial_id = NULL,
      entitlement_trial_verified_at = NULL,
      updated_at = v_now;

  UPDATE public.pro_entitlement_grants
  SET revoked_at = COALESCE(revoked_at, v_now),
      metadata = metadata || pg_catalog.jsonb_build_object(
        'episode_closed_at', v_now,
        'episode_close_reason', 'invoice_paid',
        'paid_invoice_id', p_stripe_invoice_id
      ),
      updated_at = v_now
  WHERE user_id = p_user_id
    AND source = 'stripe_payment_retry_grace'
    AND metadata ->> 'stripe_subscription_id' =
      p_stripe_subscription_id
    AND metadata ->> 'episode_closed_at' IS NULL;

  UPDATE public.pro_entitlement_grants
  SET revoked_at = COALESCE(revoked_at, v_now),
      updated_at = v_now
  WHERE user_id = p_user_id
    AND source = 'legacy_stripe_snapshot'
    AND revoked_at IS NULL;

  UPDATE public.stripe_trial_entitlements
  SET revoked_at = COALESCE(revoked_at, v_now),
      revoke_reason = COALESCE(revoke_reason, 'paid_conversion'),
      updated_at = v_now
  WHERE user_id = p_user_id
    AND revoked_at IS NULL;

  PERFORM public.sync_current_pro_projection_atomic(p_user_id);

  INSERT INTO public.stripe_entitlement_effects (
    entitlement_payment_id,
    user_id,
    source_kind,
    source_key,
    operation_key,
    effect_type,
    payload
  ) VALUES
    (
      v_payment.id,
      p_user_id,
      'payment',
      v_payment.id::text,
      'activation',
      'pro_official_group_join',
      pg_catalog.jsonb_build_object('plan', p_plan)
    ),
    (
      v_payment.id,
      p_user_id,
      'payment',
      v_payment.id::text,
      'activation',
      'pro_purchase_alert',
      pg_catalog.jsonb_build_object('plan', p_plan)
    )
  ON CONFLICT (
    source_kind,
    source_key,
    effect_type,
    operation_key
  ) DO NOTHING;

  RETURN pg_catalog.jsonb_build_object('status', 'activated');
END
$function$;

ALTER FUNCTION public.activate_recurring_entitlement_payment_atomic(
  uuid, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, text
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.activate_recurring_trial_entitlement_atomic(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_plan text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_stripe_subscription_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_subscription public.subscriptions%ROWTYPE;
  v_trial public.stripe_trial_entitlements%ROWTYPE;
  v_trial_id uuid;
  v_identity_user_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR pg_catalog.left(COALESCE(p_stripe_customer_id, ''), 4) <> 'cus_'
    OR pg_catalog.left(COALESCE(p_stripe_subscription_id, ''), 4) <> 'sub_'
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_period_start IS NULL
    OR p_period_end IS NULL
    OR p_period_end <= p_period_start
    OR p_stripe_subscription_status IS DISTINCT FROM 'trialing'
  THEN
    RAISE EXCEPTION 'recurring trial identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_user_id::text,
      0
    )
  );

  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active trial owner is missing'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT profile.id
  INTO v_identity_user_id
  FROM public.user_profiles AS profile
  WHERE profile.stripe_customer_id = p_stripe_customer_id
    AND profile.id IS DISTINCT FROM p_user_id
  FOR UPDATE;
  IF FOUND THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'customer',
      p_stripe_customer_id,
      v_identity_user_id,
      'stripe_customer_identity_conflict',
      'A Stripe customer id was replayed for another user.',
      pg_catalog.jsonb_build_object(
        'requested_user_id', p_user_id,
        'existing_user_id', v_identity_user_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT subscription.user_id
  INTO v_identity_user_id
  FROM public.subscriptions AS subscription
  WHERE subscription.stripe_subscription_id = p_stripe_subscription_id
    AND subscription.user_id IS DISTINCT FROM p_user_id
  FOR UPDATE;
  IF FOUND THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'subscription',
      p_stripe_subscription_id,
      v_identity_user_id,
      'trial_subscription_identity_conflict',
      'A Stripe trial subscription was replayed for another user.',
      pg_catalog.jsonb_build_object(
        'requested_user_id', p_user_id,
        'existing_user_id', v_identity_user_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT trial.user_id
  INTO v_identity_user_id
  FROM public.stripe_trial_entitlements AS trial
  WHERE trial.stripe_subscription_id = p_stripe_subscription_id
    AND trial.user_id IS DISTINCT FROM p_user_id
  ORDER BY trial.created_at, trial.id
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'subscription',
      p_stripe_subscription_id,
      v_identity_user_id,
      'trial_subscription_identity_conflict',
      'A verified trial identity was replayed for another user.',
      pg_catalog.jsonb_build_object(
        'requested_user_id', p_user_id,
        'existing_user_id', v_identity_user_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  -- Reject stale or conflicting trial versions before inserting an immutable
  -- snapshot. Stripe commonly extends a trial by retaining period_start and
  -- moving period_end forward; lexicographic start-only checks incorrectly
  -- rejected that legitimate transition and left an unbound version behind.
  SELECT subscription.*
  INTO v_subscription
  FROM public.subscriptions AS subscription
  WHERE subscription.user_id = p_user_id
  FOR UPDATE;

  IF FOUND
    AND v_subscription.entitlement_payment_id IS NOT NULL
    AND v_subscription.status IN ('active', 'trialing')
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'current_entitlement_protected'
    );
  END IF;
  IF FOUND
    AND v_subscription.status = 'trialing'
    AND public.stripe_subscription_has_exact_trial_binding_v2(p_user_id)
  THEN
    IF v_subscription.stripe_customer_id = p_stripe_customer_id
      AND v_subscription.stripe_subscription_id = p_stripe_subscription_id
      AND v_subscription.plan = p_plan
      AND v_subscription.current_period_start = p_period_start
      AND v_subscription.current_period_end = p_period_end
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'already_activated');
    END IF;
    IF v_subscription.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_subscription.stripe_subscription_id
        IS DISTINCT FROM p_stripe_subscription_id
      OR v_subscription.plan IS DISTINCT FROM p_plan
    THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'subscription',
        p_stripe_subscription_id,
        p_user_id,
        'parallel_trial_subscription',
        'A second Stripe trial attempted to replace another exact current trial.',
        pg_catalog.jsonb_build_object(
          'current_subscription_id',
          v_subscription.stripe_subscription_id,
          'requested_subscription_id',
          p_stripe_subscription_id
        )
      );
      RETURN pg_catalog.jsonb_build_object(
        'status',
        'current_entitlement_protected'
      );
    END IF;
    IF NOT (
      p_period_start > v_subscription.current_period_start
      OR (
        p_period_start = v_subscription.current_period_start
        AND p_period_end > v_subscription.current_period_end
      )
    )
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'stale_trial');
    END IF;
  END IF;

  INSERT INTO public.stripe_trial_entitlements (
    user_id,
    stripe_customer_id,
    stripe_subscription_id,
    plan,
    period_start,
    period_end,
    verified_at
  ) VALUES (
    p_user_id,
    p_stripe_customer_id,
    p_stripe_subscription_id,
    p_plan,
    p_period_start,
    p_period_end,
    v_now
  )
  ON CONFLICT (
    stripe_subscription_id,
    period_start,
    period_end
  ) DO NOTHING
  RETURNING id INTO v_trial_id;

  SELECT trial.*
  INTO v_trial
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
    PERFORM public.record_stripe_manual_review_atomic(
      'subscription',
      p_stripe_subscription_id,
      CASE
        WHEN FOUND THEN v_trial.user_id
        ELSE p_user_id
      END,
      'trial_identity_conflict',
      'A verified trial snapshot changed immutable identity.',
      pg_catalog.jsonb_build_object(
        'requested_user_id', p_user_id,
        'requested_plan', p_plan,
        'period_start', p_period_start,
        'period_end', p_period_end
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  IF v_trial.revoked_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'stale_trial');
  END IF;

  UPDATE public.stripe_trial_entitlements
  SET revoked_at = COALESCE(revoked_at, v_now),
      revoke_reason = COALESCE(revoke_reason, 'superseded_trial'),
      updated_at = v_now
  WHERE user_id = p_user_id
    AND id IS DISTINCT FROM v_trial.id
    AND revoked_at IS NULL;

  INSERT INTO public.subscriptions (
    user_id,
    stripe_customer_id,
    stripe_subscription_id,
    status,
    tier,
    plan,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    canceled_at,
    entitlement_payment_id,
    entitlement_trial_id,
    entitlement_trial_verified_at,
    updated_at
  ) VALUES (
    p_user_id,
    p_stripe_customer_id,
    p_stripe_subscription_id,
    'trialing',
    'pro',
    p_plan,
    p_period_start,
    p_period_end,
    false,
    NULL,
    NULL,
    v_trial.id,
    v_trial.verified_at,
    v_now
  )
  ON CONFLICT (user_id) DO UPDATE
  SET stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      status = 'trialing',
      tier = 'pro',
      plan = EXCLUDED.plan,
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = EXCLUDED.current_period_end,
      cancel_at_period_end = false,
      canceled_at = NULL,
      entitlement_payment_id = NULL,
      entitlement_trial_id = v_trial.id,
      entitlement_trial_verified_at = v_trial.verified_at,
      updated_at = v_now;

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
    NULL,
    p_user_id,
    'trial',
    'trial:' || v_trial.id::text,
    'activation',
    'pro_official_group_join',
    pg_catalog.jsonb_build_object(
      'plan', p_plan,
      'period_start', p_period_start,
      'period_end', p_period_end
    )
  )
  ON CONFLICT (
    source_kind,
    source_key,
    effect_type,
    operation_key
  ) DO NOTHING;

  RETURN pg_catalog.jsonb_build_object('status', 'activated');
END
$function$;

ALTER FUNCTION public.activate_recurring_trial_entitlement_atomic(
  uuid, text, text, text, timestamptz, timestamptz, text
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
  p_event_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_inserted_event_id text;
  v_existing_event public.stripe_subscription_state_events%ROWTYPE;
  v_latest_event public.stripe_subscription_state_events%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_trial public.stripe_trial_entitlements%ROWTYPE;
  v_new_trial public.stripe_trial_entitlements%ROWTYPE;
  v_grace public.pro_entitlement_grants%ROWTYPE;
  v_exact_payment boolean := false;
  v_exact_trial boolean := false;
  v_has_latest_event boolean := false;
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
    OR pg_catalog.left(COALESCE(p_stripe_customer_id, ''), 4) <> 'cus_'
    OR pg_catalog.left(COALESCE(p_stripe_subscription_id, ''), 4) <> 'sub_'
    OR (
      p_current_invoice_id IS NOT NULL
      AND pg_catalog.left(p_current_invoice_id, 3) <> 'in_'
    )
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_period_start IS NULL
    OR p_period_end IS NULL
    OR p_period_end <= p_period_start
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
    OR pg_catalog.left(COALESCE(p_event_id, ''), 4) <> 'evt_'
    OR p_event_created_at IS NULL
    OR (
      p_stripe_status = 'past_due'
      AND (
        p_current_invoice_id IS NULL
        OR pg_catalog.left(p_current_invoice_id, 3) <> 'in_'
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
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_user_id::text,
      0
    )
  );

  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active subscription state owner is missing'
      USING ERRCODE = 'P0002';
  END IF;

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
    event_created_at
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
    p_event_created_at
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
      PERFORM public.record_stripe_manual_review_atomic(
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
    AND state_event.event_id IS DISTINCT FROM p_event_id
  ORDER BY state_event.event_created_at DESC, state_event.event_id DESC
  LIMIT 1;
  v_has_latest_event := FOUND;

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
    AND NOT (
      p_stripe_status IN (
        'past_due',
        'canceled',
        'unpaid',
        'incomplete',
        'incomplete_expired',
        'paused'
      )
      AND v_latest_event.stripe_status IN ('active', 'trialing')
    )
  THEN
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'manual_review'
    WHERE event_id = p_event_id;
    PERFORM public.record_stripe_manual_review_atomic(
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
    PERFORM public.record_stripe_manual_review_atomic(
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
        p_event_created_at > v_payment.created_at
        AND (
          (
            p_current_invoice_id = v_payment.stripe_invoice_id
            AND p_period_start = v_payment.period_start
            AND p_period_end = v_payment.period_end
          )
          OR (
            v_has_latest_event
            AND v_latest_event.outcome = 'applied'
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
      AND p_current_invoice_id IS NULL
      AND v_trial.user_id = p_user_id
      AND v_trial.stripe_customer_id = p_stripe_customer_id
      AND v_trial.stripe_subscription_id = p_stripe_subscription_id
      AND v_trial.plan = p_plan
      AND v_trial.period_start = v_subscription.current_period_start
      AND v_trial.period_end = v_subscription.current_period_end
      AND v_trial.revoked_at IS NULL
      AND (
        (
          p_period_start = v_trial.period_start
          AND p_period_end >= v_trial.period_end
        )
        OR (
          p_period_start > v_trial.period_start
          AND p_period_end > v_trial.period_end
        )
      );
    IF v_exact_trial
      AND p_stripe_status IN (
        'canceled',
        'unpaid',
        'incomplete',
        'incomplete_expired',
        'paused'
      )
    THEN
      v_exact_trial :=
        p_period_start = v_trial.period_start
        AND p_period_end = v_trial.period_end;
    END IF;
  END IF;

  IF NOT v_exact_payment AND NOT v_exact_trial THEN
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'manual_review'
    WHERE event_id = p_event_id;
    PERFORM public.record_stripe_manual_review_atomic(
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
    PERFORM public.record_stripe_manual_review_atomic(
      'subscription_event',
      p_event_id,
      p_user_id,
      'subscription_state_authority_kind_conflict',
      'A state-only event attempted to convert between paid and trial authority.',
      pg_catalog.jsonb_build_object('stripe_status', p_stripe_status)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  IF p_stripe_status = 'trialing' THEN
    IF p_period_start IS DISTINCT FROM v_trial.period_start
      OR p_period_end IS DISTINCT FROM v_trial.period_end
    THEN
      INSERT INTO public.stripe_trial_entitlements (
        user_id,
        stripe_customer_id,
        stripe_subscription_id,
        plan,
        period_start,
        period_end,
        verified_at
      ) VALUES (
        p_user_id,
        p_stripe_customer_id,
        p_stripe_subscription_id,
        p_plan,
        p_period_start,
        p_period_end,
        v_now
      )
      ON CONFLICT (
        stripe_subscription_id,
        period_start,
        period_end
      ) DO NOTHING;

      SELECT trial.*
      INTO v_new_trial
      FROM public.stripe_trial_entitlements AS trial
      WHERE trial.stripe_subscription_id = p_stripe_subscription_id
        AND trial.period_start = p_period_start
        AND trial.period_end = p_period_end
      FOR UPDATE;
      IF NOT FOUND
        OR v_new_trial.user_id IS DISTINCT FROM p_user_id
        OR v_new_trial.stripe_customer_id
          IS DISTINCT FROM p_stripe_customer_id
        OR v_new_trial.plan IS DISTINCT FROM p_plan
        OR v_new_trial.revoked_at IS NOT NULL
      THEN
        RAISE EXCEPTION 'trial extension identity conflict'
          USING ERRCODE = '23514';
      END IF;

      UPDATE public.stripe_trial_entitlements
      SET revoked_at = COALESCE(revoked_at, v_now),
          revoke_reason = COALESCE(revoke_reason, 'trial_extended'),
          updated_at = v_now
      WHERE id = v_trial.id
        AND revoked_at IS NULL;

      UPDATE public.subscriptions
      SET status = 'trialing',
          current_period_start = p_period_start,
          current_period_end = p_period_end,
          cancel_at_period_end = p_cancel_at_period_end,
          canceled_at = p_canceled_at,
          entitlement_trial_id = v_new_trial.id,
          entitlement_trial_verified_at = v_new_trial.verified_at,
          updated_at = v_now
      WHERE id = v_subscription.id;
    ELSE
      UPDATE public.subscriptions
      SET status = 'trialing',
          cancel_at_period_end = p_cancel_at_period_end,
          canceled_at = p_canceled_at,
          updated_at = v_now
      WHERE id = v_subscription.id;
    END IF;

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
      OR p_event_created_at <= v_payment.created_at
    THEN
      UPDATE public.stripe_subscription_state_events
      SET outcome = 'stale'
      WHERE event_id = p_event_id;
      PERFORM public.record_stripe_manual_review_atomic(
        'subscription_event',
        p_event_id,
        p_user_id,
        'paid_invoice_state_downgrade',
        'A past-due state attempted to downgrade a newer exact succeeded payment.',
        pg_catalog.jsonb_build_object(
          'paid_invoice_id', v_payment.stripe_invoice_id,
          'failed_invoice_id', p_current_invoice_id,
          'payment_observed_at', v_payment.created_at,
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

    v_has_authority :=
      public.sync_current_pro_projection_atomic(p_user_id);
    IF NOT v_has_authority THEN
      v_leave_ack := public.leave_pro_official_group_atomic(p_user_id);
      IF v_leave_ack ->> 'status' NOT IN ('left', 'not_member') THEN
        RAISE EXCEPTION
          'atomic official-group leave returned invalid status';
      END IF;
    END IF;
    UPDATE public.stripe_subscription_state_events
    SET outcome = 'applied'
    WHERE event_id = p_event_id;
    RETURN pg_catalog.jsonb_build_object(
      'status',
      CASE
        WHEN v_has_authority THEN 'grace_applied'
        ELSE 'grace_expired'
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
    IF v_leave_ack ->> 'status' NOT IN ('left', 'not_member') THEN
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

ALTER FUNCTION public.reconcile_recurring_subscription_state_atomic(
  uuid, text, text, text, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz
) OWNER TO postgres;

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
  p_payment_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_payment_id uuid;
  v_match_ids uuid[];
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_reservation public.stripe_lifetime_seat_reservations%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_current_payment public.stripe_entitlement_payments%ROWTYPE;
  v_has_current_lifetime_authority boolean := false;
  v_identity_user_id uuid;
  v_reservation_valid boolean := false;
  v_reservation_found boolean := false;
  v_profile_exists boolean := false;
  v_subject_active boolean := false;
  v_profile_customer_id text;
  v_audit_user_id uuid;
  v_safe_refund_identity boolean := false;
  v_tombstone_merge jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR pg_catalog.left(COALESCE(p_stripe_customer_id, ''), 4) <> 'cus_'
    OR pg_catalog.left(COALESCE(p_checkout_session_id, ''), 3) <> 'cs_'
    OR pg_catalog.left(
      COALESCE(p_stripe_payment_intent_id, ''),
      3
    ) <> 'pi_'
    OR pg_catalog.left(COALESCE(p_stripe_charge_id, ''), 3) <> 'ch_'
    OR p_amount_paid IS NULL
    OR p_amount_paid <= 0
    OR p_currency IS NULL
    OR p_currency !~ '^[a-z]{3}$'
    OR p_paid_at IS NULL
    OR p_payment_status IS DISTINCT FROM 'succeeded'
  THEN
    RAISE EXCEPTION 'lifetime payment identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-lifetime-seat-capacity', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || p_stripe_charge_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_user_id::text,
      0
    )
  );

  SELECT profile.deleted_at IS NULL, profile.stripe_customer_id
  INTO v_subject_active, v_profile_customer_id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  v_profile_exists := FOUND;
  v_subject_active :=
    v_profile_exists AND COALESCE(v_subject_active, false);
  v_audit_user_id :=
    CASE WHEN v_profile_exists THEN p_user_id ELSE NULL END;

  SELECT reservation.*
  INTO v_reservation
  FROM public.stripe_lifetime_seat_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;
  v_reservation_found := FOUND;
  v_reservation_valid :=
    v_reservation_found
    AND v_reservation.user_id = p_user_id
    AND v_reservation.checkout_session_id = p_checkout_session_id
    AND (
      (
        v_reservation.status = 'bound'
        AND p_paid_at <= v_reservation.checkout_expires_at
      )
      OR v_reservation.status = 'converted'
    );
  v_safe_refund_identity :=
    NOT v_profile_exists
    OR (
      v_profile_exists
      AND (
        v_profile_customer_id IS NULL
        OR v_profile_customer_id = p_stripe_customer_id
      )
    )
    OR (
      v_reservation_found
      AND v_reservation.user_id = p_user_id
      AND v_reservation.checkout_session_id = p_checkout_session_id
    );

  INSERT INTO public.stripe_entitlement_payments (
    user_id,
    stripe_customer_id,
    payment_kind,
    plan,
    stripe_payment_intent_id,
    stripe_charge_id,
    checkout_session_id,
    amount_paid,
    currency,
    period_start,
    payment_status
  ) VALUES (
    v_audit_user_id,
    p_stripe_customer_id,
    'lifetime',
    'lifetime',
    p_stripe_payment_intent_id,
    p_stripe_charge_id,
    p_checkout_session_id,
    p_amount_paid,
    p_currency,
    p_paid_at,
    p_payment_status
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_payment_id;

  SELECT pg_catalog.array_agg(payment.id ORDER BY payment.id)
  INTO v_match_ids
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.stripe_payment_intent_id = p_stripe_payment_intent_id
    OR payment.stripe_charge_id = p_stripe_charge_id
    OR payment.checkout_session_id = p_checkout_session_id;

  IF pg_catalog.cardinality(v_match_ids) IS DISTINCT FROM 1 THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_intent',
      p_stripe_payment_intent_id,
      v_audit_user_id,
      'payment_identity_conflict',
      'Lifetime payment identifiers resolve to multiple or no ledger rows.',
      pg_catalog.jsonb_build_object(
        'charge_id', p_stripe_charge_id,
        'session_id', p_checkout_session_id,
        'match_count', COALESCE(pg_catalog.cardinality(v_match_ids), 0)
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT payment.*
  INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.id = v_match_ids[1]
  FOR UPDATE;

  IF v_payment.user_id IS DISTINCT FROM v_audit_user_id
    OR v_payment.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
    OR v_payment.payment_kind IS DISTINCT FROM 'lifetime'
    OR v_payment.plan IS DISTINCT FROM 'lifetime'
    OR v_payment.checkout_session_id IS DISTINCT FROM p_checkout_session_id
    OR v_payment.stripe_payment_intent_id
      IS DISTINCT FROM p_stripe_payment_intent_id
    OR v_payment.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
    OR v_payment.amount_paid IS DISTINCT FROM p_amount_paid
    OR v_payment.currency IS DISTINCT FROM p_currency
    OR v_payment.period_start IS DISTINCT FROM p_paid_at
    OR v_payment.payment_status IS DISTINCT FROM p_payment_status
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_intent',
      p_stripe_payment_intent_id,
      v_audit_user_id,
      'payment_identity_conflict',
      'Lifetime payment replay changed immutable ledger identity.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'charge_id', p_stripe_charge_id,
        'session_id', p_checkout_session_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  v_tombstone_merge :=
    public.stripe_merge_charge_refund_tombstone_v2(
      v_payment.id
    );
  IF v_tombstone_merge ->> 'status' IN (
    'identity_conflict',
    'manual_review'
  ) THEN
    RETURN v_tombstone_merge;
  END IF;
  SELECT payment.*
  INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.id = v_match_ids[1]
  FOR UPDATE;

  IF v_payment.refund_state = 'succeeded'
    AND v_payment.refund_succeeded_amount >= v_payment.amount_paid
  THEN
    IF v_reservation_valid
      AND v_reservation.status = 'bound'
    THEN
      UPDATE public.stripe_lifetime_seat_reservations
      SET status = 'released',
          release_reason = 'payment_refunded_before_activation',
          released_at = v_now,
          updated_at = v_now
      WHERE id = v_reservation.id
        AND status = 'bound';
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'refunded_payment');
  END IF;

  SELECT profile.id
  INTO v_identity_user_id
  FROM public.user_profiles AS profile
  WHERE profile.stripe_customer_id = p_stripe_customer_id
    AND profile.id IS DISTINCT FROM p_user_id
  FOR UPDATE;
  IF FOUND
    OR (
      v_profile_exists
      AND v_profile_customer_id IS NOT NULL
      AND v_profile_customer_id IS DISTINCT FROM p_stripe_customer_id
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'customer',
      p_stripe_customer_id,
      CASE
        WHEN v_identity_user_id IS NOT NULL THEN v_identity_user_id
        ELSE v_audit_user_id
      END,
      'stripe_customer_identity_conflict',
      'A paid Stripe customer id conflicted with the requested owner.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'requested_user_id', p_user_id,
        'existing_user_id', v_identity_user_id,
        'requested_profile_customer_id', v_profile_customer_id
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
      v_audit_user_id,
      'payment',
      v_payment.id::text,
      'review:stripe_customer_identity_conflict',
      'payment_manual_review',
      pg_catalog.jsonb_build_object(
        'reason_key', 'stripe_customer_identity_conflict'
      )
    )
    ON CONFLICT (
      source_kind,
      source_key,
      effect_type,
      operation_key
    ) DO NOTHING;
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF NOT v_reservation_valid
    OR (
      v_reservation.status = 'converted'
      AND v_reservation.converted_payment_id IS DISTINCT FROM v_payment.id
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'session',
      p_checkout_session_id,
      v_audit_user_id,
      'lifetime_reservation_identity_conflict',
      'A paid lifetime Checkout Session lacked its exact consumable seat reservation.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'requested_reservation_id', p_reservation_id,
        'reservation_status', v_reservation.status,
        'reservation_user_id', v_reservation.user_id,
        'reservation_session_id', v_reservation.checkout_session_id,
        'reservation_expires_at', v_reservation.expires_at,
        'paid_at', p_paid_at
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
      v_audit_user_id,
      'payment',
      v_payment.id::text,
      'review:lifetime_reservation_identity_conflict',
      'payment_manual_review',
      pg_catalog.jsonb_build_object(
        'reason_key', 'lifetime_reservation_identity_conflict'
      )
    )
    ON CONFLICT (
      source_kind,
      source_key,
      effect_type,
      operation_key
    ) DO NOTHING;
    IF v_safe_refund_identity THEN
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
        v_audit_user_id,
        'payment',
        v_payment.id::text,
        CASE
          WHEN v_subject_active THEN 'refund:reservation_conflict'
          ELSE 'refund:subject_deleted'
        END,
        'payment_auto_refund',
        pg_catalog.jsonb_build_object(
          'reason_key',
            CASE
              WHEN v_subject_active
              THEN 'paid_lifetime_reservation_conflict'
              ELSE 'paid_lifetime_subject_deleted'
            END,
          'checkout_session_id', p_checkout_session_id
        )
      )
      ON CONFLICT (
        source_kind,
        source_key,
        effect_type,
        operation_key
      ) DO NOTHING;
      RETURN pg_catalog.jsonb_build_object(
        'status',
        CASE
          WHEN v_subject_active THEN 'reservation_refund_queued'
          ELSE 'subject_deleted'
        END
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'reservation_review');
  END IF;

  IF v_reservation.status = 'bound' THEN
    UPDATE public.stripe_lifetime_seat_reservations
    SET status = 'converted',
        converted_payment_id = v_payment.id,
        updated_at = v_now
    WHERE id = v_reservation.id
      AND user_id = p_user_id
      AND checkout_session_id = p_checkout_session_id
      AND status = 'bound'
      AND converted_payment_id IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'lifetime reservation conversion CAS failed'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  IF NOT v_subject_active THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'session',
      p_checkout_session_id,
      v_audit_user_id,
      'paid_lifetime_subject_deleted',
      'A lifetime payment completed after its entitlement owner was deleted.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'reservation_id', v_reservation.id,
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
      v_audit_user_id,
      'payment',
      v_payment.id::text,
      'refund:subject_deleted',
      'payment_auto_refund',
      pg_catalog.jsonb_build_object(
        'reason_key', 'paid_lifetime_subject_deleted',
        'checkout_session_id', p_checkout_session_id
      )
    )
    ON CONFLICT (
      source_kind,
      source_key,
      effect_type,
      operation_key
    ) DO NOTHING;
    RETURN pg_catalog.jsonb_build_object('status', 'subject_deleted');
  END IF;

  INSERT INTO public.pro_entitlement_grants (
    user_id,
    source,
    source_key,
    starts_at,
    expires_at,
    metadata
  ) VALUES (
    p_user_id,
    'stripe_lifetime_payment',
    'payment:' || v_payment.id::text,
    p_paid_at,
    NULL,
    pg_catalog.jsonb_build_object(
      'payment_id', v_payment.id,
      'checkout_session_id', p_checkout_session_id,
      'charge_id', p_stripe_charge_id
    )
  )
  ON CONFLICT (source, source_key) DO NOTHING;

  SELECT subscription.*
  INTO v_subscription
  FROM public.subscriptions AS subscription
  WHERE subscription.user_id = p_user_id
  FOR UPDATE;

  IF FOUND
    AND v_subscription.entitlement_payment_id = v_payment.id
    AND v_subscription.status = 'active'
    AND public.stripe_subscription_has_exact_payment_binding_v2(p_user_id)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_activated');
  END IF;

  IF FOUND
    AND v_subscription.entitlement_payment_id IS DISTINCT FROM v_payment.id
    AND v_subscription.plan = 'lifetime'
    AND v_subscription.status = 'active'
  THEN
    IF v_subscription.entitlement_payment_id IS NOT NULL THEN
      SELECT payment.*
      INTO v_current_payment
      FROM public.stripe_entitlement_payments AS payment
      WHERE payment.id = v_subscription.entitlement_payment_id
      FOR UPDATE;
      v_has_current_lifetime_authority :=
        FOUND
        AND v_current_payment.payment_kind = 'lifetime'
        AND v_current_payment.user_id = p_user_id
        AND NOT (
          v_current_payment.refund_state = 'succeeded'
          AND v_current_payment.refund_succeeded_amount
            >= v_current_payment.amount_paid
        );
    ELSE
      SELECT EXISTS (
        SELECT 1
        FROM public.pro_entitlement_grants AS entitlement_grant
        WHERE entitlement_grant.user_id = p_user_id
          AND entitlement_grant.source = 'legacy_stripe_snapshot'
          AND entitlement_grant.source_key =
            'subscription:' || v_subscription.id::text
          AND entitlement_grant.revoked_at IS NULL
          AND entitlement_grant.expires_at IS NULL
          AND entitlement_grant.metadata ->> 'plan' = 'lifetime'
      ) INTO v_has_current_lifetime_authority;
    END IF;

    IF v_has_current_lifetime_authority THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'charge',
        p_stripe_charge_id,
        p_user_id,
        'duplicate_lifetime_purchase',
        'A second lifetime payment succeeded for an already-lifetime user.',
        pg_catalog.jsonb_build_object(
          'incoming_payment_id', v_payment.id,
          'current_payment_id', v_subscription.entitlement_payment_id,
          'current_subscription_id', v_subscription.id
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
        v_effective_user_id,
        'payment',
        v_payment.id::text,
        'review:duplicate_lifetime_purchase',
        'payment_manual_review',
        pg_catalog.jsonb_build_object(
          'reason_key', 'duplicate_lifetime_purchase'
        )
      )
      ON CONFLICT (
        source_kind,
        source_key,
        effect_type,
        operation_key
      ) DO NOTHING;
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
        'refund:duplicate_lifetime_purchase',
        'payment_auto_refund',
        pg_catalog.jsonb_build_object(
          'reason_key', 'duplicate_lifetime_purchase',
          'checkout_session_id', p_checkout_session_id
        )
      )
      ON CONFLICT (
        source_kind,
        source_key,
        effect_type,
        operation_key
      ) DO NOTHING;
      RETURN pg_catalog.jsonb_build_object(
        'status',
        'duplicate_refund_queued'
      );
    END IF;
  END IF;

  -- A paid lifetime purchase always supersedes recurring/trial authority. It
  -- is never silently swallowed merely because a recurring row already exists.
  INSERT INTO public.subscriptions (
    user_id,
    stripe_customer_id,
    stripe_subscription_id,
    status,
    tier,
    plan,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    canceled_at,
    entitlement_payment_id,
    entitlement_trial_id,
    entitlement_trial_verified_at,
    updated_at
  ) VALUES (
    p_user_id,
    p_stripe_customer_id,
    p_checkout_session_id,
    'active',
    'pro',
    'lifetime',
    p_paid_at,
    NULL,
    false,
    NULL,
    v_payment.id,
    NULL,
    NULL,
    v_now
  )
  ON CONFLICT (user_id) DO UPDATE
  SET stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      status = 'active',
      tier = 'pro',
      plan = 'lifetime',
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = NULL,
      cancel_at_period_end = false,
      canceled_at = NULL,
      entitlement_payment_id = EXCLUDED.entitlement_payment_id,
      entitlement_trial_id = NULL,
      entitlement_trial_verified_at = NULL,
      updated_at = v_now;

  UPDATE public.pro_entitlement_grants
  SET revoked_at = COALESCE(revoked_at, v_now),
      updated_at = v_now
  WHERE user_id = p_user_id
    AND source = 'legacy_stripe_snapshot'
    AND revoked_at IS NULL;

  UPDATE public.stripe_trial_entitlements
  SET revoked_at = COALESCE(revoked_at, v_now),
      revoke_reason = COALESCE(revoke_reason, 'lifetime_activation'),
      updated_at = v_now
  WHERE user_id = p_user_id
    AND revoked_at IS NULL;

  PERFORM public.sync_current_pro_projection_atomic(p_user_id);

  INSERT INTO public.stripe_entitlement_effects (
    entitlement_payment_id,
    user_id,
    source_kind,
    source_key,
    operation_key,
    effect_type,
    payload
  ) VALUES
    (
      v_payment.id,
      p_user_id,
      'payment',
      v_payment.id::text,
      'activation',
      'pro_official_group_join',
      pg_catalog.jsonb_build_object('plan', 'lifetime')
    ),
    (
      v_payment.id,
      p_user_id,
      'payment',
      v_payment.id::text,
      'activation',
      'pro_purchase_alert',
      pg_catalog.jsonb_build_object('plan', 'lifetime')
    )
  ON CONFLICT (
    source_kind,
    source_key,
    effect_type,
    operation_key
  ) DO NOTHING;

  RETURN pg_catalog.jsonb_build_object('status', 'activated');
END
$function$;

ALTER FUNCTION public.activate_lifetime_membership_with_identity_atomic(
  uuid, text, text, uuid, text, text, bigint, text, timestamptz, text
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.reconcile_stripe_entitlement_refund_atomic(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_payment_kind text,
  p_plan text,
  p_stripe_subscription_id text,
  p_stripe_invoice_id text,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_checkout_session_id text,
  p_amount_paid bigint,
  p_currency text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_payment_status text,
  p_refund_succeeded_amount bigint,
  p_refund_state text,
  p_stripe_subscription_status text,
  p_refund_event_id text,
  p_refund_event_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_payment_id uuid;
  v_match_ids uuid[];
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_existing_event public.stripe_entitlement_refund_events%ROWTYPE;
  v_inserted_event_id text;
  v_is_full_refund boolean;
  v_incoming_full_refund boolean;
  v_existing_full_refund boolean;
  v_profile_exists boolean;
  v_subject_active boolean := false;
  v_subject_deleted boolean := false;
  v_ambiguous_event_order boolean := false;
  v_effective_user_id uuid := p_user_id;
  v_tombstone_merge jsonb;
  v_has_authority boolean;
  v_leave_ack jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.left(COALESCE(p_stripe_customer_id, ''), 4) <> 'cus_'
    OR p_payment_kind NOT IN ('recurring', 'lifetime')
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND pg_catalog.left(p_stripe_payment_intent_id, 3) <> 'pi_'
    )
    OR pg_catalog.left(COALESCE(p_stripe_charge_id, ''), 3) <> 'ch_'
    OR p_amount_paid IS NULL
    OR p_amount_paid <= 0
    OR p_currency IS NULL
    OR p_currency !~ '^[a-z]{3}$'
    OR p_period_start IS NULL
    OR p_payment_status NOT IN ('paid', 'succeeded')
    OR p_refund_succeeded_amount IS NULL
    OR p_refund_succeeded_amount < 0
    OR p_refund_succeeded_amount > p_amount_paid
    OR (
      p_refund_succeeded_amount = p_amount_paid
      AND p_refund_state IS DISTINCT FROM 'succeeded'
    )
    OR p_refund_state NOT IN (
      'pending',
      'requires_action',
      'succeeded',
      'failed',
      'canceled'
    )
    OR pg_catalog.left(COALESCE(p_refund_event_id, ''), 4) <> 'evt_'
    OR p_refund_event_created_at IS NULL
  THEN
    RAISE EXCEPTION 'refund payment identity is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF (
    p_payment_kind = 'recurring'
    AND (
      p_plan NOT IN ('monthly', 'yearly')
      OR pg_catalog.left(COALESCE(p_stripe_subscription_id, ''), 4) <> 'sub_'
      OR pg_catalog.left(COALESCE(p_stripe_invoice_id, ''), 3) <> 'in_'
      OR p_checkout_session_id IS NOT NULL
      OR p_period_end IS NULL
      OR p_period_end <= p_period_start
      OR p_stripe_subscription_status NOT IN (
        'active',
        'trialing',
        'past_due',
        'canceled',
        'unpaid',
        'incomplete',
        'incomplete_expired',
        'paused'
      )
    )
  ) OR (
    p_payment_kind = 'lifetime'
    AND (
      p_plan IS DISTINCT FROM 'lifetime'
      OR p_stripe_subscription_id IS NOT NULL
      OR p_stripe_invoice_id IS NOT NULL
      OR pg_catalog.left(
        COALESCE(p_stripe_payment_intent_id, ''),
        3
      ) <> 'pi_'
      OR pg_catalog.left(COALESCE(p_checkout_session_id, ''), 3) <> 'cs_'
      OR p_period_end IS NOT NULL
      OR p_stripe_subscription_status IS NOT NULL
      OR p_payment_status IS DISTINCT FROM 'succeeded'
    )
  ) THEN
    RAISE EXCEPTION 'refund kind-specific identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-lifetime-seat-capacity', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-refund-event:' || p_refund_event_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || p_stripe_charge_id,
      0
    )
  );

  -- p_user_id is only a nullable routing hint. Resolve the durable subject
  -- under the per-Charge fence so a concurrent activation cannot appear after
  -- this lookup and turn an exact refund into a false identity conflict.
  IF v_effective_user_id IS NULL
    AND p_payment_kind = 'lifetime'
  THEN
    SELECT reservation.user_id
    INTO v_effective_user_id
    FROM public.stripe_lifetime_seat_reservations AS reservation
    WHERE reservation.checkout_session_id = p_checkout_session_id
      AND reservation.status IN ('bound', 'converted')
    LIMIT 1;
  END IF;
  IF v_effective_user_id IS NULL THEN
    SELECT payment.user_id
    INTO v_effective_user_id
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.stripe_charge_id = p_stripe_charge_id;
  END IF;

  IF v_effective_user_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'pro-official-group-user:' || v_effective_user_id::text,
        0
      )
    );
  END IF;

  SELECT profile.deleted_at IS NULL
  INTO v_subject_active
  FROM public.user_profiles AS profile
  WHERE profile.id = v_effective_user_id
  FOR UPDATE;
  v_profile_exists := FOUND;
  v_subject_active := v_profile_exists AND COALESCE(v_subject_active, false);

  IF EXISTS (
    SELECT 1
    FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
    WHERE tombstone_event.event_id = p_refund_event_id
      AND (
        tombstone_event.stripe_charge_id
          IS DISTINCT FROM p_stripe_charge_id
        OR tombstone_event.event_created_at
          IS DISTINCT FROM p_refund_event_created_at
      )
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'refund',
      p_refund_event_id,
      CASE WHEN v_profile_exists THEN v_effective_user_id ELSE NULL END,
      'refund_event_identity_conflict',
      'A refund event already belongs to another Charge tombstone identity.',
      pg_catalog.jsonb_build_object(
        'stripe_charge_id', p_stripe_charge_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  -- Financial identity survives account deletion. A refund-first webhook must
  -- create an ownerless tombstone so a delayed activation cannot resurrect the
  -- charge and a fully refunded lifetime Session can release its bound seat.
  INSERT INTO public.stripe_entitlement_payments (
    user_id,
    stripe_customer_id,
    payment_kind,
    plan,
    stripe_subscription_id,
    stripe_invoice_id,
    stripe_payment_intent_id,
    stripe_charge_id,
    checkout_session_id,
    amount_paid,
    currency,
    period_start,
    period_end,
    payment_status
  ) VALUES (
    CASE WHEN v_profile_exists THEN v_effective_user_id ELSE NULL END,
    p_stripe_customer_id,
    p_payment_kind,
    p_plan,
    p_stripe_subscription_id,
    p_stripe_invoice_id,
    p_stripe_payment_intent_id,
    p_stripe_charge_id,
    p_checkout_session_id,
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
  WHERE payment.stripe_payment_intent_id = p_stripe_payment_intent_id
    OR payment.stripe_charge_id = p_stripe_charge_id
    OR (
      p_stripe_invoice_id IS NOT NULL
      AND payment.stripe_invoice_id = p_stripe_invoice_id
    )
    OR (
      p_checkout_session_id IS NOT NULL
      AND payment.checkout_session_id = p_checkout_session_id
    );

  IF pg_catalog.cardinality(v_match_ids) IS DISTINCT FROM 1 THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'refund',
      p_refund_event_id,
      CASE WHEN v_profile_exists THEN v_effective_user_id ELSE NULL END,
      'payment_identity_conflict',
      'Refund identifiers resolve to multiple or no payment ledger rows.',
      pg_catalog.jsonb_build_object(
        'payment_intent_id', p_stripe_payment_intent_id,
        'charge_id', p_stripe_charge_id,
        'match_count', COALESCE(pg_catalog.cardinality(v_match_ids), 0)
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT payment.*
  INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.id = v_match_ids[1]
  FOR UPDATE;

  v_subject_deleted :=
    NOT v_subject_active
    AND (
      (
        v_profile_exists
        AND v_payment.user_id = v_effective_user_id
      )
      OR (
        NOT v_profile_exists
        AND v_payment.user_id IS NULL
      )
    );

  IF (
      v_payment.user_id IS DISTINCT FROM v_effective_user_id
      AND NOT v_subject_deleted
    )
    OR v_payment.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
    OR v_payment.payment_kind IS DISTINCT FROM p_payment_kind
    OR v_payment.plan IS DISTINCT FROM p_plan
    OR v_payment.stripe_subscription_id
      IS DISTINCT FROM p_stripe_subscription_id
    OR v_payment.stripe_invoice_id IS DISTINCT FROM p_stripe_invoice_id
    OR v_payment.stripe_payment_intent_id
      IS DISTINCT FROM p_stripe_payment_intent_id
    OR v_payment.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
    OR v_payment.checkout_session_id IS DISTINCT FROM p_checkout_session_id
    OR v_payment.amount_paid IS DISTINCT FROM p_amount_paid
    OR v_payment.currency IS DISTINCT FROM p_currency
    OR v_payment.period_start IS DISTINCT FROM p_period_start
    OR v_payment.period_end IS DISTINCT FROM p_period_end
    OR v_payment.payment_status IS DISTINCT FROM p_payment_status
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'refund',
      p_refund_event_id,
      CASE WHEN v_profile_exists THEN v_effective_user_id ELSE NULL END,
      'payment_identity_conflict',
      'Refund replay changed immutable payment ledger identity.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'payment_intent_id', p_stripe_payment_intent_id,
        'charge_id', p_stripe_charge_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  v_tombstone_merge :=
    public.stripe_merge_charge_refund_tombstone_v2(
      v_payment.id
    );
  IF v_tombstone_merge ->> 'status' IN (
    'identity_conflict',
    'manual_review'
  ) THEN
    RETURN v_tombstone_merge;
  END IF;
  SELECT payment.*
  INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.id = v_match_ids[1]
  FOR UPDATE;

  INSERT INTO public.stripe_entitlement_refund_events (
    event_id,
    entitlement_payment_id,
    user_id,
    refund_state,
    refund_succeeded_amount,
    stripe_subscription_status,
    event_created_at,
    observations
  ) VALUES (
    p_refund_event_id,
    v_payment.id,
    CASE WHEN v_profile_exists THEN v_effective_user_id ELSE NULL END,
    p_refund_state,
    p_refund_succeeded_amount,
    p_stripe_subscription_status,
    p_refund_event_created_at,
    pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'refund_state', p_refund_state,
        'refund_succeeded_amount', p_refund_succeeded_amount,
        'stripe_subscription_status', p_stripe_subscription_status
      )
    )
  )
  ON CONFLICT (event_id) DO NOTHING
  RETURNING event_id INTO v_inserted_event_id;

  IF v_inserted_event_id IS NULL THEN
    SELECT refund_event.*
    INTO v_existing_event
    FROM public.stripe_entitlement_refund_events AS refund_event
    WHERE refund_event.event_id = p_refund_event_id;
    IF NOT FOUND
      OR v_existing_event.entitlement_payment_id IS DISTINCT FROM v_payment.id
      OR v_existing_event.user_id IS DISTINCT FROM
        (
          CASE WHEN v_profile_exists THEN v_effective_user_id ELSE NULL END
        )
      OR v_existing_event.event_created_at
        IS DISTINCT FROM p_refund_event_created_at
    THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'refund',
        p_refund_event_id,
        CASE WHEN v_profile_exists THEN v_effective_user_id ELSE NULL END,
        'refund_event_identity_conflict',
        'A Stripe refund event id was rebound to another immutable identity.',
        pg_catalog.jsonb_build_object('payment_id', v_payment.id)
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    -- The webhook id is immutable, but the handler deliberately fresh-retrieves
    -- the Charge aggregate. Preserve each distinct observation and continue
    -- through terminal/max-watermark reconciliation on redelivery.
    IF v_existing_event.observations @> pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'refund_state', p_refund_state,
        'refund_succeeded_amount', p_refund_succeeded_amount,
        'stripe_subscription_status', p_stripe_subscription_status
      )
    ) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'already_reconciled');
    END IF;

    UPDATE public.stripe_entitlement_refund_events
    SET observations = CASE
          WHEN observations @> pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'refund_state', p_refund_state,
              'refund_succeeded_amount', p_refund_succeeded_amount,
              'stripe_subscription_status', p_stripe_subscription_status
            )
          )
          THEN observations
          ELSE observations || pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'refund_state', p_refund_state,
              'refund_succeeded_amount', p_refund_succeeded_amount,
              'stripe_subscription_status', p_stripe_subscription_status
            )
          )
        END,
        observed_at = pg_catalog.clock_timestamp()
    WHERE event_id = p_refund_event_id;
  END IF;

  v_incoming_full_refund :=
    p_refund_state = 'succeeded'
    AND p_refund_succeeded_amount >= v_payment.amount_paid;
  v_existing_full_refund :=
    v_payment.refund_state = 'succeeded'
    AND v_payment.refund_succeeded_amount >= v_payment.amount_paid;

  -- A fully succeeded aggregate is terminal. Stripe aggregate refund totals
  -- cannot legitimately decrease, even when the contradicting snapshot has a
  -- newer event.created value. Keep the applied full snapshot, advance only the
  -- max-seen watermark, and require operator review.
  IF v_existing_full_refund
    AND NOT v_incoming_full_refund
  THEN
    UPDATE public.stripe_entitlement_payments
    SET latest_refund_event_id = CASE
          WHEN latest_refund_event_created_at IS NULL
            OR p_refund_event_created_at > latest_refund_event_created_at
          THEN p_refund_event_id
          ELSE latest_refund_event_id
        END,
        latest_refund_event_created_at = CASE
          WHEN latest_refund_event_created_at IS NULL
            OR p_refund_event_created_at > latest_refund_event_created_at
          THEN p_refund_event_created_at
          ELSE latest_refund_event_created_at
        END,
        updated_at = v_now
    WHERE id = v_payment.id;

    PERFORM public.record_stripe_manual_review_atomic(
      'refund',
      p_refund_event_id,
      CASE WHEN v_profile_exists THEN v_effective_user_id ELSE NULL END,
      'full_refund_terminal_conflict',
      'A later Stripe aggregate attempted to reduce a fully succeeded refund.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'incoming_refund_state', p_refund_state,
        'incoming_refund_succeeded_amount', p_refund_succeeded_amount,
        'applied_refund_state', v_payment.refund_state,
        'applied_refund_succeeded_amount',
        v_payment.refund_succeeded_amount
      )
    );
    IF NOT v_subject_deleted THEN
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
        v_effective_user_id,
        'payment',
        v_payment.id::text,
        'review:full_refund_terminal_conflict:' || p_refund_event_id,
        'payment_manual_review',
        pg_catalog.jsonb_build_object(
          'reason_key', 'full_refund_terminal_conflict'
        )
      )
      ON CONFLICT (
        source_kind,
        source_key,
        effect_type,
        operation_key
      ) DO NOTHING;
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  IF v_payment.latest_refund_event_created_at IS NOT NULL
    AND p_refund_event_created_at
      <= v_payment.latest_refund_event_created_at
    AND p_refund_event_id IS DISTINCT FROM v_payment.latest_refund_event_id
  THEN
    v_ambiguous_event_order :=
      p_refund_event_created_at =
        v_payment.latest_refund_event_created_at;
    PERFORM public.record_stripe_manual_review_atomic(
      'refund',
      p_refund_event_id,
      CASE WHEN v_profile_exists THEN v_effective_user_id ELSE NULL END,
      'ambiguous_refund_event_order',
      CASE
        WHEN v_ambiguous_event_order
        THEN 'Different refund events share one Stripe creation timestamp.'
        ELSE 'An older refund event carried a conflicting aggregate snapshot.'
      END,
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'current_event_id', v_payment.latest_refund_event_id,
        'incoming_full_refund', v_incoming_full_refund,
        'existing_full_refund', v_existing_full_refund
      )
    );
    IF NOT v_subject_deleted THEN
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
        v_effective_user_id,
        'payment',
        v_payment.id::text,
        'review:ambiguous_refund_event_order:' || p_refund_event_id,
        'payment_manual_review',
        pg_catalog.jsonb_build_object(
          'reason_key', 'ambiguous_refund_event_order'
        )
      )
      ON CONFLICT (
        source_kind,
        source_key,
        effect_type,
        operation_key
      ) DO NOTHING;
    END IF;

    -- Stripe event.created is only second-resolution. A terminal full-refund
    -- aggregate always wins to fail closed; a non-full snapshot can never
    -- undo an already-observed full refund without operator review.
    IF NOT v_incoming_full_refund OR v_existing_full_refund THEN
      RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
    END IF;
  END IF;

  UPDATE public.stripe_entitlement_payments
  SET refund_succeeded_amount = p_refund_succeeded_amount,
      refund_state = p_refund_state,
      latest_refund_event_id = CASE
        WHEN latest_refund_event_created_at IS NULL
          OR p_refund_event_created_at > latest_refund_event_created_at
        THEN p_refund_event_id
        ELSE latest_refund_event_id
      END,
      latest_refund_event_created_at = CASE
        WHEN latest_refund_event_created_at IS NULL
          OR p_refund_event_created_at > latest_refund_event_created_at
        THEN p_refund_event_created_at
        ELSE latest_refund_event_created_at
      END,
      refund_snapshot_event_id = p_refund_event_id,
      refund_snapshot_event_created_at = p_refund_event_created_at,
      updated_at = v_now
  WHERE id = v_payment.id
  RETURNING * INTO v_payment;

  v_is_full_refund :=
    v_payment.refund_state = 'succeeded'
    AND v_payment.refund_succeeded_amount >= v_payment.amount_paid;

  IF v_is_full_refund THEN
    -- Revoke not-yet-finished authority side effects from this exact payment.
    -- A worker holding an old lease loses its fence and cannot acknowledge a
    -- group join after the source payment became fully refunded.
    UPDATE public.stripe_entitlement_effects
    SET status = 'superseded',
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error = 'payment_fully_refunded',
        completed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE entitlement_payment_id = v_payment.id
      AND effect_type IN (
        'payment_auto_refund',
        'pro_official_group_join',
        'pro_official_group_restore',
        'pro_purchase_alert'
      )
      AND status IN ('pending', 'processing', 'failed');

    -- A quarantined paid Session may still have a bound (not converted)
    -- reservation. The fresh full-refund aggregate is the financial proof
    -- that this exact Session can no longer consume one of the 200 seats.
    IF p_payment_kind = 'lifetime' THEN
      UPDATE public.stripe_lifetime_seat_reservations
      SET status = 'released',
          release_reason = 'payment_fully_refunded',
          released_at = v_now,
          updated_at = v_now
      WHERE user_id = v_effective_user_id
        AND checkout_session_id = p_checkout_session_id
        AND status = 'bound'
        AND converted_payment_id IS NULL;
    END IF;
  END IF;

  IF v_is_full_refund
    AND p_payment_kind = 'lifetime'
  THEN
    UPDATE public.pro_entitlement_grants
    SET revoked_at = COALESCE(revoked_at, v_now),
        updated_at = v_now
    WHERE user_id = v_effective_user_id
      AND source = 'stripe_lifetime_payment'
      AND source_key = 'payment:' || v_payment.id::text
      AND revoked_at IS NULL;
  END IF;

  IF v_subject_deleted THEN
    IF v_is_full_refund AND v_profile_exists THEN
      UPDATE public.subscriptions
      SET status = 'canceled',
          cancel_at_period_end = false,
          canceled_at = COALESCE(canceled_at, v_now),
          updated_at = v_now
      WHERE user_id = v_effective_user_id
        AND entitlement_payment_id = v_payment.id;

      UPDATE public.pro_entitlement_grants
      SET revoked_at = COALESCE(revoked_at, v_now),
          metadata = metadata || pg_catalog.jsonb_build_object(
            'episode_closed_at', v_now,
            'episode_close_reason', 'payment_fully_refunded',
            'refund_event_id', p_refund_event_id
          ),
          updated_at = v_now
      WHERE user_id = v_effective_user_id
        AND source = 'stripe_payment_retry_grace'
        AND metadata ->> 'stripe_subscription_id' =
          p_stripe_subscription_id
        AND metadata ->> 'episode_closed_at' IS NULL;

      v_leave_ack :=
        public.leave_pro_official_group_atomic(v_effective_user_id);
      IF v_leave_ack ->> 'status' NOT IN ('left', 'not_member') THEN
        RAISE EXCEPTION
          'atomic official-group leave returned invalid status';
      END IF;
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'subject_deleted');
  END IF;

  SELECT subscription.*
  INTO v_subscription
  FROM public.subscriptions AS subscription
  WHERE subscription.user_id = v_effective_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'refund_recorded');
  END IF;

  IF v_subscription.entitlement_payment_id IS DISTINCT FROM v_payment.id THEN
    IF v_subscription.entitlement_payment_id IS NULL
      AND v_subscription.status IN ('active', 'trialing')
      AND (
        (
          p_payment_kind = 'recurring'
          AND v_subscription.stripe_subscription_id = p_stripe_subscription_id
        )
        OR (
          p_payment_kind = 'lifetime'
          AND v_subscription.stripe_subscription_id = p_checkout_session_id
        )
      )
    THEN
      PERFORM public.record_stripe_manual_review_atomic(
        CASE
          WHEN p_payment_kind = 'recurring' THEN 'subscription'
          ELSE 'session'
        END,
        CASE
          WHEN p_payment_kind = 'recurring' THEN p_stripe_subscription_id
          ELSE p_checkout_session_id
        END,
        v_effective_user_id,
        'legacy_current_entitlement_unbound',
        'A refund may target a current pre-ledger entitlement.',
        pg_catalog.jsonb_build_object(
          'payment_id', v_payment.id,
          'refund_event_id', p_refund_event_id
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
        v_effective_user_id,
        'payment',
        v_payment.id::text,
        'review:legacy_current_entitlement_unbound:'
          || p_refund_event_id,
        'payment_manual_review',
        pg_catalog.jsonb_build_object(
          'reason_key', 'legacy_current_entitlement_unbound'
        )
      )
      ON CONFLICT (
        source_kind,
        source_key,
        effect_type,
        operation_key
      ) DO NOTHING;
      RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
    END IF;
    IF v_is_full_refund
      AND p_payment_kind = 'lifetime'
    THEN
      v_has_authority :=
        public.sync_current_pro_projection_atomic(v_effective_user_id);
      IF v_has_authority THEN
        RETURN pg_catalog.jsonb_build_object('status', 'grant_protected');
      END IF;
      v_leave_ack :=
        public.leave_pro_official_group_atomic(v_effective_user_id);
      IF v_leave_ack ->> 'status' NOT IN ('left', 'not_member') THEN
        RAISE EXCEPTION
          'atomic official-group leave returned invalid status';
      END IF;
      RETURN pg_catalog.jsonb_build_object('status', 'revoked');
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'not_current');
  END IF;

  IF v_is_full_refund THEN
    UPDATE public.pro_entitlement_grants
    SET revoked_at = COALESCE(revoked_at, v_now),
        metadata = metadata || pg_catalog.jsonb_build_object(
          'episode_closed_at', v_now,
          'episode_close_reason', 'payment_fully_refunded',
          'refund_event_id', p_refund_event_id
        ),
        updated_at = v_now
    WHERE user_id = v_effective_user_id
      AND source = 'stripe_payment_retry_grace'
      AND metadata ->> 'stripe_subscription_id' =
        p_stripe_subscription_id
      AND metadata ->> 'episode_closed_at' IS NULL;

    IF v_subscription.status = 'canceled' THEN
      PERFORM public.sync_current_pro_projection_atomic(v_effective_user_id);
      RETURN pg_catalog.jsonb_build_object('status', 'already_revoked');
    END IF;

    UPDATE public.subscriptions
    SET status = 'canceled',
        cancel_at_period_end = false,
        canceled_at = COALESCE(canceled_at, v_now),
        entitlement_trial_verified_at = NULL,
        updated_at = v_now
    WHERE id = v_subscription.id;

    v_has_authority :=
      public.sync_current_pro_projection_atomic(v_effective_user_id);
    IF v_has_authority THEN
      RETURN pg_catalog.jsonb_build_object('status', 'grant_protected');
    END IF;

    v_leave_ack :=
      public.leave_pro_official_group_atomic(v_effective_user_id);
    IF v_leave_ack ->> 'status' NOT IN ('left', 'not_member') THEN
      RAISE EXCEPTION 'atomic official-group leave returned invalid status';
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'revoked');
  END IF;

  IF v_subscription.status = 'canceled' THEN
    IF p_payment_kind = 'recurring'
      AND p_stripe_subscription_status IN ('active', 'trialing')
    THEN
      UPDATE public.subscriptions
      SET status = p_stripe_subscription_status,
          canceled_at = NULL,
          cancel_at_period_end = false,
          updated_at = v_now
      WHERE id = v_subscription.id;
      PERFORM public.sync_current_pro_projection_atomic(v_effective_user_id);
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
        v_effective_user_id,
        'payment',
        v_payment.id::text,
        'restore:' || p_refund_event_id,
        'pro_official_group_restore',
        pg_catalog.jsonb_build_object(
          'refund_event_id', p_refund_event_id
        )
      )
      ON CONFLICT (
        source_kind,
        source_key,
        effect_type,
        operation_key
      ) DO NOTHING;
      RETURN pg_catalog.jsonb_build_object('status', 'restored');
    END IF;

    IF p_payment_kind = 'lifetime' THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'charge',
        p_stripe_charge_id,
        v_effective_user_id,
        'lifetime_refund_reversal_requires_review',
        'A lifetime full-refund snapshot moved back to a non-full state.',
        pg_catalog.jsonb_build_object(
          'payment_id', v_payment.id,
          'refund_event_id', p_refund_event_id,
          'refund_state', p_refund_state,
          'refund_succeeded_amount', p_refund_succeeded_amount
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
        v_effective_user_id,
        'payment',
        v_payment.id::text,
        'review:lifetime_refund_reversal_requires_review:'
          || p_refund_event_id,
        'payment_manual_review',
        pg_catalog.jsonb_build_object(
          'reason_key', 'lifetime_refund_reversal_requires_review'
        )
      )
      ON CONFLICT (
        source_kind,
        source_key,
        effect_type,
        operation_key
      ) DO NOTHING;
      RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'status',
      'restore_not_authorized'
    );
  END IF;

  IF p_refund_state = 'succeeded' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'partial_refund');
  END IF;
  IF p_refund_state IN ('pending', 'requires_action') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'refund_pending');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'refund_recorded');
END
$function$;

ALTER FUNCTION public.reconcile_stripe_entitlement_refund_atomic(
  uuid, text, text, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, bigint, text, text, text, timestamptz
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
                  AND payment.refund_succeeded_amount
                    >= payment.amount_paid
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
                    AND payment.refund_succeeded_amount
                      >= payment.amount_paid
                  )
              )
            )
          )
          OR effect.effect_type NOT IN (
            'payment_auto_refund',
            'pro_official_group_join',
            'pro_official_group_restore',
            'pro_purchase_alert'
          )
        )
    )
$function$;

ALTER FUNCTION public.stripe_entitlement_effect_is_current_v2(uuid)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.lease_stripe_entitlement_effects_atomic(
  p_limit integer,
  p_lease_seconds integer
)
RETURNS SETOF public.stripe_entitlement_effects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
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
      (
        effect.effect_type NOT IN (
          'payment_auto_refund',
          'payment_manual_review'
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
          effect.attempt_count < 10
          AND
          effect.status IN ('pending', 'failed')
          AND effect.available_at <= pg_catalog.statement_timestamp()
        )
        OR (
          effect.status = 'processing'
          AND effect.lease_expires_at
            <= pg_catalog.statement_timestamp()
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
          WHEN candidates.subject_inactive
            OR candidates.authority_superseded
          THEN 'superseded'
          WHEN effect.status = 'processing'
            AND effect.attempt_count >= 10
          THEN 'dead_lettered'
          ELSE 'processing'
        END,
        attempt_count = CASE
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
          WHEN candidates.subject_inactive
            OR candidates.authority_superseded
            OR (
              effect.status = 'processing'
              AND effect.attempt_count >= 10
            )
          THEN NULL
          ELSE pg_catalog.gen_random_uuid()
        END,
        lease_expires_at = CASE
          WHEN candidates.subject_inactive
            OR candidates.authority_superseded
            OR (
              effect.status = 'processing'
              AND effect.attempt_count >= 10
            )
          THEN NULL
          ELSE pg_catalog.statement_timestamp()
            + pg_catalog.make_interval(secs => p_lease_seconds)
        END,
        last_error = CASE
          WHEN candidates.subject_inactive THEN CASE
            WHEN effect.user_id IS NULL THEN 'subject_deleted'
            ELSE 'subject_inactive'
          END
          WHEN candidates.authority_superseded
          THEN 'authority_superseded'
          WHEN effect.status = 'processing'
            AND effect.attempt_count >= 10
          THEN 'lease_exhausted'
          ELSE NULL
        END,
        completed_at = CASE
          WHEN candidates.subject_inactive
            OR candidates.authority_superseded
            OR (
              effect.status = 'processing'
              AND effect.attempt_count >= 10
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
    OR (
      p_external_ref IS NOT NULL
      AND pg_catalog.length(pg_catalog.btrim(p_external_ref))
        NOT BETWEEN 1 AND 512
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
      'payment_manual_review'
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
  ) THEN
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

CREATE OR REPLACE FUNCTION public.stripe_paid_launch_readiness_v2()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_open_manual_reviews integer;
  v_unfinished_effects integer;
  v_completed_effects_without_external_ref integer;
  v_paid_unbound_payments integer;
  v_unresolved_refund_tombstones integer;
  v_reservation_anomalies integer;
  v_projection_drift integer;
  v_authority_drift integer;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_open_manual_reviews
  FROM public.stripe_manual_reviews AS review
  WHERE review.state = 'open';

  SELECT pg_catalog.count(*)::integer
  INTO v_unfinished_effects
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.status IN (
    'pending',
    'processing',
    'failed',
    'dead_lettered'
  );

  SELECT pg_catalog.count(*)::integer
  INTO v_completed_effects_without_external_ref
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.status = 'completed'
    AND (
      effect.external_ref IS NULL
      OR pg_catalog.length(pg_catalog.btrim(effect.external_ref)) = 0
    );

  SELECT (
    (
      SELECT pg_catalog.count(*)
      FROM public.stripe_entitlement_payments AS payment
      WHERE payment.payment_status IN ('paid', 'succeeded')
        AND NOT (
          payment.refund_state = 'succeeded'
          AND payment.refund_succeeded_amount >= payment.amount_paid
        )
        AND (
          (
            payment.payment_kind = 'lifetime'
            AND NOT EXISTS (
              SELECT 1
              FROM public.pro_entitlement_grants AS entitlement_grant
              WHERE entitlement_grant.source =
                  'stripe_lifetime_payment'
                AND entitlement_grant.source_key =
                  'payment:' || payment.id::text
                AND entitlement_grant.user_id = payment.user_id
                AND entitlement_grant.revoked_at IS NULL
                AND entitlement_grant.expires_at IS NULL
            )
          )
          OR (
            payment.payment_kind = 'recurring'
            AND payment.period_start <= v_now
            AND payment.period_end > v_now
            AND NOT EXISTS (
              SELECT 1
              FROM public.stripe_entitlement_payments AS newer_payment
              WHERE newer_payment.payment_kind = 'recurring'
                AND newer_payment.stripe_subscription_id =
                  payment.stripe_subscription_id
                AND newer_payment.period_start > payment.period_start
                AND newer_payment.period_start <= v_now
                AND NOT (
                  newer_payment.refund_state = 'succeeded'
                  AND newer_payment.refund_succeeded_amount
                    >= newer_payment.amount_paid
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.subscriptions AS subscription
              WHERE subscription.entitlement_payment_id = payment.id
                AND subscription.user_id = payment.user_id
                AND subscription.stripe_customer_id =
                  payment.stripe_customer_id
                AND subscription.stripe_subscription_id =
                  payment.stripe_subscription_id
                AND subscription.plan = payment.plan
                AND subscription.current_period_start =
                  payment.period_start
                AND subscription.current_period_end = payment.period_end
                AND subscription.status IN ('active', 'trialing')
                AND subscription.tier = 'pro'
            )
          )
        )
    )
  )::integer
  INTO v_paid_unbound_payments;

  SELECT pg_catalog.count(*)::integer
  INTO v_unresolved_refund_tombstones
  FROM public.stripe_charge_refund_tombstones AS tombstone
  WHERE tombstone.resolution_kind <> 'entitlement_payment'
    OR tombstone.merged_payment_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      WHERE payment.id = tombstone.merged_payment_id
        AND payment.stripe_charge_id = tombstone.stripe_charge_id
        AND payment.stripe_customer_id = tombstone.stripe_customer_id
        AND payment.stripe_payment_intent_id
          IS NOT DISTINCT FROM tombstone.stripe_payment_intent_id
        AND payment.amount_paid = tombstone.amount_paid
        AND payment.currency = tombstone.currency
        AND payment.refund_succeeded_amount >=
          tombstone.refund_succeeded_amount
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstone_events AS snapshot_event
      WHERE snapshot_event.event_id =
          tombstone.refund_snapshot_event_id
        AND snapshot_event.stripe_charge_id =
          tombstone.stripe_charge_id
        AND snapshot_event.event_created_at =
          tombstone.refund_snapshot_event_created_at
        AND snapshot_event.observations @>
          pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'refund_state', tombstone.refund_state,
              'refund_succeeded_amount',
                tombstone.refund_succeeded_amount
            )
          )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstone_events AS latest_event
      WHERE latest_event.event_id = tombstone.latest_refund_event_id
        AND latest_event.stripe_charge_id =
          tombstone.stripe_charge_id
        AND latest_event.event_created_at =
          tombstone.latest_refund_event_created_at
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
      WHERE tombstone_event.stripe_charge_id =
          tombstone.stripe_charge_id
        AND NOT EXISTS (
          SELECT 1
          FROM public.stripe_entitlement_refund_events AS refund_event
          WHERE refund_event.event_id = tombstone_event.event_id
            AND refund_event.entitlement_payment_id =
              tombstone.merged_payment_id
            AND refund_event.event_created_at =
              tombstone_event.event_created_at
            AND refund_event.observations @>
              tombstone_event.observations
        )
    );

  SELECT (
    (
      SELECT pg_catalog.count(*)
      FROM public.stripe_lifetime_seat_reservations AS reservation
      WHERE (
          reservation.status = 'reserved'
          AND reservation.expires_at <= v_now
        )
        OR (
          reservation.status = 'bound'
          AND reservation.expires_at <= v_now
        )
        OR (
          reservation.status = 'converted'
          AND NOT EXISTS (
            SELECT 1
            FROM public.stripe_entitlement_payments AS payment
            WHERE payment.id = reservation.converted_payment_id
              AND payment.checkout_session_id =
                reservation.checkout_session_id
              AND (
                payment.user_id = reservation.user_id
                OR payment.user_id IS NULL
              )
          )
        )
    ) + (
      -- A legacy commercial claim and a new unrefunded lifetime ledger row
      -- for the same owner are two paid representations until an operator
      -- proves they are the same sale and releases one, or the new charge is
      -- fully refunded. Never silently transfer capacity between identities.
      SELECT pg_catalog.count(*)
      FROM public.stripe_legacy_lifetime_seat_claims AS legacy_claim
      JOIN public.stripe_entitlement_payments AS payment
        ON payment.user_id = legacy_claim.user_id
       AND payment.payment_kind = 'lifetime'
      WHERE legacy_claim.status = 'claimed'
        AND NOT (
          payment.refund_state = 'succeeded'
          AND payment.refund_succeeded_amount >= payment.amount_paid
        )
    ) + GREATEST(
      public.stripe_lifetime_claimed_seat_count_v2() - 200,
      0
    )
  )::integer
  INTO v_reservation_anomalies;

  WITH expected AS (
    SELECT
      profile.id,
      profile.subscription_tier,
      profile.pro_plan,
      profile.pro_expires_at,
      profile.is_pro,
      profile.stripe_customer_id,
      public.stripe_has_current_pro_authority_v2(profile.id)
        AS has_authority,
      current_subscription.plan AS subscription_plan,
      current_subscription.stripe_customer_id
        AS subscription_customer_id,
      current_subscription.current_period_end
        AS subscription_expires_at,
      active_grants.has_permanent_grant,
      active_grants.has_lifetime_grant,
      active_grants.max_expires_at
    FROM public.user_profiles AS profile
    LEFT JOIN LATERAL (
      SELECT
        subscription.plan,
        subscription.stripe_customer_id,
        subscription.current_period_end
      FROM public.subscriptions AS subscription
      WHERE subscription.user_id = profile.id
        AND subscription.status IN ('active', 'trialing')
        AND subscription.tier = 'pro'
        AND (
          subscription.current_period_end IS NULL
          OR subscription.current_period_end > v_now
        )
        AND (
          public.stripe_subscription_has_exact_payment_binding_v2(
            profile.id
          )
          OR public.stripe_subscription_has_exact_trial_binding_v2(
            profile.id
          )
        )
      LIMIT 1
    ) AS current_subscription ON true
    LEFT JOIN LATERAL (
      SELECT
        COALESCE(
          pg_catalog.bool_or(entitlement_grant.expires_at IS NULL),
          false
        ) AS has_permanent_grant,
        COALESCE(
          pg_catalog.bool_or(
            entitlement_grant.source = 'stripe_lifetime_payment'
            OR (
              entitlement_grant.source = 'legacy_stripe_snapshot'
              AND entitlement_grant.metadata ->> 'plan' = 'lifetime'
            )
          ),
          false
        ) AS has_lifetime_grant,
        pg_catalog.max(entitlement_grant.expires_at) AS max_expires_at
      FROM public.pro_entitlement_grants AS entitlement_grant
      WHERE entitlement_grant.user_id = profile.id
        AND entitlement_grant.revoked_at IS NULL
        AND entitlement_grant.starts_at <= v_now
        AND (
          entitlement_grant.expires_at IS NULL
          OR entitlement_grant.expires_at > v_now
        )
    ) AS active_grants ON true
    WHERE profile.deleted_at IS NULL
  )
  SELECT pg_catalog.count(*)::integer
  INTO v_projection_drift
  FROM expected
  WHERE (
      NOT has_authority
      AND (
        COALESCE(is_pro, false)
        OR subscription_tier IS DISTINCT FROM 'free'
        OR pro_plan IS NOT NULL
        OR pro_expires_at IS NOT NULL
      )
    )
    OR (
      has_authority
      AND (
        NOT COALESCE(is_pro, false)
        OR subscription_tier IS DISTINCT FROM 'pro'
        OR pro_plan IS DISTINCT FROM CASE
          WHEN subscription_plan IS NOT NULL THEN subscription_plan
          WHEN has_lifetime_grant THEN 'lifetime'
          ELSE NULL
        END
        OR pro_expires_at IS DISTINCT FROM CASE
          WHEN subscription_expires_at IS NULL
            AND subscription_plan IS NOT NULL
          THEN NULL
          WHEN has_permanent_grant THEN NULL
          WHEN subscription_expires_at IS NOT NULL
          THEN GREATEST(
            subscription_expires_at,
            max_expires_at
          )
          ELSE max_expires_at
        END
        OR (
          subscription_customer_id IS NOT NULL
          AND stripe_customer_id IS DISTINCT FROM
            subscription_customer_id
        )
      )
    );

  SELECT pg_catalog.count(*)::integer
  INTO v_authority_drift
  FROM (
    SELECT subscription.user_id, 'subscription'::text AS drift_kind
    FROM public.subscriptions AS subscription
    WHERE subscription.status IN ('active', 'trialing')
      AND subscription.tier = 'pro'
      AND (
        subscription.current_period_end IS NULL
        OR subscription.current_period_end > v_now
      )
      AND NOT (
        public.stripe_subscription_has_exact_payment_binding_v2(
          subscription.user_id
        )
        OR public.stripe_subscription_has_exact_trial_binding_v2(
          subscription.user_id
        )
        OR EXISTS (
          SELECT 1
          FROM public.pro_entitlement_grants AS entitlement_grant
          WHERE entitlement_grant.user_id = subscription.user_id
            AND entitlement_grant.source = 'legacy_stripe_snapshot'
            AND entitlement_grant.source_key =
              'subscription:' || subscription.id::text
            AND public.stripe_legacy_snapshot_grant_is_exact_v2(
              entitlement_grant.id
            )
            AND entitlement_grant.revoked_at IS NULL
            AND entitlement_grant.starts_at <= v_now
            AND (
              entitlement_grant.expires_at IS NULL
              OR entitlement_grant.expires_at > v_now
            )
        )
      )
    UNION ALL
    SELECT entitlement_grant.user_id, 'orphan_legacy_snapshot'
    FROM public.pro_entitlement_grants AS entitlement_grant
    WHERE entitlement_grant.source = 'legacy_stripe_snapshot'
      AND entitlement_grant.revoked_at IS NULL
      AND entitlement_grant.starts_at <= v_now
      AND (
        entitlement_grant.expires_at IS NULL
        OR entitlement_grant.expires_at > v_now
      )
      AND NOT public.stripe_legacy_snapshot_grant_is_exact_v2(
        entitlement_grant.id
      )
    UNION ALL
    SELECT entitlement_grant.user_id, 'rolling_legacy_snapshot'
    FROM public.pro_entitlement_grants AS entitlement_grant
    WHERE entitlement_grant.source = 'legacy_stripe_snapshot'
      AND entitlement_grant.revoked_at IS NULL
      AND entitlement_grant.metadata ->> 'migration' =
        '20260718183000_rolling_legacy_writer'
    UNION ALL
    SELECT entitlement_grant.user_id, 'lifetime_grant'
    FROM public.pro_entitlement_grants AS entitlement_grant
    WHERE entitlement_grant.source = 'stripe_lifetime_payment'
      AND entitlement_grant.revoked_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.stripe_entitlement_payments AS payment
        WHERE entitlement_grant.source_key =
            'payment:' || payment.id::text
          AND payment.user_id = entitlement_grant.user_id
          AND payment.payment_kind = 'lifetime'
          AND NOT (
            payment.refund_state = 'succeeded'
            AND payment.refund_succeeded_amount >= payment.amount_paid
          )
      )
    UNION ALL
    SELECT trial.user_id, 'orphan_trial'
    FROM public.stripe_trial_entitlements AS trial
    WHERE trial.revoked_at IS NULL
      AND trial.period_end > v_now
      AND NOT EXISTS (
        SELECT 1
        FROM public.subscriptions AS subscription
        WHERE subscription.entitlement_trial_id = trial.id
          AND subscription.user_id = trial.user_id
          AND subscription.status = 'trialing'
          AND subscription.tier = 'pro'
      )
  ) AS drift;

  RETURN pg_catalog.jsonb_build_object(
    'status',
    CASE
      WHEN v_open_manual_reviews = 0
        AND v_unfinished_effects = 0
        AND v_completed_effects_without_external_ref = 0
        AND v_paid_unbound_payments = 0
        AND v_unresolved_refund_tombstones = 0
        AND v_reservation_anomalies = 0
        AND v_projection_drift = 0
        AND v_authority_drift = 0
      THEN 'ready'
      ELSE 'blocked'
    END,
    'open_manual_reviews', v_open_manual_reviews,
    'unfinished_effects', v_unfinished_effects,
    'completed_effects_without_external_ref',
      v_completed_effects_without_external_ref,
    'paid_unbound_payments', v_paid_unbound_payments,
    'unresolved_refund_tombstones',
      v_unresolved_refund_tombstones,
    'reservation_anomalies', v_reservation_anomalies,
    'projection_drift', v_projection_drift,
    'authority_drift', v_authority_drift
  );
END
$function$;

ALTER FUNCTION public.stripe_paid_launch_readiness_v2()
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.stripe_paid_launch_readiness_v2()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.stripe_paid_launch_readiness_v2()
  TO service_role;

REVOKE ALL ON FUNCTION public.stripe_lifetime_claimed_seat_count_v2()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

REVOKE ALL ON FUNCTION
  public.stripe_legacy_snapshot_grant_is_exact_v2(uuid)
FROM PUBLIC, anon, authenticated, service_role, authenticator;

REVOKE ALL ON FUNCTION public.check_lifetime_spots_available(integer)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.check_lifetime_spots_available(integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.activate_lifetime_membership(uuid, text)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.activate_lifetime_membership(uuid, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.record_stripe_manual_review_atomic(
  text, text, uuid, text, text, jsonb
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.record_stripe_manual_review_atomic(
  text, text, uuid, text, text, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.bind_stripe_customer_owner_atomic(
  uuid, text, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.bind_stripe_customer_owner_atomic(
  uuid, text, text
) TO service_role;

REVOKE ALL ON FUNCTION public.record_charge_refund_tombstone_atomic(
  uuid, text, text, text, boolean, bigint, text, bigint, text, text,
  timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.record_charge_refund_tombstone_atomic(
  uuid, text, text, text, boolean, bigint, text, bigint, text, text,
  timestamptz
) TO service_role;

REVOKE ALL ON FUNCTION
  public.stripe_merge_charge_refund_tombstone_v2(uuid)
FROM PUBLIC, anon, authenticated, service_role, authenticator;

REVOKE ALL ON FUNCTION public.reserve_lifetime_membership_spot_atomic(
  uuid, text, integer
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.reserve_lifetime_membership_spot_atomic(
  uuid, text, integer
) TO service_role;

REVOKE ALL ON FUNCTION
  public.bind_lifetime_membership_reservation_session_atomic(
    uuid, uuid, text, text, timestamptz
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.bind_lifetime_membership_reservation_session_atomic(
    uuid, uuid, text, text, timestamptz
  )
TO service_role;

REVOKE ALL ON FUNCTION
  public.release_lifetime_membership_reservation_atomic(
    uuid, uuid, text, text, text, text, timestamptz
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.release_lifetime_membership_reservation_atomic(
    uuid, uuid, text, text, text, text, timestamptz
  )
TO service_role;

REVOKE ALL ON FUNCTION
  public.stripe_subscription_has_exact_payment_binding_v2(uuid)
FROM PUBLIC, anon, authenticated, service_role, authenticator;

REVOKE ALL ON FUNCTION
  public.stripe_subscription_has_exact_trial_binding_v2(uuid)
FROM PUBLIC, anon, authenticated, service_role, authenticator;

REVOKE ALL ON FUNCTION public.stripe_has_current_pro_authority_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

REVOKE ALL ON FUNCTION public.sync_current_pro_projection_atomic(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.sync_current_pro_projection_atomic(uuid)
  TO service_role;

REVOKE ALL ON FUNCTION
  public.reconcile_due_pro_entitlement_projections_atomic(integer, uuid)
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.reconcile_due_pro_entitlement_projections_atomic(integer, uuid)
TO service_role;

REVOKE ALL ON FUNCTION public.upsert_pro_entitlement_grant_atomic(
  uuid, text, text, timestamptz, timestamptz, jsonb
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.upsert_pro_entitlement_grant_atomic(
  uuid, text, text, timestamptz, timestamptz, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.grant_pro_entitlement_days_atomic(
  uuid, text, text, integer, timestamptz, jsonb
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.grant_pro_entitlement_days_atomic(
  uuid, text, text, integer, timestamptz, jsonb
) TO service_role;

REVOKE ALL ON FUNCTION public.revoke_pro_entitlement_grant_atomic(
  uuid, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.revoke_pro_entitlement_grant_atomic(
  uuid, text, text, timestamptz
) TO service_role;

REVOKE ALL ON FUNCTION public.activate_recurring_entitlement_payment_atomic(
  uuid, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.activate_recurring_entitlement_payment_atomic(
  uuid, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, text
) TO service_role;

REVOKE ALL ON FUNCTION public.activate_recurring_trial_entitlement_atomic(
  uuid, text, text, text, timestamptz, timestamptz, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.activate_recurring_trial_entitlement_atomic(
  uuid, text, text, text, timestamptz, timestamptz, text
) TO service_role;

REVOKE ALL ON FUNCTION
  public.reconcile_recurring_subscription_state_atomic(
    uuid, text, text, text, text, timestamptz, timestamptz, text,
    boolean, timestamptz, timestamptz, text, timestamptz
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.reconcile_recurring_subscription_state_atomic(
    uuid, text, text, text, text, timestamptz, timestamptz, text,
    boolean, timestamptz, timestamptz, text, timestamptz
  )
TO service_role;

REVOKE ALL ON FUNCTION public.activate_lifetime_membership_with_identity_atomic(
  uuid, text, text, uuid, text, text, bigint, text, timestamptz, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.activate_lifetime_membership_with_identity_atomic(
  uuid, text, text, uuid, text, text, bigint, text, timestamptz, text
) TO service_role;

REVOKE ALL ON FUNCTION public.reconcile_stripe_entitlement_refund_atomic(
  uuid, text, text, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, bigint, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.reconcile_stripe_entitlement_refund_atomic(
  uuid, text, text, text, text, text, text, text, text, bigint, text,
  timestamptz, timestamptz, text, bigint, text, text, text, timestamptz
) TO service_role;

REVOKE ALL ON FUNCTION public.stripe_entitlement_effect_is_current_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

REVOKE ALL ON FUNCTION public.lease_stripe_entitlement_effects_atomic(
  integer, integer
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.lease_stripe_entitlement_effects_atomic(
  integer, integer
) TO service_role;

REVOKE ALL ON FUNCTION public.finish_stripe_entitlement_effect_atomic(
  uuid, uuid, boolean, text, text, integer
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.finish_stripe_entitlement_effect_atomic(
  uuid, uuid, boolean, text, text, integer
) TO service_role;

DO $postflight$
DECLARE
  v_function pg_catalog.regprocedure;
  v_relation pg_catalog.regclass;
  v_postgres oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
  v_service_role oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
  v_expected_return oid;
BEGIN
  IF v_postgres IS NULL OR v_service_role IS NULL THEN
    RAISE EXCEPTION 'required database roles are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.uq_payment_history_invoice_conflict_target'::pg_catalog.regclass,
          'public.payment_history'::pg_catalog.regclass,
          'stripe_invoice_id'::name
        ),
        (
          'public.uq_payment_history_pi_conflict_target'::pg_catalog.regclass,
          'public.payment_history'::pg_catalog.regclass,
          'stripe_payment_intent_id'::name
        ),
        (
          'public.idx_subscriptions_user_id'::pg_catalog.regclass,
          'public.subscriptions'::pg_catalog.regclass,
          'user_id'::name
        ),
        (
          'public.uq_subscriptions_stripe_subscription_identity'::pg_catalog.regclass,
          'public.subscriptions'::pg_catalog.regclass,
          'stripe_subscription_id'::name
        ),
        (
          'public.uq_user_profiles_stripe_customer_identity'::pg_catalog.regclass,
          'public.user_profiles'::pg_catalog.regclass,
          'stripe_customer_id'::name
        )
    ) AS required_index(index_oid, relation_oid, column_name)
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = required_index.index_oid
    WHERE NOT index_row.indisunique
       OR NOT index_row.indisvalid
       OR NOT index_row.indisready
       OR index_row.indpred IS NOT NULL
       OR index_row.indexprs IS NOT NULL
       OR index_row.indnkeyatts <> 1
       OR index_row.indkey[0] <> (
         SELECT attribute.attnum
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = required_index.relation_oid
           AND attribute.attname = required_index.column_name
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
       )
  ) THEN
    RAISE EXCEPTION 'Stripe identity conflict-target indexes drifted';
  END IF;

  IF to_regclass('public.stripe_entitlement_payments') IS NULL
    OR to_regclass('public.stripe_charge_refund_tombstones') IS NULL
    OR to_regclass('public.stripe_charge_refund_tombstone_events') IS NULL
    OR to_regclass('public.stripe_lifetime_seat_reservations') IS NULL
    OR to_regclass('public.stripe_legacy_lifetime_seat_claims') IS NULL
    OR to_regclass('public.stripe_trial_entitlements') IS NULL
    OR to_regclass('public.stripe_subscription_state_events') IS NULL
    OR to_regclass('public.pro_entitlement_grants') IS NULL
    OR to_regclass('public.stripe_manual_reviews') IS NULL
    OR to_regclass('public.stripe_entitlement_refund_events') IS NULL
    OR to_regclass('public.stripe_entitlement_effects') IS NULL
    OR to_regclass('public.stripe_entitlement_payments_invoice_key') IS NULL
    OR to_regclass('public.stripe_entitlement_payments_session_key') IS NULL
    OR to_regclass(
      'public.stripe_charge_refund_tombstones_payment_key'
    ) IS NULL
    OR to_regclass(
      'public.stripe_lifetime_seat_reservations_active_user_key'
    ) IS NULL
    OR to_regclass(
      'public.stripe_lifetime_seat_reservations_session_key'
    ) IS NULL
    OR to_regclass(
      'public.stripe_lifetime_seat_reservations_payment_key'
    ) IS NULL
    OR to_regclass(
      'public.stripe_lifetime_seat_reservations_release_event_key'
    ) IS NULL
    OR to_regclass(
      'public.stripe_legacy_lifetime_seat_claims_stripe_subscription_key'
    ) IS NULL
    OR to_regclass('public.stripe_trial_entitlements_identity_version_key')
      IS NULL
    OR to_regclass('public.subscriptions_entitlement_payment_key') IS NULL
    OR to_regclass('public.subscriptions_entitlement_trial_key') IS NULL
    OR to_regclass('public.stripe_entitlement_effects_expired_processing_idx')
      IS NULL
    OR to_regclass('public.pro_entitlement_grants_due_start_idx') IS NULL
    OR to_regclass('public.user_profiles_pro_projection_due_idx') IS NULL
  THEN
    RAISE EXCEPTION 'Stripe entitlement authority schema is incomplete';
  END IF;

  IF pg_catalog.pg_get_functiondef(
      'public.activate_lifetime_membership(uuid,text)'::pg_catalog.regprocedure
    ) NOT LIKE '%stripe-lifetime-seat-capacity%'
    OR pg_catalog.pg_get_functiondef(
      'public.activate_lifetime_membership(uuid,text)'::pg_catalog.regprocedure
    ) NOT LIKE '%stripe_lifetime_claimed_seat_count_v2%'
    OR pg_catalog.pg_get_functiondef(
      'public.check_lifetime_spots_available(integer)'::pg_catalog.regprocedure
    ) NOT LIKE '%RETURN false;%'
    OR pg_catalog.pg_get_functiondef(
      'public.check_lifetime_spots_available(integer)'::pg_catalog.regprocedure
    ) LIKE '%stripe_lifetime_claimed_seat_count_v2%'
    OR NOT pg_catalog.has_function_privilege(
      'service_role',
      'public.activate_lifetime_membership(uuid,text)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'service_role',
      'public.check_lifetime_spots_available(integer)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION
      'rolling-deploy lifetime boundary is not fail-closed and capacity-safe';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.subscriptions'::pg_catalog.regclass
      AND constraint_row.conname =
        'subscriptions_entitlement_payment_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid =
        'public.stripe_entitlement_payments'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'r'
      AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'subscription payment authority foreign key drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.subscriptions'::pg_catalog.regclass
      AND constraint_row.conname =
        'subscriptions_entitlement_trial_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid =
        'public.stripe_trial_entitlements'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'n'
      AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'subscription trial authority foreign key drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.stripe_entitlement_payments'::pg_catalog.regclass,
          'stripe_entitlement_payments_user_id_fkey'::name,
          'n'::"char"
        ),
        (
          'public.stripe_trial_entitlements'::pg_catalog.regclass,
          'stripe_trial_entitlements_user_id_fkey'::name,
          'c'::"char"
        ),
        (
          'public.stripe_subscription_state_events'::pg_catalog.regclass,
          'stripe_subscription_state_events_user_id_fkey'::name,
          'n'::"char"
        ),
        (
          'public.pro_entitlement_grants'::pg_catalog.regclass,
          'pro_entitlement_grants_user_id_fkey'::name,
          'c'::"char"
        ),
        (
          'public.stripe_manual_reviews'::pg_catalog.regclass,
          'stripe_manual_reviews_user_id_fkey'::name,
          'n'::"char"
        ),
        (
          'public.stripe_entitlement_refund_events'::pg_catalog.regclass,
          'stripe_entitlement_refund_events_user_id_fkey'::name,
          'n'::"char"
        ),
        (
          'public.stripe_entitlement_effects'::pg_catalog.regclass,
          'stripe_entitlement_effects_user_id_fkey'::name,
          'n'::"char"
        )
    ) AS required_fk(relation_oid, constraint_name, delete_action)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = required_fk.relation_oid
        AND constraint_row.conname = required_fk.constraint_name
        AND constraint_row.contype = 'f'
        AND constraint_row.confrelid =
          'public.user_profiles'::pg_catalog.regclass
        AND constraint_row.confdeltype = required_fk.delete_action
        AND constraint_row.convalidated
    )
  ) THEN
    RAISE EXCEPTION 'Stripe authority subject delete actions drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.stripe_lifetime_seat_reservations'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid =
        'public.user_profiles'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION
      'payable lifetime reservation identity must survive profile deletion';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.stripe_legacy_lifetime_seat_claims'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid =
        'public.user_profiles'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION
      'durable legacy lifetime seat claim must survive profile deletion';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.stripe_lifetime_seat_reservations'::pg_catalog.regclass
      AND constraint_row.conname =
        'stripe_lifetime_seat_reservations_converted_payment_id_fkey'
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid =
        'public.stripe_entitlement_payments'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'r'
      AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'lifetime reservation payment conversion FK drifted';
  END IF;

  IF pg_catalog.pg_get_functiondef(
    'public.stripe_has_current_pro_authority_v2(uuid)'::pg_catalog.regprocedure
  ) NOT LIKE '%public.pro_entitlement_grants%'
    OR pg_catalog.pg_get_functiondef(
      'public.stripe_has_current_pro_authority_v2(uuid)'::pg_catalog.regprocedure
    ) NOT LIKE '%entitlement_payment_id%'
    OR pg_catalog.pg_get_functiondef(
      'public.stripe_has_current_pro_authority_v2(uuid)'::pg_catalog.regprocedure
    ) LIKE '%profile_entitlement.subscription_tier%'
  THEN
    RAISE EXCEPTION 'Stripe v2 Pro authority still trusts profile flags';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.stripe_subscription_has_exact_payment_binding_v2(uuid)'::pg_catalog.regprocedure,
    'public.stripe_subscription_has_exact_trial_binding_v2(uuid)'::pg_catalog.regprocedure,
    'public.stripe_has_current_pro_authority_v2(uuid)'::pg_catalog.regprocedure,
    'public.stripe_entitlement_effect_is_current_v2(uuid)'::pg_catalog.regprocedure,
    'public.stripe_lifetime_claimed_seat_count_v2()'::pg_catalog.regprocedure,
    'public.stripe_legacy_snapshot_grant_is_exact_v2(uuid)'::pg_catalog.regprocedure,
    'public.stripe_merge_charge_refund_tombstone_v2(uuid)'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND function_row.proowner = v_postgres
        AND function_row.prosecdef
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
      WHERE function_row.oid = v_function
        AND acl_row.grantee <> v_postgres
    ) THEN
      RAISE EXCEPTION 'Stripe v2 authority helper is not owner-only: %',
        v_function;
    END IF;
  END LOOP;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.stripe_entitlement_payments'::pg_catalog.regclass,
    'public.stripe_charge_refund_tombstones'::pg_catalog.regclass,
    'public.stripe_charge_refund_tombstone_events'::pg_catalog.regclass,
    'public.stripe_lifetime_seat_reservations'::pg_catalog.regclass,
    'public.stripe_legacy_lifetime_seat_claims'::pg_catalog.regclass,
    'public.stripe_trial_entitlements'::pg_catalog.regclass,
    'public.stripe_subscription_state_events'::pg_catalog.regclass,
    'public.pro_entitlement_grants'::pg_catalog.regclass,
    'public.stripe_manual_reviews'::pg_catalog.regclass,
    'public.stripe_entitlement_refund_events'::pg_catalog.regclass,
    'public.stripe_entitlement_effects'::pg_catalog.regclass
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation_row
      WHERE relation_row.oid = v_relation
        AND relation_row.relowner = v_postgres
        AND relation_row.relrowsecurity
        AND relation_row.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'server-only Stripe relation security drifted: %',
        v_relation;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation_row.relacl,
          pg_catalog.acldefault('r', relation_row.relowner)
        )
      ) AS acl_row
      WHERE relation_row.oid = v_relation
        AND acl_row.grantee NOT IN (v_postgres, v_service_role)
    ) THEN
      RAISE EXCEPTION 'unknown Stripe relation ACL grantee: %', v_relation;
    END IF;
    IF NOT pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      'SELECT'
    ) OR pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) THEN
      RAISE EXCEPTION 'service-role Stripe relation privilege drifted: %',
        v_relation;
    END IF;
  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    'public.stripe_paid_launch_readiness_v2()'::pg_catalog.regprocedure,
    'public.record_stripe_manual_review_atomic(text,text,uuid,text,text,jsonb)'::pg_catalog.regprocedure,
    'public.bind_stripe_customer_owner_atomic(uuid,text,text)'::pg_catalog.regprocedure,
    'public.record_charge_refund_tombstone_atomic(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.reserve_lifetime_membership_spot_atomic(uuid,text,integer)'::pg_catalog.regprocedure,
    'public.bind_lifetime_membership_reservation_session_atomic(uuid,uuid,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.release_lifetime_membership_reservation_atomic(uuid,uuid,text,text,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.sync_current_pro_projection_atomic(uuid)'::pg_catalog.regprocedure,
    'public.reconcile_due_pro_entitlement_projections_atomic(integer,uuid)'::pg_catalog.regprocedure,
    'public.upsert_pro_entitlement_grant_atomic(uuid,text,text,timestamp with time zone,timestamp with time zone,jsonb)'::pg_catalog.regprocedure,
    'public.grant_pro_entitlement_days_atomic(uuid,text,text,integer,timestamp with time zone,jsonb)'::pg_catalog.regprocedure,
    'public.revoke_pro_entitlement_grant_atomic(uuid,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.activate_recurring_entitlement_payment_atomic(uuid,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text)'::pg_catalog.regprocedure,
    'public.activate_recurring_trial_entitlement_atomic(uuid,text,text,text,timestamp with time zone,timestamp with time zone,text)'::pg_catalog.regprocedure,
    'public.reconcile_recurring_subscription_state_atomic(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.activate_lifetime_membership_with_identity_atomic(uuid,text,text,uuid,text,text,bigint,text,timestamp with time zone,text)'::pg_catalog.regprocedure,
    'public.reconcile_stripe_entitlement_refund_atomic(uuid,text,text,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,bigint,text,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)'::pg_catalog.regprocedure
  ]
  LOOP
    v_expected_return := CASE
      WHEN v_function =
        'public.sync_current_pro_projection_atomic(uuid)'::pg_catalog.regprocedure
      THEN 'boolean'::pg_catalog.regtype
      ELSE 'jsonb'::pg_catalog.regtype
    END;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND function_row.proowner = v_postgres
        AND function_row.prosecdef
        AND function_row.prorettype = v_expected_return
        AND function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
    ) THEN
      RAISE EXCEPTION 'Stripe authority function security drifted: %',
        v_function;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
      WHERE function_row.oid = v_function
        AND acl_row.grantee NOT IN (v_postgres, v_service_role)
    ) OR NOT pg_catalog.has_function_privilege(
      'service_role',
      v_function,
      'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'Stripe authority function ACL drifted: %',
        v_function;
    END IF;
  END LOOP;

  v_function :=
    'public.lease_stripe_entitlement_effects_atomic(integer,integer)'::pg_catalog.regprocedure;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres
      AND function_row.prosecdef
      AND function_row.proretset
      AND function_row.prorettype =
        'public.stripe_entitlement_effects'::pg_catalog.regtype
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_row
    WHERE function_row.oid = v_function
      AND acl_row.grantee NOT IN (v_postgres, v_service_role)
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_function,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'Stripe effect lease function security drifted';
  END IF;
END
$postflight$;

COMMIT;
