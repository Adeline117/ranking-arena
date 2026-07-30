#!/usr/bin/env bash

# PostgreSQL 17 proof for the filtered, keyset-paginated notification reader.
# This owns an isolated temporary cluster and never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729172000_atomic_notification_page.sql"
TYPE_MIGRATION="$ROOT_DIR/supabase/migrations/20260717222500_notification_type_contract.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-notification-page-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((65000 + ($$ % 500)))
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
  handle text,
  avatar_url text,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  link text,
  read boolean DEFAULT false,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reference_id text,
  created_at timestamptz DEFAULT pg_catalog.statement_timestamp(),
  CONSTRAINT notifications_type_check CHECK (
    type IN (
      'follow', 'like', 'reaction', 'comment', 'system', 'mention',
      'copy_trade', 'message', 'trader_alert', 'trader_alert_roi',
      'trader_alert_drawdown', 'trader_alert_score', 'trader_alert_pnl',
      'trader_alert_rank', 'post_reply', 'new_follower', 'group_update',
      'ranking_change', 'referral_reward', 'tip_received',
      'subscription_expiring', 'subscription_expired', 'nft_expired',
      'nft_pending', 'nft_minted'
    )
  )
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.notifications OWNER TO postgres;
GRANT SELECT ON public.user_profiles, public.notifications TO service_role;
SQL

psql_cmd -f "$TYPE_MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

# Replay converges hostile grants and a grant option rather than preserving
# authority drift.
psql_cmd <<'SQL'
GRANT EXECUTE
  ON FUNCTION public.get_notification_page_atomic(
    uuid, text[], timestamptz, uuid, integer
  )
  TO authenticated, rogue_role;
GRANT EXECUTE
  ON FUNCTION public.get_notification_page_atomic(
    uuid, text[], timestamptz, uuid, integer
  )
  TO service_role WITH GRANT OPTION;
SQL
psql_cmd -f "$MIGRATION" >/dev/null

expect_failure "SET ROLE authenticated; SET request.jwt.claim.role='authenticated'; SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',NULL,NULL,NULL,20)"
expect_failure "SET ROLE rogue_role; SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',NULL,NULL,NULL,20)"
assert_scalar 'true|false|false' "SELECT pg_catalog.has_function_privilege('service_role','public.get_notification_page_atomic(uuid,text[],timestamp with time zone,uuid,integer)','EXECUTE')::text || '|' || pg_catalog.has_function_privilege('authenticated','public.get_notification_page_atomic(uuid,text[],timestamp with time zone,uuid,integer)','EXECUTE')::text || '|' || COALESCE((SELECT acl_entry.is_grantable::text FROM pg_catalog.pg_proc AS function_row CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry WHERE function_row.oid = 'public.get_notification_page_atomic(uuid,text[],timestamp with time zone,uuid,integer)'::regprocedure AND acl_entry.grantee = pg_catalog.to_regrole('service_role')::oid),'false')"

psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');
INSERT INTO public.user_profiles(id, handle, avatar_url) VALUES
  ('11111111-1111-4111-8111-111111111111','viewer',NULL),
  ('22222222-2222-4222-8222-222222222222','active-actor','https://cdn.example/active.png'),
  ('33333333-3333-4333-8333-333333333333','deleted-actor','https://cdn.example/deleted.png'),
  ('44444444-4444-4444-8444-444444444444','outsider',NULL);
UPDATE public.user_profiles
SET deleted_at = '2026-07-29T11:00:00Z'
WHERE id = '33333333-3333-4333-8333-333333333333';

INSERT INTO public.notifications(
  id, user_id, type, title, message, link, read, actor_id,
  reference_id, created_at
) VALUES
  ('a0000000-0000-4000-8000-000000000601','11111111-1111-4111-8111-111111111111','mention','old mention','m6',NULL,true,'22222222-2222-4222-8222-222222222222',NULL,'2026-07-29T12:00:00Z'),
  ('a0000000-0000-4000-8000-000000000501','11111111-1111-4111-8111-111111111111','comment','old comment','m5','/post/5',false,'22222222-2222-4222-8222-222222222222','5','2026-07-29T12:01:00Z'),
  ('a0000000-0000-4000-8000-000000000303','11111111-1111-4111-8111-111111111111','follow','tie follow','m4','/user/2',false,'22222222-2222-4222-8222-222222222222',NULL,'2026-07-29T12:02:00Z'),
  ('a0000000-0000-4000-8000-000000000304','11111111-1111-4111-8111-111111111111','new_follower','tie new follower','m3','/user/3',false,'33333333-3333-4333-8333-333333333333',NULL,'2026-07-29T12:02:00Z'),
  ('a0000000-0000-4000-8000-000000000201','11111111-1111-4111-8111-111111111111','like','recent like','m2','/post/2',false,'33333333-3333-4333-8333-333333333333','2','2026-07-29T12:03:00Z'),
  ('a0000000-0000-4000-8000-000000000101','11111111-1111-4111-8111-111111111111','system','newest system','m1',NULL,false,NULL,NULL,'2026-07-29T12:04:00Z'),
  ('b0000000-0000-4000-8000-000000000001','44444444-4444-4444-8444-444444444444','system','outsider secret','secret',NULL,false,NULL,NULL,'2026-07-29T13:00:00Z');
SQL

assert_service_scalar 'INVALID' "SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',ARRAY['follow','follow'],NULL,NULL,2)->>'reason'"
assert_service_scalar 'INVALID' "SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',ARRAY['unknown'],NULL,NULL,2)->>'reason'"
assert_service_scalar 'INVALID' "SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',NULL,'2026-07-29T12:02:00Z',NULL,2)->>'reason'"
assert_service_scalar 'ACTOR_UNAVAILABLE' "SELECT public.get_notification_page_atomic('44444444-4444-4444-8444-444444444445',NULL,NULL,NULL,2)->>'reason'"

# The filter is applied before LIMIT. The page finds older follow events even
# though newer rows have other types, normalizes the type set, and keeps the
# unread count global.
assert_service_scalar '2|false|a0000000-0000-4000-8000-000000000304|a0000000-0000-4000-8000-000000000303|follow,new_follower|5|false' "SELECT jsonb_array_length(r->'notifications') || '|' || (r->>'has_more') || '|' || (r#>>'{notifications,0,id}') || '|' || (r#>>'{notifications,1,id}') || '|' || (SELECT pg_catalog.string_agg(value,',' ORDER BY value) FROM pg_catalog.jsonb_array_elements_text(r->'types')) || '|' || (r->>'unread_count') || '|' || (r::text LIKE '%recent like%')::text FROM (SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',ARRAY['new_follower','follow'],NULL,NULL,2) AS r) AS result" || { echo 'notification type filter leaked another type' >&2; exit 1; }
assert_service_scalar '0|5|true' "SELECT jsonb_array_length(r->'notifications') || '|' || (r->>'unread_count') || '|' || ((r->'types') = '[]'::jsonb)::text FROM (SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',ARRAY[]::text[],NULL,NULL,2) AS r) AS result"
assert_service_scalar 'true|true' "SELECT ((r#>'{notifications,1,actor_handle}') = 'null'::jsonb)::text || '|' || ((r#>'{notifications,1,actor_avatar_url}') = 'null'::jsonb)::text FROM (SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',NULL,NULL,NULL,2) AS r) AS result"
assert_service_scalar 'false' "SELECT (public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',NULL,NULL,NULL,50)::text LIKE '%outsider secret%')::text"

# A total cursor preserves the original traversal after a newer row arrives.
assert_service_scalar '2|true|a0000000-0000-4000-8000-000000000101|a0000000-0000-4000-8000-000000000201' "SELECT jsonb_array_length(r->'notifications') || '|' || (r->>'has_more') || '|' || (r#>>'{notifications,0,id}') || '|' || (r#>>'{next_cursor,before_id}') FROM (SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',NULL,NULL,NULL,2) AS r) AS result"
psql_cmd <<'SQL'
INSERT INTO public.notifications(
  id, user_id, type, title, message, read, created_at
) VALUES (
  'a0000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  'system', 'inserted newer', 'new', false, '2026-07-29T12:05:00Z'
);
SQL
assert_service_scalar 'a0000000-0000-4000-8000-000000000304|a0000000-0000-4000-8000-000000000303|0' "SELECT (r#>>'{notifications,0,id}') || '|' || (r#>>'{notifications,1,id}') || '|' || (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements(r->'notifications') AS item WHERE item->>'id' IN ('a0000000-0000-4000-8000-000000000101','a0000000-0000-4000-8000-000000000201')) FROM (SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',NULL,'2026-07-29T12:03:00Z','a0000000-0000-4000-8000-000000000201',2) AS r) AS result" || { echo 'new notification shifted an issued cursor page' >&2; exit 1; }

# Invalid legacy null state fails closed instead of silently omitting a row.
psql_cmd <<'SQL'
INSERT INTO public.notifications(
  id, user_id, type, title, message, read, created_at
) VALUES (
  'a0000000-0000-4000-8000-000000000701',
  '11111111-1111-4111-8111-111111111111',
  'system', 'invalid legacy row', 'invalid', NULL, '2026-07-29T11:00:00Z'
);
SQL
assert_service_scalar 'DATA_INTEGRITY' "SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',NULL,NULL,NULL,20)->>'reason'"
psql_cmd -c "DELETE FROM public.notifications WHERE id = 'a0000000-0000-4000-8000-000000000701'" >/dev/null

# An uncommitted insert never crosses the page snapshot, then appears after
# commit. The global unread count is from that same content snapshot.
psql_cmd >"$TMP_ROOT/notification-insert-owner.out" 2>&1 <<'SQL' &
BEGIN;
INSERT INTO public.notifications(
  id, user_id, type, title, message, read, created_at
) VALUES (
  'a0000000-0000-4000-8000-000000000801',
  '11111111-1111-4111-8111-111111111111',
  'system', 'uncommitted notification', 'pending', false,
  '2026-07-29T12:06:00Z'
);
SELECT pg_catalog.pg_sleep(1) /* notification_insert_hold */;
COMMIT;
SQL
insert_pid=$!
wait_for_query 'notification_insert_hold'
assert_service_scalar 'false|6' "SELECT (r::text LIKE '%uncommitted notification%')::text || '|' || (r->>'unread_count') FROM (SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',NULL,NULL,NULL,20) AS r) AS result" || { echo 'uncommitted notification crossed the page snapshot' >&2; exit 1; }
wait "$insert_pid"
assert_service_scalar 'true|7' "SELECT (r::text LIKE '%uncommitted notification%')::text || '|' || (r->>'unread_count') FROM (SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',NULL,NULL,NULL,20) AS r) AS result"

# An uncommitted mark-read is observed wholly before or wholly after.
psql_cmd >"$TMP_ROOT/notification-read-owner.out" 2>&1 <<'SQL' &
BEGIN;
UPDATE public.notifications
SET read = true
WHERE id = 'a0000000-0000-4000-8000-000000000101';
SELECT pg_catalog.pg_sleep(1) /* notification_read_hold */;
COMMIT;
SQL
read_pid=$!
wait_for_query 'notification_read_hold'
assert_service_scalar '7|false' "SELECT (r->>'unread_count') || '|' || (r#>>'{notifications,2,read}') FROM (SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',NULL,NULL,NULL,20) AS r) AS result" || { echo 'uncommitted read crossed the unread snapshot' >&2; exit 1; }
wait "$read_pid"
assert_service_scalar '6' "SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',NULL,NULL,NULL,20)->>'unread_count'"

# Actor lifecycle decisions serialize before notification admission.
psql_cmd >"$TMP_ROOT/notification-lifecycle-owner.out" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'account-recovery-admission:11111111-1111-4111-8111-111111111111',
    0
  )
);
UPDATE public.user_profiles
SET deleted_at = '2026-07-29T14:00:00Z'
WHERE id = '11111111-1111-4111-8111-111111111111';
SELECT pg_catalog.pg_sleep(1) /* notification_lifecycle_hold */;
COMMIT;
SQL
lifecycle_pid=$!
wait_for_query 'notification_lifecycle_hold'
assert_service_scalar 'ACTOR_UNAVAILABLE' "SELECT public.get_notification_page_atomic('11111111-1111-4111-8111-111111111111',NULL,NULL,NULL,20)->>'reason'" || { echo 'notification actor lifecycle admission failed' >&2; exit 1; }
wait "$lifecycle_pid"

echo 'atomic notification page PostgreSQL 17 checks passed'
