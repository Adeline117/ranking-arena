-- Treat Stripe refund events as unordered wakeups over a fresh Charge
-- aggregate. Equivalent or monotonic observations converge without opening a
-- false manual review; only a real succeeded-refund amount decrease is
-- quarantined. This PREDEPLOY migration changes no table or public signature.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_signature pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.reconcile_stripe_entitlement_refund_atomic(uuid,text,text,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,bigint,text,text,text,timestamp with time zone)'
    );
  v_definition text;
  v_is_predecessor boolean;
  v_is_current boolean;
BEGIN
  IF v_signature IS NULL THEN
    RAISE EXCEPTION
      'Stripe entitlement refund reconciler is missing';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(v_signature);
  v_is_predecessor :=
    v_definition LIKE '%v_ambiguous_event_order boolean := false%'
    AND v_definition LIKE '%ambiguous_refund_event_order%'
    AND v_definition NOT LIKE '%charge_refund_aggregate_decreased%'
    AND v_definition LIKE
      '%IF v_payment.latest_refund_event_created_at IS NOT NULL%';
  v_is_current :=
    v_definition NOT LIKE '%ambiguous_refund_event_order%'
    AND v_definition LIKE '%v_same_applied_observation boolean := false%'
    AND v_definition LIKE '%charge_refund_aggregate_decreased%'
    AND v_definition ~
      'p_refund_succeeded_amount[[:space:]]+<[[:space:]]+v_payment[.]refund_succeeded_amount';
  IF NOT v_is_predecessor
    AND NOT v_is_current
  THEN
    RAISE EXCEPTION
      'Stripe entitlement refund reconciler predecessor drifted';
  END IF;
END
$preflight$;

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
  v_applied_observation jsonb;
  v_incoming_observation jsonb;
  v_same_applied_observation boolean := false;
  v_inserted_event_id text;
  v_is_full_refund boolean;
  v_incoming_full_refund boolean;
  v_existing_full_refund boolean;
  v_profile_exists boolean;
  v_subject_active boolean := false;
  v_subject_deleted boolean := false;
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

  v_incoming_observation := pg_catalog.jsonb_build_object(
    'refund_state', p_refund_state,
    'refund_succeeded_amount', p_refund_succeeded_amount,
    'stripe_subscription_status', p_stripe_subscription_status
  );

  -- Compare against the exact last observation that produced the currently
  -- applied payment snapshot. Compute this before inserting or appending the
  -- incoming event so a replay cannot prove its own equivalence.
  IF v_payment.refund_snapshot_event_id IS NOT NULL
    AND v_payment.refund_snapshot_event_created_at IS NOT NULL
  THEN
    SELECT observation.value
    INTO v_applied_observation
    FROM public.stripe_entitlement_refund_events AS snapshot_event
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
      snapshot_event.observations
    ) WITH ORDINALITY AS observation(value, position)
    WHERE snapshot_event.event_id =
        v_payment.refund_snapshot_event_id
      AND snapshot_event.entitlement_payment_id = v_payment.id
      AND snapshot_event.event_created_at =
        v_payment.refund_snapshot_event_created_at
    ORDER BY observation.position DESC
    LIMIT 1;
  END IF;
  v_same_applied_observation :=
    v_payment.refund_state IS NOT DISTINCT FROM p_refund_state
    AND v_payment.refund_succeeded_amount
      IS NOT DISTINCT FROM p_refund_succeeded_amount
    AND v_applied_observation IS NOT DISTINCT FROM
      v_incoming_observation;

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
    pg_catalog.jsonb_build_array(v_incoming_observation)
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
    -- through terminal/max-watermark reconciliation on redelivery. An old
    -- event id carrying a newly observed aggregate must not short-circuit.
    IF NOT (
      v_existing_event.observations @>
        pg_catalog.jsonb_build_array(v_incoming_observation)
    ) THEN
      UPDATE public.stripe_entitlement_refund_events
      SET observations =
            observations
            || pg_catalog.jsonb_build_array(v_incoming_observation),
          observed_at = pg_catalog.clock_timestamp()
      WHERE event_id = p_refund_event_id;
    END IF;
  END IF;

  -- A different Stripe Event may be an equivalent wakeup for the same fresh
  -- business projection. Keep its immutable audit row, advance only the
  -- max-seen envelope watermark, and leave the applied snapshot untouched.
  IF v_same_applied_observation THEN
    UPDATE public.stripe_entitlement_payments
    SET latest_refund_event_id = p_refund_event_id,
        latest_refund_event_created_at = p_refund_event_created_at,
        updated_at = v_now
    WHERE id = v_payment.id
      AND (
        latest_refund_event_created_at IS NULL
        OR p_refund_event_created_at > latest_refund_event_created_at
      );
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'already_reconciled'
    );
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

  -- Stripe event.created orders webhook envelopes, not the fresh Charge
  -- aggregate read by the handler. Different events can legitimately share a
  -- second or arrive out of order, so financial authority is the monotonic
  -- succeeded-refund amount. Preserve the applied snapshot and review only a
  -- real aggregate decrease.
  IF p_refund_succeeded_amount
      < v_payment.refund_succeeded_amount
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
      'charge_refund_aggregate_decreased',
      'A fresh Stripe Charge aggregate attempted to decrease refunded amount.',
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
        'review:charge_refund_aggregate_decreased:' || p_refund_event_id,
        'payment_manual_review',
        pg_catalog.jsonb_build_object(
          'reason_key', 'charge_refund_aggregate_decreased'
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

REVOKE ALL ON FUNCTION
  public.reconcile_stripe_entitlement_refund_atomic(
    uuid, text, text, text, text, text, text, text, text, bigint, text,
    timestamptz, timestamptz, text, bigint, text, text, text, timestamptz
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.reconcile_stripe_entitlement_refund_atomic(
    uuid, text, text, text, text, text, text, text, text, bigint, text,
    timestamptz, timestamptz, text, bigint, text, text, text, timestamptz
  )
TO service_role;

DO $postflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'public.reconcile_stripe_entitlement_refund_atomic(uuid,text,text,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,text,bigint,text,text,text,timestamp with time zone)'
  );
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
  v_definition text;
BEGIN
  IF v_function IS NULL
    OR v_postgres IS NULL
    OR v_service_role IS NULL
  THEN
    RAISE EXCEPTION
      'Stripe refund-event equivalence postflight prerequisites are missing';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(v_function);
  IF v_definition LIKE '%ambiguous_refund_event_order%'
    OR v_definition NOT LIKE '%charge_refund_aggregate_decreased%'
    OR v_definition !~
      'p_refund_succeeded_amount[[:space:]]+<[[:space:]]+v_payment[.]refund_succeeded_amount'
  THEN
    RAISE EXCEPTION
      'Stripe refund-event equivalence function body drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND (
        function_row.proowner IS DISTINCT FROM v_postgres
        OR function_row.prorettype IS DISTINCT FROM
          'pg_catalog.jsonb'::pg_catalog.regtype
        OR function_row.prosecdef IS DISTINCT FROM true
        OR NOT pg_catalog.has_function_privilege(
          'service_role',
          v_function,
          'EXECUTE'
        )
        OR pg_catalog.has_function_privilege(
          'anon',
          v_function,
          'EXECUTE'
        )
        OR pg_catalog.has_function_privilege(
          'authenticated',
          v_function,
          'EXECUTE'
        )
      )
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
  ) THEN
    RAISE EXCEPTION
      'Stripe refund-event equivalence owner or ACL drifted';
  END IF;
END
$postflight$;

COMMIT;
