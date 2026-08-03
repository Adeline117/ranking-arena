#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for ordinary B2C Pro Checkout admission,
# concurrent monthly/yearly reservation, exact signed lifecycle transitions,
# replay, RLS/ACL ownership, and migration replay stability.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729073000_pro_membership_checkout_reservation.sql"
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

TMP_ROOT="$(mktemp -d /tmp/pro-checkout-reservation-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55573
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure() {
  local sql="$1"
  local label="$2"
  if psql_cmd -Atqc "$sql" >/dev/null 2>&1; then
    echo "Expected failure: $label" >&2
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

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  stripe_customer_id text,
  stripe_subscription_id text,
  subscription_tier text,
  is_pro boolean NOT NULL DEFAULT false,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false
);
ALTER TABLE public.user_profiles OWNER TO postgres;
CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text NOT NULL DEFAULT 'inactive',
  tier text NOT NULL DEFAULT 'free',
  plan text
);
ALTER TABLE public.subscriptions OWNER TO postgres;
CREATE TABLE public.stripe_trial_entitlements (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  plan text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  verified_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text
);
ALTER TABLE public.stripe_trial_entitlements OWNER TO postgres;
CREATE TABLE public.stripe_subscription_state_events (
  event_id text PRIMARY KEY,
  user_id uuid,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  plan text NOT NULL,
  stripe_status text NOT NULL,
  event_created_at timestamptz NOT NULL,
  livemode boolean,
  period_start timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  period_end timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp() + interval '30 days',
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  current_invoice_id text,
  requested_grace_expires_at timestamptz,
  outcome text NOT NULL DEFAULT 'observed',
  observed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public.stripe_subscription_state_events OWNER TO postgres;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

if [[ "${PRINT_PRO_CHECKOUT_CATALOG:-0}" == '1' ]]; then
  psql_cmd -Atqc "
    SELECT 'COLUMN|' || attribute.attnum || '|' || attribute.attname || '|'
      || pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || '|'
      || attribute.attnotnull::text || '|'
      || COALESCE(pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid), '') || '|'
      || attribute.attidentity::text || '|' || attribute.attgenerated::text
    FROM pg_catalog.pg_attribute AS attribute
    LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
      AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'public.pro_membership_checkout_reservations'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY attribute.attnum;

    SELECT 'CONSTRAINT|' || constraint_row.conname || '|'
      || constraint_row.contype::text || '|' || constraint_row.convalidated::text || '|'
      || constraint_row.connoinherit::text || '|'
      || pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.pro_membership_checkout_reservations'::pg_catalog.regclass
    ORDER BY constraint_row.conname;

    SELECT 'INDEX|' || index_row.indexname || '|' || index_row.indexdef
    FROM pg_catalog.pg_indexes AS index_row
    WHERE index_row.schemaname = 'public'
      AND index_row.tablename = 'pro_membership_checkout_reservations'
    ORDER BY index_row.indexname;

    SELECT 'FUNCTION|' || function_row.proname || '|'
      || pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(function_row.prosrc, 'UTF8')),
        'hex'
      ) || '|' || pg_catalog.array_to_string(function_row.proconfig, ',')
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (
      'public.bind_pro_membership_checkout_session_atomic(uuid,uuid,boolean,text,text,text,bigint,text,smallint,text,bigint)'::pg_catalog.regprocedure::oid,
      'public.convert_pro_membership_checkout_reservation_atomic(uuid,uuid,boolean,text,text,text,bigint,text,smallint,text,text,text,text,bigint,bigint,text,bigint)'::pg_catalog.regprocedure::oid,
      'public.release_pro_membership_checkout_observation_atomic(uuid,uuid,boolean,text,text,text,bigint,text,smallint,text,bigint,text,bigint)'::pg_catalog.regprocedure::oid,
      'public.release_pro_membership_checkout_reservation_atomic(uuid,uuid,boolean,text,text,text,bigint,text,smallint,text,bigint,text,bigint)'::pg_catalog.regprocedure::oid,
      'public.reserve_pro_membership_checkout_atomic(uuid,boolean,text,text,text,bigint,text,smallint,text,text)'::pg_catalog.regprocedure::oid
    )
    ORDER BY function_row.proname;

    SELECT 'COLUMN_HASH|' || pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.concat_ws(
              '|', attribute.attnum, attribute.attname,
              pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
              attribute.attnotnull,
              COALESCE(pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid), ''),
              attribute.attidentity, attribute.attgenerated
            ),
            E'\n' ORDER BY attribute.attnum
          ),
          'UTF8'
        )
      ),
      'hex'
    )
    FROM pg_catalog.pg_attribute AS attribute
    LEFT JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
      AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'public.pro_membership_checkout_reservations'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    SELECT 'CONSTRAINT_HASH|' || pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.concat_ws(
              '|', constraint_row.conname, constraint_row.contype,
              constraint_row.convalidated, constraint_row.connoinherit,
              pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
            ),
            E'\n' ORDER BY constraint_row.conname
          ),
          'UTF8'
        )
      ),
      'hex'
    )
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.pro_membership_checkout_reservations'::pg_catalog.regclass;

    SELECT 'INDEX_HASH|' || pg_catalog.encode(
      pg_catalog.sha256(
        pg_catalog.convert_to(
          pg_catalog.string_agg(
            pg_catalog.concat_ws(
              '|', index_relation.relname, index_row.indisunique,
              index_row.indisprimary, index_row.indisvalid,
              index_row.indisready, index_row.indislive,
              pg_catalog.pg_get_indexdef(index_row.indexrelid)
            ),
            E'\n' ORDER BY index_relation.relname
          ),
          'UTF8'
        )
      ),
      'hex'
    )
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    WHERE index_row.indrelid =
      'public.pro_membership_checkout_reservations'::pg_catalog.regclass;
  "
  exit 0
fi

schema_hash() {
  psql_cmd -Atqc "
    SELECT pg_catalog.md5(pg_catalog.string_agg(definition, E'\\n' ORDER BY definition))
    FROM (
      SELECT pg_catalog.pg_get_functiondef(function_row.oid) AS definition
      FROM pg_catalog.pg_proc AS function_row
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = function_row.pronamespace
      WHERE namespace.nspname = 'public'
        AND function_row.proname LIKE '%pro_membership_checkout%'
      UNION ALL
      SELECT index_row.indexdef
      FROM pg_catalog.pg_indexes AS index_row
      WHERE index_row.schemaname = 'public'
        AND index_row.tablename = 'pro_membership_checkout_reservations'
      UNION ALL
      SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid =
        'public.pro_membership_checkout_reservations'::pg_catalog.regclass
    ) AS definitions;
  "
}

BASE_HASH="$(schema_hash)"
psql_cmd -f "$MIGRATION" >/dev/null
REPLAY_HASH="$(schema_hash)"
[[ -n "$BASE_HASH" && "$BASE_HASH" == "$REPLAY_HASH" ]] || {
  echo "Migration replay changed the Pro checkout schema hash" >&2
  exit 1
}

USER_A='11111111-1111-4111-8111-111111111111'
USER_B='22222222-2222-4222-8222-222222222222'
USER_C='33333333-3333-4333-8333-333333333333'
USER_D='44444444-4444-4444-8444-444444444444'
USER_E='55555555-5555-4555-8555-555555555555'
USER_F='66666666-6666-4666-8666-666666666666'
USER_G='77777777-7777-4777-8777-777777777777'
USER_H='88888888-8888-4888-8888-888888888888'
USER_I='99999999-9999-4999-8999-999999999999'
USER_J='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
USER_K='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
USER_L='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
USER_M='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
USER_N='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
USER_O='ffffffff-ffff-4fff-8fff-ffffffffffff'
psql_cmd -v user_a="$USER_A" -v user_b="$USER_B" -v user_c="$USER_C" \
  -v user_d="$USER_D" -v user_e="$USER_E" -v user_f="$USER_F" \
  -v user_g="$USER_G" -v user_h="$USER_H" -v user_i="$USER_I" \
  -v user_j="$USER_J" -v user_k="$USER_K" -v user_l="$USER_L" \
  -v user_m="$USER_M" -v user_n="$USER_N" -v user_o="$USER_O" <<'SQL'
INSERT INTO public.user_profiles (
  id, stripe_customer_id, subscription_tier, is_pro
) VALUES
  (:'user_a', 'cus_concurrent', 'free', false),
  (:'user_b', 'cus_complete', 'free', false),
  (:'user_c', 'cus_expire', 'free', false),
  (:'user_d', 'cus_active', 'free', false),
  (:'user_e', 'cus_trial_new', 'free', false),
  (:'user_f', 'cus_cross_user', 'free', false),
  (:'user_g', 'cus_cross_customer', 'free', false),
  (:'user_h', 'cus_bind_race', 'free', false),
  (:'user_i', 'cus_trial_exact', 'free', false),
  (:'user_j', 'cus_zero_forgery', 'free', false),
  (:'user_k', 'cus_trial_bind_race', 'free', false),
  (:'user_l', 'cus_orphan_absent', 'free', false),
  (:'user_m', 'cus_orphan_expired', 'free', false),
  (:'user_n', 'cus_deleted_after_bind', 'free', false),
  (:'user_o', 'cus_banned_after_bind', 'free', false);
SQL

# Runtime SECURITY DEFINER functions carry their own lock/statement bounds;
# migration-transaction SET LOCAL values do not protect later RPC calls.
psql_cmd -c "
  BEGIN;
  SELECT id FROM public.user_profiles WHERE id = '$USER_D' FOR UPDATE;
  SELECT pg_catalog.pg_sleep(7);
  COMMIT;
" >"$TMP_ROOT/runtime-lock-holder.out" &
RUNTIME_LOCK_PID=$!
psql_cmd -Atqc "SELECT pg_catalog.pg_sleep(0.5)" >/dev/null
RUNTIME_LOCK_STARTED=$SECONDS
expect_failure "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_D', false, 'cus_active', 'monthly', 'price_monthly',
    499, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )
" 'runtime reservation lock contention did not fail closed'
RUNTIME_LOCK_ELAPSED=$((SECONDS - RUNTIME_LOCK_STARTED))
((RUNTIME_LOCK_ELAPSED < 7)) || {
  echo "Runtime reservation RPC ignored its function-level lock timeout" >&2
  exit 1
}
wait "$RUNTIME_LOCK_PID"
[[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.pro_membership_checkout_reservations WHERE user_id = '$USER_D'")" == '0' ]] || {
  echo "Timed-out runtime reservation RPC committed a row" >&2
  exit 1
}

# Two different plans racing for one user must converge to one durable row and
# one reservation UUID. The application turns the losing different-plan
# `existing` response into HTTP 409.
psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_A', false, 'cus_concurrent', 'monthly', 'price_monthly',
    499, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'reservation_id'
" >"$TMP_ROOT/monthly.out" &
MONTHLY_PID=$!
psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_A', false, 'cus_concurrent', 'yearly', 'price_yearly',
    2999, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'reservation_id'
" >"$TMP_ROOT/yearly.out" &
YEARLY_PID=$!
wait "$MONTHLY_PID"
wait "$YEARLY_PID"
[[ "$(cat "$TMP_ROOT/monthly.out")" == "$(cat "$TMP_ROOT/yearly.out")" ]] || {
  echo "Concurrent monthly/yearly checkout did not converge to one reservation" >&2
  exit 1
}
[[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.pro_membership_checkout_reservations WHERE user_id = '$USER_A' AND status IN ('reserved', 'bound')")" == '1' ]] || {
  echo "Concurrent monthly/yearly checkout created more than one active reservation" >&2
  exit 1
}

# Same-plan retry recovers the same UUID and never creates another row.
WINNING_PLAN="$(psql_cmd -Atqc "SELECT pro_plan FROM public.pro_membership_checkout_reservations WHERE user_id = '$USER_A'")"
WINNING_PRICE="$(psql_cmd -Atqc "SELECT stripe_price_id FROM public.pro_membership_checkout_reservations WHERE user_id = '$USER_A'")"
WINNING_AMOUNT="$(psql_cmd -Atqc "SELECT unit_amount FROM public.pro_membership_checkout_reservations WHERE user_id = '$USER_A'")"
RETRY_ID="$(psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_A', false, 'cus_concurrent', '$WINNING_PLAN', '$WINNING_PRICE',
    $WINNING_AMOUNT, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'reservation_id'
")"
[[ "$RETRY_ID" == "$(cat "$TMP_ROOT/monthly.out")" ]] || {
  echo "Same-plan retry did not recover the durable reservation" >&2
  exit 1
}

# Reserve/bind/convert one exact subscription and prove exact replay.
RESERVE_B="$(psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_B', true, 'cus_complete', 'monthly', 'price_monthly',
    499, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )
")"
RESERVATION_B="$(psql_cmd -Atqc "SELECT '$RESERVE_B'::jsonb->>'reservation_id'")"
EXPIRES_B="$(psql_cmd -Atqc "SELECT '$RESERVE_B'::jsonb->>'checkout_expires_at'")"
psql_cmd -Atqc "
  SELECT public.bind_pro_membership_checkout_session_atomic(
    '$RESERVATION_B', '$USER_B', true, 'cus_complete', 'monthly',
    'price_monthly', 499, 'usd', 0::smallint, 'cs_complete', $EXPIRES_B
  )->>'status'
" | grep -qx 'bound'

expect_failure "
  SELECT public.convert_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_B', '$USER_B', true, 'cus_complete', 'yearly',
    'price_yearly', 2999, 'usd', 0::smallint, 'cs_complete', 'sub_complete',
    'paid', 'active', NULL, NULL,
    'evt_complete', 2000000000
  )
" 'forged completion plan/price was accepted'

psql_cmd -Atqc "
  SELECT public.convert_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_B', '$USER_B', true, 'cus_complete', 'monthly',
    'price_monthly', 499, 'usd', 0::smallint, 'cs_complete', 'sub_complete',
    'paid', 'active', NULL, NULL,
    'evt_complete', 2000000000
  )->>'status'
" | grep -qx 'converted'
psql_cmd -Atqc "
  SELECT public.convert_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_B', '$USER_B', true, 'cus_complete', 'monthly',
    'price_monthly', 499, 'usd', 0::smallint, 'cs_complete', 'sub_complete',
    'paid', 'active', NULL, NULL,
    'evt_complete', 2000000000
  )->>'status'
" | grep -qx 'already_converted'
psql_cmd -Atqc "
  SELECT public.convert_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_B', '$USER_B', true, 'cus_complete', 'monthly',
    'price_monthly', 499, 'usd', 0::smallint, 'cs_complete', 'sub_complete',
    'paid', 'past_due', NULL, NULL,
    'evt_complete', 2000000000
  )->>'observation'
" | grep -qx 'observed'
[[ "$(psql_cmd -Atqc "SELECT subscription_status FROM public.pro_membership_checkout_reservations WHERE id = '$RESERVATION_B'")" == 'active' ]] || {
  echo "Mutable nonterminal retry overwrote the durable terminal barrier source" >&2
  exit 1
}
psql_cmd -Atqc "
  SELECT public.convert_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_B', '$USER_B', true, 'cus_complete', 'monthly',
    'price_monthly', 499, 'usd', 0::smallint, 'cs_complete', 'sub_complete',
    'paid', 'canceled', NULL, NULL,
    'evt_complete', 2000000000
  )->>'observation'
" | grep -qx 'tightened'
expect_failure "
  SELECT public.convert_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_B', '$USER_B', true, 'cus_complete', 'monthly',
    'price_monthly', 499, 'usd', 0::smallint, 'cs_complete', 'sub_complete',
    'paid', 'active', NULL, NULL,
    'evt_complete', 2000000000
  )
" 'terminal completion observation was resurrected by an older retry'
expect_failure "
  SELECT public.convert_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_B', '$USER_B', true, 'cus_complete', 'monthly',
    'price_monthly', 499, 'usd', 0::smallint, 'cs_complete', 'sub_attacker',
    'paid', 'active', NULL, NULL,
    'evt_attacker', 2000000001
  )
" 'conflicting completion replay was accepted'

# Account deletion/long-ban after Session binding must not erase a completed
# financial fact. 073 records the exact conversion, while the downstream 074
# authority is responsible for an atomic zero-grant/refund disposition.
for account_state in deleted banned; do
  if [[ "$account_state" == 'deleted' ]]; then
    ACCOUNT_USER="$USER_N"
    ACCOUNT_CUSTOMER='cus_deleted_after_bind'
  else
    ACCOUNT_USER="$USER_O"
    ACCOUNT_CUSTOMER='cus_banned_after_bind'
  fi
  ACCOUNT_RESERVE="$(psql_cmd -Atqc "
    SELECT public.reserve_pro_membership_checkout_atomic(
      '$ACCOUNT_USER', false, '$ACCOUNT_CUSTOMER', 'monthly', 'price_monthly',
      499, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
      'https://www.arenafi.org/pricing'
    )
  ")"
  ACCOUNT_RESERVATION="$(
    psql_cmd -Atqc "SELECT '$ACCOUNT_RESERVE'::jsonb->>'reservation_id'"
  )"
  ACCOUNT_EXPIRES="$(
    psql_cmd -Atqc "SELECT '$ACCOUNT_RESERVE'::jsonb->>'checkout_expires_at'"
  )"
  psql_cmd -Atqc "
    SELECT public.bind_pro_membership_checkout_session_atomic(
      '$ACCOUNT_RESERVATION', '$ACCOUNT_USER', false, '$ACCOUNT_CUSTOMER',
      'monthly', 'price_monthly', 499, 'usd', 0::smallint,
      'cs_${account_state}_after_bind', $ACCOUNT_EXPIRES
    )->>'status'
  " | grep -qx 'bound'
  if [[ "$account_state" == 'deleted' ]]; then
    psql_cmd -c "
      UPDATE public.user_profiles
      SET deleted_at = pg_catalog.clock_timestamp()
      WHERE id = '$ACCOUNT_USER'
    " >/dev/null
  else
    psql_cmd -c "
      UPDATE public.user_profiles
      SET banned_at = pg_catalog.clock_timestamp(), is_banned = true
      WHERE id = '$ACCOUNT_USER'
    " >/dev/null
  fi
  psql_cmd -Atqc "
    SELECT public.convert_pro_membership_checkout_reservation_atomic(
      '$ACCOUNT_RESERVATION', '$ACCOUNT_USER', false, '$ACCOUNT_CUSTOMER',
      'monthly', 'price_monthly', 499, 'usd', 0::smallint,
      'cs_${account_state}_after_bind', 'sub_${account_state}_after_bind',
      'paid', 'active', NULL, NULL, 'evt_${account_state}_after_bind', 2000000200
    )->>'status'
  " | grep -qx 'converted'
  [[ "$(psql_cmd -Atqc "
    SELECT (reservation.status = 'converted'
      AND profile.is_pro = false
      AND profile.subscription_tier = 'free'
      AND NOT EXISTS (
        SELECT 1 FROM public.subscriptions WHERE user_id = '$ACCOUNT_USER'
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.stripe_trial_entitlements WHERE user_id = '$ACCOUNT_USER'
      ))::text
    FROM public.pro_membership_checkout_reservations AS reservation
    JOIN public.user_profiles AS profile ON profile.id = reservation.user_id
    WHERE reservation.id = '$ACCOUNT_RESERVATION'
  ")" == 'true' ]] || {
    echo "${account_state} account conversion lost its financial fact or granted locally" >&2
    exit 1
  }
done

# A converted row remains a financial barrier. Missing or different local
# authority, a non-terminal latest signed state, and a terminal state from the
# other Stripe mode all remain blocked. Only the exact local subscription plus
# latest same-mode terminal state atomically retires it.
psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_B', true, 'cus_complete', 'yearly', 'price_yearly',
    2999, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'status'
" | grep -qx 'already_subscribed'
psql_cmd -c "
  INSERT INTO public.subscriptions (
    user_id, stripe_customer_id, stripe_subscription_id, status, tier, plan
  ) VALUES (
    '$USER_B', 'cus_complete', 'sub_different', 'canceled', 'pro', 'monthly'
  );
  INSERT INTO public.stripe_subscription_state_events (
    event_id, user_id, stripe_customer_id, stripe_subscription_id,
    plan, stripe_status, event_created_at, livemode
  ) VALUES (
    'evt_different_terminal', '$USER_B', 'cus_complete', 'sub_different',
    'monthly', 'canceled', pg_catalog.to_timestamp(2000000100), true
  );
" >/dev/null
psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_B', true, 'cus_complete', 'yearly', 'price_yearly',
    2999, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'status'
" | grep -qx 'already_subscribed'
psql_cmd -c "
  UPDATE public.subscriptions
  SET stripe_subscription_id = 'sub_complete', status = 'active'
  WHERE user_id = '$USER_B';
  INSERT INTO public.stripe_subscription_state_events (
    event_id, user_id, stripe_customer_id, stripe_subscription_id,
    plan, stripe_status, event_created_at, livemode
  ) VALUES (
    'evt_exact_active', '$USER_B', 'cus_complete', 'sub_complete',
    'monthly', 'active', pg_catalog.to_timestamp(2000000200), true
  );
" >/dev/null
psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_B', true, 'cus_complete', 'yearly', 'price_yearly',
    2999, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'status'
" | grep -qx 'already_subscribed'
psql_cmd -c "
  UPDATE public.subscriptions SET status = 'canceled' WHERE user_id = '$USER_B';
  INSERT INTO public.stripe_subscription_state_events (
    event_id, user_id, stripe_customer_id, stripe_subscription_id,
    plan, stripe_status, event_created_at, livemode
  ) VALUES (
    'evt_false_terminal', '$USER_B', 'cus_complete', 'sub_complete',
    'monthly', 'canceled', pg_catalog.to_timestamp(2000000300), false
  );
" >/dev/null
psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_B', true, 'cus_complete', 'yearly', 'price_yearly',
    2999, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'status'
" | grep -qx 'already_subscribed'
psql_cmd -c "
  INSERT INTO public.stripe_subscription_state_events (
    event_id, user_id, stripe_customer_id, stripe_subscription_id,
    plan, stripe_status, event_created_at, livemode
  ) VALUES (
    'evt_true_terminal', '$USER_B', 'cus_complete', 'sub_complete',
    'monthly', 'canceled', pg_catalog.to_timestamp(2000000400), true
  );
" >/dev/null
psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_B', true, 'cus_complete', 'yearly', 'price_yearly',
    2999, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'status'
" | grep -qx 'reserved'
[[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.pro_membership_checkout_reservations WHERE user_id = '$USER_B' AND status = 'retired'")" == '1' ]] || {
  echo "Exact terminal converted reservation was not retired" >&2
  exit 1
}
psql_cmd -c "
  INSERT INTO public.subscriptions (
    user_id, stripe_customer_id, stripe_subscription_id, status, tier, plan
  ) VALUES (
    '$USER_D', 'cus_active', 'sub_active', 'past_due', 'pro', 'monthly'
  )
" >/dev/null
psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_D', false, 'cus_active', 'monthly', 'price_monthly',
    499, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'status'
" | grep -qx 'already_subscribed'

# Trial consumption is durable and independent of the currently configured
# Stripe Price, Customer, and revocation state. It rejects a requested trial;
# it never silently creates an immediate-charge reservation.
psql_cmd -c "
  INSERT INTO public.stripe_trial_entitlements (
    user_id, stripe_customer_id, stripe_subscription_id, plan,
    period_start, period_end, verified_at, revoked_at, revoke_reason
  ) VALUES (
    '$USER_E', 'cus_old_trial_customer', 'sub_old_price_trial', 'monthly',
    pg_catalog.clock_timestamp() - interval '1 year',
    pg_catalog.clock_timestamp() - interval '1 year' + interval '7 days',
    pg_catalog.clock_timestamp() - interval '1 year',
    pg_catalog.clock_timestamp() - interval '6 months', 'historical revocation'
  )
" >/dev/null
psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_E', false, 'cus_trial_new', 'yearly', 'price_rotated_yearly',
    2999, 'usd', 7::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'status'
" | grep -qx 'trial_already_used'
[[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.pro_membership_checkout_reservations WHERE user_id = '$USER_E'")" == '0' ]] || {
  echo "Used trial created an immediate-charge reservation" >&2
  exit 1
}

# Crossed user/Customer rows are locked as a set; SELECT INTO is never allowed
# to choose one nondeterministically.
psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_F', false, 'cus_cross_user', 'monthly', 'price_monthly',
    499, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'status'
" | grep -qx 'reserved'
psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_G', false, 'cus_cross_customer', 'monthly', 'price_monthly',
    499, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'status'
" | grep -qx 'reserved'
psql_cmd -c "UPDATE public.user_profiles SET stripe_customer_id = 'cus_cross_customer' WHERE id = '$USER_F'" >/dev/null
expect_failure "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_F', false, 'cus_cross_customer', 'monthly', 'price_monthly',
    499, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )
" 'crossed active user/Customer reservations were reused nondeterministically'

# Bind repeats local authority under the same locks. A non-terminal Pro row or
# newly consumed trial appearing after reserve explicitly rejects the bind.
RESERVE_H="$(psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_H', false, 'cus_bind_race', 'monthly', 'price_monthly',
    499, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )
")"
RESERVATION_H="$(psql_cmd -Atqc "SELECT '$RESERVE_H'::jsonb->>'reservation_id'")"
EXPIRES_H="$(psql_cmd -Atqc "SELECT '$RESERVE_H'::jsonb->>'checkout_expires_at'")"
psql_cmd -Atqc "
  SELECT public.bind_pro_membership_checkout_session_atomic(
    '$RESERVATION_H', '$USER_H', false, 'cus_bind_race', 'monthly',
    'price_monthly', 499, 'usd', 0::smallint, 'cs_bind_race', $EXPIRES_H
  )->>'status'
" | grep -qx 'bound'
psql_cmd -c "
  INSERT INTO public.subscriptions (
    user_id, stripe_customer_id, stripe_subscription_id, status, tier, plan
  ) VALUES ('$USER_H', 'cus_bind_race', 'sub_manual_race', 'active', 'pro', 'monthly')
" >/dev/null
expect_failure "
  SELECT public.bind_pro_membership_checkout_session_atomic(
    '$RESERVATION_H', '$USER_H', false, 'cus_bind_race', 'monthly',
    'price_monthly', 499, 'usd', 0::smallint, 'cs_bind_race', $EXPIRES_H
  )
" 'new non-terminal authority did not block bound Session recovery'

# Exact trial conversion is 7 days/no-payment/trialing; paid and zero-day
# forgeries fail. The terminal status variant remains consumable for T2-before-
# T1 ordering without granting entitlement in this reservation function.
RESERVE_I="$(psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_I', false, 'cus_trial_exact', 'monthly', 'price_monthly',
    499, 'usd', 7::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )
")"
RESERVATION_I="$(psql_cmd -Atqc "SELECT '$RESERVE_I'::jsonb->>'reservation_id'")"
EXPIRES_I="$(psql_cmd -Atqc "SELECT '$RESERVE_I'::jsonb->>'checkout_expires_at'")"
psql_cmd -Atqc "
  SELECT public.bind_pro_membership_checkout_session_atomic(
    '$RESERVATION_I', '$USER_I', false, 'cus_trial_exact', 'monthly',
    'price_monthly', 499, 'usd', 7::smallint, 'cs_trial_exact', $EXPIRES_I
  )->>'status'
" | grep -qx 'bound'
expect_failure "
  SELECT public.convert_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_I', '$USER_I', false, 'cus_trial_exact', 'monthly',
    'price_monthly', 499, 'usd', 7::smallint, 'cs_trial_exact', 'sub_trial_exact',
    'paid', 'active', NULL, NULL, 'evt_trial_paid_forgery', 2000000500
  )
" 'seven-day reservation was converted as an immediate paid subscription'
psql_cmd -Atqc "
  SELECT public.convert_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_I', '$USER_I', false, 'cus_trial_exact', 'monthly',
    'price_monthly', 499, 'usd', 7::smallint, 'cs_trial_exact', 'sub_trial_exact',
    'no_payment_required', 'canceled', 2000000000, 2000604800,
    'evt_trial_terminal', 2000000600
  )->>'status'
" | grep -qx 'converted'
[[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.stripe_trial_entitlements WHERE user_id = '$USER_I'")" == '0' ]] || {
  echo "Trial crash fixture unexpectedly had a downstream trial ledger row" >&2
  exit 1
}
psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_I', false, 'cus_trial_exact', 'yearly', 'price_yearly',
    2999, 'usd', 7::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'status'
" | grep -qx 'trial_already_used'

# Once exact signed terminal authorities allow the converted barrier to retire,
# the converted/retired reservation itself remains permanent trial history even
# though the downstream entitlement transaction never committed.
psql_cmd -c "
  INSERT INTO public.subscriptions (
    user_id, stripe_customer_id, stripe_subscription_id, status, tier, plan
  ) VALUES (
    '$USER_I', 'cus_trial_exact', 'sub_trial_exact', 'canceled', 'pro', 'monthly'
  );
  INSERT INTO public.stripe_subscription_state_events (
    event_id, user_id, stripe_customer_id, stripe_subscription_id,
    plan, stripe_status, event_created_at, livemode
  ) VALUES (
    'evt_trial_exact_state', '$USER_I', 'cus_trial_exact', 'sub_trial_exact',
    'monthly', 'canceled', pg_catalog.to_timestamp(2000000800), false
  );
" >/dev/null
RESERVE_I_PAID="$(psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_I', false, 'cus_trial_exact', 'yearly', 'price_yearly',
    2999, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )
")"
RESERVATION_I_PAID="$(psql_cmd -Atqc "SELECT '$RESERVE_I_PAID'::jsonb->>'reservation_id'")"
EXPIRES_I_PAID="$(psql_cmd -Atqc "SELECT '$RESERVE_I_PAID'::jsonb->>'checkout_expires_at'")"
CREATED_I_PAID="$(psql_cmd -Atqc "SELECT floor(extract(epoch FROM created_at))::bigint FROM public.pro_membership_checkout_reservations WHERE id = '$RESERVATION_I_PAID'")"
psql_cmd -Atqc "
  SELECT public.release_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_I_PAID', '$USER_I', false, 'cus_trial_exact', 'yearly',
    'price_yearly', 2999, 'usd', 0::smallint, 'cs_trial_paid_cleanup',
    $EXPIRES_I_PAID, 'evt_trial_paid_cleanup', $CREATED_I_PAID
  )->>'status'
" | grep -qx 'released'
psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_I', false, 'cus_trial_exact', 'yearly', 'price_yearly',
    2999, 'usd', 7::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )->>'status'
" | grep -qx 'trial_already_used'
[[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.pro_membership_checkout_reservations WHERE user_id = '$USER_I' AND status = 'retired' AND trial_days = 7")" == '1' ]] || {
  echo "Converted trial proof was not retained after retirement" >&2
  exit 1
}

RESERVE_J="$(psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_J', false, 'cus_zero_forgery', 'monthly', 'price_monthly',
    499, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )
")"
RESERVATION_J="$(psql_cmd -Atqc "SELECT '$RESERVE_J'::jsonb->>'reservation_id'")"
EXPIRES_J="$(psql_cmd -Atqc "SELECT '$RESERVE_J'::jsonb->>'checkout_expires_at'")"
psql_cmd -Atqc "
  SELECT public.bind_pro_membership_checkout_session_atomic(
    '$RESERVATION_J', '$USER_J', false, 'cus_zero_forgery', 'monthly',
    'price_monthly', 499, 'usd', 0::smallint, 'cs_zero_forgery', $EXPIRES_J
  )->>'status'
" | grep -qx 'bound'
expect_failure "
  SELECT public.convert_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_J', '$USER_J', false, 'cus_zero_forgery', 'monthly',
    'price_monthly', 499, 'usd', 0::smallint, 'cs_zero_forgery', 'sub_zero_forgery',
    'no_payment_required', 'trialing', 2000000000, 2000604800,
    'evt_zero_trial_forgery', 2000000700
  )
" 'zero-day reservation was forged into a trial'

RESERVE_K="$(psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_K', false, 'cus_trial_bind_race', 'monthly', 'price_monthly',
    499, 'usd', 7::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )
")"
RESERVATION_K="$(psql_cmd -Atqc "SELECT '$RESERVE_K'::jsonb->>'reservation_id'")"
EXPIRES_K="$(psql_cmd -Atqc "SELECT '$RESERVE_K'::jsonb->>'checkout_expires_at'")"
psql_cmd -c "
  INSERT INTO public.stripe_trial_entitlements (
    user_id, stripe_customer_id, stripe_subscription_id, plan,
    period_start, period_end, verified_at
  ) VALUES (
    '$USER_K', 'cus_trial_bind_race', 'sub_trial_race', 'monthly',
    pg_catalog.clock_timestamp(), pg_catalog.clock_timestamp() + interval '7 days',
    pg_catalog.clock_timestamp()
  )
" >/dev/null
expect_failure "
  SELECT public.bind_pro_membership_checkout_session_atomic(
    '$RESERVATION_K', '$USER_K', false, 'cus_trial_bind_race', 'monthly',
    'price_monthly', 499, 'usd', 7::smallint, 'cs_trial_bind_race', $EXPIRES_K
  )
" 'new permanent trial history did not block Session binding'

# Service-side observations can release only already-expired exact orphans.
# `absent_session` is limited to an unbound reserved row; a bound row requires
# one exact fresh expired Session identity. Concurrent replay is idempotent.
psql_cmd -c "
  WITH observed AS (
    SELECT pg_catalog.date_trunc(
      'second', pg_catalog.clock_timestamp() - interval '2 hours'
    ) AS created_at
  )
  INSERT INTO public.pro_membership_checkout_reservations (
    id, user_id, livemode, stripe_customer_id, pro_plan, stripe_price_id,
    unit_amount, currency, trial_days, success_url, cancel_url, status,
    checkout_expires_at, checkout_session_id, created_at, updated_at
  )
  SELECT
    'cccccccc-1111-4111-8111-cccccccccccc', '$USER_L', false,
    'cus_orphan_absent', 'monthly', 'price_monthly', 499, 'usd', 0,
    'https://www.arenafi.org/pricing/success', 'https://www.arenafi.org/pricing',
    'reserved', floor(extract(epoch FROM created_at))::bigint + 2700,
    NULL, created_at, created_at
  FROM observed;

  WITH observed AS (
    SELECT pg_catalog.date_trunc(
      'second', pg_catalog.clock_timestamp() - interval '2 hours'
    ) AS created_at
  )
  INSERT INTO public.pro_membership_checkout_reservations (
    id, user_id, livemode, stripe_customer_id, pro_plan, stripe_price_id,
    unit_amount, currency, trial_days, success_url, cancel_url, status,
    checkout_expires_at, checkout_session_id, created_at, updated_at
  )
  SELECT
    'dddddddd-1111-4111-8111-dddddddddddd', '$USER_M', false,
    'cus_orphan_expired', 'yearly', 'price_yearly', 2999, 'usd', 0,
    'https://www.arenafi.org/pricing/success', 'https://www.arenafi.org/pricing',
    'bound', floor(extract(epoch FROM created_at))::bigint + 2700,
    'cs_orphan_expired', created_at, created_at
  FROM observed;
" >/dev/null
OBSERVED_NOW="$(psql_cmd -Atqc "SELECT floor(extract(epoch FROM clock_timestamp()))::bigint")"
ABSENT_EXPIRES="$(psql_cmd -Atqc "SELECT checkout_expires_at FROM public.pro_membership_checkout_reservations WHERE user_id = '$USER_L'")"
EXPIRED_EXPIRES="$(psql_cmd -Atqc "SELECT checkout_expires_at FROM public.pro_membership_checkout_reservations WHERE user_id = '$USER_M'")"
for output in "$TMP_ROOT/absent-observation-1.out" "$TMP_ROOT/absent-observation-2.out"; do
  psql_cmd -Atqc "
    SELECT public.release_pro_membership_checkout_observation_atomic(
      'cccccccc-1111-4111-8111-cccccccccccc', '$USER_L', false,
      'cus_orphan_absent', 'monthly', 'price_monthly', 499, 'usd', 0::smallint,
      NULL, $ABSENT_EXPIRES, 'absent_session', $OBSERVED_NOW
    )->>'status'
  " >"$output" &
done
wait
OBSERVATION_RESULTS="$(
  sort "$TMP_ROOT/absent-observation-1.out" "$TMP_ROOT/absent-observation-2.out"
)"
[[ "$OBSERVATION_RESULTS" == $'already_released\nreleased' ]] || {
  echo "Concurrent absent-Session observations did not converge idempotently" >&2
  exit 1
}
psql_cmd -Atqc "
  SELECT public.release_pro_membership_checkout_observation_atomic(
    'dddddddd-1111-4111-8111-dddddddddddd', '$USER_M', false,
    'cus_orphan_expired', 'yearly', 'price_yearly', 2999, 'usd', 0::smallint,
    'cs_orphan_expired', $EXPIRED_EXPIRES, 'expired_session', $OBSERVED_NOW
  )->>'status'
" | grep -qx 'released'
expect_failure "
  SELECT public.release_pro_membership_checkout_observation_atomic(
    'dddddddd-1111-4111-8111-dddddddddddd', '$USER_M', false,
    'cus_orphan_expired', 'yearly', 'price_yearly', 2999, 'usd', 0::smallint,
    NULL, $EXPIRED_EXPIRES, 'absent_session', $OBSERVED_NOW
  )
" 'bound reservation was released from absent-Session evidence'
expect_failure "
  SELECT public.release_pro_membership_checkout_observation_atomic(
    '$(cat "$TMP_ROOT/monthly.out")', '$USER_A', false, 'cus_concurrent',
    '$WINNING_PLAN', '$WINNING_PRICE', $WINNING_AMOUNT, 'usd', 0::smallint,
    NULL,
    (SELECT checkout_expires_at FROM public.pro_membership_checkout_reservations WHERE id = '$(cat "$TMP_ROOT/monthly.out")'),
    'absent_session', $OBSERVED_NOW
  )
" 'unexpired reservation was released from an observation'
[[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.pro_membership_checkout_reservations WHERE status = 'released' AND terminal_event_id LIKE 'obs_pro_%'")" == '2' ]] || {
  echo "Fresh Stripe orphan observations did not converge to two released rows" >&2
  exit 1
}

# A signed expiration can release a Session whose bind response was lost, but
# neither an event predating the reservation nor a changed identity can do so.
RESERVE_C="$(psql_cmd -Atqc "
  SELECT public.reserve_pro_membership_checkout_atomic(
    '$USER_C', false, 'cus_expire', 'yearly', 'price_yearly',
    2999, 'usd', 0::smallint, 'https://www.arenafi.org/pricing/success',
    'https://www.arenafi.org/pricing'
  )
")"
RESERVATION_C="$(psql_cmd -Atqc "SELECT '$RESERVE_C'::jsonb->>'reservation_id'")"
EXPIRES_C="$(psql_cmd -Atqc "SELECT '$RESERVE_C'::jsonb->>'checkout_expires_at'")"
CREATED_C="$(psql_cmd -Atqc "SELECT floor(extract(epoch FROM created_at))::bigint FROM public.pro_membership_checkout_reservations WHERE id = '$RESERVATION_C'")"
expect_failure "
  SELECT public.release_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_C', '$USER_C', false, 'cus_expire', 'yearly',
    'price_yearly', 2999, 'usd', 0::smallint, 'cs_expire', $EXPIRES_C,
    'evt_too_early', $((CREATED_C - 1))
  )
" 'pre-reservation expiration event was accepted'
expect_failure "
  SELECT public.release_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_C', '$USER_C', false, 'cus_expire', 'monthly',
    'price_monthly', 499, 'usd', 0::smallint, 'cs_expire', $EXPIRES_C,
    'evt_wrong_plan', $CREATED_C
  )
" 'forged expiration product was accepted'
psql_cmd -Atqc "
  SELECT public.release_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_C', '$USER_C', false, 'cus_expire', 'yearly',
    'price_yearly', 2999, 'usd', 0::smallint, 'cs_expire', $EXPIRES_C,
    'evt_expire', $CREATED_C
  )->>'status'
" | grep -qx 'released'
psql_cmd -Atqc "
  SELECT public.release_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_C', '$USER_C', false, 'cus_expire', 'yearly',
    'price_yearly', 2999, 'usd', 0::smallint, 'cs_expire', $EXPIRES_C,
    'evt_expire', $CREATED_C
  )->>'status'
" | grep -qx 'already_released'
expect_failure "
  SELECT public.release_pro_membership_checkout_reservation_atomic(
    '$RESERVATION_C', '$USER_C', false, 'cus_expire', 'yearly',
    'price_yearly', 2999, 'usd', 0::smallint, 'cs_expire', $EXPIRES_C,
    'evt_other', $((CREATED_C + 1))
  )
" 'conflicting expiration replay was accepted'

# Browsers cannot inspect or mutate reservation rows and cannot call any of the
# four authorities. service_role can execute the function but still has no
# direct table grant, preserving the RPC-only boundary.
expect_failure "SET ROLE authenticated; SELECT * FROM public.pro_membership_checkout_reservations" \
  'authenticated read bypass survived RLS/ACL'
expect_failure "SET ROLE authenticated; SELECT public.reserve_pro_membership_checkout_atomic('$USER_A', false, 'cus_concurrent', 'monthly', 'price_monthly', 499, 'usd', 0::smallint, 'https://www.arenafi.org/a', 'https://www.arenafi.org/b')" \
  'authenticated function EXECUTE survived'
expect_failure "SET ROLE service_role; SELECT * FROM public.pro_membership_checkout_reservations" \
  'service role retained direct table access'

# Hostile grants and owners are converged by replay; an overload is rejected by
# the migration's exact inventory instead of silently becoming an alternate
# authority.
psql_cmd <<'SQL'
GRANT SELECT ON public.pro_membership_checkout_reservations TO authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_pro_membership_checkout_atomic(
  uuid, boolean, text, text, text, bigint, text, smallint, text, text
) TO authenticated;
ALTER FUNCTION public.bind_pro_membership_checkout_session_atomic(
  uuid, uuid, boolean, text, text, text, bigint, text, smallint, text, bigint
) OWNER TO hostile_role;
SQL
psql_cmd -f "$MIGRATION" >/dev/null
[[ "$(schema_hash)" == "$BASE_HASH" ]] || {
  echo "Migration did not restore the exact schema hash after hostile drift" >&2
  exit 1
}
expect_failure "SET ROLE authenticated; SELECT * FROM public.pro_membership_checkout_reservations" \
  'hostile table grant survived migration replay'
expect_failure "SET ROLE authenticated; SELECT public.reserve_pro_membership_checkout_atomic('$USER_A', false, 'cus_concurrent', 'monthly', 'price_monthly', 499, 'usd', 0::smallint, 'https://www.arenafi.org/a', 'https://www.arenafi.org/b')" \
  'hostile function grant survived migration replay'

psql_cmd <<'SQL'
CREATE FUNCTION public.reserve_pro_membership_checkout_atomic(p_user_id uuid)
RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';
ALTER FUNCTION public.reserve_pro_membership_checkout_atomic(uuid)
  OWNER TO hostile_role;
SQL
if psql_cmd -f "$MIGRATION" >/dev/null 2>&1; then
  echo "Migration accepted a hostile reservation authority overload" >&2
  exit 1
fi
psql_cmd -c 'DROP FUNCTION public.reserve_pro_membership_checkout_atomic(uuid)' >/dev/null

echo "Pro membership Checkout reservation PG17 proof passed"
