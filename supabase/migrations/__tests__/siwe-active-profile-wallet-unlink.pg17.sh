#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BIND_MIGRATION="$ROOT_DIR/supabase/migrations/20260729158500_siwe_active_profile_wallet_admission.sql"
UNLINK_MIGRATION="$ROOT_DIR/supabase/migrations/20260729159500_siwe_active_profile_wallet_unlink.sql"
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

TMP_ROOT="$(mktemp -d /tmp/siwe-active-unlink-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55695
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

wait_for_lock() {
  local lock_key="$1"
  local label="$2"
  local attempt
  local acquired
  for attempt in $(seq 1 150); do
    acquired="$(psql_cmd -Atqc "
      SELECT pg_catalog.pg_try_advisory_lock(
        pg_catalog.hashtextextended('$lock_key', 0)
      )
    ")"
    if [[ "$acquired" == 'f' ]]; then
      return 0
    fi
    sleep 0.02
  done
  echo "Timed out waiting for advisory lock: $label" >&2
  exit 1
}

ACTIVE='11111111-1111-4111-8111-111111111111'
EMPTY='22222222-2222-4222-8222-222222222222'
BANNED='33333333-3333-4333-8333-333333333333'
DELETED='44444444-4444-4444-8444-444444444444'
LINK_RACE='55555555-5555-4555-8555-555555555555'
CLAIM_OWNER='66666666-6666-4666-8666-666666666666'
CLAIMANT='77777777-7777-4777-8777-777777777777'
FAILURE='88888888-8888-4888-8888-888888888888'
BAN_RACE='99999999-9999-4999-8999-999999999999'
DELETE_RACE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

WALLET_ACTIVE='0x1111111111111111111111111111111111111111'
WALLET_BANNED='0x2222222222222222222222222222222222222222'
WALLET_DELETED='0x3333333333333333333333333333333333333333'
WALLET_LINK_RACE='0x4444444444444444444444444444444444444444'
WALLET_CLAIM='0x5555555555555555555555555555555555555555'
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
  ('11111111-1111-4111-8111-111111111111', 'active@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'empty@example.com'),
  ('33333333-3333-4333-8333-333333333333', 'banned@example.com'),
  ('44444444-4444-4444-8444-444444444444', 'deleted@example.com'),
  ('55555555-5555-4555-8555-555555555555', 'link-race@example.com'),
  ('66666666-6666-4666-8666-666666666666', 'claim-owner@example.com'),
  ('77777777-7777-4777-8777-777777777777', 'claimant@example.com'),
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
  ('11111111-1111-4111-8111-111111111111', 'active', 'active@example.com', '0x1111111111111111111111111111111111111111', NULL, NULL, NULL, false),
  ('22222222-2222-4222-8222-222222222222', 'empty', 'empty@example.com', NULL, NULL, NULL, NULL, false),
  ('33333333-3333-4333-8333-333333333333', 'banned', 'banned@example.com', '0x2222222222222222222222222222222222222222', '2026-07-29', NULL, NULL, true),
  ('44444444-4444-4444-8444-444444444444', 'deleted', 'deleted@example.com', '0x3333333333333333333333333333333333333333', NULL, NULL, '2026-07-29', false),
  ('55555555-5555-4555-8555-555555555555', 'link-race', 'link-race@example.com', '0x4444444444444444444444444444444444444444', NULL, NULL, NULL, false),
  ('66666666-6666-4666-8666-666666666666', 'claim-owner', 'claim-owner@example.com', '0x5555555555555555555555555555555555555555', NULL, NULL, NULL, false),
  ('77777777-7777-4777-8777-777777777777', 'claimant', 'claimant@example.com', NULL, NULL, NULL, NULL, false),
  ('88888888-8888-4888-8888-888888888888', 'failure', 'failure@example.com', '0x6666666666666666666666666666666666666666', NULL, NULL, NULL, false),
  ('99999999-9999-4999-8999-999999999999', 'ban-race', 'ban-race@example.com', '0x7777777777777777777777777777777777777777', NULL, NULL, NULL, false),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'delete-race', 'delete-race@example.com', '0x8888888888888888888888888888888888888888', NULL, NULL, NULL, false);
SQL

psql_cmd -q -f "$BIND_MIGRATION"
psql_cmd -q -f "$UNLINK_MIGRATION"
psql_cmd -q -f "$UNLINK_MIGRATION"

service_query() {
  local sql="$1"
  psql_cmd -qAtF '|' -c "
    SET ROLE service_role;
    SET request.jwt.claim.role = 'service_role';
    $sql
  "
}

expect_eq "$(service_query "SELECT * FROM public.unbind_siwe_wallet_for_active_profile_atomic('$ACTIVE')")" \
  "unbound|$ACTIVE|$WALLET_ACTIVE" \
  'active wallet unlink acknowledgement'
expect_eq "$(service_query "SELECT * FROM public.unbind_siwe_wallet_for_active_profile_atomic('$ACTIVE')")" \
  "already_unbound|$ACTIVE|" \
  'idempotent wallet unlink acknowledgement'
expect_eq "$(service_query "SELECT * FROM public.unbind_siwe_wallet_for_active_profile_atomic('$EMPTY')")" \
  "already_unbound|$EMPTY|" \
  'initially empty wallet acknowledgement'
expect_eq "$(service_query "SELECT status FROM public.unbind_siwe_wallet_for_active_profile_atomic('$BANNED')")" \
  'suspended' \
  'banned wallet unlink rejection'
expect_eq "$(service_query "SELECT status FROM public.unbind_siwe_wallet_for_active_profile_atomic('$DELETED')")" \
  'suspended' \
  'deleted wallet unlink rejection'
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.user_profiles WHERE id IN ('$BANNED', '$DELETED') AND wallet_address IS NOT NULL")" \
  '2' \
  'suspended wallets remain linked'

expect_failure_matching \
  "SET ROLE anon; SELECT * FROM public.unbind_siwe_wallet_for_active_profile_atomic('$EMPTY')" \
  'anon-unlink-execute' \
  '42501'
expect_failure_matching \
  "SET ROLE authenticated; SELECT * FROM public.unbind_siwe_wallet_for_active_profile_atomic('$EMPTY')" \
  'authenticated-unlink-execute' \
  '42501'
expect_failure_matching \
  "SET ROLE service_role; SET request.jwt.claim.role = 'authenticated'; SELECT * FROM public.unbind_siwe_wallet_for_active_profile_atomic('$EMPTY')" \
  'forged-service-unlink' \
  '42501'

# Failure injection proves no partial wallet release can be acknowledged.
psql_cmd <<SQL
CREATE FUNCTION public.fail_test_wallet_unlink()
RETURNS trigger
LANGUAGE plpgsql
AS \$function\$
BEGIN
  IF NEW.id = '$FAILURE' AND NEW.wallet_address IS NULL THEN
    RAISE EXCEPTION 'injected wallet unlink failure';
  END IF;
  RETURN NEW;
END
\$function\$;
CREATE TRIGGER fail_test_wallet_unlink
  BEFORE UPDATE OF wallet_address ON public.user_profiles
  FOR EACH ROW EXECUTE FUNCTION public.fail_test_wallet_unlink();
SQL
expect_failure_matching \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT * FROM public.unbind_siwe_wallet_for_active_profile_atomic('$FAILURE')" \
  'injected-unlink-failure' \
  'injected wallet unlink failure'
expect_eq "$(psql_cmd -Atqc "SELECT wallet_address FROM public.user_profiles WHERE id = '$FAILURE'")" \
  "$WALLET_FAILURE" \
  'failed unlink rollback'
psql_cmd -q -c 'DROP TRIGGER fail_test_wallet_unlink ON public.user_profiles; DROP FUNCTION public.fail_test_wallet_unlink()'

# Link linearizes first; the queued unlink then releases the wallet.
psql_cmd -qAtF '|' <<SQL >"$LOG_DIR/link-first.out" 2>"$LOG_DIR/link-first.err" &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT * FROM public.bind_siwe_wallet_for_active_profile_atomic('$LINK_RACE', '$WALLET_LINK_RACE');
SELECT pg_catalog.pg_sleep(0.75);
COMMIT;
SQL
link_first_pid=$!
wait_for_lock "account-recovery-admission:$LINK_RACE" 'link-first subject'
expect_eq "$(service_query "SELECT status FROM public.unbind_siwe_wallet_for_active_profile_atomic('$LINK_RACE')")" \
  'unbound' \
  'unlink after concurrent link'
wait "$link_first_pid"
expect_eq "$(psql_cmd -Atqc "SELECT wallet_address IS NULL FROM public.user_profiles WHERE id = '$LINK_RACE'")" \
  't' \
  'link-first final wallet state'

# Unlink linearizes first; the queued re-link restores the exact wallet.
psql_cmd -q -c "UPDATE public.user_profiles SET wallet_address = '$WALLET_LINK_RACE' WHERE id = '$LINK_RACE'"
psql_cmd -qAtF '|' <<SQL >"$LOG_DIR/unlink-first.out" 2>"$LOG_DIR/unlink-first.err" &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT * FROM public.unbind_siwe_wallet_for_active_profile_atomic('$LINK_RACE');
SELECT pg_catalog.pg_sleep(0.75);
COMMIT;
SQL
unlink_first_pid=$!
wait_for_lock "account-recovery-admission:$LINK_RACE" 'unlink-first subject'
expect_eq "$(service_query "SELECT status FROM public.bind_siwe_wallet_for_active_profile_atomic('$LINK_RACE', '$WALLET_LINK_RACE')")" \
  'active' \
  're-link after concurrent unlink'
wait "$unlink_first_pid"
expect_eq "$(psql_cmd -Atqc "SELECT wallet_address FROM public.user_profiles WHERE id = '$LINK_RACE'")" \
  "$WALLET_LINK_RACE" \
  'unlink-first final wallet state'

# Releasing one account's wallet and claiming it for another serialize on the
# shared wallet key; the claimant observes the committed release.
psql_cmd -qAtF '|' <<SQL >"$LOG_DIR/release-owner.out" 2>"$LOG_DIR/release-owner.err" &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT * FROM public.unbind_siwe_wallet_for_active_profile_atomic('$CLAIM_OWNER');
SELECT pg_catalog.pg_sleep(0.75);
COMMIT;
SQL
release_owner_pid=$!
wait_for_lock "siwe-wallet-binding:$WALLET_CLAIM" 'released wallet identity'
expect_eq "$(service_query "SELECT status FROM public.bind_siwe_wallet_for_active_profile_atomic('$CLAIMANT', '$WALLET_CLAIM')")" \
  'active' \
  'claim after concurrent release'
wait "$release_owner_pid"
expect_eq "$(psql_cmd -Atqc "SELECT id FROM public.user_profiles WHERE wallet_address = '$WALLET_CLAIM'")" \
  "$CLAIMANT" \
  'released wallet new owner'

# A ban that owns the lifecycle order rejects the queued unlink and preserves
# the wallet for review/recovery.
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
wait_for_lock "account-recovery-admission:$BAN_RACE" 'ban-race subject'
expect_eq "$(service_query "SELECT status FROM public.unbind_siwe_wallet_for_active_profile_atomic('$BAN_RACE')")" \
  'suspended' \
  'ban wins unlink race'
wait "$ban_pid"
expect_eq "$(psql_cmd -Atqc "SELECT wallet_address FROM public.user_profiles WHERE id = '$BAN_RACE'")" \
  "$WALLET_BAN_RACE" \
  'ban race preserves wallet'

# A hard deletion that owns the lifecycle order leaves no profile for unlink.
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
wait_for_lock "account-recovery-admission:$DELETE_RACE" 'delete-race subject'
expect_eq "$(service_query "SELECT status FROM public.unbind_siwe_wallet_for_active_profile_atomic('$DELETE_RACE')")" \
  'missing' \
  'hard deletion wins unlink race'
wait "$delete_pid"

echo 'SIWE active-profile wallet unlink pg17 proof passed'
