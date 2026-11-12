#!/usr/bin/env bash

# PostgreSQL 17 proof that legacy ranking_change payloads cannot be replayed
# through the service notification reader, while safe notification types remain
# paginated and counted normally.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261111132446_notification_ranking_change_reader_fence_hosted_role_graph.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl postgres psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/postgres" --version)" != postgres\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/notification-ranking-change-reader-fence-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((56500 + RANDOM % 300))
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

expect_browser_denial() {
  local role="$1"
  local failure_log="$TMP_ROOT/${role}-denial.log"
  if psql_cmd -v VERBOSITY=verbose -c \
    "SET ROLE $role; SELECT title FROM public.get_user_notifications('11111111-1111-4111-8111-111111111111', 50, 0, false)" \
    >"$failure_log" 2>&1; then
    echo "Expected browser RPC denial: $role" >&2
    return 1
  fi
  if ! grep -Fq '42501' "$failure_log" ||
     ! grep -Fq 'permission denied for function get_user_notifications' "$failure_log"; then
    cat "$failure_log" >&2
    echo "Missing direct RPC denial evidence: $role" >&2
    return 1
  fi
}

expect_runtime_guard_denial() {
  local failure_log="$TMP_ROOT/authenticated-runtime-guard.log"
  if psql_cmd -v VERBOSITY=verbose -c \
    "SET ROLE authenticated; SET request.jwt.claim.role = 'authenticated'; SELECT title FROM public.get_user_notifications('11111111-1111-4111-8111-111111111111', 50, 0, false)" \
    >"$failure_log" 2>&1; then
    echo 'Expected internal notification reader guard denial' >&2
    return 1
  fi
  if ! grep -Fq '42501' "$failure_log" ||
     ! grep -Fq 'notification reader requires service role' "$failure_log"; then
    cat "$failure_log" >&2
    echo 'Missing internal notification reader guard evidence' >&2
    return 1
  fi
}

expect_migration_failure() {
  local label="$1"
  local needle="$2"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"

  if psql_cmd -v VERBOSITY=verbose -f "$MIGRATION" >"$failure_log" 2>&1; then
    echo "Expected migration failure: $label" >&2
    return 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    cat "$failure_log" >&2
    echo "Missing migration failure evidence: $label" >&2
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
CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS;
CREATE ROLE inherited_reader NOLOGIN INHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE setter_reader NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE setter_bridge NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE admin_bridge NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE delegated_reader NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE hostile_owner NOLOGIN;

-- PostgREST connects as this trusted NOINHERIT gateway, then SETs the service
-- role only after validating a service JWT. The migration must preserve this
-- exact edge and reject every other authority path.
GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  )
$function$;
ALTER FUNCTION auth.role() OWNER TO postgres;
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  )::uuid
$function$;
ALTER FUNCTION auth.uid() OWNER TO postgres;

GRANT USAGE ON SCHEMA public, auth
  TO anon, authenticated, service_role, authenticator, inherited_reader,
     setter_reader, setter_bridge, admin_bridge, delegated_reader, hostile_owner;
GRANT EXECUTE ON FUNCTION auth.role(), auth.uid() TO anon, authenticated, service_role;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  handle text,
  avatar_url text
);
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  link text,
  read boolean NOT NULL DEFAULT false,
  actor_id uuid,
  reference_id text,
  created_at timestamp with time zone NOT NULL DEFAULT pg_catalog.now()
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.notifications OWNER TO postgres;
-- Deliberately hostile historical state: policies exist but are inert. The
-- migration must explicitly re-enable RLS rather than merely replacing policy
-- text and assuming a prior migration's table setting survived.
ALTER TABLE public.notifications DISABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own notifications"
  ON public.notifications
  AS PERMISSIVE
  FOR SELECT
  TO public
  USING ((SELECT auth.uid()) = user_id);
CREATE POLICY "Service manage notifications"
  ON public.notifications
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
GRANT SELECT ON public.notifications TO anon, authenticated, service_role;

INSERT INTO public.user_profiles (id, handle, avatar_url) VALUES
  ('11111111-1111-4111-8111-111111111111', 'viewer', '/viewer.png');
INSERT INTO public.notifications (
  id, user_id, type, title, message, link, read, actor_id, reference_id, created_at
) VALUES
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '11111111-1111-4111-8111-111111111111',
    'ranking_change',
    'unsafe-rank',
    'Rank #9 to #1 and ROI 80%',
    '/trader/unsafe',
    false,
    '11111111-1111-4111-8111-111111111111',
    'unsafe-rank',
    '2026-08-17T03:00:00.000Z'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    '11111111-1111-4111-8111-111111111111',
    'system',
    'safe-system',
    'A safe account message',
    '/settings',
    false,
    NULL,
    'safe-system',
    '2026-08-17T02:00:00.000Z'
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    '11111111-1111-4111-8111-111111111111',
    'follow',
    'safe-follow',
    'A safe social message',
    '/feed',
    false,
    NULL,
    'safe-follow',
    '2026-08-17T01:00:00.000Z'
  );

-- Deliberately permissive legacy body: it returns ranking_change before this
-- migration installs the reader fence.
CREATE FUNCTION public.get_user_notifications(
  p_user_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_unread_only boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  user_id uuid,
  type text,
  title text,
  message text,
  link text,
  read boolean,
  actor_id uuid,
  reference_id text,
  created_at timestamp with time zone,
  actor_handle text,
  actor_avatar_url text,
  unread_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  WITH notification_page AS (
    SELECT
      notification.id,
      notification.user_id,
      notification.type::text,
      notification.title,
      notification.message,
      notification.link,
      notification.read,
      notification.actor_id,
      notification.reference_id,
      notification.created_at
    FROM public.notifications AS notification
    WHERE notification.user_id = p_user_id
      AND (NOT p_unread_only OR NOT notification.read)
    ORDER BY notification.created_at DESC
    LIMIT p_limit
    OFFSET p_offset
  ),
  unread AS (
    SELECT pg_catalog.count(*) AS count
    FROM public.notifications AS notification
    WHERE notification.user_id = p_user_id
      AND NOT notification.read
  )
  SELECT
    notification_page.id,
    notification_page.user_id,
    notification_page.type,
    notification_page.title,
    notification_page.message,
    notification_page.link,
    notification_page.read,
    notification_page.actor_id,
    notification_page.reference_id,
    notification_page.created_at,
    actor.handle,
    actor.avatar_url,
    unread.count
  FROM notification_page
  LEFT JOIN public.user_profiles AS actor
    ON actor.id = notification_page.actor_id
  CROSS JOIN unread
  ORDER BY notification_page.created_at DESC;
END
$function$;
-- 20260717220000_notification_read_authority makes postgres the owner.
ALTER FUNCTION public.get_user_notifications(uuid, integer, integer, boolean)
  OWNER TO postgres;
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(uuid, integer, integer, boolean)
  TO PUBLIC;

CREATE FUNCTION public.get_user_notifications(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $function$
  SELECT 'unsafe-overload'
$function$;
ALTER FUNCTION public.get_user_notifications(uuid) OWNER TO hostile_owner;
GRANT EXECUTE ON FUNCTION public.get_user_notifications(uuid) TO PUBLIC;
SQL

# legacy ranking_change is present before the reader fence
assert_query \
  'ranking_change|system|follow' \
  "SET ROLE authenticated; SELECT string_agg(type, '|' ORDER BY created_at DESC) FROM public.get_user_notifications('11111111-1111-4111-8111-111111111111', 50, 0, false)" \
  'legacy reader returns ranking_change before the fence'
assert_query \
  'unsafe-rank|safe-system|safe-follow' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; SELECT string_agg(title, '|' ORDER BY created_at DESC) FROM public.notifications" \
  'legacy authenticated table reader returns ranking_change before the fence'

# A notification-table owner bypasses non-FORCE RLS. The cutover must fail
# closed rather than replacing policies beneath an unexpected owner.
psql_cmd -c 'ALTER TABLE public.notifications OWNER TO hostile_owner' >/dev/null
expect_migration_failure \
  'hostile-notification-owner' \
  'notification reader fence requires the postgres-owned table'
assert_query \
  'f' \
  "SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.notifications'::pg_catalog.regclass" \
  'failed owner cutover leaves disabled RLS unchanged'
psql_cmd -c 'ALTER TABLE public.notifications OWNER TO postgres' >/dev/null

# Browser authority may be inherited through an intermediate role. The first
# application must reject it before it can turn on RLS/policies and claim a
# successful reader fence.
psql_cmd <<'SQL' >/dev/null
GRANT service_role TO inherited_reader WITH INHERIT TRUE, SET FALSE;
GRANT inherited_reader TO authenticated WITH INHERIT TRUE, SET FALSE;
SQL
expect_migration_failure \
  'browser-inherited-service-role-before-cutover' \
  'notification reader internal role authority graph is unsafe'
assert_query \
  'f' \
  "SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.notifications'::pg_catalog.regclass" \
  'failed inherited-role cutover leaves disabled RLS unchanged'
psql_cmd <<'SQL' >/dev/null
REVOKE inherited_reader FROM authenticated;
REVOKE service_role FROM inherited_reader;
SQL

if [[ "${SUPABASE_MANAGED_GRAPH_PROOF:-0}" == "1" ]]; then
  # shellcheck source=lib/supabase-managed-graph-proof.sh
  source "$ROOT_DIR/supabase/migrations/__tests__/lib/supabase-managed-graph-proof.sh"
  if [[ "${SUPABASE_MANAGED_GRAPH_EXECUTOR:-}" == "hosted" ]]; then
    # The hostile_owner overload is a bare-cluster attack fixture. A
    # non-superuser executor cannot take it over and fails closed instead, so
    # the hosted-executor path proves convergence without it.
    psql_cmd -q -c 'DROP FUNCTION public.get_user_notifications(uuid)'
  fi
  run_supabase_managed_graph_proof
  exit 0
fi

psql_cmd -f "$MIGRATION" >/dev/null

# The reader migration must repair a disabled-RLS fixture before its policy can
# provide any direct-table protection.
assert_query \
  't' \
  "SELECT relrowsecurity FROM pg_catalog.pg_class WHERE oid = 'public.notifications'::pg_catalog.regclass" \
  'reader migration enables RLS from disabled baseline'

# safe page skips the ranking_change row before LIMIT/OFFSET
assert_query \
  'safe-system|2' \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT title || '|' || unread_count FROM public.get_user_notifications('11111111-1111-4111-8111-111111111111', 1, 0, false)" \
  'first safe page excludes newer ranking_change'
assert_query \
  'safe-follow|2' \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT title || '|' || unread_count FROM public.get_user_notifications('11111111-1111-4111-8111-111111111111', 1, 1, false)" \
  'second safe page is not displaced by ranking_change'

# unread count excludes the suppressed ranking_change row
assert_query \
  '2' \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT unread_count FROM public.get_user_notifications('11111111-1111-4111-8111-111111111111', 1, 0, true)" \
  'safe unread count excludes ranking_change'

# anonymous direct notification RPC is denied
expect_browser_denial anon
# authenticated direct notification RPC is denied
expect_browser_denial authenticated

assert_query \
  '0' \
  "SET ROLE anon; SELECT count(*) FROM public.notifications" \
  'anonymous table RLS reader remains denied'

assert_query \
  'safe-system|safe-follow' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; SELECT string_agg(title, '|' ORDER BY created_at DESC) FROM public.notifications" \
  'authenticated table RLS reader excludes ranking_change'

# The canonical PostgREST gateway keeps the required SET-only service path.
assert_query \
  'safe-system|safe-follow' \
  "SET ROLE authenticator; SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT string_agg(title, '|' ORDER BY created_at DESC) FROM public.get_user_notifications('11111111-1111-4111-8111-111111111111', 50, 0, false)" \
  'canonical authenticator SET ROLE service reader remains available'

# The preserved service ALL policy is permissive with the browser policy. A
# browser role that inherits service_role would therefore replay the unsafe row
# unless role-topology preflight rejects the replay.
psql_cmd <<'SQL' >/dev/null
GRANT service_role TO inherited_reader WITH INHERIT TRUE, SET FALSE;
GRANT inherited_reader TO authenticated WITH INHERIT TRUE, SET FALSE;
SQL
assert_query \
  'unsafe-rank|safe-system|safe-follow' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; SELECT string_agg(title, '|' ORDER BY created_at DESC) FROM public.notifications" \
  'inherited browser service role bypasses the RLS type predicate before replay rejection'
expect_migration_failure \
  'browser-inherited-service-role-replay' \
  'notification reader internal role authority graph is unsafe'
psql_cmd <<'SQL' >/dev/null
REVOKE inherited_reader FROM authenticated;
REVOKE service_role FROM inherited_reader;
SQL
psql_cmd -f "$MIGRATION" >/dev/null
assert_query \
  'safe-system|safe-follow' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; SELECT string_agg(title, '|' ORDER BY created_at DESC) FROM public.notifications" \
  'replay restores browser RLS type fence after inherited-role removal'

# SET-only chains and ADMIN-option delegators are authority too, even though
# their current roles do not inherit service_role directly.
psql_cmd <<'SQL' >/dev/null
GRANT authenticator TO setter_bridge WITH INHERIT FALSE, SET TRUE;
GRANT setter_bridge TO setter_reader WITH INHERIT FALSE, SET TRUE;
SQL
assert_query \
  '3' \
  "SET ROLE setter_reader; SET ROLE setter_bridge; SET ROLE authenticator; SET ROLE service_role; SELECT count(*) FROM public.notifications" \
  'multi-hop SET ROLE path reaches the service notification reader before rejection'
expect_migration_failure \
  'multi-hop-set-role-reader' \
  'notification reader internal role authority graph is unsafe'
psql_cmd <<'SQL' >/dev/null
REVOKE setter_bridge FROM setter_reader;
REVOKE authenticator FROM setter_bridge;
SQL

psql_cmd -c \
  'GRANT authenticator TO admin_bridge WITH ADMIN TRUE, INHERIT FALSE, SET FALSE' >/dev/null
expect_migration_failure \
  'admin-option-authenticator-delegator' \
  'notification reader internal role authority graph is unsafe'
psql_cmd <<'SQL' >/dev/null
SET ROLE admin_bridge;
GRANT authenticator TO delegated_reader WITH INHERIT FALSE, SET TRUE;
RESET ROLE;
SQL
assert_query \
  '3' \
  "SET ROLE delegated_reader; SET ROLE authenticator; SET ROLE service_role; SELECT count(*) FROM public.notifications" \
  'ADMIN-option bridge can delegate a service reader before rejection'
expect_migration_failure \
  'delegated-reader-through-admin-option' \
  'notification reader internal role authority graph is unsafe'
psql_cmd <<'SQL' >/dev/null
SET ROLE admin_bridge;
REVOKE authenticator FROM delegated_reader;
RESET ROLE;
REVOKE authenticator FROM admin_bridge;
SQL

# A browser BYPASSRLS flag also defeats the direct-table policy even without a
# membership edge, and must make replay fail closed.
psql_cmd -c 'ALTER ROLE authenticated BYPASSRLS' >/dev/null
assert_query \
  'unsafe-rank|safe-system|safe-follow' \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; SELECT string_agg(title, '|' ORDER BY created_at DESC) FROM public.notifications" \
  'browser BYPASSRLS role can replay ranking_change before rejection'
expect_migration_failure \
  'browser-bypassrls-role' \
  'notification reader browser role posture is unsafe'
psql_cmd -c 'ALTER ROLE authenticated NOBYPASSRLS' >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

assert_query \
  'f|f|t|f|postgres|postgres' \
  "SELECT has_function_privilege('anon', 'public.get_user_notifications(uuid,integer,integer,boolean)', 'EXECUTE'), has_function_privilege('authenticated', 'public.get_user_notifications(uuid,integer,integer,boolean)', 'EXECUTE'), has_function_privilege('service_role', 'public.get_user_notifications(uuid,integer,integer,boolean)', 'EXECUTE'), has_function_privilege('authenticated', 'public.get_user_notifications(uuid)', 'EXECUTE'), pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'public.get_user_notifications(uuid,integer,integer,boolean)'::regprocedure)), pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'public.get_user_notifications(uuid)'::regprocedure))" \
  'canonical and phantom reader ACLs converge'

GRANT_EXECUTE_SQL="GRANT EXECUTE ON FUNCTION public.get_user_notifications(uuid, integer, integer, boolean) TO authenticated;"
psql_cmd -c "$GRANT_EXECUTE_SQL" >/dev/null
expect_runtime_guard_denial

# Reintroduce explicit grants to prove the migration remains a convergent
# safety fence when replayed after historical ACL drift.
psql_cmd <<'SQL' >/dev/null
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(uuid, integer, integer, boolean)
  TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_user_notifications(uuid) TO authenticated;
SQL
psql_cmd -f "$MIGRATION" >/dev/null

# phantom overload is quarantined on replay
assert_query \
  'f|f|t|f' \
  "SELECT has_function_privilege('anon', 'public.get_user_notifications(uuid,integer,integer,boolean)', 'EXECUTE'), has_function_privilege('authenticated', 'public.get_user_notifications(uuid,integer,integer,boolean)', 'EXECUTE'), has_function_privilege('service_role', 'public.get_user_notifications(uuid,integer,integer,boolean)', 'EXECUTE'), has_function_privilege('authenticated', 'public.get_user_notifications(uuid)', 'EXECUTE')" \
  'replay removes canonical and phantom browser grants'

# service reader keeps non-ranking notifications
assert_query \
  'safe-system|safe-follow' \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT string_agg(title, '|' ORDER BY created_at DESC) FROM public.get_user_notifications('11111111-1111-4111-8111-111111111111', 50, 0, false)" \
  'safe rows remain visible after replay'

echo 'PostgreSQL 17 notification ranking-change reader fence proof passed'
