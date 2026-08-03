#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729022000_account_deletion_one_time_settlement_barrier.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/account-deletion-one-time-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55522
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN BYPASSRLS;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT pg_catalog.current_setting('request.jwt.claim.role', true)
$function$;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  stripe_customer_id text,
  deleted_at timestamptz,
  deletion_scheduled_at timestamptz
);
CREATE TABLE public.stripe_manual_reviews (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  object_type text NOT NULL,
  object_id text NOT NULL,
  user_id uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  action text NOT NULL,
  reason_key text NOT NULL,
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'open',
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  resolved_at timestamptz,
  UNIQUE (object_type, object_id, reason_key)
);
CREATE TABLE public.stripe_entitlement_payments (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid,
  stripe_customer_id text NOT NULL,
  payment_kind text NOT NULL,
  stripe_payment_intent_id text,
  stripe_charge_id text NOT NULL UNIQUE,
  checkout_session_id text UNIQUE,
  amount_paid bigint NOT NULL,
  currency text NOT NULL,
  payment_status text NOT NULL,
  refund_succeeded_amount bigint NOT NULL DEFAULT 0,
  refund_state text NOT NULL DEFAULT 'none',
  CONSTRAINT stripe_entitlement_payments_status_check
    CHECK (payment_status IN ('paid', 'succeeded', 'ownership_conflict'))
);
CREATE TABLE public.stripe_lifetime_seat_reservations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  status text NOT NULL
);
CREATE TABLE public.tips (
  id uuid PRIMARY KEY,
  from_user_id uuid NOT NULL,
  to_user_id uuid,
  checkout_to_user_id uuid,
  status text NOT NULL
);
CREATE TABLE public.stripe_payment_ownerships (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  product_kind text NOT NULL,
  ledger_id uuid NOT NULL,
  owner_user_id uuid,
  stripe_customer_id text NOT NULL,
  stripe_payment_intent_id text,
  stripe_charge_id text NOT NULL UNIQUE,
  checkout_session_id text UNIQUE,
  amount_paid bigint NOT NULL,
  currency text NOT NULL,
  CONSTRAINT stripe_payment_ownerships_kind_ledger_key
    UNIQUE (product_kind, ledger_id)
);
CREATE TABLE public.group_payment_consumptions (
  id uuid PRIMARY KEY,
  checkout_session_id text,
  user_id uuid NOT NULL,
  outcome text NOT NULL
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.stripe_manual_reviews OWNER TO postgres;
ALTER TABLE public.stripe_entitlement_payments OWNER TO postgres;
ALTER TABLE public.stripe_lifetime_seat_reservations OWNER TO postgres;
ALTER TABLE public.tips OWNER TO postgres;
ALTER TABLE public.stripe_payment_ownerships OWNER TO postgres;
ALTER TABLE public.group_payment_consumptions OWNER TO postgres;
GRANT SELECT ON TABLE
  public.stripe_entitlement_payments,
  public.stripe_manual_reviews,
  public.stripe_payment_ownerships
TO service_role;

CREATE FUNCTION public.stripe_payment_ownership_is_exact_v2(
  p_ownership_id uuid
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
      FROM public.stripe_payment_ownerships AS ownership
      WHERE ownership.id = p_ownership_id
        AND ownership.product_kind = 'pro_entitlement'
        AND EXISTS (
          SELECT 1
          FROM public.stripe_entitlement_payments AS payment
          WHERE payment.id = ownership.ledger_id
            AND payment.payment_status IN ('paid', 'succeeded')
            AND payment.user_id
              IS NOT DISTINCT FROM ownership.owner_user_id
            AND payment.stripe_customer_id = ownership.stripe_customer_id
            AND payment.stripe_payment_intent_id
              IS NOT DISTINCT FROM ownership.stripe_payment_intent_id
            AND payment.stripe_charge_id = ownership.stripe_charge_id
            AND payment.checkout_session_id
              IS NOT DISTINCT FROM ownership.checkout_session_id
            AND payment.amount_paid = ownership.amount_paid
            AND payment.currency = ownership.currency
        )
    )
$function$;
ALTER FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
SET request.jwt.claim.role = 'service_role';

INSERT INTO public.user_profiles (
  id,
  stripe_customer_id,
  deleted_at,
  deletion_scheduled_at
) VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'cus_lifetime',
    pg_catalog.clock_timestamp() - interval '31 days',
    pg_catalog.clock_timestamp() - interval '1 day'
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'cus_unknown',
    pg_catalog.clock_timestamp() - interval '31 days',
    pg_catalog.clock_timestamp() - interval '1 day'
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'cus_expired',
    pg_catalog.clock_timestamp() - interval '31 days',
    pg_catalog.clock_timestamp() - interval '1 day'
  ),
  (
    '44444444-4444-4444-8444-444444444444',
    'cus_missing_ledger',
    pg_catalog.clock_timestamp() - interval '31 days',
    pg_catalog.clock_timestamp() - interval '1 day'
  ),
  (
    '55555555-5555-4555-8555-555555555555',
    'cus_lifetime_conflict',
    pg_catalog.clock_timestamp() - interval '31 days',
    pg_catalog.clock_timestamp() - interval '1 day'
  ),
  (
    '66666666-6666-4666-8666-666666666666',
    'cus_lifetime_missing',
    pg_catalog.clock_timestamp() - interval '31 days',
    pg_catalog.clock_timestamp() - interval '1 day'
  ),
  (
    '77777777-7777-4777-8777-777777777777',
    'cus_lifetime_duplicate',
    pg_catalog.clock_timestamp() - interval '31 days',
    pg_catalog.clock_timestamp() - interval '1 day'
  ),
  (
    '88888888-8888-4888-8888-888888888888',
    'cus_lifetime_nonexact',
    pg_catalog.clock_timestamp() - interval '31 days',
    pg_catalog.clock_timestamp() - interval '1 day'
  ),
  (
    '99999999-9999-4999-8999-999999999999',
    'cus_lifetime_refunded',
    pg_catalog.clock_timestamp() - interval '31 days',
    pg_catalog.clock_timestamp() - interval '1 day'
  );

SET ROLE service_role;

DO $delayed_webhook_stays_pending$
DECLARE
  v_sync jsonb;
  v_ready jsonb;
BEGIN
  v_sync := public.sync_account_deletion_one_time_settlements(
    '11111111-1111-4111-8111-111111111111',
    'cus_lifetime',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '[{
      "checkout_session_id":"cs_lifetime_delayed",
      "livemode":true,
      "stripe_customer_id":"cus_lifetime",
      "product_kind":"lifetime",
      "stripe_status":"complete",
      "payment_status":"paid",
      "ownership_status":"exact"
    }]'::jsonb
  );
  IF v_sync ->> 'status' IS DISTINCT FROM 'synced'
    OR v_sync -> 'pending_session_ids'
      IS DISTINCT FROM '["cs_lifetime_delayed"]'::jsonb
  THEN
    RAISE EXCEPTION 'delayed lifetime fulfillment was not held pending: %', v_sync;
  END IF;

  v_ready := public.check_account_deletion_one_time_settlements_ready(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  IF v_ready ->> 'status' IS DISTINCT FROM 'pending'
    OR (v_ready ->> 'ready')::boolean
  THEN
    RAISE EXCEPTION 'hard deletion ignored delayed fulfillment: %', v_ready;
  END IF;
END
$delayed_webhook_stays_pending$;

-- Model a signed fulfillment arriving more than one day after the first scan.
RESET ROLE;
INSERT INTO public.stripe_entitlement_payments (
  id,
  user_id,
  stripe_customer_id,
  payment_kind,
  stripe_payment_intent_id,
  stripe_charge_id,
  checkout_session_id,
  amount_paid,
  currency,
  payment_status,
  refund_succeeded_amount,
  refund_state
) VALUES (
  '11111111-1111-4111-8111-111111111119',
  '11111111-1111-4111-8111-111111111111',
  'cus_lifetime',
  'lifetime',
  'pi_lifetime_delayed',
  'ch_lifetime_delayed',
  'cs_lifetime_delayed',
  4999,
  'usd',
  'paid',
  0,
  'none'
);
INSERT INTO public.stripe_payment_ownerships (
  id,
  product_kind,
  ledger_id,
  owner_user_id,
  stripe_customer_id,
  stripe_payment_intent_id,
  stripe_charge_id,
  checkout_session_id,
  amount_paid,
  currency
) VALUES (
  '11111111-1111-4111-8111-111111111118',
  'pro_entitlement',
  '11111111-1111-4111-8111-111111111119',
  '11111111-1111-4111-8111-111111111111',
  'cus_lifetime',
  'pi_lifetime_delayed',
  'ch_lifetime_delayed',
  'cs_lifetime_delayed',
  4999,
  'usd'
);
SET ROLE service_role;

DO $delayed_webhook_converges$
DECLARE
  v_sync jsonb;
  v_ready jsonb;
  v_status text;
BEGIN
  v_sync := public.sync_account_deletion_one_time_settlements(
    '11111111-1111-4111-8111-111111111111',
    'cus_lifetime',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '[{
      "checkout_session_id":"cs_lifetime_delayed",
      "livemode":true,
      "stripe_customer_id":"cus_lifetime",
      "product_kind":"lifetime",
      "stripe_status":"complete",
      "payment_status":"paid",
      "ownership_status":"exact"
    }]'::jsonb
  );
  IF v_sync -> 'terminal_session_ids'
    IS DISTINCT FROM '["cs_lifetime_delayed"]'::jsonb
  THEN
    RAISE EXCEPTION 'late fulfillment did not converge: %', v_sync;
  END IF;

  SELECT settlement.settlement_status
  INTO v_status
  FROM public.account_deletion_one_time_settlements AS settlement
  WHERE settlement.user_id = '11111111-1111-4111-8111-111111111111'
    AND settlement.checkout_session_id = 'cs_lifetime_delayed';
  IF v_status IS DISTINCT FROM 'fulfilled' THEN
    RAISE EXCEPTION 'exact lifetime ownership was not fulfilled: %', v_status;
  END IF;

  v_ready := public.check_account_deletion_one_time_settlements_ready(
    '11111111-1111-4111-8111-111111111111',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  );
  IF v_ready ->> 'status' IS DISTINCT FROM 'ready'
    OR NOT (v_ready ->> 'ready')::boolean
  THEN
    RAISE EXCEPTION 'converged fulfillment remained blocked: %', v_ready;
  END IF;
END
$delayed_webhook_converges$;

RESET ROLE;
INSERT INTO public.stripe_entitlement_payments (
  id,
  user_id,
  stripe_customer_id,
  payment_kind,
  stripe_payment_intent_id,
  stripe_charge_id,
  checkout_session_id,
  amount_paid,
  currency,
  payment_status,
  refund_succeeded_amount,
  refund_state
) VALUES
  (
    '55555555-5555-4555-8555-555555555551',
    '55555555-5555-4555-8555-555555555555',
    'cus_lifetime_conflict',
    'lifetime',
    'pi_lifetime_conflict',
    'ch_lifetime_conflict',
    'cs_lifetime_conflict',
    4999,
    'usd',
    'ownership_conflict',
    0,
    'none'
  ),
  (
    '66666666-6666-4666-8666-666666666661',
    '66666666-6666-4666-8666-666666666666',
    'cus_lifetime_missing',
    'lifetime',
    'pi_lifetime_missing',
    'ch_lifetime_missing',
    'cs_lifetime_missing',
    4999,
    'usd',
    'paid',
    0,
    'none'
  ),
  (
    '77777777-7777-4777-8777-777777777771',
    '77777777-7777-4777-8777-777777777777',
    'cus_lifetime_duplicate',
    'lifetime',
    'pi_lifetime_duplicate',
    'ch_lifetime_duplicate',
    'cs_lifetime_duplicate',
    4999,
    'usd',
    'succeeded',
    0,
    'none'
  ),
  (
    '88888888-8888-4888-8888-888888888881',
    '88888888-8888-4888-8888-888888888888',
    'cus_lifetime_nonexact',
    'lifetime',
    'pi_lifetime_nonexact',
    'ch_lifetime_nonexact',
    'cs_lifetime_nonexact',
    4999,
    'usd',
    'paid',
    0,
    'none'
  ),
  (
    '99999999-9999-4999-8999-999999999991',
    '99999999-9999-4999-8999-999999999999',
    'cus_lifetime_refunded',
    'lifetime',
    'pi_lifetime_refunded',
    'ch_lifetime_refunded',
    'cs_lifetime_refunded',
    4999,
    'usd',
    'ownership_conflict',
    4999,
    'succeeded'
  );

INSERT INTO public.stripe_payment_ownerships (
  id,
  product_kind,
  ledger_id,
  owner_user_id,
  stripe_customer_id,
  stripe_payment_intent_id,
  stripe_charge_id,
  checkout_session_id,
  amount_paid,
  currency
) VALUES
  (
    '55555555-5555-4555-8555-555555555552',
    'pro_entitlement',
    '55555555-5555-4555-8555-555555555551',
    '55555555-5555-4555-8555-555555555555',
    'cus_lifetime_conflict',
    'pi_lifetime_conflict',
    'ch_lifetime_conflict',
    'cs_lifetime_conflict',
    4999,
    'usd'
  ),
  (
    '77777777-7777-4777-8777-777777777772',
    'pro_entitlement',
    '77777777-7777-4777-8777-777777777771',
    '77777777-7777-4777-8777-777777777777',
    'cus_lifetime_duplicate',
    'pi_lifetime_duplicate',
    'ch_lifetime_duplicate',
    'cs_lifetime_duplicate',
    4999,
    'usd'
  ),
  (
    '88888888-8888-4888-8888-888888888882',
    'pro_entitlement',
    '88888888-8888-4888-8888-888888888881',
    '88888888-8888-4888-8888-888888888888',
    'cus_lifetime_nonexact',
    'pi_lifetime_nonexact',
    'ch_lifetime_nonexact',
    'cs_lifetime_nonexact',
    4998,
    'usd'
  );

-- The production schema prevents this corruption. Drop only the exact
-- kind/ledger uniqueness in the adversarial fixture to prove that the delete
-- barrier itself still refuses two central ownership claims instead of
-- trusting whichever row an unordered SELECT happens to return.
ALTER TABLE public.stripe_payment_ownerships
  DROP CONSTRAINT stripe_payment_ownerships_kind_ledger_key;
INSERT INTO public.stripe_payment_ownerships (
  id,
  product_kind,
  ledger_id,
  owner_user_id,
  stripe_customer_id,
  stripe_payment_intent_id,
  stripe_charge_id,
  checkout_session_id,
  amount_paid,
  currency
) VALUES (
  '77777777-7777-4777-8777-777777777773',
  'pro_entitlement',
  '77777777-7777-4777-8777-777777777771',
  '77777777-7777-4777-8777-777777777777',
  'cus_lifetime_duplicate',
  'pi_lifetime_duplicate_shadow',
  'ch_lifetime_duplicate_shadow',
  'cs_lifetime_duplicate_shadow',
  4999,
  'usd'
);
SET ROLE service_role;

DO $lifetime_conflict_missing_duplicate_nonexact_reviewed$
DECLARE
  v_case record;
  v_sync jsonb;
  v_ready jsonb;
  v_settlement_status text;
  v_reason_key text;
  v_metadata jsonb;
BEGIN
  FOR v_case IN
    SELECT *
    FROM (
      VALUES
        (
          '55555555-5555-4555-8555-555555555555'::uuid,
          'cus_lifetime_conflict'::text,
          'cs_lifetime_conflict'::text,
          'aaaaaaaa-5555-4555-8555-aaaaaaaaaaaa'::uuid,
          'account_deletion_one_time:lifetime_payment_status_conflict'::text,
          'ownership_conflict'::text,
          NULL::integer
        ),
        (
          '66666666-6666-4666-8666-666666666666'::uuid,
          'cus_lifetime_missing'::text,
          'cs_lifetime_missing'::text,
          'aaaaaaaa-6666-4666-8666-aaaaaaaaaaaa'::uuid,
          'account_deletion_one_time:lifetime_ownership_cardinality'::text,
          'paid'::text,
          0::integer
        ),
        (
          '77777777-7777-4777-8777-777777777777'::uuid,
          'cus_lifetime_duplicate'::text,
          'cs_lifetime_duplicate'::text,
          'aaaaaaaa-7777-4777-8777-aaaaaaaaaaaa'::uuid,
          'account_deletion_one_time:lifetime_ownership_cardinality'::text,
          'succeeded'::text,
          2::integer
        ),
        (
          '88888888-8888-4888-8888-888888888888'::uuid,
          'cus_lifetime_nonexact'::text,
          'cs_lifetime_nonexact'::text,
          'aaaaaaaa-8888-4888-8888-aaaaaaaaaaaa'::uuid,
          'account_deletion_one_time:lifetime_ownership_not_exact'::text,
          'paid'::text,
          1::integer
        )
    ) AS fixture(
      user_id,
      customer_id,
      session_id,
      scan_token,
      expected_reason_key,
      expected_payment_status,
      expected_ownership_count
    )
  LOOP
    v_sync := public.sync_account_deletion_one_time_settlements(
      v_case.user_id,
      v_case.customer_id,
      v_case.scan_token,
      pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'checkout_session_id', v_case.session_id,
          'livemode', true,
          'stripe_customer_id', v_case.customer_id,
          'product_kind', 'lifetime',
          'stripe_status', 'complete',
          'payment_status', 'paid',
          'ownership_status', 'exact'
        )
      )
    );

    SELECT
      settlement.settlement_status,
      review.reason_key,
      review.metadata
    INTO
      v_settlement_status,
      v_reason_key,
      v_metadata
    FROM public.account_deletion_one_time_settlements AS settlement
    JOIN public.stripe_manual_reviews AS review
      ON review.id = settlement.manual_review_id
    WHERE settlement.user_id = v_case.user_id
      AND settlement.checkout_session_id = v_case.session_id;

    IF v_sync -> 'terminal_session_ids'
        IS DISTINCT FROM pg_catalog.jsonb_build_array(v_case.session_id)
      OR v_settlement_status IS DISTINCT FROM 'terminal_manual_review'
      OR v_reason_key IS DISTINCT FROM v_case.expected_reason_key
      OR v_metadata ->> 'deletion_user_id'
        IS DISTINCT FROM v_case.user_id::text
      OR v_metadata ->> 'checkout_session_id'
        IS DISTINCT FROM v_case.session_id
      OR v_metadata ->> 'entitlement_payment_status'
        IS DISTINCT FROM v_case.expected_payment_status
      OR (
        v_case.expected_ownership_count IS NOT NULL
        AND (v_metadata ->> 'lifetime_ownership_count')::integer
          IS DISTINCT FROM v_case.expected_ownership_count
      )
    THEN
      RAISE EXCEPTION
        'lifetime authority anomaly was not durably reviewed: %, %, %, %',
        v_case.session_id,
        v_sync,
        v_reason_key,
        v_metadata;
    END IF;

    v_ready := public.check_account_deletion_one_time_settlements_ready(
      v_case.user_id,
      v_case.scan_token
    );
    IF v_ready ->> 'status' IS DISTINCT FROM 'ready'
      OR NOT (v_ready ->> 'ready')::boolean
    THEN
      RAISE EXCEPTION
        'durably reviewed lifetime anomaly was not terminal: %, %',
        v_case.session_id,
        v_ready;
    END IF;
  END LOOP;
END
$lifetime_conflict_missing_duplicate_nonexact_reviewed$;

DO $fully_refunded_lifetime_remains_terminal$
DECLARE
  v_sync jsonb;
  v_ready jsonb;
  v_status text;
BEGIN
  v_sync := public.sync_account_deletion_one_time_settlements(
    '99999999-9999-4999-8999-999999999999',
    'cus_lifetime_refunded',
    'aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa',
    '[{
      "checkout_session_id":"cs_lifetime_refunded",
      "livemode":true,
      "stripe_customer_id":"cus_lifetime_refunded",
      "product_kind":"lifetime",
      "stripe_status":"complete",
      "payment_status":"paid",
      "ownership_status":"exact"
    }]'::jsonb
  );
  SELECT settlement.settlement_status
  INTO v_status
  FROM public.account_deletion_one_time_settlements AS settlement
  WHERE settlement.user_id = '99999999-9999-4999-8999-999999999999'
    AND settlement.checkout_session_id = 'cs_lifetime_refunded';

  IF v_sync -> 'terminal_session_ids'
      IS DISTINCT FROM '["cs_lifetime_refunded"]'::jsonb
    OR v_status IS DISTINCT FROM 'refunded'
  THEN
    RAISE EXCEPTION 'full lifetime refund lost terminal semantics: %, %',
      v_sync,
      v_status;
  END IF;

  v_ready := public.check_account_deletion_one_time_settlements_ready(
    '99999999-9999-4999-8999-999999999999',
    'aaaaaaaa-9999-4999-8999-aaaaaaaaaaaa'
  );
  IF v_ready ->> 'status' IS DISTINCT FROM 'ready'
    OR NOT (v_ready ->> 'ready')::boolean
  THEN
    RAISE EXCEPTION 'full lifetime refund remained blocked: %', v_ready;
  END IF;
END
$fully_refunded_lifetime_remains_terminal$;

RESET ROLE;
DELETE FROM public.user_profiles
WHERE id = '55555555-5555-4555-8555-555555555555';

DO $manual_review_evidence_survives_hard_delete$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.account_deletion_one_time_settlements AS settlement
    JOIN public.stripe_manual_reviews AS review
      ON review.id = settlement.manual_review_id
    JOIN public.stripe_entitlement_payments AS payment
      ON payment.id = (review.metadata ->> 'entitlement_payment_id')::uuid
    JOIN public.stripe_payment_ownerships AS ownership
      ON ownership.product_kind = 'pro_entitlement'
      AND ownership.ledger_id = payment.id
    WHERE settlement.user_id = '55555555-5555-4555-8555-555555555555'
      AND settlement.checkout_session_id = 'cs_lifetime_conflict'
      AND settlement.settlement_status = 'terminal_manual_review'
      AND review.user_id IS NULL
      AND review.metadata ->> 'deletion_user_id' =
        '55555555-5555-4555-8555-555555555555'
      AND review.metadata ->> 'entitlement_payment_status' =
        'ownership_conflict'
      AND payment.payment_status = 'ownership_conflict'
      AND ownership.owner_user_id =
        '55555555-5555-4555-8555-555555555555'
  ) THEN
    RAISE EXCEPTION
      'manual review or immutable financial evidence was lost after hard delete';
  END IF;
END
$manual_review_evidence_survives_hard_delete$;
SET ROLE service_role;

DO $unknown_product_is_durably_reviewed$
DECLARE
  v_sync jsonb;
  v_ready jsonb;
BEGIN
  v_sync := public.sync_account_deletion_one_time_settlements(
    '22222222-2222-4222-8222-222222222222',
    'cus_unknown',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '[{
      "checkout_session_id":"cs_unknown_paid",
      "livemode":true,
      "stripe_customer_id":"cus_unknown",
      "product_kind":"unknown",
      "stripe_status":"complete",
      "payment_status":"paid",
      "ownership_status":"mismatch"
    }]'::jsonb
  );
  IF v_sync -> 'terminal_session_ids'
    IS DISTINCT FROM '["cs_unknown_paid"]'::jsonb
  THEN
    RAISE EXCEPTION 'unknown paid Checkout lacked retained review: %', v_sync;
  END IF;

  v_ready := public.check_account_deletion_one_time_settlements_ready(
    '22222222-2222-4222-8222-222222222222',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  );
  IF v_ready ->> 'status' IS DISTINCT FROM 'ready' THEN
    RAISE EXCEPTION 'terminal manual review was not recognized: %', v_ready;
  END IF;
END
$unknown_product_is_durably_reviewed$;

RESET ROLE;
DO $unknown_product_review_row_is_retained$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.stripe_manual_reviews AS review
    WHERE review.object_type = 'account_deletion_checkout'
      AND review.object_id = 'cs_unknown_paid'
      AND review.state = 'open'
  ) THEN
    RAISE EXCEPTION 'unknown paid Checkout review row was not retained';
  END IF;
END
$unknown_product_review_row_is_retained$;

INSERT INTO public.stripe_payment_ownerships (
  product_kind,
  ledger_id,
  owner_user_id,
  stripe_customer_id,
  stripe_charge_id,
  checkout_session_id,
  amount_paid,
  currency
) VALUES
  (
    'tip',
    '44444444-4444-4444-8444-444444444441',
    '44444444-4444-4444-8444-444444444444',
    'cus_missing_ledger',
    'ch_tip_missing_child',
    'cs_tip_missing_child',
    100,
    'usd'
  ),
  (
    'group_pass',
    '44444444-4444-4444-8444-444444444442',
    '44444444-4444-4444-8444-444444444444',
    'cus_missing_ledger',
    'ch_group_missing_child',
    'cs_group_missing_child',
    100,
    'usd'
  );
SET ROLE service_role;

DO $missing_child_ledgers_are_not_fulfilled$
DECLARE
  v_sync jsonb;
BEGIN
  v_sync := public.sync_account_deletion_one_time_settlements(
    '44444444-4444-4444-8444-444444444444',
    'cus_missing_ledger',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    '[{
      "checkout_session_id":"cs_group_missing_child",
      "livemode":true,
      "stripe_customer_id":"cus_missing_ledger",
      "product_kind":"group_pass",
      "stripe_status":"complete",
      "payment_status":"paid",
      "ownership_status":"exact"
    },{
      "checkout_session_id":"cs_tip_missing_child",
      "livemode":true,
      "stripe_customer_id":"cus_missing_ledger",
      "product_kind":"tip",
      "stripe_status":"complete",
      "payment_status":"paid",
      "ownership_status":"exact"
    }]'::jsonb
  );

  IF v_sync -> 'terminal_session_ids'
    IS DISTINCT FROM '["cs_group_missing_child", "cs_tip_missing_child"]'::jsonb
    OR EXISTS (
      SELECT 1
      FROM public.account_deletion_one_time_settlements AS settlement
      WHERE settlement.user_id = '44444444-4444-4444-8444-444444444444'
        AND settlement.settlement_status IS DISTINCT FROM 'terminal_manual_review'
    )
  THEN
    RAISE EXCEPTION 'missing child ledger was falsely accepted as fulfilled: %', v_sync;
  END IF;
END
$missing_child_ledgers_are_not_fulfilled$;

RESET ROLE;
INSERT INTO public.stripe_lifetime_seat_reservations (user_id, status)
VALUES ('33333333-3333-4333-8333-333333333333', 'bound');
SET ROLE service_role;

DO $expired_checkout_waits_for_local_lifecycle$
DECLARE
  v_ready jsonb;
BEGIN
  PERFORM public.sync_account_deletion_one_time_settlements(
    '33333333-3333-4333-8333-333333333333',
    'cus_expired',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    '[{
      "checkout_session_id":"cs_expired_exact",
      "livemode":true,
      "stripe_customer_id":"cus_expired",
      "product_kind":"lifetime",
      "stripe_status":"expired",
      "payment_status":"unpaid",
      "ownership_status":"exact"
    }]'::jsonb
  );
  v_ready := public.check_account_deletion_one_time_settlements_ready(
    '33333333-3333-4333-8333-333333333333',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  );
  IF v_ready ->> 'status' IS DISTINCT FROM 'pending'
    OR (v_ready ->> 'pending_lifetime_reservations')::integer <> 1
  THEN
    RAISE EXCEPTION 'bound reservation was not retained: %', v_ready;
  END IF;
END
$expired_checkout_waits_for_local_lifecycle$;
SQL

echo "Account deletion one-time settlement PostgreSQL 17 proof passed"
