#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EMAIL_MIGRATION="$ROOT_DIR/supabase/migrations/20260729075400_verified_auth_profile_email.sql"
BAN_MIGRATION="$ROOT_DIR/supabase/migrations/20260729075600_verified_auth_profile_ban_authority.sql"
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

TMP_ROOT="$(mktemp -d /tmp/verified-auth-profile-ban-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55595
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
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  banned_at timestamptz,
  ban_expires_at timestamptz,
  deleted_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false
);
ALTER TABLE public.user_profiles OWNER TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, authenticator, service_role;

INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'active@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'permanent@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'temporary@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'expired@example.com'),
  ('55555555-5555-4555-8555-555555555555', 'deleted@example.com'),
  ('66666666-6666-4666-8666-666666666666', 'modern-ban@example.com');

INSERT INTO public.user_profiles (
  id,
  email,
  banned_at,
  ban_expires_at,
  deleted_at,
  is_banned
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'stale@example.com', NULL, NULL, NULL, false),
  ('22222222-2222-4222-8222-222222222222', 'permanent@example.com', NULL, NULL, NULL, true),
  ('33333333-3333-4333-8333-333333333333', 'temporary@example.com', NULL, '2999-01-01', NULL, true),
  ('44444444-4444-4444-8444-444444444444', 'expired@example.com', NULL, '2000-01-01', NULL, true),
  ('55555555-5555-4555-8555-555555555555', 'deleted@example.com', NULL, NULL, '2026-07-29', false),
  ('66666666-6666-4666-8666-666666666666', 'modern-ban@example.com', '2026-07-29', NULL, NULL, false);
SQL

psql_cmd -f "$EMAIL_MIGRATION" >/dev/null
psql_cmd -f "$BAN_MIGRATION" >/dev/null
psql_cmd -f "$BAN_MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF public.admit_verified_auth_profile_atomic(
      '11111111-1111-4111-8111-111111111111',
      'active@example.com'
    ) <> 'active'
    OR public.admit_verified_auth_profile_atomic(
      '22222222-2222-4222-8222-222222222222',
      'permanent@example.com'
    ) <> 'suspended'
    OR public.admit_verified_auth_profile_atomic(
      '33333333-3333-4333-8333-333333333333',
      'temporary@example.com'
    ) <> 'suspended'
    OR public.admit_verified_auth_profile_atomic(
      '44444444-4444-4444-8444-444444444444',
      'expired@example.com'
    ) <> 'active'
    OR public.admit_verified_auth_profile_atomic(
      '55555555-5555-4555-8555-555555555555',
      'deleted@example.com'
    ) <> 'suspended'
    OR public.admit_verified_auth_profile_atomic(
      '66666666-6666-4666-8666-666666666666',
      'modern-ban@example.com'
    ) <> 'suspended'
    OR public.admit_verified_auth_profile_atomic(
      '11111111-1111-4111-8111-111111111111',
      'stale@example.com'
    ) <> 'unavailable'
  THEN
    RAISE EXCEPTION 'verified profile ban admission result mismatch';
  END IF;

  IF (SELECT email FROM public.user_profiles WHERE id =
      '11111111-1111-4111-8111-111111111111') <> 'active@example.com' THEN
    RAISE EXCEPTION 'verified Auth email convergence regressed';
  END IF;
END
$proof$;
SQL

if [[ "$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.admit_verified_auth_profile_atomic('11111111-1111-4111-8111-111111111111', 'active@example.com')")" != 'active' ]]; then
  echo 'service role could not execute verified profile admission' >&2
  exit 1
fi
expect_failure \
  "SET ROLE anon; SELECT public.admit_verified_auth_profile_atomic('11111111-1111-4111-8111-111111111111', 'active@example.com')" \
  'anon-execute'
expect_failure \
  "SET ROLE authenticated; SELECT public.admit_verified_auth_profile_atomic('11111111-1111-4111-8111-111111111111', 'active@example.com')" \
  'authenticated-execute'
expect_failure \
  "SET ROLE authenticator; SELECT public.admit_verified_auth_profile_atomic('11111111-1111-4111-8111-111111111111', 'active@example.com')" \
  'authenticator-execute'

echo 'verified Auth profile ban authority pg17 proof passed'
