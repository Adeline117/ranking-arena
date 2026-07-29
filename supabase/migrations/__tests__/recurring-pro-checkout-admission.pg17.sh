#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for ordinary Pro Checkout admission,
# concurrency, exact replay, signed completion/expiry ordering, and ACLs.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729025000_recurring_pro_checkout_admission.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/recurring-pro-checkout-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="$(( 55000 + RANDOM % 5000 ))"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    [[ -f "$LOG_FILE" ]] && tail -240 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

service_query() {
  local sql="$1"
  psql_cmd -qAtc "
    SET ROLE service_role;
    SET request.jwt.claim.role = 'service_role';
    $sql
    RESET ROLE;
  "
}

expect_value() {
  local label="$1"
  local expected="$2"
  local sql="$3"
  local actual
  actual="$(service_query "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label drifted: expected '$expected', got '$actual'" >&2
    return 1
  fi
}

expect_failure() {
  local label="$1"
  local sql="$2"
  local expected_state="${3:-}"
  local output="$TMP_ROOT/expected-failure.out"
  if service_query "$sql" >"$output" 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
  if [[ -n "$expected_state" ]] && ! grep -Fq "$expected_state" "$output"; then
    echo "$label did not report SQLSTATE $expected_state" >&2
    sed -n '1,120p' "$output" >&2
    return 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOINHERIT;
CREATE ROLE hostile_role NOLOGIN;

GRANT service_role TO authenticator
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role, authenticator, hostile_role;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT pg_catalog.current_setting('request.jwt.claim.role', true)
$function$;
ALTER FUNCTION auth.role() OWNER TO postgres;
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO service_role;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  stripe_customer_id text,
  deleted_at timestamptz
);
ALTER TABLE public.user_profiles OWNER TO postgres;

CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  stripe_customer_id text,
  stripe_subscription_id text,
  tier text NOT NULL DEFAULT 'free',
  status text NOT NULL DEFAULT 'canceled'
);
ALTER TABLE public.subscriptions OWNER TO postgres;

CREATE TABLE public.stripe_manual_reviews (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  object_type text NOT NULL,
  object_id text NOT NULL,
  user_id uuid,
  reason_key text NOT NULL,
  reason text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (object_type, object_id, reason_key)
);
ALTER TABLE public.stripe_manual_reviews OWNER TO postgres;
GRANT SELECT ON public.stripe_manual_reviews TO service_role;

CREATE FUNCTION public.record_stripe_manual_review_atomic(
  p_object_type text,
  p_object_id text,
  p_user_id uuid,
  p_reason_key text,
  p_reason text,
  p_context jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.stripe_manual_reviews (
    object_type, object_id, user_id, reason_key, reason, metadata
  ) VALUES (
    p_object_type, p_object_id, p_user_id, p_reason_key, p_reason, p_context
  )
  ON CONFLICT (object_type, object_id, reason_key) DO NOTHING;
  RETURN pg_catalog.jsonb_build_object('status', 'recorded');
END
$function$;
ALTER FUNCTION public.record_stripe_manual_review_atomic(
  text, text, uuid, text, text, jsonb
) OWNER TO postgres;

CREATE FUNCTION public.activate_recurring_trial_entitlement_atomic(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_subscription_id text,
  p_plan text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_stripe_subscription_status text
)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object('status', 'activated')
$function$;
ALTER FUNCTION public.activate_recurring_trial_entitlement_atomic(
  uuid, text, text, text, timestamptz, timestamptz, text
) OWNER TO postgres;

INSERT INTO public.user_profiles (id, stripe_customer_id) VALUES
  ('11000000-0000-4000-8000-000000000001', 'cus_concurrent_one'),
  ('11000000-0000-4000-8000-000000000002', 'cus_release_two'),
  ('11000000-0000-4000-8000-000000000003', 'cus_mode_three'),
  ('11000000-0000-4000-8000-000000000004', 'cus_owner_change_four');
SQL

psql_cmd -f "$MIGRATION" >/dev/null

# Closed role graph: only service_role can see or execute the authority.
if psql_cmd -qAtc "
  SET ROLE authenticated;
  SET request.jwt.claim.role = 'authenticated';
  SELECT public.reserve_recurring_pro_checkout_atomic(
    '11000000-0000-4000-8000-000000000001',
    false,
    'cus_concurrent_one',
    'monthly',
    'price_monthly',
    '21000000-0000-4000-8000-000000000001',
    false
  );
" >"$TMP_ROOT/authenticated.out" 2>&1; then
  echo "authenticated unexpectedly executed recurring Checkout admission" >&2
  exit 1
fi

expect_failure \
  "NULL text input must fail closed" \
  "SELECT public.reserve_recurring_pro_checkout_atomic(
    '11000000-0000-4000-8000-000000000001',
    false,
    NULL,
    'monthly',
    'price_monthly',
    '21000000-0000-4000-8000-000000000001',
    false
  );" \
  "22023"

# Twelve different monthly/yearly operations race for one user and Customer.
# Exactly one durable reservation may become payable.
mkdir -p "$TMP_ROOT/fanout"
pids=()
for lane in {1..12}; do
  suffix="$(printf '%012d' "$lane")"
  if ((lane % 2 == 0)); then
    plan="yearly"
    price="price_yearly"
  else
    plan="monthly"
    price="price_monthly"
  fi
  service_query "
    SELECT result ->> 'status'
    FROM public.reserve_recurring_pro_checkout_atomic(
      '11000000-0000-4000-8000-000000000001',
      false,
      'cus_concurrent_one',
      '$plan',
      '$price',
      '22000000-0000-4000-8000-$suffix',
      false
    ) AS result;
  " >"$TMP_ROOT/fanout/$lane.out" 2>"$TMP_ROOT/fanout/$lane.err" &
  pids+=("$!")
done
fanout_failed=0
for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    fanout_failed=1
  fi
done
if ((fanout_failed != 0)); then
  echo "recurring Checkout fanout had a failed PostgreSQL connection" >&2
  sed -n '1,120p' "$TMP_ROOT"/fanout/*.err >&2
  exit 1
fi
reserved_count="$(grep -hFx reserved "$TMP_ROOT"/fanout/*.out | wc -l | tr -d ' ')"
conflict_count="$(grep -hFx conflict "$TMP_ROOT"/fanout/*.out | wc -l | tr -d ' ')"
if [[ "$reserved_count|$conflict_count" != "1|11" ]]; then
  echo "fanout expected 1 reserved and 11 conflict results" >&2
  sort "$TMP_ROOT"/fanout/*.out | uniq -c >&2
  exit 1
fi
expect_value \
  "active reservation cardinality" \
  "1|1|1" \
  "SELECT
     pg_catalog.count(*),
     pg_catalog.count(DISTINCT user_id),
     pg_catalog.count(DISTINCT stripe_customer_id)
   FROM public.stripe_recurring_pro_checkout_reservations
   WHERE status IN ('reserved', 'bound', 'completed');"

read -r reservation_id operation_id nonce plan price expires_at <<<"$(
  psql_cmd -qAtF ' ' -c "
    SELECT id, operation_id, reservation_nonce, plan, stripe_price_id,
      checkout_expires_at
    FROM public.stripe_recurring_pro_checkout_reservations
    WHERE user_id = '11000000-0000-4000-8000-000000000001'
      AND NOT livemode
      AND status = 'reserved';
  "
)"

expect_value \
  "exact operation replay" \
  "existing|$reservation_id|$operation_id" \
  "SELECT pg_catalog.concat_ws(
     '|',
     result ->> 'status',
     result ->> 'reservation_id',
     result ->> 'operation_id'
   )
   FROM public.reserve_recurring_pro_checkout_atomic(
     '11000000-0000-4000-8000-000000000001',
     false,
     'cus_concurrent_one',
     '$plan',
     '$price',
     '$operation_id',
     false
   ) AS result;"

drift_plan="monthly"
drift_price="price_monthly"
if [[ "$plan" == "monthly" ]]; then
  drift_plan="yearly"
  drift_price="price_yearly"
fi
expect_value \
  "same operation immutable drift" \
  "identity_conflict" \
  "SELECT result ->> 'status'
   FROM public.reserve_recurring_pro_checkout_atomic(
     '11000000-0000-4000-8000-000000000001',
     false,
     'cus_concurrent_one',
     '$drift_plan',
     '$drift_price',
     '$operation_id',
     false
   ) AS result;"
expect_value \
  "operation conflict durable review" \
  "1" \
  "SELECT pg_catalog.count(*)
   FROM public.stripe_manual_reviews
   WHERE reason_key = 'recurring_checkout_operation_identity_conflict';"

expect_value \
  "reservation bind" \
  "bound" \
  "SELECT public.bind_recurring_pro_checkout_session_atomic(
     '11000000-0000-4000-8000-000000000001',
     false,
     'cus_concurrent_one',
     '$plan',
     '$price',
     '$operation_id',
     '$reservation_id',
     '$nonce',
     false,
     'cs_concurrent_winner',
     $expires_at
   );"

expect_failure \
  "invoice/subscription must not outrun Checkout completion" \
  "SELECT public.assert_recurring_pro_checkout_completed_atomic(
     '11000000-0000-4000-8000-000000000001',
     false,
     'cus_concurrent_one',
     'sub_concurrent_winner',
     '$reservation_id',
     '$operation_id',
     '$nonce',
     '$plan',
     '$price',
     false
   );" \
  "40001"

expect_value \
  "signed completion" \
  "completed" \
  "SELECT public.complete_recurring_pro_checkout_atomic(
     '11000000-0000-4000-8000-000000000001',
     false,
     'cus_concurrent_one',
     'sub_concurrent_winner',
     '$reservation_id',
     '$operation_id',
     '$nonce',
     '$plan',
     '$price',
     false,
     'cs_concurrent_winner',
     'evt_checkout_complete',
     2000000000
   );"
expect_value \
  "completed assertion" \
  "completed" \
  "SELECT public.assert_recurring_pro_checkout_completed_atomic(
     '11000000-0000-4000-8000-000000000001',
     false,
     'cus_concurrent_one',
     'sub_concurrent_winner',
     '$reservation_id',
     '$operation_id',
     '$nonce',
     '$plan',
     '$price',
     false
   );"
expect_value \
  "exact signed completion replay" \
  "already_completed" \
  "SELECT public.complete_recurring_pro_checkout_atomic(
     '11000000-0000-4000-8000-000000000001',
     false,
     'cus_concurrent_one',
     'sub_concurrent_winner',
     '$reservation_id',
     '$operation_id',
     '$nonce',
     '$plan',
     '$price',
     false,
     'cs_concurrent_winner',
     'evt_checkout_complete',
     2000000000
   );"

psql_cmd -qAtc "
  INSERT INTO public.subscriptions (
    user_id, stripe_customer_id, stripe_subscription_id, tier, status
  ) VALUES (
    '11000000-0000-4000-8000-000000000001',
    'cus_concurrent_one',
    'sub_concurrent_winner',
    'pro',
    'active'
  );
" >/dev/null
expect_value \
  "active subscription blocks recheckout" \
  "already_subscribed" \
  "SELECT result ->> 'status'
   FROM public.reserve_recurring_pro_checkout_atomic(
     '11000000-0000-4000-8000-000000000001',
     false,
     'cus_concurrent_one',
     'monthly',
     'price_monthly',
     '23000000-0000-4000-8000-000000000001',
     false
   ) AS result;"

psql_cmd -qAtc "
  UPDATE public.subscriptions
  SET status = 'canceled'
  WHERE stripe_subscription_id = 'sub_concurrent_winner';
" >/dev/null
expect_value \
  "terminal projection permits one new reservation" \
  "reserved" \
  "SELECT result ->> 'status'
   FROM public.reserve_recurring_pro_checkout_atomic(
     '11000000-0000-4000-8000-000000000001',
     false,
     'cus_concurrent_one',
     'monthly',
     'price_monthly',
     '23000000-0000-4000-8000-000000000001',
     false
   ) AS result;"

# A second identity proves that only its exact signed expiration releases it.
release_json="$(
  service_query "
    SELECT result::text
    FROM public.reserve_recurring_pro_checkout_atomic(
      '11000000-0000-4000-8000-000000000002',
      false,
      'cus_release_two',
      'yearly',
      'price_yearly',
      '24000000-0000-4000-8000-000000000001',
      true
    ) AS result;
  "
)"
release_id="$(psql_cmd -qAtc "
  SELECT id
  FROM public.stripe_recurring_pro_checkout_reservations
  WHERE operation_id = '24000000-0000-4000-8000-000000000001';
")"
release_nonce="$(psql_cmd -qAtc "
  SELECT reservation_nonce
  FROM public.stripe_recurring_pro_checkout_reservations
  WHERE id = '$release_id';
")"
release_expires="$(psql_cmd -qAtc "
  SELECT checkout_expires_at
  FROM public.stripe_recurring_pro_checkout_reservations
  WHERE id = '$release_id';
")"
[[ -n "$release_json" ]]

expect_value \
  "release reservation bind" \
  "bound" \
  "SELECT public.bind_recurring_pro_checkout_session_atomic(
     '11000000-0000-4000-8000-000000000002',
     false,
     'cus_release_two',
     'yearly',
     'price_yearly',
     '24000000-0000-4000-8000-000000000001',
     '$release_id',
     '$release_nonce',
     true,
     'cs_release_exact',
     $release_expires
   );"
expect_value \
  "exact signed expiry release" \
  "released" \
  "SELECT public.release_recurring_pro_checkout_atomic(
     '11000000-0000-4000-8000-000000000002',
     false,
     'cus_release_two',
     '$release_id',
     '24000000-0000-4000-8000-000000000001',
     '$release_nonce',
     'yearly',
     'price_yearly',
     true,
     'cs_release_exact',
     'evt_release_exact',
     2000000000
   );"
expect_value \
  "exact signed expiry replay" \
  "already_released" \
  "SELECT public.release_recurring_pro_checkout_atomic(
     '11000000-0000-4000-8000-000000000002',
     false,
     'cus_release_two',
     '$release_id',
     '24000000-0000-4000-8000-000000000001',
     '$release_nonce',
     'yearly',
     'price_yearly',
     true,
     'cs_release_exact',
     'evt_release_exact',
     2000000000
   );"
expect_value \
  "new reservation after signed release" \
  "reserved" \
  "SELECT result ->> 'status'
   FROM public.reserve_recurring_pro_checkout_atomic(
     '11000000-0000-4000-8000-000000000002',
     false,
     'cus_release_two',
     'monthly',
     'price_monthly',
     '24000000-0000-4000-8000-000000000002',
     false
   ) AS result;"

# A signed completion must not mutate the lifecycle row after its persisted
# user/Customer ownership changes. It records review and leaves the reservation
# bound for operator reconciliation.
owner_change_json="$(
  service_query "
    SELECT result::text
    FROM public.reserve_recurring_pro_checkout_atomic(
      '11000000-0000-4000-8000-000000000004',
      false,
      'cus_owner_change_four',
      'monthly',
      'price_monthly',
      '25000000-0000-4000-8000-000000000001',
      false
    ) AS result;
  "
)"
owner_change_id="$(psql_cmd -qAtc "
  SELECT id
  FROM public.stripe_recurring_pro_checkout_reservations
  WHERE operation_id = '25000000-0000-4000-8000-000000000001';
")"
owner_change_nonce="$(psql_cmd -qAtc "
  SELECT reservation_nonce
  FROM public.stripe_recurring_pro_checkout_reservations
  WHERE id = '$owner_change_id';
")"
owner_change_expires="$(psql_cmd -qAtc "
  SELECT checkout_expires_at
  FROM public.stripe_recurring_pro_checkout_reservations
  WHERE id = '$owner_change_id';
")"
[[ -n "$owner_change_json" ]]

expect_value \
  "owner-change reservation bind" \
  "bound" \
  "SELECT public.bind_recurring_pro_checkout_session_atomic(
     '11000000-0000-4000-8000-000000000004',
     false,
     'cus_owner_change_four',
     'monthly',
     'price_monthly',
     '25000000-0000-4000-8000-000000000001',
     '$owner_change_id',
     '$owner_change_nonce',
     false,
     'cs_owner_change_exact',
     $owner_change_expires
   );"
psql_cmd -qAtc "
  UPDATE public.user_profiles
  SET stripe_customer_id = 'cus_owner_change_rebound'
  WHERE id = '11000000-0000-4000-8000-000000000004';
" >/dev/null
expect_value \
  "owner change blocks completion" \
  "identity_conflict" \
  "SELECT public.complete_recurring_pro_checkout_atomic(
     '11000000-0000-4000-8000-000000000004',
     false,
     'cus_owner_change_four',
     'sub_owner_change_exact',
     '$owner_change_id',
     '25000000-0000-4000-8000-000000000001',
     '$owner_change_nonce',
     'monthly',
     'price_monthly',
     false,
     'cs_owner_change_exact',
     'evt_owner_change_exact',
     2000000000
   );"
expect_value \
  "owner change preserves bound lifecycle and review" \
  "bound|1" \
  "SELECT pg_catalog.concat_ws(
     '|',
     reservation.status,
     (
       SELECT pg_catalog.count(*)
       FROM public.stripe_manual_reviews AS review
       WHERE review.reason_key =
         'recurring_checkout_owner_changed_before_completion'
     )
   )
   FROM public.stripe_recurring_pro_checkout_reservations AS reservation
   WHERE reservation.id = '$owner_change_id';"

expect_value \
  "persistent RLS relation" \
  "p|t|f" \
  "SELECT relation.relpersistence, relation.relrowsecurity,
     relation.relforcerowsecurity
   FROM pg_catalog.pg_class AS relation
   WHERE relation.oid =
     'public.stripe_recurring_pro_checkout_reservations'::pg_catalog.regclass;"

echo "recurring Pro Checkout PostgreSQL 17 integration proof passed"
