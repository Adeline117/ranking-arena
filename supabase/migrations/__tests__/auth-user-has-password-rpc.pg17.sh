#!/usr/bin/env bash

# Executable PostgreSQL 17 proof that the password-status RPC answers only a boolean and only to service_role.
# 

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261113151849_auth_user_has_password_rpc.sql"
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

TMP_ROOT="$(mktemp -d /tmp/has-password-pg17.XXXXXX)"
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
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, encrypted_password text);
INSERT INTO auth.users (id, email, encrypted_password) VALUES
  ('10000000-0000-4000-8000-000000000001', 'has@example.com', '$2a$10$hash'),
  ('10000000-0000-4000-8000-000000000002', 'code-only@example.com', NULL),
  ('10000000-0000-4000-8000-000000000003', 'empty@example.com', '');
SQL

psql_cmd -q -f "$MIGRATION"

as_role() {
  psql_cmd -Atq -c "SET ROLE $1; SELECT public.auth_user_has_password('$2');" 2>&1
}

RESULT="$(as_role service_role 10000000-0000-4000-8000-000000000001),$(as_role service_role 10000000-0000-4000-8000-000000000002),$(as_role service_role 10000000-0000-4000-8000-000000000003),$(as_role service_role 10000000-0000-4000-8000-00000000dead)"
if [[ "$RESULT" != "t,f,f,f" ]]; then
  echo "unexpected password status: $RESULT" >&2
  exit 1
fi

for role in anon authenticated; do
  if [[ "$(as_role "$role" 10000000-0000-4000-8000-000000000001)" != *"permission denied"* ]]; then
    echo "$role can read password status" >&2
    exit 1
  fi
done

# service_role gets the boolean without any direct access to the hash column.
if psql_cmd -q -c "SET ROLE service_role; SELECT encrypted_password FROM auth.users;" >/dev/null 2>&1; then
  echo "fixture error: service_role should not read auth.users directly here" >&2
  exit 1
fi

echo "password status RPC PostgreSQL 17 proof passed"
