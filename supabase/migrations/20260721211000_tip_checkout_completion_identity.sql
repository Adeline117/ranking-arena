-- Revalidate fresh Tip Checkout identity under the same row/advisory locks as
-- financial completion. Keep the existing eight-argument RPC for mixed App
-- deploys; the expanded overload is the only post-cutover write path.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('tip-checkout-completion-identity-migration', 0)
);

-- A selective 211000 apply is safe only on the exact audited 210000 body. The
-- row lock keeps that prerequisite immutable through this transaction; live
-- object shape alone cannot distinguish an unrecorded or drifted cutover.
DO $exact_lifecycle_ledger$
BEGIN
  IF pg_catalog.to_regclass(
      'supabase_migrations.schema_migrations'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'extensions.digest(text,text)'
    ) IS NULL
  THEN
    RAISE EXCEPTION
      'Tip completion identity requires the exact 20260721210000 migration ledger';
  END IF;

  PERFORM 1
  FROM supabase_migrations.schema_migrations AS ledger
  WHERE ledger.version = '20260721210000'
    AND ledger.name = 'tip_checkout_lifecycle_atomic'
    AND ledger.created_by = 'codex'
    AND ledger.idempotency_key =
      'codex:20260721210000:d10a9959b52e20d127553c1683b154a62c97d85c455ff12e831c3a1d5c7ef1ab'
    AND pg_catalog.array_length(ledger.statements, 1) = 1
    AND pg_catalog.encode(
      extensions.digest(ledger.statements[1], 'sha256'),
      'hex'
    ) = 'd10a9959b52e20d127553c1683b154a62c97d85c455ff12e831c3a1d5c7ef1ab'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Tip completion identity requires the exact 20260721210000 migration ledger';
  END IF;
END
$exact_lifecycle_ledger$;

DO $required_objects$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_completion pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamptz)'
  );
  v_authority_lock pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.lock_tip_notification_authority_atomic(uuid)'
  );
  v_manual_review pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.record_stripe_manual_review_atomic(text,text,uuid,text,text,jsonb)'
  );
  v_required record;
BEGIN
  IF v_postgres IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
  THEN
    RAISE EXCEPTION 'Tip completion identity roles are missing';
  END IF;

  IF pg_catalog.to_regclass('public.tips') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = 'public.tips'::pg_catalog.regclass
        AND relation.relkind IN ('r', 'p')
        AND relation.relowner = v_postgres
    )
  THEN
    RAISE EXCEPTION 'public.tips must be a postgres-owned table';
  END IF;

  FOR v_required IN
    SELECT *
    FROM (
      VALUES
        ('id', 'uuid'::pg_catalog.regtype, true),
        ('from_user_id', 'uuid'::pg_catalog.regtype, true),
        ('amount_cents', 'integer'::pg_catalog.regtype, true),
        ('status', 'text'::pg_catalog.regtype, true),
        ('stripe_checkout_session_id', 'text'::pg_catalog.regtype, false),
        ('stripe_customer_id', 'text'::pg_catalog.regtype, false),
        ('stripe_payment_intent_id', 'text'::pg_catalog.regtype, false),
        ('stripe_charge_id', 'text'::pg_catalog.regtype, false),
        ('checkout_post_id', 'uuid'::pg_catalog.regtype, false),
        ('checkout_to_user_id', 'uuid'::pg_catalog.regtype, false),
        (
          'checkout_expires_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        (
          'checkout_failed_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        ('checkout_failure_reason', 'text'::pg_catalog.regtype, false),
        ('checkout_failure_event_id', 'text'::pg_catalog.regtype, false),
        (
          'checkout_failure_event_created_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        )
    ) AS required_column(column_name, type_oid, must_be_not_null)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.tips'::pg_catalog.regclass
        AND attribute.attname = v_required.column_name
        AND attribute.atttypid = v_required.type_oid
        AND attribute.atttypmod = -1
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND (
          NOT v_required.must_be_not_null
          OR attribute.attnotnull
        )
    ) THEN
      RAISE EXCEPTION
        'Tip completion identity column is missing or incompatible: %',
        v_required.column_name;
    END IF;
  END LOOP;

  IF v_completion IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_completion
      AND function_row.proowner = v_postgres
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'durable eight-argument Tip completion RPC is incompatible';
  END IF;

  IF v_authority_lock IS NULL OR v_manual_review IS NULL THEN
    RAISE EXCEPTION 'Tip completion lock or manual-review prerequisite is missing';
  END IF;

  IF pg_catalog.to_regclass(
      'public.tip_checkout_legacy_completion_audits'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.prevent_tip_checkout_legacy_completion_audit_mutation()'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamptz,text,uuid,uuid,uuid,uuid,bigint,timestamptz,text)'
    ) IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.pronamespace =
          'public'::pg_catalog.regnamespace
        AND function_row.proname =
          'complete_tip_with_stripe_ownership_atomic'
        AND function_row.oid <> v_completion
    )
  THEN
    RAISE EXCEPTION 'Tip completion identity migration was partially applied';
  END IF;
END
$required_objects$;

CREATE TABLE public.tip_checkout_legacy_completion_audits (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tip_id uuid NOT NULL UNIQUE,
  checkout_session_id text NOT NULL UNIQUE,
  stripe_customer_id text NOT NULL,
  stripe_payment_intent_id text NOT NULL UNIQUE,
  stripe_charge_id text NOT NULL UNIQUE,
  client_reference_id text,
  metadata_user_id uuid NOT NULL,
  metadata_from_user_id uuid NOT NULL,
  metadata_post_id uuid NOT NULL,
  metadata_to_user_id uuid NOT NULL,
  metadata_amount_cents integer NOT NULL,
  amount_paid integer NOT NULL,
  currency text NOT NULL,
  checkout_expires_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  initial_event_id text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.date_trunc(
    'second',
    pg_catalog.clock_timestamp()
  ),
  CONSTRAINT tip_checkout_legacy_completion_audit_shape CHECK (
    pg_catalog.length(checkout_session_id) BETWEEN 4 AND 255
    AND checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_customer_id) BETWEEN 5 AND 255
    AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_payment_intent_id) BETWEEN 4 AND 255
    AND stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_charge_id) BETWEEN 4 AND 255
    AND stripe_charge_id ~ '^ch_[A-Za-z0-9_]+$'
    AND client_reference_id IS NULL
    AND metadata_user_id = metadata_from_user_id
    AND metadata_amount_cents BETWEEN 100 AND 50000
    AND amount_paid = metadata_amount_cents
    AND currency = 'usd'
    AND checkout_expires_at = pg_catalog.date_trunc(
      'second', checkout_expires_at
    )
    AND completed_at = pg_catalog.date_trunc('second', completed_at)
    AND pg_catalog.length(initial_event_id) BETWEEN 5 AND 255
    AND initial_event_id ~ '^evt_[A-Za-z0-9_]+$'
    AND created_at = pg_catalog.date_trunc('second', created_at)
  )
);

ALTER TABLE public.tip_checkout_legacy_completion_audits OWNER TO postgres;
ALTER TABLE public.tip_checkout_legacy_completion_audits ENABLE ROW LEVEL SECURITY;

CREATE POLICY tip_checkout_legacy_completion_audits_service_select
  ON public.tip_checkout_legacy_completion_audits
  FOR SELECT
  TO service_role
  USING (COALESCE((SELECT auth.role()), '') = 'service_role');

REVOKE ALL ON TABLE public.tip_checkout_legacy_completion_audits
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT SELECT ON TABLE public.tip_checkout_legacy_completion_audits
  TO service_role;

CREATE OR REPLACE FUNCTION
  public.prevent_tip_checkout_legacy_completion_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'Tip legacy completion audit rows are immutable'
    USING ERRCODE = '23514';
END
$function$;

ALTER FUNCTION
  public.prevent_tip_checkout_legacy_completion_audit_mutation()
  OWNER TO postgres;

REVOKE ALL ON FUNCTION
  public.prevent_tip_checkout_legacy_completion_audit_mutation()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE TRIGGER trg_tip_checkout_legacy_completion_audits_immutable
  BEFORE UPDATE OR DELETE
  ON public.tip_checkout_legacy_completion_audits
  FOR EACH ROW
  EXECUTE FUNCTION
    public.prevent_tip_checkout_legacy_completion_audit_mutation();

CREATE OR REPLACE FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  p_tip_id uuid,
  p_stripe_customer_id text,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_checkout_session_id text,
  p_amount_paid bigint,
  p_currency text,
  p_completed_at timestamptz,
  p_client_reference_id text,
  p_metadata_user_id uuid,
  p_metadata_from_user_id uuid,
  p_metadata_post_id uuid,
  p_metadata_to_user_id uuid,
  p_metadata_amount_cents bigint,
  p_checkout_expires_at timestamptz,
  p_event_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_tip public.tips%ROWTYPE;
  v_result jsonb;
  v_financial_status text;
  v_is_legacy boolean := false;
  v_conflict_reason text;
  v_conflicting_audit_tip_id uuid;
  v_audit public.tip_checkout_legacy_completion_audits%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_tip_id IS NULL
    OR pg_catalog.length(COALESCE(p_stripe_customer_id, ''))
      NOT BETWEEN 5 AND 255
    OR COALESCE(p_stripe_customer_id, '') !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(COALESCE(p_stripe_payment_intent_id, ''))
      NOT BETWEEN 4 AND 255
    OR COALESCE(p_stripe_payment_intent_id, '') !~ '^pi_[A-Za-z0-9_]+$'
    OR pg_catalog.length(COALESCE(p_stripe_charge_id, ''))
      NOT BETWEEN 4 AND 255
    OR COALESCE(p_stripe_charge_id, '') !~ '^ch_[A-Za-z0-9_]+$'
    OR pg_catalog.length(COALESCE(p_checkout_session_id, ''))
      NOT BETWEEN 4 AND 255
    OR COALESCE(p_checkout_session_id, '') !~ '^cs_[A-Za-z0-9_]+$'
    OR p_amount_paid IS NULL
    OR p_amount_paid NOT BETWEEN 100 AND 50000
    OR p_currency IS DISTINCT FROM 'usd'
    OR p_completed_at IS NULL
    OR p_completed_at IS DISTINCT FROM pg_catalog.date_trunc(
      'second', p_completed_at
    )
    OR p_metadata_user_id IS NULL
    OR p_metadata_from_user_id IS NULL
    OR p_metadata_post_id IS NULL
    OR p_metadata_to_user_id IS NULL
    OR p_metadata_amount_cents IS NULL
    OR p_metadata_amount_cents NOT BETWEEN 100 AND 50000
    OR p_checkout_expires_at IS NULL
    OR p_checkout_expires_at IS DISTINCT FROM pg_catalog.date_trunc(
      'second', p_checkout_expires_at
    )
    OR pg_catalog.length(COALESCE(p_event_id, '')) NOT BETWEEN 5 AND 255
    OR COALESCE(p_event_id, '') !~ '^evt_[A-Za-z0-9_]+$'
    OR (
      p_client_reference_id IS NOT NULL
      AND (
        pg_catalog.length(p_client_reference_id) <> 36
        OR p_client_reference_id !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      )
    )
  THEN
    RAISE EXCEPTION 'expanded Tip completion identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- This is the exact lock order used by the existing durable completion
  -- wrapper. Its nested call re-enters every lock without changing order.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || p_stripe_charge_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-payment-identity:' || p_stripe_payment_intent_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-checkout-session:' || p_checkout_session_id,
      0
    )
  );
  PERFORM public.lock_tip_notification_authority_atomic(p_tip_id);

  SELECT tip.*
  INTO v_tip
  FROM public.tips AS tip
  WHERE tip.id = p_tip_id
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'tip_checkout_completion',
      p_event_id,
      NULL::uuid,
      'tip_checkout_completion_subject_missing',
      'Fresh Stripe completion authority references a missing Tip.',
      pg_catalog.jsonb_build_object(
        'tip_id', p_tip_id,
        'checkout_session_id', p_checkout_session_id,
        'payment_intent_id', p_stripe_payment_intent_id,
        'charge_id', p_stripe_charge_id
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'manual_review',
      'reason_key', 'tip_checkout_completion_subject_missing'
    );
  END IF;

  IF v_tip.status = 'failed' THEN
    v_conflict_reason := 'tip_checkout_completion_after_expiry';
  ELSIF v_tip.from_user_id IS DISTINCT FROM p_metadata_user_id
    OR v_tip.from_user_id IS DISTINCT FROM p_metadata_from_user_id
    OR p_metadata_user_id IS DISTINCT FROM p_metadata_from_user_id
  THEN
    v_conflict_reason := 'tip_checkout_completion_payer_drift';
  ELSIF v_tip.amount_cents::bigint IS DISTINCT FROM p_amount_paid
    OR v_tip.amount_cents::bigint IS DISTINCT FROM p_metadata_amount_cents
  THEN
    v_conflict_reason := 'tip_checkout_completion_amount_drift';
  ELSIF v_tip.checkout_post_id IS NULL
    OR v_tip.checkout_post_id IS DISTINCT FROM p_metadata_post_id
    OR v_tip.checkout_to_user_id IS NULL
    OR v_tip.checkout_to_user_id IS DISTINCT FROM p_metadata_to_user_id
  THEN
    v_conflict_reason := 'tip_checkout_completion_snapshot_drift';
  ELSIF v_tip.stripe_checkout_session_id IS NULL
    OR v_tip.stripe_checkout_session_id IS DISTINCT FROM p_checkout_session_id
  THEN
    v_conflict_reason := 'tip_checkout_completion_session_drift';
  ELSIF v_tip.stripe_customer_id IS NOT NULL
    AND v_tip.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
  THEN
    v_conflict_reason := 'tip_checkout_completion_customer_drift';
  ELSIF v_tip.stripe_payment_intent_id IS NOT NULL
    AND v_tip.stripe_payment_intent_id IS DISTINCT FROM
      p_stripe_payment_intent_id
  THEN
    v_conflict_reason := 'tip_checkout_completion_payment_intent_drift';
  ELSIF v_tip.stripe_charge_id IS NOT NULL
    AND v_tip.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
  THEN
    v_conflict_reason := 'tip_checkout_completion_charge_drift';
  ELSIF v_tip.checkout_expires_at IS NULL THEN
    v_is_legacy := true;
    IF p_client_reference_id IS NOT NULL
      OR v_tip.checkout_failed_at IS NOT NULL
      OR v_tip.checkout_failure_reason IS NOT NULL
      OR v_tip.checkout_failure_event_id IS NOT NULL
      OR v_tip.checkout_failure_event_created_at IS NOT NULL
    THEN
      v_conflict_reason := 'tip_checkout_completion_legacy_shape_drift';
    END IF;
  ELSIF p_client_reference_id IS DISTINCT FROM p_tip_id::text
    OR v_tip.checkout_expires_at IS DISTINCT FROM p_checkout_expires_at
  THEN
    v_conflict_reason := 'tip_checkout_completion_lifecycle_drift';
  END IF;

  IF v_conflict_reason IS NOT NULL THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'tip_checkout_completion',
      p_event_id,
      v_tip.from_user_id,
      v_conflict_reason,
      'Fresh Stripe completion identity conflicts with the locked Tip snapshot.',
      pg_catalog.jsonb_build_object(
        'tip_id', v_tip.id,
        'tip_status', v_tip.status,
        'tip_from_user_id', v_tip.from_user_id,
        'metadata_user_id', p_metadata_user_id,
        'metadata_from_user_id', p_metadata_from_user_id,
        'checkout_post_id', v_tip.checkout_post_id,
        'metadata_post_id', p_metadata_post_id,
        'checkout_to_user_id', v_tip.checkout_to_user_id,
        'metadata_to_user_id', p_metadata_to_user_id,
        'tip_amount_cents', v_tip.amount_cents,
        'metadata_amount_cents', p_metadata_amount_cents,
        'amount_paid', p_amount_paid,
        'recorded_session_id', v_tip.stripe_checkout_session_id,
        'checkout_session_id', p_checkout_session_id,
        'client_reference_id', p_client_reference_id,
        'recorded_checkout_expires_at', v_tip.checkout_expires_at,
        'checkout_expires_at', p_checkout_expires_at,
        'stripe_customer_id', p_stripe_customer_id,
        'stripe_payment_intent_id', p_stripe_payment_intent_id,
        'stripe_charge_id', p_stripe_charge_id
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'manual_review',
      'tip_id', v_tip.id,
      'reason_key', v_conflict_reason
    );
  END IF;

  IF v_is_legacy THEN
    SELECT audit.tip_id
    INTO v_conflicting_audit_tip_id
    FROM public.tip_checkout_legacy_completion_audits AS audit
    WHERE audit.tip_id <> v_tip.id
      AND (
        audit.checkout_session_id = p_checkout_session_id
        OR audit.stripe_payment_intent_id = p_stripe_payment_intent_id
        OR audit.stripe_charge_id = p_stripe_charge_id
        OR audit.initial_event_id = p_event_id
      )
    ORDER BY audit.tip_id
    LIMIT 1
    FOR SHARE;
    IF FOUND THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'tip_checkout_completion',
        p_event_id,
        v_tip.from_user_id,
        'tip_checkout_legacy_audit_identity_reuse',
        'Legacy Tip completion identity is already audited for another Tip.',
        pg_catalog.jsonb_build_object(
          'tip_id', v_tip.id,
          'conflicting_tip_id', v_conflicting_audit_tip_id,
          'checkout_session_id', p_checkout_session_id,
          'payment_intent_id', p_stripe_payment_intent_id,
          'charge_id', p_stripe_charge_id
        )
      );
      RETURN pg_catalog.jsonb_build_object(
        'status', 'manual_review',
        'tip_id', v_tip.id,
        'reason_key', 'tip_checkout_legacy_audit_identity_reuse'
      );
    END IF;
  END IF;

  v_result := public.complete_tip_with_stripe_ownership_atomic(
    p_tip_id,
    p_stripe_customer_id,
    p_stripe_payment_intent_id,
    p_stripe_charge_id,
    p_checkout_session_id,
    p_amount_paid,
    p_currency,
    p_completed_at
  );

  v_financial_status := COALESCE(
    v_result ->> 'completion_status',
    v_result ->> 'status'
  );
  IF v_is_legacy AND v_financial_status IN (
    'completed',
    'already_completed',
    'refunded'
  ) THEN
    INSERT INTO public.tip_checkout_legacy_completion_audits (
      tip_id,
      checkout_session_id,
      stripe_customer_id,
      stripe_payment_intent_id,
      stripe_charge_id,
      client_reference_id,
      metadata_user_id,
      metadata_from_user_id,
      metadata_post_id,
      metadata_to_user_id,
      metadata_amount_cents,
      amount_paid,
      currency,
      checkout_expires_at,
      completed_at,
      initial_event_id
    ) VALUES (
      p_tip_id,
      p_checkout_session_id,
      p_stripe_customer_id,
      p_stripe_payment_intent_id,
      p_stripe_charge_id,
      p_client_reference_id,
      p_metadata_user_id,
      p_metadata_from_user_id,
      p_metadata_post_id,
      p_metadata_to_user_id,
      p_metadata_amount_cents::integer,
      p_amount_paid::integer,
      p_currency,
      p_checkout_expires_at,
      p_completed_at,
      p_event_id
    )
    ON CONFLICT (tip_id) DO NOTHING;

    SELECT audit.*
    INTO v_audit
    FROM public.tip_checkout_legacy_completion_audits AS audit
    WHERE audit.tip_id = p_tip_id
    FOR SHARE;
    IF NOT FOUND
      OR v_audit.checkout_session_id IS DISTINCT FROM p_checkout_session_id
      OR v_audit.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
      OR v_audit.stripe_payment_intent_id IS DISTINCT FROM
        p_stripe_payment_intent_id
      OR v_audit.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
      OR v_audit.client_reference_id IS NOT NULL
      OR v_audit.metadata_user_id IS DISTINCT FROM p_metadata_user_id
      OR v_audit.metadata_from_user_id IS DISTINCT FROM p_metadata_from_user_id
      OR v_audit.metadata_post_id IS DISTINCT FROM p_metadata_post_id
      OR v_audit.metadata_to_user_id IS DISTINCT FROM p_metadata_to_user_id
      OR v_audit.metadata_amount_cents::bigint IS DISTINCT FROM
        p_metadata_amount_cents
      OR v_audit.amount_paid::bigint IS DISTINCT FROM p_amount_paid
      OR v_audit.currency IS DISTINCT FROM p_currency
      OR v_audit.checkout_expires_at IS DISTINCT FROM p_checkout_expires_at
      OR v_audit.completed_at IS DISTINCT FROM p_completed_at
    THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'tip_checkout_completion',
        p_event_id,
        v_tip.from_user_id,
        'tip_checkout_legacy_audit_replay_conflict',
        'Legacy Tip completion did not converge on its immutable audit.',
        pg_catalog.jsonb_build_object(
          'tip_id', p_tip_id,
          'checkout_session_id', p_checkout_session_id,
          'payment_intent_id', p_stripe_payment_intent_id,
          'charge_id', p_stripe_charge_id
        )
      );
      RETURN v_result || pg_catalog.jsonb_build_object(
        'completion_status', v_financial_status,
        'status', 'manual_review',
        'reason_key', 'tip_checkout_legacy_audit_replay_conflict'
      );
    END IF;
  END IF;

  RETURN v_result;
END
$function$;

ALTER FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  uuid,
  text,
  text,
  text,
  text,
  bigint,
  text,
  timestamptz,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  bigint,
  timestamptz,
  text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  uuid,
  text,
  text,
  text,
  text,
  bigint,
  text,
  timestamptz,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  bigint,
  timestamptz,
  text
) FROM PUBLIC, anon, authenticated, authenticator;

GRANT EXECUTE ON FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  uuid,
  text,
  text,
  text,
  text,
  bigint,
  text,
  timestamptz,
  text,
  uuid,
  uuid,
  uuid,
  uuid,
  bigint,
  timestamptz,
  text
) TO service_role;

-- Default privileges may add arbitrary grants (including WITH GRANT OPTION).
-- Converge every new object to the explicit contract before postflight.
DO $converge_acl$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_acl record;
BEGIN
  REVOKE ALL ON TABLE public.tip_checkout_legacy_completion_audits
    FROM PUBLIC;
  FOR v_acl IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(acl_row.grantee) AS role_name
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_row
    WHERE relation.oid =
        'public.tip_checkout_legacy_completion_audits'::pg_catalog.regclass
      AND acl_row.grantee NOT IN (0, v_postgres)
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON TABLE public.tip_checkout_legacy_completion_audits FROM %I',
      v_acl.role_name
    );
  END LOOP;
  GRANT SELECT ON TABLE public.tip_checkout_legacy_completion_audits
    TO service_role;

  REVOKE ALL ON FUNCTION
    public.prevent_tip_checkout_legacy_completion_audit_mutation()
    FROM PUBLIC;
  FOR v_acl IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(acl_row.grantee) AS role_name
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_row
    WHERE function_row.oid =
        'public.prevent_tip_checkout_legacy_completion_audit_mutation()'::pg_catalog.regprocedure
      AND acl_row.grantee NOT IN (0, v_postgres)
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION public.prevent_tip_checkout_legacy_completion_audit_mutation() FROM %I',
      v_acl.role_name
    );
  END LOOP;

  REVOKE ALL ON FUNCTION public.complete_tip_with_stripe_ownership_atomic(
    uuid,
    text,
    text,
    text,
    text,
    bigint,
    text,
    timestamptz,
    text,
    uuid,
    uuid,
    uuid,
    uuid,
    bigint,
    timestamptz,
    text
  ) FROM PUBLIC;
  FOR v_acl IN
    SELECT DISTINCT pg_catalog.pg_get_userbyid(acl_row.grantee) AS role_name
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_row
    WHERE function_row.oid =
        'public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamp with time zone,text,uuid,uuid,uuid,uuid,bigint,timestamp with time zone,text)'::pg_catalog.regprocedure
      AND acl_row.grantee NOT IN (0, v_postgres)
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamptz,text,uuid,uuid,uuid,uuid,bigint,timestamptz,text) FROM %I',
      v_acl.role_name
    );
  END LOOP;
  GRANT EXECUTE ON FUNCTION public.complete_tip_with_stripe_ownership_atomic(
    uuid,
    text,
    text,
    text,
    text,
    bigint,
    text,
    timestamptz,
    text,
    uuid,
    uuid,
    uuid,
    uuid,
    bigint,
    timestamptz,
    text
  ) TO service_role;
END
$converge_acl$;

DO $postflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service oid := pg_catalog.to_regrole('service_role');
  v_table pg_catalog.regclass := pg_catalog.to_regclass(
    'public.tip_checkout_legacy_completion_audits'
  );
  v_trigger_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.prevent_tip_checkout_legacy_completion_audit_mutation()'
  );
  v_old_completion pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamptz)'
  );
  v_new_completion pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamptz,text,uuid,uuid,uuid,uuid,bigint,timestamptz,text)'
  );
  v_authority_lock pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.lock_tip_notification_authority_atomic(uuid)'
  );
  v_manual_review pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.record_stripe_manual_review_atomic(text,text,uuid,text,text,jsonb)'
  );
  v_required record;
  v_default text;
  v_check_definition text;
  v_policy_qual text;
  v_old_source text;
  v_new_source text;
  v_charge_position integer;
  v_payment_position integer;
  v_session_position integer;
  v_authority_position integer;
  v_tip_position integer;
  v_tip_lock_position integer;
  v_nested_position integer;
BEGIN
  IF v_postgres IS NULL
    OR v_service IS NULL
    OR v_table IS NULL
    OR v_trigger_function IS NULL
    OR v_old_completion IS NULL
    OR v_new_completion IS NULL
    OR v_authority_lock IS NULL
    OR v_manual_review IS NULL
  THEN
    RAISE EXCEPTION 'Tip completion identity postflight object is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_table
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND relation.relowner = v_postgres
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'Tip legacy completion audit table shape drifted';
  END IF;

  FOR v_required IN
    SELECT *
    FROM (
      VALUES
        ('id', 'uuid'::pg_catalog.regtype, true, true),
        ('tip_id', 'uuid'::pg_catalog.regtype, true, false),
        ('checkout_session_id', 'text'::pg_catalog.regtype, true, false),
        ('stripe_customer_id', 'text'::pg_catalog.regtype, true, false),
        ('stripe_payment_intent_id', 'text'::pg_catalog.regtype, true, false),
        ('stripe_charge_id', 'text'::pg_catalog.regtype, true, false),
        ('client_reference_id', 'text'::pg_catalog.regtype, false, false),
        ('metadata_user_id', 'uuid'::pg_catalog.regtype, true, false),
        ('metadata_from_user_id', 'uuid'::pg_catalog.regtype, true, false),
        ('metadata_post_id', 'uuid'::pg_catalog.regtype, true, false),
        ('metadata_to_user_id', 'uuid'::pg_catalog.regtype, true, false),
        ('metadata_amount_cents', 'integer'::pg_catalog.regtype, true, false),
        ('amount_paid', 'integer'::pg_catalog.regtype, true, false),
        ('currency', 'text'::pg_catalog.regtype, true, false),
        (
          'checkout_expires_at',
          'timestamp with time zone'::pg_catalog.regtype,
          true,
          false
        ),
        (
          'completed_at',
          'timestamp with time zone'::pg_catalog.regtype,
          true,
          false
        ),
        ('initial_event_id', 'text'::pg_catalog.regtype, true, false),
        (
          'created_at',
          'timestamp with time zone'::pg_catalog.regtype,
          true,
          true
        )
    ) AS required_column(
      column_name,
      type_oid,
      must_be_not_null,
      must_have_default
    )
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_table
        AND attribute.attname = v_required.column_name
        AND attribute.atttypid = v_required.type_oid
        AND attribute.atttypmod = -1
        AND attribute.attnotnull = v_required.must_be_not_null
        AND attribute.atthasdef = v_required.must_have_default
        AND attribute.attidentity = ''
        AND attribute.attgenerated = ''
        AND attribute.attacl IS NULL
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) THEN
      RAISE EXCEPTION
        'Tip legacy completion audit column drifted: %',
        v_required.column_name;
    END IF;
  END LOOP;
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_table
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 18 THEN
    RAISE EXCEPTION 'Tip legacy completion audit column set drifted';
  END IF;

  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
  INTO v_default
  FROM pg_catalog.pg_attrdef AS default_row
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = default_row.adrelid
    AND attribute.attnum = default_row.adnum
  WHERE default_row.adrelid = v_table
    AND attribute.attname = 'id';
  IF v_default IS NULL
    OR pg_catalog.strpos(v_default, 'gen_random_uuid()') = 0
  THEN
    RAISE EXCEPTION 'Tip legacy completion audit id default drifted';
  END IF;
  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
  INTO v_default
  FROM pg_catalog.pg_attrdef AS default_row
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = default_row.adrelid
    AND attribute.attnum = default_row.adnum
  WHERE default_row.adrelid = v_table
    AND attribute.attname = 'created_at';
  IF v_default IS NULL
    OR pg_catalog.strpos(v_default, 'date_trunc') = 0
    OR pg_catalog.strpos(v_default, 'clock_timestamp()') = 0
  THEN
    RAISE EXCEPTION 'Tip legacy completion audit timestamp default drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_table
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
  ) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.conrelid
        AND attribute.attnum = constraint_row.conkey[1]
      WHERE constraint_row.conrelid = v_table
        AND constraint_row.contype = 'p'
        AND pg_catalog.array_length(constraint_row.conkey, 1) = 1
        AND attribute.attname = 'id'
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_table
        AND constraint_row.contype = 'u'
        AND constraint_row.convalidated
        AND pg_catalog.array_length(constraint_row.conkey, 1) = 1
    ) <> 5
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_row
      JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = constraint_row.conrelid
        AND attribute.attnum = constraint_row.conkey[1]
      WHERE constraint_row.conrelid = v_table
        AND constraint_row.contype = 'u'
        AND attribute.attname IN (
          'tip_id',
          'checkout_session_id',
          'stripe_payment_intent_id',
          'stripe_charge_id',
          'initial_event_id'
        )
    ) <> 5
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_table
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND constraint_row.conname =
          'tip_checkout_legacy_completion_audit_shape'
    ) <> 1
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_table
        AND constraint_row.contype NOT IN ('p', 'u', 'c')
    )
  THEN
    RAISE EXCEPTION 'Tip legacy completion audit constraint set drifted';
  END IF;
  SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
  INTO v_check_definition
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = v_table
    AND constraint_row.conname =
      'tip_checkout_legacy_completion_audit_shape';
  IF v_check_definition IS NULL
    OR pg_catalog.strpos(v_check_definition, 'client_reference_id IS NULL') = 0
    OR pg_catalog.strpos(
      v_check_definition,
      'metadata_user_id = metadata_from_user_id'
    ) = 0
    OR pg_catalog.strpos(v_check_definition, 'currency = ''usd''') = 0
    OR pg_catalog.strpos(v_check_definition, 'initial_event_id') = 0
  THEN
    RAISE EXCEPTION 'Tip legacy completion audit CHECK drifted';
  END IF;

  IF NOT pg_catalog.has_table_privilege(v_service, v_table, 'SELECT')
    OR pg_catalog.has_table_privilege(v_service, v_table, 'INSERT')
    OR pg_catalog.has_table_privilege(v_service, v_table, 'UPDATE')
    OR pg_catalog.has_table_privilege(v_service, v_table, 'DELETE')
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_row
      WHERE relation.oid = v_table
        AND (
          acl_row.grantee NOT IN (v_postgres, v_service)
          OR (
            acl_row.grantee = v_service
            AND (
              acl_row.privilege_type <> 'SELECT'
              OR acl_row.is_grantable
            )
          )
        )
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_row
      WHERE relation.oid = v_table
        AND acl_row.grantee = v_service
        AND acl_row.privilege_type = 'SELECT'
        AND NOT acl_row.is_grantable
    ) <> 1
  THEN
    RAISE EXCEPTION 'Tip legacy completion audit table ACL drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = v_table
  ) <> 1
  THEN
    RAISE EXCEPTION 'Tip legacy completion audit policy set drifted';
  END IF;
  SELECT pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid)
  INTO v_policy_qual
  FROM pg_catalog.pg_policy AS policy_row
  WHERE policy_row.polrelid = v_table
    AND policy_row.polname =
      'tip_checkout_legacy_completion_audits_service_select'
    AND policy_row.polcmd = 'r'
    AND policy_row.polpermissive
    AND policy_row.polroles = ARRAY[v_service]::oid[]
    AND policy_row.polwithcheck IS NULL;
  IF v_policy_qual IS NULL
    OR pg_catalog.md5(v_policy_qual) <>
      '8c6ddc5473c9092822b853b3d6105248'
  THEN
    RAISE EXCEPTION 'Tip legacy completion audit policy drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_table
      AND NOT trigger_row.tgisinternal
  ) <> 1
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_table
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgname =
          'trg_tip_checkout_legacy_completion_audits_immutable'
        AND trigger_row.tgenabled = 'O'
        AND trigger_row.tgtype = 27
        AND trigger_row.tgnargs = 0
        AND trigger_row.tgqual IS NULL
        AND trigger_row.tgconstraint = 0
        AND NOT trigger_row.tgdeferrable
        AND NOT trigger_row.tginitdeferred
        AND trigger_row.tgfoid = v_trigger_function
    )
  THEN
    RAISE EXCEPTION 'Tip legacy completion audit trigger drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_trigger_function
      AND function_row.proowner = v_postgres
      AND function_row.prolang = (
        SELECT language_row.oid
        FROM pg_catalog.pg_language AS language_row
        WHERE language_row.lanname = 'plpgsql'
      )
      AND function_row.prorettype = 'trigger'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prokind = 'f'
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND function_row.proargnames IS NULL
      AND function_row.proargmodes IS NULL
      AND function_row.proallargtypes IS NULL
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
      AND pg_catalog.encode(
        extensions.digest(function_row.prosrc, 'sha256'),
        'hex'
      ) = '7c29e8275b6ccd6388c2308bd44cb00181aa042e55cdd95b57861397772e496e'
  )
    OR pg_catalog.has_function_privilege(
      v_service,
      v_trigger_function,
      'EXECUTE'
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
      WHERE function_row.oid = v_trigger_function
        AND acl_row.grantee <> v_postgres
    )
  THEN
    RAISE EXCEPTION 'Tip legacy completion audit trigger function drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_authority_lock
      AND function_row.proowner = v_postgres
      AND function_row.prolang = (
        SELECT language_row.oid
        FROM pg_catalog.pg_language AS language_row
        WHERE language_row.lanname = 'plpgsql'
      )
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prokind = 'f'
      AND function_row.pronargs = 1
      AND function_row.pronargdefaults = 0
      AND function_row.proargnames = ARRAY['p_tip_id']::text[]
      AND function_row.proargmodes IS NULL
      AND function_row.proallargtypes IS NULL
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.encode(
        extensions.digest(function_row.prosrc, 'sha256'),
        'hex'
      ) = '40953ad533d19339ac23c42aa0893a009c5ac8fc9cc5e1fd375d1a2c05ea272f'
  )
    OR pg_catalog.has_function_privilege(
      v_service,
      v_authority_lock,
      'EXECUTE'
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
      WHERE function_row.oid = v_authority_lock
        AND acl_row.grantee <> v_postgres
    )
  THEN
    RAISE EXCEPTION 'Tip notification authority lock prerequisite drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_manual_review
      AND function_row.proowner = v_postgres
      AND function_row.prolang = (
        SELECT language_row.oid
        FROM pg_catalog.pg_language AS language_row
        WHERE language_row.lanname = 'plpgsql'
      )
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prokind = 'f'
      AND function_row.pronargs = 6
      AND function_row.pronargdefaults = 0
      AND function_row.proargnames = ARRAY[
        'p_object_type',
        'p_object_id',
        'p_user_id',
        'p_reason_key',
        'p_reason',
        'p_context'
      ]::text[]
      AND function_row.proargmodes IS NULL
      AND function_row.proallargtypes IS NULL
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.encode(
        extensions.digest(function_row.prosrc, 'sha256'),
        'hex'
      ) = 'c3ceb0b30556e234321ca061496012cf6b51c360515516cb01e683643f8b774d'
  )
    OR NOT pg_catalog.has_function_privilege(
      v_service,
      v_manual_review,
      'EXECUTE'
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
      WHERE function_row.oid = v_manual_review
        AND (
          acl_row.grantee NOT IN (v_postgres, v_service)
          OR (
            acl_row.grantee = v_service
            AND (
              acl_row.privilege_type <> 'EXECUTE'
              OR acl_row.is_grantable
            )
          )
        )
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
      WHERE function_row.oid = v_manual_review
        AND acl_row.grantee = v_service
        AND acl_row.privilege_type = 'EXECUTE'
        AND NOT acl_row.is_grantable
    ) <> 1
  THEN
    RAISE EXCEPTION 'Stripe manual-review prerequisite drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname =
        'complete_tip_with_stripe_ownership_atomic'
  ) <> 2
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
        AND function_row.proname =
          'complete_tip_with_stripe_ownership_atomic'
        AND function_row.oid NOT IN (v_old_completion, v_new_completion)
    )
  THEN
    RAISE EXCEPTION 'Tip completion RPC overload set drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (v_old_completion, v_new_completion)
      AND (
        function_row.proowner <> v_postgres
        OR function_row.prolang <> (
          SELECT language_row.oid
          FROM pg_catalog.pg_language AS language_row
          WHERE language_row.lanname = 'plpgsql'
        )
        OR function_row.prorettype <> 'jsonb'::pg_catalog.regtype
        OR function_row.proretset
        OR NOT function_row.prosecdef
        OR function_row.provolatile <> 'v'
        OR function_row.prokind <> 'f'
        OR function_row.pronargdefaults <> 0
        OR function_row.proargmodes IS NOT NULL
        OR function_row.proallargtypes IS NOT NULL
        OR function_row.proconfig IS DISTINCT FROM ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
      )
  )
    OR NOT pg_catalog.has_function_privilege(
      v_service,
      v_old_completion,
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      v_service,
      v_new_completion,
      'EXECUTE'
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
      WHERE function_row.oid IN (v_old_completion, v_new_completion)
        AND (
          acl_row.grantee NOT IN (v_postgres, v_service)
          OR (
            acl_row.grantee = v_service
            AND (
              acl_row.privilege_type <> 'EXECUTE'
              OR acl_row.is_grantable
            )
          )
        )
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
      WHERE function_row.oid IN (v_old_completion, v_new_completion)
        AND acl_row.grantee = v_service
        AND acl_row.privilege_type = 'EXECUTE'
        AND NOT acl_row.is_grantable
    ) <> 2
  THEN
    RAISE EXCEPTION 'Tip completion RPC owner, config, or ACL drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_old_completion
      AND function_row.pronargs = 8
      AND function_row.proargnames = ARRAY[
        'p_tip_id',
        'p_stripe_customer_id',
        'p_stripe_payment_intent_id',
        'p_stripe_charge_id',
        'p_checkout_session_id',
        'p_amount_paid',
        'p_currency',
        'p_completed_at'
      ]::text[]
      AND pg_catalog.encode(
        extensions.digest(function_row.prosrc, 'sha256'),
        'hex'
      ) = '3b7f906d3bbadba61ac8ac103921f8711425d59c8349840dfc56ddda15d27146'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_new_completion
      AND function_row.pronargs = 16
      AND function_row.proargnames = ARRAY[
        'p_tip_id',
        'p_stripe_customer_id',
        'p_stripe_payment_intent_id',
        'p_stripe_charge_id',
        'p_checkout_session_id',
        'p_amount_paid',
        'p_currency',
        'p_completed_at',
        'p_client_reference_id',
        'p_metadata_user_id',
        'p_metadata_from_user_id',
        'p_metadata_post_id',
        'p_metadata_to_user_id',
        'p_metadata_amount_cents',
        'p_checkout_expires_at',
        'p_event_id'
      ]::text[]
      AND pg_catalog.encode(
        extensions.digest(function_row.prosrc, 'sha256'),
        'hex'
      ) = '229187be40e62e0014e948dfb6c801a0ad7f3b1946e9ed884157f5c615993292'
  ) THEN
    RAISE EXCEPTION 'Tip completion RPC arguments or body hash drifted';
  END IF;

  SELECT function_row.prosrc
  INTO v_old_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_old_completion;
  IF v_old_source IS NULL
    OR pg_catalog.strpos(v_old_source, 'stripe-charge-refund:') = 0
    OR pg_catalog.strpos(v_old_source, 'stripe-payment-identity:') = 0
    OR pg_catalog.strpos(v_old_source, 'stripe-checkout-session:') = 0
    OR pg_catalog.strpos(
      v_old_source,
      'public.lock_tip_notification_authority_atomic'
    ) = 0
    OR pg_catalog.strpos(v_old_source, 'FROM public.tips AS tip') = 0
    OR pg_catalog.strpos(v_old_source, 'FOR UPDATE') = 0
    OR pg_catalog.strpos(
      v_old_source,
      'public.record_stripe_manual_review_atomic'
    ) = 0
  THEN
    RAISE EXCEPTION 'Durable eight-argument Tip completion body drifted';
  END IF;

  SELECT function_row.prosrc
  INTO v_new_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_new_completion;
  v_charge_position := pg_catalog.strpos(
    v_new_source,
    'stripe-charge-refund:'
  );
  v_payment_position := pg_catalog.strpos(
    v_new_source,
    'stripe-payment-identity:'
  );
  v_session_position := pg_catalog.strpos(
    v_new_source,
    'stripe-checkout-session:'
  );
  v_authority_position := pg_catalog.strpos(
    v_new_source,
    'public.lock_tip_notification_authority_atomic'
  );
  v_tip_position := pg_catalog.strpos(
    v_new_source,
    'FROM public.tips AS tip'
  );
  v_tip_lock_position := pg_catalog.strpos(v_new_source, 'FOR UPDATE');
  v_nested_position := pg_catalog.strpos(
    v_new_source,
    'v_result := public.complete_tip_with_stripe_ownership_atomic('
  );
  IF v_new_source IS NULL
    OR v_charge_position = 0
    OR v_payment_position <= v_charge_position
    OR v_session_position <= v_payment_position
    OR v_authority_position <= v_session_position
    OR v_tip_position <= v_authority_position
    OR v_tip_lock_position <= v_tip_position
    OR v_nested_position <= v_tip_lock_position
    OR pg_catalog.strpos(
      v_new_source,
      'p_client_reference_id IS DISTINCT FROM p_tip_id::text'
    ) = 0
    OR pg_catalog.strpos(
      v_new_source,
      'v_tip.checkout_expires_at IS DISTINCT FROM p_checkout_expires_at'
    ) = 0
    OR pg_catalog.strpos(
      v_new_source,
      'tip_checkout_legacy_completion_audits'
    ) = 0
    OR pg_catalog.strpos(
      v_new_source,
      'public.record_stripe_manual_review_atomic'
    ) = 0
    OR pg_catalog.strpos(
      v_new_source,
      'tip_checkout_completion_lifecycle_drift'
    ) = 0
    OR pg_catalog.strpos(
      v_new_source,
      'tip_checkout_legacy_audit_replay_conflict'
    ) = 0
  THEN
    RAISE EXCEPTION 'Expanded Tip completion body or lock order drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
