#!/usr/bin/env bash

# PostgreSQL 17 proof for canonical, single-owner SIWE wallet identities.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716179200_user_profile_wallet_authority.sql"
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

TMP_ROOT="$(mktemp -d /tmp/user-profile-wallet-authority-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((55800 + RANDOM % 500))
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

assert_query() {
  local expected="$1"
  local sql="$2"
  local label="$3"
  local actual
  actual="$(psql_cmd -Atqc "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label: expected '$expected', got '$actual'" >&2
    return 1
  fi
}

expect_sql_failure() {
  local sql="$1"
  local needle="$2"
  local label="$3"
  local failure_log="$TMP_ROOT/${label}.log"
  if psql_cmd -c "$sql" >"$failure_log" 2>&1; then
    echo "Expected SQL failure: $label" >&2
    return 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    cat "$failure_log" >&2
    echo "Missing failure evidence '$needle': $label" >&2
    return 1
  fi
}

expect_migration_failure() {
  local needle="$1"
  local label="$2"
  local failure_log="$TMP_ROOT/${label}.log"
  if psql_cmd -f "$MIGRATION" >"$failure_log" 2>&1; then
    echo "Expected migration failure: $label" >&2
    return 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    cat "$failure_log" >&2
    echo "Missing migration failure evidence '$needle': $label" >&2
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
CREATE ROLE hostile_owner NOLOGIN;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  handle text NOT NULL,
  wallet_address text,
  bio text,
  avatar_url text,
  cover_url text,
  market_pairs jsonb,
  notify_follow boolean,
  notify_like boolean,
  notify_comment boolean,
  notify_mention boolean,
  notify_message boolean,
  notify_trader_events boolean,
  show_followers boolean,
  show_following boolean,
  dm_permission text,
  email_digest boolean,
  settings_version integer,
  show_pro_badge boolean,
  last_seen_at timestamptz,
  is_online boolean,
  interests text[],
  onboarding_completed boolean,
  search_history jsonb
);
ALTER TABLE public.user_profiles OWNER TO postgres;

-- Reproduce historical broad grants plus the safe per-column update grant
-- installed by the profile write-authority migration.
GRANT UPDATE (
  handle, bio, avatar_url, cover_url, market_pairs, notify_follow,
  notify_like, notify_comment, notify_mention, notify_message,
  notify_trader_events, show_followers, show_following, dm_permission,
  email_digest, settings_version, show_pro_badge, last_seen_at, is_online,
  interests, onboarding_completed, search_history
) ON public.user_profiles TO authenticated;
GRANT SELECT, INSERT ON public.user_profiles TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_profiles TO service_role;

INSERT INTO public.user_profiles (id, handle, wallet_address) VALUES
  ('11111111-1111-4111-8111-111111111111', 'singleton', '0x' || repeat('A', 40)),
  ('22222222-2222-4222-8222-222222222222', 'duplicate_upper', '0x' || repeat('B', 40)),
  ('33333333-3333-4333-8333-333333333333', 'duplicate_lower', '0x' || repeat('b', 40)),
  ('44444444-4444-4444-8444-444444444444', 'invalid', 'not-a-wallet'),
  ('55555555-5555-4555-8555-555555555555', 'empty', NULL),
  ('66666666-6666-4666-8666-666666666666', 'concurrent_a', NULL),
  ('77777777-7777-4777-8777-777777777777', 'concurrent_b', NULL);

CREATE UNIQUE INDEX idx_user_profiles_wallet_address
  ON public.user_profiles (wallet_address)
  WHERE wallet_address IS NOT NULL;
SQL

# Owner drift must abort before touching historical rows or the legacy index.
psql_cmd -c 'ALTER TABLE public.user_profiles OWNER TO hostile_owner' >/dev/null
expect_migration_failure \
  "public.user_profiles must be an ordinary postgres-owned table" \
  "owner-drift"
psql_cmd -c 'ALTER TABLE public.user_profiles OWNER TO postgres' >/dev/null

# A same-table name collision with a different definition must abort without
# deleting the unfamiliar object.
psql_cmd <<'SQL' >/dev/null
DROP INDEX public.idx_user_profiles_wallet_address;
CREATE UNIQUE INDEX idx_user_profiles_wallet_address
  ON public.user_profiles (handle)
  WHERE handle IS NOT NULL;
SQL
expect_migration_failure \
  "wallet index definition is incompatible and was preserved: idx_user_profiles_wallet_address" \
  "legacy-index-definition-drift"
assert_query \
  "handle" \
  "SELECT pg_catalog.pg_get_indexdef('public.idx_user_profiles_wallet_address'::regclass, 1, true)" \
  "drifted legacy index preserved"
psql_cmd <<'SQL' >/dev/null
DROP INDEX public.idx_user_profiles_wallet_address;
CREATE UNIQUE INDEX idx_user_profiles_wallet_address
  ON public.user_profiles (wallet_address)
  WHERE wallet_address IS NOT NULL;
SQL

psql_cmd <<'SQL' >/dev/null
CREATE UNIQUE INDEX user_profiles_wallet_address_lower_unique
  ON public.user_profiles (handle)
  WHERE handle IS NOT NULL;
SQL
expect_migration_failure \
  "wallet index definition is incompatible and was preserved: user_profiles_wallet_address_lower_unique" \
  "canonical-index-definition-drift"
assert_query \
  "handle" \
  "SELECT pg_catalog.pg_get_indexdef('public.user_profiles_wallet_address_lower_unique'::regclass, 1, true)" \
  "drifted canonical index preserved"
psql_cmd -c \
  'DROP INDEX public.user_profiles_wallet_address_lower_unique' >/dev/null

psql_cmd <<'SQL' >/dev/null
ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_wallet_address_shape_check
  CHECK (wallet_address IS NULL OR pg_catalog.length(wallet_address) > 0);
SQL
expect_migration_failure \
  "wallet shape constraint is incompatible and was preserved" \
  "shape-constraint-definition-drift"
assert_query \
  "CHECK (wallet_address IS NULL OR length(wallet_address) > 0)" \
  "SELECT pg_catalog.pg_get_constraintdef(oid, true) FROM pg_catalog.pg_constraint WHERE conrelid = 'public.user_profiles'::regclass AND conname = 'user_profiles_wallet_address_shape_check'" \
  "drifted shape constraint preserved"
psql_cmd -c \
  'ALTER TABLE public.user_profiles DROP CONSTRAINT user_profiles_wallet_address_shape_check' \
  >/dev/null

psql_cmd -f "$MIGRATION" >/dev/null

assert_query \
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" \
  "SELECT wallet_address FROM public.user_profiles WHERE handle = 'singleton'" \
  "checksum singleton canonicalized"
assert_query \
  "2" \
  "SELECT count(*) FROM public.user_profiles WHERE handle LIKE 'duplicate_%' AND wallet_address IS NULL" \
  "ambiguous case variants unlinked"
assert_query \
  "1" \
  "SELECT count(*) FROM public.user_profiles WHERE handle = 'invalid' AND wallet_address IS NULL" \
  "invalid historical wallet unlinked"
assert_query \
  "t|t|f|f" \
  "SELECT has_column_privilege('authenticated', 'public.user_profiles', 'handle', 'UPDATE'), has_column_privilege('service_role', 'public.user_profiles', 'wallet_address', 'UPDATE'), has_column_privilege('authenticated', 'public.user_profiles', 'wallet_address', 'UPDATE'), has_table_privilege('authenticated', 'public.user_profiles', 'INSERT')" \
  "wallet ACL boundary"

expect_sql_failure \
  "SET ROLE authenticated; UPDATE public.user_profiles SET wallet_address = '0x' || repeat('c', 40) WHERE id = '55555555-5555-4555-8555-555555555555'" \
  "permission denied" \
  "browser-wallet-write"
assert_query \
  "55555555-5555-4555-8555-555555555555" \
  "SET ROLE authenticated; UPDATE public.user_profiles SET handle = 'safe-column-still-writable' WHERE id = '55555555-5555-4555-8555-555555555555' RETURNING id" \
  "safe profile column compatibility"

expect_sql_failure \
  "SET ROLE service_role; UPDATE public.user_profiles SET wallet_address = '0x' || repeat('D', 40) WHERE id = '55555555-5555-4555-8555-555555555555'" \
  "user_profiles_wallet_address_shape_check" \
  "uppercase runtime wallet rejected"

# Two independent transactions contend for one signed wallet. The unique
# index makes the loser fail after the winner commits; both can never persist.
wallet_c="0x$(printf 'c%.0s' {1..40})"
(
  psql_cmd <<SQL
BEGIN;
SET ROLE service_role;
UPDATE public.user_profiles
SET wallet_address = '$wallet_c'
WHERE id = '66666666-6666-4666-8666-666666666666';
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
) >"$TMP_ROOT/concurrent-a.log" 2>&1 &
winner_pid=$!
sleep 0.2
set +e
psql_cmd <<SQL >"$TMP_ROOT/concurrent-b.log" 2>&1
BEGIN;
SET ROLE service_role;
UPDATE public.user_profiles
SET wallet_address = '$wallet_c'
WHERE id = '77777777-7777-4777-8777-777777777777';
COMMIT;
SQL
loser_status=$?
wait "$winner_pid"
winner_status=$?
set -e

if ((winner_status != 0 || loser_status == 0)); then
  cat "$TMP_ROOT/concurrent-a.log" >&2 || true
  cat "$TMP_ROOT/concurrent-b.log" >&2 || true
  echo "Concurrent wallet ownership did not produce exactly one winner" >&2
  exit 1
fi
if ! grep -Fq 'duplicate key value violates unique constraint' "$TMP_ROOT/concurrent-b.log"; then
  cat "$TMP_ROOT/concurrent-b.log" >&2
  echo "Concurrent loser did not fail at the unique wallet boundary" >&2
  exit 1
fi
assert_query \
  "1" \
  "SELECT count(*) FROM public.user_profiles WHERE wallet_address = '$wallet_c'" \
  "single concurrent wallet owner"

# Replaying after a real binding must preserve ownership and the exact ACL.
psql_cmd -f "$MIGRATION" >/dev/null
assert_query \
  "1" \
  "SELECT count(*) FROM public.user_profiles WHERE wallet_address = '$wallet_c'" \
  "replay preserves canonical owner"
assert_query \
  "1|1" \
  "SELECT count(*) FILTER (WHERE indexname = 'user_profiles_wallet_address_lower_unique'), count(*) FILTER (WHERE constraint_name = 'user_profiles_wallet_address_shape_check') FROM (SELECT indexname, NULL::text AS constraint_name FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'user_profiles' UNION ALL SELECT NULL, constraint_name FROM information_schema.table_constraints WHERE table_schema = 'public' AND table_name = 'user_profiles') AS authority" \
  "replay converges wallet authority"

echo "User profile wallet authority PostgreSQL 17 proof passed"
