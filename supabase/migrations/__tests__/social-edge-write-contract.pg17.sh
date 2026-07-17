#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the final social-edge write contract.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FIXTURE="$ROOT_DIR/supabase/migrations/__tests__/social-edge-write-contract.fixture.sql"
FOLLOW_MIGRATION="$ROOT_DIR/supabase/migrations/20260716190000_atomic_user_follow.sql"
BLOCK_MIGRATION="$ROOT_DIR/supabase/migrations/20260716191000_atomic_user_block.sql"
CONTRACT_MIGRATION="$ROOT_DIR/supabase/migrations/20260716192000_social_edge_write_contract.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl postgres psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/postgres --version)" != postgres\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/social-edge-contract-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
DIRECT_LOG="$TMP_ROOT/direct.log"
PORT=55544
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)); then
    for diagnostic in "$DIRECT_LOG" "$LOG_FILE"; do
      if [[ -f "$diagnostic" ]]; then
        echo "--- ${diagnostic##*/} ---" >&2
        tail -200 "$diagnostic" >&2 || true
      fi
    done
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_status"
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
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

service_sql() {
  local sql="$1"
  psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; $sql"
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

expect_denied() {
  local role="$1"
  local sql="$2"
  local label="$3"
  if psql_cmd -qc "SET ROLE $role; SET request.jwt.claim.role = '$role'; $sql" >"$DIRECT_LOG" 2>&1; then
    echo "$label unexpectedly succeeded for $role" >&2
    exit 1
  fi
  if ! grep -Eq 'permission denied|row-level security policy' "$DIRECT_LOG"; then
    echo "$label failed for an unexpected reason" >&2
    cat "$DIRECT_LOG" >&2
    exit 1
  fi
}

ACTOR_ID="11111111-1111-4111-8111-111111111111"
TARGET_ID="22222222-2222-4222-8222-222222222222"
THIRD_ID="33333333-3333-4333-8333-333333333333"

psql_cmd -f "$FIXTURE" >/dev/null
psql_cmd -f "$FOLLOW_MIGRATION" >/dev/null
psql_cmd -f "$BLOCK_MIGRATION" >/dev/null
psql_cmd -f "$CONTRACT_MIGRATION" >/dev/null
psql_cmd -f "$CONTRACT_MIGRATION" >/dev/null

# Existing reads survive unchanged.
expect_eq "$(psql_cmd -Atqc "SELECT has_table_privilege('anon', 'public.user_follows', 'SELECT')")" "t" "anon follow read"
expect_eq "$(psql_cmd -Atqc "SELECT has_table_privilege('authenticated', 'public.user_follows', 'SELECT')")" "t" "authenticated follow read"
expect_eq "$(psql_cmd -Atqc "SELECT has_table_privilege('authenticated', 'public.blocked_users', 'SELECT')")" "t" "authenticated block read"
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM pg_policy WHERE polrelid IN ('public.user_follows'::regclass, 'public.blocked_users'::regclass) AND polcmd = 'r'")" "2" "select policy preservation"
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM pg_policy WHERE polrelid IN ('public.user_follows'::regclass, 'public.blocked_users'::regclass) AND polcmd IN ('*', 'a', 'w', 'd')")" "0" "mutation policy removal"

# Table grants and explicit column grants cannot bypass either edge boundary.
for role in anon authenticated service_role; do
  for relation in user_follows blocked_users; do
    for privilege in INSERT UPDATE DELETE TRUNCATE REFERENCES TRIGGER; do
      expect_eq "$(psql_cmd -Atqc "SELECT has_table_privilege('$role', 'public.$relation', '$privilege')")" "f" "$role $relation $privilege"
    done
  done
done
for role in anon authenticated service_role; do
  expect_eq "$(psql_cmd -Atqc "SELECT has_column_privilege('$role', 'public.user_follows', 'follower_id', 'INSERT')")" "f" "$role follow column insert"
  expect_eq "$(psql_cmd -Atqc "SELECT has_column_privilege('$role', 'public.user_follows', 'following_id', 'UPDATE')")" "f" "$role follow column update"
  expect_eq "$(psql_cmd -Atqc "SELECT has_column_privilege('$role', 'public.blocked_users', 'blocker_id', 'INSERT')")" "f" "$role block column insert"
  expect_eq "$(psql_cmd -Atqc "SELECT has_column_privilege('$role', 'public.blocked_users', 'blocked_id', 'REFERENCES')")" "f" "$role block column references"
done

expect_denied service_role "INSERT INTO public.user_follows(follower_id, following_id) VALUES ('$ACTOR_ID', '$TARGET_ID')" "service direct follow insert"
expect_denied service_role "DELETE FROM public.user_follows WHERE follower_id = '$ACTOR_ID'" "service direct follow delete"
expect_denied authenticated "INSERT INTO public.user_follows(follower_id, following_id) VALUES ('$ACTOR_ID', '$TARGET_ID')" "browser direct follow insert"
expect_denied authenticated "INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES ('$ACTOR_ID', '$TARGET_ID')" "browser direct block insert"
expect_denied service_role "DELETE FROM public.blocked_users WHERE blocker_id = '$ACTOR_ID'" "service direct block delete"

# The service-only functions remain the complete write surface after contract.
expect_eq "$(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'follow')->>'status'")" "followed" "RPC follow after contract"
expect_eq "$(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$TARGET_ID', 'block')->>'status'")" "blocked" "RPC block after contract"
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.user_follows WHERE follower_id = '$ACTOR_ID' AND following_id = '$TARGET_ID'")" "0" "RPC block cleanup after contract"
expect_eq "$(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$TARGET_ID', 'unblock')->>'status'")" "unblocked" "RPC unblock after contract"
expect_eq "$(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$THIRD_ID', 'follow')->>'status'")" "followed" "second RPC follow after contract"

# FK cascades remain database-owned and do not depend on application grants.
psql_cmd -qc "DELETE FROM auth.users WHERE id = '$THIRD_ID'"
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.user_follows WHERE following_id = '$THIRD_ID'")" "0" "Auth cascade after contract"

echo "social edge write contract PostgreSQL 17 proof passed"
