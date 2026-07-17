#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for atomic user follow/unfollow.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716190000_atomic_user_follow.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-user-follow-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
SAME_A_LOG="$TMP_ROOT/same-a.log"
SAME_B_LOG="$TMP_ROOT/same-b.log"
OPPOSITE_A_LOG="$TMP_ROOT/opposite-a.log"
OPPOSITE_B_LOG="$TMP_ROOT/opposite-b.log"
BLOCK_LOG="$TMP_ROOT/block.log"
FOLLOW_LOG="$TMP_ROOT/follow.log"
PORT=55542
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)); then
    for diagnostic in \
      "$SAME_A_LOG" "$SAME_B_LOG" \
      "$OPPOSITE_A_LOG" "$OPPOSITE_B_LOG" \
      "$BLOCK_LOG" "$FOLLOW_LOG" "$LOG_FILE"; do
      if [[ -f "$diagnostic" ]]; then
        echo "--- ${diagnostic##*/} ---" >&2
        tail -160 "$diagnostic" >&2 || true
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

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
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

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

# Exact function ACL and the internal role assertion both fail closed.
expect_eq "$(psql_cmd -Atqc "SELECT has_function_privilege('service_role', 'public.mutate_user_follow_atomic(uuid,uuid,text)', 'EXECUTE')")" "t" "service execute"
expect_eq "$(psql_cmd -Atqc "SELECT has_function_privilege('authenticated', 'public.mutate_user_follow_atomic(uuid,uuid,text)', 'EXECUTE')")" "f" "authenticated execute"
expect_eq "$(psql_cmd -Atqc "SELECT has_function_privilege('anon', 'public.mutate_user_follow_atomic(uuid,uuid,text)', 'EXECUTE')")" "f" "anon execute"

psql_cmd -qc "GRANT EXECUTE ON FUNCTION public.mutate_user_follow_atomic(uuid,uuid,text) TO authenticated"
if psql_cmd -qc "SET ROLE authenticated; SET request.jwt.claim.role = 'authenticated'; SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'follow')" >"$FOLLOW_LOG" 2>&1; then
  echo "authenticated caller bypassed the RPC role assertion" >&2
  exit 1
fi
grep -q 'service role required for atomic user follow mutation' "$FOLLOW_LOG"
psql_cmd -qc "REVOKE EXECUTE ON FUNCTION public.mutate_user_follow_atomic(uuid,uuid,text) FROM authenticated"

expect_eq "$(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'toggle')->>'status'")" "invalid" "invalid action"
expect_eq "$(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$ACTOR_ID', 'follow')->>'status'")" "self" "self follow"
expect_eq "$(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$INACTIVE_ID', 'follow')->>'status'")" "target_unavailable" "inactive target"
expect_eq "$(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$MISSING_ID', 'follow')->>'status'")" "target_unavailable" "missing target"
expect_eq "$(service_sql "SELECT public.mutate_user_follow_atomic('$MISSING_ID', '$TARGET_ID', 'follow')->>'status'")" "actor_unavailable" "missing actor"

psql_cmd -qc "UPDATE public.user_profiles SET banned_at = pg_catalog.clock_timestamp() WHERE id = '$ACTOR_ID'"
expect_eq "$(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'follow')->>'status'")" "actor_unavailable" "inactive actor"
psql_cmd -qc "UPDATE public.user_profiles SET banned_at = NULL WHERE id = '$ACTOR_ID'"

psql_cmd -qc "INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES ('$TARGET_ID', '$ACTOR_ID')"
expect_eq "$(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'follow')->>'status'")" "blocked" "reverse block"
psql_cmd -qc "DELETE FROM public.blocked_users"

# A newly created mutual pair repairs deliberately corrupted cached counters
# from absolute source-of-truth counts in the same transaction.
psql_cmd -qc "INSERT INTO public.user_follows(follower_id, following_id) VALUES ('$TARGET_ID', '$ACTOR_ID'); UPDATE public.user_profiles SET follower_count = 99, following_count = 98 WHERE id IN ('$ACTOR_ID', '$TARGET_ID')"
RESULT="$(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'follow')")"
expect_eq "$(psql_cmd -Atqc "SELECT '$RESULT'::jsonb->>'status'")" "followed" "new follow status"
expect_eq "$(psql_cmd -Atqc "SELECT '$RESULT'::jsonb->>'mutual'")" "true" "mutual ack"
expect_eq "$(psql_cmd -Atqc "SELECT '$RESULT'::jsonb->>'actor_follower_count'")" "1" "actor follower ack"
expect_eq "$(psql_cmd -Atqc "SELECT '$RESULT'::jsonb->>'actor_following_count'")" "1" "actor following ack"
expect_eq "$(psql_cmd -Atqc "SELECT '$RESULT'::jsonb->>'target_follower_count'")" "1" "target follower ack"
expect_eq "$(psql_cmd -Atqc "SELECT '$RESULT'::jsonb->>'target_following_count'")" "1" "target following ack"
expect_eq "$(psql_cmd -Atqc "SELECT follower_count || ':' || following_count FROM public.user_profiles WHERE id = '$ACTOR_ID'")" "1:1" "actor absolute counters"
expect_eq "$(psql_cmd -Atqc "SELECT follower_count || ':' || following_count FROM public.user_profiles WHERE id = '$TARGET_ID'")" "1:1" "target absolute counters"

psql_cmd -qc "UPDATE public.user_profiles SET follower_count = 77, following_count = 66 WHERE id IN ('$ACTOR_ID', '$TARGET_ID')"
expect_eq "$(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'follow')->>'status'")" "already_following" "idempotent follow"
expect_eq "$(psql_cmd -Atqc "SELECT follower_count || ':' || following_count FROM public.user_profiles WHERE id = '$ACTOR_ID'")" "1:1" "retry repairs drift"
expect_eq "$(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'unfollow')->>'status'")" "unfollowed" "unfollow"
expect_eq "$(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'unfollow')->>'status'")" "already_not_following" "idempotent unfollow"
expect_eq "$(psql_cmd -Atqc "SELECT follower_count || ':' || following_count FROM public.user_profiles WHERE id = '$ACTOR_ID'")" "1:0" "unfollow actor counters"
expect_eq "$(psql_cmd -Atqc "SELECT follower_count || ':' || following_count FROM public.user_profiles WHERE id = '$TARGET_ID'")" "0:1" "unfollow target counters"

# Concurrent duplicate follows serialize on one unordered pair. Exactly one
# inserts, both return a valid idempotent ACK, and counters remain absolute.
psql_cmd -qc "DELETE FROM public.user_follows; UPDATE public.user_profiles SET follower_count = 0, following_count = 0"
(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'follow')->>'status'" >"$SAME_A_LOG" 2>&1) &
SAME_A_PID=$!
(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'follow')->>'status'" >"$SAME_B_LOG" 2>&1) &
SAME_B_PID=$!
wait "$SAME_A_PID"
wait "$SAME_B_PID"
SAME_RESULTS="$(sort "$SAME_A_LOG" "$SAME_B_LOG" | tr '\n' ':' | sed 's/:$//')"
expect_eq "$SAME_RESULTS" "already_following:followed" "concurrent duplicate statuses"
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.user_follows")" "1" "concurrent duplicate edge count"
expect_eq "$(psql_cmd -Atqc "SELECT following_count FROM public.user_profiles WHERE id = '$ACTOR_ID'")" "1" "concurrent actor count"
expect_eq "$(psql_cmd -Atqc "SELECT follower_count FROM public.user_profiles WHERE id = '$TARGET_ID'")" "1" "concurrent target count"

# Opposite-direction operations use the same unordered pair key, avoiding a
# deadlock while producing exact mutual counts.
psql_cmd -qc "DELETE FROM public.user_follows; UPDATE public.user_profiles SET follower_count = 0, following_count = 0"
(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'follow')->>'status'" >"$OPPOSITE_A_LOG" 2>&1) &
OPPOSITE_A_PID=$!
(service_sql "SELECT public.mutate_user_follow_atomic('$TARGET_ID', '$ACTOR_ID', 'follow')->>'status'" >"$OPPOSITE_B_LOG" 2>&1) &
OPPOSITE_B_PID=$!
wait "$OPPOSITE_A_PID"
wait "$OPPOSITE_B_PID"
expect_eq "$(cat "$OPPOSITE_A_LOG")" "followed" "opposite A status"
expect_eq "$(cat "$OPPOSITE_B_LOG")" "followed" "opposite B status"
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.user_follows")" "2" "mutual edge count"
expect_eq "$(psql_cmd -Atqc "SELECT string_agg(follower_count || ':' || following_count, ',' ORDER BY id) FROM public.user_profiles WHERE id IN ('$ACTOR_ID', '$TARGET_ID')")" "1:1,1:1" "mutual exact counters"

# A block transaction that owns the canonical pair key commits before the
# waiting follow rechecks blocked_users. The stale pre-wait snapshot must not
# permit a post-block edge.
psql_cmd -qc "DELETE FROM public.user_follows; DELETE FROM public.blocked_users; UPDATE public.user_profiles SET follower_count = 0, following_count = 0"
(
  psql_cmd -qc "BEGIN; INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES ('$TARGET_ID', '$ACTOR_ID'); SELECT pg_catalog.pg_sleep(0.8); COMMIT" >"$BLOCK_LOG" 2>&1
) &
BLOCK_PID=$!
sleep 0.15
(service_sql "SELECT public.mutate_user_follow_atomic('$ACTOR_ID', '$TARGET_ID', 'follow')->>'status'" >"$FOLLOW_LOG" 2>&1) &
FOLLOW_PID=$!
wait "$BLOCK_PID"
wait "$FOLLOW_PID"
expect_eq "$(cat "$FOLLOW_LOG")" "blocked" "block race status"
expect_eq "$(psql_cmd -Atqc "SELECT count(*) FROM public.user_follows")" "0" "block race edge invariant"

echo "atomic user follow PostgreSQL 17 proof passed"
