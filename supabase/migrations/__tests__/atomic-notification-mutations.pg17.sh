#!/usr/bin/env bash

# PostgreSQL 17 proof for actor-bound notification read/delete mutations.
# This owns an isolated temporary cluster and never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729173500_atomic_notification_mutations.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-notification-mutations-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((64500 + ($$ % 900)))
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
  while ((attempts < 300)); do
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
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses= -c timezone=UTC" \
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
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role;

CREATE FUNCTION public.install_active_authenticated_subject_mutation_barriers()
RETURNS integer LANGUAGE sql AS $function$ SELECT 1 $function$;
CREATE FUNCTION public.assert_active_authenticated_subject_mutation_barriers()
RETURNS integer LANGUAGE sql AS $function$ SELECT 1 $function$;

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
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read boolean DEFAULT false,
  read_at timestamptz,
  created_at timestamptz DEFAULT pg_catalog.statement_timestamp()
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.notifications OWNER TO postgres;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_viewer_select
  ON public.notifications FOR SELECT TO authenticated USING (true);
CREATE POLICY notification_viewer_update
  ON public.notifications FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY notification_viewer_delete
  ON public.notifications FOR DELETE TO authenticated USING (true);
CREATE POLICY notification_service_all
  ON public.notifications FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT SELECT, UPDATE, DELETE ON public.notifications TO authenticated;
GRANT SELECT ON public.notifications TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notifications TO service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

# Replay removes hostile function/table grants, grant options, and browser
# mutation policies rather than preserving authority drift.
psql_cmd <<'SQL'
GRANT EXECUTE
  ON FUNCTION public.mutate_notifications_atomic(uuid, text, uuid[])
  TO authenticated, rogue_role;
GRANT EXECUTE
  ON FUNCTION public.mutate_notifications_atomic(uuid, text, uuid[])
  TO service_role WITH GRANT OPTION;
GRANT UPDATE ON public.notifications TO authenticated;
CREATE POLICY hostile_notification_update
  ON public.notifications FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
SQL
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','MARK_ALL_READ',NULL)"
expect_failure "SET ROLE rogue_role; SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','MARK_ALL_READ',NULL)"
expect_failure "SET ROLE authenticated; UPDATE public.notifications SET read=true"
assert_scalar 'true|false|false|false|false|true' "SELECT pg_catalog.has_function_privilege('service_role','public.mutate_notifications_atomic(uuid,text,uuid[])','EXECUTE')::text || '|' || pg_catalog.has_function_privilege('authenticated','public.mutate_notifications_atomic(uuid,text,uuid[])','EXECUTE')::text || '|' || pg_catalog.has_table_privilege('authenticated','public.notifications','UPDATE')::text || '|' || pg_catalog.has_table_privilege('authenticated','public.notifications','DELETE')::text || '|' || EXISTS(SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid='public.notifications'::regclass AND polcmd IN ('*','a','w','d') AND pg_catalog.to_regrole('authenticated')::oid=ANY(polroles))::text || '|' || COALESCE((SELECT NOT acl_entry.is_grantable FROM pg_catalog.pg_proc AS function_row CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry WHERE function_row.oid='public.mutate_notifications_atomic(uuid,text,uuid[])'::regprocedure AND acl_entry.grantee=pg_catalog.to_regrole('service_role')::oid),'false')"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');
INSERT INTO public.user_profiles(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');
INSERT INTO public.notifications(id, user_id, read, created_at) VALUES
  ('a0000000-0000-4000-8000-000000000001','11111111-1111-4111-8111-111111111111',false,'2026-07-29T12:00:00Z'),
  ('a0000000-0000-4000-8000-000000000002','11111111-1111-4111-8111-111111111111',false,'2026-07-29T12:01:00Z'),
  ('a0000000-0000-4000-8000-000000000003','11111111-1111-4111-8111-111111111111',true,'2026-07-29T12:02:00Z'),
  ('b0000000-0000-4000-8000-000000000001','22222222-2222-4222-8222-222222222222',false,'2026-07-29T13:00:00Z');
SQL

assert_service_scalar 'INVALID' "SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','MARK_READ',ARRAY['a0000000-0000-4000-8000-000000000001'::uuid,'a0000000-0000-4000-8000-000000000001'::uuid])->>'reason'"
assert_service_scalar 'INVALID' "SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','MARK_ALL_READ',ARRAY[]::uuid[])->>'reason'"
assert_service_scalar 'ACTOR_UNAVAILABLE' "SELECT public.mutate_notifications_atomic('33333333-3333-4333-8333-333333333333','MARK_ALL_READ',NULL)->>'reason'"

# A mixed own/foreign batch fails as one unit and does not mark the owned row.
assert_service_scalar 'NOT_FOUND' "SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','MARK_READ',ARRAY['a0000000-0000-4000-8000-000000000001'::uuid,'b0000000-0000-4000-8000-000000000001'::uuid])->>'reason'"
assert_scalar 'false' "SELECT read::text FROM public.notifications WHERE id='a0000000-0000-4000-8000-000000000001'"

# Exact owned batches acknowledge the actor, action, original ID order, and
# changed count. Replays are successful but report no new transition.
assert_service_scalar 'true|11111111-1111-4111-8111-111111111111|MARK_READ|a0000000-0000-4000-8000-000000000002|a0000000-0000-4000-8000-000000000001|2|true' "SELECT (r->>'success') || '|' || (r->>'actor_id') || '|' || (r->>'action') || '|' || (r#>>'{notification_ids,0}') || '|' || (r#>>'{notification_ids,1}') || '|' || (r->>'changed_count') || '|' || (r->>'mutation_at' IS NOT NULL)::text FROM (SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','MARK_READ',ARRAY['a0000000-0000-4000-8000-000000000002'::uuid,'a0000000-0000-4000-8000-000000000001'::uuid]) AS r) AS result"
assert_service_scalar '0' "SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','MARK_READ',ARRAY['a0000000-0000-4000-8000-000000000001'::uuid])->>'changed_count'"

# Delete never treats a missing or foreign ID as success.
assert_service_scalar 'NOT_FOUND' "SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','DELETE',ARRAY['b0000000-0000-4000-8000-000000000001'::uuid])->>'reason'"
assert_service_scalar 'DELETE|1|a0000000-0000-4000-8000-000000000003' "SELECT (r->>'action') || '|' || (r->>'changed_count') || '|' || (r#>>'{notification_ids,0}') FROM (SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','DELETE',ARRAY['a0000000-0000-4000-8000-000000000003'::uuid]) AS r) AS result"
assert_service_scalar 'NOT_FOUND' "SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','DELETE',ARRAY['a0000000-0000-4000-8000-000000000003'::uuid])->>'reason'"

psql_cmd <<'SQL'
INSERT INTO public.notifications(id, user_id, read) VALUES
  ('a0000000-0000-4000-8000-000000000004','11111111-1111-4111-8111-111111111111',false),
  ('a0000000-0000-4000-8000-000000000005','11111111-1111-4111-8111-111111111111',true);
SQL
assert_service_scalar 'MARK_ALL_READ|null|1' "SELECT (r->>'action') || '|' || (r->'notification_ids')::text || '|' || (r->>'changed_count') FROM (SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','MARK_ALL_READ',NULL) AS r) AS result"

# Two RPC mutations for one viewer serialize through the viewer mutation lock.
psql_cmd -Atq >"$TMP_ROOT/mutation-owner.out" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role='service_role';
SELECT public.mutate_notifications_atomic(
  '11111111-1111-4111-8111-111111111111',
  'MARK_READ',
  ARRAY['a0000000-0000-4000-8000-000000000005'::uuid]
);
SELECT pg_catalog.pg_sleep(1) /* notification_mutation_owner_hold */;
COMMIT;
SQL
mutation_pid=$!
wait_for_query 'notification_mutation_owner_hold'
assert_service_scalar 'DELETE|1' "SELECT (r->>'action') || '|' || (r->>'changed_count') FROM (SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','DELETE',ARRAY['a0000000-0000-4000-8000-000000000005'::uuid]) AS r) AS result" || { echo 'concurrent notification mutations were not serialized' >&2; exit 1; }
wait "$mutation_pid"
assert_scalar '0' "SELECT count(*) FROM public.notifications WHERE id='a0000000-0000-4000-8000-000000000005'"

# An uncommitted new notification is outside mark-all's snapshot and remains
# unread after commit; no notification that existed at admission is skipped.
psql_cmd >"$TMP_ROOT/insert-owner.out" 2>&1 <<'SQL' &
BEGIN;
INSERT INTO public.notifications(id, user_id, read) VALUES (
  'a0000000-0000-4000-8000-000000000006',
  '11111111-1111-4111-8111-111111111111',
  false
);
SELECT pg_catalog.pg_sleep(1) /* notification_insert_owner_hold */;
COMMIT;
SQL
insert_pid=$!
wait_for_query 'notification_insert_owner_hold'
assert_service_scalar '0' "SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','MARK_ALL_READ',NULL)->>'changed_count'"
wait "$insert_pid"
assert_scalar 'false' "SELECT read::text FROM public.notifications WHERE id='a0000000-0000-4000-8000-000000000006'" || { echo 'concurrent new notification crossed mark-all cutoff' >&2; exit 1; }

# Lifecycle changes win admission before any notification mutation is allowed.
psql_cmd >"$TMP_ROOT/lifecycle-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:11111111-1111-4111-8111-111111111111',
    0
  )
);
UPDATE public.user_profiles
SET deleted_at='2026-07-29T14:00:00Z'
WHERE id='11111111-1111-4111-8111-111111111111';
SELECT pg_catalog.pg_sleep(1) /* notification_lifecycle_owner_hold */;
COMMIT;
SQL
lifecycle_pid=$!
wait_for_query 'notification_lifecycle_owner_hold'
assert_service_scalar 'ACTOR_UNAVAILABLE' "SELECT public.mutate_notifications_atomic('11111111-1111-4111-8111-111111111111','MARK_ALL_READ',NULL)->>'reason'" || { echo 'notification mutation bypassed lifecycle admission' >&2; exit 1; }
wait "$lifecycle_pid"

echo 'atomic notification mutations PostgreSQL 17 checks passed'
