#!/usr/bin/env bash

# Executable PostgreSQL 17 proof that follow activity handles and metadata do
# not cross exchanges that reuse one raw trader id.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260718131000_source_scope_trader_follow_activity.sql"
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

TMP_ROOT="$(mktemp -d /tmp/follow-activity-source-pg17.XXXXXX)"
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
CREATE TABLE public.trader_sources (
  source text NOT NULL,
  source_trader_id text NOT NULL,
  handle text
);

CREATE TABLE public.user_activities (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  activity_type text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  metadata jsonb NOT NULL
);

CREATE TABLE public.trader_follows (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  trader_id text NOT NULL,
  source text
);

CREATE FUNCTION public.log_trader_follow_activity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN NEW;
END
$$;

CREATE TRIGGER trg_log_trader_follow_activity
AFTER INSERT ON public.trader_follows
FOR EACH ROW EXECUTE FUNCTION public.log_trader_follow_activity();

INSERT INTO public.trader_sources (
  source, source_trader_id, handle
) VALUES
  ('bybit', 'shared-id', 'Bybit Alpha'),
  ('binance', 'shared-id', 'Binance Alpha');
SQL

psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
INSERT INTO public.trader_follows (
  id, user_id, trader_id, source
) VALUES
  ('10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000001',
   'shared-id', 'bybit'),
  ('10000000-0000-4000-8000-000000000002',
   '20000000-0000-4000-8000-000000000002',
   'shared-id', 'binance'),
  ('10000000-0000-4000-8000-000000000003',
   '20000000-0000-4000-8000-000000000003',
   'shared-id', NULL);
SQL

RESULT="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.string_agg(
      COALESCE(metadata->>'source', 'NULL') || ':' ||
      COALESCE(metadata->>'trader_handle', '') || ':' ||
      (metadata->'identity_key')::text,
      ',' ORDER BY id
    )
    FROM public.user_activities;
  "
)"
EXPECTED='bybit:Bybit Alpha:["shared-id", "bybit"],binance:Binance Alpha:["shared-id", "binance"],NULL::["shared-id", null]'
if [[ "$RESULT" != "$EXPECTED" ]]; then
  echo "follow activity crossed source identity or guessed legacy data: $RESULT" >&2
  exit 1
fi

echo "source-scoped trader follow activity PostgreSQL 17 proof passed"
