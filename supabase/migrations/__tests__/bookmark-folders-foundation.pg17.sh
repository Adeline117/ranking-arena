#!/usr/bin/env bash

# Executable PostgreSQL 17 replay for the previously phantom bookmark_folders
# parent. It owns an isolated temporary cluster and never connects to a
# developer or remote database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BARRIER="$ROOT_DIR/supabase/migrations/20260729154500_inactive_auth_subject_mutation_barrier.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729172750_bookmark_folders_foundation.sql"
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

TMP_ROOT="$(mktemp -d /tmp/bookmark-folders-foundation-pg17.XXXXXX)"
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

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean,
  ban_expires_at timestamptz
);
CREATE TABLE public.post_bookmarks (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  post_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id uuid,
  created_at timestamptz DEFAULT pg_catalog.now(),
  UNIQUE (post_id, user_id)
);
CREATE TABLE public.folder_subscriptions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (user_id, folder_id)
);

ALTER TABLE auth.users OWNER TO postgres;
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.post_bookmarks OWNER TO postgres;
ALTER TABLE public.folder_subscriptions OWNER TO postgres;

GRANT USAGE ON SCHEMA auth, public
  TO anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role()
  TO anon, authenticated, service_role, authenticator;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.post_bookmarks
  TO authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.folder_subscriptions
  TO authenticated, service_role;

INSERT INTO auth.users (id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
INSERT INTO public.user_profiles (
  id,
  deleted_at,
  banned_at,
  is_banned,
  ban_expires_at
) VALUES
  ('11111111-1111-4111-8111-111111111111', NULL, NULL, false, NULL),
  ('22222222-2222-4222-8222-222222222222', NULL, NULL, false, NULL),
  ('33333333-3333-4333-8333-333333333333', NULL, NULL, true, NULL);

-- Reproduce child rows left behind while the parent and both FKs were absent.
INSERT INTO public.post_bookmarks (post_id, user_id, folder_id) VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  '11111111-1111-4111-8111-111111111111',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
);
INSERT INTO public.folder_subscriptions (user_id, folder_id) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
);
SQL

# Real deployment order: the global stale-JWT write barrier existed before the
# missing parent was restored. The foundation must reinstall it for the new row.
psql_cmd -q -f "$BARRIER"
psql_cmd -q -f "$MIGRATION"
psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
DO $proof$
DECLARE
  v_required_columns integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO v_required_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.bookmark_folders'::pg_catalog.regclass
    AND attribute.attname = ANY(ARRAY[
      'id',
      'user_id',
      'name',
      'description',
      'avatar_url',
      'is_public',
      'is_default',
      'post_count',
      'created_at',
      'updated_at'
    ])
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_required_columns <> 10
    OR NOT pg_catalog.has_table_privilege(
      'anon',
      'public.bookmark_folders',
      'SELECT'
    )
    OR pg_catalog.has_table_privilege(
      'anon',
      'public.bookmark_folders',
      'INSERT,UPDATE,DELETE'
    )
    OR NOT pg_catalog.has_table_privilege(
      'authenticated',
      'public.bookmark_folders',
      'SELECT,INSERT,UPDATE,DELETE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'authenticated',
      'public.ensure_default_bookmark_folder(uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'anon',
      'public.ensure_default_bookmark_folder(uuid)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.ensure_default_bookmark_folder(uuid)',
      'EXECUTE'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid =
          'public.bookmark_folders'::pg_catalog.regclass
        AND trigger_row.tgname =
          '000_active_authenticated_subject_statement_guard'
        AND NOT trigger_row.tgisinternal
    )
  THEN
    RAISE EXCEPTION 'bookmark folder foundation or privilege boundary failed';
  END IF;

  IF (
    SELECT bookmark.folder_id IS NOT NULL
    FROM public.post_bookmarks AS bookmark
    WHERE bookmark.post_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) OR EXISTS (
    SELECT 1 FROM public.folder_subscriptions
  ) THEN
    RAISE EXCEPTION 'orphan child repair failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.confrelid =
        'public.bookmark_folders'::pg_catalog.regclass
      AND constraint_row.conrelid IN (
        'public.post_bookmarks'::pg_catalog.regclass,
        'public.folder_subscriptions'::pg_catalog.regclass
      )
      AND constraint_row.contype = 'f'
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.convalidated
  ) <> 2 THEN
    RAISE EXCEPTION 'bookmark folder child cascade contract failed';
  END IF;
END
$proof$;
SQL

ACTOR_ONE='11111111-1111-4111-8111-111111111111'
ACTOR_TWO='22222222-2222-4222-8222-222222222222'
INACTIVE_ACTOR='33333333-3333-4333-8333-333333333333'

DEFAULT_ONE="$(authenticated_query "$ACTOR_ONE" "
  SELECT public.ensure_default_bookmark_folder('$ACTOR_ONE');
")"
expect_value \
  'idempotent default authority' \
  "$DEFAULT_ONE" \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT public.ensure_default_bookmark_folder('$ACTOR_ONE');
  ")"

# A pre-existing custom folder called Default is promoted instead of causing a
# permanent owner/name conflict.
CUSTOM_DEFAULT='44444444-4444-4444-8444-444444444444'
authenticated_query "$ACTOR_TWO" "
  INSERT INTO public.bookmark_folders (
    id, user_id, name, is_public, is_default
  ) VALUES (
    '$CUSTOM_DEFAULT', '$ACTOR_TWO', 'Default', true, false
  );
" >/dev/null
expect_value \
  'existing Default authority id' \
  "$CUSTOM_DEFAULT" \
  "$(authenticated_query "$ACTOR_TWO" "
    SELECT public.ensure_default_bookmark_folder('$ACTOR_TWO');
  ")"
expect_value \
  'existing Default promotion' \
  "$CUSTOM_DEFAULT|true|false" \
  "$(authenticated_query "$ACTOR_TWO" "
    SELECT folder.id::text || '|' || folder.is_default::text || '|' ||
      folder.is_public::text
    FROM public.bookmark_folders AS folder
    WHERE folder.id = '$CUSTOM_DEFAULT';
  ")"

expect_failure \
  'cross-account default authority' \
  "SET ROLE authenticated;
   SET request.jwt.claim.role = 'authenticated';
   SET request.jwt.claim.sub = '$ACTOR_ONE';
   SELECT public.ensure_default_bookmark_folder('$ACTOR_TWO');"

expect_failure \
  'inactive default authority' \
  "SET ROLE authenticated;
   SET request.jwt.claim.role = 'authenticated';
   SET request.jwt.claim.sub = '$INACTIVE_ACTOR';
   SELECT public.ensure_default_bookmark_folder('$INACTIVE_ACTOR');"

expect_failure \
  'cross-owner direct insert' \
  "SET ROLE authenticated;
   SET request.jwt.claim.role = 'authenticated';
   SET request.jwt.claim.sub = '$ACTOR_ONE';
   INSERT INTO public.bookmark_folders (user_id, name)
   VALUES ('$ACTOR_TWO', 'Bypass');"

expect_failure \
  'second default' \
  "SET ROLE authenticated;
   SET request.jwt.claim.role = 'authenticated';
   SET request.jwt.claim.sub = '$ACTOR_ONE';
   INSERT INTO public.bookmark_folders (user_id, name, is_default)
   VALUES ('$ACTOR_ONE', 'Second default', true);"

authenticated_query "$ACTOR_ONE" "
  INSERT INTO public.bookmark_folders (
    user_id, name, is_public, is_default
  ) VALUES (
    '$ACTOR_ONE', 'Public evidence', true, false
  );
" >/dev/null

expect_value \
  'anonymous public visibility' \
  '1' \
  "$(psql_cmd -qAtc "
    SET ROLE anon;
    SELECT pg_catalog.count(*)
    FROM public.bookmark_folders;
  ")"

# Both child relations must actually cascade when a non-default parent leaves.
CASCADE_FOLDER='55555555-5555-4555-8555-555555555555'
psql_cmd -q <<SQL
INSERT INTO public.bookmark_folders (
  id, user_id, name, is_public, is_default
) VALUES (
  '$CASCADE_FOLDER', '$ACTOR_TWO', 'Cascade parent', true, false
);
INSERT INTO public.post_bookmarks (post_id, user_id, folder_id) VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '$ACTOR_TWO', '$CASCADE_FOLDER'
);
INSERT INTO public.folder_subscriptions (user_id, folder_id) VALUES (
  '$ACTOR_ONE', '$CASCADE_FOLDER'
);
DELETE FROM public.bookmark_folders WHERE id = '$CASCADE_FOLDER';
SQL
expect_value \
  'child cascade execution' \
  '0|0' \
  "$(psql_cmd -qAtc "
    SELECT
      (SELECT pg_catalog.count(*) FROM public.post_bookmarks
       WHERE folder_id = '$CASCADE_FOLDER')::text || '|' ||
      (SELECT pg_catalog.count(*) FROM public.folder_subscriptions
       WHERE folder_id = '$CASCADE_FOLDER')::text;
  ")"

echo "bookmark folders foundation PostgreSQL 17 proof passed"
