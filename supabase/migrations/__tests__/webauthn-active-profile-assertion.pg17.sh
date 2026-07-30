#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ADMISSION_MIGRATION="$ROOT_DIR/supabase/migrations/20260729158500_siwe_active_profile_wallet_admission.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729160500_webauthn_active_profile_assertion.sql"
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

TMP_ROOT="$(mktemp -d /tmp/webauthn-active-assertion-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55705
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
  for attempt in $(seq 1 150); do
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
COUNTERLESS='22222222-2222-4222-8222-222222222222'
BANNED='33333333-3333-4333-8333-333333333333'
DELETED='44444444-4444-4444-8444-444444444444'
REPLACED='55555555-5555-4555-8555-555555555555'
FAILURE='66666666-6666-4666-8666-666666666666'
BAN_RACE='77777777-7777-4777-8777-777777777777'
DELETE_RACE='88888888-8888-4888-8888-888888888888'
MINT_RACE='99999999-9999-4999-8999-999999999999'

PASSKEY_ACTIVE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
PASSKEY_COUNTERLESS='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
PASSKEY_BANNED='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
PASSKEY_DELETED='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'
PASSKEY_REPLACED='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'
PASSKEY_FAILURE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6'
PASSKEY_BAN_RACE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7'
PASSKEY_DELETE_RACE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8'
PASSKEY_MINT_RACE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9'

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
CREATE TABLE public.user_passkeys (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  counter bigint NOT NULL DEFAULT 0,
  transports text[],
  device_name text,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  last_used_at timestamptz
);
ALTER TABLE auth.users OWNER TO postgres;
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_passkeys OWNER TO postgres;
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
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER
  ON TABLE public.user_passkeys
  TO authenticated, service_role;

INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-4111-8111-111111111111', 'active@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'counterless@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'banned@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'deleted@example.com'),
  ('55555555-5555-4555-8555-555555555555', 'replaced@example.com'),
  ('66666666-6666-4666-8666-666666666666', 'failure@example.com'),
  ('77777777-7777-4777-8777-777777777777', 'ban-race@example.com'),
  ('88888888-8888-4888-8888-888888888888', 'delete-race@example.com'),
  ('99999999-9999-4999-8999-999999999999', 'mint-race@example.com');

INSERT INTO public.user_profiles (
  id,
  handle,
  email,
  banned_at,
  ban_expires_at,
  deleted_at,
  is_banned
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'active', 'active@example.com', NULL, NULL, NULL, false),
  ('22222222-2222-4222-8222-222222222222', 'counterless', 'counterless@example.com', NULL, NULL, NULL, false),
  ('33333333-3333-4333-8333-333333333333', 'banned', 'banned@example.com', '2026-07-29', NULL, NULL, true),
  ('44444444-4444-4444-8444-444444444444', 'deleted', 'deleted@example.com', NULL, NULL, '2026-07-29', false),
  ('55555555-5555-4555-8555-555555555555', 'replaced', 'replaced@example.com', NULL, NULL, NULL, false),
  ('66666666-6666-4666-8666-666666666666', 'failure', 'failure@example.com', NULL, NULL, NULL, false),
  ('77777777-7777-4777-8777-777777777777', 'ban-race', 'ban-race@example.com', NULL, NULL, NULL, false),
  ('88888888-8888-4888-8888-888888888888', 'delete-race', 'delete-race@example.com', NULL, NULL, NULL, false),
  ('99999999-9999-4999-8999-999999999999', 'mint-race', 'mint-race@example.com', NULL, NULL, NULL, false);

INSERT INTO public.user_passkeys (
  id,
  user_id,
  credential_id,
  public_key,
  counter,
  last_used_at
) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '11111111-1111-4111-8111-111111111111', 'credential-active', 'key-active', 4, '2026-07-28 00:00:00+00'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '22222222-2222-4222-8222-222222222222', 'credential-counterless', 'key-counterless', 0, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '33333333-3333-4333-8333-333333333333', 'credential-banned', 'key-banned', 7, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', '44444444-4444-4444-8444-444444444444', 'credential-deleted', 'key-deleted', 8, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', '55555555-5555-4555-8555-555555555555', 'credential-replaced', 'key-original', 9, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6', '66666666-6666-4666-8666-666666666666', 'credential-failure', 'key-failure', 10, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7', '77777777-7777-4777-8777-777777777777', 'credential-ban-race', 'key-ban-race', 11, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa8', '88888888-8888-4888-8888-888888888888', 'credential-delete-race', 'key-delete-race', 12, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa9', '99999999-9999-4999-8999-999999999999', 'credential-mint-race', 'key-mint-race', 13, NULL);
SQL

psql_cmd -q -f "$ADMISSION_MIGRATION"
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

expect_eq "$(service_query "SELECT status FROM public.consume_webauthn_authentication_atomic('$ACTIVE', '$PASSKEY_ACTIVE', 'credential-active', 'key-active', 4, '2026-07-28 00:00:00+00', 5)")" \
  'consumed' \
  'active assertion consumption'
expect_eq "$(psql_cmd -AtF '|' -c "SELECT counter, last_used_at > '2026-07-28 00:00:00+00' FROM public.user_passkeys WHERE id = '$PASSKEY_ACTIVE'")" \
  '5|t' \
  'active credential state'
expect_eq "$(service_query "SELECT status FROM public.consume_webauthn_authentication_atomic('$ACTIVE', '$PASSKEY_ACTIVE', 'credential-active', 'key-active', 4, '2026-07-28 00:00:00+00', 5)")" \
  'conflict' \
  'stale assertion replay'
expect_eq "$(service_query "SELECT status FROM public.consume_webauthn_authentication_atomic('$BANNED', '$PASSKEY_BANNED', 'credential-banned', 'key-banned', 7, NULL, 8)")" \
  'suspended' \
  'banned assertion rejection'
expect_eq "$(service_query "SELECT status FROM public.consume_webauthn_authentication_atomic('$DELETED', '$PASSKEY_DELETED', 'credential-deleted', 'key-deleted', 8, NULL, 9)")" \
  'suspended' \
  'deleted assertion rejection'
expect_eq "$(psql_cmd -AtF '|' -c "SELECT counter FROM public.user_passkeys WHERE id IN ('$PASSKEY_BANNED', '$PASSKEY_DELETED') ORDER BY id")" \
  $'7\n8' \
  'suspended counters remain unchanged'

# Browser roles cannot bypass attestation by injecting or rewriting a key.
expect_failure_matching \
  "SET ROLE authenticated; INSERT INTO public.user_passkeys (id, user_id, credential_id, public_key) VALUES (pg_catalog.gen_random_uuid(), '$ACTIVE', 'injected', 'attacker-key')" \
  'authenticated-credential-insert' \
  '42501'
expect_failure_matching \
  "SET ROLE authenticated; UPDATE public.user_passkeys SET public_key = 'attacker-key' WHERE id = '$PASSKEY_ACTIVE'" \
  'authenticated-credential-update' \
  '42501'
expect_failure_matching \
  "SET ROLE authenticated; DELETE FROM public.user_passkeys WHERE id = '$PASSKEY_ACTIVE'" \
  'authenticated-credential-delete' \
  '42501'
expect_failure_matching \
  "SET ROLE anon; SELECT * FROM public.consume_webauthn_authentication_atomic('$ACTIVE', '$PASSKEY_ACTIVE', 'credential-active', 'key-active', 5, NULL, 6)" \
  'anon-consume-execute' \
  '42501'

# A trigger failure rolls counter and CAS generation back together.
psql_cmd <<SQL
CREATE FUNCTION public.fail_test_assertion_consumption()
RETURNS trigger
LANGUAGE plpgsql
AS \$function\$
BEGIN
  IF NEW.id = '$PASSKEY_FAILURE' THEN
    RAISE EXCEPTION 'injected assertion consumption failure';
  END IF;
  RETURN NEW;
END
\$function\$;
CREATE TRIGGER fail_test_assertion_consumption
  BEFORE UPDATE ON public.user_passkeys
  FOR EACH ROW EXECUTE FUNCTION public.fail_test_assertion_consumption();
SQL
expect_failure_matching \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT * FROM public.consume_webauthn_authentication_atomic('$FAILURE', '$PASSKEY_FAILURE', 'credential-failure', 'key-failure', 10, NULL, 11)" \
  'injected-consumption-failure' \
  'injected assertion consumption failure'
expect_eq "$(psql_cmd -AtF '|' -c "SELECT counter, last_used_at IS NULL FROM public.user_passkeys WHERE id = '$PASSKEY_FAILURE'")" \
  '10|t' \
  'failed assertion rollback'
psql_cmd -q -c 'DROP TRIGGER fail_test_assertion_consumption ON public.user_passkeys; DROP FUNCTION public.fail_test_assertion_consumption()'

# Counterless assertions use last_used_at as a monotonic CAS generation, so
# two calls based on the same 0/null snapshot have exactly one winner.
service_query "SELECT status FROM public.consume_webauthn_authentication_atomic('$COUNTERLESS', '$PASSKEY_COUNTERLESS', 'credential-counterless', 'key-counterless', 0, NULL, 0)" \
  >"$LOG_DIR/counterless-a.out" 2>"$LOG_DIR/counterless-a.err" &
counterless_a_pid=$!
service_query "SELECT status FROM public.consume_webauthn_authentication_atomic('$COUNTERLESS', '$PASSKEY_COUNTERLESS', 'credential-counterless', 'key-counterless', 0, NULL, 0)" \
  >"$LOG_DIR/counterless-b.out" 2>"$LOG_DIR/counterless-b.err" &
counterless_b_pid=$!
wait "$counterless_a_pid"
wait "$counterless_b_pid"
expect_eq "$(awk '$1 == "consumed" || $1 == "conflict" { print $1 }' "$LOG_DIR"/counterless-*.out | sort | paste -sd, -)" \
  'conflict,consumed' \
  'counterless concurrent acknowledgements'
expect_eq "$(psql_cmd -AtF '|' -c "SELECT counter, last_used_at IS NOT NULL FROM public.user_passkeys WHERE id = '$PASSKEY_COUNTERLESS'")" \
  '0|t' \
  'counterless CAS state'

# A credential replacement cannot inherit a proof verified against the old
# public key, even when every other identity field is preserved.
psql_cmd -q <<SQL >"$LOG_DIR/credential-replace.out" 2>"$LOG_DIR/credential-replace.err" &
BEGIN;
UPDATE public.user_passkeys
SET public_key = 'key-replacement'
WHERE id = '$PASSKEY_REPLACED';
SELECT pg_catalog.pg_sleep(0.75);
COMMIT;
SQL
replace_pid=$!
for _attempt in $(seq 1 100); do
  if [[ "$(psql_cmd -Atqc "SELECT public_key FROM public.user_passkeys WHERE id = '$PASSKEY_REPLACED'")" == 'key-replacement' ]]; then
    break
  fi
  sleep 0.02
done
wait "$replace_pid"
expect_eq "$(service_query "SELECT status FROM public.consume_webauthn_authentication_atomic('$REPLACED', '$PASSKEY_REPLACED', 'credential-replaced', 'key-original', 9, NULL, 10)")" \
  'conflict' \
  'replaced public key conflict'
expect_eq "$(psql_cmd -Atqc "SELECT counter FROM public.user_passkeys WHERE id = '$PASSKEY_REPLACED'")" \
  '9' \
  'replaced credential counter unchanged'

# A committed ban owns the lifecycle ordering and rejects the queued counter.
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
expect_eq "$(service_query "SELECT status FROM public.consume_webauthn_authentication_atomic('$BAN_RACE', '$PASSKEY_BAN_RACE', 'credential-ban-race', 'key-ban-race', 11, NULL, 12)")" \
  'suspended' \
  'ban wins assertion race'
wait "$ban_pid"
expect_eq "$(psql_cmd -Atqc "SELECT counter FROM public.user_passkeys WHERE id = '$PASSKEY_BAN_RACE'")" \
  '11' \
  'ban race counter unchanged'

# A hard deletion that owns the lifecycle order removes the credential before
# the queued assertion authority can consume it.
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
expect_eq "$(service_query "SELECT status FROM public.consume_webauthn_authentication_atomic('$DELETE_RACE', '$PASSKEY_DELETE_RACE', 'credential-delete-race', 'key-delete-race', 12, NULL, 13)")" \
  'missing' \
  'hard deletion wins assertion race'
wait "$delete_pid"

# Model the external mint window: a first exact admission succeeds, then a ban
# commits, and the pre-release admission observes suspension.
expect_eq "$(service_query "SELECT public.admit_verified_auth_profile_atomic('$MINT_RACE', 'mint-race@example.com')")" \
  'active' \
  'pre-mint active admission'
psql_cmd -q -c "UPDATE public.user_profiles SET banned_at = pg_catalog.clock_timestamp(), is_banned = true WHERE id = '$MINT_RACE'"
expect_eq "$(service_query "SELECT public.admit_verified_auth_profile_atomic('$MINT_RACE', 'mint-race@example.com')")" \
  'suspended' \
  'pre-release suspended admission'
expect_eq "$(psql_cmd -Atqc "SELECT counter FROM public.user_passkeys WHERE id = '$PASSKEY_MINT_RACE'")" \
  '13' \
  'mint-window credential remains unconsumed'

echo 'WebAuthn active-profile assertion pg17 proof passed'
