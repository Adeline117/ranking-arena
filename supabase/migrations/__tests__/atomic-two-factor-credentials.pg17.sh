#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for atomic 2FA enrollment, backup-code rotation,
# disablement rollback, exact-secret binding, state guards, and ACLs.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729056000_atomic_two_factor_credentials.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-two-factor-pg17.XXXXXX)"
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
  local role="${3:-service_role}"
  local claim="${4:-service_role}"
  local output="$TMP_ROOT/expected-failure.out"
  if psql_cmd -qAtc "
    SET ROLE $role;
    SET request.jwt.claim.role = '$claim';
    $sql
    RESET ROLE;
  " >"$output" 2>&1; then
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

GRANT service_role TO authenticator
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role, authenticator;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT pg_catalog.current_setting('request.jwt.claim.role', true)
$function$;
ALTER FUNCTION auth.role() OWNER TO postgres;
GRANT USAGE ON SCHEMA auth TO service_role, authenticated;
GRANT EXECUTE ON FUNCTION auth.role() TO service_role, authenticated;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
ALTER TABLE auth.users OWNER TO postgres;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  totp_enabled boolean DEFAULT false
);
ALTER TABLE public.user_profiles OWNER TO postgres;

CREATE TABLE public.backup_codes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used boolean DEFAULT false,
  used_at timestamptz,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public.backup_codes OWNER TO postgres;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.backup_codes
  TO authenticated, service_role;
GRANT SELECT, UPDATE ON public.user_profiles TO service_role;

INSERT INTO auth.users (id) VALUES
  ('10000000-0000-4000-8000-000000000001'),
  ('10000000-0000-4000-8000-000000000002'),
  ('10000000-0000-4000-8000-000000000003');
INSERT INTO public.user_profiles (id, totp_enabled) VALUES
  ('10000000-0000-4000-8000-000000000001', false),
  ('10000000-0000-4000-8000-000000000002', false),
  ('10000000-0000-4000-8000-000000000003', true);
INSERT INTO public.backup_codes (user_id, code_hash, used) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    pg_catalog.repeat('a', 64),
    false
  );
SQL

psql_cmd -f "$MIGRATION" >/dev/null

HASHES_ONE="ARRAY[
  repeat('1', 64), repeat('2', 64), repeat('3', 64), repeat('4', 64),
  repeat('5', 64), repeat('6', 64), repeat('7', 64), repeat('8', 64)
]::text[]"
HASHES_TWO="ARRAY[
  repeat('9', 64), repeat('a', 64), repeat('b', 64), repeat('c', 64),
  repeat('d', 64), repeat('e', 64), repeat('f', 64), repeat('0', 64)
]::text[]"

expect_failure \
  "authenticated RPC execution is closed" \
  "SELECT public.disable_two_factor_credentials_atomic(
    '10000000-0000-4000-8000-000000000001'
  );" \
  authenticated \
  authenticated

expect_failure \
  "authenticated direct backup mutation is closed" \
  "INSERT INTO public.backup_codes (user_id, code_hash)
   VALUES (
     '10000000-0000-4000-8000-000000000001',
     repeat('b', 64)
   );" \
  authenticated \
  authenticated

expect_value \
  "invalid hash count is rejected" \
  '{"status": "invalid_codes"}' \
  "SELECT public.rotate_two_factor_backup_codes_atomic(
    '10000000-0000-4000-8000-000000000003',
    ARRAY[repeat('1', 64)]::text[]
  );"

expect_value \
  "stage enrollment secret" \
  '{"status": "staged"}' \
  "SELECT public.stage_two_factor_enrollment_secret_atomic(
    '10000000-0000-4000-8000-000000000001',
    'JBSWY3DPEHPK3PXP'
  );"

expect_value \
  "read staged enrollment secret" \
  '{"status": "ready", "totp_secret": "JBSWY3DPEHPK3PXP"}' \
  "SELECT public.read_two_factor_enrollment_secret(
    '10000000-0000-4000-8000-000000000001'
  );"

expect_value \
  "wrong verified secret preserves disabled credentials" \
  '{"status": "secret_changed"}' \
  "SELECT public.enable_two_factor_credentials_atomic(
    '10000000-0000-4000-8000-000000000001',
    'JBSWY3DPEHPK3PXQ',
    $HASHES_ONE
  );"

if [[ "$(psql_cmd -qAtc "
  SELECT
    profile.totp_enabled::text || '|' ||
    pg_catalog.count(backup_code.id)::text || '|' ||
    pg_catalog.min(backup_code.code_hash)
  FROM public.user_profiles AS profile
  LEFT JOIN public.backup_codes AS backup_code
    ON backup_code.user_id = profile.id
  WHERE profile.id = '10000000-0000-4000-8000-000000000001'
  GROUP BY profile.totp_enabled;
")" != "false|1|$(printf 'a%.0s' {1..64})" ]]; then
  echo "wrong verified secret changed disabled credentials" >&2
  exit 1
fi

expect_value \
  "enable with exact verified secret" \
  '{"status": "enabled", "code_count": 8}' \
  "SELECT public.enable_two_factor_credentials_atomic(
    '10000000-0000-4000-8000-000000000001',
    'JBSWY3DPEHPK3PXP',
    $HASHES_ONE
  );"

if [[ "$(psql_cmd -qAtc "
  SELECT profile.totp_enabled::text || '|' || pg_catalog.count(backup_code.id)
  FROM public.user_profiles AS profile
  LEFT JOIN public.backup_codes AS backup_code
    ON backup_code.user_id = profile.id
  WHERE profile.id = '10000000-0000-4000-8000-000000000001'
  GROUP BY profile.totp_enabled;
")" != "true|8" ]]; then
  echo "enablement did not publish one complete credential set" >&2
  exit 1
fi

psql_cmd <<'SQL'
CREATE FUNCTION public.reject_two_factor_backup_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'injected backup insert failure';
END
$function$;
CREATE TRIGGER reject_two_factor_backup_insert
BEFORE INSERT ON public.backup_codes
FOR EACH ROW EXECUTE FUNCTION public.reject_two_factor_backup_insert();
SQL

expect_failure \
  "failed rotation restores old backup codes" \
  "SELECT public.rotate_two_factor_backup_codes_atomic(
    '10000000-0000-4000-8000-000000000001',
    $HASHES_TWO
  );"

if [[ "$(psql_cmd -qAtc "
  SELECT pg_catalog.count(*) || '|' || pg_catalog.min(code_hash)
  FROM public.backup_codes
  WHERE user_id = '10000000-0000-4000-8000-000000000001';
")" != "8|$(printf '1%.0s' {1..64})" ]]; then
  echo "failed rotation did not restore old backup codes" >&2
  exit 1
fi

psql_cmd -qAtc "
  DROP TRIGGER reject_two_factor_backup_insert ON public.backup_codes;
  DROP FUNCTION public.reject_two_factor_backup_insert();
" >/dev/null

expect_value \
  "successful backup code rotation" \
  '{"status": "rotated", "code_count": 8}' \
  "SELECT public.rotate_two_factor_backup_codes_atomic(
    '10000000-0000-4000-8000-000000000001',
    $HASHES_TWO
  );"

psql_cmd <<'SQL'
CREATE FUNCTION public.reject_two_factor_secret_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'injected secret delete failure';
END
$function$;
CREATE TRIGGER reject_two_factor_secret_delete
BEFORE DELETE ON public.user_2fa_secrets
FOR EACH ROW EXECUTE FUNCTION public.reject_two_factor_secret_delete();
SQL

expect_failure \
  "failed disable restores enabled credentials" \
  "SELECT public.disable_two_factor_credentials_atomic(
    '10000000-0000-4000-8000-000000000001'
  );"

if [[ "$(psql_cmd -qAtc "
  SELECT
    profile.totp_enabled::text || '|' ||
    pg_catalog.count(DISTINCT backup_code.id) || '|' ||
    pg_catalog.count(DISTINCT secret_row.user_id)
  FROM public.user_profiles AS profile
  LEFT JOIN public.backup_codes AS backup_code
    ON backup_code.user_id = profile.id
  LEFT JOIN public.user_2fa_secrets AS secret_row
    ON secret_row.user_id = profile.id
  WHERE profile.id = '10000000-0000-4000-8000-000000000001'
  GROUP BY profile.totp_enabled;
")" != "true|8|1" ]]; then
  echo "failed disable did not restore enabled credentials" >&2
  exit 1
fi

psql_cmd -qAtc "
  DROP TRIGGER reject_two_factor_secret_delete ON public.user_2fa_secrets;
  DROP FUNCTION public.reject_two_factor_secret_delete();
" >/dev/null

expect_value \
  "successful disable removes every credential" \
  '{"status": "disabled", "code_count": 8, "secret_count": 1}' \
  "SELECT public.disable_two_factor_credentials_atomic(
    '10000000-0000-4000-8000-000000000001'
  );"

if [[ "$(psql_cmd -qAtc "
  SELECT
    profile.totp_enabled::text || '|' ||
    pg_catalog.count(DISTINCT backup_code.id) || '|' ||
    pg_catalog.count(DISTINCT secret_row.user_id)
  FROM public.user_profiles AS profile
  LEFT JOIN public.backup_codes AS backup_code
    ON backup_code.user_id = profile.id
  LEFT JOIN public.user_2fa_secrets AS secret_row
    ON secret_row.user_id = profile.id
  WHERE profile.id = '10000000-0000-4000-8000-000000000001'
  GROUP BY profile.totp_enabled;
")" != "false|0|0" ]]; then
  echo "successful disable left credential state behind" >&2
  exit 1
fi

expect_value \
  "enabled state without a secret fails rotation closed" \
  '{"status": "credential_inconsistent"}' \
  "SELECT public.rotate_two_factor_backup_codes_atomic(
    '10000000-0000-4000-8000-000000000003',
    $HASHES_ONE
  );"

echo "Atomic 2FA credential PostgreSQL 17 proof passed."
