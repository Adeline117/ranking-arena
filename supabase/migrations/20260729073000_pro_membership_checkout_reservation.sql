-- Durable admission and exact Stripe identity for ordinary B2C Pro Checkout.
--
-- An application-side subscription scan cannot serialize two open Checkout
-- Sessions.  This reservation is therefore the only admission authority.  A
-- reservation that may have reached Stripe is never released by an unsigned
-- request or a local clock; only an exact signed Stripe lifecycle event can
-- make the user eligible for another checkout.

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
    VALUES
      ('postgres'::text),
      ('anon'::text),
      ('authenticated'::text),
      ('service_role'::text),
      ('authenticator'::text)
  ) AS required(required_role)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required.required_role
  );
  IF v_missing IS NOT NULL THEN
    RAISE EXCEPTION 'missing required Supabase roles: %', v_missing;
  END IF;

  IF pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.subscriptions') IS NULL
    OR pg_catalog.to_regclass('public.stripe_trial_entitlements') IS NULL
    OR pg_catalog.to_regclass('public.stripe_subscription_state_events') IS NULL
  THEN
    RAISE EXCEPTION 'Pro checkout authority requires profile, subscription, and trial ledgers';
  END IF;

  IF EXISTS (
    SELECT required.column_name
    FROM (
      VALUES
        ('user_profiles'::text, 'id'::text),
        ('user_profiles', 'stripe_customer_id'),
        ('user_profiles', 'stripe_subscription_id'),
        ('user_profiles', 'subscription_tier'),
        ('user_profiles', 'is_pro'),
        ('user_profiles', 'deleted_at'),
        ('user_profiles', 'banned_at'),
        ('user_profiles', 'is_banned'),
        ('subscriptions', 'user_id'),
        ('subscriptions', 'stripe_customer_id'),
        ('subscriptions', 'stripe_subscription_id'),
        ('subscriptions', 'status'),
        ('subscriptions', 'tier'),
        ('subscriptions', 'plan'),
        ('stripe_trial_entitlements', 'user_id'),
        ('stripe_subscription_state_events', 'user_id'),
        ('stripe_subscription_state_events', 'stripe_customer_id'),
        ('stripe_subscription_state_events', 'stripe_subscription_id'),
        ('stripe_subscription_state_events', 'plan'),
        ('stripe_subscription_state_events', 'stripe_status'),
        ('stripe_subscription_state_events', 'event_created_at'),
        ('stripe_subscription_state_events', 'event_id')
    ) AS required(table_name, column_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
          'public.' || required.table_name
        )
        AND attribute.attname = required.column_name
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'Pro checkout authority dependency columns drifted';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.pro_membership_checkout_reservations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  livemode boolean NOT NULL,
  stripe_customer_id text NOT NULL,
  pro_plan text NOT NULL,
  stripe_price_id text NOT NULL,
  unit_amount bigint NOT NULL,
  currency text NOT NULL,
  trial_days smallint NOT NULL,
  success_url text NOT NULL,
  cancel_url text NOT NULL,
  status text NOT NULL,
  checkout_expires_at bigint NOT NULL,
  checkout_session_id text,
  stripe_subscription_id text,
  completion_payment_status text,
  subscription_status text,
  trial_start bigint,
  trial_end bigint,
  terminal_event_id text,
  terminal_event_created bigint,
  created_at timestamp with time zone NOT NULL,
  updated_at timestamp with time zone NOT NULL,
  released_at timestamp with time zone,
  converted_at timestamp with time zone,
  CONSTRAINT pro_membership_checkout_reservations_customer_check
    CHECK (
      stripe_customer_id = pg_catalog.btrim(stripe_customer_id)
      AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_customer_id) <= 255
    ),
  CONSTRAINT pro_membership_checkout_reservations_plan_check
    CHECK (pro_plan IN ('monthly', 'yearly')),
  CONSTRAINT pro_membership_checkout_reservations_price_check
    CHECK (
      stripe_price_id = pg_catalog.btrim(stripe_price_id)
      AND stripe_price_id ~ '^price_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_price_id) <= 255
    ),
  CONSTRAINT pro_membership_checkout_reservations_amount_check
    CHECK (
      currency = 'usd'
      AND (
        (pro_plan = 'monthly' AND unit_amount = 499)
        OR (pro_plan = 'yearly' AND unit_amount = 2999)
      )
    ),
  CONSTRAINT pro_membership_checkout_reservations_trial_check
    CHECK (trial_days IN (0, 7)),
  CONSTRAINT pro_membership_checkout_reservations_url_check
    CHECK (
      success_url = pg_catalog.btrim(success_url)
      AND cancel_url = pg_catalog.btrim(cancel_url)
      AND success_url ~ '^https://[^[:space:]]+$'
      AND cancel_url ~ '^https://[^[:space:]]+$'
      AND pg_catalog.length(success_url) <= 2048
      AND pg_catalog.length(cancel_url) <= 2048
    ),
  CONSTRAINT pro_membership_checkout_reservations_time_check
    CHECK (
      created_at = pg_catalog.date_trunc('second', created_at)
      AND updated_at >= created_at
      AND checkout_expires_at =
        pg_catalog.floor(extract(epoch FROM created_at))::bigint + 2700
      AND checkout_expires_at <= 253402300799
    ),
  CONSTRAINT pro_membership_checkout_reservations_session_check
    CHECK (
      checkout_session_id IS NULL
      OR (
        checkout_session_id = pg_catalog.btrim(checkout_session_id)
        AND checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'
        AND pg_catalog.length(checkout_session_id) <= 255
      )
    ),
  CONSTRAINT pro_membership_checkout_reservations_subscription_check
    CHECK (
      stripe_subscription_id IS NULL
      OR (
        stripe_subscription_id = pg_catalog.btrim(stripe_subscription_id)
        AND stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
        AND pg_catalog.length(stripe_subscription_id) <= 255
      )
    ),
  CONSTRAINT pro_membership_checkout_reservations_event_check
    CHECK (
      terminal_event_id IS NULL
      OR (
        terminal_event_id = pg_catalog.btrim(terminal_event_id)
        AND terminal_event_id ~ '^(evt|obs)_[A-Za-z0-9_]+$'
        AND pg_catalog.length(terminal_event_id) <= 255
        AND terminal_event_created > 0
        AND terminal_event_created <= 253402300799
      )
    ),
  CONSTRAINT pro_membership_checkout_reservations_conversion_terms_check
    CHECK (
      (
        status IN ('reserved', 'bound', 'released')
        AND completion_payment_status IS NULL
        AND subscription_status IS NULL
        AND trial_start IS NULL
        AND trial_end IS NULL
      )
      OR (
        status IN ('converted', 'retired')
        AND (
          (
            trial_days = 0
            AND completion_payment_status = 'paid'
            AND subscription_status IN (
              'active', 'past_due', 'unpaid', 'paused',
              'canceled', 'incomplete_expired'
            )
            AND trial_start IS NULL
            AND trial_end IS NULL
          )
          OR (
            trial_days = 7
            AND completion_payment_status = 'no_payment_required'
            AND subscription_status IN (
              'trialing', 'active', 'past_due', 'unpaid', 'paused',
              'canceled', 'incomplete_expired'
            )
            AND trial_start > 0
            AND trial_end::numeric = trial_start::numeric + 604800
            AND trial_end <= 253402300799
          )
        )
      )
    ),
  CONSTRAINT pro_membership_checkout_reservations_state_check
    CHECK (
      (
        status = 'reserved'
        AND checkout_session_id IS NULL
        AND stripe_subscription_id IS NULL
        AND terminal_event_id IS NULL
        AND terminal_event_created IS NULL
        AND released_at IS NULL
        AND converted_at IS NULL
      )
      OR (
        status = 'bound'
        AND checkout_session_id IS NOT NULL
        AND stripe_subscription_id IS NULL
        AND terminal_event_id IS NULL
        AND terminal_event_created IS NULL
        AND released_at IS NULL
        AND converted_at IS NULL
      )
      OR (
        status = 'converted'
        AND checkout_session_id IS NOT NULL
        AND stripe_subscription_id IS NOT NULL
        AND terminal_event_id IS NOT NULL
        AND terminal_event_created IS NOT NULL
        AND released_at IS NULL
        AND converted_at IS NOT NULL
      )
      OR (
        status = 'released'
        AND (
          (terminal_event_id LIKE 'evt_%' AND checkout_session_id IS NOT NULL)
          OR (
            terminal_event_id LIKE 'obs_pro_expired_%'
            AND checkout_session_id IS NOT NULL
          )
          OR (
            terminal_event_id LIKE 'obs_pro_absent_%'
            AND checkout_session_id IS NULL
          )
        )
        AND stripe_subscription_id IS NULL
        AND terminal_event_id IS NOT NULL
        AND terminal_event_created IS NOT NULL
        AND released_at IS NOT NULL
        AND converted_at IS NULL
      )
      OR (
        status = 'retired'
        AND checkout_session_id IS NOT NULL
        AND stripe_subscription_id IS NOT NULL
        AND terminal_event_id IS NOT NULL
        AND terminal_event_created IS NOT NULL
        AND released_at IS NOT NULL
        AND converted_at IS NOT NULL
      )
    )
);

ALTER TABLE public.pro_membership_checkout_reservations OWNER TO postgres;
ALTER TABLE public.pro_membership_checkout_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pro_membership_checkout_reservations NO FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS
  pro_membership_checkout_reservations_active_user_mode_idx
  ON public.pro_membership_checkout_reservations (user_id, livemode)
  WHERE status IN ('reserved', 'bound', 'converted');
CREATE UNIQUE INDEX IF NOT EXISTS
  pro_membership_checkout_reservations_active_customer_mode_idx
  ON public.pro_membership_checkout_reservations (
    stripe_customer_id,
    livemode
  )
  WHERE status IN ('reserved', 'bound', 'converted');
CREATE UNIQUE INDEX IF NOT EXISTS
  pro_membership_checkout_reservations_session_mode_idx
  ON public.pro_membership_checkout_reservations (livemode, checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS
  pro_membership_checkout_reservations_subscription_mode_idx
  ON public.pro_membership_checkout_reservations (livemode, stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS
  pro_membership_checkout_reservations_event_mode_idx
  ON public.pro_membership_checkout_reservations (livemode, terminal_event_id)
  WHERE terminal_event_id IS NOT NULL;

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
AS $function$
DECLARE
  v_profile record;
  v_reservation public.pro_membership_checkout_reservations%ROWTYPE;
  v_created_at timestamp with time zone;
  v_profile_has_exact_terminal boolean := false;
  v_active_reservation_count integer := 0;
BEGIN
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id <> pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_pro_plan NOT IN ('monthly', 'yearly')
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id <> pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_currency IS DISTINCT FROM 'usd'
    OR (p_pro_plan = 'monthly' AND p_unit_amount IS DISTINCT FROM 499)
    OR (p_pro_plan = 'yearly' AND p_unit_amount IS DISTINCT FROM 2999)
    OR p_trial_days NOT IN (0, 7)
    OR p_success_url IS NULL
    OR p_success_url <> pg_catalog.btrim(p_success_url)
    OR p_success_url !~ '^https://[^[:space:]]+$'
    OR pg_catalog.length(p_success_url) > 2048
    OR p_cancel_url IS NULL
    OR p_cancel_url <> pg_catalog.btrim(p_cancel_url)
    OR p_cancel_url !~ '^https://[^[:space:]]+$'
    OR pg_catalog.length(p_cancel_url) > 2048
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid Pro membership checkout reservation input';
  END IF;

  -- Shared paid-entitlement lock order: global group, user, Customer.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('stripe-customer-owner:' || p_stripe_customer_id, 0)
  );

  SELECT
    profile.stripe_customer_id,
    profile.stripe_subscription_id,
    profile.subscription_tier,
    profile.is_pro,
    profile.deleted_at,
    profile.banned_at,
    profile.is_banned
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'Pro membership checkout owner profile does not exist';
  END IF;
  IF v_profile.deleted_at IS NOT NULL
    OR v_profile.banned_at IS NOT NULL
    OR COALESCE(v_profile.is_banned, false)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'inactive Pro membership checkout owner';
  END IF;
  IF v_profile.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'Pro membership checkout customer ownership drifted';
  END IF;

  -- Lock every local membership projection before deciding admission.  The
  -- profile fields are intentionally checked too: an unexplained Pro
  -- projection is a reason to stop, never a reason to create another charge.
  PERFORM 1
  FROM public.subscriptions AS subscription
  WHERE subscription.user_id = p_user_id
  FOR UPDATE;
  -- The durable trial ledger is the normal authority. A converted reservation
  -- is also permanent proof of use: conversion commits before the downstream
  -- entitlement writer, so a crash between those transactions must never make
  -- the same seven-day trial available again. A rotated Stripe Price must not
  -- change either decision.
  PERFORM 1
  FROM public.stripe_trial_entitlements AS trial
  WHERE trial.user_id = p_user_id
  FOR UPDATE;
  IF p_trial_days = 7 AND (
    EXISTS (
      SELECT 1
      FROM public.stripe_trial_entitlements AS trial
      WHERE trial.user_id = p_user_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.pro_membership_checkout_reservations AS reservation
      WHERE reservation.user_id = p_user_id
        AND reservation.trial_days = 7
        AND reservation.status IN ('converted', 'retired')
    )
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'trial_already_used');
  END IF;

  -- A converted row is an active financial barrier until the exact local
  -- subscription and its latest signed state authority are both terminal.
  -- This closes the Stripe-scan -> reserve TOCTOU while allowing a genuine
  -- canceled/expired subscription to buy again under the same lock order.
  UPDATE public.pro_membership_checkout_reservations AS reservation
  SET
    status = 'retired',
    released_at = pg_catalog.clock_timestamp(),
    updated_at = pg_catalog.clock_timestamp()
  WHERE reservation.user_id = p_user_id
    AND reservation.livemode = p_livemode
    AND reservation.stripe_customer_id = p_stripe_customer_id
    AND reservation.status = 'converted'
    AND EXISTS (
      SELECT 1
      FROM public.subscriptions AS subscription
      WHERE subscription.user_id = p_user_id
        AND subscription.stripe_customer_id = p_stripe_customer_id
        AND subscription.stripe_subscription_id =
          reservation.stripe_subscription_id
        AND subscription.plan = reservation.pro_plan
        AND subscription.status IN ('canceled', 'incomplete_expired')
    )
    AND (
      SELECT state.stripe_status
      FROM public.stripe_subscription_state_events AS state
      WHERE state.user_id = p_user_id
        AND state.stripe_customer_id = p_stripe_customer_id
        AND state.stripe_subscription_id = reservation.stripe_subscription_id
        AND state.plan = reservation.pro_plan
        AND pg_catalog.to_jsonb(state) ->> 'livemode' = p_livemode::text
      ORDER BY state.event_created_at DESC, state.event_id DESC
      LIMIT 1
    ) IN ('canceled', 'incomplete_expired');

  SELECT EXISTS (
    SELECT 1
    FROM public.subscriptions AS subscription
    WHERE subscription.user_id = p_user_id
      AND subscription.stripe_customer_id = p_stripe_customer_id
      AND subscription.stripe_subscription_id =
        v_profile.stripe_subscription_id
      AND subscription.tier IN ('pro', 'elite')
      AND subscription.plan IN ('monthly', 'yearly')
      AND subscription.status IN ('canceled', 'incomplete_expired')
      AND (
        SELECT state.stripe_status
        FROM public.stripe_subscription_state_events AS state
        WHERE state.user_id = p_user_id
          AND state.stripe_customer_id = p_stripe_customer_id
          AND state.stripe_subscription_id =
            subscription.stripe_subscription_id
          AND state.plan = subscription.plan
          AND pg_catalog.to_jsonb(state) ->> 'livemode' = p_livemode::text
        ORDER BY state.event_created_at DESC, state.event_id DESC
        LIMIT 1
      ) IN ('canceled', 'incomplete_expired')
  ) INTO v_profile_has_exact_terminal;

  IF (
      (
        COALESCE(v_profile.is_pro, false)
        OR v_profile.subscription_tier IN ('pro', 'elite')
        OR v_profile.stripe_subscription_id IS NOT NULL
      )
      AND NOT v_profile_has_exact_terminal
    ) OR EXISTS (
      SELECT 1
      FROM public.subscriptions AS subscription
      WHERE subscription.user_id = p_user_id
        AND subscription.status IN (
          'active', 'trialing', 'past_due', 'incomplete',
          'unpaid', 'paused'
        )
        AND (
          subscription.tier IN ('pro', 'elite')
          OR subscription.plan IN ('monthly', 'yearly', 'lifetime')
        )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_subscribed');
  END IF;

  -- Lock the whole OR-domain before selecting a reusable identity. Separate
  -- user and Customer uniqueness constraints can still produce two crossed
  -- rows; PL/pgSQL SELECT INTO would otherwise pick one nondeterministically.
  PERFORM 1
  FROM public.pro_membership_checkout_reservations AS reservation
  WHERE reservation.livemode = p_livemode
    AND (
      reservation.user_id = p_user_id
      OR reservation.stripe_customer_id = p_stripe_customer_id
    )
    AND reservation.status IN ('reserved', 'bound', 'converted')
  FOR UPDATE;

  SELECT pg_catalog.count(*)
  INTO v_active_reservation_count
  FROM public.pro_membership_checkout_reservations AS reservation
  WHERE reservation.livemode = p_livemode
    AND (
      reservation.user_id = p_user_id
      OR reservation.stripe_customer_id = p_stripe_customer_id
    )
    AND reservation.status IN ('reserved', 'bound', 'converted');

  IF v_active_reservation_count > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'crossed Pro checkout user and Customer reservations conflicted';
  END IF;

  SELECT reservation.*
  INTO v_reservation
  FROM public.pro_membership_checkout_reservations AS reservation
  WHERE reservation.livemode = p_livemode
    AND (
      reservation.user_id = p_user_id
      OR reservation.stripe_customer_id = p_stripe_customer_id
    )
    AND reservation.status IN ('reserved', 'bound', 'converted')
  ;

  IF FOUND THEN
    IF v_reservation.user_id <> p_user_id
      OR v_reservation.stripe_customer_id <> p_stripe_customer_id
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'existing Pro checkout user or Customer identity drifted';
    END IF;
    IF v_reservation.status = 'converted' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'already_subscribed');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'existing',
      'reservation_id', v_reservation.id,
      'pro_plan', v_reservation.pro_plan,
      'stripe_price_id', v_reservation.stripe_price_id,
      'unit_amount', v_reservation.unit_amount,
      'currency', v_reservation.currency,
      'trial_days', v_reservation.trial_days,
      'success_url', v_reservation.success_url,
      'cancel_url', v_reservation.cancel_url,
      'checkout_expires_at', v_reservation.checkout_expires_at,
      'checkout_session_id', v_reservation.checkout_session_id
    );
  END IF;

  v_created_at := pg_catalog.date_trunc(
    'second',
    pg_catalog.clock_timestamp()
  );
  INSERT INTO public.pro_membership_checkout_reservations (
    user_id,
    livemode,
    stripe_customer_id,
    pro_plan,
    stripe_price_id,
    unit_amount,
    currency,
    trial_days,
    success_url,
    cancel_url,
    status,
    checkout_expires_at,
    created_at,
    updated_at
  ) VALUES (
    p_user_id,
    p_livemode,
    p_stripe_customer_id,
    p_pro_plan,
    p_stripe_price_id,
    p_unit_amount,
    p_currency,
    p_trial_days,
    p_success_url,
    p_cancel_url,
    'reserved',
    pg_catalog.floor(extract(epoch FROM v_created_at))::bigint + 2700,
    v_created_at,
    v_created_at
  )
  RETURNING * INTO v_reservation;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'reserved',
    'reservation_id', v_reservation.id,
    'pro_plan', v_reservation.pro_plan,
    'stripe_price_id', v_reservation.stripe_price_id,
    'unit_amount', v_reservation.unit_amount,
    'currency', v_reservation.currency,
    'trial_days', v_reservation.trial_days,
    'success_url', v_reservation.success_url,
    'cancel_url', v_reservation.cancel_url,
    'checkout_expires_at', v_reservation.checkout_expires_at,
    'checkout_session_id', NULL
  );
END
$function$;

ALTER FUNCTION public.reserve_pro_membership_checkout_atomic(
  uuid, boolean, text, text, text, bigint, text, smallint, text, text
) OWNER TO postgres;

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
AS $function$
DECLARE
  v_profile record;
  v_reservation public.pro_membership_checkout_reservations%ROWTYPE;
  v_profile_has_exact_terminal boolean := false;
BEGIN
  IF p_reservation_id IS NULL
    OR p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id <> pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_pro_plan NOT IN ('monthly', 'yearly')
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id <> pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_currency IS DISTINCT FROM 'usd'
    OR (p_pro_plan = 'monthly' AND p_unit_amount IS DISTINCT FROM 499)
    OR (p_pro_plan = 'yearly' AND p_unit_amount IS DISTINCT FROM 2999)
    OR p_trial_days NOT IN (0, 7)
    OR p_checkout_session_id IS NULL
    OR p_checkout_session_id <> pg_catalog.btrim(p_checkout_session_id)
    OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_checkout_session_id) > 255
    OR p_checkout_expires_at IS NULL
    OR p_checkout_expires_at <= 0
    OR p_checkout_expires_at > 253402300799
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid Pro membership checkout Session binding input';
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

  SELECT
    profile.stripe_customer_id,
    profile.stripe_subscription_id,
    profile.subscription_tier,
    profile.is_pro,
    profile.deleted_at,
    profile.banned_at,
    profile.is_banned
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_profile.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
    OR v_profile.deleted_at IS NOT NULL
    OR v_profile.banned_at IS NOT NULL
    OR COALESCE(v_profile.is_banned, false)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'Pro membership checkout owner changed before Session binding';
  END IF;

  PERFORM 1
  FROM public.subscriptions AS subscription
  WHERE subscription.user_id = p_user_id
  FOR UPDATE;
  PERFORM 1
  FROM public.stripe_trial_entitlements AS trial
  WHERE trial.user_id = p_user_id
  FOR UPDATE;

  SELECT reservation.*
  INTO v_reservation
  FROM public.pro_membership_checkout_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_reservation.user_id <> p_user_id
    OR v_reservation.livemode <> p_livemode
    OR v_reservation.stripe_customer_id <> p_stripe_customer_id
    OR v_reservation.pro_plan <> p_pro_plan
    OR v_reservation.stripe_price_id <> p_stripe_price_id
    OR v_reservation.unit_amount <> p_unit_amount
    OR v_reservation.currency <> p_currency
    OR v_reservation.trial_days <> p_trial_days
    OR v_reservation.checkout_expires_at <> p_checkout_expires_at
    OR v_reservation.status IN ('released', 'retired')
    OR pg_catalog.to_timestamp(v_reservation.checkout_expires_at)
      <= pg_catalog.clock_timestamp()
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'Pro membership checkout reservation changed before Session binding';
  END IF;

  -- A retry of an already-bound payable Session is still an admission retry.
  -- Re-run every local authority check while holding the same locks; otherwise
  -- a subscription or trial committed after the first bind could be skipped.
  IF v_reservation.status IN ('reserved', 'bound') THEN
    IF v_reservation.trial_days = 7 AND (
      EXISTS (
        SELECT 1
        FROM public.stripe_trial_entitlements AS trial
        WHERE trial.user_id = p_user_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.pro_membership_checkout_reservations AS reservation
        WHERE reservation.user_id = p_user_id
          AND reservation.trial_days = 7
          AND reservation.status IN ('converted', 'retired')
      )
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'Pro trial history appeared before Session binding';
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM public.subscriptions AS subscription
      WHERE subscription.user_id = p_user_id
        AND subscription.stripe_customer_id = p_stripe_customer_id
        AND subscription.stripe_subscription_id =
          v_profile.stripe_subscription_id
        AND subscription.tier IN ('pro', 'elite')
        AND subscription.plan IN ('monthly', 'yearly')
        AND subscription.status IN ('canceled', 'incomplete_expired')
        AND (
          SELECT state.stripe_status
          FROM public.stripe_subscription_state_events AS state
          WHERE state.user_id = p_user_id
            AND state.stripe_customer_id = p_stripe_customer_id
            AND state.stripe_subscription_id =
              subscription.stripe_subscription_id
            AND state.plan = subscription.plan
            AND pg_catalog.to_jsonb(state) ->> 'livemode' = p_livemode::text
          ORDER BY state.event_created_at DESC, state.event_id DESC
          LIMIT 1
        ) IN ('canceled', 'incomplete_expired')
    ) INTO v_profile_has_exact_terminal;

    IF (
        (
          COALESCE(v_profile.is_pro, false)
          OR v_profile.subscription_tier IN ('pro', 'elite')
          OR v_profile.stripe_subscription_id IS NOT NULL
        )
        AND NOT v_profile_has_exact_terminal
      ) OR EXISTS (
        SELECT 1
        FROM public.subscriptions AS subscription
        WHERE subscription.user_id = p_user_id
          AND subscription.status IN (
            'active', 'trialing', 'past_due', 'incomplete',
            'unpaid', 'paused'
          )
          AND (
            subscription.tier IN ('pro', 'elite')
            OR subscription.plan IN ('monthly', 'yearly', 'lifetime')
          )
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'Pro entitlement authority appeared before Session binding';
    END IF;
  END IF;

  IF v_reservation.checkout_session_id IS NOT NULL THEN
    IF v_reservation.checkout_session_id <> p_checkout_session_id THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'Pro membership checkout reservation has another Session';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status',
      CASE
        WHEN v_reservation.status = 'converted' THEN 'converted'
        ELSE 'already_bound'
      END
    );
  END IF;

  IF v_reservation.status <> 'reserved' THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'Pro membership checkout reservation is not bindable';
  END IF;

  UPDATE public.pro_membership_checkout_reservations AS reservation
  SET
    status = 'bound',
    checkout_session_id = p_checkout_session_id,
    updated_at = pg_catalog.clock_timestamp()
  WHERE reservation.id = p_reservation_id;

  RETURN pg_catalog.jsonb_build_object('status', 'bound');
END
$function$;

ALTER FUNCTION public.bind_pro_membership_checkout_session_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.release_pro_membership_checkout_reservation_atomic(
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
  p_checkout_expires_at bigint,
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
AS $function$
DECLARE
  v_reservation public.pro_membership_checkout_reservations%ROWTYPE;
BEGIN
  IF p_reservation_id IS NULL
    OR p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id <> pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_pro_plan NOT IN ('monthly', 'yearly')
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id <> pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_currency IS DISTINCT FROM 'usd'
    OR (p_pro_plan = 'monthly' AND p_unit_amount IS DISTINCT FROM 499)
    OR (p_pro_plan = 'yearly' AND p_unit_amount IS DISTINCT FROM 2999)
    OR p_trial_days NOT IN (0, 7)
    OR p_checkout_session_id IS NULL
    OR p_checkout_session_id <> pg_catalog.btrim(p_checkout_session_id)
    OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_checkout_session_id) > 255
    OR p_checkout_expires_at IS NULL
    OR p_checkout_expires_at <= 0
    OR p_checkout_expires_at > 253402300799
    OR p_stripe_event_id IS NULL
    OR p_stripe_event_id <> pg_catalog.btrim(p_stripe_event_id)
    OR p_stripe_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_event_id) > 255
    OR p_stripe_event_created IS NULL
    OR p_stripe_event_created <= 0
    OR p_stripe_event_created > 253402300799
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid signed Pro membership checkout release input';
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

  SELECT reservation.*
  INTO v_reservation
  FROM public.pro_membership_checkout_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_reservation.user_id <> p_user_id
    OR v_reservation.livemode <> p_livemode
    OR v_reservation.stripe_customer_id <> p_stripe_customer_id
    OR v_reservation.pro_plan <> p_pro_plan
    OR v_reservation.stripe_price_id <> p_stripe_price_id
    OR v_reservation.unit_amount <> p_unit_amount
    OR v_reservation.currency <> p_currency
    OR v_reservation.trial_days <> p_trial_days
    OR v_reservation.checkout_expires_at <> p_checkout_expires_at
    OR (
      v_reservation.checkout_session_id IS NOT NULL
      AND v_reservation.checkout_session_id <> p_checkout_session_id
    )
    OR v_reservation.stripe_subscription_id IS NOT NULL
    OR v_reservation.status = 'converted'
    OR p_stripe_event_created <
      pg_catalog.floor(extract(epoch FROM v_reservation.created_at))::bigint
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'signed Pro membership checkout release identity drifted';
  END IF;

  IF v_reservation.status = 'released' THEN
    IF v_reservation.checkout_session_id = p_checkout_session_id
      AND v_reservation.terminal_event_id = p_stripe_event_id
      AND v_reservation.terminal_event_created = p_stripe_event_created
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'already_released');
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'Pro membership checkout release replay conflicted';
  END IF;

  IF v_reservation.status NOT IN ('reserved', 'bound') THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'Pro membership checkout reservation is not releasable';
  END IF;

  UPDATE public.pro_membership_checkout_reservations AS reservation
  SET
    status = 'released',
    checkout_session_id = p_checkout_session_id,
    terminal_event_id = p_stripe_event_id,
    terminal_event_created = p_stripe_event_created,
    released_at = pg_catalog.clock_timestamp(),
    updated_at = pg_catalog.clock_timestamp()
  WHERE reservation.id = p_reservation_id;

  RETURN pg_catalog.jsonb_build_object('status', 'released');
END
$function$;

ALTER FUNCTION public.release_pro_membership_checkout_reservation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint,
  text, bigint
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.release_pro_membership_checkout_observation_atomic(
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
  p_checkout_expires_at bigint,
  p_observation_kind text,
  p_observed_at bigint
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
AS $function$
DECLARE
  v_reservation public.pro_membership_checkout_reservations%ROWTYPE;
  v_observation_id text;
BEGIN
  IF p_reservation_id IS NULL
    OR p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id <> pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_pro_plan NOT IN ('monthly', 'yearly')
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id <> pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_currency IS DISTINCT FROM 'usd'
    OR (p_pro_plan = 'monthly' AND p_unit_amount IS DISTINCT FROM 499)
    OR (p_pro_plan = 'yearly' AND p_unit_amount IS DISTINCT FROM 2999)
    OR p_trial_days NOT IN (0, 7)
    OR p_checkout_expires_at IS NULL
    OR p_checkout_expires_at <= 0
    OR p_checkout_expires_at > 253402300799
    OR p_observation_kind NOT IN ('expired_session', 'absent_session')
    OR (
      p_observation_kind = 'expired_session'
      AND (
        p_checkout_session_id IS NULL
        OR p_checkout_session_id <> pg_catalog.btrim(p_checkout_session_id)
        OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_checkout_session_id) > 255
      )
    )
    OR (p_observation_kind = 'absent_session' AND p_checkout_session_id IS NOT NULL)
    OR p_observed_at IS NULL
    OR p_observed_at < p_checkout_expires_at
    OR p_observed_at > 253402300799
    OR p_observed_at >
      pg_catalog.floor(extract(epoch FROM pg_catalog.clock_timestamp()))::bigint + 300
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid fresh Stripe Pro checkout terminal observation';
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

  SELECT reservation.*
  INTO v_reservation
  FROM public.pro_membership_checkout_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_reservation.user_id <> p_user_id
    OR v_reservation.livemode <> p_livemode
    OR v_reservation.stripe_customer_id <> p_stripe_customer_id
    OR v_reservation.pro_plan <> p_pro_plan
    OR v_reservation.stripe_price_id <> p_stripe_price_id
    OR v_reservation.unit_amount <> p_unit_amount
    OR v_reservation.currency <> p_currency
    OR v_reservation.trial_days <> p_trial_days
    OR v_reservation.checkout_expires_at <> p_checkout_expires_at
    OR v_reservation.stripe_subscription_id IS NOT NULL
    OR v_reservation.status IN ('converted', 'retired')
    OR pg_catalog.to_timestamp(v_reservation.checkout_expires_at) >
      pg_catalog.clock_timestamp()
    OR (
      p_observation_kind = 'expired_session'
      AND v_reservation.checkout_session_id IS NOT NULL
      AND v_reservation.checkout_session_id <> p_checkout_session_id
    )
    OR (
      p_observation_kind = 'absent_session'
      AND (
        v_reservation.status NOT IN ('reserved', 'released')
        OR v_reservation.checkout_session_id IS NOT NULL
      )
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'fresh Stripe Pro checkout terminal observation identity drifted';
  END IF;

  v_observation_id := 'obs_pro_'
    || CASE
      WHEN p_observation_kind = 'expired_session' THEN 'expired_'
      ELSE 'absent_'
    END
    || pg_catalog.replace(p_reservation_id::text, '-', '');

  IF v_reservation.status = 'released' THEN
    IF v_reservation.checkout_session_id IS NOT DISTINCT FROM p_checkout_session_id
      AND v_reservation.terminal_event_id = v_observation_id
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'already_released');
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'fresh Stripe Pro checkout terminal observation replay conflicted';
  END IF;

  IF v_reservation.status NOT IN ('reserved', 'bound') THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'Pro checkout reservation is not observation-releasable';
  END IF;

  UPDATE public.pro_membership_checkout_reservations AS reservation
  SET
    status = 'released',
    checkout_session_id = p_checkout_session_id,
    terminal_event_id = v_observation_id,
    terminal_event_created = p_observed_at,
    released_at = pg_catalog.clock_timestamp(),
    updated_at = pg_catalog.clock_timestamp()
  WHERE reservation.id = p_reservation_id;

  RETURN pg_catalog.jsonb_build_object('status', 'released');
END
$function$;

ALTER FUNCTION public.release_pro_membership_checkout_observation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint,
  text, bigint
) OWNER TO postgres;

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
AS $function$
DECLARE
  v_reservation public.pro_membership_checkout_reservations%ROWTYPE;
BEGIN
  IF p_reservation_id IS NULL
    OR p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id <> pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_pro_plan NOT IN ('monthly', 'yearly')
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id <> pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_currency IS DISTINCT FROM 'usd'
    OR (p_pro_plan = 'monthly' AND p_unit_amount IS DISTINCT FROM 499)
    OR (p_pro_plan = 'yearly' AND p_unit_amount IS DISTINCT FROM 2999)
    OR p_trial_days NOT IN (0, 7)
    OR p_checkout_session_id IS NULL
    OR p_checkout_session_id <> pg_catalog.btrim(p_checkout_session_id)
    OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_checkout_session_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id <> pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR (
      p_trial_days = 0
      AND (
        p_payment_status IS DISTINCT FROM 'paid'
        OR p_subscription_status IS NULL
        OR p_subscription_status NOT IN (
          'active', 'past_due', 'unpaid', 'paused',
          'canceled', 'incomplete_expired'
        )
        OR p_trial_start IS NOT NULL
        OR p_trial_end IS NOT NULL
      )
    )
    OR (
      p_trial_days = 7
      AND (
        p_payment_status IS DISTINCT FROM 'no_payment_required'
        OR p_subscription_status IS NULL
        OR p_subscription_status NOT IN (
          'trialing', 'active', 'past_due', 'unpaid', 'paused',
          'canceled', 'incomplete_expired'
        )
        OR p_trial_start IS NULL
        OR p_trial_start <= 0
        OR p_trial_end IS NULL
        OR p_trial_end::numeric <> p_trial_start::numeric + 604800
        OR p_trial_end > 253402300799
      )
    )
    OR p_stripe_event_id IS NULL
    OR p_stripe_event_id <> pg_catalog.btrim(p_stripe_event_id)
    OR p_stripe_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_event_id) > 255
    OR p_stripe_event_created IS NULL
    OR p_stripe_event_created <= 0
    OR p_stripe_event_created > 253402300799
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid signed Pro membership checkout conversion input';
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
      'pro-membership-stripe-subscription:'
        || p_livemode::text || ':' || p_stripe_subscription_id,
      0
    )
  );

  SELECT reservation.*
  INTO v_reservation
  FROM public.pro_membership_checkout_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_reservation.user_id <> p_user_id
    OR v_reservation.livemode <> p_livemode
    OR v_reservation.stripe_customer_id <> p_stripe_customer_id
    OR v_reservation.pro_plan <> p_pro_plan
    OR v_reservation.stripe_price_id <> p_stripe_price_id
    OR v_reservation.unit_amount <> p_unit_amount
    OR v_reservation.currency <> p_currency
    OR v_reservation.trial_days <> p_trial_days
    OR v_reservation.checkout_session_id <> p_checkout_session_id
    OR v_reservation.status IN ('reserved', 'released', 'retired')
    OR p_stripe_event_created <
      pg_catalog.floor(extract(epoch FROM v_reservation.created_at))::bigint
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'signed Pro membership checkout conversion identity drifted';
  END IF;

  IF v_reservation.status = 'converted' THEN
    IF v_reservation.stripe_subscription_id = p_stripe_subscription_id
      AND v_reservation.completion_payment_status = p_payment_status
      AND v_reservation.trial_start IS NOT DISTINCT FROM p_trial_start
      AND v_reservation.trial_end IS NOT DISTINCT FROM p_trial_end
      AND v_reservation.terminal_event_id = p_stripe_event_id
      AND v_reservation.terminal_event_created = p_stripe_event_created
    THEN
      IF v_reservation.subscription_status = p_subscription_status THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'already_converted',
          'effective_subscription_status', p_subscription_status,
          'observation', 'replayed'
        );
      END IF;

      -- Terminal Stripe Subscription states are absorbing for this completion
      -- marker. Once observed, no later retry may use an older nonterminal
      -- snapshot to resurrect it.
      IF v_reservation.subscription_status IN ('canceled', 'incomplete_expired') THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'Pro membership checkout terminal conversion cannot be resurrected';
      END IF;

      -- All immutable terms and the signed completion marker still match. A
      -- fresh Stripe read may legitimately move among nonterminal states long
      -- after checkout; the downstream authority re-fetches it again. Persist
      -- only the irreversible transition into a terminal barrier.
      IF p_subscription_status IN ('canceled', 'incomplete_expired') THEN
        UPDATE public.pro_membership_checkout_reservations AS reservation
        SET
          subscription_status = p_subscription_status,
          updated_at = pg_catalog.clock_timestamp()
        WHERE reservation.id = p_reservation_id;

        RETURN pg_catalog.jsonb_build_object(
          'status', 'already_converted',
          'effective_subscription_status', p_subscription_status,
          'observation', 'tightened'
        );
      END IF;

      RETURN pg_catalog.jsonb_build_object(
        'status', 'already_converted',
        'effective_subscription_status', p_subscription_status,
        'observation', 'observed'
      );
    END IF;
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'Pro membership checkout conversion replay conflicted';
  END IF;

  UPDATE public.pro_membership_checkout_reservations AS reservation
  SET
    status = 'converted',
    stripe_subscription_id = p_stripe_subscription_id,
    completion_payment_status = p_payment_status,
    subscription_status = p_subscription_status,
    trial_start = p_trial_start,
    trial_end = p_trial_end,
    terminal_event_id = p_stripe_event_id,
    terminal_event_created = p_stripe_event_created,
    converted_at = pg_catalog.clock_timestamp(),
    updated_at = pg_catalog.clock_timestamp()
  WHERE reservation.id = p_reservation_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'converted',
    'effective_subscription_status', p_subscription_status,
    'observation', 'recorded'
  );
END
$function$;

ALTER FUNCTION public.convert_pro_membership_checkout_reservation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, text,
  text, text, bigint, bigint, text, bigint
) OWNER TO postgres;

REVOKE ALL ON TABLE public.pro_membership_checkout_reservations
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

REVOKE ALL ON FUNCTION public.reserve_pro_membership_checkout_atomic(
  uuid, boolean, text, text, text, bigint, text, smallint, text, text
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.bind_pro_membership_checkout_session_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.release_pro_membership_checkout_reservation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint,
  text, bigint
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.release_pro_membership_checkout_observation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint,
  text, bigint
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.convert_pro_membership_checkout_reservation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, text,
  text, text, bigint, bigint, text, bigint
) FROM PUBLIC, anon, authenticated, authenticator, service_role;

GRANT EXECUTE ON FUNCTION public.reserve_pro_membership_checkout_atomic(
  uuid, boolean, text, text, text, bigint, text, smallint, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_pro_membership_checkout_session_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_pro_membership_checkout_reservation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint,
  text, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_pro_membership_checkout_observation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint,
  text, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.convert_pro_membership_checkout_reservation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, text,
  text, text, bigint, bigint, text, bigint
) TO service_role;

DO $postflight$
DECLARE
  v_table pg_catalog.regclass :=
    'public.pro_membership_checkout_reservations'::pg_catalog.regclass;
  v_postgres oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres');
  v_service oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role');
  v_expected_functions oid[] := ARRAY[
    'public.bind_pro_membership_checkout_session_atomic(uuid,uuid,boolean,text,text,text,bigint,text,smallint,text,bigint)'::pg_catalog.regprocedure::oid,
    'public.convert_pro_membership_checkout_reservation_atomic(uuid,uuid,boolean,text,text,text,bigint,text,smallint,text,text,text,text,bigint,bigint,text,bigint)'::pg_catalog.regprocedure::oid,
    'public.release_pro_membership_checkout_observation_atomic(uuid,uuid,boolean,text,text,text,bigint,text,smallint,text,bigint,text,bigint)'::pg_catalog.regprocedure::oid,
    'public.release_pro_membership_checkout_reservation_atomic(uuid,uuid,boolean,text,text,text,bigint,text,smallint,text,bigint,text,bigint)'::pg_catalog.regprocedure::oid,
    'public.reserve_pro_membership_checkout_atomic(uuid,boolean,text,text,text,bigint,text,smallint,text,text)'::pg_catalog.regprocedure::oid
  ];
  v_column_hash text;
  v_constraint_hash text;
  v_index_hash text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_table
      AND relation.relowner = v_postgres
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS permission
    WHERE relation.oid = v_table
      AND permission.grantee <> relation.relowner
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy AS policy WHERE policy.polrelid = v_table
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_table
      AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_rewrite AS rule WHERE rule.ev_class = v_table
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_table
      OR inheritance.inhparent = v_table
  ) THEN
    RAISE EXCEPTION 'Pro checkout reservation table authority drifted';
  END IF;

  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.string_agg(
          pg_catalog.concat_ws(
            '|', attribute.attnum, attribute.attname,
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
            attribute.attnotnull,
            COALESCE(
              pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid),
              ''
            ),
            attribute.attidentity, attribute.attgenerated
          ),
          E'\n' ORDER BY attribute.attnum
        ),
        'UTF8'
      )
    ),
    'hex'
  ) INTO v_column_hash
  FROM pg_catalog.pg_attribute AS attribute
  LEFT JOIN pg_catalog.pg_attrdef AS default_row
    ON default_row.adrelid = attribute.attrelid
    AND default_row.adnum = attribute.attnum
  WHERE attribute.attrelid = v_table
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_column_hash IS DISTINCT FROM
    '2816c39fc81f4100b6d55667fd3263f5a68da4267b86a383207c7d189d4904e6'
  THEN
    RAISE EXCEPTION 'Pro checkout reservation columns/defaults/nullability drifted';
  END IF;

  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.string_agg(
          pg_catalog.concat_ws(
            '|', constraint_row.conname, constraint_row.contype,
            constraint_row.convalidated, constraint_row.connoinherit,
            pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
          ),
          E'\n' ORDER BY constraint_row.conname
        ),
        'UTF8'
      )
    ),
    'hex'
  ) INTO v_constraint_hash
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = v_table;

  IF v_constraint_hash IS DISTINCT FROM
    'ad6564f3043427428f60dd690150bf5f658583fcea5416f51cdf60faa4519847'
  THEN
    RAISE EXCEPTION 'Pro checkout reservation CHECK/PK/FK constraints drifted';
  END IF;

  SELECT pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.convert_to(
        pg_catalog.string_agg(
          pg_catalog.concat_ws(
            '|', index_relation.relname, index_row.indisunique,
            index_row.indisprimary, index_row.indisvalid,
            index_row.indisready, index_row.indislive,
            pg_catalog.pg_get_indexdef(index_row.indexrelid)
          ),
          E'\n' ORDER BY index_relation.relname
        ),
        'UTF8'
      )
    ),
    'hex'
  ) INTO v_index_hash
  FROM pg_catalog.pg_index AS index_row
  JOIN pg_catalog.pg_class AS index_relation
    ON index_relation.oid = index_row.indexrelid
  WHERE index_row.indrelid = v_table;

  IF v_index_hash IS DISTINCT FROM
      '141dddc76a0e081238e1703d5509dfdb5ce304acba09932d2cbb9addb7678293'
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_row
      JOIN pg_catalog.pg_class AS index_relation
        ON index_relation.oid = index_row.indexrelid
      WHERE index_row.indrelid = v_table
        AND (
          index_relation.relowner <> v_postgres
          OR index_relation.relkind <> 'i'
          OR index_relation.relpersistence <> 'p'
        )
    )
  THEN
    RAISE EXCEPTION 'Pro checkout reservation PK/five-index inventory drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = function_row.pronamespace
    WHERE namespace.nspname = 'public'
      AND function_row.proname IN (
        'reserve_pro_membership_checkout_atomic',
        'bind_pro_membership_checkout_session_atomic',
        'release_pro_membership_checkout_observation_atomic',
        'release_pro_membership_checkout_reservation_atomic',
        'convert_pro_membership_checkout_reservation_atomic'
      )
  ) <> 5 OR EXISTS (
    SELECT expected.oid
    FROM pg_catalog.unnest(v_expected_functions) AS expected(oid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = expected.oid
    )
  ) THEN
    RAISE EXCEPTION 'Pro checkout authority overload inventory drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = ANY(v_expected_functions)
      AND (
        function_row.proowner <> v_postgres
        OR function_row.prokind <> 'f'
        OR function_row.prolang <>
          (SELECT oid FROM pg_catalog.pg_language WHERE lanname = 'plpgsql')
        OR function_row.prorettype <> 'jsonb'::pg_catalog.regtype
        OR function_row.proretset
        OR NOT function_row.prosecdef
        OR function_row.provolatile <> 'v'
        OR function_row.proparallel <> 'u'
        OR function_row.proisstrict
        OR function_row.proconfig IS DISTINCT FROM ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off',
          'lock_timeout=5s',
          'statement_timeout=30s'
        ]::text[]
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.aclexplode(
            COALESCE(
              function_row.proacl,
              pg_catalog.acldefault('f', function_row.proowner)
            )
          ) AS permission
          WHERE permission.privilege_type <> 'EXECUTE'
            OR permission.grantee NOT IN (v_postgres, v_service)
        )
        OR NOT pg_catalog.has_function_privilege(
          v_service,
          function_row.oid,
          'EXECUTE'
        )
        OR pg_catalog.has_function_privilege(
          (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'anon'),
          function_row.oid,
          'EXECUTE'
        )
        OR pg_catalog.has_function_privilege(
          (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'),
          function_row.oid,
          'EXECUTE'
        )
      )
  ) THEN
    RAISE EXCEPTION 'Pro checkout function owner, ACL, or runtime settings drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.bind_pro_membership_checkout_session_atomic(uuid,uuid,boolean,text,text,text,bigint,text,smallint,text,bigint)'::pg_catalog.regprocedure::oid,
          '632f69a607d17ed29cd0b45af86117279985865ee6d41a95c933e7c1cd218931'::text
        ),
        (
          'public.convert_pro_membership_checkout_reservation_atomic(uuid,uuid,boolean,text,text,text,bigint,text,smallint,text,text,text,text,bigint,bigint,text,bigint)'::pg_catalog.regprocedure::oid,
          'ff447c3f414699a7f1a4224e6e05f2e74608feee976d703369303618f1bcf1e3'::text
        ),
        (
          'public.release_pro_membership_checkout_observation_atomic(uuid,uuid,boolean,text,text,text,bigint,text,smallint,text,bigint,text,bigint)'::pg_catalog.regprocedure::oid,
          'b71ed64b945ecd74c67b20db26e0ade23a7ca01b103c613622d1945b633710b2'::text
        ),
        (
          'public.release_pro_membership_checkout_reservation_atomic(uuid,uuid,boolean,text,text,text,bigint,text,smallint,text,bigint,text,bigint)'::pg_catalog.regprocedure::oid,
          '1c9e020a383765da512c4c891396ff52844b0c8dcf4855221cda6fefd84fce21'::text
        ),
        (
          'public.reserve_pro_membership_checkout_atomic(uuid,boolean,text,text,text,bigint,text,smallint,text,text)'::pg_catalog.regprocedure::oid,
          'a8a408c2a2d586d9f73dfc1190abc20c7164affa472fa4d81624c9fc9934af41'::text
        )
    ) AS expected(function_oid, body_hash)
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected.function_oid
    WHERE pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
      'hex'
    ) <> expected.body_hash
  ) THEN
    RAISE EXCEPTION 'Pro checkout authority function body hash drifted';
  END IF;
END
$postflight$;

COMMENT ON TABLE public.pro_membership_checkout_reservations IS
  'Service-only durable admission ledger for ordinary B2C monthly/yearly Stripe Checkout.';
COMMENT ON FUNCTION public.reserve_pro_membership_checkout_atomic(
  uuid, boolean, text, text, text, bigint, text, smallint, text, text
) IS 'Serializes one exact ordinary Pro Checkout reservation per user and Stripe mode.';
COMMENT ON FUNCTION public.bind_pro_membership_checkout_session_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint
) IS 'Binds a freshly verified Stripe Checkout Session to its exact Pro reservation.';
COMMENT ON FUNCTION public.release_pro_membership_checkout_reservation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint,
  text, bigint
) IS 'Releases only the reservation identified by an exact signed checkout.session.expired event.';
COMMENT ON FUNCTION public.release_pro_membership_checkout_observation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint,
  text, bigint
) IS 'Releases an expired Pro Checkout only after service-side fresh Stripe terminal or exact-absence proof.';
COMMENT ON FUNCTION public.convert_pro_membership_checkout_reservation_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, text,
  text, text, bigint, bigint, text, bigint
) IS 'Converts a bound reservation to one exact subscription from a signed checkout completion.';

COMMIT;
