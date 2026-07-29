-- payment_history is a compatibility/audit projection, but the historical
-- successful-Invoice writer used ON CONFLICT (stripe_invoice_id) DO UPDATE.
-- That made a repeated webhook capable of silently replacing financial
-- identity.  Bind successful rows to the canonical recurring-payment ledger,
-- permit only the legitimate failed -> succeeded transition, and make the
-- audit table append-only outside that authority.

BEGIN;

SET LOCAL lock_timeout = '5s';

DO $preflight$
DECLARE
  v_conflicting_rows bigint;
BEGIN
  IF pg_catalog.to_regclass('public.payment_history') IS NULL
    OR pg_catalog.to_regclass('public.stripe_entitlement_payments') IS NULL
    OR pg_catalog.to_regclass('public.stripe_manual_reviews') IS NULL
    OR pg_catalog.to_regclass('auth.users') IS NULL
  THEN
    RAISE EXCEPTION
      'recurring payment-history authority prerequisites are missing';
  END IF;

  IF pg_catalog.to_regprocedure(
      'public.record_stripe_manual_review_atomic(text,text,uuid,text,text,jsonb)'
    ) IS NULL
  THEN
    RAISE EXCEPTION
      'recurring payment-history manual-review authority is missing';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
  THEN
    RAISE EXCEPTION 'recurring payment-history authority roles are missing';
  END IF;

  -- A failed row with the same immutable identity is a legitimate lifecycle
  -- predecessor. Everything else already contradicts the canonical payment
  -- and must be repaired explicitly rather than normalized by deployment.
  SELECT pg_catalog.count(*)
  INTO v_conflicting_rows
  FROM public.payment_history AS history
  JOIN public.stripe_entitlement_payments AS payment
    ON payment.stripe_invoice_id = history.stripe_invoice_id
   AND payment.payment_kind = 'recurring'
   AND payment.payment_status IN ('paid', 'succeeded')
  WHERE (
      history.user_id IS DISTINCT FROM payment.user_id
      AND NOT (
        history.user_id IS NULL
        AND payment.user_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM auth.users AS subject
          WHERE subject.id = payment.user_id
        )
      )
    )
    OR history.amount::bigint IS DISTINCT FROM payment.amount_paid
    OR history.currency IS DISTINCT FROM payment.currency
    OR history.status NOT IN ('failed', 'succeeded')
    OR (
      history.status = 'succeeded'
      AND history.stripe_payment_intent_id
        IS DISTINCT FROM payment.stripe_payment_intent_id
    )
    OR (
      history.status = 'failed'
      AND history.stripe_payment_intent_id IS NOT NULL
      AND history.stripe_payment_intent_id
        IS DISTINCT FROM payment.stripe_payment_intent_id
    );

  IF v_conflicting_rows <> 0 THEN
    RAISE EXCEPTION
      '% recurring payment-history row(s) conflict with canonical payment identity; manual repair is required',
      v_conflicting_rows;
  END IF;
END
$preflight$;

ALTER TABLE public.payment_history
  ADD CONSTRAINT payment_history_recurring_invoice_shape_guard
  CHECK (
    stripe_invoice_id IS NULL
    OR (
      stripe_invoice_id ~ '^in_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_invoice_id) <= 255
      AND amount IS NOT NULL
      AND amount BETWEEN 1 AND 2147483647
      AND currency IS NOT NULL
      AND currency ~ '^[a-z]{3}$'
      AND status IN ('failed', 'succeeded')
      AND (
        stripe_payment_intent_id IS NULL
        OR (
          stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
          AND pg_catalog.length(stripe_payment_intent_id) <= 255
        )
      )
    )
  )
  NOT VALID;

CREATE OR REPLACE FUNCTION
  public.guard_recurring_payment_history_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_authority_path text := pg_catalog.current_setting(
    'arena.recurring_payment_history_success_authority',
    true
  );
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
    OR TG_TABLE_NAME IS DISTINCT FROM 'payment_history'
  THEN
    RAISE EXCEPTION
      'recurring payment-history audit guard is misattached'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'payment history audit cannot be truncated'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment history audit rows are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.stripe_invoice_id IS NULL THEN
      RETURN NEW;
    END IF;

    IF NEW.status = 'succeeded'
      AND v_authority_path IS DISTINCT FROM 'recurring-success'
    THEN
      RAISE EXCEPTION
        'successful recurring payment history requires canonical authority'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.status = 'failed'
      AND EXISTS (
        SELECT 1
        FROM public.stripe_entitlement_payments AS payment
        WHERE payment.stripe_invoice_id = NEW.stripe_invoice_id
          AND payment.payment_kind = 'recurring'
          AND payment.payment_status IN ('paid', 'succeeded')
      )
    THEN
      RAISE EXCEPTION
        'failed payment history contradicts a canonical successful payment'
        USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
  END IF;

  -- auth.users owns this FK's ON DELETE SET NULL action. Permit only that
  -- nested referential action, after the parent is no longer visible, while
  -- comparing every other audit field in full.
  IF OLD.user_id IS NOT NULL
    AND NEW.user_id IS NULL
    AND pg_catalog.pg_trigger_depth() > 1
    AND NOT EXISTS (
      SELECT 1
      FROM auth.users AS subject
      WHERE subject.id = OLD.user_id
    )
    AND (
      pg_catalog.to_jsonb(NEW) - 'user_id'
    ) IS NOT DISTINCT FROM (
      pg_catalog.to_jsonb(OLD) - 'user_id'
    )
  THEN
    RETURN NEW;
  END IF;

  IF v_authority_path IS DISTINCT FROM 'recurring-success'
    OR OLD.stripe_invoice_id IS NULL
    OR NEW.stripe_invoice_id IS NULL
    OR OLD.status IS DISTINCT FROM 'failed'
    OR NEW.status IS DISTINCT FROM 'succeeded'
    OR NEW.id IS DISTINCT FROM OLD.id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.stripe_invoice_id IS DISTINCT FROM OLD.stripe_invoice_id
    OR NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR (
      OLD.stripe_payment_intent_id IS NOT NULL
      AND NEW.stripe_payment_intent_id
        IS DISTINCT FROM OLD.stripe_payment_intent_id
    )
  THEN
    RAISE EXCEPTION 'payment history audit rows are immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.guard_recurring_payment_history_audit()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_recurring_payment_history_audit()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TRIGGER trg_payment_history_recurring_audit_row
  BEFORE INSERT OR UPDATE OR DELETE ON public.payment_history
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_recurring_payment_history_audit();

CREATE TRIGGER trg_payment_history_recurring_audit_truncate
  BEFORE TRUNCATE ON public.payment_history
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.guard_recurring_payment_history_audit();

CREATE OR REPLACE FUNCTION
  public.record_recurring_payment_history_success_atomic(
    p_user_id uuid,
    p_livemode boolean,
    p_stripe_event_id text,
    p_stripe_event_created bigint,
    p_stripe_invoice_id text,
    p_stripe_payment_intent_id text,
    p_amount_paid bigint,
    p_currency text
  )
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_history public.payment_history%ROWTYPE;
  v_pi_history public.payment_history%ROWTYPE;
  v_conflict_kind text;
  v_updated_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_event_id IS NULL
    OR p_stripe_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_event_id) > 255
    OR p_stripe_event_created IS NULL
    OR p_stripe_event_created NOT BETWEEN 1 AND 253402300799
    OR p_stripe_invoice_id IS NULL
    OR p_stripe_invoice_id !~ '^in_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_invoice_id) > 255
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND (
        p_stripe_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_stripe_payment_intent_id) > 255
      )
    )
    OR p_amount_paid IS NULL
    OR p_amount_paid NOT BETWEEN 1 AND 2147483647
    OR p_currency IS NULL
    OR p_currency !~ '^[a-z]{3}$'
  THEN
    RAISE EXCEPTION
      'recurring payment-history success identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'recurring-payment-history-invoice:' || p_stripe_invoice_id,
      0
    )
  );
  IF p_stripe_payment_intent_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'recurring-payment-history-pi:' || p_stripe_payment_intent_id,
        0
      )
    );
  END IF;

  SELECT payment.*
  INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.stripe_invoice_id = p_stripe_invoice_id
  FOR SHARE;

  IF NOT FOUND THEN
    v_conflict_kind := 'canonical_payment_missing';
  ELSIF v_payment.user_id IS DISTINCT FROM p_user_id
    OR v_payment.livemode IS DISTINCT FROM p_livemode
    OR v_payment.payment_kind IS DISTINCT FROM 'recurring'
    OR v_payment.payment_status NOT IN ('paid', 'succeeded')
    OR v_payment.stripe_invoice_id IS DISTINCT FROM p_stripe_invoice_id
    OR v_payment.stripe_payment_intent_id
      IS DISTINCT FROM p_stripe_payment_intent_id
    OR v_payment.amount_paid IS DISTINCT FROM p_amount_paid
    OR v_payment.currency IS DISTINCT FROM p_currency
  THEN
    v_conflict_kind := 'canonical_payment_identity_mismatch';
  END IF;

  IF v_conflict_kind IS NULL THEN
    SELECT history.*
    INTO v_history
    FROM public.payment_history AS history
    WHERE history.stripe_invoice_id = p_stripe_invoice_id
    FOR UPDATE;

    IF p_stripe_payment_intent_id IS NOT NULL THEN
      SELECT history.*
      INTO v_pi_history
      FROM public.payment_history AS history
      WHERE history.stripe_payment_intent_id =
        p_stripe_payment_intent_id
      FOR UPDATE;

      IF FOUND
        AND (
          v_history.id IS NULL
          OR v_pi_history.id IS DISTINCT FROM v_history.id
        )
      THEN
        v_conflict_kind := 'payment_intent_history_collision';
      END IF;
    END IF;
  END IF;

  IF v_conflict_kind IS NULL AND v_history.id IS NOT NULL THEN
    IF v_history.user_id IS DISTINCT FROM p_user_id
      OR v_history.stripe_invoice_id IS DISTINCT FROM p_stripe_invoice_id
      OR v_history.amount::bigint IS DISTINCT FROM p_amount_paid
      OR v_history.currency IS DISTINCT FROM p_currency
      OR v_history.status NOT IN ('failed', 'succeeded')
      OR (
        v_history.status = 'succeeded'
        AND v_history.stripe_payment_intent_id
          IS DISTINCT FROM p_stripe_payment_intent_id
      )
      OR (
        v_history.status = 'failed'
        AND v_history.stripe_payment_intent_id IS NOT NULL
        AND v_history.stripe_payment_intent_id
          IS DISTINCT FROM p_stripe_payment_intent_id
      )
    THEN
      v_conflict_kind := 'payment_history_identity_mismatch';
    END IF;
  END IF;

  IF v_conflict_kind IS NOT NULL THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'invoice',
      p_stripe_invoice_id,
      NULL,
      'recurring_payment_history_success_identity_conflict',
      'A successful recurring Invoice conflicts with canonical payment-history identity.',
      pg_catalog.jsonb_build_object(
        'conflict_kind', v_conflict_kind,
        'event_id', p_stripe_event_id,
        'event_created', p_stripe_event_created,
        'livemode', p_livemode,
        'input_user_id', p_user_id,
        'canonical_user_id', v_payment.user_id,
        'stripe_payment_intent_id', p_stripe_payment_intent_id,
        'canonical_payment_intent_id',
          v_payment.stripe_payment_intent_id,
        'amount_paid', p_amount_paid,
        'canonical_amount_paid', v_payment.amount_paid,
        'currency', p_currency,
        'canonical_currency', v_payment.currency
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'identity_conflict'
    );
  END IF;

  IF v_history.id IS NOT NULL AND v_history.status = 'succeeded' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status',
      'already_recorded'
    );
  END IF;

  PERFORM pg_catalog.set_config(
    'arena.recurring_payment_history_success_authority',
    'recurring-success',
    true
  );

  IF v_history.id IS NULL THEN
    INSERT INTO public.payment_history (
      user_id,
      stripe_invoice_id,
      stripe_payment_intent_id,
      amount,
      currency,
      status,
      created_at
    ) VALUES (
      p_user_id,
      p_stripe_invoice_id,
      p_stripe_payment_intent_id,
      p_amount_paid::integer,
      p_currency,
      'succeeded',
      pg_catalog.to_timestamp(p_stripe_event_created)
    );

    RETURN pg_catalog.jsonb_build_object('status', 'recorded');
  END IF;

  UPDATE public.payment_history AS history
  SET
    stripe_payment_intent_id = p_stripe_payment_intent_id,
    status = 'succeeded'
  WHERE history.id = v_history.id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count <> 1 THEN
    RAISE EXCEPTION
      'recurring payment-history promotion did not update exactly one row'
      USING ERRCODE = '40001';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status',
    'promoted_from_failed'
  );
END
$function$;

ALTER FUNCTION public.record_recurring_payment_history_success_atomic(
  uuid, boolean, text, bigint, text, text, bigint, text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.record_recurring_payment_history_success_atomic(
    uuid, boolean, text, bigint, text, text, bigint, text
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.record_recurring_payment_history_success_atomic(
    uuid, boolean, text, bigint, text, text, bigint, text
  )
TO service_role;

COMMIT;
