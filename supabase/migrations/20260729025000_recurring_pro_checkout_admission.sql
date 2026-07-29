-- Exact admission and lifecycle authority for ordinary B2C Pro Checkout.
--
-- A Stripe Customer scan is observational and cannot serialize two concurrent
-- Checkout Session writers. This durable reservation is the only admission
-- authority for new monthly/yearly Sessions. A bound reservation is released
-- only by its exact signed checkout.session.expired event, and a paid/trial
-- subscription cannot become entitlement authority until its exact signed
-- checkout.session.completed event converts the reservation.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regrole('postgres') IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.subscriptions') IS NULL
    OR pg_catalog.to_regclass('public.stripe_manual_reviews') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.record_stripe_manual_review_atomic(text,text,uuid,text,text,jsonb)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.activate_recurring_trial_entitlement_atomic(uuid,text,text,text,timestamp with time zone,timestamp with time zone,text)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'recurring Pro Checkout admission prerequisites are missing';
  END IF;
END
$preflight$;

CREATE TABLE public.stripe_recurring_pro_checkout_reservations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  livemode boolean NOT NULL,
  stripe_customer_id text NOT NULL,
  plan text NOT NULL,
  stripe_price_id text NOT NULL,
  operation_id uuid NOT NULL,
  reservation_nonce uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  trial_requested boolean NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  checkout_expires_at bigint NOT NULL,
  checkout_session_id text,
  stripe_subscription_id text,
  completion_event_id text,
  completion_event_created bigint,
  release_reason text,
  release_event_id text,
  release_event_created bigint,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  released_at timestamptz,
  CONSTRAINT stripe_recurring_pro_checkout_customer_check
    CHECK (
      stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_customer_id) <= 255
    ),
  CONSTRAINT stripe_recurring_pro_checkout_plan_check
    CHECK (plan IN ('monthly', 'yearly')),
  CONSTRAINT stripe_recurring_pro_checkout_price_check
    CHECK (
      stripe_price_id ~ '^price_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_price_id) <= 255
    ),
  CONSTRAINT stripe_recurring_pro_checkout_status_check
    CHECK (
      status IN ('reserved', 'bound', 'completed', 'released', 'expired')
    ),
  CONSTRAINT stripe_recurring_pro_checkout_expiry_check
    CHECK (
      checkout_expires_at > 0
      AND checkout_expires_at <= 253402300799
    ),
  CONSTRAINT stripe_recurring_pro_checkout_session_check
    CHECK (
      checkout_session_id IS NULL
      OR (
        checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'
        AND pg_catalog.length(checkout_session_id) <= 255
      )
    ),
  CONSTRAINT stripe_recurring_pro_checkout_subscription_check
    CHECK (
      stripe_subscription_id IS NULL
      OR (
        stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
        AND pg_catalog.length(stripe_subscription_id) <= 255
      )
    ),
  CONSTRAINT stripe_recurring_pro_checkout_completion_event_check
    CHECK (
      (
        completion_event_id IS NULL
        AND completion_event_created IS NULL
      )
      OR (
        completion_event_id ~ '^evt_[A-Za-z0-9_]+$'
        AND pg_catalog.length(completion_event_id) <= 255
        AND completion_event_created > 0
        AND completion_event_created <= 253402300799
      )
    ),
  CONSTRAINT stripe_recurring_pro_checkout_release_event_check
    CHECK (
      (
        release_event_id IS NULL
        AND release_event_created IS NULL
      )
      OR (
        release_event_id ~ '^evt_[A-Za-z0-9_]+$'
        AND pg_catalog.length(release_event_id) <= 255
        AND release_event_created > 0
        AND release_event_created <= 253402300799
      )
    ),
  CONSTRAINT stripe_recurring_pro_checkout_release_reason_check
    CHECK (
      release_reason IS NULL
      OR release_reason ~ '^[a-z0-9_:-]{2,96}$'
    ),
  CONSTRAINT stripe_recurring_pro_checkout_shape_check
    CHECK (
      (
        status = 'reserved'
        AND checkout_session_id IS NULL
        AND stripe_subscription_id IS NULL
        AND completion_event_id IS NULL
        AND completion_event_created IS NULL
        AND completed_at IS NULL
        AND release_reason IS NULL
        AND release_event_id IS NULL
        AND release_event_created IS NULL
        AND released_at IS NULL
      )
      OR (
        status = 'bound'
        AND checkout_session_id IS NOT NULL
        AND stripe_subscription_id IS NULL
        AND completion_event_id IS NULL
        AND completion_event_created IS NULL
        AND completed_at IS NULL
        AND release_reason IS NULL
        AND release_event_id IS NULL
        AND release_event_created IS NULL
        AND released_at IS NULL
      )
      OR (
        status = 'completed'
        AND checkout_session_id IS NOT NULL
        AND stripe_subscription_id IS NOT NULL
        AND completion_event_id IS NOT NULL
        AND completion_event_created IS NOT NULL
        AND completed_at IS NOT NULL
        AND release_reason IS NULL
        AND release_event_id IS NULL
        AND release_event_created IS NULL
        AND released_at IS NULL
      )
      OR (
        status = 'expired'
        AND checkout_session_id IS NULL
        AND stripe_subscription_id IS NULL
        AND completion_event_id IS NULL
        AND completion_event_created IS NULL
        AND completed_at IS NULL
        AND release_reason = 'lease_expired'
        AND release_event_id IS NULL
        AND release_event_created IS NULL
        AND released_at IS NOT NULL
      )
      OR (
        status = 'released'
        AND release_reason IS NOT NULL
        AND released_at IS NOT NULL
        AND (
          (
            release_reason = 'checkout_session_expired'
            AND checkout_session_id IS NOT NULL
            AND stripe_subscription_id IS NULL
            AND completion_event_id IS NULL
            AND completion_event_created IS NULL
            AND completed_at IS NULL
            AND release_event_id IS NOT NULL
            AND release_event_created IS NOT NULL
          )
          OR (
            release_reason = 'subscription_terminal_before_recheckout'
            AND checkout_session_id IS NOT NULL
            AND stripe_subscription_id IS NOT NULL
            AND completion_event_id IS NOT NULL
            AND completion_event_created IS NOT NULL
            AND completed_at IS NOT NULL
            AND release_event_id IS NULL
            AND release_event_created IS NULL
          )
        )
      )
    ),
  CONSTRAINT stripe_recurring_pro_checkout_operation_key
    UNIQUE (livemode, operation_id)
);

CREATE UNIQUE INDEX stripe_recurring_pro_checkout_session_key
  ON public.stripe_recurring_pro_checkout_reservations (
    livemode,
    checkout_session_id
  )
  WHERE checkout_session_id IS NOT NULL;

CREATE UNIQUE INDEX stripe_recurring_pro_checkout_subscription_key
  ON public.stripe_recurring_pro_checkout_reservations (
    livemode,
    stripe_subscription_id
  )
  WHERE stripe_subscription_id IS NOT NULL;

CREATE UNIQUE INDEX stripe_recurring_pro_checkout_active_user_key
  ON public.stripe_recurring_pro_checkout_reservations (livemode, user_id)
  WHERE status IN ('reserved', 'bound', 'completed');

CREATE UNIQUE INDEX stripe_recurring_pro_checkout_active_customer_key
  ON public.stripe_recurring_pro_checkout_reservations (
    livemode,
    stripe_customer_id
  )
  WHERE status IN ('reserved', 'bound', 'completed');

CREATE INDEX stripe_recurring_pro_checkout_expiry_idx
  ON public.stripe_recurring_pro_checkout_reservations (
    checkout_expires_at,
    id
  )
  WHERE status = 'reserved';

ALTER TABLE public.stripe_recurring_pro_checkout_reservations OWNER TO postgres;
ALTER TABLE public.stripe_recurring_pro_checkout_reservations ENABLE ROW LEVEL SECURITY;

CREATE POLICY stripe_recurring_pro_checkout_service_select
  ON public.stripe_recurring_pro_checkout_reservations
  FOR SELECT
  TO service_role
  USING (true);

REVOKE ALL ON TABLE public.stripe_recurring_pro_checkout_reservations
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT SELECT ON TABLE public.stripe_recurring_pro_checkout_reservations
  TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_recurring_pro_checkout_atomic(
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_plan text,
  p_stripe_price_id text,
  p_operation_id uuid,
  p_trial_requested boolean
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
  v_profile record;
  v_reservation public.stripe_recurring_pro_checkout_reservations%ROWTYPE;
  v_conflicting_user_id uuid;
  v_checkout_expires_at bigint;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_plan IS NULL
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_operation_id IS NULL
    OR p_trial_requested IS NULL
  THEN
    RAISE EXCEPTION 'invalid recurring Pro Checkout reservation input'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-customer-owner:' || p_stripe_customer_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'recurring-pro-checkout-operation:' || p_operation_id::text,
      0
    )
  );

  SELECT
    profile.id,
    profile.stripe_customer_id,
    profile.deleted_at
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_profile.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'active recurring Pro Checkout owner is missing'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_profile.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'customer',
      p_stripe_customer_id,
      p_user_id,
      'recurring_checkout_customer_owner_conflict',
      'Recurring Pro Checkout admission did not match the persisted Customer owner.',
      pg_catalog.jsonb_build_object(
        'expected_customer_id', v_profile.stripe_customer_id,
        'operation_id', p_operation_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT profile.id
  INTO v_conflicting_user_id
  FROM public.user_profiles AS profile
  WHERE profile.stripe_customer_id = p_stripe_customer_id
    AND profile.id IS DISTINCT FROM p_user_id
  FOR UPDATE;
  IF FOUND THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'customer',
      p_stripe_customer_id,
      v_conflicting_user_id,
      'recurring_checkout_customer_owner_conflict',
      'A recurring Pro Customer identity was linked to more than one user.',
      pg_catalog.jsonb_build_object(
        'requested_user_id', p_user_id,
        'existing_user_id', v_conflicting_user_id,
        'operation_id', p_operation_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT reservation.*
  INTO v_reservation
  FROM public.stripe_recurring_pro_checkout_reservations AS reservation
  WHERE reservation.livemode = p_livemode
    AND reservation.operation_id = p_operation_id
  FOR UPDATE;
  IF FOUND THEN
    IF v_reservation.user_id IS DISTINCT FROM p_user_id
      OR v_reservation.stripe_customer_id
        IS DISTINCT FROM p_stripe_customer_id
      OR v_reservation.plan IS DISTINCT FROM p_plan
      OR v_reservation.stripe_price_id
        IS DISTINCT FROM p_stripe_price_id
      OR v_reservation.trial_requested
        IS DISTINCT FROM p_trial_requested
    THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'checkout_operation',
        p_operation_id::text,
        p_user_id,
        'recurring_checkout_operation_identity_conflict',
        'A recurring Pro Checkout operation was replayed with changed immutable identity.',
        pg_catalog.jsonb_build_object(
          'existing_reservation_id', v_reservation.id,
          'existing_user_id', v_reservation.user_id,
          'requested_user_id', p_user_id,
          'existing_plan', v_reservation.plan,
          'requested_plan', p_plan
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    IF v_reservation.status = 'reserved'
      AND v_reservation.checkout_expires_at <= pg_catalog.floor(
        pg_catalog.extract('epoch', pg_catalog.clock_timestamp())
      )::bigint
    THEN
      UPDATE public.stripe_recurring_pro_checkout_reservations
      SET status = 'expired',
          release_reason = 'lease_expired',
          released_at = pg_catalog.clock_timestamp(),
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = v_reservation.id;
      RETURN pg_catalog.jsonb_build_object('status', 'operation_terminal');
    END IF;

    IF v_reservation.status IN ('reserved', 'bound') THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'existing',
        'reservation_id', v_reservation.id,
        'operation_id', v_reservation.operation_id,
        'nonce', v_reservation.reservation_nonce,
        'user_id', v_reservation.user_id,
        'livemode', v_reservation.livemode,
        'stripe_customer_id', v_reservation.stripe_customer_id,
        'plan', v_reservation.plan,
        'stripe_price_id', v_reservation.stripe_price_id,
        'trial_requested', v_reservation.trial_requested,
        'checkout_expires_at', v_reservation.checkout_expires_at,
        'checkout_session_id', v_reservation.checkout_session_id
      );
    END IF;
    IF v_reservation.status = 'completed' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'already_subscribed');
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'operation_terminal');
  END IF;

  -- Only unbound reservations may be retired by their lease timestamp. A
  -- bound Session remains potentially payable until its exact signed expired
  -- event releases it.
  UPDATE public.stripe_recurring_pro_checkout_reservations AS reservation
  SET status = 'expired',
      release_reason = 'lease_expired',
      released_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE reservation.livemode = p_livemode
    AND reservation.status = 'reserved'
    AND reservation.checkout_session_id IS NULL
    AND reservation.checkout_expires_at <= pg_catalog.floor(
      pg_catalog.extract('epoch', pg_catalog.clock_timestamp())
    )::bigint
    AND (
      reservation.user_id = p_user_id
      OR reservation.stripe_customer_id = p_stripe_customer_id
    );

  -- A completed reservation remains a hard financial barrier until the exact
  -- local subscription projection is terminal. This closes the event-order
  -- gap between Checkout completion and invoice activation.
  UPDATE public.stripe_recurring_pro_checkout_reservations AS reservation
  SET status = 'released',
      release_reason = 'subscription_terminal_before_recheckout',
      released_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE reservation.livemode = p_livemode
    AND reservation.status = 'completed'
    AND (
      reservation.user_id = p_user_id
      OR reservation.stripe_customer_id = p_stripe_customer_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.subscriptions AS subscription
      WHERE subscription.user_id = reservation.user_id
        AND subscription.stripe_subscription_id =
          reservation.stripe_subscription_id
        AND subscription.status IN (
          'canceled',
          'cancelled',
          'expired',
          'incomplete_expired'
        )
    );

  IF EXISTS (
    SELECT 1
    FROM public.subscriptions AS subscription
    WHERE (
        subscription.user_id = p_user_id
        OR subscription.stripe_customer_id = p_stripe_customer_id
      )
      AND subscription.tier IN ('pro', 'elite')
      AND subscription.status NOT IN (
        'canceled',
        'cancelled',
        'expired',
        'incomplete_expired'
      )
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_subscribed');
  END IF;

  SELECT reservation.*
  INTO v_reservation
  FROM public.stripe_recurring_pro_checkout_reservations AS reservation
  WHERE reservation.livemode = p_livemode
    AND (
      reservation.user_id = p_user_id
      OR reservation.stripe_customer_id = p_stripe_customer_id
    )
    AND reservation.status IN ('reserved', 'bound', 'completed')
  ORDER BY reservation.created_at, reservation.id
  LIMIT 1
  FOR UPDATE;
  IF FOUND THEN
    IF v_reservation.user_id IS DISTINCT FROM p_user_id
      OR v_reservation.stripe_customer_id
        IS DISTINCT FROM p_stripe_customer_id
    THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'checkout_reservation',
        v_reservation.id::text,
        p_user_id,
        'recurring_checkout_active_owner_conflict',
        'An active recurring Pro Checkout reservation crossed user or Customer ownership.',
        pg_catalog.jsonb_build_object(
          'existing_user_id', v_reservation.user_id,
          'requested_user_id', p_user_id,
          'existing_customer_id', v_reservation.stripe_customer_id,
          'requested_customer_id', p_stripe_customer_id
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    RETURN pg_catalog.jsonb_build_object('status', 'conflict');
  END IF;

  v_checkout_expires_at := pg_catalog.floor(
    pg_catalog.extract(
      'epoch',
      pg_catalog.clock_timestamp() + interval '60 minutes'
    )
  )::bigint;

  INSERT INTO public.stripe_recurring_pro_checkout_reservations (
    user_id,
    livemode,
    stripe_customer_id,
    plan,
    stripe_price_id,
    operation_id,
    trial_requested,
    status,
    checkout_expires_at
  ) VALUES (
    p_user_id,
    p_livemode,
    p_stripe_customer_id,
    p_plan,
    p_stripe_price_id,
    p_operation_id,
    p_trial_requested,
    'reserved',
    v_checkout_expires_at
  )
  RETURNING * INTO v_reservation;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'reserved',
    'reservation_id', v_reservation.id,
    'operation_id', v_reservation.operation_id,
    'nonce', v_reservation.reservation_nonce,
    'user_id', v_reservation.user_id,
    'livemode', v_reservation.livemode,
    'stripe_customer_id', v_reservation.stripe_customer_id,
    'plan', v_reservation.plan,
    'stripe_price_id', v_reservation.stripe_price_id,
    'trial_requested', v_reservation.trial_requested,
    'checkout_expires_at', v_reservation.checkout_expires_at,
    'checkout_session_id', NULL
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.bind_recurring_pro_checkout_session_atomic(
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_plan text,
  p_stripe_price_id text,
  p_operation_id uuid,
  p_reservation_id uuid,
  p_reservation_nonce uuid,
  p_trial_requested boolean,
  p_checkout_session_id text,
  p_checkout_expires_at bigint
)
RETURNS text
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
  v_profile record;
  v_reservation public.stripe_recurring_pro_checkout_reservations%ROWTYPE;
  v_conflicting_reservation
    public.stripe_recurring_pro_checkout_reservations%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_plan IS NULL
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_operation_id IS NULL
    OR p_reservation_id IS NULL
    OR p_reservation_nonce IS NULL
    OR p_trial_requested IS NULL
    OR p_checkout_session_id IS NULL
    OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_checkout_session_id) > 255
    OR p_checkout_expires_at IS NULL
    OR p_checkout_expires_at <= 0
    OR p_checkout_expires_at > 253402300799
  THEN
    RAISE EXCEPTION 'invalid recurring Pro Checkout bind input'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-customer-owner:' || p_stripe_customer_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'recurring-pro-checkout-session:' || p_checkout_session_id,
      0
    )
  );

  SELECT profile.id, profile.stripe_customer_id, profile.deleted_at
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_profile.deleted_at IS NOT NULL
    OR v_profile.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'checkout_session',
      p_checkout_session_id,
      CASE WHEN FOUND THEN p_user_id ELSE NULL END,
      'recurring_checkout_owner_inactive_before_bind',
      'The recurring Pro Checkout owner changed before Session binding.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'operation_id', p_operation_id,
        'customer_id', p_stripe_customer_id
      )
    );
    RETURN 'owner_inactive';
  END IF;

  SELECT reservation.*
  INTO v_reservation
  FROM public.stripe_recurring_pro_checkout_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_reservation.user_id IS DISTINCT FROM p_user_id
    OR v_reservation.livemode IS DISTINCT FROM p_livemode
    OR v_reservation.stripe_customer_id
      IS DISTINCT FROM p_stripe_customer_id
    OR v_reservation.plan IS DISTINCT FROM p_plan
    OR v_reservation.stripe_price_id IS DISTINCT FROM p_stripe_price_id
    OR v_reservation.operation_id IS DISTINCT FROM p_operation_id
    OR v_reservation.reservation_nonce
      IS DISTINCT FROM p_reservation_nonce
    OR v_reservation.trial_requested IS DISTINCT FROM p_trial_requested
    OR v_reservation.checkout_expires_at
      IS DISTINCT FROM p_checkout_expires_at
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'checkout_session',
      p_checkout_session_id,
      p_user_id,
      'recurring_checkout_bind_identity_conflict',
      'A recurring Pro Checkout Session bind changed immutable reservation identity.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'operation_id', p_operation_id
      )
    );
    RETURN 'identity_conflict';
  END IF;

  SELECT reservation.*
  INTO v_conflicting_reservation
  FROM public.stripe_recurring_pro_checkout_reservations AS reservation
  WHERE reservation.livemode = p_livemode
    AND reservation.checkout_session_id = p_checkout_session_id
    AND reservation.id IS DISTINCT FROM p_reservation_id
  FOR UPDATE;
  IF FOUND THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'checkout_session',
      p_checkout_session_id,
      v_conflicting_reservation.user_id,
      'recurring_checkout_session_owner_conflict',
      'A recurring Pro Checkout Session was already bound to another reservation.',
      pg_catalog.jsonb_build_object(
        'existing_reservation_id', v_conflicting_reservation.id,
        'requested_reservation_id', p_reservation_id,
        'requested_user_id', p_user_id
      )
    );
    RETURN 'identity_conflict';
  END IF;

  IF v_reservation.status = 'bound'
    AND v_reservation.checkout_session_id = p_checkout_session_id
  THEN
    RETURN 'already_bound';
  END IF;
  IF v_reservation.status = 'completed'
    AND v_reservation.checkout_session_id = p_checkout_session_id
  THEN
    RETURN 'already_completed';
  END IF;
  IF v_reservation.status IS DISTINCT FROM 'reserved'
    OR v_reservation.checkout_session_id IS NOT NULL
    OR v_reservation.checkout_expires_at <= pg_catalog.floor(
      pg_catalog.extract('epoch', pg_catalog.clock_timestamp())
    )::bigint
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'checkout_session',
      p_checkout_session_id,
      p_user_id,
      'recurring_checkout_bind_state_conflict',
      'A recurring Pro Checkout Session could not bind to the exact reserved state.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'reservation_status', v_reservation.status
      )
    );
    RETURN 'identity_conflict';
  END IF;

  UPDATE public.stripe_recurring_pro_checkout_reservations
  SET status = 'bound',
      checkout_session_id = p_checkout_session_id,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_reservation_id;
  RETURN 'bound';
END
$function$;

CREATE OR REPLACE FUNCTION public.complete_recurring_pro_checkout_atomic(
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_reservation_id uuid,
  p_operation_id uuid,
  p_reservation_nonce uuid,
  p_plan text,
  p_stripe_price_id text,
  p_trial_requested boolean,
  p_checkout_session_id text,
  p_stripe_event_id text,
  p_stripe_event_created bigint
)
RETURNS text
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
  v_reservation public.stripe_recurring_pro_checkout_reservations%ROWTYPE;
  v_conflicting_reservation
    public.stripe_recurring_pro_checkout_reservations%ROWTYPE;
  v_conflicting_user_id uuid;
  v_profile record;
  v_audit_user_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_reservation_id IS NULL
    OR p_operation_id IS NULL
    OR p_reservation_nonce IS NULL
    OR p_plan IS NULL
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_trial_requested IS NULL
    OR p_checkout_session_id IS NULL
    OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_checkout_session_id) > 255
    OR p_stripe_event_id IS NULL
    OR p_stripe_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_event_id) > 255
    OR p_stripe_event_created IS NULL
    OR p_stripe_event_created <= 0
    OR p_stripe_event_created > 253402300799
  THEN
    RAISE EXCEPTION 'invalid recurring Pro Checkout completion input'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-customer-owner:' || p_stripe_customer_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'recurring-pro-checkout-session:' || p_checkout_session_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'recurring-pro-subscription:' || p_stripe_subscription_id,
      0
    )
  );

  SELECT profile.id, profile.stripe_customer_id, profile.deleted_at
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_profile.deleted_at IS NOT NULL
    OR v_profile.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'checkout_session',
      p_checkout_session_id,
      CASE WHEN FOUND THEN p_user_id ELSE NULL END,
      'recurring_checkout_owner_changed_before_completion',
      'The recurring Pro Checkout owner changed before signed completion.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'operation_id', p_operation_id,
        'expected_customer_id', p_stripe_customer_id,
        'actual_customer_id',
          CASE WHEN FOUND THEN v_profile.stripe_customer_id ELSE NULL END
      )
    );
    RETURN 'identity_conflict';
  END IF;
  v_audit_user_id := v_profile.id;

  SELECT reservation.*
  INTO v_reservation
  FROM public.stripe_recurring_pro_checkout_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_reservation.user_id IS DISTINCT FROM p_user_id
    OR v_reservation.livemode IS DISTINCT FROM p_livemode
    OR v_reservation.stripe_customer_id
      IS DISTINCT FROM p_stripe_customer_id
    OR v_reservation.operation_id IS DISTINCT FROM p_operation_id
    OR v_reservation.reservation_nonce
      IS DISTINCT FROM p_reservation_nonce
    OR v_reservation.plan IS DISTINCT FROM p_plan
    OR v_reservation.stripe_price_id IS DISTINCT FROM p_stripe_price_id
    OR v_reservation.trial_requested IS DISTINCT FROM p_trial_requested
    OR v_reservation.checkout_session_id
      IS DISTINCT FROM p_checkout_session_id
    OR p_stripe_event_created < pg_catalog.floor(
      pg_catalog.extract('epoch', v_reservation.created_at)
    )::bigint
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'checkout_session',
      p_checkout_session_id,
      v_audit_user_id,
      'recurring_checkout_completion_identity_conflict',
      'A recurring Pro Checkout completion changed immutable reservation identity.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'subscription_id', p_stripe_subscription_id,
        'event_id', p_stripe_event_id
      )
    );
    RETURN 'identity_conflict';
  END IF;

  IF v_reservation.status = 'completed' THEN
    IF v_reservation.stripe_subscription_id = p_stripe_subscription_id
      AND v_reservation.completion_event_id = p_stripe_event_id
      AND v_reservation.completion_event_created = p_stripe_event_created
    THEN
      RETURN 'already_completed';
    END IF;
    PERFORM public.record_stripe_manual_review_atomic(
      'checkout_session',
      p_checkout_session_id,
      v_audit_user_id,
      'recurring_checkout_completion_replay_conflict',
      'A completed recurring Pro Checkout was replayed with another subscription or event.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'existing_subscription_id', v_reservation.stripe_subscription_id,
        'requested_subscription_id', p_stripe_subscription_id,
        'existing_event_id', v_reservation.completion_event_id,
        'requested_event_id', p_stripe_event_id
      )
    );
    RETURN 'identity_conflict';
  END IF;
  IF v_reservation.status IS DISTINCT FROM 'bound' THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'checkout_session',
      p_checkout_session_id,
      v_audit_user_id,
      'recurring_checkout_completion_state_conflict',
      'A recurring Pro Checkout completed outside its exact bound state.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'reservation_status', v_reservation.status
      )
    );
    RETURN 'identity_conflict';
  END IF;

  SELECT reservation.*
  INTO v_conflicting_reservation
  FROM public.stripe_recurring_pro_checkout_reservations AS reservation
  WHERE reservation.livemode = p_livemode
    AND reservation.stripe_subscription_id = p_stripe_subscription_id
    AND reservation.id IS DISTINCT FROM p_reservation_id
  FOR UPDATE;
  IF FOUND THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'subscription',
      p_stripe_subscription_id,
      v_conflicting_reservation.user_id,
      'recurring_checkout_subscription_owner_conflict',
      'A recurring Pro subscription was already completed by another reservation.',
      pg_catalog.jsonb_build_object(
        'existing_reservation_id', v_conflicting_reservation.id,
        'requested_reservation_id', p_reservation_id,
        'requested_user_id', p_user_id
      )
    );
    RETURN 'identity_conflict';
  END IF;

  SELECT subscription.user_id
  INTO v_conflicting_user_id
  FROM public.subscriptions AS subscription
  WHERE subscription.stripe_subscription_id = p_stripe_subscription_id
    AND subscription.user_id IS DISTINCT FROM p_user_id
  FOR UPDATE;
  IF FOUND THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'subscription',
      p_stripe_subscription_id,
      v_conflicting_user_id,
      'recurring_checkout_subscription_owner_conflict',
      'A recurring Pro Checkout subscription was already owned by another user.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'requested_user_id', p_user_id,
        'existing_user_id', v_conflicting_user_id
      )
    );
    RETURN 'identity_conflict';
  END IF;

  SELECT profile.id
  INTO v_conflicting_user_id
  FROM public.user_profiles AS profile
  WHERE profile.stripe_customer_id = p_stripe_customer_id
    AND profile.id IS DISTINCT FROM p_user_id
  FOR UPDATE;
  IF FOUND THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'customer',
      p_stripe_customer_id,
      v_conflicting_user_id,
      'recurring_checkout_customer_owner_conflict',
      'A completed recurring Pro Checkout Customer belonged to another user.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'requested_user_id', p_user_id,
        'existing_user_id', v_conflicting_user_id
      )
    );
    RETURN 'identity_conflict';
  END IF;

  UPDATE public.stripe_recurring_pro_checkout_reservations
  SET status = 'completed',
      stripe_subscription_id = p_stripe_subscription_id,
      completion_event_id = p_stripe_event_id,
      completion_event_created = p_stripe_event_created,
      completed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_reservation_id;
  RETURN 'completed';
END
$function$;

CREATE OR REPLACE FUNCTION public.release_recurring_pro_checkout_atomic(
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_reservation_id uuid,
  p_operation_id uuid,
  p_reservation_nonce uuid,
  p_plan text,
  p_stripe_price_id text,
  p_trial_requested boolean,
  p_checkout_session_id text,
  p_stripe_event_id text,
  p_stripe_event_created bigint
)
RETURNS text
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
  v_reservation public.stripe_recurring_pro_checkout_reservations%ROWTYPE;
  v_audit_user_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_reservation_id IS NULL
    OR p_operation_id IS NULL
    OR p_reservation_nonce IS NULL
    OR p_plan IS NULL
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_trial_requested IS NULL
    OR p_checkout_session_id IS NULL
    OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_checkout_session_id) > 255
    OR p_stripe_event_id IS NULL
    OR p_stripe_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_event_id) > 255
    OR p_stripe_event_created IS NULL
    OR p_stripe_event_created <= 0
    OR p_stripe_event_created > 253402300799
  THEN
    RAISE EXCEPTION 'invalid recurring Pro Checkout release input'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-user:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-customer-owner:' || p_stripe_customer_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'recurring-pro-checkout-session:' || p_checkout_session_id,
      0
    )
  );

  SELECT profile.id
  INTO v_audit_user_id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  SELECT reservation.*
  INTO v_reservation
  FROM public.stripe_recurring_pro_checkout_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_reservation.user_id IS DISTINCT FROM p_user_id
    OR v_reservation.livemode IS DISTINCT FROM p_livemode
    OR v_reservation.stripe_customer_id
      IS DISTINCT FROM p_stripe_customer_id
    OR v_reservation.operation_id IS DISTINCT FROM p_operation_id
    OR v_reservation.reservation_nonce
      IS DISTINCT FROM p_reservation_nonce
    OR v_reservation.plan IS DISTINCT FROM p_plan
    OR v_reservation.stripe_price_id IS DISTINCT FROM p_stripe_price_id
    OR v_reservation.trial_requested IS DISTINCT FROM p_trial_requested
    OR v_reservation.checkout_session_id
      IS DISTINCT FROM p_checkout_session_id
    OR p_stripe_event_created < pg_catalog.floor(
      pg_catalog.extract('epoch', v_reservation.created_at)
    )::bigint
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'checkout_session',
      p_checkout_session_id,
      v_audit_user_id,
      'recurring_checkout_expiry_identity_conflict',
      'A signed recurring Pro Checkout expiration changed reservation identity.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'event_id', p_stripe_event_id
      )
    );
    RETURN 'identity_conflict';
  END IF;

  IF v_reservation.status = 'completed' THEN
    RETURN 'already_completed';
  END IF;
  IF v_reservation.status = 'released' THEN
    IF v_reservation.release_reason = 'checkout_session_expired'
      AND v_reservation.release_event_id = p_stripe_event_id
      AND v_reservation.release_event_created = p_stripe_event_created
    THEN
      RETURN 'already_released';
    END IF;
    PERFORM public.record_stripe_manual_review_atomic(
      'checkout_session',
      p_checkout_session_id,
      v_audit_user_id,
      'recurring_checkout_expiry_replay_conflict',
      'A recurring Pro Checkout expiration replay changed signed event identity.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'existing_event_id', v_reservation.release_event_id,
        'requested_event_id', p_stripe_event_id
      )
    );
    RETURN 'identity_conflict';
  END IF;
  IF v_reservation.status IS DISTINCT FROM 'bound' THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'checkout_session',
      p_checkout_session_id,
      v_audit_user_id,
      'recurring_checkout_expiry_state_conflict',
      'A signed recurring Pro Checkout expiration did not target a bound reservation.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'reservation_status', v_reservation.status
      )
    );
    RETURN 'identity_conflict';
  END IF;

  UPDATE public.stripe_recurring_pro_checkout_reservations
  SET status = 'released',
      release_reason = 'checkout_session_expired',
      release_event_id = p_stripe_event_id,
      release_event_created = p_stripe_event_created,
      released_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_reservation_id;
  RETURN 'released';
END
$function$;

CREATE OR REPLACE FUNCTION public.assert_recurring_pro_checkout_completed_atomic(
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_reservation_id uuid,
  p_operation_id uuid,
  p_reservation_nonce uuid,
  p_plan text,
  p_stripe_price_id text,
  p_trial_requested boolean
)
RETURNS text
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
  v_reservation public.stripe_recurring_pro_checkout_reservations%ROWTYPE;
  v_audit_user_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_reservation_id IS NULL
    OR p_operation_id IS NULL
    OR p_reservation_nonce IS NULL
    OR p_plan IS NULL
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_trial_requested IS NULL
  THEN
    RAISE EXCEPTION 'invalid recurring Pro Checkout assertion input'
      USING ERRCODE = '22023';
  END IF;

  SELECT profile.id
  INTO v_audit_user_id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id;

  SELECT reservation.*
  INTO v_reservation
  FROM public.stripe_recurring_pro_checkout_reservations AS reservation
  WHERE reservation.id = p_reservation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'recurring Pro Checkout completion is not durable yet'
      USING ERRCODE = '40001';
  END IF;
  IF v_reservation.user_id IS DISTINCT FROM p_user_id
    OR v_reservation.livemode IS DISTINCT FROM p_livemode
    OR v_reservation.stripe_customer_id
      IS DISTINCT FROM p_stripe_customer_id
    OR v_reservation.operation_id IS DISTINCT FROM p_operation_id
    OR v_reservation.reservation_nonce
      IS DISTINCT FROM p_reservation_nonce
    OR v_reservation.plan IS DISTINCT FROM p_plan
    OR v_reservation.stripe_price_id IS DISTINCT FROM p_stripe_price_id
    OR v_reservation.trial_requested IS DISTINCT FROM p_trial_requested
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'subscription',
      p_stripe_subscription_id,
      v_audit_user_id,
      'recurring_checkout_assertion_identity_conflict',
      'A recurring Pro entitlement event changed completed Checkout identity.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'reservation_status', v_reservation.status,
        'stored_subscription_id', v_reservation.stripe_subscription_id
      )
    );
    RETURN 'identity_conflict';
  END IF;
  IF v_reservation.status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'recurring Pro Checkout completion is not durable yet'
      USING ERRCODE = '40001';
  END IF;
  IF v_reservation.stripe_subscription_id
    IS DISTINCT FROM p_stripe_subscription_id
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'subscription',
      p_stripe_subscription_id,
      v_audit_user_id,
      'recurring_checkout_assertion_identity_conflict',
      'A recurring Pro entitlement event changed completed Checkout identity.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_reservation_id,
        'reservation_status', v_reservation.status,
        'stored_subscription_id', v_reservation.stripe_subscription_id
      )
    );
    RETURN 'identity_conflict';
  END IF;
  RETURN 'completed';
END
$function$;

ALTER FUNCTION public.reserve_recurring_pro_checkout_atomic(
  uuid, boolean, text, text, text, uuid, boolean
) OWNER TO postgres;
ALTER FUNCTION public.bind_recurring_pro_checkout_session_atomic(
  uuid, boolean, text, text, text, uuid, uuid, uuid, boolean, text, bigint
) OWNER TO postgres;
ALTER FUNCTION public.complete_recurring_pro_checkout_atomic(
  uuid, boolean, text, text, uuid, uuid, uuid, text, text, boolean,
  text, text, bigint
) OWNER TO postgres;
ALTER FUNCTION public.release_recurring_pro_checkout_atomic(
  uuid, boolean, text, uuid, uuid, uuid, text, text, boolean,
  text, text, bigint
) OWNER TO postgres;
ALTER FUNCTION public.assert_recurring_pro_checkout_completed_atomic(
  uuid, boolean, text, text, uuid, uuid, uuid, text, text, boolean
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.reserve_recurring_pro_checkout_atomic(
  uuid, boolean, text, text, text, uuid, boolean
) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.bind_recurring_pro_checkout_session_atomic(
  uuid, boolean, text, text, text, uuid, uuid, uuid, boolean, text, bigint
) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.complete_recurring_pro_checkout_atomic(
  uuid, boolean, text, text, uuid, uuid, uuid, text, text, boolean,
  text, text, bigint
) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.release_recurring_pro_checkout_atomic(
  uuid, boolean, text, uuid, uuid, uuid, text, text, boolean,
  text, text, bigint
) FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.assert_recurring_pro_checkout_completed_atomic(
  uuid, boolean, text, text, uuid, uuid, uuid, text, text, boolean
) FROM PUBLIC, anon, authenticated, authenticator;

GRANT EXECUTE ON FUNCTION public.reserve_recurring_pro_checkout_atomic(
  uuid, boolean, text, text, text, uuid, boolean
) TO service_role;
GRANT EXECUTE ON FUNCTION public.bind_recurring_pro_checkout_session_atomic(
  uuid, boolean, text, text, text, uuid, uuid, uuid, boolean, text, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_recurring_pro_checkout_atomic(
  uuid, boolean, text, text, uuid, uuid, uuid, text, text, boolean,
  text, text, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_recurring_pro_checkout_atomic(
  uuid, boolean, text, uuid, uuid, uuid, text, text, boolean,
  text, text, bigint
) TO service_role;
GRANT EXECUTE ON FUNCTION public.assert_recurring_pro_checkout_completed_atomic(
  uuid, boolean, text, text, uuid, uuid, uuid, text, text, boolean
) TO service_role;

DO $postflight$
DECLARE
  v_function pg_catalog.regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
      'public.stripe_recurring_pro_checkout_reservations'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND relation.relowner = pg_catalog.to_regrole('postgres')
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'recurring Pro Checkout reservation relation is unsafe';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.reserve_recurring_pro_checkout_atomic(uuid,boolean,text,text,text,uuid,boolean)'::pg_catalog.regprocedure,
    'public.bind_recurring_pro_checkout_session_atomic(uuid,boolean,text,text,text,uuid,uuid,uuid,boolean,text,bigint)'::pg_catalog.regprocedure,
    'public.complete_recurring_pro_checkout_atomic(uuid,boolean,text,text,uuid,uuid,uuid,text,text,boolean,text,text,bigint)'::pg_catalog.regprocedure,
    'public.release_recurring_pro_checkout_atomic(uuid,boolean,text,uuid,uuid,uuid,text,text,boolean,text,text,bigint)'::pg_catalog.regprocedure,
    'public.assert_recurring_pro_checkout_completed_atomic(uuid,boolean,text,text,uuid,uuid,uuid,text,text,boolean)'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND function_row.proowner = pg_catalog.to_regrole('postgres')
        AND function_row.prosecdef
        AND function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off'
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
        AND acl_row.grantee <> pg_catalog.to_regrole('service_role')
        AND acl_row.grantee <> pg_catalog.to_regrole('postgres')
        AND acl_row.privilege_type = 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'recurring Pro Checkout authority owner or ACL drifted';
    END IF;
  END LOOP;
END
$postflight$;

COMMIT;
