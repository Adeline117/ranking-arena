#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729158500_siwe_active_profile_wallet_admission.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo 'This integration proof requires PostgreSQL 17' >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/siwe-active-wallet-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55685
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_eq() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

expect_failure_matching() {
  local sql="$1"
  local label="$2"
  local pattern="$3"
  local failure_log="$LOG_DIR/$label.log"
  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "Expected failure: $label" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$failure_log"; then
    echo "Failure did not match $pattern: $label" >&2
    cat "$failure_log" >&2
    exit 1
  fi
}

wait_for_subject_lock() {
  local user_id="$1"
  local attempt
  local acquired
  for attempt in $(seq 1 100); do
    acquired="$(psql_cmd -Atqc "
      SELECT pg_catalog.pg_try_advisory_lock(
        pg_catalog.hashtextextended(
          'account-recovery-admission:' || '$user_id'::uuid::text,
          0
        )
      )
    ")"
    if [[ "$acquired" == 'f' ]]; then
      return 0
    fi
    sleep 0.02
  done
  echo "Timed out waiting for lifecycle lock: $user_id" >&2
  exit 1
}

ACTIVE='11111111-1111-4111-8111-111111111111'
BANNED='22222222-2222-4222-8222-222222222222'
DELETED='33333333-3333-4333-8333-333333333333'
EXPIRED='44444444-4444-4444-8444-444444444444'
CONFLICT='55555555-5555-4555-8555-555555555555'
COMPETE_A='66666666-6666-4666-8666-666666666666'
COMPETE_B='77777777-7777-4777-8777-777777777777'
FAILURE='88888888-8888-4888-8888-888888888888'
BAN_RACE='99999999-9999-4999-8999-999999999999'
DELETE_RACE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

WALLET_ACTIVE='0x1111111111111111111111111111111111111111'
WALLET_OTHER='0x2222222222222222222222222222222222222222'
WALLET_CONFLICT='0x3333333333333333333333333333333333333333'
WALLET_EXPIRED='0x4444444444444444444444444444444444444444'
WALLET_COMPETE='0x5555555555555555555555555555555555555555'
WALLET_FAILURE='0x6666666666666666666666666666666666666666'
WALLET_BAN_RACE='0x7777777777777777777777777777777777777777'
WALLET_DELETE_RACE='0x8888888888888888888888888888888888888888'

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;

CREATE SCHEMA auth AUTHORIZATION postgres;

CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  )
$function$;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY,
  email varchar
);

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle text NOT NULL,
  email text,
  wallet_address text,
  banned_at timestamptz,
  ban_expires_at timestamptz,
  deleted_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false
);

ALTER TABLE auth.users OWNER TO postgres;
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER FUNCTION auth.role() OWNER TO postgres;

ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_wallet_address_shape_check
  CHECK (
    wallet_address IS NULL
    OR (
      wallet_address = pg_catalog.lower(wallet_address)
      AND wallet_address ~ '^0x[0-9a-f]{40}$'
    )
  );
CREATE UNIQUE INDEX user_profiles_wallet_address_lower_unique
  ON public.user_profiles (pg_catalog.lower(wallet_address))
  WHERE wallet_address IS NOT NULL;

CREATE FUNCTION public.admit_verified_auth_profile_atomic(uuid, text)
RETURNS text
LANGUAGE sql
AS $function$
  SELECT 'unavailable'::text
$function$;
ALTER FUNCTION public.admit_verified_auth_profile_atomic(uuid, text)
  OWNER TO postgres;

-- Model the already-installed lifecycle trigger contract used by production.
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

GRANT USAGE ON SCHEMA auth, public
  TO anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION auth.role()
  TO anon, authenticated, authenticator, service_role;

INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'active-auth@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'banned-auth@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'deleted-auth@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'expired-auth@example.com'),
  ('55555555-5555-4555-8555-555555555555', 'conflict-auth@example.com'),
  ('66666666-6666-4666-8666-666666666666', 'compete-a@example.com'),
  ('77777777-7777-4777-8777-777777777777', 'compete-b@example.com'),
  ('88888888-8888-4888-8888-888888888888', 'failure@example.com'),
  ('99999999-9999-4999-8999-999999999999', 'ban-race@example.com'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'delete-race@example.com');

INSERT INTO public.user_profiles (
  id,
  handle,
  email,
  wallet_address,
  banned_at,
  ban_expires_at,
  deleted_at,
  is_banned
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'active', 'stale-active@example.com', NULL, NULL, NULL, NULL, false),
  ('22222222-2222-4222-8222-222222222222', 'banned', 'stale-banned@example.com', NULL, '2026-07-29', NULL, NULL, true),
  ('33333333-3333-4333-8333-333333333333', 'deleted', 'deleted-auth@example.com', NULL, NULL, NULL, '2026-07-29', false),
  ('44444444-4444-4444-8444-444444444444', 'expired', 'expired-auth@example.com', NULL, NULL, '2000-01-01', NULL, true),
  ('55555555-5555-4555-8555-555555555555', 'conflict', 'conflict-auth@example.com', '0x3333333333333333333333333333333333333333', NULL, NULL, NULL, false),
  ('66666666-6666-4666-8666-666666666666', 'compete-a', 'compete-a@example.com', NULL, NULL, NULL, NULL, false),
  ('77777777-7777-4777-8777-777777777777', 'compete-b', 'compete-b@example.com', NULL, NULL, NULL, NULL, false),
  ('88888888-8888-4888-8888-888888888888', 'failure', 'failure@example.com', NULL, NULL, NULL, NULL, false),
  ('99999999-9999-4999-8999-999999999999', 'ban-race', 'ban-race@example.com', NULL, NULL, NULL, NULL, false),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'delete-race', 'delete-race@example.com', NULL, NULL, NULL, NULL, false);
SQL

psql_cmd -q -f "$MIGRATION"
psql_cmd -q -f "$MIGRATION"

service_query() {
  local sql="$1"
  psql_cmd -qAtF '|' -c "
    SET ROLE service_role;
    SET request.jwt.claim.role = 'service_role';
    $sql
  "
}

expect_eq "$(service_query "SELECT * FROM public.bind_siwe_wallet_for_active_profile_atomic('$ACTIVE', '$WALLET_ACTIVE')")" \
  "active|$ACTIVE|active|stale-active@example.com|$WALLET_ACTIVE" \
  'active wallet bind acknowledgement'
expect_eq "$(service_query "SELECT * FROM public.bind_siwe_wallet_for_active_profile_atomic('$ACTIVE', '$WALLET_ACTIVE')")" \
  "active|$ACTIVE|active|stale-active@example.com|$WALLET_ACTIVE" \
  'idempotent wallet bind acknowledgement'
expect_eq "$(service_query "SELECT status FROM public.bind_siwe_wallet_for_active_profile_atomic('$ACTIVE', '$WALLET_OTHER')")" \
  'conflict' \
  'account wallet conflict'
expect_eq "$(service_query "SELECT status FROM public.bind_siwe_wallet_for_active_profile_atomic('$COMPETE_A', '$WALLET_CONFLICT')")" \
  'conflict' \
  'wallet owner conflict'
expect_eq "$(service_query "SELECT status FROM public.bind_siwe_wallet_for_active_profile_atomic('$BANNED', '$WALLET_OTHER')")" \
  'suspended' \
  'banned wallet rejection'
expect_eq "$(service_query "SELECT status FROM public.bind_siwe_wallet_for_active_profile_atomic('$DELETED', '$WALLET_OTHER')")" \
  'suspended' \
  'deleted wallet rejection'
expect_eq "$(service_query "SELECT status FROM public.bind_siwe_wallet_for_active_profile_atomic('$EXPIRED', '$WALLET_EXPIRED')")" \
  'active' \
  'expired legacy ban admission'
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.user_profiles WHERE id IN ('$BANNED', '$DELETED') AND wallet_address IS NOT NULL")" \
  '0' \
  'suspended wallet mutation count'

# Rejected verified admission must not reconcile a suspended profile's email.
expect_eq "$(service_query "SELECT public.admit_verified_auth_profile_atomic('$BANNED', 'banned-auth@example.com')")" \
  'suspended' \
  'banned verified admission'
expect_eq "$(psql_cmd -Atqc "SELECT email FROM public.user_profiles WHERE id = '$BANNED'")" \
  'stale-banned@example.com' \
  'banned email projection remains unchanged'
expect_eq "$(service_query "SELECT public.admit_verified_auth_profile_atomic('$ACTIVE', 'active-auth@example.com')")" \
  'active' \
  'active verified admission'
expect_eq "$(psql_cmd -Atqc "SELECT email FROM public.user_profiles WHERE id = '$ACTIVE'")" \
  'active-auth@example.com' \
  'active email projection converges'

expect_failure_matching \
  "SET ROLE anon; SELECT * FROM public.bind_siwe_wallet_for_active_profile_atomic('$ACTIVE', '$WALLET_ACTIVE')" \
  'anon-bind-execute' \
  '42501'
expect_failure_matching \
  "SET ROLE authenticated; SELECT public.admit_verified_auth_profile_atomic('$ACTIVE', 'active-auth@example.com')" \
  'authenticated-admission-execute' \
  '42501'
expect_failure_matching \
  "SET ROLE service_role; SET request.jwt.claim.role = 'authenticated'; SELECT * FROM public.bind_siwe_wallet_for_active_profile_atomic('$ACTIVE', '$WALLET_ACTIVE')" \
  'forged-service-invocation' \
  '42501'
expect_failure_matching \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT * FROM public.bind_siwe_wallet_for_active_profile_atomic('$ACTIVE', '0xABC')" \
  'invalid-wallet-shape' \
  '22023'

# A database error during binding rolls the whole authority call back.
psql_cmd <<SQL
CREATE FUNCTION public.fail_test_wallet_binding()
RETURNS trigger
LANGUAGE plpgsql
AS \$function\$
BEGIN
  IF NEW.id = '$FAILURE' THEN
    RAISE EXCEPTION 'injected wallet binding failure';
  END IF;
  RETURN NEW;
END
\$function\$;
CREATE TRIGGER fail_test_wallet_binding
  BEFORE UPDATE OF wallet_address ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.fail_test_wallet_binding();
SQL
expect_failure_matching \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT * FROM public.bind_siwe_wallet_for_active_profile_atomic('$FAILURE', '$WALLET_FAILURE')" \
  'injected-wallet-failure' \
  'injected wallet binding failure'
expect_eq "$(psql_cmd -Atqc "SELECT wallet_address IS NULL FROM public.user_profiles WHERE id = '$FAILURE'")" \
  't' \
  'failed bind rollback'
psql_cmd -q -c 'DROP TRIGGER fail_test_wallet_binding ON public.user_profiles; DROP FUNCTION public.fail_test_wallet_binding()'

# Two different profiles proving the same wallet produce exactly one owner.
service_query "SELECT * FROM public.bind_siwe_wallet_for_active_profile_atomic('$COMPETE_A', '$WALLET_COMPETE')" \
  >"$LOG_DIR/compete-a.out" 2>"$LOG_DIR/compete-a.err" &
compete_a_pid=$!
service_query "SELECT * FROM public.bind_siwe_wallet_for_active_profile_atomic('$COMPETE_B', '$WALLET_COMPETE')" \
  >"$LOG_DIR/compete-b.out" 2>"$LOG_DIR/compete-b.err" &
compete_b_pid=$!
wait "$compete_a_pid"
wait "$compete_b_pid"
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.user_profiles WHERE wallet_address = '$WALLET_COMPETE'")" \
  '1' \
  'concurrent wallet owner count'
expect_eq "$(awk -F'|' '$1 == "active" || $1 == "conflict" { print $1 }' "$LOG_DIR"/compete-*.out | sort | paste -sd, -)" \
  'active,conflict' \
  'concurrent wallet acknowledgements'

# A committed ban owns the lifecycle ordering and the queued bind observes it.
psql_cmd -q <<SQL >"$LOG_DIR/ban-race.out" 2>"$LOG_DIR/ban-race.err" &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$BAN_RACE'::uuid::text,
    0
  )
);
UPDATE public.user_profiles
SET banned_at = pg_catalog.clock_timestamp(), is_banned = true
WHERE id = '$BAN_RACE';
SELECT pg_catalog.pg_sleep(0.75);
COMMIT;
SQL
ban_pid=$!
wait_for_subject_lock "$BAN_RACE"
expect_eq "$(service_query "SELECT status FROM public.bind_siwe_wallet_for_active_profile_atomic('$BAN_RACE', '$WALLET_BAN_RACE')")" \
  'suspended' \
  'ban wins wallet race'
wait "$ban_pid"
expect_eq "$(psql_cmd -Atqc "SELECT wallet_address IS NULL FROM public.user_profiles WHERE id = '$BAN_RACE'")" \
  't' \
  'ban race leaves wallet unbound'

# A committed hard deletion likewise orders before the queued bind.
psql_cmd -q <<SQL >"$LOG_DIR/delete-race.out" 2>"$LOG_DIR/delete-race.err" &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:' || '$DELETE_RACE'::uuid::text,
    0
  )
);
DELETE FROM auth.users WHERE id = '$DELETE_RACE';
SELECT pg_catalog.pg_sleep(0.75);
COMMIT;
SQL
delete_pid=$!
wait_for_subject_lock "$DELETE_RACE"
expect_eq "$(service_query "SELECT status FROM public.bind_siwe_wallet_for_active_profile_atomic('$DELETE_RACE', '$WALLET_DELETE_RACE')")" \
  'missing' \
  'hard deletion wins wallet race'
wait "$delete_pid"
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.user_profiles WHERE id = '$DELETE_RACE'")" \
  '0' \
  'hard deletion profile cascade'

echo 'SIWE active-profile wallet admission pg17 proof passed'
