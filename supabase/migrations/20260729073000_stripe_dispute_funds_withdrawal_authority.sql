-- Stripe creates warning/inquiry disputes without withdrawing funds. Only an
-- active funds-withdrawn status may become financial reversal authority.
-- Preserve one canonical withdrawal per dispute while accepting the distinct
-- created/funds_withdrawn event ids in either delivery order.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_required_relation text;
  v_required_function text;
BEGIN
  FOREACH v_required_relation IN ARRAY ARRAY[
    'public.stripe_charge_dispute_events',
    'public.stripe_charge_dispute_projections',
    'public.stripe_charge_dispute_reinstatement_events',
    'public.stripe_charge_dispute_reinstatement_projections',
    'public.stripe_payment_ownerships',
    'public.stripe_manual_reviews'
  ]
  LOOP
    IF pg_catalog.to_regclass(v_required_relation) IS NULL THEN
      RAISE EXCEPTION
        'Stripe dispute funds-withdrawal prerequisite is missing: %',
        v_required_relation;
    END IF;
  END LOOP;

  FOREACH v_required_function IN ARRAY ARRAY[
    'public.record_api_tier_dispute_reversal_atomic(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)',
    'public.record_stripe_manual_review_atomic(text,text,uuid,text,text,jsonb)',
    'public.stripe_charge_dispute_identity_state_v2(boolean,text,text,text,bigint,text)',
    'public.stripe_payment_ownership_has_exact_dispute_v2(uuid,boolean,text)',
    'public.stripe_payment_ownership_has_active_dispute_v3(uuid)',
    'public.stripe_dispute_reinstatement_matches_payment_v2(uuid,boolean,text)',
    'public.stripe_dispute_reinstatement_is_exact_v2(uuid,boolean,text)',
    'public.project_stripe_charge_dispute_reinstatement_atomic(uuid,boolean,text)',
    'public.project_dispute_after_payment_ownership_insert()',
    'public.stripe_paid_launch_readiness_v2()'
  ]
  LOOP
    IF pg_catalog.to_regprocedure(v_required_function) IS NULL THEN
      RAISE EXCEPTION
        'Stripe dispute funds-withdrawal function is missing: %',
        v_required_function;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure(
      'public.record_api_tier_dispute_reversal_pre_withdrawal_v3(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.stripe_paid_launch_readiness_pre_withdrawal_v3()'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.stripe_payment_ownership_has_other_active_dispute_v3(uuid,text)'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.project_dispute_reinstatement_pre_other_active_v3(uuid,boolean,text)'
    ) IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid =
          'public.stripe_charge_dispute_events'::pg_catalog.regclass
        AND constraint_row.conname =
          'stripe_charge_dispute_events_withdrawn_status_check'
    )
  THEN
    RAISE EXCEPTION
      'Stripe dispute funds-withdrawal authority already exists; audit before replay';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
  THEN
    RAISE EXCEPTION
      'Stripe dispute funds-withdrawal authority roles are missing';
  END IF;
END
$preflight$;

-- Close the old writer while checking that no live warning/inquiry was already
-- projected as a chargeback. Such rows require Stripe-backed operator repair;
-- silently guessing whether access or a remote subscription should be restored
-- would create a second financial error.
LOCK TABLE public.stripe_charge_dispute_events
  IN SHARE ROW EXCLUSIVE MODE;

DO $live_history_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.stripe_charge_dispute_events AS dispute
    WHERE dispute.livemode IS TRUE
      AND dispute.dispute_status NOT IN (
        'needs_response',
        'under_review',
        'lost'
      )
  ) THEN
    RAISE EXCEPTION
      'live Stripe warning/inquiry dispute history requires manual repair before funds-withdrawal authority can be installed'
      USING ERRCODE = '23514';
  END IF;
END
$live_history_preflight$;

-- Existing test-mode history remains immutable, but all future inserts,
-- including calls through renamed legacy functions, must be actual withdrawal
-- authority. NOT VALID intentionally avoids rewriting historical audit rows.
ALTER TABLE public.stripe_charge_dispute_events
  ADD CONSTRAINT stripe_charge_dispute_events_withdrawn_status_check
  CHECK (
    dispute_status IN (
      'needs_response',
      'under_review',
      'lost'
    )
  ) NOT VALID;

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
    WHERE dispute.dispute_status IN (
        'needs_response',
        'under_review',
        'lost'
      )
      AND (
        dispute.stripe_charge_id = p_stripe_charge_id
        OR (
          p_stripe_payment_intent_id IS NOT NULL
          AND dispute.stripe_payment_intent_id =
            p_stripe_payment_intent_id
        )
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
        AND dispute.dispute_status IN (
          'needs_response',
          'under_review',
          'lost'
        )
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
  public.stripe_payment_ownership_has_other_active_dispute_v3(
    p_ownership_id uuid,
    p_excluded_dispute_id text
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
      JOIN public.stripe_charge_dispute_events AS dispute
        ON dispute.livemode = projection.livemode
       AND dispute.stripe_event_id = projection.stripe_event_id
      WHERE projection.ownership_id = p_ownership_id
        AND (
          p_excluded_dispute_id IS NULL
          OR dispute.stripe_dispute_id <>
            p_excluded_dispute_id
        )
        AND dispute.dispute_status IN (
          'needs_response',
          'under_review',
          'lost'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.stripe_charge_dispute_reinstatement_events
            AS reinstatement
          JOIN public.stripe_charge_dispute_reinstatement_projections
            AS reinstatement_projection
            ON reinstatement_projection.livemode =
                reinstatement.livemode
           AND reinstatement_projection.stripe_event_id =
                reinstatement.stripe_event_id
           AND reinstatement_projection.ownership_id =
                p_ownership_id
          WHERE reinstatement.stripe_dispute_id =
              dispute.stripe_dispute_id
            AND COALESCE(
              reinstatement_projection.result ->> 'status',
              ''
            ) IN (
              'restored',
              'refund_preserved'
            )
        )
    )
$function$;

ALTER FUNCTION
  public.stripe_payment_ownership_has_other_active_dispute_v3(
    uuid, text
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.stripe_payment_ownership_has_other_active_dispute_v3(
    uuid, text
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- A reinstatement neutralizes only its exact dispute. Another active dispute
-- against the same payment remains financial reversal authority.
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
    AND public.stripe_payment_ownership_has_other_active_dispute_v3(
      p_ownership_id,
      NULL
    )
$function$;

ALTER FUNCTION
  public.stripe_payment_ownership_has_active_dispute_v3(uuid)
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.stripe_payment_ownership_has_active_dispute_v3(uuid)
FROM PUBLIC, anon, authenticated, service_role, authenticator;

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
        AND dispute.dispute_status IN (
          'needs_response',
          'under_review',
          'lost'
        )
        AND public.stripe_payment_ownership_is_exact_v2(
          ownership.id
        )
    )
$function$;

ALTER FUNCTION
  public.stripe_dispute_reinstatement_matches_payment_v2(
    uuid, boolean, text
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.stripe_dispute_reinstatement_matches_payment_v2(
    uuid, boolean, text
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- If one of several disputes is won, record that exact funds restoration but
-- keep access revoked until every other dispute against the payment is also
-- terminally reinstated. The final reinstatement delegates to the original
-- projector and restores the benefit exactly once.
ALTER FUNCTION
  public.project_stripe_charge_dispute_reinstatement_atomic(
    uuid, boolean, text
  )
RENAME TO project_dispute_reinstatement_pre_other_active_v3;
REVOKE ALL ON FUNCTION
  public.project_dispute_reinstatement_pre_other_active_v3(
    uuid, boolean, text
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

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
BEGIN
  IF p_ownership_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_event_id IS NULL
  THEN
    RAISE EXCEPTION
      'Stripe dispute reinstatement projection input is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_charge_dispute_reinstatement_projections
      AS projection
    WHERE projection.livemode = p_livemode
      AND projection.stripe_event_id = p_stripe_event_id
  ) THEN
    RETURN
      public.project_dispute_reinstatement_pre_other_active_v3(
        p_ownership_id,
        p_livemode,
        p_stripe_event_id
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

  IF public.stripe_payment_ownership_has_other_active_dispute_v3(
      v_ownership.id,
      v_event.stripe_dispute_id
    )
  THEN
    v_result := pg_catalog.jsonb_build_object(
      'status', 'refund_preserved',
      'access_restored', false,
      'reason', 'other_dispute_active'
    );
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
  END IF;

  RETURN public.project_dispute_reinstatement_pre_other_active_v3(
    p_ownership_id,
    p_livemode,
    p_stripe_event_id
  );
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

ALTER FUNCTION public.record_api_tier_dispute_reversal_atomic(
  boolean, text, bigint, text, text, text, bigint, text, text, text,
  text, bigint
)
RENAME TO record_api_tier_dispute_reversal_pre_withdrawal_v3;
REVOKE ALL ON FUNCTION
  public.record_api_tier_dispute_reversal_pre_withdrawal_v3(
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
  v_existing public.stripe_charge_dispute_events%ROWTYPE;
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
    OR p_dispute_status NOT IN (
      'needs_response',
      'under_review',
      'lost'
    )
    OR p_dispute_reason IS NULL
    OR pg_catalog.length(p_dispute_reason) NOT BETWEEN 1 AND 100
    OR p_dispute_amount IS NULL
    OR p_dispute_amount <= 0
    OR p_currency IS NULL
    OR p_currency !~ '^[a-z]{3}$'
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND (
        p_stripe_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_stripe_payment_intent_id) > 255
      )
    )
    OR p_stripe_charge_id IS NULL
    OR p_stripe_charge_id !~ '^ch_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_charge_id) > 255
    OR p_captured_amount IS NULL
    OR p_captured_amount <= 0
    OR p_dispute_amount > p_captured_amount
  THEN
    RAISE EXCEPTION
      'Stripe dispute does not prove withdrawn funds'
      USING ERRCODE = '22023';
  END IF;

  -- Match the existing financial identity lock order before examining either
  -- unique key. Concurrent created/funds_withdrawn deliveries for one Charge
  -- therefore converge on one canonical immutable event.
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

  SELECT dispute.*
  INTO v_existing
  FROM public.stripe_charge_dispute_events AS dispute
  WHERE dispute.livemode = p_livemode
    AND dispute.stripe_dispute_id = p_stripe_dispute_id;

  IF FOUND THEN
    IF v_existing.dispute_status IN (
        'needs_response',
        'under_review',
        'lost'
      )
      AND v_existing.dispute_reason = p_dispute_reason
      AND v_existing.dispute_amount = p_dispute_amount
      AND v_existing.currency = p_currency
      AND v_existing.stripe_customer_id =
        p_stripe_customer_id
      AND v_existing.stripe_payment_intent_id
        IS NOT DISTINCT FROM p_stripe_payment_intent_id
      AND v_existing.stripe_charge_id = p_stripe_charge_id
      AND v_existing.captured_amount = p_captured_amount
      AND NOT EXISTS (
        SELECT 1
        FROM public.stripe_charge_dispute_events AS event_collision
        WHERE event_collision.livemode = p_livemode
          AND event_collision.stripe_event_id =
            p_stripe_event_id
          AND event_collision.stripe_dispute_id <>
            p_stripe_dispute_id
      )
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'already_withdrawn'
      );
    END IF;

    PERFORM public.record_stripe_manual_review_atomic(
      'dispute',
      p_stripe_dispute_id,
      NULL,
      'stripe_dispute_withdrawal_identity_conflict',
      'A repeated Stripe funds-withdrawn event conflicts with its canonical immutable dispute identity.',
      pg_catalog.jsonb_build_object(
        'event_id', p_stripe_event_id,
        'canonical_event_id', v_existing.stripe_event_id,
        'charge_id', p_stripe_charge_id,
        'canonical_charge_id', v_existing.stripe_charge_id,
        'dispute_status', p_dispute_status,
        'canonical_dispute_status', v_existing.dispute_status,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict'
    );
  END IF;

  RETURN public.record_api_tier_dispute_reversal_pre_withdrawal_v3(
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
        AND dispute.dispute_status IN (
          'needs_response',
          'under_review',
          'lost'
        )
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
      reinstatement.stripe_event_id,
      reinstatement.stripe_dispute_id
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
        AND dispute.stripe_dispute_id =
          v_dispute.stripe_dispute_id
        AND dispute.stripe_charge_id =
          NEW.stripe_charge_id
        AND dispute.dispute_status IN (
          'needs_response',
          'under_review',
          'lost'
        )
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
  RENAME TO stripe_paid_launch_readiness_pre_withdrawal_v3;
REVOKE ALL ON FUNCTION
  public.stripe_paid_launch_readiness_pre_withdrawal_v3()
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
  v_nonwithdrawn_live_events integer;
  v_status_guard_anomalies integer;
  v_identity_anomalies integer;
  v_authority_drift integer;
  v_ready boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  v_base :=
    public.stripe_paid_launch_readiness_pre_withdrawal_v3();

  SELECT pg_catalog.count(*)::integer
  INTO v_nonwithdrawn_live_events
  FROM public.stripe_charge_dispute_events AS dispute
  WHERE dispute.livemode IS TRUE
    AND dispute.dispute_status NOT IN (
      'needs_response',
      'under_review',
      'lost'
    );

  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid =
          'public.stripe_charge_dispute_events'::pg_catalog.regclass
        AND constraint_row.conname =
          'stripe_charge_dispute_events_withdrawn_status_check'
        AND constraint_row.contype = 'c'
        AND pg_catalog.pg_get_constraintdef(
          constraint_row.oid
        ) LIKE '%needs_response%'
        AND pg_catalog.pg_get_constraintdef(
          constraint_row.oid
        ) LIKE '%under_review%'
        AND pg_catalog.pg_get_constraintdef(
          constraint_row.oid
        ) LIKE '%lost%'
    )
    THEN 0
    ELSE 1
  END
  INTO v_status_guard_anomalies;

  v_identity_anomalies :=
    COALESCE(
      (v_base ->> 'charge_dispute_identity_anomalies')::integer,
      -1
    )
      + v_nonwithdrawn_live_events
      + v_status_guard_anomalies;
  v_authority_drift :=
    COALESCE((v_base ->> 'authority_drift')::integer, -1)
      + v_nonwithdrawn_live_events
      + v_status_guard_anomalies;
  v_ready :=
    COALESCE(v_base ->> 'status', '') = 'ready'
    AND v_nonwithdrawn_live_events = 0
    AND v_status_guard_anomalies = 0;

  RETURN v_base || pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_ready THEN 'ready' ELSE 'blocked' END,
    'authority_drift', v_authority_drift,
    'charge_dispute_identity_anomalies',
      v_identity_anomalies
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
  v_function pg_catalog.regprocedure;
  v_definition text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.stripe_charge_dispute_events'::pg_catalog.regclass
      AND constraint_row.conname =
        'stripe_charge_dispute_events_withdrawn_status_check'
      AND constraint_row.contype = 'c'
  ) THEN
    RAISE EXCEPTION
      'Stripe dispute funds-withdrawn status guard did not converge';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.stripe_charge_dispute_identity_state_v2(boolean,text,text,text,bigint,text)'::pg_catalog.regprocedure,
    'public.stripe_payment_ownership_has_exact_dispute_v2(uuid,boolean,text)'::pg_catalog.regprocedure,
    'public.stripe_payment_ownership_has_other_active_dispute_v3(uuid,text)'::pg_catalog.regprocedure,
    'public.stripe_dispute_reinstatement_matches_payment_v2(uuid,boolean,text)'::pg_catalog.regprocedure,
    'public.record_api_tier_dispute_reversal_atomic(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)'::pg_catalog.regprocedure,
    'public.project_dispute_after_payment_ownership_insert()'::pg_catalog.regprocedure,
    'public.stripe_paid_launch_readiness_v2()'::pg_catalog.regprocedure
  ]
  LOOP
    IF (
      SELECT function_owner.rolname
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_roles AS function_owner
        ON function_owner.oid = routine.proowner
      WHERE routine.oid = v_function
    ) IS DISTINCT FROM 'postgres'
      OR (
        SELECT routine.prosecdef
        FROM pg_catalog.pg_proc AS routine
        WHERE routine.oid = v_function
      ) IS NOT TRUE
    THEN
      RAISE EXCEPTION
        'Stripe dispute funds-withdrawal routine owner/security drifted: %',
        v_function;
    END IF;

    SELECT pg_catalog.pg_get_functiondef(v_function)
    INTO v_definition;
    IF v_definition NOT LIKE '%needs_response%'
      OR v_definition NOT LIKE '%under_review%'
      OR v_definition NOT LIKE '%lost%'
    THEN
      RAISE EXCEPTION
        'Stripe dispute funds-withdrawal status contract drifted: %',
        v_function;
    END IF;
  END LOOP;

  SELECT pg_catalog.pg_get_functiondef(
    'public.record_api_tier_dispute_reversal_atomic(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)'::pg_catalog.regprocedure
  )
  INTO v_definition;
  IF v_definition NOT LIKE '%already_withdrawn%'
    OR v_definition NOT LIKE
      '%record_api_tier_dispute_reversal_pre_withdrawal_v3%'
  THEN
    RAISE EXCEPTION
      'Stripe dispute replay acknowledgement did not converge';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.stripe_payment_ownership_has_active_dispute_v3(uuid)'::pg_catalog.regprocedure,
    'public.project_stripe_charge_dispute_reinstatement_atomic(uuid,boolean,text)'::pg_catalog.regprocedure
  ]
  LOOP
    IF (
      SELECT function_owner.rolname
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_roles AS function_owner
        ON function_owner.oid = routine.proowner
      WHERE routine.oid = v_function
    ) IS DISTINCT FROM 'postgres'
      OR (
        SELECT routine.prosecdef
        FROM pg_catalog.pg_proc AS routine
        WHERE routine.oid = v_function
      ) IS NOT TRUE
    THEN
      RAISE EXCEPTION
        'Stripe dispute reinstatement fence owner/security drifted: %',
        v_function;
    END IF;
  END LOOP;

  SELECT pg_catalog.pg_get_functiondef(
    'public.stripe_payment_ownership_has_active_dispute_v3(uuid)'::pg_catalog.regprocedure
  )
  INTO v_definition;
  IF v_definition NOT LIKE
      '%stripe_payment_ownership_has_other_active_dispute_v3%'
  THEN
    RAISE EXCEPTION
      'Stripe active-dispute predicate did not converge';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.project_stripe_charge_dispute_reinstatement_atomic(uuid,boolean,text)'::pg_catalog.regprocedure
  )
  INTO v_definition;
  IF v_definition NOT LIKE
      '%stripe_payment_ownership_has_other_active_dispute_v3%'
    OR v_definition NOT LIKE '%other_dispute_active%'
    OR v_definition NOT LIKE '%refund_preserved%'
  THEN
    RAISE EXCEPTION
      'Stripe multi-dispute reinstatement fence did not converge';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
      'service_role',
      'public.record_api_tier_dispute_reversal_atomic(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'service_role',
      'public.stripe_paid_launch_readiness_v2()',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.record_api_tier_dispute_reversal_pre_withdrawal_v3(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.stripe_paid_launch_readiness_pre_withdrawal_v3()',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.project_dispute_reinstatement_pre_other_active_v3(uuid,boolean,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.stripe_payment_ownership_has_other_active_dispute_v3(uuid,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      'public.record_api_tier_dispute_reversal_atomic(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION
      'Stripe dispute funds-withdrawal authority ACL drifted';
  END IF;
END
$postflight$;

COMMENT ON FUNCTION public.record_api_tier_dispute_reversal_atomic(
  boolean, text, bigint, text, text, text, bigint, text, text, text,
  text, bigint
) IS
  'Records one exact active Stripe funds withdrawal; equivalent created/funds_withdrawn event ids acknowledge idempotently.';

COMMENT ON CONSTRAINT
  stripe_charge_dispute_events_withdrawn_status_check
ON public.stripe_charge_dispute_events IS
  'Future dispute reversal audit rows must prove that Stripe funds are withdrawn.';

COMMIT;
