#!/usr/bin/env bash

# Executable PostgreSQL 17 proof that folder-detail removal is identity-bound,
# idempotent, compatible with legacy default-folder NULL rows, and never
# deletes a later move/re-add represented by a different identity.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729180000_atomic_bookmark_post_removal.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl postgres psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/postgres --version)" != postgres\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/atomic-bookmark-post-removal-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
FAILURE_LOG="$TMP_ROOT/expected-failure.log"
PORT="$(( 55000 + RANDOM % 5000 ))"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    [[ -f "$FAILURE_LOG" ]] && tail -200 "$FAILURE_LOG" >&2 || true
    [[ -f "$LOG_FILE" ]] && tail -240 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

authenticated_query() {
  local actor_id="$1"
  local sql="$2"
  psql_cmd -qAtc "
    SET ROLE authenticated;
    SET request.jwt.claim.role = 'authenticated';
    SET request.jwt.claim.sub = '$actor_id';
    $sql
    RESET ROLE;
  "
}

expect_value() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label drifted: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

expect_failure() {
  local label="$1"
  local sql="$2"
  if psql_cmd -qAtc "$sql" >"$FAILURE_LOG" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
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

psql_cmd -q <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOINHERIT;

CREATE SCHEMA auth AUTHORIZATION postgres;
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
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  )
$function$;
ALTER FUNCTION auth.uid() OWNER TO postgres;
ALTER FUNCTION auth.role() OWNER TO postgres;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean,
  ban_expires_at timestamptz
);
CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  bookmark_count bigint NOT NULL DEFAULT 0
);
CREATE TABLE public.bookmark_folders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  is_default boolean
);
CREATE TABLE public.post_bookmarks (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  folder_id uuid,
  UNIQUE (post_id, user_id)
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.posts OWNER TO postgres;
ALTER TABLE public.bookmark_folders OWNER TO postgres;
ALTER TABLE public.post_bookmarks OWNER TO postgres;

GRANT USAGE ON SCHEMA auth, public
  TO anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role()
  TO anon, authenticated, service_role, authenticator;
GRANT SELECT ON public.post_bookmarks TO authenticated;
SQL

ACTOR='11111111-1111-4111-8111-111111111111'
OTHER_ACTOR='22222222-2222-4222-8222-222222222222'
INACTIVE_ACTOR='33333333-3333-4333-8333-333333333333'
FOLDER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
DEFAULT_FOLDER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
OTHER_FOLDER='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
OTHER_ACTOR_FOLDER='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
POST_ONE='10000000-0000-4000-8000-000000000001'
POST_TWO='10000000-0000-4000-8000-000000000002'
POST_THREE='10000000-0000-4000-8000-000000000003'
POST_FOUR='10000000-0000-4000-8000-000000000004'
BOOKMARK_ONE='20000000-0000-4000-8000-000000000001'
BOOKMARK_TWO='20000000-0000-4000-8000-000000000002'
BOOKMARK_THREE='20000000-0000-4000-8000-000000000003'
BOOKMARK_FOUR='20000000-0000-4000-8000-000000000004'
STALE_BOOKMARK='29999999-9999-4999-8999-999999999999'

psql_cmd -q <<SQL
INSERT INTO public.user_profiles (
  id, deleted_at, banned_at, is_banned, ban_expires_at
) VALUES
  ('$ACTOR', NULL, NULL, false, NULL),
  ('$OTHER_ACTOR', NULL, NULL, false, NULL),
  ('$INACTIVE_ACTOR', NULL, NULL, true, NULL);
INSERT INTO public.posts (id, bookmark_count) VALUES
  ('$POST_ONE', 99),
  ('$POST_TWO', 99),
  ('$POST_THREE', 99),
  ('$POST_FOUR', 99);
INSERT INTO public.bookmark_folders (id, user_id, is_default) VALUES
  ('$FOLDER', '$ACTOR', false),
  ('$DEFAULT_FOLDER', '$ACTOR', true),
  ('$OTHER_FOLDER', '$ACTOR', false),
  ('$OTHER_ACTOR_FOLDER', '$OTHER_ACTOR', false);
INSERT INTO public.post_bookmarks (id, post_id, user_id, folder_id) VALUES
  ('$BOOKMARK_ONE', '$POST_ONE', '$ACTOR', '$FOLDER'),
  ('$BOOKMARK_TWO', '$POST_TWO', '$ACTOR', NULL),
  ('$BOOKMARK_THREE', '$POST_THREE', '$ACTOR', '$OTHER_FOLDER'),
  ('$BOOKMARK_FOUR', '$POST_FOUR', '$ACTOR', '$FOLDER');
SQL

psql_cmd -q -f "$MIGRATION"
psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
DO $proof$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
    'authenticated',
    'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)',
    'EXECUTE'
  )
    OR pg_catalog.has_function_privilege(
      'anon',
      'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'bookmark post removal privilege boundary failed';
  END IF;
END
$proof$;
SQL

expect_failure \
  'anonymous removal authority' \
  "SET ROLE anon;
   SET request.jwt.claim.role = 'anon';
   SELECT public.remove_post_bookmark_from_folder_atomic(
     '$POST_ONE', '$BOOKMARK_ONE', '$FOLDER'
   );"

expect_failure \
  'service removal authority' \
  "SET ROLE service_role;
   SET request.jwt.claim.role = 'service_role';
   SELECT public.remove_post_bookmark_from_folder_atomic(
     '$POST_ONE', '$BOOKMARK_ONE', '$FOLDER'
   );"

expect_value \
  'invalid removal' \
  'invalid' \
  "$(authenticated_query "$ACTOR" "
    SELECT public.remove_post_bookmark_from_folder_atomic(
      NULL, '$BOOKMARK_ONE', '$FOLDER'
    )->>'status';
  ")"

expect_value \
  'inactive actor removal' \
  'account_inactive' \
  "$(authenticated_query "$INACTIVE_ACTOR" "
    SELECT public.remove_post_bookmark_from_folder_atomic(
      '$POST_ONE', '$BOOKMARK_ONE', '$FOLDER'
    )->>'status';
  ")"

expect_value \
  'cross-actor folder rejection' \
  'folder_not_found' \
  "$(authenticated_query "$OTHER_ACTOR" "
    SELECT public.remove_post_bookmark_from_folder_atomic(
      '$POST_ONE', '$BOOKMARK_ONE', '$FOLDER'
    )->>'status';
  ")"

expect_value \
  'exact removal acknowledgement' \
  "removed|$ACTOR|$POST_ONE|$BOOKMARK_ONE|$FOLDER|false|0" \
  "$(authenticated_query "$ACTOR" "
    SELECT
      (result->>'status') || '|' ||
      (result->>'user_id') || '|' ||
      (result->>'post_id') || '|' ||
      (result->>'bookmark_id') || '|' ||
      (result->>'folder_id') || '|' ||
      (result->>'bookmarked') || '|' ||
      (result->>'bookmark_count')
    FROM (
      SELECT public.remove_post_bookmark_from_folder_atomic(
        '$POST_ONE', '$BOOKMARK_ONE', '$FOLDER'
      ) AS result
    ) AS mutation;
  ")"

expect_value \
  'exact removal persisted' \
  '0|0' \
  "$(psql_cmd -qAtc "
    SELECT
      (SELECT pg_catalog.count(*) FROM public.post_bookmarks
       WHERE post_id = '$POST_ONE')::text || '|' ||
      (SELECT bookmark_count FROM public.posts WHERE id = '$POST_ONE')::text;
  ")"

expect_value \
  'idempotent removal without re-add' \
  'already_removed|false|0|0' \
  "$(authenticated_query "$ACTOR" "
    SELECT
      (result->>'status') || '|' ||
      (result->>'bookmarked') || '|' ||
      (result->>'bookmark_count') || '|' ||
      (SELECT pg_catalog.count(*) FROM public.post_bookmarks
       WHERE post_id = '$POST_ONE')::text
    FROM (
      SELECT public.remove_post_bookmark_from_folder_atomic(
        '$POST_ONE', '$BOOKMARK_ONE', '$FOLDER'
      ) AS result
    ) AS mutation;
  ")"

expect_value \
  'legacy default NULL removal' \
  'removed|0' \
  "$(authenticated_query "$ACTOR" "
    SELECT
      (result->>'status') || '|' ||
      (result->>'bookmark_count')
    FROM (
      SELECT public.remove_post_bookmark_from_folder_atomic(
        '$POST_TWO', '$BOOKMARK_TWO', '$DEFAULT_FOLDER'
      ) AS result
    ) AS mutation;
  ")"

expect_value \
  'moved bookmark conflict' \
  'conflict|1' \
  "$(authenticated_query "$ACTOR" "
    SELECT
      (result->>'status') || '|' ||
      (SELECT pg_catalog.count(*) FROM public.post_bookmarks
       WHERE id = '$BOOKMARK_THREE')::text
    FROM (
      SELECT public.remove_post_bookmark_from_folder_atomic(
        '$POST_THREE', '$BOOKMARK_THREE', '$FOLDER'
      ) AS result
    ) AS mutation;
  ")"

expect_value \
  're-added bookmark identity conflict' \
  'conflict|1' \
  "$(authenticated_query "$ACTOR" "
    SELECT
      (result->>'status') || '|' ||
      (SELECT pg_catalog.count(*) FROM public.post_bookmarks
       WHERE id = '$BOOKMARK_FOUR')::text
    FROM (
      SELECT public.remove_post_bookmark_from_folder_atomic(
        '$POST_FOUR', '$STALE_BOOKMARK', '$FOLDER'
      ) AS result
    ) AS mutation;
  ")"

echo "atomic bookmark post removal PostgreSQL 17 proof passed"
