#!/usr/bin/env bash

# Executable PostgreSQL 17 proof that profile emails follow auth email changes and drifted rows are repaired.
# 

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261113151848_sync_user_profile_email_from_auth.sql"
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

TMP_ROOT="$(mktemp -d /tmp/profile-email-sync-pg17.XXXXXX)"
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
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, encrypted_password text);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text,
  handle text
);
INSERT INTO auth.users (id, email) VALUES
  ('10000000-0000-4000-8000-000000000001', 'new-address@example.com'),
  ('10000000-0000-4000-8000-000000000002', 'same@example.com'),
  ('10000000-0000-4000-8000-000000000003', NULL);
-- user 1 already changed their email before the trigger existed (drifted).
INSERT INTO public.user_profiles (id, email, handle) VALUES
  ('10000000-0000-4000-8000-000000000001', 'old-address@example.com', 'one'),
  ('10000000-0000-4000-8000-000000000002', 'same@example.com', 'two'),
  ('10000000-0000-4000-8000-000000000003', 'kept@wallet.arena', 'three');
SQL

psql_cmd -q -f "$MIGRATION"
# Idempotent re-apply.
psql_cmd -q -f "$MIGRATION" 2>/dev/null

profile_email() {
  psql_cmd -Atqc "SELECT email FROM public.user_profiles WHERE handle = '$1'"
}
expect() {
  if [[ "$2" != "$3" ]]; then
    echo "$1: expected '$3', got '$2'" >&2
    exit 1
  fi
}

# 1. Backfill repaired the drifted row and left the others alone.
expect "backfill" "$(profile_email one)" "new-address@example.com"
expect "unchanged row" "$(profile_email two)" "same@example.com"
expect "NULL auth email keeps the profile value" "$(profile_email three)" "kept@wallet.arena"

# 2. A later email change is mirrored.
psql_cmd -q -c "UPDATE auth.users SET email = 'moved@example.com' WHERE id = '10000000-0000-4000-8000-000000000002'"
expect "trigger sync" "$(profile_email two)" "moved@example.com"

# 3. Updates that do not touch the email, or clear it, never blank the profile.
psql_cmd -q -c "UPDATE auth.users SET encrypted_password = 'x' WHERE id = '10000000-0000-4000-8000-000000000002'"
psql_cmd -q -c "UPDATE auth.users SET email = NULL WHERE id = '10000000-0000-4000-8000-000000000002'"
expect "NULL change ignored" "$(profile_email two)" "moved@example.com"

echo "profile email sync PostgreSQL 17 proof passed"
