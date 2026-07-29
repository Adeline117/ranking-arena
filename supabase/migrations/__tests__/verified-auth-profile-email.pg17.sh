#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729075400_verified_auth_profile_email.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/verified-auth-profile-email-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55593
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
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email varchar
);
ALTER TABLE auth.users OWNER TO postgres;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  banned_at timestamptz,
  deleted_at timestamptz
);
ALTER TABLE public.user_profiles OWNER TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'canonical@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'suspended-new@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'missing-profile@example.com'),
  ('44444444-4444-4444-8444-444444444444', NULL),
  ('55555555-5555-4555-8555-555555555555', 'race-old@example.com');

INSERT INTO public.user_profiles (id, email, banned_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'stale@example.com', NULL),
  ('22222222-2222-4222-8222-222222222222', 'suspended-old@example.com', '2026-07-29'),
  ('44444444-4444-4444-8444-444444444444', 'old-phone@example.com', NULL),
  ('55555555-5555-4555-8555-555555555555', 'race-old@example.com', NULL);
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF (SELECT email FROM public.user_profiles WHERE id =
      '11111111-1111-4111-8111-111111111111') <> 'canonical@example.com'
    OR (SELECT email FROM public.user_profiles WHERE id =
      '22222222-2222-4222-8222-222222222222') <> 'suspended-new@example.com'
    OR (SELECT email FROM public.user_profiles WHERE id =
      '44444444-4444-4444-8444-444444444444') IS NOT NULL
  THEN
    RAISE EXCEPTION 'migration backfill did not converge Auth emails';
  END IF;

  IF public.admit_verified_auth_profile_atomic(
      '11111111-1111-4111-8111-111111111111',
      'canonical@example.com'
    ) <> 'active'
    OR public.admit_verified_auth_profile_atomic(
      '22222222-2222-4222-8222-222222222222',
      'suspended-new@example.com'
    ) <> 'suspended'
    OR public.admit_verified_auth_profile_atomic(
      '33333333-3333-4333-8333-333333333333',
      'missing-profile@example.com'
    ) <> 'missing'
    OR public.admit_verified_auth_profile_atomic(
      '44444444-4444-4444-8444-444444444444',
      NULL
    ) <> 'active'
    OR public.admit_verified_auth_profile_atomic(
      '99999999-9999-4999-8999-999999999999',
      'absent@example.com'
    ) <> 'unavailable'
  THEN
    RAISE EXCEPTION 'verified profile admission acknowledgement mismatch';
  END IF;
END
$proof$;
SQL

expect_failure \
  "SET ROLE anon; SELECT public.admit_verified_auth_profile_atomic('11111111-1111-4111-8111-111111111111', 'canonical@example.com')" \
  'anon-execute'
expect_failure \
  "SET ROLE authenticated; SELECT public.admit_verified_auth_profile_atomic('11111111-1111-4111-8111-111111111111', 'canonical@example.com')" \
  'authenticated-execute'

if [[ "$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.admit_verified_auth_profile_atomic('11111111-1111-4111-8111-111111111111', 'canonical@example.com')")" != 'active' ]]; then
  echo 'service_role could not execute verified profile admission' >&2
  exit 1
fi

# Commit a newer Auth email while a request carrying the old verified value is
# queued on the same row. Admission must observe the winner and reject without
# rolling the profile projection back to the stale address.
psql_cmd >"$TMP_ROOT/email-writer.log" 2>&1 <<'SQL' &
BEGIN;
UPDATE auth.users
SET email = 'race-new@example.com'
WHERE id = '55555555-5555-4555-8555-555555555555';
SELECT pg_catalog.pg_sleep(1.25) /* verified-email-writer */;
COMMIT;
SQL
WRITER_PID=$!

for _ in {1..60}; do
  if [[ "$(psql_cmd -Atqc "SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE query LIKE '%verified-email-writer%' AND state = 'active'")" == '1' ]]; then
    break
  fi
  sleep 0.05
done

STALE_ACK="$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.admit_verified_auth_profile_atomic('55555555-5555-4555-8555-555555555555', 'race-old@example.com')")"
if ! wait "$WRITER_PID"; then
  cat "$TMP_ROOT/email-writer.log" >&2
  exit 1
fi
if [[ "$STALE_ACK" != 'unavailable' ]]; then
  echo "Stale verified email was admitted: $STALE_ACK" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT email FROM public.user_profiles WHERE id = '55555555-5555-4555-8555-555555555555'")" != 'race-old@example.com' ]]; then
  echo 'Stale admission mutated the profile email' >&2
  exit 1
fi

if [[ "$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.admit_verified_auth_profile_atomic('55555555-5555-4555-8555-555555555555', 'race-new@example.com')")" != 'active' ]]; then
  echo 'Current verified email was not admitted' >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT email FROM public.user_profiles WHERE id = '55555555-5555-4555-8555-555555555555'")" != 'race-new@example.com' ]]; then
  echo 'Current verified email did not converge the profile' >&2
  exit 1
fi

echo 'verified auth profile email pg17 proof passed'
