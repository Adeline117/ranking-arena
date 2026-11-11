#!/usr/bin/env bash

# PostgreSQL 17 hostile proof for the arena_bot legacy-publication fence.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261111132447_arena_bot_legacy_publication_isolation_hosted_role_graph.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/arena-bot-publication-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55618
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure() {
  local sql="$1"
  local label="$2"
  if psql_cmd -Atqc "$sql" >/dev/null 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
}

assert_equals() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Assertion failed (%s): expected %q, got %q\n' "$label" "$expected" "$actual" >&2
    return 1
  fi
}

scalar() {
  psql_cmd -Atqc "$1" | tr -d '\r'
}

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

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE hostile_role NOLOGIN NOSUPERUSER NOBYPASSRLS;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO PUBLIC;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, hostile_role;

CREATE TYPE public.post_status AS ENUM ('active', 'locked', 'deleted');
CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL,
  author_handle text,
  title text NOT NULL,
  content text NOT NULL,
  group_id uuid,
  visibility text NOT NULL DEFAULT 'public',
  status public.post_status NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  delete_reason text,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  original_post_id uuid REFERENCES public.posts(id)
);
ALTER TABLE public.posts OWNER TO postgres;
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.posts TO anon, authenticated, service_role;

CREATE FUNCTION public.can_actor_read_post_fields(
  p_viewer_id uuid,
  p_author_id uuid,
  p_group_id uuid,
  p_visibility text,
  p_status public.post_status,
  p_deleted_at timestamptz
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE(CASE
    WHEN p_author_id IS NULL
      OR p_status IS NULL
      OR p_visibility IS NULL
      OR p_deleted_at IS NOT NULL
      OR p_status NOT IN ('active'::public.post_status, 'locked'::public.post_status)
      OR p_visibility <> 'public'
    THEN false
    ELSE true
  END, false)
$function$;
ALTER FUNCTION public.can_actor_read_post_fields(
  uuid, uuid, uuid, text, public.post_status, timestamptz
) OWNER TO postgres;

CREATE FUNCTION public.can_actor_read_post_id(p_post_id uuid, p_viewer_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE((
    SELECT public.can_actor_read_post_fields(
      p_viewer_id,
      wrapper.author_id,
      wrapper.group_id,
      wrapper.visibility,
      wrapper.status,
      wrapper.deleted_at
    ) AND (
      wrapper.original_post_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.posts AS root
        WHERE root.id = wrapper.original_post_id
          AND root.original_post_id IS NULL
          AND public.can_actor_read_post_fields(
            p_viewer_id,
            root.author_id,
            root.group_id,
            root.visibility,
            root.status,
            root.deleted_at
          )
      )
    )
    FROM public.posts AS wrapper
    WHERE wrapper.id = p_post_id
  ), false)
$function$;
ALTER FUNCTION public.can_actor_read_post_id(uuid, uuid) OWNER TO postgres;

CREATE FUNCTION public.current_user_can_read_post(p_post_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT public.can_actor_read_post_id(p_post_id, (SELECT auth.uid()))
$function$;
ALTER FUNCTION public.current_user_can_read_post(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.current_user_can_read_post(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_can_read_post(uuid) TO anon, authenticated;

CREATE FUNCTION public.can_service_actor_read_post(p_post_id uuid, p_actor_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING ERRCODE = '42501';
  END IF;
  RETURN public.can_actor_read_post_id(p_post_id, p_actor_id);
END
$function$;
ALTER FUNCTION public.can_service_actor_read_post(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_service_actor_read_post(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.can_service_actor_read_post(uuid, uuid) TO service_role;

CREATE POLICY posts_fixture_read
  ON public.posts
  FOR SELECT
  TO anon, authenticated
  USING (public.current_user_can_read_post(id));
CREATE POLICY posts_fixture_service
  ON public.posts
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE FUNCTION public.search_posts_with_weight(
  search_query text,
  result_limit integer DEFAULT 20,
  result_offset integer DEFAULT 0,
  weight_factor numeric DEFAULT 0.4
)
RETURNS TABLE(id uuid, title text, content text)
LANGUAGE sql
AS $function$
  SELECT post_row.id, post_row.title, post_row.content
  FROM public.posts AS post_row
  WHERE post_row.title ILIKE '%' || search_query || '%'
  LIMIT result_limit OFFSET result_offset
$function$;
ALTER FUNCTION public.search_posts_with_weight(text, integer, integer, numeric) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.search_posts_with_weight(text, integer, integer, numeric)
  TO PUBLIC, anon, authenticated, service_role, hostile_role;

INSERT INTO public.posts (id, author_id, author_handle, title, content, status)
VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'arena_bot', 'bot active', 'raw metric', 'active'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'arena_bot', 'bot locked', 'raw metric', 'locked'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'arena_bot', 'bot root', 'raw metric', 'active'),
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'ordinary_user', 'ordinary', 'ordinary text', 'active'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', 'arena_bot', 'same handle', 'ordinary text', 'active'),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', 'ordinary_user', 'repost wrapper', 'wrapper text', 'active');
UPDATE public.posts
SET original_post_id = '10000000-0000-0000-0000-000000000003'
WHERE id = '20000000-0000-0000-0000-000000000003';
SQL

if [[ "${SUPABASE_MANAGED_GRAPH_PROOF:-0}" == "1" ]]; then
  # shellcheck source=lib/supabase-managed-graph-proof.sh
  source "$ROOT_DIR/supabase/migrations/__tests__/lib/supabase-managed-graph-proof.sh"
  run_supabase_managed_graph_proof
  exit 0
fi

# A revoked function ACL is not meaningful if an arbitrary role can become
# its postgres owner. The migration must reject that capability graph before
# touching legacy rows, then converge normally once the attack is removed.
psql_cmd -c 'GRANT postgres TO hostile_role WITH INHERIT TRUE, SET TRUE' >/dev/null
if psql_cmd -f "$MIGRATION" >/dev/null 2>&1; then
  echo 'Expected owner-authority attack to block the migration' >&2
  exit 1
fi
psql_cmd -c 'REVOKE postgres FROM hostile_role' >/dev/null

psql_cmd -f "$MIGRATION" >/dev/null

assert_equals "$(scalar "SELECT count(*) FROM public.posts WHERE author_id = '00000000-0000-0000-0000-000000000001'::uuid AND status = 'deleted'::public.post_status AND deleted_at IS NOT NULL")" "3" "all bot rows soft-deleted"
assert_equals "$(scalar "SELECT delete_reason FROM public.posts WHERE id = '10000000-0000-0000-0000-000000000001'::uuid")" "unverified_legacy_arena_bot_publication" "bot quarantine reason"
assert_equals "$(scalar "SELECT status::text || ':' || COALESCE(deleted_at::text, 'null') || ':' || author_handle FROM public.posts WHERE id = '20000000-0000-0000-0000-000000000002'::uuid")" "active:null:arena_bot" "same-handle ordinary post untouched"
assert_equals "$(scalar "SELECT status::text || ':' || COALESCE(deleted_at::text, 'null') FROM public.posts WHERE id = '20000000-0000-0000-0000-000000000001'::uuid")" "active:null" "ordinary post untouched"

assert_equals "$(scalar "SET ROLE anon; SET request.jwt.claim.role = 'anon'; SELECT count(*) FROM public.posts WHERE author_id = '00000000-0000-0000-0000-000000000001'::uuid")" "0" "anon cannot read bot rows"
assert_equals "$(scalar "SET ROLE authenticated; SET request.jwt.claim.role = 'authenticated'; SELECT count(*) FROM public.posts WHERE id IN ('20000000-0000-0000-0000-000000000001'::uuid, '20000000-0000-0000-0000-000000000002'::uuid)")" "2" "ordinary and same-handle posts remain readable"
assert_equals "$(scalar "SET ROLE anon; SET request.jwt.claim.role = 'anon'; SELECT count(*) FROM public.posts WHERE id = '20000000-0000-0000-0000-000000000003'::uuid")" "0" "repost of quarantined root is hidden"

assert_equals "$(scalar "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; SELECT public.can_service_actor_read_post('10000000-0000-0000-0000-000000000001'::uuid, NULL)::text || ':' || public.can_service_actor_read_post('20000000-0000-0000-0000-000000000001'::uuid, NULL)::text || ':' || public.can_service_actor_read_post('20000000-0000-0000-0000-000000000003'::uuid, NULL)::text")" "false:true:false" "service canonical reader honors bot and root fence"

expect_failure "SET ROLE service_role; INSERT INTO public.posts (id, author_id, author_handle, title, content, status) VALUES ('30000000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000001'::uuid, 'arena_bot', 'new raw', 'raw metric', 'active'::public.post_status)" "service role cannot insert live bot post"
expect_failure "SET ROLE service_role; UPDATE public.posts SET status = 'active'::public.post_status, deleted_at = NULL WHERE id = '10000000-0000-0000-0000-000000000001'::uuid" "service role cannot restore bot post"
expect_failure "SET ROLE service_role; UPDATE public.posts SET author_id = '00000000-0000-0000-0000-000000000002'::uuid WHERE id = '10000000-0000-0000-0000-000000000001'::uuid" "service role cannot reattribute bot post"

psql_cmd -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
SET ROLE service_role;
INSERT INTO public.posts (id, author_id, author_handle, title, content, status)
VALUES (
  '30000000-0000-0000-0000-000000000002'::uuid,
  '00000000-0000-0000-0000-000000000004'::uuid,
  'arena_bot',
  'ordinary same handle',
  'ordinary text',
  'active'::public.post_status
);
SQL
assert_equals "$(scalar "SELECT count(*) FROM public.posts WHERE id = '30000000-0000-0000-0000-000000000002'::uuid")" "1" "nonbot same-handle write remains allowed"

assert_equals "$(scalar "SELECT pg_catalog.has_function_privilege('anon', 'public.search_posts_with_weight(text,integer,integer,numeric)', 'EXECUTE')::text || ':' || pg_catalog.has_function_privilege('authenticated', 'public.search_posts_with_weight(text,integer,integer,numeric)', 'EXECUTE')::text || ':' || pg_catalog.has_function_privilege('service_role', 'public.search_posts_with_weight(text,integer,integer,numeric)', 'EXECUTE')::text || ':' || pg_catalog.has_function_privilege('hostile_role', 'public.search_posts_with_weight(text,integer,integer,numeric)', 'EXECUTE')::text")" "false:false:false:false" "weighted raw search is not callable"
assert_equals "$(scalar "SELECT pg_catalog.has_function_privilege('anon', 'public.reject_unverified_arena_bot_publication()', 'EXECUTE')::text || ':' || pg_catalog.has_function_privilege('anon', 'public.can_actor_read_post_fields(uuid,uuid,uuid,text,public.post_status,timestamptz)', 'EXECUTE')::text")" "false:false" "fence internals are not callable"

echo "arena_bot legacy publication isolation PG17 proof passed"
