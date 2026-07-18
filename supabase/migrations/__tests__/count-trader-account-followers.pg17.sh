#!/usr/bin/env bash

# Executable PostgreSQL 17 proof that follower counts remain account-scoped
# when two exchanges reuse the same raw trader id.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260718130000_count_trader_account_followers.sql"
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

TMP_ROOT="$(mktemp -d /tmp/account-followers-pg17.XXXXXX)"
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
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.trader_follows (
  user_id uuid NOT NULL,
  trader_id text NOT NULL,
  source text
);

INSERT INTO public.trader_follows (
  user_id, trader_id, source
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'shared-id', 'bybit'),
  ('10000000-0000-4000-8000-000000000002', 'shared-id', 'bybit'),
  ('10000000-0000-4000-8000-000000000003', 'shared-id', 'binance'),
  ('10000000-0000-4000-8000-000000000004', 'solo-id', 'bybit'),
  ('10000000-0000-4000-8000-000000000005', 'shared-id', NULL);
SQL

psql_cmd -q -f "$MIGRATION"

RESULT="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.string_agg(
      trader_id || ':' || source || ':' || cnt,
      ',' ORDER BY trader_id, source
    )
    FROM public.count_trader_account_followers(
      ARRAY['shared-id', 'shared-id', 'solo-id', 'shared-id'],
      ARRAY['bybit', 'binance', 'bybit', 'bybit']
    );
  "
)"
if [[ "$RESULT" != "shared-id:binance:1,shared-id:bybit:2,solo-id:bybit:1" ]]; then
  echo "account follower counts merged sources or duplicate requests: $RESULT" >&2
  exit 1
fi

if psql_cmd -q -c "
  SELECT *
  FROM public.count_trader_account_followers(
    ARRAY['shared-id'],
    ARRAY['bybit', 'binance']
  );
" >/dev/null 2>&1; then
  echo "mismatched account arrays unexpectedly succeeded" >&2
  exit 1
fi

if psql_cmd -q -c "
  SELECT *
  FROM public.count_trader_account_followers(
    ARRAY['shared-id'],
    ARRAY['']
  );
" >/dev/null 2>&1; then
  echo "empty account source unexpectedly succeeded" >&2
  exit 1
fi

echo "source-scoped trader follower count PostgreSQL 17 proof passed"
