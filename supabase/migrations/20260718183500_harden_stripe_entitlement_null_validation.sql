-- Fail closed on NULL Stripe enums and malformed official-group leave ACKs.
-- This PREDEPLOY migration only replaces existing function bodies.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.record_charge_refund_tombstone_atomic(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)'
        ),
        (
          'public.release_lifetime_membership_reservation_atomic(uuid,uuid,text,text,text,text,timestamp with time zone)'
        ),
        (
          'public.reconcile_due_pro_entitlement_projections_atomic(integer,uuid)'
        ),
        (
          'public.revoke_pro_entitlement_grant_atomic(uuid,text,text,timestamp with time zone)'
        ),
        (
          'public.activate_recurring_entitlement_payment_atomic(uuid,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text)'
        ),
        (
          'public.activate_recurring_trial_entitlement_atomic(uuid,text,text,text,timestamp with time zone,timestamp with time zone,text)'
        ),
        (
          'public.reconcile_recurring_subscription_state_atomic(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone)'
        ),
        (
          'public.reconcile_stripe_entitlement_refund_atomic(uuid,text,text,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,bigint,text,text,text,timestamp with time zone)'
        )
    ) AS required_function(signature)
    WHERE pg_catalog.to_regprocedure(required_function.signature) IS NULL
  ) THEN
    RAISE EXCEPTION
      '20260718183000 Stripe entitlement authority functions are missing';
  END IF;
END
$preflight$;

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
    OR p_refund_state IS NULL
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
    OR p_release_reason IS NULL
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
      AND (
        p_release_reason IS NULL
        OR p_release_reason NOT IN (
          'stripe_checkout_create_failed',
          'stripe_checkout_abandoned'
        )
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
      IF COALESCE(v_leave_ack ->> 'status', '')
        NOT IN ('left', 'not_member')
      THEN
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
  IF COALESCE(v_leave_ack ->> 'status', '')
    NOT IN ('left', 'not_member')
  THEN
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
    OR p_plan IS NULL
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_amount_paid IS NULL
    OR p_amount_paid <= 0
    OR p_currency IS NULL
    OR p_currency !~ '^[a-z]{3}$'
    OR p_period_start IS NULL
    OR p_period_end IS NULL
    OR p_period_end <= p_period_start
    OR p_payment_status IS NULL
    OR p_stripe_subscription_status IS NULL
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
  IF p_payment_status IS NULL
    OR p_payment_status NOT IN ('paid', 'succeeded')
  THEN
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

  IF p_stripe_subscription_status IS NULL
    OR p_stripe_subscription_status NOT IN ('active', 'trialing')
  THEN
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
    OR p_plan IS NULL
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
      IF COALESCE(v_leave_ack ->> 'status', '')
        NOT IN ('left', 'not_member')
      THEN
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

ALTER FUNCTION public.reconcile_recurring_subscription_state_atomic(
  uuid, text, text, text, text, timestamptz, timestamptz, text,
  boolean, timestamptz, timestamptz, text, timestamptz
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
    OR p_payment_kind IS NULL
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
    OR p_payment_status IS NULL
    OR p_payment_status NOT IN ('paid', 'succeeded')
    OR p_refund_succeeded_amount IS NULL
    OR p_refund_succeeded_amount < 0
    OR p_refund_succeeded_amount > p_amount_paid
    OR (
      p_refund_succeeded_amount = p_amount_paid
      AND p_refund_state IS DISTINCT FROM 'succeeded'
    )
    OR p_refund_state IS NULL
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
      p_plan IS NULL
      OR p_plan NOT IN ('monthly', 'yearly')
      OR pg_catalog.left(COALESCE(p_stripe_subscription_id, ''), 4) <> 'sub_'
      OR pg_catalog.left(COALESCE(p_stripe_invoice_id, ''), 3) <> 'in_'
      OR p_checkout_session_id IS NOT NULL
      OR p_period_end IS NULL
      OR p_period_end <= p_period_start
      OR p_stripe_subscription_status IS NULL
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
      IF COALESCE(v_leave_ack ->> 'status', '')
        NOT IN ('left', 'not_member')
      THEN
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
      IF COALESCE(v_leave_ack ->> 'status', '')
        NOT IN ('left', 'not_member')
      THEN
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
    IF COALESCE(v_leave_ack ->> 'status', '')
      NOT IN ('left', 'not_member')
    THEN
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

DO $postflight$
DECLARE
  v_postgres oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_role oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF v_postgres IS NULL OR v_service_role IS NULL THEN
    RAISE EXCEPTION 'required Stripe entitlement roles are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.record_charge_refund_tombstone_atomic(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)'
        ),
        (
          'public.release_lifetime_membership_reservation_atomic(uuid,uuid,text,text,text,text,timestamp with time zone)'
        ),
        (
          'public.reconcile_due_pro_entitlement_projections_atomic(integer,uuid)'
        ),
        (
          'public.revoke_pro_entitlement_grant_atomic(uuid,text,text,timestamp with time zone)'
        ),
        (
          'public.activate_recurring_entitlement_payment_atomic(uuid,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text)'
        ),
        (
          'public.activate_recurring_trial_entitlement_atomic(uuid,text,text,text,timestamp with time zone,timestamp with time zone,text)'
        ),
        (
          'public.reconcile_recurring_subscription_state_atomic(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone)'
        ),
        (
          'public.reconcile_stripe_entitlement_refund_atomic(uuid,text,text,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,bigint,text,text,text,timestamp with time zone)'
        )
    ) AS required_function(signature)
    LEFT JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid =
        pg_catalog.to_regprocedure(required_function.signature)
    WHERE function_row.oid IS NULL
      OR function_row.proowner IS DISTINCT FROM v_postgres
      OR function_row.prorettype IS DISTINCT FROM
        'pg_catalog.jsonb'::pg_catalog.regtype
      OR function_row.prosecdef IS DISTINCT FROM true
      OR NOT pg_catalog.has_function_privilege(
        'service_role',
        required_function.signature,
        'EXECUTE'
      )
      OR pg_catalog.has_function_privilege(
        'anon',
        required_function.signature,
        'EXECUTE'
      )
      OR pg_catalog.has_function_privilege(
        'authenticated',
        required_function.signature,
        'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION
      'Stripe entitlement NULL hardening function contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.record_charge_refund_tombstone_atomic(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)'
        ),
        (
          'public.release_lifetime_membership_reservation_atomic(uuid,uuid,text,text,text,text,timestamp with time zone)'
        ),
        (
          'public.reconcile_due_pro_entitlement_projections_atomic(integer,uuid)'
        ),
        (
          'public.revoke_pro_entitlement_grant_atomic(uuid,text,text,timestamp with time zone)'
        ),
        (
          'public.activate_recurring_entitlement_payment_atomic(uuid,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,text)'
        ),
        (
          'public.activate_recurring_trial_entitlement_atomic(uuid,text,text,text,timestamp with time zone,timestamp with time zone,text)'
        ),
        (
          'public.reconcile_recurring_subscription_state_atomic(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,text,boolean,timestamp with time zone,timestamp with time zone,text,timestamp with time zone)'
        ),
        (
          'public.reconcile_stripe_entitlement_refund_atomic(uuid,text,text,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,bigint,text,text,text,timestamp with time zone)'
        )
    ) AS required_function(signature)
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid =
        pg_catalog.to_regprocedure(required_function.signature)
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_row
    WHERE acl_row.grantee NOT IN (v_postgres, v_service_role)
  ) THEN
    RAISE EXCEPTION
      'Stripe entitlement NULL hardening function ACL drifted';
  END IF;
END
$postflight$;

COMMIT;
