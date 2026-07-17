#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for atomic block/unblock and follow cleanup.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
FOLLOW_MIGRATION="$ROOT_DIR/supabase/migrations/20260716190000_atomic_user_follow.sql"
BLOCK_MIGRATION="$ROOT_DIR/supabase/migrations/20260716191000_atomic_user_block.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-user-block-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
BLOCK_LOG="$TMP_ROOT/block.log"
FOLLOW_LOG="$TMP_ROOT/follow.log"
AUTH_LOG="$TMP_ROOT/auth.log"
PORT=55543
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)); then
    for diagnostic in "$BLOCK_LOG" "$FOLLOW_LOG" "$AUTH_LOG" "$LOG_FILE"; do
      if [[ -f "$diagnostic" ]]; then
        echo "--- ${diagnostic##*/} ---" >&2
        tail -180 "$diagnostic" >&2 || true
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

ACTOR_ID="11111111-1111-4111-8111-111111111111"
TARGET_ID="22222222-2222-4222-8222-222222222222"
THIRD_ID="33333333-3333-4333-8333-333333333333"
INACTIVE_ID="44444444-4444-4444-8444-444444444444"
MISSING_ID="55555555-5555-4555-8555-555555555555"

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;
ALTER FUNCTION auth.role() OWNER TO postgres;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  handle text,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean DEFAULT false,
  ban_expires_at timestamptz,
  follower_count integer DEFAULT 0,
  following_count integer DEFAULT 0
);
CREATE TABLE public.user_follows (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  follower_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (follower_id, following_id)
);
CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (blocker_id, blocked_id)
);
ALTER TABLE auth.users OWNER TO postgres;
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_follows OWNER TO postgres;
ALTER TABLE public.blocked_users OWNER TO postgres;

ALTER TABLE public.user_follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_follow_service ON public.user_follows
  FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY block_service ON public.blocked_users
  FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_follows, public.blocked_users
  TO service_role;
GRANT SELECT, UPDATE ON public.user_profiles TO service_role;

CREATE FUNCTION public.serialize_direct_message_pair_edge()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_pairs text[] := ARRAY[]::text[];
  v_pair text;
  v_old_left uuid;
  v_old_right uuid;
  v_new_left uuid;
  v_new_right uuid;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'blocked_users' THEN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old_left := OLD.blocker_id;
        v_old_right := OLD.blocked_id;
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_new_left := NEW.blocker_id;
        v_new_right := NEW.blocked_id;
      END IF;
    WHEN 'user_follows' THEN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old_left := OLD.follower_id;
        v_old_right := OLD.following_id;
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_new_left := NEW.follower_id;
        v_new_right := NEW.following_id;
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported table';
  END CASE;
  IF v_old_left IS NOT NULL AND v_old_right IS NOT NULL THEN
    v_pairs := pg_catalog.array_append(
      v_pairs,
      LEAST(v_old_left::text, v_old_right::text)
        || ':' || GREATEST(v_old_left::text, v_old_right::text)
    );
  END IF;
  IF v_new_left IS NOT NULL AND v_new_right IS NOT NULL THEN
    v_pairs := pg_catalog.array_append(
      v_pairs,
      LEAST(v_new_left::text, v_new_right::text)
        || ':' || GREATEST(v_new_left::text, v_new_right::text)
    );
  END IF;
  FOR v_pair IN
    SELECT DISTINCT affected_pair
    FROM pg_catalog.unnest(v_pairs) AS affected(affected_pair)
    ORDER BY affected_pair
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
    );
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.serialize_direct_message_pair_edge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.serialize_direct_message_pair_edge()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_serialize_dm_block_pair
BEFORE INSERT OR DELETE OR UPDATE OF blocker_id, blocked_id
ON public.blocked_users
FOR EACH ROW EXECUTE FUNCTION public.serialize_direct_message_pair_edge();
CREATE TRIGGER trg_serialize_dm_follow_pair
BEFORE INSERT OR DELETE OR UPDATE OF follower_id, following_id
ON public.user_follows
FOR EACH ROW EXECUTE FUNCTION public.serialize_direct_message_pair_edge();

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');
INSERT INTO public.user_profiles(id, handle) VALUES
  ('11111111-1111-4111-8111-111111111111', 'actor'),
  ('22222222-2222-4222-8222-222222222222', 'target'),
  ('33333333-3333-4333-8333-333333333333', 'third'),
  ('44444444-4444-4444-8444-444444444444', 'inactive');
UPDATE public.user_profiles
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = '44444444-4444-4444-8444-444444444444';
SQL

psql_cmd -f "$FOLLOW_MIGRATION" >/dev/null
psql_cmd -f "$BLOCK_MIGRATION" >/dev/null
psql_cmd -f "$BLOCK_MIGRATION" >/dev/null

expect_eq "$(psql_cmd -Atqc "SELECT has_function_privilege('service_role', 'public.mutate_user_block_atomic(uuid,uuid,text)', 'EXECUTE')")" "t" "service execute"
expect_eq "$(psql_cmd -Atqc "SELECT has_function_privilege('authenticated', 'public.mutate_user_block_atomic(uuid,uuid,text)', 'EXECUTE')")" "f" "authenticated execute"
expect_eq "$(psql_cmd -Atqc "SELECT has_function_privilege('anon', 'public.mutate_user_block_atomic(uuid,uuid,text)', 'EXECUTE')")" "f" "anon execute"

psql_cmd -qc "GRANT EXECUTE ON FUNCTION public.mutate_user_block_atomic(uuid,uuid,text) TO authenticated"
if psql_cmd -qc "SET ROLE authenticated; SET request.jwt.claim.role = 'authenticated'; SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$TARGET_ID', 'block')" >"$AUTH_LOG" 2>&1; then
  echo "authenticated caller bypassed the block RPC role assertion" >&2
  exit 1
fi
grep -q 'service role required for atomic user block mutation' "$AUTH_LOG"
psql_cmd -qc "REVOKE EXECUTE ON FUNCTION public.mutate_user_block_atomic(uuid,uuid,text) FROM authenticated"

expect_eq "$(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$TARGET_ID', 'toggle')->>'status'")" "invalid" "invalid action"
expect_eq "$(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$ACTOR_ID', 'block')->>'status'")" "self" "self block"
expect_eq "$(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$INACTIVE_ID', 'block')->>'status'")" "target_unavailable" "inactive target block"
expect_eq "$(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$MISSING_ID', 'unblock')->>'status'")" "already_unblocked" "missing target unblock"

psql_cmd -qc "UPDATE public.user_profiles SET banned_at = pg_catalog.clock_timestamp() WHERE id = '$ACTOR_ID'"
expect_eq "$(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$TARGET_ID', 'block')->>'status'")" "actor_unavailable" "inactive actor"
psql_cmd -qc "UPDATE public.user_profiles SET banned_at = NULL WHERE id = '$ACTOR_ID'"

# Seed a mutual relationship through the canonical follow boundary, corrupt
# both caches, and prove one block transaction removes both edges and repairs
# all four absolute counts.
service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'follow')" >/dev/null
service_sql "SELECT public.mutate_user_follow_atomic('$TARGET_ID', '$ACTOR_ID', 'follow')" >/dev/null
psql_cmd -qc "UPDATE public.user_profiles SET follower_count = 91, following_count = 92 WHERE id IN ('$ACTOR_ID', '$TARGET_ID')"
RESULT="$(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$TARGET_ID', 'block')")"
expect_eq "$(psql_cmd -Atqc "SELECT '$RESULT'::jsonb->>'status'")" "blocked" "block status"
expect_eq "$(psql_cmd -Atqc "SELECT '$RESULT'::jsonb->>'removed_outgoing_follow'")" "true" "outgoing cleanup ack"
expect_eq "$(psql_cmd -Atqc "SELECT '$RESULT'::jsonb->>'removed_incoming_follow'")" "true" "incoming cleanup ack"
expect_eq "$(psql_cmd -Atqc "SELECT '$RESULT'::jsonb->>'actor_following_count'")" "0" "actor following ack"
expect_eq "$(psql_cmd -Atqc "SELECT '$RESULT'::jsonb->>'target_follower_count'")" "0" "target follower ack"
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.blocked_users WHERE blocker_id = '$ACTOR_ID' AND blocked_id = '$TARGET_ID'")" "1" "block edge"
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.user_follows WHERE follower_id IN ('$ACTOR_ID', '$TARGET_ID') AND following_id IN ('$ACTOR_ID', '$TARGET_ID')")" "0" "bidirectional cleanup"
expect_eq "$(psql_cmd -Atqc "SELECT string_agg(follower_count || ':' || following_count, ',' ORDER BY id) FROM public.user_profiles WHERE id IN ('$ACTOR_ID', '$TARGET_ID')")" "0:0,0:0" "block absolute counters"

expect_eq "$(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$TARGET_ID', 'block')->>'status'")" "already_blocked" "idempotent block"
expect_eq "$(service_sql "SELECT public.mutate_user_follow_atomic('$TARGET_ID', '$ACTOR_ID', 'follow')->>'status'")" "blocked" "block prevents reverse follow"
expect_eq "$(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$TARGET_ID', 'unblock')->>'status'")" "unblocked" "unblock"
expect_eq "$(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$TARGET_ID', 'unblock')->>'status'")" "already_unblocked" "idempotent unblock"

# Unblock is cleanup and remains available after the target becomes inactive.
expect_eq "$(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$TARGET_ID', 'block')->>'status'")" "blocked" "reblock"
psql_cmd -qc "UPDATE public.user_profiles SET deleted_at = pg_catalog.clock_timestamp() WHERE id = '$TARGET_ID'"
expect_eq "$(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$TARGET_ID', 'unblock')->>'status'")" "unblocked" "inactive target unblock"
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.blocked_users WHERE blocker_id = '$ACTOR_ID' AND blocked_id = '$TARGET_ID'")" "0" "inactive target block cleanup"
psql_cmd -qc "UPDATE public.user_profiles SET deleted_at = NULL WHERE id = '$TARGET_ID'"

# Race the follow and block RPCs without ordering them. Whichever acquires the
# shared pair key first, the final committed invariant is block + no follows.
psql_cmd -qc "DELETE FROM public.user_follows; DELETE FROM public.blocked_users; UPDATE public.user_profiles SET follower_count = 0, following_count = 0"
(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'follow')->>'status'" >"$FOLLOW_LOG" 2>&1) &
FOLLOW_PID=$!
(service_sql "SELECT public.mutate_user_block_atomic('$ACTOR_ID', '$TARGET_ID', 'block')->>'status'" >"$BLOCK_LOG" 2>&1) &
BLOCK_PID=$!
wait "$FOLLOW_PID"
wait "$BLOCK_PID"
expect_eq "$(cat "$BLOCK_LOG")" "blocked" "concurrent block status"
if [[ "$(cat "$FOLLOW_LOG")" != "followed" && "$(cat "$FOLLOW_LOG")" != "blocked" ]]; then
  echo "concurrent follow returned unexpected status: $(cat "$FOLLOW_LOG")" >&2
  exit 1
fi
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.blocked_users WHERE blocker_id = '$ACTOR_ID' AND blocked_id = '$TARGET_ID'")" "1" "concurrent block invariant"
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.user_follows WHERE follower_id = '$ACTOR_ID' AND following_id = '$TARGET_ID'")" "0" "concurrent follow invariant"
expect_eq "$(psql_cmd -Atqc "SELECT following_count FROM public.user_profiles WHERE id = '$ACTOR_ID'")" "0" "concurrent actor count"
expect_eq "$(psql_cmd -Atqc "SELECT follower_count FROM public.user_profiles WHERE id = '$TARGET_ID'")" "0" "concurrent target count"

echo "atomic user block PostgreSQL 17 proof passed"
