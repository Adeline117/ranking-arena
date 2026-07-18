-- Repair the lifetime terminal contract: recover reservations by durable
-- nonce, accept exact bound early signed expiry, preserve duplicate refund
-- outbox durability, and cancel only an exact superseded recurring identity.
-- This PREDEPLOY migration only replaces existing function bodies.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;

DO $preflight$
DECLARE
  v_function pg_catalog.regprocedure;
  v_definition text;
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service_role oid := pg_catalog.to_regrole('service_role');
BEGIN
  IF v_postgres IS NULL OR v_service_role IS NULL THEN
    RAISE EXCEPTION 'Stripe lifetime corrective roles are missing';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.reserve_lifetime_membership_spot_atomic(uuid,text,integer)'::pg_catalog.regprocedure,
    'public.release_lifetime_membership_reservation_atomic(uuid,uuid,text,text,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.activate_lifetime_membership_with_identity_atomic(uuid,text,text,uuid,text,text,bigint,text,timestamp with time zone,text)'::pg_catalog.regprocedure,
    'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      JOIN pg_catalog.pg_language AS language_row
        ON language_row.oid = function_row.prolang
      WHERE function_row.oid = v_function
        AND function_row.proowner = v_postgres
        AND function_row.prorettype =
          'pg_catalog.jsonb'::pg_catalog.regtype
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.proparallel = 'u'
        AND language_row.lanname = 'plpgsql'
        AND function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
        AND pg_catalog.cardinality(function_row.proconfig) = 2
    ) OR NOT pg_catalog.has_function_privilege(
      'service_role',
      v_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon',
      v_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated',
      v_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticator',
      v_function,
      'EXECUTE'
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
        'Stripe lifetime corrective function contract drifted: %',
        v_function;
    END IF;
  END LOOP;

  v_function :=
    'public.stripe_entitlement_effect_is_current_v2(uuid)'::pg_catalog.regprocedure;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres
      AND function_row.prorettype =
        'pg_catalog.bool'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.proparallel = 'u'
      AND language_row.lanname = 'sql'
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
      AND pg_catalog.cardinality(function_row.proconfig) = 1
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
    RAISE EXCEPTION
      'Stripe lifetime effect currentness contract drifted';
  END IF;

  v_function :=
    'public.lease_stripe_entitlement_effects_atomic(integer,integer)'::pg_catalog.regprocedure;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres
      AND function_row.proretset
      AND function_row.prorettype =
        'public.stripe_entitlement_effects'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND language_row.lanname = 'plpgsql'
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.cardinality(function_row.proconfig) = 2
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_function,
    'EXECUTE'
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
      'Stripe lifetime effect lease contract drifted';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.activate_lifetime_membership_with_identity_atomic(uuid,text,text,uuid,text,text,bigint,text,timestamp with time zone,text)'::pg_catalog.regprocedure
  );
  IF pg_catalog.regexp_count(
      v_definition,
      '\mv_effective_user_id\M'
    ) IS DISTINCT FROM 1
    OR v_definition NOT LIKE '%duplicate_lifetime_purchase%'
    OR v_definition NOT LIKE '%duplicate_refund_queued%'
  THEN
    RAISE EXCEPTION
      'duplicate lifetime refund rollback fingerprint drifted';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.release_lifetime_membership_reservation_atomic(uuid,uuid,text,text,text,text,timestamp with time zone)'::pg_catalog.regprocedure
  );
  IF pg_catalog.regexp_count(
      v_definition,
      'p_event_created_at < v_reservation.checkout_expires_at'
    ) IS DISTINCT FROM 1
  THEN
    RAISE EXCEPTION
      'bound lifetime early-expiration leak fingerprint drifted';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.reserve_lifetime_membership_spot_atomic(uuid,text,integer)'::pg_catalog.regprocedure
  );
  IF pg_catalog.regexp_count(
      v_definition,
      '''request_nonce'',[[:space:]]+v_existing.request_nonce'
    ) IS DISTINCT FROM 0
  THEN
    RAISE EXCEPTION
      'lifetime reservation recovery response fingerprint drifted';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.stripe_entitlement_effect_is_current_v2(uuid)'::pg_catalog.regprocedure
  );
  IF v_definition LIKE '%stripe_subscription_cancel%' THEN
    RAISE EXCEPTION
      'lifetime subscription cancellation currentness fingerprint drifted';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.lease_stripe_entitlement_effects_atomic(integer,integer)'::pg_catalog.regprocedure
  );
  IF v_definition LIKE '%stripe_subscription_cancel%' THEN
    RAISE EXCEPTION
      'Stripe lifetime cancellation lease fingerprint drifted';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)'::pg_catalog.regprocedure
  );
  IF v_definition LIKE '%stripe_subscription_cancel%' THEN
    RAISE EXCEPTION
      'Stripe lifetime cancellation finish fingerprint drifted';
  END IF;
END
$preflight$;

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
      'request_nonce',
      v_existing.request_nonce,
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
      'request_nonce',
      v_existing.request_nonce,
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
        OR p_event_created_at
          < v_reservation.created_at
            - pg_catalog.make_interval(mins => 5)
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
  v_subscription_found boolean := false;
  v_profile_exists boolean := false;
  v_subject_active boolean := false;
  v_profile_customer_id text;
  v_audit_user_id uuid;
  v_safe_refund_identity boolean := false;
  v_tombstone_merge jsonb;
  v_superseded_stripe_subscription_id text;
  v_superseded_stripe_customer_id text;
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
  v_subscription_found := FOUND;

  IF v_subscription_found
    AND v_subscription.plan IN ('monthly', 'yearly')
    AND v_subscription.status IN ('active', 'trialing')
    AND pg_catalog.left(
      COALESCE(v_subscription.stripe_subscription_id, ''),
      4
    ) = 'sub_'
    AND pg_catalog.left(
      COALESCE(v_subscription.stripe_customer_id, ''),
      4
    ) = 'cus_'
    AND (
      public.stripe_subscription_has_exact_payment_binding_v2(p_user_id)
      OR public.stripe_subscription_has_exact_trial_binding_v2(p_user_id)
    )
  THEN
    v_superseded_stripe_subscription_id :=
      v_subscription.stripe_subscription_id;
    v_superseded_stripe_customer_id :=
      v_subscription.stripe_customer_id;
  END IF;

  IF v_subscription_found
    AND v_subscription.entitlement_payment_id = v_payment.id
    AND v_subscription.status = 'active'
    AND public.stripe_subscription_has_exact_payment_binding_v2(p_user_id)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_activated');
  END IF;

  IF v_subscription_found
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
        p_user_id,
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
  IF v_superseded_stripe_subscription_id IS NOT NULL THEN
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
      'cancel:subscription:' || v_superseded_stripe_subscription_id,
      'stripe_subscription_cancel',
      pg_catalog.jsonb_build_object(
        'stripe_subscription_id',
          v_superseded_stripe_subscription_id,
        'stripe_customer_id',
          v_superseded_stripe_customer_id,
        'reason',
          'lifetime_membership_activated'
      )
    )
    ON CONFLICT (
      source_kind,
      source_key,
      effect_type,
      operation_key
    ) DO NOTHING;
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
            effect.effect_type = 'stripe_subscription_cancel'
            AND effect.source_kind = 'payment'
            AND effect.payload ->> 'reason' =
              'lifetime_membership_activated'
            AND pg_catalog.left(
              COALESCE(
                effect.payload ->> 'stripe_subscription_id',
                ''
              ),
              4
            ) = 'sub_'
            AND pg_catalog.left(
              COALESCE(
                effect.payload ->> 'stripe_customer_id',
                ''
              ),
              4
            ) = 'cus_'
            AND effect.operation_key =
              'cancel:subscription:'
                || (effect.payload ->> 'stripe_subscription_id')
            AND EXISTS (
              SELECT 1
              FROM public.stripe_entitlement_payments AS payment
              WHERE payment.id = effect.entitlement_payment_id
                AND payment.payment_kind = 'lifetime'
                AND payment.plan = 'lifetime'
                AND payment.payment_status = 'succeeded'
                AND payment.stripe_customer_id =
                  effect.payload ->> 'stripe_customer_id'
                AND NOT (
                  payment.refund_state = 'succeeded'
                  AND payment.refund_succeeded_amount
                    >= payment.amount_paid
                )
                AND (
                  (
                    payment.user_id IS NOT NULL
                    AND effect.user_id = payment.user_id
                    AND EXISTS (
                      SELECT 1
                      FROM public.subscriptions AS subscription
                      WHERE subscription.entitlement_payment_id = payment.id
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
                    AND effect.user_id IS NULL
                    AND NOT EXISTS (
                      SELECT 1
                      FROM public.subscriptions AS subscription
                      WHERE subscription.entitlement_payment_id = payment.id
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
                    AND payment.refund_succeeded_amount
                      >= payment.amount_paid
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
          'payment_manual_review',
          'stripe_subscription_cancel'
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
      'payment_manual_review',
      'stripe_subscription_cancel'
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

REVOKE ALL ON FUNCTION public.release_lifetime_membership_reservation_atomic(uuid,uuid,text,text,text,text,timestamp with time zone)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.release_lifetime_membership_reservation_atomic(uuid,uuid,text,text,text,text,timestamp with time zone)
  TO service_role;

REVOKE ALL ON FUNCTION public.activate_lifetime_membership_with_identity_atomic(uuid,text,text,uuid,text,text,bigint,text,timestamp with time zone,text)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.activate_lifetime_membership_with_identity_atomic(uuid,text,text,uuid,text,text,bigint,text,timestamp with time zone,text)
  TO service_role;

REVOKE ALL ON FUNCTION public.reserve_lifetime_membership_spot_atomic(uuid,text,integer)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.reserve_lifetime_membership_spot_atomic(uuid,text,integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.stripe_entitlement_effect_is_current_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

REVOKE ALL ON FUNCTION public.lease_stripe_entitlement_effects_atomic(integer,integer)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.lease_stripe_entitlement_effects_atomic(integer,integer)
  TO service_role;

REVOKE ALL ON FUNCTION public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)
  TO service_role;

DO $postflight$
DECLARE
  v_function pg_catalog.regprocedure;
  v_definition text;
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service_role oid := pg_catalog.to_regrole('service_role');
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.reserve_lifetime_membership_spot_atomic(uuid,text,integer)'::pg_catalog.regprocedure,
    'public.release_lifetime_membership_reservation_atomic(uuid,uuid,text,text,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.activate_lifetime_membership_with_identity_atomic(uuid,text,text,uuid,text,text,bigint,text,timestamp with time zone,text)'::pg_catalog.regprocedure,
    'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      JOIN pg_catalog.pg_language AS language_row
        ON language_row.oid = function_row.prolang
      WHERE function_row.oid = v_function
        AND function_row.proowner = v_postgres
        AND function_row.prorettype =
          'pg_catalog.jsonb'::pg_catalog.regtype
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.proparallel = 'u'
        AND language_row.lanname = 'plpgsql'
        AND function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
        AND pg_catalog.cardinality(function_row.proconfig) = 2
    ) OR NOT pg_catalog.has_function_privilege(
      'service_role',
      v_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon',
      v_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated',
      v_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticator',
      v_function,
      'EXECUTE'
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
        'Stripe lifetime corrective function contract drifted: %',
        v_function;
    END IF;
  END LOOP;

  v_function :=
    'public.stripe_entitlement_effect_is_current_v2(uuid)'::pg_catalog.regprocedure;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres
      AND function_row.prorettype =
        'pg_catalog.bool'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.proparallel = 'u'
      AND language_row.lanname = 'sql'
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
      AND pg_catalog.cardinality(function_row.proconfig) = 1
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
    RAISE EXCEPTION
      'Stripe lifetime effect currentness contract drifted';
  END IF;

  v_function :=
    'public.lease_stripe_entitlement_effects_atomic(integer,integer)'::pg_catalog.regprocedure;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres
      AND function_row.proretset
      AND function_row.prorettype =
        'public.stripe_entitlement_effects'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND language_row.lanname = 'plpgsql'
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.cardinality(function_row.proconfig) = 2
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_function,
    'EXECUTE'
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
      'Stripe lifetime effect lease contract drifted';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.activate_lifetime_membership_with_identity_atomic(uuid,text,text,uuid,text,text,bigint,text,timestamp with time zone,text)'::pg_catalog.regprocedure
  );
  IF pg_catalog.regexp_count(
      v_definition,
      '\mv_effective_user_id\M'
    ) IS DISTINCT FROM 0
    OR pg_catalog.regexp_count(
      v_definition,
      'v_payment.id,[[:space:]]+p_user_id,[[:space:]]+''payment'',[[:space:]]+v_payment.id::text,[[:space:]]+''review:duplicate_lifetime_purchase'''
    ) IS DISTINCT FROM 1
    OR v_definition NOT LIKE '%duplicate_lifetime_purchase%'
    OR v_definition NOT LIKE '%duplicate_refund_queued%'
    OR v_definition NOT LIKE '%stripe_subscription_cancel%'
    OR v_definition NOT LIKE
      '%public.stripe_subscription_has_exact_payment_binding_v2%'
    OR v_definition NOT LIKE
      '%public.stripe_subscription_has_exact_trial_binding_v2%'
    OR v_definition NOT LIKE '%lifetime_membership_activated%'
  THEN
    RAISE EXCEPTION
      'duplicate lifetime refund rollback correction drifted';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.release_lifetime_membership_reservation_atomic(uuid,uuid,text,text,text,text,timestamp with time zone)'::pg_catalog.regprocedure
  );
  IF v_definition NOT LIKE '%p_release_reason IS NULL%'
    OR v_definition LIKE
      '%p_event_created_at < v_reservation.checkout_expires_at%'
    OR pg_catalog.regexp_count(
      v_definition,
      'p_event_created_at[[:space:]]+< v_reservation.created_at[[:space:]]+- pg_catalog.make_interval\(mins => 5\)'
    ) IS DISTINCT FROM 1
  THEN
    RAISE EXCEPTION
      'bound lifetime early-expiration correction drifted';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.reserve_lifetime_membership_spot_atomic(uuid,text,integer)'::pg_catalog.regprocedure
  );
  IF pg_catalog.regexp_count(
      v_definition,
      '''request_nonce'',[[:space:]]+v_existing.request_nonce'
    ) IS DISTINCT FROM 2
  THEN
    RAISE EXCEPTION
      'lifetime reservation recovery response correction drifted';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.stripe_entitlement_effect_is_current_v2(uuid)'::pg_catalog.regprocedure
  );
  IF pg_catalog.regexp_count(
      v_definition,
      'effect.effect_type = ''stripe_subscription_cancel'''
    ) IS DISTINCT FROM 1
    OR v_definition NOT LIKE '%lifetime_membership_activated%'
    OR v_definition NOT LIKE
      '%public.stripe_subscription_has_exact_payment_binding_v2%'
    OR v_definition NOT LIKE
      '%effect.operation_key =%'
    OR v_definition NOT LIKE
      '%payment.stripe_customer_id =%'
    OR v_definition NOT LIKE
      '%payment.user_id IS NULL%'
    OR v_definition NOT LIKE
      '%effect.user_id IS NULL%'
  THEN
    RAISE EXCEPTION
      'lifetime subscription cancellation currentness correction drifted';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.lease_stripe_entitlement_effects_atomic(integer,integer)'::pg_catalog.regprocedure
  );
  IF pg_catalog.regexp_count(
      v_definition,
      '''payment_manual_review'',[[:space:]]+''stripe_subscription_cancel'''
    ) IS DISTINCT FROM 1
  THEN
    RAISE EXCEPTION
      'Stripe lifetime cancellation lease correction drifted';
  END IF;

  v_definition := pg_catalog.pg_get_functiondef(
    'public.finish_stripe_entitlement_effect_atomic(uuid,uuid,boolean,text,text,integer)'::pg_catalog.regprocedure
  );
  IF pg_catalog.regexp_count(
      v_definition,
      '''payment_manual_review'',[[:space:]]+''stripe_subscription_cancel'''
    ) IS DISTINCT FROM 1
  THEN
    RAISE EXCEPTION
      'Stripe lifetime cancellation finish correction drifted';
  END IF;
END
$postflight$;

COMMIT;
