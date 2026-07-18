#!/usr/bin/env bash

# PostgreSQL 17 proof that the notification reader cannot be invoked directly
# by a browser role with another account's p_user_id.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LEGACY_MIGRATION="$ROOT_DIR/supabase/migrations/20260422121538_optimize_notifications_rpc.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260717220000_notification_read_authority.sql"
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

TMP_ROOT="$(mktemp -d /tmp/notification-read-authority-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((56300 + RANDOM % 400))
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
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
  local failure_log="$TMP_ROOT/${role}-browser-denial.log"
  if psql_cmd -v VERBOSITY=verbose -c \
    "SET ROLE $role; SELECT title FROM public.get_user_notifications('22222222-2222-4222-8222-222222222222', 50, 0, false)" \
    >"$failure_log" 2>&1; then
    echo "Expected browser RPC denial: $role" >&2
    return 1
  fi
  if ! grep -Fq '42501' "$failure_log" ||
     ! grep -Fq 'permission denied for function get_user_notifications' "$failure_log"; then
    cat "$failure_log" >&2
    echo "Missing 42501 browser denial evidence: $role" >&2
    return 1
  fi
}

expect_guard_denial() {
  local role="$1"
  local failure_log="$TMP_ROOT/${role}-guard-denial.log"
  if psql_cmd -v VERBOSITY=verbose -c \
    "SET ROLE $role; SET request.jwt.claim.role = '$role'; SELECT title FROM public.get_user_notifications('22222222-2222-4222-8222-222222222222')" \
    >"$failure_log" 2>&1; then
    echo "Expected notification reader guard denial: $role" >&2
    return 1
  fi
  if ! grep -Fq '42501' "$failure_log" ||
     ! grep -Fq 'notification reader requires service role' "$failure_log"; then
    cat "$failure_log" >&2
    echo "Missing internal 42501 guard evidence: $role" >&2
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
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE hostile_owner NOLOGIN;
CREATE ROLE legacy_reader NOLOGIN;
CREATE ROLE downstream_reader NOLOGIN;

CREATE SCHEMA auth AUTHORIZATION postgres;
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
GRANT USAGE ON SCHEMA public, auth
  TO anon, authenticated, service_role, hostile_owner, legacy_reader,
    downstream_reader;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role()
  TO anon, authenticated, service_role;

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
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.notifications OWNER TO postgres;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_owner_read
  ON public.notifications
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);
GRANT SELECT ON public.notifications TO authenticated;

INSERT INTO public.user_profiles (id, handle, avatar_url) VALUES
  ('11111111-1111-4111-8111-111111111111', 'attacker', '/attacker.png'),
  ('22222222-2222-4222-8222-222222222222', 'victim', '/victim.png');
INSERT INTO public.notifications (
  id, user_id, type, title, message, link, actor_id, reference_id
) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '22222222-2222-4222-8222-222222222222',
  'system',
  'victim-secret-title',
  'victim-secret-message',
  '/private/victim',
  '22222222-2222-4222-8222-222222222222',
  'victim-secret-reference'
);
SQL

psql_cmd -f "$LEGACY_MIGRATION" >/dev/null
psql_cmd -c \
  'ALTER FUNCTION public.get_user_notifications(uuid, integer, integer, boolean) OWNER TO postgres' \
  >/dev/null

# Before hardening, PUBLIC's default EXECUTE lets an authenticated attacker
# bypass notification RLS by supplying the victim's UUID to the definer RPC.
assert_query \
  "victim-secret-title" \
  "SET ROLE authenticated; SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111'; SELECT title FROM public.get_user_notifications('22222222-2222-4222-8222-222222222222', 50, 0, false)" \
  "legacy cross-account notification disclosure reproduced"

# A phantom overload, hostile owner, unknown grantee, and downstream grant must
# all be quarantined instead of making the transaction roll back to the leak.
psql_cmd <<'SQL' >/dev/null
CREATE FUNCTION public.get_user_notifications(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $function$
  SELECT 0
$function$;
ALTER FUNCTION public.get_user_notifications(uuid)
  OWNER TO hostile_owner;
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(uuid)
  TO PUBLIC, authenticated;
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(uuid)
  TO legacy_reader
  WITH GRANT OPTION;
SET ROLE legacy_reader;
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(uuid)
  TO downstream_reader;
RESET ROLE;

-- Reproduce canonical metadata and ACL drift too; the migration owns and
-- rebuilds this exact function rather than trusting the old body.
ALTER FUNCTION public.get_user_notifications(
  uuid, integer, integer, boolean
) SECURITY INVOKER;
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(
    uuid, integer, integer, boolean
  )
  TO legacy_reader
  WITH GRANT OPTION;
SET ROLE legacy_reader;
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(
    uuid, integer, integer, boolean
  )
  TO downstream_reader;
RESET ROLE;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

assert_query \
  "f|f|t|f|f|f|f|postgres|postgres" \
  "SELECT has_function_privilege('anon', 'public.get_user_notifications(uuid,integer,integer,boolean)', 'EXECUTE'), has_function_privilege('authenticated', 'public.get_user_notifications(uuid,integer,integer,boolean)', 'EXECUTE'), has_function_privilege('service_role', 'public.get_user_notifications(uuid,integer,integer,boolean)', 'EXECUTE'), has_function_privilege('service_role', 'public.get_user_notifications(uuid)', 'EXECUTE'), has_function_privilege('hostile_owner', 'public.get_user_notifications(uuid)', 'EXECUTE'), has_function_privilege('legacy_reader', 'public.get_user_notifications(uuid,integer,integer,boolean)', 'EXECUTE'), has_function_privilege('downstream_reader', 'public.get_user_notifications(uuid)', 'EXECUTE'), pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'public.get_user_notifications(uuid,integer,integer,boolean)'::regprocedure)), pg_get_userbyid((SELECT proowner FROM pg_proc WHERE oid = 'public.get_user_notifications(uuid)'::regprocedure))" \
  "all notification RPC overload authority converged"
expect_browser_denial anon
expect_browser_denial authenticated
assert_query \
  "victim-secret-title|victim-secret-message|/private/victim|victim-secret-reference" \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT title, message, link, reference_id FROM public.get_user_notifications('22222222-2222-4222-8222-222222222222', 50, 0, false)" \
  "service route retains notification read authority"

assert_query \
  "50, 0, false|p_user_id uuid, p_limit integer, p_offset integer, p_unread_only boolean|TABLE(id uuid, user_id uuid, type text, title text, message text, link text, read boolean, actor_id uuid, reference_id text, created_at timestamp with time zone, actor_handle text, actor_avatar_url text, unread_count bigint)|{\"search_path=pg_catalog, pg_temp\"}|e65cc383873adaa2dca14b0e3eb5cac6" \
  "SELECT pg_catalog.pg_get_expr(proargdefaults, 0), pg_catalog.pg_get_function_identity_arguments(oid), pg_catalog.pg_get_function_result(oid), proconfig::text, pg_catalog.md5(prosrc) FROM pg_catalog.pg_proc WHERE oid = 'public.get_user_notifications(uuid,integer,integer,boolean)'::regprocedure" \
  "canonical notification reader catalog contract"

# Remove the quarantined overload from this isolated fixture so PostgreSQL can
# resolve the canonical function's intentional one-argument default call.
psql_cmd -c \
  'DROP FUNCTION public.get_user_notifications(uuid)' >/dev/null
assert_query \
  "victim-secret-title" \
  "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT title FROM public.get_user_notifications('22222222-2222-4222-8222-222222222222')" \
  "canonical notification reader defaults remain callable"

# Even if browser EXECUTE drifts back before replay, the internal JWT-role
# guard independently denies cross-account reads with SQLSTATE 42501.
psql_cmd <<'SQL' >/dev/null
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(uuid, integer, integer, boolean)
  TO authenticated;
SQL
expect_guard_denial authenticated

# Replaying must remove browser, unknown-role, downstream, and grant-option
# drift across every function overload.
psql_cmd <<'SQL' >/dev/null
CREATE FUNCTION public.get_user_notifications(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $function$
  SELECT 0
$function$;
ALTER FUNCTION public.get_user_notifications(uuid)
  OWNER TO hostile_owner;
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(uuid, integer, integer, boolean)
  TO PUBLIC, anon;
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(uuid, integer, integer, boolean)
  TO legacy_reader
  WITH GRANT OPTION;
SET ROLE legacy_reader;
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(uuid, integer, integer, boolean)
  TO downstream_reader;
RESET ROLE;
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(uuid, integer, integer, boolean)
  TO service_role
  WITH GRANT OPTION;
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(uuid)
  TO authenticated;
GRANT EXECUTE
  ON FUNCTION public.get_user_notifications(uuid)
  TO legacy_reader
  WITH GRANT OPTION;
SQL
psql_cmd -f "$MIGRATION" >/dev/null

expect_browser_denial anon
expect_browser_denial authenticated
assert_query \
  "t|f|f|f|f|2|1" \
  "SELECT has_function_privilege('service_role', 'public.get_user_notifications(uuid,integer,integer,boolean)', 'EXECUTE'), bool_or(acl_entry.is_grantable) FILTER (WHERE acl_entry.grantee = (SELECT oid FROM pg_roles WHERE rolname = 'service_role')), has_function_privilege('service_role', 'public.get_user_notifications(uuid)', 'EXECUTE'), has_function_privilege('legacy_reader', 'public.get_user_notifications(uuid,integer,integer,boolean)', 'EXECUTE'), has_function_privilege('downstream_reader', 'public.get_user_notifications(uuid,integer,integer,boolean)', 'EXECUTE'), count(*) FILTER (WHERE function_row.oid = 'public.get_user_notifications(uuid,integer,integer,boolean)'::regprocedure), count(*) FILTER (WHERE function_row.oid = 'public.get_user_notifications(uuid)'::regprocedure) FROM pg_proc AS function_row CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry WHERE function_row.oid IN ('public.get_user_notifications(uuid,integer,integer,boolean)'::regprocedure, 'public.get_user_notifications(uuid)'::regprocedure)" \
  "replay converges exact notification RPC ACL"

echo "Notification read authority PostgreSQL 17 proof passed"
