-- Preserve opaque financial-subject UUIDs after account hard deletion.
--
-- tips.from_user_id historically referenced auth.users ON DELETE CASCADE,
-- which erased completed Tip ledgers. stripe_entitlement_payments.user_id
-- referenced user_profiles ON DELETE SET NULL, which made the immutable
-- central ownership row non-exact and prevented deterministic refund routing.
--
-- These UUIDs are accounting identity, not a live account/profile relation.
-- Removing the two FKs neither recreates auth/profile rows nor retains display
-- PII. Existing RLS remains unchanged and a deleted UUID cannot authenticate.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

LOCK TABLE
  public.tips,
  public.stripe_entitlement_payments,
  public.stripe_payment_ownerships
IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_relation pg_catalog.regclass;
  v_column name;
  v_expected_target pg_catalog.regclass;
  v_expected_delete_action "char";
  v_attribute_number smallint;
BEGIN
  IF pg_catalog.to_regclass('auth.users') IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.tips') IS NULL
    OR pg_catalog.to_regclass(
      'public.stripe_entitlement_payments'
    ) IS NULL
    OR pg_catalog.to_regclass(
      'public.stripe_payment_ownerships'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.stripe_payment_ownership_is_exact_v2(uuid)'
    ) IS NULL
  THEN
    RAISE EXCEPTION
      'financial-subject retention prerequisites are missing';
  END IF;

  FOR v_relation, v_column, v_expected_target, v_expected_delete_action IN
    SELECT *
    FROM (
      VALUES
        (
          'public.tips'::pg_catalog.regclass,
          'from_user_id'::name,
          'auth.users'::pg_catalog.regclass,
          'c'::"char"
        ),
        (
          'public.stripe_entitlement_payments'::pg_catalog.regclass,
          'user_id'::name,
          'public.user_profiles'::pg_catalog.regclass,
          'n'::"char"
        )
    ) AS required_subject(
      relation_oid,
      column_name,
      expected_target,
      expected_delete_action
    )
  LOOP
    SELECT attribute.attnum
    INTO v_attribute_number
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attname = v_column
      AND attribute.atttypid = 'pg_catalog.uuid'::pg_catalog.regtype
      AND attribute.atttypmod = -1
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF v_attribute_number IS NULL THEN
      RAISE EXCEPTION
        'financial-subject UUID column is missing: %.%',
        v_relation,
        v_column;
    END IF;

    IF v_relation = 'public.tips'::pg_catalog.regclass
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_relation
          AND attribute.attnum = v_attribute_number
          AND attribute.attnotnull
      )
    THEN
      RAISE EXCEPTION 'tips.from_user_id must remain NOT NULL';
    END IF;

    -- Accept either the exact historical FK or no FK (safe replay). Reject a
    -- renamed/multi-column/wrong-action relation instead of dropping a
    -- constraint whose semantics were not reviewed.
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_relation
        AND constraint_row.contype = 'f'
        AND v_attribute_number = ANY (constraint_row.conkey)
        AND (
          constraint_row.conkey
            IS DISTINCT FROM ARRAY[v_attribute_number]::smallint[]
          OR constraint_row.confkey IS DISTINCT FROM ARRAY[
            (
              SELECT target_attribute.attnum
              FROM pg_catalog.pg_attribute AS target_attribute
              WHERE target_attribute.attrelid = v_expected_target
                AND target_attribute.attname = 'id'
                AND target_attribute.attnum > 0
                AND NOT target_attribute.attisdropped
            )
          ]::smallint[]
          OR constraint_row.confrelid IS DISTINCT FROM v_expected_target
          OR constraint_row.confdeltype
            IS DISTINCT FROM v_expected_delete_action
          OR NOT constraint_row.convalidated
        )
    ) THEN
      RAISE EXCEPTION
        'financial-subject FK drifted: %.%',
        v_relation,
        v_column;
    END IF;
  END LOOP;

  IF pg_catalog.to_regrole('postgres') IS NULL THEN
    RAISE EXCEPTION 'postgres role is missing';
  END IF;
END
$preflight$;

-- Drop every validated instance of the two reviewed FKs, including an
-- otherwise exact constraint that was renamed by a schema tool.
DO $drop_subject_fks$
DECLARE
  v_constraint record;
BEGIN
  FOR v_constraint IN
    SELECT
      constraint_row.conrelid::pg_catalog.regclass AS relation_oid,
      constraint_row.conname
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = constraint_row.conrelid
      AND attribute.attnum = constraint_row.conkey[1]
    WHERE constraint_row.contype = 'f'
      AND pg_catalog.cardinality(constraint_row.conkey) = 1
      AND (
        (
          constraint_row.conrelid =
            'public.tips'::pg_catalog.regclass
          AND attribute.attname = 'from_user_id'
        )
        OR (
          constraint_row.conrelid =
            'public.stripe_entitlement_payments'::pg_catalog.regclass
          AND attribute.attname = 'user_id'
        )
      )
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE %s DROP CONSTRAINT %I',
      v_constraint.relation_oid,
      v_constraint.conname
    );
  END LOOP;
END
$drop_subject_fks$;

-- Repair the precise historical SET NULL damage when the immutable ownership
-- row proves every other payment field. Rows with no exact proof remain NULL
-- and continue to fail launch readiness; this migration never guesses a user.
UPDATE public.stripe_entitlement_payments AS payment
SET user_id = ownership.owner_user_id,
    updated_at = pg_catalog.clock_timestamp()
FROM public.stripe_payment_ownerships AS ownership
WHERE payment.user_id IS NULL
  AND ownership.product_kind = 'pro_entitlement'
  AND ownership.ledger_id = payment.id
  AND ownership.owner_user_id IS NOT NULL
  AND payment.payment_status IN ('paid', 'succeeded')
  AND payment.stripe_customer_id = ownership.stripe_customer_id
  AND payment.stripe_payment_intent_id
    IS NOT DISTINCT FROM ownership.stripe_payment_intent_id
  AND payment.stripe_charge_id = ownership.stripe_charge_id
  AND payment.checkout_session_id
    IS NOT DISTINCT FROM ownership.checkout_session_id
  AND payment.amount_paid = ownership.amount_paid
  AND payment.currency = ownership.currency;

CREATE OR REPLACE FUNCTION
  public.prevent_tip_financial_owner_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.from_user_id IS DISTINCT FROM OLD.from_user_id THEN
    RAISE EXCEPTION 'Tip financial owner is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.prevent_tip_financial_owner_mutation()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prevent_tip_financial_owner_mutation()
  FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_tips_financial_owner_immutable
  ON public.tips;
CREATE TRIGGER trg_tips_financial_owner_immutable
  BEFORE UPDATE OF from_user_id ON public.tips
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_tip_financial_owner_mutation();

CREATE OR REPLACE FUNCTION
  public.prevent_entitlement_financial_owner_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id THEN
    RAISE EXCEPTION 'Stripe entitlement financial owner is immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.prevent_entitlement_financial_owner_mutation()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.prevent_entitlement_financial_owner_mutation()
FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_stripe_entitlement_financial_owner_immutable
  ON public.stripe_entitlement_payments;
CREATE TRIGGER trg_stripe_entitlement_financial_owner_immutable
  BEFORE UPDATE OF user_id ON public.stripe_entitlement_payments
  FOR EACH ROW
  EXECUTE FUNCTION
    public.prevent_entitlement_financial_owner_mutation();

DO $postflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_function pg_catalog.regprocedure;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = constraint_row.conrelid
      AND attribute.attnum = ANY (constraint_row.conkey)
    WHERE constraint_row.contype = 'f'
      AND (
        (
          constraint_row.conrelid =
            'public.tips'::pg_catalog.regclass
          AND attribute.attname = 'from_user_id'
        )
        OR (
          constraint_row.conrelid =
            'public.stripe_entitlement_payments'::pg_catalog.regclass
          AND attribute.attname = 'user_id'
        )
      )
  ) THEN
    RAISE EXCEPTION
      'financial-subject profile/auth FK was not removed';
  END IF;

  -- An immutable ownership row without its product ledger is pre-existing,
  -- unrecoverable data loss. Fail the release loudly rather than reporting a
  -- false-green refund authority after the forward-protection cutover.
  IF EXISTS (
    SELECT 1
    FROM public.stripe_payment_ownerships AS ownership
    WHERE ownership.product_kind IN ('pro_entitlement', 'tip')
      AND NOT public.stripe_payment_ownership_is_exact_v2(ownership.id)
  ) THEN
    RAISE EXCEPTION
      'historical Stripe payment ownership requires recovery or review';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.prevent_tip_financial_owner_mutation()'::pg_catalog.regprocedure,
    'public.prevent_entitlement_financial_owner_mutation()'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND function_row.proowner = v_postgres
        AND function_row.prosecdef
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
        WHERE function_row.oid = v_function
          AND acl_row.grantee = 0
          AND acl_row.privilege_type = 'EXECUTE'
      )
    THEN
      RAISE EXCEPTION
        'financial-subject immutability function owner or ACL drifted';
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.tips'::pg_catalog.regclass
      AND trigger_row.tgname =
        'trg_tips_financial_owner_immutable'
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid =
          'public.stripe_entitlement_payments'::pg_catalog.regclass
        AND trigger_row.tgname =
          'trg_stripe_entitlement_financial_owner_immutable'
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
    )
  THEN
    RAISE EXCEPTION
      'financial-subject immutability trigger is missing';
  END IF;
END
$postflight$;

COMMIT;
