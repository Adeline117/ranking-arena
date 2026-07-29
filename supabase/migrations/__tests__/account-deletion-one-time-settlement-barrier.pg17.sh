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
  checkout_session_id text UNIQUE,
  amount_paid bigint NOT NULL,
  refund_succeeded_amount bigint NOT NULL DEFAULT 0,
  refund_state text NOT NULL DEFAULT 'none'
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
  checkout_session_id text UNIQUE
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
  user_id,
  stripe_customer_id,
  payment_kind,
  checkout_session_id,
  amount_paid,
  refund_succeeded_amount,
  refund_state
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'cus_lifetime',
  'lifetime',
  'cs_lifetime_delayed',
  4999,
  0,
  'none'
);
SET ROLE service_role;

DO $delayed_webhook_converges$
DECLARE
  v_sync jsonb;
  v_ready jsonb;
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
  checkout_session_id
) VALUES
  (
    'tip',
    '44444444-4444-4444-8444-444444444441',
    '44444444-4444-4444-8444-444444444444',
    'cus_missing_ledger',
    'cs_tip_missing_child'
  ),
  (
    'group_pass',
    '44444444-4444-4444-8444-444444444442',
    '44444444-4444-4444-8444-444444444444',
    'cus_missing_ledger',
    'cs_group_missing_child'
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
