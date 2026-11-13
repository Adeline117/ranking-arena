#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the activation-v2 measurement contract.
# It owns an isolated temporary cluster and never connects to a remote DB.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803211000_b2c_activation_v2.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/b2c-activation-v2-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 8000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -160 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
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

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  created_at timestamptz NOT NULL,
  deleted_at timestamptz,
  last_seen_at timestamptz
);
CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL,
  status text NOT NULL,
  tier text NOT NULL
);
CREATE TABLE public.product_events (
  event_id uuid PRIMARY KEY,
  event_name text NOT NULL,
  user_id uuid REFERENCES auth.users(id),
  anonymous_id_hash text,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.user_activity_days (
  user_id uuid NOT NULL REFERENCES auth.users(id),
  activity_date date NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  heartbeat_count integer NOT NULL,
  PRIMARY KEY (user_id, activity_date)
);
SQL

psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
UPDATE public.product_metric_epochs
SET started_at = now() - interval '20 days'
WHERE metric_name = 'activation_7d';

INSERT INTO auth.users(id)
SELECT ('00000000-0000-4000-8000-' || pg_catalog.lpad(value::text, 12, '0'))::uuid
FROM pg_catalog.generate_series(1, 8) AS value;

INSERT INTO public.user_profiles(id, created_at, last_seen_at)
SELECT
  ('00000000-0000-4000-8000-' || pg_catalog.lpad(value::text, 12, '0'))::uuid,
  CASE
    WHEN value = 7 THEN now() - interval '25 days'
    WHEN value = 8 THEN now() - interval '3 days'
    ELSE now() - interval '10 days'
  END,
  now() - interval '1 day'
FROM pg_catalog.generate_series(1, 8) AS value;

-- User 1: detail day one plus a durable save day two => activated.
-- User 2: both qualifying actions on one UTC date => not activated.
-- User 3: opening the alert modal is not a durable retention action.
-- User 4: a persisted alert on day two => activated.
-- User 5: retention actions without a detail view => not activated.
-- User 6: the save at exactly registration+7 days is outside the strict window.
INSERT INTO public.product_events(event_id, event_name, user_id, properties, occurred_at)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'view_trader',
   '00000000-0000-4000-8000-000000000001', '{}', now() - interval '9 days'),
  ('10000000-0000-4000-8000-000000000002', 'save_trader',
   '00000000-0000-4000-8000-000000000001', '{}', now() - interval '8 days'),
  -- User 2's two actions must share one UTC day whatever time the proof runs:
  -- anchored at UTC noon, not now() - 9 days (+1h crossed midnight after 23:00 UTC).
  ('10000000-0000-4000-8000-000000000003', 'view_trader',
   '00000000-0000-4000-8000-000000000002', '{}',
   date_trunc('day', now(), 'UTC') - interval '9 days' + interval '12 hours'),
  ('10000000-0000-4000-8000-000000000004', 'follow_trader',
   '00000000-0000-4000-8000-000000000002', '{}',
   date_trunc('day', now(), 'UTC') - interval '9 days' + interval '13 hours'),
  ('10000000-0000-4000-8000-000000000005', 'view_trader',
   '00000000-0000-4000-8000-000000000003', '{}', now() - interval '9 days'),
  ('10000000-0000-4000-8000-000000000006', 'create_trader_alert',
   '00000000-0000-4000-8000-000000000003', '{"step":"open"}', now() - interval '8 days'),
  ('10000000-0000-4000-8000-000000000007', 'view_trader',
   '00000000-0000-4000-8000-000000000004', '{}', now() - interval '9 days'),
  ('10000000-0000-4000-8000-000000000008', 'create_trader_alert',
   '00000000-0000-4000-8000-000000000004', '{"step":"persisted"}', now() - interval '8 days'),
  ('10000000-0000-4000-8000-000000000009', 'save_trader',
   '00000000-0000-4000-8000-000000000005', '{}', now() - interval '9 days'),
  ('10000000-0000-4000-8000-000000000010', 'follow_trader',
   '00000000-0000-4000-8000-000000000005', '{}', now() - interval '8 days'),
  ('10000000-0000-4000-8000-000000000011', 'view_trader',
   '00000000-0000-4000-8000-000000000006', '{}', now() - interval '9 days'),
  ('10000000-0000-4000-8000-000000000012', 'save_trader',
   '00000000-0000-4000-8000-000000000006', '{}', now() - interval '3 days');
SQL

RESULT="$(
  psql_cmd -Atqc "
    SELECT
      (public.b2c_product_metrics(7)->>'activation_eligible') || ':' ||
      (public.b2c_product_metrics(7)->>'activated_7d') || ':' ||
      (public.b2c_product_metrics(7)->>'activation_definition_version');
  "
)"
EXPECTED='6:2:v2_detail_retention_two_utc_days'
if [[ "$RESULT" != "$EXPECTED" ]]; then
  echo "activation-v2 behavior mismatch: $RESULT" >&2
  exit 1
fi

if psql_cmd -v ON_ERROR_STOP=1 -c \
  'SET ROLE authenticated; SELECT public.b2c_product_metrics(7);' \
  >"$TMP_ROOT/authenticated.log" 2>&1; then
  echo 'authenticated unexpectedly executed the service-only metric function' >&2
  exit 1
fi

# The runtime role may read the immutable epoch but cannot shift the baseline.
SERVICE_EPOCH="$(
  psql_cmd -Atqc \
    "SET ROLE service_role; SELECT metric_name FROM public.product_metric_epochs;"
)"
if [[ "$SERVICE_EPOCH" != 'activation_7d' ]]; then
  echo "service_role could not read the activation epoch: $SERVICE_EPOCH" >&2
  exit 1
fi

SERVICE_METRIC="$(
  psql_cmd -Atqc \
    "SET ROLE service_role; SELECT public.b2c_product_metrics(7)->>'activation_definition_version';"
)"
if [[ "$SERVICE_METRIC" != 'v2_detail_retention_two_utc_days' ]]; then
  echo "service_role could not execute the activation metric: $SERVICE_METRIC" >&2
  exit 1
fi

if psql_cmd -v ON_ERROR_STOP=1 -c \
  "SET ROLE service_role; UPDATE public.product_metric_epochs SET started_at = now();" \
  >"$TMP_ROOT/service-write.log" 2>&1; then
  echo 'service_role unexpectedly rewrote the activation epoch' >&2
  exit 1
fi

echo 'B2C activation v2 PostgreSQL 17 proof passed'
