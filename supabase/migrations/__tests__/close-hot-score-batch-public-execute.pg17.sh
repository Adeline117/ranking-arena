#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803104500_close_hot_score_batch_public_execute.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/hot-score-batch-acl-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="$((58500 + ($$ % 400)))"

cleanup() {
  if [[ -d "$PGDATA" ]]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

if [[ ! -x "$PG_BIN/initdb" || ! -x "$PG_BIN/pg_ctl" || ! -x "$PG_BIN/psql" ]]; then
  echo "PostgreSQL 17 binaries not found at $PG_BIN" >&2
  exit 1
fi

mkdir -p "$SOCKET_DIR"
"$PG_BIN/initdb" -D "$PGDATA" --auth=trust --username=postgres --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$PGDATA" -o "-F -k $SOCKET_DIR -p $PORT" -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -q \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres postgres "$@"
}

assert_scalar() {
  local expected="$1"
  local query="$2"
  local actual
  actual="$(psql_cmd -At -c "$query")"
  if [[ "$actual" != "$expected" ]]; then
    echo "assertion failed: expected '$expected', got '$actual'" >&2
    echo "$query" >&2
    exit 1
  fi
}

psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  hot_score numeric NOT NULL DEFAULT 0,
  last_hot_refresh_at timestamptz,
  likes_last_hour integer NOT NULL DEFAULT 0,
  comments_last_hour integer NOT NULL DEFAULT 0,
  velocity_updated_at timestamptz,
  report_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.post_reactions (
  post_id uuid NOT NULL,
  reaction_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.comments (
  post_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.content_reports (
  content_type text NOT NULL,
  content_id text NOT NULL,
  status text NOT NULL
);

CREATE OR REPLACE FUNCTION public.calculate_hot_score(value numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT value
$function$;

CREATE OR REPLACE FUNCTION public.refresh_hot_scores()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  updated_count integer;
BEGIN
  UPDATE posts SET
    hot_score = calculate_hot_score(hot_score),
    last_hot_refresh_at = now();
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END
$function$;

CREATE OR REPLACE FUNCTION public.refresh_hot_scores_incremental()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  updated_count integer;
BEGIN
  UPDATE posts SET
    hot_score = calculate_hot_score(hot_score),
    last_hot_refresh_at = now()
  WHERE updated_at >= created_at;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END
$function$;

CREATE OR REPLACE FUNCTION public.update_post_velocity()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  updated_count integer;
BEGIN
  UPDATE posts p SET
    likes_last_hour = 0,
    comments_last_hour = 0,
    velocity_updated_at = now()
  WHERE EXISTS (SELECT 1 FROM post_reactions WHERE post_id = p.id)
     OR EXISTS (SELECT 1 FROM comments WHERE post_id = p.id);
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END
$function$;

CREATE OR REPLACE FUNCTION public.update_post_report_counts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  updated_count integer;
BEGIN
  UPDATE posts p SET
    report_count = (
      SELECT count(*)
      FROM content_reports
      WHERE content_type = 'post'
        AND content_id = p.id::text
    );
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END
$function$;

INSERT INTO public.posts(id)
VALUES ('10000000-0000-0000-0000-000000000001');
SQL

# PostgreSQL's historical default made every function callable through PUBLIC.
assert_scalar 't|t|t|t' \
  "SELECT
     has_function_privilege('anon', 'public.refresh_hot_scores()', 'EXECUTE'),
     has_function_privilege('authenticated', 'public.refresh_hot_scores_incremental()', 'EXECUTE'),
     has_function_privilege('authenticator', 'public.update_post_velocity()', 'EXECUTE'),
     has_function_privilege('service_role', 'public.update_post_report_counts()', 'EXECUTE')"

psql_cmd -f "$MIGRATION"

assert_scalar 'f|f|f|t' \
  "SELECT
     has_function_privilege('anon', 'public.refresh_hot_scores()', 'EXECUTE'),
     has_function_privilege('authenticated', 'public.refresh_hot_scores_incremental()', 'EXECUTE'),
     has_function_privilege('authenticator', 'public.update_post_velocity()', 'EXECUTE'),
     has_function_privilege('service_role', 'public.update_post_report_counts()', 'EXECUTE')"

assert_scalar '4' \
  "SELECT count(*)
     FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid IN (
      'public.refresh_hot_scores()'::regprocedure,
      'public.refresh_hot_scores_incremental()'::regprocedure,
      'public.update_post_velocity()'::regprocedure,
      'public.update_post_report_counts()'::regprocedure
    )
      AND function_row.proowner = 'postgres'::regrole
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, public, pg_temp',
        'row_security=off',
        'lock_timeout=5s',
        'statement_timeout=60s'
      ]::text[]
      AND obj_description(function_row.oid, 'pg_proc') =
        'post-hot-score-service-authority:v1:' || md5(function_row.prosrc)"

if psql_cmd -At -c \
  "SET ROLE authenticated; SELECT public.refresh_hot_scores()" \
  >"$TMP_ROOT/browser-call.out" 2>"$TMP_ROOT/browser-call.err"; then
  echo 'authenticated caller retained hot-score batch execute' >&2
  exit 1
fi
grep -q 'permission denied for function refresh_hot_scores' "$TMP_ROOT/browser-call.err"

assert_scalar '0|1|1|1' \
  "SET ROLE service_role;
   SELECT public.update_post_velocity(),
          public.update_post_report_counts(),
          public.refresh_hot_scores_incremental(),
          public.refresh_hot_scores()"

# Replay removes deliberately reintroduced direct and inherited-style grants,
# settings drift, and service-role grant option.
psql_cmd <<'SQL'
RESET ROLE;
GRANT EXECUTE ON FUNCTION public.refresh_hot_scores() TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_post_velocity() TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_post_report_counts() TO service_role WITH GRANT OPTION;
ALTER FUNCTION public.refresh_hot_scores_incremental() RESET lock_timeout;
COMMENT ON FUNCTION public.update_post_velocity() IS 'drift';
SQL
psql_cmd -f "$MIGRATION"
assert_scalar 'f|f|t|f|4' \
  "SELECT
     has_function_privilege('anon', 'public.refresh_hot_scores()', 'EXECUTE'),
     has_function_privilege('authenticated', 'public.update_post_velocity()', 'EXECUTE'),
     has_function_privilege('service_role', 'public.update_post_report_counts()', 'EXECUTE'),
     EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
       WHERE function_row.oid = 'public.update_post_report_counts()'::regprocedure
         AND acl_entry.grantee = 'service_role'::regrole
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.is_grantable
     ),
     (
       SELECT count(*)
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid IN (
         'public.refresh_hot_scores()'::regprocedure,
         'public.refresh_hot_scores_incremental()'::regprocedure,
         'public.update_post_velocity()'::regprocedure,
         'public.update_post_report_counts()'::regprocedure
       )
         AND cardinality(function_row.proconfig) = 4
     )"

# An unknown overload is a separate PostgREST surface and fails closed.
psql_cmd <<'SQL'
CREATE FUNCTION public.refresh_hot_scores(p_limit integer DEFAULT 1)
RETURNS integer
LANGUAGE sql
AS $function$
  SELECT p_limit
$function$;
SQL
if psql_cmd -f "$MIGRATION" \
  >"$TMP_ROOT/overload.out" 2>"$TMP_ROOT/overload.err"; then
  echo 'migration accepted an unknown hot-score overload' >&2
  exit 1
fi
grep -q 'overload set drifted' "$TMP_ROOT/overload.err"
psql_cmd -c 'DROP FUNCTION public.refresh_hot_scores(integer)'

# The ACL migration refuses to bless a body that is no longer the reviewed
# batch writer, even though it could still return the expected scalar type.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.update_post_report_counts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  RETURN 0;
END
$function$;
SQL
if psql_cmd -f "$MIGRATION" \
  >"$TMP_ROOT/source-drift.out" 2>"$TMP_ROOT/source-drift.err"; then
  echo 'migration accepted a drifted hot-score body' >&2
  exit 1
fi
grep -q 'source drifted' "$TMP_ROOT/source-drift.err"

psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.update_post_report_counts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  updated_count integer;
BEGIN
  UPDATE posts p SET
    report_count = (
      SELECT count(*)
      FROM content_reports
      WHERE content_type = 'post'
        AND content_id = p.id::text
    );
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END
$function$;
SQL
psql_cmd -f "$MIGRATION"

echo 'hot-score batch public execute PG17 proof passed'
