#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic, participant-bound direct-message settings.
# This owns an isolated temporary cluster and never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729163000_atomic_direct_message_conversation_settings.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-dm-settings-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((64000 + ($$ % 1000)))
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

service_sql() {
  local sql=$1
  psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; $sql"
}

expect_failure() {
  local sql=$1
  if psql_cmd -c "$sql" >"$TMP_ROOT/expected-failure.out" 2>&1; then
    echo "Expected SQL to fail: $sql" >&2
    return 1
  fi
}

assert_scalar() {
  local expected=$1
  local sql=$2
  local actual
  actual="$(psql_cmd -Atqc "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected [$expected], received [$actual] for: $sql" >&2
    return 1
  fi
}

assert_service_scalar() {
  local expected=$1
  local sql=$2
  local actual
  actual="$(service_sql "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "Expected [$expected], received [$actual] for service SQL: $sql" >&2
    return 1
  fi
}

wait_for_query() {
  local pattern=$1
  local attempts=0
  while ((attempts < 200)); do
    if [[ "$(psql_cmd -Atqc "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND query LIKE '%${pattern}%' AND state = 'active')")" == "t" ]]; then
      return 0
    fi
    attempts=$((attempts + 1))
  done
  echo "Timed out waiting for query pattern: $pattern" >&2
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
CREATE ROLE postgres SUPERUSER NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE rogue_role NOLOGIN;

CREATE SCHEMA auth;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb
      ->> 'role'
  )::text
$function$;
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  )::uuid
$function$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role(), auth.uid()
  TO anon, authenticated, service_role;

CREATE FUNCTION public.install_active_authenticated_subject_mutation_barriers()
RETURNS integer
LANGUAGE sql
AS $function$ SELECT 1 $function$;
CREATE FUNCTION public.assert_active_authenticated_subject_mutation_barriers()
RETURNS integer
LANGUAGE sql
AS $function$ SELECT 1 $function$;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz,
  follower_count integer NOT NULL DEFAULT 0,
  following_count integer NOT NULL DEFAULT 0
);
CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user1_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  user2_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  UNIQUE (user1_id, user2_id),
  CHECK (user1_id < user2_id)
);
CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE public.user_follows (
  follower_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (follower_id, following_id)
);
CREATE TABLE public.conversation_members (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  remark text,
  is_muted boolean NOT NULL DEFAULT false,
  is_pinned boolean NOT NULL DEFAULT false,
  is_blocked boolean NOT NULL DEFAULT false,
  cleared_before timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.conversations OWNER TO postgres;
ALTER TABLE public.blocked_users OWNER TO postgres;
ALTER TABLE public.user_follows OWNER TO postgres;
ALTER TABLE public.conversation_members OWNER TO postgres;

ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversation_members_select_policy
ON public.conversation_members FOR SELECT TO authenticated
USING ((SELECT auth.uid()) = user_id);
CREATE POLICY conversation_members_insert_policy
ON public.conversation_members FOR INSERT TO authenticated
WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY conversation_members_update_policy
ON public.conversation_members FOR UPDATE TO authenticated
USING ((SELECT auth.uid()) = user_id)
WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY conversation_members_delete_policy
ON public.conversation_members FOR DELETE TO authenticated
USING ((SELECT auth.uid()) = user_id);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.conversation_members TO authenticated, service_role;
GRANT SELECT ON public.user_profiles, public.conversations,
  public.blocked_users, public.user_follows TO service_role;

CREATE FUNCTION public.serialize_direct_message_pair_edge()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_left uuid;
  v_right uuid;
  v_pair text;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'blocked_users' THEN
      IF TG_OP = 'DELETE' THEN
        v_left := OLD.blocker_id;
        v_right := OLD.blocked_id;
      ELSE
        v_left := NEW.blocker_id;
        v_right := NEW.blocked_id;
      END IF;
    WHEN 'user_follows' THEN
      IF TG_OP = 'DELETE' THEN
        v_left := OLD.follower_id;
        v_right := OLD.following_id;
      ELSE
        v_left := NEW.follower_id;
        v_right := NEW.following_id;
      END IF;
    ELSE
      RAISE EXCEPTION 'unsupported direct-message pair table';
  END CASE;

  v_pair := LEAST(v_left::text, v_right::text)
    || ':' || GREATEST(v_left::text, v_right::text);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.serialize_direct_message_pair_edge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.serialize_direct_message_pair_edge()
  FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER trg_serialize_dm_block_pair
BEFORE INSERT OR UPDATE OR DELETE ON public.blocked_users
FOR EACH ROW EXECUTE FUNCTION public.serialize_direct_message_pair_edge();
CREATE TRIGGER trg_serialize_dm_follow_pair
BEFORE INSERT OR UPDATE OR DELETE ON public.user_follows
FOR EACH ROW EXECUTE FUNCTION public.serialize_direct_message_pair_edge();

CREATE FUNCTION public.mutate_user_block_atomic(
  p_actor_id uuid,
  p_target_id uuid,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_pair text;
  v_changed boolean := false;
  v_affected integer := 0;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;

  PERFORM auth_user.id
  FROM auth.users AS auth_user
  WHERE auth_user.id IN (p_actor_id, p_target_id)
  ORDER BY auth_user.id
  FOR KEY SHARE;

  v_pair := LEAST(p_actor_id::text, p_target_id::text)
    || ':' || GREATEST(p_actor_id::text, p_target_id::text);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
  );

  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id IN (p_actor_id, p_target_id)
  ORDER BY profile.id
  FOR UPDATE;

  IF p_action = 'block' THEN
    INSERT INTO public.blocked_users AS block_edge (blocker_id, blocked_id)
    VALUES (p_actor_id, p_target_id)
    ON CONFLICT (blocker_id, blocked_id) DO NOTHING
    RETURNING true INTO v_changed;
    v_changed := COALESCE(v_changed, false);

    DELETE FROM public.user_follows AS follow_edge
    WHERE (follow_edge.follower_id = p_actor_id AND follow_edge.following_id = p_target_id)
       OR (follow_edge.follower_id = p_target_id AND follow_edge.following_id = p_actor_id);
    v_status := CASE WHEN v_changed THEN 'blocked' ELSE 'already_blocked' END;
  ELSIF p_action = 'unblock' THEN
    DELETE FROM public.blocked_users AS block_edge
    WHERE block_edge.blocker_id = p_actor_id
      AND block_edge.blocked_id = p_target_id;
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    v_changed := v_affected = 1;
    v_status := CASE WHEN v_changed THEN 'unblocked' ELSE 'already_unblocked' END;
  ELSE
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_status,
    'actor_id', p_actor_id,
    'target_id', p_target_id,
    'action', p_action,
    'changed', v_changed,
    'blocked', p_action = 'block',
    'removed_outgoing_follow', false,
    'removed_incoming_follow', false,
    'actor_follower_count', 0,
    'actor_following_count', 0,
    'target_follower_count', 0,
    'target_following_count', 0
  );
END
$function$;
ALTER FUNCTION public.mutate_user_block_atomic(uuid, uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.mutate_user_block_atomic(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mutate_user_block_atomic(uuid, uuid, text)
  TO service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,false,true,true,NULL,false,NULL,false,false)"
expect_failure "SET ROLE rogue_role; SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,false,true,true,NULL,false,NULL,false,false)"
expect_failure "SET ROLE authenticated; INSERT INTO public.conversation_members(conversation_id,user_id) VALUES ('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111')"
expect_failure "SET ROLE service_role; SET request.jwt.claim.role='service_role'; UPDATE public.conversation_members SET is_muted=true"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('12222222-2222-4222-8222-222222222222'),
  ('13333333-3333-4333-8333-333333333333'),
  ('21111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('31111111-1111-4111-8111-111111111111'),
  ('32222222-2222-4222-8222-222222222222'),
  ('41111111-1111-4111-8111-111111111111'),
  ('42222222-2222-4222-8222-222222222222'),
  ('51111111-1111-4111-8111-111111111111'),
  ('52222222-2222-4222-8222-222222222222'),
  ('61111111-1111-4111-8111-111111111111'),
  ('62222222-2222-4222-8222-222222222222');

INSERT INTO public.user_profiles(id) SELECT id FROM auth.users;
UPDATE public.user_profiles
SET deleted_at = pg_catalog.statement_timestamp()
WHERE id = '21111111-1111-4111-8111-111111111111';
UPDATE public.user_profiles
SET is_banned = true
WHERE id = '22222222-2222-4222-8222-222222222222';

INSERT INTO public.conversations(id, user1_id, user2_id) VALUES
  ('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','12222222-2222-4222-8222-222222222222'),
  ('a0000000-0000-4000-8000-000000000002','21111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'),
  ('a0000000-0000-4000-8000-000000000003','31111111-1111-4111-8111-111111111111','32222222-2222-4222-8222-222222222222'),
  ('a0000000-0000-4000-8000-000000000004','41111111-1111-4111-8111-111111111111','42222222-2222-4222-8222-222222222222'),
  ('a0000000-0000-4000-8000-000000000005','51111111-1111-4111-8111-111111111111','52222222-2222-4222-8222-222222222222'),
  ('a0000000-0000-4000-8000-000000000006','61111111-1111-4111-8111-111111111111','62222222-2222-4222-8222-222222222222'),
  ('a0000000-0000-4000-8000-000000000007','13333333-3333-4333-8333-333333333333','22222222-2222-4222-8222-222222222222');
SQL

# Strict input, membership, and inactive-account failures never create rows.
assert_service_scalar 'INVALID' "SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,false,NULL,false,NULL,false,NULL,false,false)->>'reason'"
assert_service_scalar 'INVALID' "SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,false,true,false,NULL,false,NULL,false,false)->>'reason'"
assert_service_scalar 'INVALID' "SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',repeat('x',51),true,NULL,false,NULL,false,NULL,false,false)->>'reason'"
assert_service_scalar 'NOT_FOUND' "SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000001','13333333-3333-4333-8333-333333333333',NULL,false,true,true,NULL,false,NULL,false,false)->>'reason'"
assert_service_scalar 'ACTOR_UNAVAILABLE' "SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000002','21111111-1111-4111-8111-111111111111',NULL,false,true,true,NULL,false,NULL,false,false)->>'reason'"
assert_service_scalar 'ACTOR_UNAVAILABLE' "SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000002','22222222-2222-4222-8222-222222222222',NULL,false,true,true,NULL,false,NULL,false,false)->>'reason'"
assert_service_scalar 'PARTICIPANT_UNAVAILABLE' "SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000007','13333333-3333-4333-8333-333333333333',NULL,false,true,true,NULL,false,NULL,false,false)->>'reason'"
assert_scalar '0' "SELECT count(*) FROM public.conversation_members"

# Create and update preserve omitted fields, trim remarks, and clear only at a
# database-owned monotonic timestamp.
assert_service_scalar 'true|true|buddy|true|false|false|true' "SELECT (r->>'success') || '|' || (r->>'created') || '|' || (r#>>'{settings,remark}') || '|' || (r#>>'{settings,is_muted}') || '|' || (r#>>'{settings,is_pinned}') || '|' || (r#>>'{settings,is_blocked}') || '|' || ((r#>>'{settings,updated_at}') IS NOT NULL)::text FROM (SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','  buddy  ',true,true,true,NULL,false,NULL,false,false) AS r) AS result"
assert_service_scalar 'false|buddy|true|true|true' "SELECT (r->>'created') || '|' || (r#>>'{settings,remark}') || '|' || (r#>>'{settings,is_muted}') || '|' || (r#>>'{settings,is_pinned}') || '|' || ((r#>>'{settings,cleared_before}') IS NOT NULL)::text FROM (SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,false,NULL,false,true,true,NULL,false,true) AS r) AS result"
assert_scalar '1|buddy|true|true|true' "SELECT count(*) || '|' || min(remark) || '|' || bool_and(is_muted) || '|' || bool_and(is_pinned) || '|' || bool_and(cleared_before IS NOT NULL) FROM public.conversation_members WHERE conversation_id='a0000000-0000-4000-8000-000000000001' AND user_id='11111111-1111-4111-8111-111111111111'"

# Disjoint concurrent patches serialize on the settings key and preserve both
# fields without a read/insert/update race or duplicate member row.
psql_cmd >"$TMP_ROOT/settings-owner.out" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.mutate_direct_message_conversation_settings_atomic(
  'a0000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  NULL, false, false, true, NULL, false, NULL, false, false
);
SELECT pg_catalog.pg_sleep(1) /* dm_settings_patch_hold */;
COMMIT;
SQL
settings_pid=$!
wait_for_query 'dm_settings_patch_hold'
assert_service_scalar 'false|false' "SELECT (r#>>'{settings,is_muted}') || '|' || (r#>>'{settings,is_pinned}') FROM (SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,false,NULL,false,false,true,NULL,false,false) AS r) AS result"
wait "$settings_pid"
assert_scalar '1|true|true' "SELECT count(*) || '|' || bool_and(NOT is_muted) || '|' || bool_and(NOT is_pinned) FROM public.conversation_members WHERE conversation_id='a0000000-0000-4000-8000-000000000001' AND user_id='11111111-1111-4111-8111-111111111111'"

# The drawer block action owns the real block edge and follow cleanup, then
# returns the synchronized projection from the same commit.
psql_cmd -qc "INSERT INTO public.user_follows(follower_id,following_id) VALUES ('11111111-1111-4111-8111-111111111111','12222222-2222-4222-8222-222222222222'),('12222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111')"
assert_service_scalar 'blocked|true' "SELECT (r->>'block_status') || '|' || (r#>>'{settings,is_blocked}') FROM (SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,false,NULL,false,NULL,false,true,true,false) AS r) AS result"
assert_scalar '1|0|true' "SELECT (SELECT count(*) FROM public.blocked_users WHERE blocker_id='11111111-1111-4111-8111-111111111111' AND blocked_id='12222222-2222-4222-8222-222222222222') || '|' || (SELECT count(*) FROM public.user_follows WHERE follower_id IN ('11111111-1111-4111-8111-111111111111','12222222-2222-4222-8222-222222222222') AND following_id IN ('11111111-1111-4111-8111-111111111111','12222222-2222-4222-8222-222222222222')) || '|' || (SELECT is_blocked FROM public.conversation_members WHERE conversation_id='a0000000-0000-4000-8000-000000000001' AND user_id='11111111-1111-4111-8111-111111111111')"
assert_service_scalar 'already_blocked' "SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,false,NULL,false,NULL,false,true,true,false)->>'block_status'"
assert_service_scalar 'unblocked|false' "SELECT (r->>'block_status') || '|' || (r#>>'{settings,is_blocked}') FROM (SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',NULL,false,NULL,false,NULL,false,false,true,false) AS r) AS result"
assert_scalar '0|false' "SELECT (SELECT count(*) FROM public.blocked_users WHERE blocker_id='11111111-1111-4111-8111-111111111111' AND blocked_id='12222222-2222-4222-8222-222222222222') || '|' || (SELECT is_blocked FROM public.conversation_members WHERE conversation_id='a0000000-0000-4000-8000-000000000001' AND user_id='11111111-1111-4111-8111-111111111111')"

# A settings-row failure rolls back the nested block and its follow cleanup.
psql_cmd <<'SQL'
INSERT INTO public.user_follows(follower_id, following_id)
VALUES ('31111111-1111-4111-8111-111111111111','32222222-2222-4222-8222-222222222222');
CREATE FUNCTION public.fail_settings_for_test()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.conversation_id = 'a0000000-0000-4000-8000-000000000003' THEN
    RAISE EXCEPTION 'injected settings failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_fail_settings_for_test
BEFORE INSERT OR UPDATE ON public.conversation_members
FOR EACH ROW EXECUTE FUNCTION public.fail_settings_for_test();
SQL
expect_failure "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.mutate_direct_message_conversation_settings_atomic('a0000000-0000-4000-8000-000000000003','31111111-1111-4111-8111-111111111111',NULL,false,NULL,false,NULL,false,true,true,false)"
assert_scalar '0|1|0' "SELECT (SELECT count(*) FROM public.blocked_users WHERE blocker_id='31111111-1111-4111-8111-111111111111' AND blocked_id='32222222-2222-4222-8222-222222222222') || '|' || (SELECT count(*) FROM public.user_follows WHERE follower_id='31111111-1111-4111-8111-111111111111' AND following_id='32222222-2222-4222-8222-222222222222') || '|' || (SELECT count(*) FROM public.conversation_members WHERE conversation_id='a0000000-0000-4000-8000-000000000003')"

# A conversation deletion that wins first is observed as a leave/not-found;
# no settings row is recreated after the parent is gone.
psql_cmd >"$TMP_ROOT/leave-owner.out" 2>&1 <<'SQL' &
BEGIN;
DELETE FROM public.conversations
WHERE id = 'a0000000-0000-4000-8000-000000000004';
SELECT pg_catalog.pg_sleep(1) /* dm_settings_leave_hold */;
COMMIT;
SQL
leave_pid=$!
wait_for_query 'dm_settings_leave_hold'
psql_cmd >"$TMP_ROOT/leave-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.mutate_direct_message_conversation_settings_atomic(
  'a0000000-0000-4000-8000-000000000004',
  '41111111-1111-4111-8111-111111111111',
  NULL, false, true, true, NULL, false, NULL, false, false
);
SQL
leave_waiter_pid=$!
wait "$leave_pid"
wait "$leave_waiter_pid"
if ! grep -Fq '"reason": "NOT_FOUND"' "$TMP_ROOT/leave-waiter.out"; then
  echo "Concurrent conversation leave was not observed" >&2
  cat "$TMP_ROOT/leave-waiter.out" >&2
  exit 1
fi
assert_scalar '0|0' "SELECT (SELECT count(*) FROM public.conversations WHERE id='a0000000-0000-4000-8000-000000000004') || '|' || (SELECT count(*) FROM public.conversation_members WHERE conversation_id='a0000000-0000-4000-8000-000000000004')"

# Hard account deletion owns lifecycle admission first. The settings waiter
# cannot acknowledge a mutation for the deleted identity or recreate children.
psql_cmd >"$TMP_ROOT/delete-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:51111111-1111-4111-8111-111111111111',
    0
  )
);
DELETE FROM auth.users
WHERE id = '51111111-1111-4111-8111-111111111111';
SELECT pg_catalog.pg_sleep(1) /* dm_settings_delete_hold */;
COMMIT;
SQL
delete_pid=$!
wait_for_query 'dm_settings_delete_hold'
psql_cmd >"$TMP_ROOT/delete-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.mutate_direct_message_conversation_settings_atomic(
  'a0000000-0000-4000-8000-000000000005',
  '51111111-1111-4111-8111-111111111111',
  NULL, false, true, true, NULL, false, NULL, false, false
);
SQL
delete_waiter_pid=$!
wait "$delete_pid"
wait "$delete_waiter_pid"
if ! grep -Fq '"reason": "ACTOR_UNAVAILABLE"' "$TMP_ROOT/delete-waiter.out"; then
  echo "Concurrent account deletion was not observed" >&2
  cat "$TMP_ROOT/delete-waiter.out" >&2
  exit 1
fi
assert_scalar '0|0' "SELECT (SELECT count(*) FROM public.conversations WHERE id='a0000000-0000-4000-8000-000000000005') || '|' || (SELECT count(*) FROM public.conversation_members WHERE conversation_id='a0000000-0000-4000-8000-000000000005')"

# A modern ban shares the lifecycle key and wins before settings admission.
psql_cmd >"$TMP_ROOT/ban-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:61111111-1111-4111-8111-111111111111',
    0
  )
);
UPDATE public.user_profiles
SET is_banned = true
WHERE id = '61111111-1111-4111-8111-111111111111';
SELECT pg_catalog.pg_sleep(1) /* dm_settings_ban_hold */;
COMMIT;
SQL
ban_pid=$!
wait_for_query 'dm_settings_ban_hold'
psql_cmd >"$TMP_ROOT/ban-waiter.out" 2>&1 <<'SQL' &
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.mutate_direct_message_conversation_settings_atomic(
  'a0000000-0000-4000-8000-000000000006',
  '61111111-1111-4111-8111-111111111111',
  NULL, false, NULL, false, true, true, NULL, false, false
);
SQL
ban_waiter_pid=$!
wait "$ban_pid"
wait "$ban_waiter_pid"
if ! grep -Fq '"reason": "ACTOR_UNAVAILABLE"' "$TMP_ROOT/ban-waiter.out"; then
  echo "Concurrent account ban was not observed" >&2
  cat "$TMP_ROOT/ban-waiter.out" >&2
  exit 1
fi
assert_scalar '0' "SELECT count(*) FROM public.conversation_members WHERE conversation_id='a0000000-0000-4000-8000-000000000006'"

echo "atomic direct-message conversation-settings PostgreSQL 17 checks passed"
