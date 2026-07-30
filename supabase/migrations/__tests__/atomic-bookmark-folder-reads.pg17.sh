#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for stable bookmark-folder read snapshots.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729175000_atomic_bookmark_folder_reads.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-folder-reads-pg17.XXXXXX)"
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

service_query() {
  local sql="$1"
  psql_cmd -qAtc "
    SET ROLE service_role;
    SET request.jwt.claim.role = 'service_role';
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
ALTER FUNCTION auth.role() OWNER TO postgres;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  handle text,
  avatar_url text,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean,
  ban_expires_at timestamptz
);
CREATE TABLE public.bookmark_folders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  avatar_url text,
  is_public boolean,
  is_default boolean,
  post_count integer,
  created_at timestamptz,
  updated_at timestamptz
);
CREATE TABLE public.folder_subscriptions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  folder_id uuid NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  content text,
  author_id uuid NOT NULL,
  author_handle text,
  group_id uuid,
  like_count integer,
  comment_count integer,
  bookmark_count integer,
  created_at timestamptz NOT NULL,
  visibility text NOT NULL
);
CREATE TABLE public.post_bookmarks (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  folder_id uuid,
  created_at timestamptz
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.bookmark_folders OWNER TO postgres;
ALTER TABLE public.folder_subscriptions OWNER TO postgres;
ALTER TABLE public.posts OWNER TO postgres;
ALTER TABLE public.post_bookmarks OWNER TO postgres;

CREATE FUNCTION public.can_actor_read_post_id(
  p_post_id uuid,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.posts AS post
    WHERE post.id = p_post_id
      AND (
        post.visibility = 'public'
        OR post.author_id = p_actor_id
      )
  )
$function$;
ALTER FUNCTION public.can_actor_read_post_id(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_actor_read_post_id(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT USAGE ON SCHEMA auth, public
  TO anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION auth.role()
  TO anon, authenticated, service_role, authenticator;

INSERT INTO public.user_profiles (
  id, handle, avatar_url, deleted_at, banned_at, is_banned, ban_expires_at
) VALUES
  ('11111111-1111-4111-8111-111111111111', 'owner', 'owner.png', NULL, NULL, false, NULL),
  ('22222222-2222-4222-8222-222222222222', 'viewer', NULL, NULL, NULL, false, NULL),
  ('33333333-3333-4333-8333-333333333333', 'inactive', NULL, NULL, NULL, true, NULL);

INSERT INTO public.bookmark_folders (
  id, user_id, name, description, avatar_url, is_public, is_default,
  post_count, created_at, updated_at
) VALUES
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '11111111-1111-4111-8111-111111111111',
    'Public', NULL, NULL, true, false, 999,
    '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z'
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    '11111111-1111-4111-8111-111111111111',
    'Private', NULL, NULL, false, false, 999,
    '2026-07-28T00:00:00Z', '2026-07-28T00:00:00Z'
  ),
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    '11111111-1111-4111-8111-111111111111',
    'Default', NULL, NULL, false, true, 999,
    '2026-07-27T00:00:00Z', '2026-07-27T00:00:00Z'
  );

INSERT INTO public.posts (
  id, title, content, author_id, author_handle, group_id,
  like_count, comment_count, bookmark_count, created_at, visibility
) VALUES
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'Public post', 'visible',
    '11111111-1111-4111-8111-111111111111', 'owner', NULL,
    1, 2, 3, '2026-07-29T03:00:00Z', 'public'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'Private post', 'owner only',
    '11111111-1111-4111-8111-111111111111', 'owner', NULL,
    4, 5, 6, '2026-07-29T02:00:00Z', 'private'
  ),
  (
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3', 'Default post', 'legacy null folder',
    '11111111-1111-4111-8111-111111111111', 'owner', NULL,
    7, 8, 9, '2026-07-29T01:00:00Z', 'public'
  );

INSERT INTO public.post_bookmarks (
  id, post_id, user_id, folder_id, created_at
) VALUES
  (
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '2026-07-29T03:00:00Z'
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc2',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    '2026-07-29T02:00:00Z'
  ),
  (
    'cccccccc-cccc-4ccc-8ccc-ccccccccccc3',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
    '11111111-1111-4111-8111-111111111111',
    NULL,
    '2026-07-29T01:00:00Z'
  );

INSERT INTO public.folder_subscriptions (id, user_id, folder_id, created_at)
VALUES (
  'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
  '22222222-2222-4222-8222-222222222222',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  '2026-07-29T04:00:00Z'
);
SQL

psql_cmd -q -f "$MIGRATION"
psql_cmd -q -f "$MIGRATION"

OWNER='11111111-1111-4111-8111-111111111111'
VIEWER='22222222-2222-4222-8222-222222222222'
INACTIVE='33333333-3333-4333-8333-333333333333'
PUBLIC_FOLDER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
PRIVATE_FOLDER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'

psql_cmd -q <<'SQL'
DO $privileges$
BEGIN
  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.read_bookmark_folder_detail_snapshot(uuid,uuid,integer,integer)',
    'EXECUTE'
  )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      'public.read_bookmark_folder_detail_snapshot(uuid,uuid,integer,integer)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'anon',
      'public.read_owned_bookmark_folders_snapshot(uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.read_bookmark_folder_snapshot_payload(uuid,uuid)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'bookmark folder read privilege boundary failed';
  END IF;
END
$privileges$;
SQL

expect_failure \
  'authenticated snapshot execution' \
  "SET ROLE authenticated;
   SET request.jwt.claim.role = 'authenticated';
   SELECT public.read_owned_bookmark_folders_snapshot('$OWNER');"

expect_value \
  'owned counts ignore stale column and include legacy default rows' \
  'ok|2|1' \
  "$(service_query "
    SELECT
      (result->>'status') || '|' ||
      (SELECT folder->>'post_count'
       FROM pg_catalog.jsonb_array_elements(result->'folders') AS folder
       WHERE folder->>'id' = '$PUBLIC_FOLDER') || '|' ||
      (SELECT folder->>'post_count'
       FROM pg_catalog.jsonb_array_elements(result->'folders') AS folder
       WHERE folder->>'is_default' = 'true')
    FROM (
      SELECT public.read_owned_bookmark_folders_snapshot('$OWNER') AS result
    ) AS snapshot;
  ")"

expect_value \
  'public profile hides private folders and unreadable post counts' \
  'ok|1|1' \
  "$(service_query "
    SELECT
      (result->>'status') || '|' ||
      pg_catalog.jsonb_array_length(result->'folders') || '|' ||
      (result->'folders'->0->>'post_count')
    FROM (
      SELECT public.read_profile_bookmark_folders_snapshot(
        NULL, '$OWNER', false
      ) AS result
    ) AS snapshot;
  ")"

expect_value \
  'forged private profile scope' \
  'invalid' \
  "$(service_query "
    SELECT public.read_profile_bookmark_folders_snapshot(
      '$VIEWER', '$OWNER', true
    )->>'status';
  ")"

expect_value \
  'subscribed page snapshot' \
  'ok|1|1|owner|false' \
  "$(service_query "
    SELECT
      (result->>'status') || '|' ||
      pg_catalog.jsonb_array_length(result->'folders') || '|' ||
      (result->'folders'->0->>'post_count') || '|' ||
      (result->'folders'->0->>'owner_handle') || '|' ||
      (result->'pagination'->>'has_more')
    FROM (
      SELECT public.read_subscribed_bookmark_folders_snapshot(
        '$VIEWER', 1, 0
      ) AS result
    ) AS snapshot;
  ")"

expect_value \
  'anonymous detail filters audience before pagination' \
  'ok|1|1|false|Public post' \
  "$(service_query "
    SELECT
      (result->>'status') || '|' ||
      (result->'folder'->>'post_count') || '|' ||
      pg_catalog.jsonb_array_length(result->'posts') || '|' ||
      (result->'pagination'->>'has_more') || '|' ||
      (result->'posts'->0->>'title')
    FROM (
      SELECT public.read_bookmark_folder_detail_snapshot(
        NULL, '$PUBLIC_FOLDER', 1, 0
      ) AS result
    ) AS snapshot;
  ")"

expect_value \
  'owner detail lookahead' \
  'ok|2|1|true|true|false' \
  "$(service_query "
    SELECT
      (result->>'status') || '|' ||
      (result->'folder'->>'post_count') || '|' ||
      pg_catalog.jsonb_array_length(result->'posts') || '|' ||
      (result->'pagination'->>'has_more') || '|' ||
      (result->>'is_owner') || '|' ||
      (result->>'is_subscribed')
    FROM (
      SELECT public.read_bookmark_folder_detail_snapshot(
        '$OWNER', '$PUBLIC_FOLDER', 1, 0
      ) AS result
    ) AS snapshot;
  ")"

expect_value \
  'private folder boundary' \
  'folder_forbidden' \
  "$(service_query "
    SELECT public.read_bookmark_folder_detail_snapshot(
      '$VIEWER', '$PRIVATE_FOLDER', 20, 0
    )->>'status';
  ")"

expect_value \
  'inactive actor boundary' \
  'actor_inactive' \
  "$(service_query "
    SELECT public.read_bookmark_folder_detail_snapshot(
      '$INACTIVE', '$PUBLIC_FOLDER', 20, 0
    )->>'status';
  ")"

psql_cmd -qAtc "
  UPDATE public.user_profiles
  SET banned_at = pg_catalog.now()
  WHERE id = '$OWNER';
" >/dev/null
expect_value \
  'inactive owner resource boundary' \
  'folder_not_found' \
  "$(service_query "
    SELECT public.read_bookmark_folder_detail_snapshot(
      '$VIEWER', '$PUBLIC_FOLDER', 20, 0
    )->>'status';
  ")"

echo "atomic bookmark folder read snapshots PostgreSQL 17 proof passed"
