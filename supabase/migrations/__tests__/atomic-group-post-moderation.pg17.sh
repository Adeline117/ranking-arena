#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic group post moderation. It owns an isolated
# temporary cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729150500_atomic_group_post_moderation.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-group-post-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((56000 + ($$ % 5000)))
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

expect_failure() {
  local sql=$1
  if psql_cmd -c "$sql" >"$TMP_ROOT/expected-failure.out" 2>&1; then
    echo "Expected SQL to fail: $sql" >&2
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
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, rogue_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role, rogue_role;

CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  dissolved_at timestamptz
);
CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  group_id uuid REFERENCES public.groups(id),
  author_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title text,
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text
);
CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL DEFAULT 'member',
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.group_audit_log (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  group_id uuid REFERENCES public.groups(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  target_id uuid,
  details jsonb,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.groups OWNER TO postgres;
ALTER TABLE public.posts OWNER TO postgres;
ALTER TABLE public.group_members OWNER TO postgres;
ALTER TABLE public.group_audit_log OWNER TO postgres;

CREATE FUNCTION public.serialize_group_membership_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_key text;
BEGIN
  v_key := 'group-membership:'
    || COALESCE(NEW.group_id, OLD.group_id)::text || ':'
    || COALESCE(NEW.user_id, OLD.user_id)::text;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_key, 0)
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.serialize_group_membership_edge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.serialize_group_membership_edge() FROM PUBLIC;
CREATE TRIGGER trg_group_members_05_serialize_edge
  BEFORE INSERT OR UPDATE OF group_id, user_id OR DELETE
  ON public.group_members
  FOR EACH ROW
  EXECUTE FUNCTION public.serialize_group_membership_edge();

CREATE FUNCTION public.set_group_member_role_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_target_id uuid,
  p_role text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM auth_user.id
  FROM auth.users AS auth_user
  WHERE auth_user.id IN (p_actor_id, p_target_id)
  FOR SHARE;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || p_group_id::text || ':' || p_actor_id::text,
      0
    )
  );
  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id IN (p_actor_id, p_target_id)
  FOR UPDATE;
  PERFORM target_group.id
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id
  FOR UPDATE;
  PERFORM member.user_id
  FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.user_id IN (p_actor_id, p_target_id)
  FOR UPDATE;
  RETURN pg_catalog.jsonb_build_object('success', true, 'role', p_role);
END
$function$;
ALTER FUNCTION public.set_group_member_role_atomic(uuid, uuid, uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_group_member_role_atomic(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.set_group_member_role_atomic(uuid, uuid, uuid, text)
  TO service_role;

CREATE FUNCTION public.moderate_group_comment_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_comment_id uuid,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM target_post.id
  FROM public.posts AS target_post
  WHERE target_post.id = p_comment_id
  FOR UPDATE;
  PERFORM target_group.id
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id
  FOR UPDATE;
  PERFORM member.user_id
  FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.user_id = p_actor_id
  FOR UPDATE;
  RETURN pg_catalog.jsonb_build_object('success', false, 'reason', p_reason);
END
$function$;
ALTER FUNCTION public.moderate_group_comment_atomic(uuid, uuid, uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.moderate_group_comment_atomic(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.moderate_group_comment_atomic(uuid, uuid, uuid, text)
  TO service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SELECT public.moderate_group_post_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','Deleted by admin')"
expect_failure "SET ROLE rogue_role; SELECT public.moderate_group_post_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','Deleted by admin')"

psql_cmd <<'SQL'
INSERT INTO auth.users (id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
INSERT INTO public.user_profiles (id, deleted_at) VALUES
  ('11111111-1111-4111-8111-111111111111', NULL),
  ('22222222-2222-4222-8222-222222222222', NULL),
  ('33333333-3333-4333-8333-333333333333', pg_catalog.clock_timestamp());
INSERT INTO public.groups (id, dissolved_at) VALUES
  ('10000000-0000-4000-8000-000000000001', NULL),
  ('20000000-0000-4000-8000-000000000002', NULL),
  ('30000000-0000-4000-8000-000000000003', pg_catalog.clock_timestamp());
INSERT INTO public.group_members (group_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'admin'),
  ('10000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'member'),
  ('10000000-0000-4000-8000-000000000001', '33333333-3333-4333-8333-333333333333', 'admin'),
  ('20000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'admin'),
  ('30000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'admin');
INSERT INTO public.posts (
  id, group_id, author_id, title, deleted_at, deleted_by, delete_reason
) VALUES
  ('a0000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Unsafe post', NULL, NULL, NULL),
  ('a0000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'Member target', NULL, NULL, NULL),
  ('a0000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Inactive target', NULL, NULL, NULL),
  ('a0000000-0000-4000-8000-000000000004', '10000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Race target', NULL, NULL, NULL),
  ('a0000000-0000-4000-8000-000000000005', '10000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Move target', NULL, NULL, NULL),
  ('a0000000-0000-4000-8000-000000000006', '10000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'Previously deleted', pg_catalog.clock_timestamp(), '11111111-1111-4111-8111-111111111111', 'Earlier moderation'),
  ('b0000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'Other group', NULL, NULL, NULL),
  ('c0000000-0000-4000-8000-000000000001', '30000000-0000-4000-8000-000000000003', '22222222-2222-4222-8222-222222222222', 'Dissolved history', NULL, NULL, NULL);
SQL

moderated="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.moderate_group_post_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','  Deleted by admin  ')")"
if [[ "$moderated" != *'"success": true'* ]] \
  || [[ "$moderated" != *'"author_id": "22222222-2222-4222-8222-222222222222"'* ]] \
  || [[ "$moderated" != *'"title": "Unsafe post"'* ]] \
  || [[ "$moderated" != *'"audit_id":'* ]]; then
  echo "Exact post deletion acknowledgement drifted: $moderated" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT deleted_by::text || ':' || delete_reason FROM public.posts WHERE id='a0000000-0000-4000-8000-000000000001'")" != "11111111-1111-4111-8111-111111111111:Deleted by admin" ]]; then
  echo "Post soft-deletion evidence drifted" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT action || ':' || (details->>'reason') || ':' || (details->>'title') FROM public.group_audit_log")" != "delete_post:Deleted by admin:Unsafe post" ]]; then
  echo "Post moderation audit evidence drifted" >&2
  exit 1
fi

audit_count="$(psql_cmd -Atqc "SELECT count(*) FROM public.group_audit_log")"
already_deleted="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.moderate_group_post_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000001','Deleted by admin')")"
if [[ "$already_deleted" != '{"reason": "POST_ALREADY_DELETED", "success": false}' ]] \
  || [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_audit_log")" != "$audit_count" ]]; then
  echo "Already-deleted retry changed evidence: $already_deleted" >&2
  exit 1
fi

member_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.moderate_group_post_atomic('22222222-2222-4222-8222-222222222222','10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000002','Deleted by admin')")"
inactive_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.moderate_group_post_atomic('33333333-3333-4333-8333-333333333333','10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000003','Deleted by admin')")"
mismatch_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.moderate_group_post_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','b0000000-0000-4000-8000-000000000001','Deleted by admin')")"
dissolved_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.moderate_group_post_atomic('11111111-1111-4111-8111-111111111111','30000000-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000001','Deleted by admin')")"
prior_denial="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.moderate_group_post_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000006','Deleted by admin')")"
if [[ "$member_denial" != '{"reason": "PERMISSION_DENIED", "success": false}' ]] \
  || [[ "$inactive_denial" != '{"reason": "ACTOR_UNAVAILABLE", "success": false}' ]] \
  || [[ "$mismatch_denial" != '{"reason": "POST_NOT_IN_GROUP", "success": false}' ]] \
  || [[ "$dissolved_denial" != '{"reason": "GROUP_DISSOLVED", "success": false}' ]] \
  || [[ "$prior_denial" != '{"reason": "POST_ALREADY_DELETED", "success": false}' ]]; then
  echo "A post moderation denial contract drifted" >&2
  exit 1
fi

if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.posts WHERE id IN ('a0000000-0000-4000-8000-000000000002','a0000000-0000-4000-8000-000000000003','b0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001') AND deleted_at IS NULL")" != "4" ]]; then
  echo "A denied post moderation path changed content" >&2
  exit 1
fi

# Resource identity is re-read under the post lock. A concurrent legacy move
# commits first; the RPC then rejects the requested-group mismatch and preserves
# deletion state and audit history.
before_move_audits="$(psql_cmd -Atqc "SELECT count(*) FROM public.group_audit_log")"
psql_cmd \
  -c "BEGIN; UPDATE public.posts SET group_id='20000000-0000-4000-8000-000000000002' WHERE id='a0000000-0000-4000-8000-000000000005'; SELECT pg_catalog.pg_sleep(2); COMMIT" \
  >"$TMP_ROOT/move.out" 2>&1 &
move_pid=$!
sleep 0.3
move_result="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.moderate_group_post_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000005','Deleted by admin')")"
wait "$move_pid"
if [[ "$move_result" != '{"reason": "POST_NOT_IN_GROUP", "success": false}' ]] \
  || [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.posts WHERE id='a0000000-0000-4000-8000-000000000005' AND deleted_at IS NULL")" != "1" ]] \
  || [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_audit_log")" != "$before_move_audits" ]]; then
  echo "Concurrent post move penetrated resource binding: $move_result" >&2
  exit 1
fi

# The destructive writer must also wait for a concurrent role change, re-read
# current manager authority, and deny without changing the post or audit log.
before_race_audits="$(psql_cmd -Atqc "SELECT count(*) FROM public.group_audit_log")"
psql_cmd \
  -c "BEGIN; UPDATE public.group_members SET role='member' WHERE group_id='10000000-0000-4000-8000-000000000001' AND user_id='11111111-1111-4111-8111-111111111111'; SELECT pg_catalog.pg_sleep(2); COMMIT" \
  >"$TMP_ROOT/demotion.out" 2>&1 &
demotion_pid=$!
sleep 0.3
race_result="$(psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.moderate_group_post_atomic('11111111-1111-4111-8111-111111111111','10000000-0000-4000-8000-000000000001','a0000000-0000-4000-8000-000000000004','Deleted by admin')")"
wait "$demotion_pid"
if [[ "$race_result" != '{"reason": "PERMISSION_DENIED", "success": false}' ]] \
  || [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.posts WHERE id='a0000000-0000-4000-8000-000000000004' AND deleted_at IS NULL")" != "1" ]] \
  || [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_audit_log")" != "$before_race_audits" ]]; then
  echo "Concurrent manager demotion penetrated post moderation: $race_result" >&2
  exit 1
fi

echo "atomic-group-post-moderation PG17 tests passed"
