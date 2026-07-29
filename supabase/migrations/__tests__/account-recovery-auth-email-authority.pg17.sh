#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729075500_account_recovery_auth_email_authority.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo 'This integration proof requires PostgreSQL 17' >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/account-recovery-auth-email-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55594
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
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
  local failure_log="$TMP_ROOT/${label}.log"
  if psql_cmd -c "$sql" >"$failure_log" 2>&1; then
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
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email varchar
);
ALTER TABLE auth.users OWNER TO postgres;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  email text
);
ALTER TABLE public.user_profiles OWNER TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, authenticator, service_role;

INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'current-new@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'reused-old@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'Duplicate@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'duplicate@example.com'),
  ('55555555-5555-4555-8555-555555555555', NULL);

-- The deleted subject's application projection is deliberately stale while
-- the old address belongs to another current Auth identity.
INSERT INTO public.user_profiles (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'reused-old@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'reused-old@example.com');
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

if [[ "$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.resolve_account_recovery_auth_subject('  CURRENT-NEW@example.com  ')")" != '11111111-1111-4111-8111-111111111111' ]]; then
  echo 'Current Auth email did not resolve its exact subject' >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.resolve_account_recovery_auth_subject('reused-old@example.com')")" != '22222222-2222-4222-8222-222222222222' ]]; then
  echo 'Reassigned email resolved from the stale profile instead of Auth' >&2
  exit 1
fi

for email in 'absent@example.com' 'duplicate@example.com' ''; do
  if [[ -n "$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.resolve_account_recovery_auth_subject('$email')")" ]]; then
    echo "Invalid or ambiguous Auth email resolved: $email" >&2
    exit 1
  fi
done

expect_failure \
  "SET ROLE anon; SELECT public.resolve_account_recovery_auth_subject('current-new@example.com')" \
  'anon-execute'
expect_failure \
  "SET ROLE authenticated; SELECT public.resolve_account_recovery_auth_subject('current-new@example.com')" \
  'authenticated-execute'
expect_failure \
  "SET ROLE authenticator; SELECT public.resolve_account_recovery_auth_subject('current-new@example.com')" \
  'authenticator-execute'

echo 'account recovery Auth email authority pg17 proof passed'
