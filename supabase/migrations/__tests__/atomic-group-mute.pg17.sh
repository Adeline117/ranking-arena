#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for atomic group mute/unmute.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716165000_atomic_group_mute.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ ! -f "$MIGRATION" ]]; then
  echo "Atomic group-mute migration is missing: $MIGRATION" >&2
  exit 1
fi
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/atomic-group-mute-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55531
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    echo "PostgreSQL 17 integration cluster log:" >&2
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

OWNER_ID="'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'"
ADMIN_ID="'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'"
MEMBER_ID="'cccccccc-cccc-4ccc-8ccc-cccccccccccc'"
MEMBER_2_ID="'dddddddd-dddd-4ddd-8ddd-dddddddddddd'"
ADMIN_2_ID="'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'"
GROUP_ID="'10000000-0000-4000-8000-000000000001'"
DISSOLVE_GROUP_ID="'20000000-0000-4000-8000-000000000002'"

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT;
CREATE ROLE drifted_moderator NOLOGIN;

-- Reproduce managed Supabase's postgres/public default sequence grants. The
-- owner-only mute ledger migration must remove these inherited privileges.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, UPDATE, USAGE ON SEQUENCES
  TO anon, authenticated, service_role;

-- PostgREST must be able to SET the JWT-selected role, but it must not
-- automatically inherit service_role while it remains authenticator.
GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

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

GRANT USAGE ON SCHEMA public, auth
  TO anon, authenticated, service_role, drifted_moderator;
GRANT EXECUTE ON FUNCTION auth.role()
  TO anon, authenticated, service_role, drifted_moderator;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
ALTER TABLE auth.users OWNER TO postgres;
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES auth.users(id),
  dissolved_at timestamptz,
  member_count integer NOT NULL DEFAULT 0
);
CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  muted_until timestamptz,
  mute_reason text,
  muted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
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
ALTER TABLE public.group_members OWNER TO postgres;
ALTER TABLE public.group_audit_log OWNER TO postgres;

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY browser_read ON public.group_members
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY server_mutation ON public.group_members
  FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT ON public.group_members TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.group_members TO service_role;

CREATE FUNCTION public.serialize_group_membership_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_group_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.group_id ELSE NEW.group_id END;
  v_user_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.user_id ELSE NEW.user_id END;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || v_group_id::text || ':' || v_user_id::text,
      0
    )
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.serialize_group_membership_edge() OWNER TO postgres;
CREATE TRIGGER trg_group_members_05_serialize_edge
  BEFORE INSERT OR UPDATE OF group_id, user_id OR DELETE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.serialize_group_membership_edge();

-- Minimal canonical kick fixture with the same advisory/profile/group/member
-- order as the production moderation migration.
CREATE FUNCTION public.moderate_group_member_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_target_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_first_edge text;
  v_second_edge text;
BEGIN
  IF p_action <> 'kick' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  v_first_edge := 'group-membership:' || p_group_id::text || ':'
    || LEAST(p_actor_id::text, p_target_id::text);
  v_second_edge := 'group-membership:' || p_group_id::text || ':'
    || GREATEST(p_actor_id::text, p_target_id::text);
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_first_edge, 0));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_second_edge, 0));
  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id IN (p_actor_id, p_target_id)
  ORDER BY profile.id
  FOR UPDATE;
  PERFORM target_group.id
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id
  FOR UPDATE;
  PERFORM member.user_id
  FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.user_id IN (p_actor_id, p_target_id)
  ORDER BY member.user_id
  FOR UPDATE;
  DELETE FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.user_id = p_target_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_member');
  END IF;
  INSERT INTO public.group_audit_log(group_id, actor_id, action, target_id, details)
  VALUES (
    p_group_id,
    p_actor_id,
    'member_kicked',
    p_target_id,
    pg_catalog.jsonb_build_object('reason', p_reason)
  );
  RETURN pg_catalog.jsonb_build_object('status', 'kicked');
END
$function$;
ALTER FUNCTION public.moderate_group_member_atomic(uuid, uuid, uuid, text, text)
  OWNER TO postgres;

CREATE FUNCTION public.purge_deleted_account_group_edges(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
  SELECT pg_catalog.jsonb_build_object('status', 'fixture')
$function$;
ALTER FUNCTION public.purge_deleted_account_group_edges(uuid) OWNER TO postgres;

INSERT INTO auth.users(id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  ('ffffffff-ffff-4fff-8fff-ffffffffffff');
INSERT INTO public.user_profiles(id) SELECT id FROM auth.users;
INSERT INTO public.groups(id, name, created_by) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    'Safety group',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    'Dissolve race',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
INSERT INTO public.group_members(group_id, user_id, role) VALUES
  ('10000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('10000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'admin'),
  ('10000000-0000-4000-8000-000000000001', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'member'),
  ('10000000-0000-4000-8000-000000000001', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'member'),
  ('10000000-0000-4000-8000-000000000001', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'admin'),
  ('20000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('20000000-0000-4000-8000-000000000002', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'member');
SQL

psql_cmd -f "$MIGRATION" >"$LOG_DIR/fresh-apply.log"

rpc() {
  local actor="$1"
  local group_id="$2"
  local target="$3"
  local action="$4"
  local muted_until="$5"
  local reason="$6"
  psql_cmd -Atqc \
    "SET request.jwt.claim.role = 'service_role'; SET ROLE service_role; SELECT public.moderate_group_mute_atomic(pg_catalog.gen_random_uuid(), '$actor', '$group_id', '$target', '$action', $muted_until, $reason); RESET ROLE;"
}

rpc_with_operation() {
  local operation_id="$1"
  local actor="$2"
  local group_id="$3"
  local target="$4"
  local action="$5"
  local muted_until="$6"
  local reason="$7"
  psql_cmd -Atqc \
    "SET request.jwt.claim.role = 'service_role'; SET ROLE service_role; SELECT public.moderate_group_mute_atomic('$operation_id', '$actor', '$group_id', '$target', '$action', $muted_until, $reason); RESET ROLE;"
}

assert_reason() {
  local expected="$1"
  shift
  local actual
  actual="$(rpc "$@")"
  if [[ "$(psql_cmd -Atqc "SELECT ('$actual'::jsonb)->>'reason'")" != "$expected" ]]; then
    echo "Expected mute denial $expected, got $actual" >&2
    exit 1
  fi
}

wait_for_sleep_gate() {
  local application_name="$1"
  for _ in {1..100}; do
    if [[ "$(psql_cmd -Atqc "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity WHERE application_name = '$application_name' AND state = 'active' AND wait_event = 'PgSleep')")" == "t" ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "Timed out waiting for concurrency gate: $application_name" >&2
  exit 1
}

wait_for_relation_lock() {
  local application_name="$1"
  local relation_name="$2"
  for _ in {1..100}; do
    if [[ "$(psql_cmd -Atqc "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_stat_activity AS activity CROSS JOIN LATERAL pg_catalog.pg_blocking_pids(activity.pid) AS blocker_pid WHERE activity.application_name = '$application_name' AND activity.wait_event_type = 'Lock' AND EXISTS (SELECT 1 FROM pg_catalog.pg_locks AS waiting_lock WHERE waiting_lock.pid = activity.pid AND NOT waiting_lock.granted AND waiting_lock.relation = '$relation_name'::regclass))")" == "t" ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "Timed out waiting for relation lock: $application_name -> $relation_name" >&2
  exit 1
}

wait_for_success() {
  local process_id="$1"
  local description="$2"
  local log_file="$3"
  if ! wait "$process_id"; then
    echo "$description failed" >&2
    cat "$log_file" >&2
    exit 1
  fi
}

assert_no_lock_failure() {
  local log_file="$1"
  if grep -Eiq 'deadlock detected|lock timeout|statement timeout|canceling statement|55P03|40P01' "$log_file"; then
    echo "Unexpected concurrency failure in $log_file" >&2
    cat "$log_file" >&2
    exit 1
  fi
}

assert_identity_deleted() {
  local user_id="$1"
  local residual
  residual="$(psql_cmd -Atqc "SELECT (SELECT count(*) FROM auth.users WHERE id='$user_id') + (SELECT count(*) FROM public.user_profiles WHERE id='$user_id') + (SELECT count(*) FROM public.group_members WHERE user_id='$user_id')")"
  if [[ "$residual" != "0" ]]; then
    echo "Auth cascade retained identity rows for $user_id" >&2
    exit 1
  fi
}

# ACL is two-layered: browser roles cannot execute the RPC or directly update
# mute state, while service_role can execute it.
if psql_cmd -c \
  "SET request.jwt.claim.role='authenticated'; SET ROLE authenticated; SELECT public.moderate_group_mute_atomic(pg_catalog.gen_random_uuid(), $ADMIN_ID, $GROUP_ID, $MEMBER_ID, 'mute', now() + interval '3 hours', NULL);" \
  >"$LOG_DIR/authenticated-rpc.log" 2>&1; then
  echo "Authenticated role unexpectedly executed group mute" >&2
  exit 1
fi
grep -Fq 'permission denied for function moderate_group_mute_atomic' \
  "$LOG_DIR/authenticated-rpc.log"
if psql_cmd -c \
  "SET ROLE authenticated; UPDATE public.group_members SET muted_until=now() WHERE group_id=$GROUP_ID AND user_id=$MEMBER_ID;" \
  >"$LOG_DIR/authenticated-update.log" 2>&1; then
  echo "Authenticated role unexpectedly updated group mute state" >&2
  exit 1
fi
grep -Fq 'permission denied for table group_members' "$LOG_DIR/authenticated-update.log"
if psql_cmd -c \
  "SET request.jwt.claim.role='service_role'; SET ROLE service_role; SELECT * FROM public.group_mute_operations;" \
  >"$LOG_DIR/service-ledger-read.log" 2>&1; then
  echo "service_role unexpectedly read the mute operation ledger" >&2
  exit 1
fi
grep -Fq 'permission denied for table group_mute_operations' \
  "$LOG_DIR/service-ledger-read.log"
if psql_cmd -c \
  "SET request.jwt.claim.role='service_role'; SET ROLE service_role; DELETE FROM public.groups WHERE id=$DISSOLVE_GROUP_ID;" \
  >"$LOG_DIR/service-group-delete.log" 2>&1; then
  echo "service_role unexpectedly gained direct group DELETE" >&2
  exit 1
fi
grep -Fq 'permission denied for table groups' "$LOG_DIR/service-group-delete.log"

# Permission and account-state decisions fail closed.
assert_reason SELF_FORBIDDEN \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  10000000-0000-4000-8000-000000000001 \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  mute "now() + interval '3 hours'" NULL
assert_reason OWNER_FORBIDDEN \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  10000000-0000-4000-8000-000000000001 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  mute "now() + interval '3 hours'" NULL
assert_reason HIERARCHY_FORBIDDEN \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  10000000-0000-4000-8000-000000000001 \
  eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee \
  mute "now() + interval '3 hours'" NULL
assert_reason ACTOR_NOT_MANAGER \
  cccccccc-cccc-4ccc-8ccc-cccccccccccc \
  10000000-0000-4000-8000-000000000001 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  mute "now() + interval '3 hours'" NULL
assert_reason TARGET_NOT_MEMBER \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  10000000-0000-4000-8000-000000000001 \
  ffffffff-ffff-4fff-8fff-ffffffffffff \
  mute "now() + interval '3 hours'" NULL
psql_cmd -c \
  "UPDATE public.user_profiles SET deleted_at=now() WHERE id=$MEMBER_2_ID" >/dev/null
assert_reason TARGET_UNAVAILABLE \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  10000000-0000-4000-8000-000000000001 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  mute "now() + interval '3 hours'" NULL
psql_cmd -c \
  "UPDATE public.user_profiles SET deleted_at=NULL WHERE id=$MEMBER_2_ID" >/dev/null

# Exact mute and unmute retries do not duplicate audit rows. Owner-to-admin is
# valid; blank reasons canonicalize to null.
MUTE_UNTIL="$(psql_cmd -Atqc "SELECT pg_catalog.clock_timestamp() + interval '7 days'")"
FIRST_MUTE="$(rpc_with_operation \
  90000000-0000-4000-8000-000000000001 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  10000000-0000-4000-8000-000000000001 \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  mute "'$MUTE_UNTIL'::timestamptz" "'   '")"
SECOND_MUTE="$(rpc_with_operation \
  90000000-0000-4000-8000-000000000001 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  10000000-0000-4000-8000-000000000001 \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  mute "'$MUTE_UNTIL'::timestamptz" "'   '")"
psql_cmd -v first="$FIRST_MUTE" -v second="$SECOND_MUTE" <<'SQL'
SELECT pg_catalog.set_config('test.first_result', :'first', false);
SELECT pg_catalog.set_config('test.second_result', :'second', false);
DO $exact_mute$
DECLARE
  first_result jsonb := pg_catalog.current_setting('test.first_result')::jsonb;
  second_result jsonb := pg_catalog.current_setting('test.second_result')::jsonb;
BEGIN
  IF first_result->>'success' <> 'true'
     OR first_result->>'applied' <> 'true'
     OR first_result->>'operation_id' <>
       '90000000-0000-4000-8000-000000000001'
     OR first_result->>'action' <> 'mute'
     OR first_result->>'group_name' <> 'Safety group'
     OR first_result->>'mute_reason' IS NOT NULL
     OR first_result->>'audit_log_id' IS NULL
     OR second_result->>'success' <> 'true'
     OR second_result->>'applied' <> 'false'
     OR second_result->>'operation_id' <>
       '90000000-0000-4000-8000-000000000001'
     OR second_result->>'audit_log_id' IS NOT NULL
     OR (
       SELECT pg_catalog.count(*)
       FROM public.group_audit_log
       WHERE action = 'mute'
         AND target_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
     ) <> 1
  THEN
    RAISE EXCEPTION 'exact mute retry contract failed: first %, second %',
      first_result, second_result;
  END IF;
END
$exact_mute$;
SQL

THIRD_MUTE="$(rpc_with_operation \
  90000000-0000-4000-8000-000000000003 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  10000000-0000-4000-8000-000000000001 \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  mute "'$MUTE_UNTIL'::timestamptz" "'   '")"
if [[ "$(psql_cmd -Atqc "SELECT ('$THIRD_MUTE'::jsonb)->>'applied'")" != "false" ]] || \
   [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_mute_operations WHERE operation_id='90000000-0000-4000-8000-000000000003' AND NOT initial_applied AND evidence_kind='operation_v2' AND evidence_operation_id='90000000-0000-4000-8000-000000000001'")" != "1" ]]; then
  echo "Different operation UUID did not certify the existing canonical mute" >&2
  exit 1
fi

if rpc_with_operation \
  90000000-0000-4000-8000-000000000001 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  10000000-0000-4000-8000-000000000001 \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  mute "'$MUTE_UNTIL'::timestamptz" "'collision'" \
  >"$LOG_DIR/operation-collision.log" 2>&1; then
  echo "Operation UUID collision unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'operation id payload collision' "$LOG_DIR/operation-collision.log"

FIRST_UNMUTE="$(rpc_with_operation \
  90000000-0000-4000-8000-000000000002 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  10000000-0000-4000-8000-000000000001 \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  unmute NULL NULL)"
SECOND_UNMUTE="$(rpc_with_operation \
  90000000-0000-4000-8000-000000000002 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  10000000-0000-4000-8000-000000000001 \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  unmute NULL NULL)"
psql_cmd -v first="$FIRST_UNMUTE" -v second="$SECOND_UNMUTE" <<'SQL'
SELECT pg_catalog.set_config('test.first_result', :'first', false);
SELECT pg_catalog.set_config('test.second_result', :'second', false);
DO $exact_unmute$
DECLARE
  first_result jsonb := pg_catalog.current_setting('test.first_result')::jsonb;
  second_result jsonb := pg_catalog.current_setting('test.second_result')::jsonb;
BEGIN
  IF first_result->>'applied' <> 'true'
     OR first_result->>'action' <> 'unmute'
     OR first_result->>'audit_log_id' IS NULL
     OR second_result->>'applied' <> 'false'
     OR second_result->>'audit_log_id' IS NOT NULL
     OR (
       SELECT pg_catalog.count(*)
       FROM public.group_audit_log
       WHERE action = 'unmute'
         AND target_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
     ) <> 1
  THEN
    RAISE EXCEPTION 'exact unmute retry contract failed: first %, second %',
      first_result, second_result;
  END IF;
END
$exact_unmute$;
SQL

# Time-shift a committed three-hour operation and its immutable evidence by
# four hours. This models a response retry after expiry without making the
# proof sleep for three hours: replay must reach the operation ledger before
# the temporal validation used for new operation IDs.
THREE_HOUR_UNTIL="$(psql_cmd -Atqc "SELECT pg_catalog.clock_timestamp() + interval '3 hours'")"
THREE_HOUR_FIRST="$(rpc_with_operation \
  92000000-0000-4000-8000-000000000001 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  10000000-0000-4000-8000-000000000001 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  mute "'$THREE_HOUR_UNTIL'::timestamptz" "'expired replay'")"
psql_cmd <<'SQL'
DO $shift_committed_three_hour_operation$
DECLARE
  operation_row public.group_mute_operations%ROWTYPE;
  expired_until timestamptz;
  translated_details jsonb;
BEGIN
  SELECT *
  INTO STRICT operation_row
  FROM public.group_mute_operations
  WHERE operation_id = '92000000-0000-4000-8000-000000000001';

  expired_until := operation_row.muted_until - interval '4 hours';
  translated_details := pg_catalog.jsonb_set(
    operation_row.evidence_details,
    '{result,muted_until}',
    pg_catalog.to_jsonb(expired_until),
    false
  );

  UPDATE public.group_audit_log
  SET details = translated_details,
      created_at = created_at - interval '4 hours'
  WHERE id = operation_row.audit_log_id;

  UPDATE public.group_mute_operations
  SET muted_until = expired_until,
      evidence_details = translated_details,
      result_muted_until = expired_until,
      created_at = created_at - interval '4 hours'
  WHERE operation_id = operation_row.operation_id;

  UPDATE public.group_members
  SET muted_until = expired_until
  WHERE group_id = operation_row.group_id
    AND user_id = operation_row.target_id;
END
$shift_committed_three_hour_operation$;
SQL
EXPIRED_THREE_HOUR_UNTIL="$(psql_cmd -Atqc "SELECT muted_until FROM public.group_mute_operations WHERE operation_id='92000000-0000-4000-8000-000000000001'")"
THREE_HOUR_REPLAY="$(rpc_with_operation \
  92000000-0000-4000-8000-000000000001 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  10000000-0000-4000-8000-000000000001 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  mute "'$EXPIRED_THREE_HOUR_UNTIL'::timestamptz" "'expired replay'")"
if [[ "$(psql_cmd -Atqc "SELECT ('$THREE_HOUR_FIRST'::jsonb)->>'applied'")" != "true" ]] || \
   [[ "$(psql_cmd -Atqc "SELECT ('$THREE_HOUR_REPLAY'::jsonb)->>'applied'")" != "false" ]] || \
   [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_mute_operations WHERE operation_id='92000000-0000-4000-8000-000000000001' AND muted_until < pg_catalog.clock_timestamp() AND created_at < pg_catalog.clock_timestamp() - interval '3 hours'")" != "1" ]] || \
   [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_audit_log WHERE id=(SELECT audit_log_id FROM public.group_mute_operations WHERE operation_id='92000000-0000-4000-8000-000000000001')")" != "1" ]]; then
  echo "Committed three-hour mute did not replay after expiry" >&2
  exit 1
fi
rpc_with_operation \
  92000000-0000-4000-8000-000000000002 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  10000000-0000-4000-8000-000000000001 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  unmute NULL NULL >/dev/null

# A lost response retried after an intervening opposite operation replays only
# immutable evidence; it must never restore its stale mute state.
STALE_MUTE_REPLAY="$(rpc_with_operation \
  90000000-0000-4000-8000-000000000001 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  10000000-0000-4000-8000-000000000001 \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  mute "'$MUTE_UNTIL'::timestamptz" "'   '")"
if [[ "$(psql_cmd -Atqc "SELECT ('$STALE_MUTE_REPLAY'::jsonb)->>'applied'")" != "false" ]] || \
   [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_members WHERE group_id=$GROUP_ID AND user_id=$ADMIN_ID AND muted_until IS NULL AND mute_reason IS NULL AND muted_by IS NULL")" != "1" ]]; then
  echo "Stale mute operation replay overwrote an intervening unmute" >&2
  exit 1
fi

# Audit retention/tampering cannot erase the durable operation identity. Same
# operation replay is ledger-only; a different no-op operation still requires
# the exact latest audit and therefore fails closed.
psql_cmd <<'SQL'
DELETE FROM public.group_audit_log
WHERE id = (
  SELECT audit_log_id
  FROM public.group_mute_operations
  WHERE operation_id = '90000000-0000-4000-8000-000000000001'
);
UPDATE public.group_audit_log
SET details = '{"forged":true}'::jsonb
WHERE id = (
  SELECT audit_log_id
  FROM public.group_mute_operations
  WHERE operation_id = '90000000-0000-4000-8000-000000000002'
);
SQL
AUDIT_DELETED_REPLAY="$(rpc_with_operation \
  90000000-0000-4000-8000-000000000001 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  10000000-0000-4000-8000-000000000001 \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  mute "'$MUTE_UNTIL'::timestamptz" "'   '")"
AUDIT_TAMPERED_REPLAY="$(rpc_with_operation \
  90000000-0000-4000-8000-000000000002 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  10000000-0000-4000-8000-000000000001 \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  unmute NULL NULL)"
if [[ "$(psql_cmd -Atqc "SELECT ('$AUDIT_DELETED_REPLAY'::jsonb)->>'applied'")" != "false" ]] || \
   [[ "$(psql_cmd -Atqc "SELECT ('$AUDIT_TAMPERED_REPLAY'::jsonb)->>'applied'")" != "false" ]] || \
   [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_mute_operations WHERE operation_id IN ('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000002')")" != "2" ]]; then
  echo "Audit retention erased or altered durable operation replay" >&2
  exit 1
fi
if rpc_with_operation \
  90000000-0000-4000-8000-000000000004 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  10000000-0000-4000-8000-000000000001 \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  unmute NULL NULL >"$LOG_DIR/forged-v2-audit.log" 2>&1; then
  echo "Different operation accepted a tampered v2 audit" >&2
  exit 1
fi
grep -Eq 'SQL state: 40001|exact audit evidence' "$LOG_DIR/forged-v2-audit.log"

# Direct callers cannot bypass temporal/reason/unmute input contracts.
for invalid_call in \
  "public.moderate_group_mute_atomic(pg_catalog.gen_random_uuid(),$ADMIN_ID,$GROUP_ID,$MEMBER_ID,'mute',now(),NULL)" \
  "public.moderate_group_mute_atomic(pg_catalog.gen_random_uuid(),$ADMIN_ID,$GROUP_ID,$MEMBER_ID,'mute',now()+interval '102 years',NULL)" \
  "public.moderate_group_mute_atomic(pg_catalog.gen_random_uuid(),$ADMIN_ID,$GROUP_ID,$MEMBER_ID,'mute',now()+interval '3 hours',repeat('x',501))" \
  "public.moderate_group_mute_atomic(pg_catalog.gen_random_uuid(),$ADMIN_ID,$GROUP_ID,$MEMBER_ID,'unmute',NULL,'')"; do
  if psql_cmd -c \
    "SET request.jwt.claim.role='service_role'; SET ROLE service_role; SELECT $invalid_call;" \
    >"$LOG_DIR/invalid-input.log" 2>&1; then
    echo "Invalid group-mute call unexpectedly succeeded: $invalid_call" >&2
    exit 1
  fi
  grep -Fq 'SQL state: 22023' "$LOG_DIR/invalid-input.log" || \
    grep -Eq 'mute timestamp|mute timestamp/reason|unmute parameters' "$LOG_DIR/invalid-input.log"
done

# Audit failure rolls the membership update back completely.
psql_cmd <<'SQL'
CREATE FUNCTION public.fail_selected_mute_audit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NEW.action = 'mute'
     AND NEW.target_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  THEN
    RAISE EXCEPTION 'injected group mute audit failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_fail_selected_mute_audit
  BEFORE INSERT ON public.group_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.fail_selected_mute_audit();
SQL
if psql_cmd -c \
  "SET request.jwt.claim.role='service_role'; SET ROLE service_role; SELECT public.moderate_group_mute_atomic(pg_catalog.gen_random_uuid(),$ADMIN_ID,$GROUP_ID,$MEMBER_2_ID,'mute',now()+interval '3 hours','rollback');" \
  >"$LOG_DIR/audit-rollback.log" 2>&1; then
  echo "Injected group-mute audit failure unexpectedly committed" >&2
  exit 1
fi
grep -Fq 'injected group mute audit failure' "$LOG_DIR/audit-rollback.log"
psql_cmd <<'SQL'
DO $audit_rollback$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.group_members
    WHERE group_id = '10000000-0000-4000-8000-000000000001'
      AND user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      AND (
        muted_until IS NOT NULL
        OR mute_reason IS NOT NULL
        OR muted_by IS NOT NULL
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.group_audit_log
    WHERE target_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
      AND details #>> '{result,mute_reason}' = 'rollback'
  ) THEN
    RAISE EXCEPTION 'audit failure left partial group mute state';
  END IF;
END
$audit_rollback$;
DROP TRIGGER trg_fail_selected_mute_audit ON public.group_audit_log;
DROP FUNCTION public.fail_selected_mute_audit();
SQL

# Genuine pre-migration state may cross the boundary exactly once using the
# old canonical audit shape. Once sealed, any ledger for that target prevents
# fallback to mutable legacy evidence.
psql_cmd <<'SQL'
INSERT INTO public.groups(id, name, created_by) VALUES
  ('30000000-0000-4000-8000-000000000003', 'Legacy mute', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('40000000-0000-4000-8000-000000000004', 'Auditless legacy', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('50000000-0000-4000-8000-000000000005', 'Forged legacy', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('55000000-0000-4000-8000-000000000055', 'Legacy unmute', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('56000000-0000-4000-8000-000000000056', 'Fictitious legacy unmute', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
INSERT INTO public.group_members(group_id, user_id, role) VALUES
  ('30000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('30000000-0000-4000-8000-000000000003', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'member'),
  ('40000000-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('40000000-0000-4000-8000-000000000004', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'member'),
  ('50000000-0000-4000-8000-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('50000000-0000-4000-8000-000000000005', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'member'),
  ('55000000-0000-4000-8000-000000000055', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('55000000-0000-4000-8000-000000000055', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'member'),
  ('56000000-0000-4000-8000-000000000056', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('56000000-0000-4000-8000-000000000056', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'member');

WITH desired AS (
  UPDATE public.group_members
  SET muted_until = pg_catalog.clock_timestamp() + interval '2 days',
      mute_reason = 'legacy exact',
      muted_by = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  WHERE group_id = '30000000-0000-4000-8000-000000000003'
    AND user_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  RETURNING muted_until
)
INSERT INTO public.group_audit_log(
  group_id,
  actor_id,
  action,
  target_id,
  details,
  created_at
)
SELECT
  '30000000-0000-4000-8000-000000000003',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'mute',
  'ffffffff-ffff-4fff-8fff-ffffffffffff',
  pg_catalog.jsonb_build_object(
    'duration', pg_catalog.to_char(
      desired.muted_until AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ),
    'reason', 'legacy exact'
  ),
  pg_catalog.clock_timestamp()
FROM desired;

UPDATE public.group_members
SET muted_until = pg_catalog.clock_timestamp() + interval '2 days',
    mute_reason = 'auditless',
    muted_by = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
WHERE group_id = '40000000-0000-4000-8000-000000000004'
  AND user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

WITH desired AS (
  UPDATE public.group_members
  SET muted_until = pg_catalog.clock_timestamp() + interval '2 days',
      mute_reason = 'forged',
      muted_by = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  WHERE group_id = '50000000-0000-4000-8000-000000000005'
    AND user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  RETURNING muted_until
)
INSERT INTO public.group_audit_log(
  group_id,
  actor_id,
  action,
  target_id,
  details,
  created_at
)
SELECT
  '50000000-0000-4000-8000-000000000005',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'mute',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  pg_catalog.jsonb_build_object(
    'muted_until', desired.muted_until,
    'reason', 'wrong details'
  ),
  pg_catalog.clock_timestamp()
FROM desired;

INSERT INTO public.group_audit_log(
  group_id,
  actor_id,
  action,
  target_id,
  details,
  created_at
) VALUES (
  '55000000-0000-4000-8000-000000000055',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'unmute',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  '{}'::jsonb,
  pg_catalog.clock_timestamp()
);

INSERT INTO public.group_audit_log(
  group_id,
  actor_id,
  action,
  target_id,
  details,
  created_at
) VALUES (
  '56000000-0000-4000-8000-000000000056',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  'unmute',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  pg_catalog.jsonb_build_object(
    'previous_muted_until', pg_catalog.clock_timestamp() + interval '1 day',
    'previous_reason', 'never emitted by the old route',
    'previous_muted_by', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid
  ),
  pg_catalog.clock_timestamp()
);
SQL

LEGACY_MUTE_UNTIL="$(psql_cmd -Atqc "SELECT muted_until FROM public.group_members WHERE group_id='30000000-0000-4000-8000-000000000003' AND user_id='ffffffff-ffff-4fff-8fff-ffffffffffff'")"
LEGACY_FIRST="$(rpc_with_operation \
  91000000-0000-4000-8000-000000000001 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  30000000-0000-4000-8000-000000000003 \
  ffffffff-ffff-4fff-8fff-ffffffffffff \
  mute "'$LEGACY_MUTE_UNTIL'::timestamptz" "'legacy exact'")"
LEGACY_SECOND="$(rpc_with_operation \
  91000000-0000-4000-8000-000000000002 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  30000000-0000-4000-8000-000000000003 \
  ffffffff-ffff-4fff-8fff-ffffffffffff \
  mute "'$LEGACY_MUTE_UNTIL'::timestamptz" "'legacy exact'")"
LEGACY_UNMUTE="$(rpc_with_operation \
  91000000-0000-4000-8000-000000000003 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  55000000-0000-4000-8000-000000000055 \
  cccccccc-cccc-4ccc-8ccc-cccccccccccc \
  unmute NULL NULL)"
if [[ "$(psql_cmd -Atqc "SELECT ('$LEGACY_FIRST'::jsonb)->>'applied'")" != "false" ]] || \
   [[ "$(psql_cmd -Atqc "SELECT ('$LEGACY_SECOND'::jsonb)->>'applied'")" != "false" ]] || \
   [[ "$(psql_cmd -Atqc "SELECT ('$LEGACY_UNMUTE'::jsonb)->>'applied'")" != "false" ]] || \
   [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_mute_operations WHERE operation_id IN ('91000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000002','91000000-0000-4000-8000-000000000003') AND evidence_kind='legacy_v1' AND evidence_operation_id IS NULL")" != "3" ]]; then
  echo "Canonical legacy evidence was not sealed exactly" >&2
  exit 1
fi

if rpc_with_operation \
  91000000-0000-4000-8000-000000000007 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  56000000-0000-4000-8000-000000000056 \
  cccccccc-cccc-4ccc-8ccc-cccccccccccc \
  unmute NULL NULL >"$LOG_DIR/fictitious-legacy-unmute.log" 2>&1; then
  echo "Fictitious three-key legacy unmute audit unexpectedly certified" >&2
  exit 1
fi
grep -Eq 'SQL state: 40001|legacy unmute audit details' \
  "$LOG_DIR/fictitious-legacy-unmute.log"

psql_cmd -c \
  "UPDATE public.group_audit_log SET details='{}'::jsonb WHERE group_id='30000000-0000-4000-8000-000000000003' AND target_id='ffffffff-ffff-4fff-8fff-ffffffffffff'" >/dev/null
if rpc_with_operation \
  91000000-0000-4000-8000-000000000004 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  30000000-0000-4000-8000-000000000003 \
  ffffffff-ffff-4fff-8fff-ffffffffffff \
  mute "'$LEGACY_MUTE_UNTIL'::timestamptz" "'legacy exact'" \
  >"$LOG_DIR/sealed-legacy-forged.log" 2>&1; then
  echo "Existing ledger fell back to forged legacy audit" >&2
  exit 1
fi
grep -Eq 'SQL state: 40001|exact audit evidence' \
  "$LOG_DIR/sealed-legacy-forged.log"

AUDITLESS_UNTIL="$(psql_cmd -Atqc "SELECT muted_until FROM public.group_members WHERE group_id='40000000-0000-4000-8000-000000000004' AND user_id='dddddddd-dddd-4ddd-8ddd-dddddddddddd'")"
if rpc_with_operation \
  91000000-0000-4000-8000-000000000005 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  40000000-0000-4000-8000-000000000004 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  mute "'$AUDITLESS_UNTIL'::timestamptz" "'auditless'" \
  >"$LOG_DIR/auditless-legacy.log" 2>&1; then
  echo "Auditless legacy state unexpectedly certified" >&2
  exit 1
fi
grep -Eq 'SQL state: 40001|lacks canonical audit evidence' \
  "$LOG_DIR/auditless-legacy.log"

FORGED_UNTIL="$(psql_cmd -Atqc "SELECT muted_until FROM public.group_members WHERE group_id='50000000-0000-4000-8000-000000000005' AND user_id='cccccccc-cccc-4ccc-8ccc-cccccccccccc'")"
if rpc_with_operation \
  91000000-0000-4000-8000-000000000006 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  50000000-0000-4000-8000-000000000005 \
  cccccccc-cccc-4ccc-8ccc-cccccccccccc \
  mute "'$FORGED_UNTIL'::timestamptz" "'forged'" \
  >"$LOG_DIR/forged-legacy.log" 2>&1; then
  echo "Forged legacy audit unexpectedly certified" >&2
  exit 1
fi
grep -Eq 'SQL state: 40001|legacy mute audit details' \
  "$LOG_DIR/forged-legacy.log"

# Role changes are re-read after the membership row lock wait.
PGAPPNAME=mute_actor_demote psql_cmd >"$LOG_DIR/actor-demote.out" 2>&1 <<'SQL' &
BEGIN;
UPDATE public.group_members
SET role = 'member'
WHERE group_id = '10000000-0000-4000-8000-000000000001'
  AND user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
DEMOTE_PID=$!
wait_for_sleep_gate mute_actor_demote
assert_reason ACTOR_NOT_MANAGER \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  10000000-0000-4000-8000-000000000001 \
  cccccccc-cccc-4ccc-8ccc-cccccccccccc \
  mute "now() + interval '3 hours'" NULL
wait "$DEMOTE_PID"
psql_cmd -c \
  "UPDATE public.group_members SET role='admin' WHERE group_id=$GROUP_ID AND user_id=$ADMIN_ID" >/dev/null

PGAPPNAME=mute_target_promote psql_cmd >"$LOG_DIR/target-promote.out" 2>&1 <<'SQL' &
BEGIN;
UPDATE public.group_members
SET role = 'admin'
WHERE group_id = '10000000-0000-4000-8000-000000000001'
  AND user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
PROMOTE_PID=$!
wait_for_sleep_gate mute_target_promote
assert_reason HIERARCHY_FORBIDDEN \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  10000000-0000-4000-8000-000000000001 \
  cccccccc-cccc-4ccc-8ccc-cccccccccccc \
  mute "now() + interval '3 hours'" NULL
wait "$PROMOTE_PID"
psql_cmd -c \
  "UPDATE public.group_members SET role='member' WHERE group_id=$GROUP_ID AND user_id=$MEMBER_ID" >/dev/null

# Kick first removes the target before mute can authorize it.
PGAPPNAME=mute_kick_first psql_cmd >"$LOG_DIR/kick-first.out" 2>&1 <<'SQL' &
BEGIN;
SELECT public.moderate_group_member_atomic(
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '10000000-0000-4000-8000-000000000001',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'kick',
  NULL
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
KICK_PID=$!
wait_for_sleep_gate mute_kick_first
assert_reason TARGET_NOT_MEMBER \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  10000000-0000-4000-8000-000000000001 \
  cccccccc-cccc-4ccc-8ccc-cccccccccccc \
  mute "now() + interval '3 hours'" NULL
wait "$KICK_PID"
psql_cmd -c \
  "INSERT INTO public.group_members(group_id,user_id,role) VALUES ($GROUP_ID,$MEMBER_ID,'member')" >/dev/null

# Mute first commits a complete audit/state transition before kick removes the
# row. No partial mute transaction survives either ordering.
PGAPPNAME=mute_before_kick psql_cmd >"$LOG_DIR/mute-before-kick.out" 2>&1 <<'SQL' &
BEGIN;
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.moderate_group_mute_atomic(
  pg_catalog.gen_random_uuid(),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '10000000-0000-4000-8000-000000000001',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'mute',
  pg_catalog.clock_timestamp() + interval '3 hours',
  'before kick'
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
MUTE_FIRST_PID=$!
wait_for_sleep_gate mute_before_kick
KICK_AFTER="$(psql_cmd -Atqc "SELECT (public.moderate_group_member_atomic($ADMIN_ID,$GROUP_ID,$MEMBER_ID,'kick',NULL))->>'status'")"
wait "$MUTE_FIRST_PID"
if [[ "$KICK_AFTER" != "kicked" ]] || [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_members WHERE group_id=$GROUP_ID AND user_id=$MEMBER_ID")" != "0" ]]; then
  echo "Mute-first/kick-second did not serialize completely" >&2
  exit 1
fi
psql_cmd -c \
  "INSERT INTO public.group_members(group_id,user_id,role) VALUES ($GROUP_ID,$MEMBER_ID,'member')" >/dev/null

# Auth deletion first locks the parent and pauses before its child cascade.
# The RPC must wait on Auth without taking the membership advisory; DELETE can
# then cascade through that advisory with no cycle. Cover target and actor.
PGAPPNAME=mute_target_delete_first psql_cmd >"$LOG_DIR/target-delete-first.out" 2>&1 <<'SQL' &
BEGIN;
SELECT id
FROM auth.users
WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
FOR UPDATE;
SELECT pg_catalog.pg_sleep(2);
DELETE FROM auth.users
WHERE id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
COMMIT;
SQL
TARGET_DELETE_PID=$!
wait_for_sleep_gate mute_target_delete_first
assert_reason TARGET_UNAVAILABLE \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  10000000-0000-4000-8000-000000000001 \
  cccccccc-cccc-4ccc-8ccc-cccccccccccc \
  mute "now() + interval '3 hours'" NULL
wait "$TARGET_DELETE_PID"
assert_identity_deleted cccccccc-cccc-4ccc-8ccc-cccccccccccc
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
INSERT INTO public.user_profiles(id) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
INSERT INTO public.group_members(group_id,user_id,role) VALUES
  ('10000000-0000-4000-8000-000000000001','cccccccc-cccc-4ccc-8ccc-cccccccccccc','member'),
  ('20000000-0000-4000-8000-000000000002','cccccccc-cccc-4ccc-8ccc-cccccccccccc','member');
SQL

PGAPPNAME=mute_actor_delete_first psql_cmd >"$LOG_DIR/actor-delete-first.out" 2>&1 <<'SQL' &
BEGIN;
SELECT id
FROM auth.users
WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
FOR UPDATE;
SELECT pg_catalog.pg_sleep(2);
DELETE FROM auth.users
WHERE id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
COMMIT;
SQL
ACTOR_DELETE_PID=$!
wait_for_sleep_gate mute_actor_delete_first
assert_reason ACTOR_UNAVAILABLE \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  10000000-0000-4000-8000-000000000001 \
  cccccccc-cccc-4ccc-8ccc-cccccccccccc \
  mute "now() + interval '3 hours'" NULL
wait "$ACTOR_DELETE_PID"
assert_identity_deleted bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO public.user_profiles(id) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO public.group_members(group_id,user_id,role) VALUES
  ('10000000-0000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','admin');
SQL

# RPC first holds Auth SHARE through commit; hard deletion waits, then cascades
# cleanly. Cover both target and actor directions.
PGAPPNAME=mute_before_target_delete psql_cmd >"$LOG_DIR/mute-before-target-delete.out" 2>&1 <<'SQL' &
BEGIN;
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.moderate_group_mute_atomic(
  pg_catalog.gen_random_uuid(),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '10000000-0000-4000-8000-000000000001',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'mute',
  pg_catalog.clock_timestamp() + interval '3 hours',
  'target delete barrier'
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
MUTE_TARGET_PID=$!
wait_for_sleep_gate mute_before_target_delete
psql_cmd -c "DELETE FROM auth.users WHERE id=$MEMBER_ID" >/dev/null
wait "$MUTE_TARGET_PID"
assert_identity_deleted cccccccc-cccc-4ccc-8ccc-cccccccccccc
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
INSERT INTO public.user_profiles(id) VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
INSERT INTO public.group_members(group_id,user_id,role) VALUES
  ('10000000-0000-4000-8000-000000000001','cccccccc-cccc-4ccc-8ccc-cccccccccccc','member'),
  ('20000000-0000-4000-8000-000000000002','cccccccc-cccc-4ccc-8ccc-cccccccccccc','member');
SQL

PGAPPNAME=mute_before_actor_delete psql_cmd >"$LOG_DIR/mute-before-actor-delete.out" 2>&1 <<'SQL' &
BEGIN;
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.moderate_group_mute_atomic(
  pg_catalog.gen_random_uuid(),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '10000000-0000-4000-8000-000000000001',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'mute',
  pg_catalog.clock_timestamp() + interval '3 hours',
  'actor delete barrier'
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
MUTE_ACTOR_PID=$!
wait_for_sleep_gate mute_before_actor_delete
psql_cmd -c "DELETE FROM auth.users WHERE id=$ADMIN_ID" >/dev/null
wait "$MUTE_ACTOR_PID"
assert_identity_deleted bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO public.user_profiles(id) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO public.group_members(group_id,user_id,role) VALUES
  ('10000000-0000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','admin');
SQL

# Concurrent mute/unmute is linearized by the same pair of membership keys.
psql_cmd -c \
  "UPDATE public.group_members SET muted_until=NULL,mute_reason=NULL,muted_by=NULL WHERE group_id=$GROUP_ID AND user_id=$MEMBER_2_ID" >/dev/null
PGAPPNAME=mute_then_unmute psql_cmd >"$LOG_DIR/mute-then-unmute.out" 2>&1 <<'SQL' &
BEGIN;
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.moderate_group_mute_atomic(
  pg_catalog.gen_random_uuid(),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '10000000-0000-4000-8000-000000000001',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'mute',
  pg_catalog.clock_timestamp() + interval '3 hours',
  'concurrent'
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
MUTE_CONCURRENT_PID=$!
wait_for_sleep_gate mute_then_unmute
UNMUTE_AFTER="$(rpc \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  10000000-0000-4000-8000-000000000001 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  unmute NULL NULL)"
wait "$MUTE_CONCURRENT_PID"
if [[ "$(psql_cmd -Atqc "SELECT ('$UNMUTE_AFTER'::jsonb)->>'applied'")" != "true" ]] || [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_members WHERE group_id=$GROUP_ID AND user_id=$MEMBER_2_ID AND muted_until IS NULL AND mute_reason IS NULL AND muted_by IS NULL")" != "1" ]]; then
  echo "Concurrent mute/unmute did not converge to the serialized final state" >&2
  exit 1
fi

# Reverse order: unmute owns the edge first, then a waiting mute becomes the
# complete final transition.
rpc \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  10000000-0000-4000-8000-000000000001 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  mute "now() + interval '3 hours'" "'reverse setup'" >/dev/null
PGAPPNAME=unmute_then_mute psql_cmd >"$LOG_DIR/unmute-then-mute.out" 2>&1 <<'SQL' &
BEGIN;
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.moderate_group_mute_atomic(
  pg_catalog.gen_random_uuid(),
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  '10000000-0000-4000-8000-000000000001',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'unmute',
  NULL,
  NULL
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
UNMUTE_CONCURRENT_PID=$!
wait_for_sleep_gate unmute_then_mute
MUTE_AFTER_UNMUTE="$(rpc \
  bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb \
  10000000-0000-4000-8000-000000000001 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  mute "now() + interval '4 hours'" "'reverse final'")"
wait "$UNMUTE_CONCURRENT_PID"
if [[ "$(psql_cmd -Atqc "SELECT ('$MUTE_AFTER_UNMUTE'::jsonb)->>'applied'")" != "true" ]] || [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_members WHERE group_id=$GROUP_ID AND user_id=$MEMBER_2_ID AND muted_until IS NOT NULL AND mute_reason='reverse final' AND muted_by=$ADMIN_ID")" != "1" ]]; then
  echo "Concurrent unmute/mute did not converge to the serialized final state" >&2
  exit 1
fi

# Dissolution first makes the group immutable; mute first commits before the
# direct group update and leaves a complete state/audit pair.
PGAPPNAME=mute_dissolve_first psql_cmd >"$LOG_DIR/dissolve-first.out" 2>&1 <<'SQL' &
BEGIN;
UPDATE public.groups
SET dissolved_at = pg_catalog.clock_timestamp()
WHERE id = '20000000-0000-4000-8000-000000000002';
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
DISSOLVE_PID=$!
wait_for_sleep_gate mute_dissolve_first
assert_reason GROUP_DISSOLVED \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  20000000-0000-4000-8000-000000000002 \
  cccccccc-cccc-4ccc-8ccc-cccccccccccc \
  mute "now() + interval '3 hours'" NULL
wait "$DISSOLVE_PID"
psql_cmd -c \
  "UPDATE public.groups SET dissolved_at=NULL WHERE id=$DISSOLVE_GROUP_ID" >/dev/null

PGAPPNAME=mute_before_dissolve psql_cmd >"$LOG_DIR/mute-before-dissolve.out" 2>&1 <<'SQL' &
BEGIN;
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.moderate_group_mute_atomic(
  pg_catalog.gen_random_uuid(),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '20000000-0000-4000-8000-000000000002',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  'mute',
  pg_catalog.clock_timestamp() + interval '3 hours',
  'before dissolve'
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
MUTE_DISSOLVE_PID=$!
wait_for_sleep_gate mute_before_dissolve
psql_cmd -c \
  "UPDATE public.groups SET dissolved_at=pg_catalog.clock_timestamp() WHERE id=$DISSOLVE_GROUP_ID" >/dev/null
wait "$MUTE_DISSOLVE_PID"
psql_cmd <<'SQL'
DO $mute_before_dissolve_exact$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.groups
    WHERE id = '20000000-0000-4000-8000-000000000002'
      AND dissolved_at IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.group_members
    WHERE group_id = '20000000-0000-4000-8000-000000000002'
      AND user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      AND muted_until IS NOT NULL
      AND mute_reason = 'before dissolve'
      AND muted_by = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.group_audit_log
    WHERE group_id = '20000000-0000-4000-8000-000000000002'
      AND target_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      AND action = 'mute'
      AND details #>> '{result,mute_reason}' = 'before dissolve'
  ) THEN
    RAISE EXCEPTION 'mute-first/dissolve-second was not a complete serialization';
  END IF;
END
$mute_before_dissolve_exact$;
SQL


# Mutable parent/audit retention can never delete or free a mute operation ID.
# Replay remains available before authorization/state locks even after each
# parent has disappeared, while collision protection remains exact.
psql_cmd <<'SQL'
INSERT INTO public.groups(id, name, created_by) VALUES
  ('80000000-0000-4000-8000-000000000008', 'Durable group', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('81000000-0000-4000-8000-000000000081', 'Durable actor', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  ('82000000-0000-4000-8000-000000000082', 'Durable target', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
INSERT INTO public.group_members(group_id, user_id, role) VALUES
  ('80000000-0000-4000-8000-000000000008', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('80000000-0000-4000-8000-000000000008', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'member'),
  ('81000000-0000-4000-8000-000000000081', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'admin'),
  ('81000000-0000-4000-8000-000000000081', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'member'),
  ('82000000-0000-4000-8000-000000000082', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'owner'),
  ('82000000-0000-4000-8000-000000000082', 'ffffffff-ffff-4fff-8fff-ffffffffffff', 'member');
SQL
DURABLE_GROUP_UNTIL="$(psql_cmd -Atqc "SELECT pg_catalog.clock_timestamp()+interval '8 hours'")"
DURABLE_ACTOR_UNTIL="$(psql_cmd -Atqc "SELECT pg_catalog.clock_timestamp()+interval '9 hours'")"
DURABLE_TARGET_UNTIL="$(psql_cmd -Atqc "SELECT pg_catalog.clock_timestamp()+interval '10 hours'")"
rpc_with_operation \
  93000000-0000-4000-8000-000000000001 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  80000000-0000-4000-8000-000000000008 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  mute "'$DURABLE_GROUP_UNTIL'::timestamptz" "'durable group'" >/dev/null
rpc_with_operation \
  93000000-0000-4000-8000-000000000002 \
  eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee \
  81000000-0000-4000-8000-000000000081 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  mute "'$DURABLE_ACTOR_UNTIL'::timestamptz" "'durable actor'" >/dev/null
rpc_with_operation \
  93000000-0000-4000-8000-000000000003 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  82000000-0000-4000-8000-000000000082 \
  ffffffff-ffff-4fff-8fff-ffffffffffff \
  mute "'$DURABLE_TARGET_UNTIL'::timestamptz" "'durable target'" >/dev/null

psql_cmd <<'SQL'
DELETE FROM public.group_audit_log
WHERE id = (
  SELECT audit_log_id FROM public.group_mute_operations
  WHERE operation_id = '93000000-0000-4000-8000-000000000001'
);
DELETE FROM public.groups
WHERE id = '80000000-0000-4000-8000-000000000008';
DELETE FROM auth.users
WHERE id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
DELETE FROM auth.users
WHERE id = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
SQL
DURABLE_GROUP_REPLAY="$(rpc_with_operation \
  93000000-0000-4000-8000-000000000001 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  80000000-0000-4000-8000-000000000008 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  mute "'$DURABLE_GROUP_UNTIL'::timestamptz" "'durable group'")"
DURABLE_ACTOR_REPLAY="$(rpc_with_operation \
  93000000-0000-4000-8000-000000000002 \
  eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee \
  81000000-0000-4000-8000-000000000081 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  mute "'$DURABLE_ACTOR_UNTIL'::timestamptz" "'durable actor'")"
DURABLE_TARGET_REPLAY="$(rpc_with_operation \
  93000000-0000-4000-8000-000000000003 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  82000000-0000-4000-8000-000000000082 \
  ffffffff-ffff-4fff-8fff-ffffffffffff \
  mute "'$DURABLE_TARGET_UNTIL'::timestamptz" "'durable target'")"
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_mute_operations WHERE operation_id IN ('93000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000002','93000000-0000-4000-8000-000000000003')")" != "3" ]] || \
   [[ "$(psql_cmd -Atqc "SELECT ('$DURABLE_GROUP_REPLAY'::jsonb)->>'applied'")" != "false" ]] || \
   [[ "$(psql_cmd -Atqc "SELECT ('$DURABLE_ACTOR_REPLAY'::jsonb)->>'applied'")" != "false" ]] || \
   [[ "$(psql_cmd -Atqc "SELECT ('$DURABLE_TARGET_REPLAY'::jsonb)->>'applied'")" != "false" ]]; then
  echo "Parent/audit deletion erased durable mute operation identity" >&2
  exit 1
fi
if rpc_with_operation \
  93000000-0000-4000-8000-000000000001 \
  aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa \
  80000000-0000-4000-8000-000000000008 \
  dddddddd-dddd-4ddd-8ddd-dddddddddddd \
  mute "'$DURABLE_GROUP_UNTIL'::timestamptz" "'reused after delete'" \
  >"$LOG_DIR/deleted-parent-operation-reuse.log" 2>&1; then
  echo "Deleted parents made a committed operation UUID reusable" >&2
  exit 1
fi
grep -Fq 'operation id payload collision' \
  "$LOG_DIR/deleted-parent-operation-reuse.log"

# Migration/runtime lock proofs. Dedicated rows keep these deployment races
# independent from the behavioral fixtures above.
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');
INSERT INTO public.user_profiles(id)
SELECT id
FROM auth.users
WHERE id IN (
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444'
);
INSERT INTO public.groups(id, name, created_by) VALUES
  ('71000000-0000-4000-8000-000000000001', 'Runtime first', '11111111-1111-4111-8111-111111111111'),
  ('71000000-0000-4000-8000-000000000002', 'DDL first', '11111111-1111-4111-8111-111111111111'),
  ('71000000-0000-4000-8000-000000000003', 'Legacy runtime', '11111111-1111-4111-8111-111111111111');
INSERT INTO public.group_members(group_id, user_id, role) VALUES
  ('71000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('71000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'member'),
  ('71000000-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('71000000-0000-4000-8000-000000000002', '33333333-3333-4333-8333-333333333333', 'member'),
  ('71000000-0000-4000-8000-000000000003', '11111111-1111-4111-8111-111111111111', 'owner'),
  ('71000000-0000-4000-8000-000000000003', '44444444-4444-4444-8444-444444444444', 'member');
SQL

# Runtime first: the atomic mute owns the ledger barrier and group row while
# an audit blocker pauses it. DDL retries at the ledger without holding any
# other dependency; after release both sessions commit exactly once.
PGAPPNAME=runtime-first-audit-blocker psql_cmd <<'SQL' \
  >"$LOG_DIR/runtime-first-audit-blocker.log" 2>&1 &
BEGIN;
LOCK TABLE public.group_audit_log IN ACCESS EXCLUSIVE MODE;
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
RUNTIME_FIRST_BLOCKER_PID=$!
wait_for_sleep_gate runtime-first-audit-blocker
PGAPPNAME=runtime-first-rpc psql_cmd -Atqc \
  "SET request.jwt.claim.role='service_role'; SET ROLE service_role; SELECT public.moderate_group_mute_atomic('94000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111','71000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222','mute',pg_catalog.clock_timestamp()+interval '6 hours','runtime first'); RESET ROLE;" \
  >"$LOG_DIR/runtime-first-rpc.log" 2>&1 &
RUNTIME_FIRST_RPC_PID=$!
wait_for_relation_lock runtime-first-rpc public.group_audit_log
PGAPPNAME=runtime-first-ddl psql_cmd -f "$MIGRATION" \
  >"$LOG_DIR/runtime-first-ddl.log" 2>&1 &
RUNTIME_FIRST_DDL_PID=$!
wait_for_sleep_gate runtime-first-ddl
wait_for_success "$RUNTIME_FIRST_BLOCKER_PID" \
  'runtime-first audit blocker' "$LOG_DIR/runtime-first-audit-blocker.log"
wait_for_success "$RUNTIME_FIRST_RPC_PID" \
  'runtime-first RPC' "$LOG_DIR/runtime-first-rpc.log"
wait_for_success "$RUNTIME_FIRST_DDL_PID" \
  'runtime-first DDL' "$LOG_DIR/runtime-first-ddl.log"

if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_mute_operations AS operation_row JOIN public.group_members AS member ON member.group_id=operation_row.group_id AND member.user_id=operation_row.target_id JOIN public.group_audit_log AS audit ON audit.id=operation_row.audit_log_id WHERE operation_row.operation_id='94000000-0000-4000-8000-000000000001' AND operation_row.initial_applied AND member.mute_reason='runtime first' AND audit.action='mute'")" != "1" ]]; then
  echo 'Runtime-first DDL/RPC state was not exact' >&2
  exit 1
fi

# DDL first: hold the same ledger ACCESS EXCLUSIVE barrier in the migration
# connection before replay. The RPC must wait on its first table lock and then
# commit after the migration finishes.
PGAPPNAME=ddl-first-migration psql_cmd \
  -c "BEGIN; LOCK TABLE public.group_mute_operations IN ACCESS EXCLUSIVE MODE; SELECT pg_catalog.pg_sleep(2);" \
  -f "$MIGRATION" >"$LOG_DIR/ddl-first-migration.log" 2>&1 &
DDL_FIRST_MIGRATION_PID=$!
wait_for_sleep_gate ddl-first-migration
PGAPPNAME=ddl-first-rpc psql_cmd -Atqc \
  "SET request.jwt.claim.role='service_role'; SET ROLE service_role; SELECT public.moderate_group_mute_atomic('94000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111','71000000-0000-4000-8000-000000000002','33333333-3333-4333-8333-333333333333','mute',pg_catalog.clock_timestamp()+interval '7 hours','ddl first'); RESET ROLE;" \
  >"$LOG_DIR/ddl-first-rpc.log" 2>&1 &
DDL_FIRST_RPC_PID=$!
wait_for_relation_lock ddl-first-rpc public.group_mute_operations
wait_for_success "$DDL_FIRST_MIGRATION_PID" \
  'DDL-first migration' "$LOG_DIR/ddl-first-migration.log"
wait_for_success "$DDL_FIRST_RPC_PID" \
  'DDL-first RPC' "$LOG_DIR/ddl-first-rpc.log"

if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM public.group_mute_operations AS operation_row JOIN public.group_members AS member ON member.group_id=operation_row.group_id AND member.user_id=operation_row.target_id JOIN public.group_audit_log AS audit ON audit.id=operation_row.audit_log_id WHERE operation_row.operation_id='94000000-0000-4000-8000-000000000002' AND operation_row.initial_applied AND member.mute_reason='ddl first' AND audit.action='mute'")" != "1" ]]; then
  echo 'DDL-first DDL/RPC state was not exact' >&2
  exit 1
fi

# Existing group -> audit runtime: this fixture deliberately has no ledger
# barrier. The migration may acquire ledger/Auth locks, but its NOWAIT miss on
# groups rolls the whole attempt back so the paused kick can reach audit.
PGAPPNAME=legacy-audit-blocker psql_cmd <<'SQL' \
  >"$LOG_DIR/legacy-audit-blocker.log" 2>&1 &
BEGIN;
LOCK TABLE public.group_audit_log IN ACCESS EXCLUSIVE MODE;
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
LEGACY_BLOCKER_PID=$!
wait_for_sleep_gate legacy-audit-blocker
PGAPPNAME=legacy-group-audit-runtime psql_cmd -Atqc \
  "SELECT public.moderate_group_member_atomic('11111111-1111-4111-8111-111111111111','71000000-0000-4000-8000-000000000003','44444444-4444-4444-8444-444444444444','kick','race proof');" \
  >"$LOG_DIR/legacy-group-audit-runtime.log" 2>&1 &
LEGACY_RUNTIME_PID=$!
wait_for_relation_lock legacy-group-audit-runtime public.group_audit_log
PGAPPNAME=legacy-group-audit-ddl psql_cmd -f "$MIGRATION" \
  >"$LOG_DIR/legacy-group-audit-ddl.log" 2>&1 &
LEGACY_DDL_PID=$!
wait_for_sleep_gate legacy-group-audit-ddl
wait_for_success "$LEGACY_BLOCKER_PID" \
  'legacy audit blocker' "$LOG_DIR/legacy-audit-blocker.log"
wait_for_success "$LEGACY_RUNTIME_PID" \
  'legacy group-to-audit runtime' "$LOG_DIR/legacy-group-audit-runtime.log"
wait_for_success "$LEGACY_DDL_PID" \
  'legacy group-to-audit DDL' "$LOG_DIR/legacy-group-audit-ddl.log"

if [[ "$(psql_cmd -Atqc "SELECT (SELECT count(*) FROM public.group_members WHERE group_id='71000000-0000-4000-8000-000000000003' AND user_id='44444444-4444-4444-8444-444444444444')::text || ':' || (SELECT count(*) FROM public.group_audit_log WHERE group_id='71000000-0000-4000-8000-000000000003' AND target_id='44444444-4444-4444-8444-444444444444' AND action='member_kicked')::text")" != "0:1" ]]; then
  echo 'Legacy group-to-audit race did not serialize exactly' >&2
  exit 1
fi

# Raw child-first writer: hold group_members, then request groups after the
# migration has attempted groups -> group_members. The request succeeds only
# if the failed NOWAIT subtransaction released its partial groups lock.
PGAPPNAME=raw-child-first psql_cmd <<'SQL' \
  >"$LOG_DIR/raw-child-first.log" 2>&1 &
BEGIN;
SET LOCAL lock_timeout = '1s';
LOCK TABLE public.group_members IN ROW EXCLUSIVE MODE;
SELECT pg_catalog.pg_sleep(2);
LOCK TABLE public.groups IN ROW EXCLUSIVE MODE;
COMMIT;
SQL
RAW_CHILD_PID=$!
wait_for_sleep_gate raw-child-first
PGAPPNAME=raw-child-first-ddl psql_cmd -f "$MIGRATION" \
  >"$LOG_DIR/raw-child-first-ddl.log" 2>&1 &
RAW_CHILD_DDL_PID=$!
wait_for_sleep_gate raw-child-first-ddl
wait_for_success "$RAW_CHILD_PID" \
  'raw child-first writer' "$LOG_DIR/raw-child-first.log"
wait_for_success "$RAW_CHILD_DDL_PID" \
  'raw child-first DDL' "$LOG_DIR/raw-child-first-ddl.log"

# Explicit last-lock failure proof: an audit-first session requests ledger
# while DDL is retrying. It can acquire ledger only if the exception
# subtransaction released the ledger/Auth/groups locks from every failed try.
PGAPPNAME=partial-lock-release psql_cmd <<'SQL' \
  >"$LOG_DIR/partial-lock-release.log" 2>&1 &
BEGIN;
SET LOCAL lock_timeout = '1s';
LOCK TABLE public.group_audit_log IN ACCESS EXCLUSIVE MODE;
SELECT pg_catalog.pg_sleep(2);
LOCK TABLE public.group_mute_operations IN ROW EXCLUSIVE MODE;
COMMIT;
SQL
PARTIAL_RELEASE_PID=$!
wait_for_sleep_gate partial-lock-release
PGAPPNAME=partial-lock-release-ddl psql_cmd -f "$MIGRATION" \
  >"$LOG_DIR/partial-lock-release-ddl.log" 2>&1 &
PARTIAL_RELEASE_DDL_PID=$!
wait_for_sleep_gate partial-lock-release-ddl
wait_for_success "$PARTIAL_RELEASE_PID" \
  'partial-lock-release writer' "$LOG_DIR/partial-lock-release.log"
wait_for_success "$PARTIAL_RELEASE_DDL_PID" \
  'partial-lock-release DDL' "$LOG_DIR/partial-lock-release-ddl.log"

for concurrency_log in \
  "$LOG_DIR/runtime-first-audit-blocker.log" \
  "$LOG_DIR/runtime-first-rpc.log" \
  "$LOG_DIR/runtime-first-ddl.log" \
  "$LOG_DIR/ddl-first-migration.log" \
  "$LOG_DIR/ddl-first-rpc.log" \
  "$LOG_DIR/legacy-audit-blocker.log" \
  "$LOG_DIR/legacy-group-audit-runtime.log" \
  "$LOG_DIR/legacy-group-audit-ddl.log" \
  "$LOG_DIR/raw-child-first.log" \
  "$LOG_DIR/raw-child-first-ddl.log" \
  "$LOG_DIR/partial-lock-release.log" \
  "$LOG_DIR/partial-lock-release-ddl.log"; do
  assert_no_lock_failure "$concurrency_log"
done

# Effective role inheritance is cluster authority, not repairable application
# data. PostgreSQL 17 decides automatic inheritance on each membership edge,
# independently of the member role's INHERIT/NOINHERIT default for new grants.
psql_cmd -c "ALTER ROLE service_role NOINHERIT" >/dev/null
psql_cmd -c \
  "GRANT drifted_moderator TO service_role WITH INHERIT TRUE, SET FALSE" \
  >/dev/null
if psql_cmd -f "$MIGRATION" >"$LOG_DIR/service-inherits-drift.log" 2>&1; then
  echo "Migration accepted an explicit service_role inheritance edge" >&2
  exit 1
fi
grep -Fq 'unsafe effective inheritance edge' \
  "$LOG_DIR/service-inherits-drift.log"
psql_cmd -c "REVOKE drifted_moderator FROM service_role" >/dev/null
psql_cmd -c "ALTER ROLE service_role INHERIT" >/dev/null

psql_cmd -c "ALTER ROLE drifted_moderator NOINHERIT" >/dev/null
psql_cmd -c \
  "GRANT service_role TO drifted_moderator WITH INHERIT TRUE, SET FALSE" \
  >/dev/null
if psql_cmd -f "$MIGRATION" >"$LOG_DIR/drift-inherits-service.log" 2>&1; then
  echo "Migration accepted a NOINHERIT role with an explicit inheritance edge" >&2
  exit 1
fi
grep -Fq 'unsafe effective inheritance edge' \
  "$LOG_DIR/drift-inherits-service.log"
psql_cmd -c "REVOKE service_role FROM drifted_moderator" >/dev/null

# postgres is the one permitted direct inheritor. A second edge below it must
# still be traversed and rejected even when that descendant is NOINHERIT.
psql_cmd -c \
  "GRANT service_role TO postgres WITH INHERIT TRUE, SET FALSE" \
  >/dev/null
psql_cmd -c \
  "GRANT postgres TO drifted_moderator WITH INHERIT TRUE, SET FALSE" \
  >/dev/null
if psql_cmd -f "$MIGRATION" >"$LOG_DIR/indirect-service-inheritance.log" 2>&1; then
  echo "Migration accepted indirect service_role inheritance through postgres" >&2
  exit 1
fi
grep -Fq 'unsafe effective inheritance edge' \
  "$LOG_DIR/indirect-service-inheritance.log"
psql_cmd -c "REVOKE postgres FROM drifted_moderator" >/dev/null
psql_cmd -c "REVOKE service_role FROM postgres" >/dev/null

# Role-level INHERIT is only the default for a new grant on PostgreSQL 17. An
# explicit INHERIT FALSE membership must not fail closed. The standing
# authenticator SET TRUE / INHERIT FALSE edge exercises the same safe shape.
psql_cmd -c "ALTER ROLE drifted_moderator INHERIT" >/dev/null
psql_cmd -c \
  "GRANT service_role TO drifted_moderator WITH INHERIT FALSE, SET FALSE" \
  >/dev/null
if ! psql_cmd -f "$MIGRATION" >"$LOG_DIR/noninheriting-membership.log" 2>&1; then
  echo "Migration rejected an explicit non-inheriting membership" >&2
  cat "$LOG_DIR/noninheriting-membership.log" >&2
  exit 1
fi
psql_cmd -c "REVOKE service_role FROM drifted_moderator" >/dev/null

# Replay converges arbitrary table/column/policy/function ACL drift and
# recomputes the source digest without changing durable operation data.
psql_cmd <<'SQL'
GRANT EXECUTE ON FUNCTION public.moderate_group_mute_atomic(
  uuid, uuid, uuid, uuid, text, timestamptz, text
) TO authenticated, drifted_moderator;
COMMENT ON FUNCTION public.moderate_group_mute_atomic(
  uuid, uuid, uuid, uuid, text, timestamptz, text
) IS 'corrupt digest';
GRANT DELETE ON TABLE public.groups TO service_role, drifted_moderator;
GRANT UPDATE (name) ON TABLE public.groups TO drifted_moderator;
GRANT UPDATE (mute_reason) ON TABLE public.group_members TO drifted_moderator;
GRANT SELECT ON TABLE public.group_mute_operations TO drifted_moderator;
CREATE POLICY forged_group_delete ON public.groups
  FOR DELETE TO drifted_moderator USING (true);
CREATE POLICY forged_member_update ON public.group_members
  FOR UPDATE TO drifted_moderator USING (true) WITH CHECK (true);
CREATE POLICY forged_ledger_read ON public.group_mute_operations
  FOR SELECT TO drifted_moderator USING (true);
SQL
psql_cmd -f "$MIGRATION" >"$LOG_DIR/replay.log"
psql_cmd <<'SQL'
DO $replay_contract$
DECLARE
  target_function regprocedure :=
    'public.moderate_group_mute_atomic(uuid,uuid,uuid,uuid,text,timestamptz,text)'::regprocedure;
BEGIN
  IF has_function_privilege('authenticated', target_function, 'EXECUTE')
     OR has_function_privilege('drifted_moderator', target_function, 'EXECUTE')
     OR NOT has_function_privilege('service_role', target_function, 'EXECUTE')
     OR has_table_privilege('service_role', 'public.groups', 'DELETE')
     OR has_table_privilege('drifted_moderator', 'public.groups', 'DELETE')
     OR has_column_privilege('drifted_moderator', 'public.groups', 'name', 'UPDATE')
     OR has_column_privilege(
       'drifted_moderator',
       'public.group_members',
       'mute_reason',
       'UPDATE'
     )
     OR has_table_privilege(
       'drifted_moderator',
       'public.group_mute_operations',
       'SELECT'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy
       WHERE policy.polrelid IN (
         'public.groups'::regclass,
         'public.group_members'::regclass,
         'public.group_mute_operations'::regclass
       )
         AND policy.polname LIKE 'forged_%'
     )
     OR (
       SELECT pg_catalog.obj_description(function_row.oid, 'pg_proc')
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = target_function
     ) IS DISTINCT FROM (
       SELECT 'atomic-group-mute:v2:' || pg_catalog.md5(function_row.prosrc)
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = target_function
     )
  THEN
    RAISE EXCEPTION 'group-mute replay did not restore ACL/digest authority';
  END IF;
END
$replay_contract$;
SQL

echo "Atomic group mute PostgreSQL 17 proof passed"
