-- A deleted Auth subject must not disappear while a one-time Checkout can
-- still complete or while its signed fulfillment is waiting to converge.
-- Stripe is scanned outside PostgreSQL; this migration durably records the
-- exact scan and refuses hard deletion unless the current complete-Session
-- inventory is terminal in an immutable financial ledger or manual review.

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass(
      'public.account_deletion_one_time_settlements'
    ) IS NOT NULL
    OR pg_catalog.to_regclass(
      'public.account_deletion_one_time_settlement_scans'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.sync_account_deletion_one_time_settlements(uuid,text,uuid,jsonb)'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.check_account_deletion_one_time_settlements_ready(uuid,uuid)'
    ) IS NOT NULL
  THEN
    RAISE EXCEPTION
      'account deletion one-time settlement barrier already exists';
  END IF;

  IF pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.stripe_entitlement_payments') IS NULL
    OR pg_catalog.to_regclass(
      'public.stripe_lifetime_seat_reservations'
    ) IS NULL
    OR pg_catalog.to_regclass('public.tips') IS NULL
    OR pg_catalog.to_regclass('public.stripe_payment_ownerships') IS NULL
    OR pg_catalog.to_regclass('public.group_payment_consumptions') IS NULL
    OR pg_catalog.to_regclass('public.stripe_manual_reviews') IS NULL
  THEN
    RAISE EXCEPTION
      'account deletion settlement barrier prerequisites are missing';
  END IF;
END
$preflight$;

CREATE TABLE public.account_deletion_one_time_settlements (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  -- Deliberately no FK: the financial settlement proof survives Auth/profile
  -- deletion and retains the immutable subject identifier for reconciliation.
  user_id uuid NOT NULL,
  livemode boolean NOT NULL,
  stripe_customer_id text NOT NULL,
  checkout_session_id text NOT NULL,
  product_kind text NOT NULL,
  ownership_status text NOT NULL,
  stripe_status text NOT NULL,
  payment_status text NOT NULL,
  settlement_status text NOT NULL,
  manual_review_id uuid
    REFERENCES public.stripe_manual_reviews(id) ON DELETE RESTRICT,
  first_observed_at timestamptz NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  last_observed_at timestamptz NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  settled_at timestamptz,
  last_scan_token uuid NOT NULL,
  CONSTRAINT account_deletion_one_time_customer_shape
    CHECK (
      pg_catalog.length(stripe_customer_id) BETWEEN 5 AND 255
      AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
    ),
  CONSTRAINT account_deletion_one_time_session_shape
    CHECK (
      pg_catalog.length(checkout_session_id) BETWEEN 4 AND 255
      AND checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'
    ),
  CONSTRAINT account_deletion_one_time_product_kind
    CHECK (product_kind IN ('lifetime', 'tip', 'group_pass', 'unknown')),
  CONSTRAINT account_deletion_one_time_ownership_status
    CHECK (ownership_status IN ('exact', 'mismatch')),
  CONSTRAINT account_deletion_one_time_stripe_status
    CHECK (stripe_status IN ('complete', 'expired')),
  CONSTRAINT account_deletion_one_time_payment_status
    CHECK (payment_status IN ('paid', 'unpaid', 'no_payment_required')),
  CONSTRAINT account_deletion_one_time_settlement_status
    CHECK (
      settlement_status IN (
        'pending_fulfillment',
        'terminal_expired',
        'fulfilled',
        'refunded',
        'terminal_manual_review'
      )
    ),
  CONSTRAINT account_deletion_one_time_terminal_shape
    CHECK (
      (
        settlement_status = 'pending_fulfillment'
        AND settled_at IS NULL
        AND manual_review_id IS NULL
      )
      OR (
        settlement_status IN ('terminal_expired', 'fulfilled', 'refunded')
        AND settled_at IS NOT NULL
        AND manual_review_id IS NULL
      )
      OR (
        settlement_status = 'terminal_manual_review'
        AND settled_at IS NOT NULL
        AND manual_review_id IS NOT NULL
      )
    ),
  CONSTRAINT account_deletion_one_time_provider_shape
    CHECK (
      (stripe_status = 'expired'
        AND settlement_status = 'terminal_expired')
      OR stripe_status = 'complete'
    ),
  CONSTRAINT account_deletion_one_time_session_key
    UNIQUE (livemode, checkout_session_id)
);

CREATE INDEX account_deletion_one_time_user_pending_idx
  ON public.account_deletion_one_time_settlements (
    user_id,
    settlement_status,
    checkout_session_id
  );

CREATE TABLE public.account_deletion_one_time_settlement_scans (
  user_id uuid PRIMARY KEY,
  stripe_customer_id text,
  scan_token uuid NOT NULL UNIQUE,
  observed_session_ids text[] NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT account_deletion_one_time_scan_customer_shape
    CHECK (
      stripe_customer_id IS NULL
      OR (
        pg_catalog.length(stripe_customer_id) BETWEEN 5 AND 255
        AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
      )
    ),
  CONSTRAINT account_deletion_one_time_scan_sessions_shape
    CHECK (
      pg_catalog.array_position(observed_session_ids, NULL) IS NULL
    )
);

ALTER TABLE public.account_deletion_one_time_settlements OWNER TO postgres;
ALTER TABLE public.account_deletion_one_time_settlement_scans OWNER TO postgres;
ALTER TABLE public.account_deletion_one_time_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_deletion_one_time_settlements FORCE ROW LEVEL SECURITY;
ALTER TABLE public.account_deletion_one_time_settlement_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_deletion_one_time_settlement_scans FORCE ROW LEVEL SECURITY;

CREATE POLICY account_deletion_one_time_settlements_service_select
  ON public.account_deletion_one_time_settlements
  FOR SELECT TO service_role
  USING (true);
CREATE POLICY account_deletion_one_time_settlement_scans_service_select
  ON public.account_deletion_one_time_settlement_scans
  FOR SELECT TO service_role
  USING (true);

REVOKE ALL ON TABLE
  public.account_deletion_one_time_settlements,
  public.account_deletion_one_time_settlement_scans
FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT SELECT ON TABLE
  public.account_deletion_one_time_settlements,
  public.account_deletion_one_time_settlement_scans
TO service_role;

CREATE OR REPLACE FUNCTION public.sync_account_deletion_one_time_settlements(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_scan_token uuid,
  p_observations jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_profile_customer_id text;
  v_observation jsonb;
  v_previous_session_id text;
  v_session_id text;
  v_livemode boolean;
  v_customer_id text;
  v_product_kind text;
  v_stripe_status text;
  v_payment_status text;
  v_ownership_status text;
  v_settlement_status text;
  v_review_reason_key text;
  v_review_reason text;
  v_review_id uuid;
  v_existing public.account_deletion_one_time_settlements%ROWTYPE;
  v_entitlement public.stripe_entitlement_payments%ROWTYPE;
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_tip_status text;
  v_group_outcome text;
  v_observed_session_ids text[] := ARRAY[]::text[];
  v_pending_session_ids text[] := ARRAY[]::text[];
  v_terminal_session_ids text[] := ARRAY[]::text[];
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_scan_token IS NULL
    OR p_observations IS NULL
    OR pg_catalog.jsonb_typeof(p_observations) IS DISTINCT FROM 'array'
  THEN
    RAISE EXCEPTION 'invalid settlement scan input'
      USING ERRCODE = '22023';
  END IF;
  IF p_stripe_customer_id IS NOT NULL
    AND (
      pg_catalog.length(p_stripe_customer_id) NOT BETWEEN 5 AND 255
      OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    )
  THEN
    RAISE EXCEPTION 'invalid settlement scan Customer'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account_deletion_one_time:' || p_user_id::text,
      0
    )
  );

  SELECT profile.stripe_customer_id
  INTO v_profile_customer_id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement scan subject not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_profile_customer_id IS DISTINCT FROM p_stripe_customer_id THEN
    RAISE EXCEPTION 'settlement scan Customer does not match locked profile'
      USING ERRCODE = '23514';
  END IF;

  FOR v_observation IN
    SELECT observation.value
    FROM pg_catalog.jsonb_array_elements(p_observations)
      WITH ORDINALITY AS observation(value, ordinal)
    ORDER BY observation.ordinal
  LOOP
    IF pg_catalog.jsonb_typeof(v_observation) IS DISTINCT FROM 'object'
      OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_object_keys(v_observation)
      ) <> 7
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_object_keys(v_observation) AS key_name
        WHERE key_name NOT IN (
          'checkout_session_id',
          'livemode',
          'stripe_customer_id',
          'product_kind',
          'stripe_status',
          'payment_status',
          'ownership_status'
        )
      )
      OR pg_catalog.jsonb_typeof(v_observation -> 'livemode')
        IS DISTINCT FROM 'boolean'
    THEN
      RAISE EXCEPTION 'invalid settlement observation shape'
        USING ERRCODE = '22023';
    END IF;

    v_session_id := v_observation ->> 'checkout_session_id';
    v_livemode := (v_observation ->> 'livemode')::boolean;
    v_customer_id := v_observation ->> 'stripe_customer_id';
    v_product_kind := v_observation ->> 'product_kind';
    v_stripe_status := v_observation ->> 'stripe_status';
    v_payment_status := v_observation ->> 'payment_status';
    v_ownership_status := v_observation ->> 'ownership_status';

    IF v_session_id IS NULL
      OR pg_catalog.length(v_session_id) NOT BETWEEN 4 AND 255
      OR v_session_id !~ '^cs_[A-Za-z0-9_]+$'
      OR v_previous_session_id IS NOT NULL
        AND v_session_id COLLATE "C" <= v_previous_session_id COLLATE "C"
      OR v_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_product_kind NOT IN (
        'lifetime',
        'tip',
        'group_pass',
        'unknown'
      )
      OR v_stripe_status NOT IN ('complete', 'expired')
      OR v_payment_status NOT IN ('paid', 'unpaid', 'no_payment_required')
      OR v_ownership_status NOT IN ('exact', 'mismatch')
    THEN
      RAISE EXCEPTION 'invalid or unsorted settlement observation'
        USING ERRCODE = '22023';
    END IF;
    v_previous_session_id := v_session_id;
    v_observed_session_ids :=
      pg_catalog.array_append(v_observed_session_ids, v_session_id);

    SELECT settlement.*
    INTO v_existing
    FROM public.account_deletion_one_time_settlements AS settlement
    WHERE settlement.livemode = v_livemode
      AND settlement.checkout_session_id = v_session_id
    FOR UPDATE;
    IF FOUND
      AND (
        v_existing.user_id IS DISTINCT FROM p_user_id
        OR v_existing.stripe_customer_id IS DISTINCT FROM v_customer_id
        OR v_existing.product_kind IS DISTINCT FROM v_product_kind
        OR v_existing.ownership_status IS DISTINCT FROM v_ownership_status
        OR v_existing.stripe_status IS DISTINCT FROM v_stripe_status
      )
    THEN
      RAISE EXCEPTION
        'settlement observation conflicts with durable Session identity'
        USING ERRCODE = '23505';
    END IF;

    v_settlement_status := 'pending_fulfillment';
    v_review_reason_key := NULL;
    v_review_reason := NULL;
    v_review_id := NULL;

    IF v_stripe_status = 'expired' THEN
      v_settlement_status := 'terminal_expired';
    ELSIF NOT v_livemode THEN
      v_settlement_status := 'terminal_manual_review';
      v_review_reason_key :=
        'account_deletion_one_time:testmode_complete';
      v_review_reason :=
        'A test-mode complete Checkout appeared on a production account deletion scan.';
    ELSIF v_product_kind = 'unknown'
      OR v_ownership_status = 'mismatch'
    THEN
      v_settlement_status := 'terminal_manual_review';
      v_review_reason_key :=
        'account_deletion_one_time:product_or_owner_mismatch';
      v_review_reason :=
        'A complete one-time Checkout had unsupported product or subject identity.';
    ELSIF v_payment_status = 'paid' THEN
      -- An existing durable review is a terminal, retained disposition. This
      -- covers webhook authority failures without inventing fulfillment.
      SELECT review.id
      INTO v_review_id
      FROM public.stripe_manual_reviews AS review
      WHERE review.object_id = v_session_id
        AND review.user_id = p_user_id
        AND review.state IN ('open', 'resolved')
      ORDER BY
        CASE WHEN review.state = 'open' THEN 0 ELSE 1 END,
        review.created_at,
        review.id
      LIMIT 1;

      IF v_product_kind = 'lifetime' THEN
        SELECT payment.*
        INTO v_entitlement
        FROM public.stripe_entitlement_payments AS payment
        WHERE payment.checkout_session_id = v_session_id;
        IF FOUND THEN
          IF v_entitlement.payment_kind IS DISTINCT FROM 'lifetime'
            OR v_entitlement.user_id IS DISTINCT FROM p_user_id
            OR v_entitlement.stripe_customer_id
              IS DISTINCT FROM v_customer_id
          THEN
            v_settlement_status := 'terminal_manual_review';
            v_review_reason_key :=
              'account_deletion_one_time:lifetime_ledger_conflict';
            v_review_reason :=
              'A lifetime Checkout conflicts with its durable entitlement ledger.';
          ELSIF v_entitlement.refund_succeeded_amount
            = v_entitlement.amount_paid
            AND v_entitlement.refund_state = 'succeeded'
          THEN
            v_settlement_status := 'refunded';
            v_review_id := NULL;
          ELSE
            v_settlement_status := 'fulfilled';
            v_review_id := NULL;
          END IF;
        ELSIF v_review_id IS NOT NULL THEN
          v_settlement_status := 'terminal_manual_review';
        END IF;
      ELSIF v_product_kind = 'tip' THEN
        SELECT ownership.*
        INTO v_ownership
        FROM public.stripe_payment_ownerships AS ownership
        WHERE ownership.checkout_session_id = v_session_id;
        IF FOUND THEN
          SELECT tip.status
          INTO v_tip_status
          FROM public.tips AS tip
          WHERE tip.id = v_ownership.ledger_id;
          IF v_ownership.product_kind IS DISTINCT FROM 'tip'
            OR v_ownership.owner_user_id IS DISTINCT FROM p_user_id
            OR v_ownership.stripe_customer_id
              IS DISTINCT FROM v_customer_id
            OR v_tip_status IS NULL
            OR v_tip_status NOT IN ('completed', 'refunded')
          THEN
            v_settlement_status := 'terminal_manual_review';
            v_review_reason_key :=
              'account_deletion_one_time:tip_ledger_conflict';
            v_review_reason :=
              'A Tip Checkout conflicts with its durable ownership ledger.';
          ELSIF v_tip_status = 'refunded' THEN
            v_settlement_status := 'refunded';
            v_review_id := NULL;
          ELSE
            v_settlement_status := 'fulfilled';
            v_review_id := NULL;
          END IF;
        ELSIF v_review_id IS NOT NULL THEN
          v_settlement_status := 'terminal_manual_review';
        END IF;
      ELSE
        SELECT ownership.*
        INTO v_ownership
        FROM public.stripe_payment_ownerships AS ownership
        WHERE ownership.checkout_session_id = v_session_id;
        IF FOUND THEN
          SELECT consumption.outcome
          INTO v_group_outcome
          FROM public.group_payment_consumptions AS consumption
          WHERE consumption.id = v_ownership.ledger_id
            AND consumption.checkout_session_id = v_session_id
            AND consumption.user_id = p_user_id;
          IF v_ownership.product_kind IS DISTINCT FROM 'group_pass'
            OR v_ownership.owner_user_id IS DISTINCT FROM p_user_id
            OR v_ownership.stripe_customer_id
              IS DISTINCT FROM v_customer_id
            OR v_group_outcome IS NULL
            OR v_group_outcome NOT IN (
              'activated',
              'renewed',
              'refund_blocked'
            )
          THEN
            v_settlement_status := 'terminal_manual_review';
            v_review_reason_key :=
              'account_deletion_one_time:group_ledger_conflict';
            v_review_reason :=
              'A group-pass Checkout conflicts with its durable ownership ledger.';
          ELSIF v_group_outcome = 'refund_blocked' THEN
            v_settlement_status := 'refunded';
            v_review_id := NULL;
          ELSE
            v_settlement_status := 'fulfilled';
            v_review_id := NULL;
          END IF;
        ELSIF v_review_id IS NOT NULL THEN
          v_settlement_status := 'terminal_manual_review';
        END IF;
      END IF;
    ELSIF v_payment_status = 'no_payment_required' THEN
      v_settlement_status := 'terminal_manual_review';
      v_review_reason_key :=
        'account_deletion_one_time:no_payment_required';
      v_review_reason :=
        'A complete one-time Checkout unexpectedly required no payment.';
    END IF;

    IF v_settlement_status = 'terminal_manual_review'
      AND v_review_id IS NULL
    THEN
      IF v_review_reason_key IS NULL OR v_review_reason IS NULL THEN
        v_review_reason_key :=
          'account_deletion_one_time:durable_ledger_conflict';
        v_review_reason :=
          'A complete one-time Checkout requires durable financial review.';
      END IF;
      INSERT INTO public.stripe_manual_reviews (
        object_type,
        object_id,
        user_id,
        action,
        reason_key,
        reason,
        metadata
      )
      VALUES (
        'account_deletion_checkout',
        v_session_id,
        p_user_id,
        'reconcile',
        v_review_reason_key,
        v_review_reason,
        pg_catalog.jsonb_build_object(
          'deletion_user_id', p_user_id,
          'livemode', v_livemode,
          'stripe_customer_id', v_customer_id,
          'checkout_session_id', v_session_id,
          'product_kind', v_product_kind,
          'ownership_status', v_ownership_status,
          'stripe_status', v_stripe_status,
          'payment_status', v_payment_status,
          'scan_token', p_scan_token
        )
      )
      ON CONFLICT (object_type, object_id, reason_key) DO NOTHING;

      SELECT review.id
      INTO v_review_id
      FROM public.stripe_manual_reviews AS review
      WHERE review.object_type = 'account_deletion_checkout'
        AND review.object_id = v_session_id
        AND review.reason_key = v_review_reason_key;
      IF v_review_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.stripe_manual_reviews AS review
          WHERE review.id = v_review_id
            AND review.user_id = p_user_id
        )
      THEN
        RAISE EXCEPTION 'failed to persist settlement manual review';
      END IF;
    END IF;

    INSERT INTO public.account_deletion_one_time_settlements (
      user_id,
      livemode,
      stripe_customer_id,
      checkout_session_id,
      product_kind,
      ownership_status,
      stripe_status,
      payment_status,
      settlement_status,
      manual_review_id,
      first_observed_at,
      last_observed_at,
      settled_at,
      last_scan_token
    )
    VALUES (
      p_user_id,
      v_livemode,
      v_customer_id,
      v_session_id,
      v_product_kind,
      v_ownership_status,
      v_stripe_status,
      v_payment_status,
      v_settlement_status,
      v_review_id,
      v_now,
      v_now,
      CASE
        WHEN v_settlement_status = 'pending_fulfillment' THEN NULL
        ELSE v_now
      END,
      p_scan_token
    )
    ON CONFLICT (livemode, checkout_session_id) DO UPDATE
    SET
      payment_status = EXCLUDED.payment_status,
      settlement_status = EXCLUDED.settlement_status,
      manual_review_id = EXCLUDED.manual_review_id,
      last_observed_at = EXCLUDED.last_observed_at,
      settled_at = CASE
        WHEN EXCLUDED.settlement_status = 'pending_fulfillment' THEN NULL
        ELSE COALESCE(
          public.account_deletion_one_time_settlements.settled_at,
          EXCLUDED.settled_at
        )
      END,
      last_scan_token = EXCLUDED.last_scan_token;

    IF v_settlement_status = 'pending_fulfillment' THEN
      v_pending_session_ids :=
        pg_catalog.array_append(v_pending_session_ids, v_session_id);
    ELSE
      v_terminal_session_ids :=
        pg_catalog.array_append(v_terminal_session_ids, v_session_id);
    END IF;
  END LOOP;

  INSERT INTO public.account_deletion_one_time_settlement_scans (
    user_id,
    stripe_customer_id,
    scan_token,
    observed_session_ids,
    completed_at
  )
  VALUES (
    p_user_id,
    p_stripe_customer_id,
    p_scan_token,
    v_observed_session_ids,
    v_now
  )
  ON CONFLICT (user_id) DO UPDATE
  SET
    stripe_customer_id = EXCLUDED.stripe_customer_id,
    scan_token = EXCLUDED.scan_token,
    observed_session_ids = EXCLUDED.observed_session_ids,
    completed_at = EXCLUDED.completed_at
  WHERE public.account_deletion_one_time_settlement_scans
    .stripe_customer_id IS NOT DISTINCT FROM EXCLUDED.stripe_customer_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement scan Customer identity changed'
      USING ERRCODE = '23514';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'synced',
    'user_id', p_user_id,
    'stripe_customer_id', p_stripe_customer_id,
    'scan_token', p_scan_token,
    'observed_session_ids', pg_catalog.to_jsonb(v_observed_session_ids),
    'pending_session_ids', pg_catalog.to_jsonb(v_pending_session_ids),
    'terminal_session_ids', pg_catalog.to_jsonb(v_terminal_session_ids)
  );
END
$function$;

ALTER FUNCTION public.sync_account_deletion_one_time_settlements(
  uuid,
  text,
  uuid,
  jsonb
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.check_account_deletion_one_time_settlements_ready(
  p_user_id uuid,
  p_scan_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_scan public.account_deletion_one_time_settlement_scans%ROWTYPE;
  v_profile_customer_id text;
  v_deleted_at timestamptz;
  v_deletion_scheduled_at timestamptz;
  v_pending_session_ids text[];
  v_pending_lifetime_reservations integer;
  v_pending_tips integer;
  v_ready boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL OR p_scan_token IS NULL THEN
    RAISE EXCEPTION 'invalid settlement readiness input'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account_deletion_one_time:' || p_user_id::text,
      0
    )
  );

  SELECT
    profile.stripe_customer_id,
    profile.deleted_at,
    profile.deletion_scheduled_at
  INTO
    v_profile_customer_id,
    v_deleted_at,
    v_deletion_scheduled_at
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'settlement readiness subject not found'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT scan.*
  INTO v_scan
  FROM public.account_deletion_one_time_settlement_scans AS scan
  WHERE scan.user_id = p_user_id
    AND scan.scan_token = p_scan_token
  FOR UPDATE;
  IF NOT FOUND
    OR v_scan.stripe_customer_id IS DISTINCT FROM v_profile_customer_id
  THEN
    RAISE EXCEPTION 'fresh exact settlement scan required'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(
      settlement.checkout_session_id
      ORDER BY settlement.checkout_session_id COLLATE "C"
    ),
    ARRAY[]::text[]
  )
  INTO v_pending_session_ids
  FROM public.account_deletion_one_time_settlements AS settlement
  WHERE settlement.user_id = p_user_id
    AND (
      settlement.settlement_status = 'pending_fulfillment'
      OR (
        settlement.stripe_status = 'complete'
        AND settlement.last_scan_token IS DISTINCT FROM p_scan_token
      )
    );

  SELECT pg_catalog.count(*)::integer
  INTO v_pending_lifetime_reservations
  FROM public.stripe_lifetime_seat_reservations AS reservation
  WHERE reservation.user_id = p_user_id
    AND reservation.status IN ('reserved', 'bound');

  SELECT pg_catalog.count(*)::integer
  INTO v_pending_tips
  FROM public.tips AS tip
  WHERE tip.status = 'pending'
    AND (
      tip.from_user_id = p_user_id
      OR tip.checkout_to_user_id = p_user_id
      OR (
        tip.checkout_to_user_id IS NULL
        AND tip.to_user_id = p_user_id
      )
    );

  v_ready :=
    v_deleted_at IS NOT NULL
    AND v_deletion_scheduled_at IS NOT NULL
    AND v_deletion_scheduled_at <= pg_catalog.clock_timestamp()
    AND pg_catalog.cardinality(v_pending_session_ids) = 0
    AND v_pending_lifetime_reservations = 0
    AND v_pending_tips = 0;

  RETURN pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_ready THEN 'ready' ELSE 'pending' END,
    'user_id', p_user_id,
    'scan_token', p_scan_token,
    'ready', v_ready,
    'pending_session_ids', pg_catalog.to_jsonb(v_pending_session_ids),
    'pending_lifetime_reservations', v_pending_lifetime_reservations,
    'pending_tips', v_pending_tips
  );
END
$function$;

ALTER FUNCTION public.check_account_deletion_one_time_settlements_ready(uuid, uuid)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION
  public.sync_account_deletion_one_time_settlements(
    uuid,
    text,
    uuid,
    jsonb
  )
FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION
  public.check_account_deletion_one_time_settlements_ready(uuid, uuid)
FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION
  public.sync_account_deletion_one_time_settlements(
    uuid,
    text,
    uuid,
    jsonb
  )
TO service_role;
GRANT EXECUTE ON FUNCTION
  public.check_account_deletion_one_time_settlements_ready(uuid, uuid)
TO service_role;

COMMENT ON TABLE public.account_deletion_one_time_settlements IS
  'Durable exact Checkout settlement barrier retained after account deletion.';
COMMENT ON TABLE public.account_deletion_one_time_settlement_scans IS
  'Latest complete Stripe open/complete pagination checkpoint per deletion subject.';
COMMENT ON FUNCTION public.sync_account_deletion_one_time_settlements(
  uuid,
  text,
  uuid,
  jsonb
) IS
  'Persists one exact full Stripe Checkout scan and re-evaluates durable fulfillment.';
COMMENT ON FUNCTION public.check_account_deletion_one_time_settlements_ready(
  uuid,
  uuid
) IS
  'Fail-closed hard-delete gate requiring a fresh scan and terminal one-time settlement.';
