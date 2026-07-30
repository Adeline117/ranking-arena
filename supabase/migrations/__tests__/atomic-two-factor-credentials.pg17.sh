#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for atomic 2FA enrollment, backup-code rotation,
# disablement rollback, exact-secret binding, state guards, and ACLs.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729056000_atomic_two_factor_credentials.sql"
ACTIVE_PROFILE_MIGRATION="$ROOT_DIR/supabase/migrations/20260729163500_active_profile_two_factor_credentials.sql"
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

wait_for_subject_lock() {
  local user_id="$1"
  local acquired
  for _attempt in $(seq 1 150); do
    acquired="$(psql_cmd -qAtc "
      SELECT pg_catalog.pg_try_advisory_lock(
        pg_catalog.hashtextextended(
          'account-recovery-admission:' || '$user_id'::uuid::text,
          0
        )
      );
    ")"
    if [[ "$acquired" == 'f' ]]; then
      return 0
    fi
    sleep 0.02
  done
  echo "Timed out waiting for lifecycle lock: $user_id" >&2
  return 1
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
  totp_enabled boolean DEFAULT false,
  banned_at timestamptz,
  ban_expires_at timestamptz,
  deleted_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false
);
ALTER TABLE public.user_profiles OWNER TO postgres;

CREATE FUNCTION public.lock_account_lifecycle_subject_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_subject_id uuid;
BEGIN
  v_subject_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_subject_id::text,
      0
    )
  ) THEN
    RAISE EXCEPTION 'account lifecycle transition conflicts with a canonical writer'
      USING ERRCODE = '40001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.lock_account_lifecycle_subject_transition()
  OWNER TO postgres;

CREATE TRIGGER "000_account_lifecycle_subject_insert_delete_lock"
  BEFORE INSERT OR DELETE ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION
    public.lock_account_lifecycle_subject_transition();
CREATE TRIGGER "000_account_lifecycle_subject_status_lock"
  BEFORE UPDATE OF deleted_at, banned_at, is_banned, ban_expires_at
  ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION
    public.lock_account_lifecycle_subject_transition();

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
psql_cmd -f "$ACTIVE_PROFILE_MIGRATION" >/dev/null
psql_cmd -f "$ACTIVE_PROFILE_MIGRATION" >/dev/null

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

# Active-profile race fixtures cover each security mutation and both durable
# lifecycle outcomes without sharing subjects across independent proofs.
STAGE_RACE='20000000-0000-4000-8000-000000000001'
ENABLE_RACE='20000000-0000-4000-8000-000000000002'
ROTATE_RACE='20000000-0000-4000-8000-000000000003'
DISABLE_RACE='20000000-0000-4000-8000-000000000004'
MUTATION_FIRST='20000000-0000-4000-8000-000000000005'
STAGE_FAILURE='20000000-0000-4000-8000-000000000006'
ENABLE_FAILURE='20000000-0000-4000-8000-000000000007'

psql_cmd -q <<SQL
INSERT INTO auth.users (id) VALUES
  ('$STAGE_RACE'),
  ('$ENABLE_RACE'),
  ('$ROTATE_RACE'),
  ('$DISABLE_RACE'),
  ('$MUTATION_FIRST'),
  ('$STAGE_FAILURE'),
  ('$ENABLE_FAILURE');
INSERT INTO public.user_profiles (id, totp_enabled) VALUES
  ('$STAGE_RACE', false),
  ('$ENABLE_RACE', false),
  ('$ROTATE_RACE', true),
  ('$DISABLE_RACE', true),
  ('$MUTATION_FIRST', true),
  ('$STAGE_FAILURE', false),
  ('$ENABLE_FAILURE', false);
INSERT INTO public.user_2fa_secrets (user_id, totp_secret) VALUES
  ('$ENABLE_RACE', 'JBSWY3DPEHPK3PXP'),
  ('$ROTATE_RACE', 'JBSWY3DPEHPK3PXP'),
  ('$DISABLE_RACE', 'JBSWY3DPEHPK3PXP'),
  ('$MUTATION_FIRST', 'JBSWY3DPEHPK3PXP'),
  ('$ENABLE_FAILURE', 'JBSWY3DPEHPK3PXP');
INSERT INTO public.backup_codes (user_id, code_hash, used)
SELECT fixture.user_id, pg_catalog.lpad(series.value::text, 64, fixture.prefix), false
FROM (
  VALUES
    ('$ROTATE_RACE'::uuid, 'a'),
    ('$DISABLE_RACE'::uuid, 'b'),
    ('$MUTATION_FIRST'::uuid, 'c')
) AS fixture(user_id, prefix)
CROSS JOIN pg_catalog.generate_series(1, 8) AS series(value);
SQL

# A ban that owns the lifecycle order rejects queued enrollment staging.
psql_cmd -qAt <<SQL >"$TMP_ROOT/stage-ban.out" 2>"$TMP_ROOT/stage-ban.err" &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$STAGE_RACE'::uuid::text,
    0
  )
);
UPDATE public.user_profiles
SET banned_at = pg_catalog.clock_timestamp(), is_banned = true
WHERE id = '$STAGE_RACE';
SELECT pg_catalog.pg_sleep(0.75);
COMMIT;
SQL
stage_ban_pid=$!
wait_for_subject_lock "$STAGE_RACE"
expect_value \
  "ban wins enrollment staging race" \
  '{"status": "suspended"}' \
  "SELECT public.stage_two_factor_enrollment_secret_atomic(
    '$STAGE_RACE', 'JBSWY3DPEHPK3PXP'
  );"
wait "$stage_ban_pid"
if [[ "$(psql_cmd -qAtc "SELECT count(*) FROM public.user_2fa_secrets WHERE user_id = '$STAGE_RACE';")" != '0' ]]; then
  echo 'ban-first staging race persisted a secret' >&2
  exit 1
fi

# A soft deletion that owns the lifecycle order rejects queued enablement and
# preserves the staged, disabled generation exactly.
psql_cmd -qAt <<SQL >"$TMP_ROOT/enable-delete.out" 2>"$TMP_ROOT/enable-delete.err" &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$ENABLE_RACE'::uuid::text,
    0
  )
);
UPDATE public.user_profiles
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = '$ENABLE_RACE';
SELECT pg_catalog.pg_sleep(0.75);
COMMIT;
SQL
enable_delete_pid=$!
wait_for_subject_lock "$ENABLE_RACE"
expect_value \
  "deletion wins 2FA enablement race" \
  '{"status": "suspended"}' \
  "SELECT public.enable_two_factor_credentials_atomic(
    '$ENABLE_RACE', 'JBSWY3DPEHPK3PXP', $HASHES_ONE
  );"
wait "$enable_delete_pid"
if [[ "$(psql_cmd -qAtc "
  SELECT profile.totp_enabled::text || '|' ||
    count(DISTINCT secret_row.user_id) || '|' ||
    count(DISTINCT backup_code.id)
  FROM public.user_profiles AS profile
  LEFT JOIN public.user_2fa_secrets AS secret_row
    ON secret_row.user_id = profile.id
  LEFT JOIN public.backup_codes AS backup_code
    ON backup_code.user_id = profile.id
  WHERE profile.id = '$ENABLE_RACE'
  GROUP BY profile.totp_enabled;
")" != 'false|1|0' ]]; then
  echo 'deletion-first enablement race changed credentials' >&2
  exit 1
fi

# A ban rejects queued backup-code rotation without replacing any hash and the
# enrollment-secret read never discloses a suspended subject's secret.
rotate_hash_before="$(psql_cmd -qAtc "SELECT string_agg(code_hash, ',' ORDER BY code_hash) FROM public.backup_codes WHERE user_id = '$ROTATE_RACE';")"
psql_cmd -qAt <<SQL >"$TMP_ROOT/rotate-ban.out" 2>"$TMP_ROOT/rotate-ban.err" &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$ROTATE_RACE'::uuid::text,
    0
  )
);
UPDATE public.user_profiles
SET banned_at = pg_catalog.clock_timestamp(), is_banned = true
WHERE id = '$ROTATE_RACE';
SELECT pg_catalog.pg_sleep(0.75);
COMMIT;
SQL
rotate_ban_pid=$!
wait_for_subject_lock "$ROTATE_RACE"
expect_value \
  "ban wins backup-code rotation race" \
  '{"status": "suspended"}' \
  "SELECT public.rotate_two_factor_backup_codes_atomic(
    '$ROTATE_RACE', $HASHES_TWO
  );"
wait "$rotate_ban_pid"
if [[ "$(psql_cmd -qAtc "SELECT string_agg(code_hash, ',' ORDER BY code_hash) FROM public.backup_codes WHERE user_id = '$ROTATE_RACE';")" != "$rotate_hash_before" ]]; then
  echo 'ban-first rotation race replaced backup hashes' >&2
  exit 1
fi
expect_value \
  "suspended enrollment secret is not disclosed" \
  '{"status": "suspended"}' \
  "SELECT public.read_two_factor_enrollment_secret('$ROTATE_RACE');"

# Deletion also blocks the credential-downgrade path: a stale authenticated
# password proof cannot disable credentials that will be needed on recovery.
psql_cmd -qAt <<SQL >"$TMP_ROOT/disable-delete.out" 2>"$TMP_ROOT/disable-delete.err" &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$DISABLE_RACE'::uuid::text,
    0
  )
);
UPDATE public.user_profiles
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = '$DISABLE_RACE';
SELECT pg_catalog.pg_sleep(0.75);
COMMIT;
SQL
disable_delete_pid=$!
wait_for_subject_lock "$DISABLE_RACE"
expect_value \
  "deletion wins 2FA disablement race" \
  '{"status": "suspended"}' \
  "SELECT public.disable_two_factor_credentials_atomic('$DISABLE_RACE');"
wait "$disable_delete_pid"
if [[ "$(psql_cmd -qAtc "
  SELECT profile.totp_enabled::text || '|' ||
    count(DISTINCT secret_row.user_id) || '|' ||
    count(DISTINCT backup_code.id)
  FROM public.user_profiles AS profile
  LEFT JOIN public.user_2fa_secrets AS secret_row
    ON secret_row.user_id = profile.id
  LEFT JOIN public.backup_codes AS backup_code
    ON backup_code.user_id = profile.id
  WHERE profile.id = '$DISABLE_RACE'
  GROUP BY profile.totp_enabled;
")" != 'true|1|8' ]]; then
  echo 'deletion-first disablement race weakened credentials' >&2
  exit 1
fi

# The inverse durable order is valid too: rotation commits, then the canonical
# deletion transition acquires the same lifecycle key. Runtime pre-release
# admission is responsible for withholding the now-invalid plaintext codes.
psql_cmd -qAt <<SQL >"$TMP_ROOT/mutation-first.out" 2>"$TMP_ROOT/mutation-first.err" &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.rotate_two_factor_backup_codes_atomic(
  '$MUTATION_FIRST', $HASHES_TWO
);
SELECT pg_catalog.pg_sleep(0.75);
COMMIT;
SQL
mutation_first_pid=$!
wait_for_subject_lock "$MUTATION_FIRST"
psql_cmd -qAt <<SQL >/dev/null
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$MUTATION_FIRST'::uuid::text,
    0
  )
);
UPDATE public.user_profiles
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = '$MUTATION_FIRST';
COMMIT;
SQL
wait "$mutation_first_pid"
if [[ "$(awk '/"status": "rotated"/ { print $0 }' "$TMP_ROOT/mutation-first.out")" != '{"status": "rotated", "code_count": 8}' ]]; then
  echo 'mutation-first rotation did not commit exactly once' >&2
  exit 1
fi
if [[ "$(psql_cmd -qAtc "
  SELECT (deleted_at IS NOT NULL)::text || '|' || count(backup_code.id)
  FROM public.user_profiles AS profile
  LEFT JOIN public.backup_codes AS backup_code
    ON backup_code.user_id = profile.id
  WHERE profile.id = '$MUTATION_FIRST'
  GROUP BY profile.deleted_at;
")" != 'true|8' ]]; then
  echo 'mutation-first lifecycle ordering drifted' >&2
  exit 1
fi

# Stage and enable failures roll back their entire credential generation;
# rotation and disable rollback are proven above by the original suite.
psql_cmd <<SQL
CREATE FUNCTION public.reject_selected_two_factor_writes()
RETURNS trigger
LANGUAGE plpgsql
AS \$function\$
BEGIN
  IF TG_TABLE_NAME = 'user_2fa_secrets'
    AND NEW.user_id = '$STAGE_FAILURE'::uuid
  THEN
    RAISE EXCEPTION 'injected staging failure';
  END IF;
  IF TG_TABLE_NAME = 'backup_codes'
    AND NEW.user_id = '$ENABLE_FAILURE'::uuid
  THEN
    RAISE EXCEPTION 'injected enablement failure';
  END IF;
  RETURN NEW;
END
\$function\$;
CREATE TRIGGER reject_selected_secret_write
  BEFORE INSERT OR UPDATE ON public.user_2fa_secrets
  FOR EACH ROW EXECUTE FUNCTION public.reject_selected_two_factor_writes();
CREATE TRIGGER reject_selected_backup_write
  BEFORE INSERT ON public.backup_codes
  FOR EACH ROW EXECUTE FUNCTION public.reject_selected_two_factor_writes();
SQL
expect_failure \
  "failed staging leaves no secret" \
  "SELECT public.stage_two_factor_enrollment_secret_atomic(
    '$STAGE_FAILURE', 'JBSWY3DPEHPK3PXP'
  );"
if [[ "$(psql_cmd -qAtc "SELECT count(*) FROM public.user_2fa_secrets WHERE user_id = '$STAGE_FAILURE';")" != '0' ]]; then
  echo 'failed staging left a partial secret' >&2
  exit 1
fi
expect_failure \
  "failed enablement restores staged disabled state" \
  "SELECT public.enable_two_factor_credentials_atomic(
    '$ENABLE_FAILURE', 'JBSWY3DPEHPK3PXP', $HASHES_ONE
  );"
if [[ "$(psql_cmd -qAtc "
  SELECT profile.totp_enabled::text || '|' ||
    count(DISTINCT secret_row.user_id) || '|' ||
    count(DISTINCT backup_code.id)
  FROM public.user_profiles AS profile
  LEFT JOIN public.user_2fa_secrets AS secret_row
    ON secret_row.user_id = profile.id
  LEFT JOIN public.backup_codes AS backup_code
    ON backup_code.user_id = profile.id
  WHERE profile.id = '$ENABLE_FAILURE'
  GROUP BY profile.totp_enabled;
")" != 'false|1|0' ]]; then
  echo 'failed enablement did not restore staged disabled state' >&2
  exit 1
fi

echo "Atomic active-profile 2FA credential PostgreSQL 17 proof passed."
