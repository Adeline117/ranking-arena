#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for folder create/update/delete/default
# lifecycle authority. It owns an isolated cluster and applies the real
# prerequisite migrations in release order.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BARRIER="$ROOT_DIR/supabase/migrations/20260729154500_inactive_auth_subject_mutation_barrier.sql"
FOUNDATION="$ROOT_DIR/supabase/migrations/20260729172750_bookmark_folders_foundation.sql"
SUBSCRIPTIONS="$ROOT_DIR/supabase/migrations/20260729173000_atomic_bookmark_folder_subscription.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729174000_atomic_bookmark_folder_lifecycle.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-folder-lifecycle-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
FAILURE_LOG="$TMP_ROOT/expected-failure.log"
CREATE_ONE_LOG="$TMP_ROOT/create-one.log"
CREATE_TWO_LOG="$TMP_ROOT/create-two.log"
PORT="$(( 55000 + RANDOM % 5000 ))"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    for diagnostic in \
      "$FAILURE_LOG" "$CREATE_ONE_LOG" "$CREATE_TWO_LOG" "$LOG_FILE"; do
      [[ -f "$diagnostic" ]] && tail -240 "$diagnostic" >&2 || true
    done
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

CREATE TABLE auth.users (id uuid PRIMARY KEY);
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
  id, deleted_at, banned_at, is_banned, ban_expires_at
) VALUES
  ('11111111-1111-4111-8111-111111111111', NULL, NULL, false, NULL),
  ('22222222-2222-4222-8222-222222222222', NULL, NULL, false, NULL),
  ('33333333-3333-4333-8333-333333333333', NULL, NULL, true, NULL);
SQL

psql_cmd -q -f "$BARRIER"
psql_cmd -q -f "$FOUNDATION"
psql_cmd -q -f "$SUBSCRIPTIONS"
psql_cmd -q -f "$MIGRATION"
psql_cmd -q -f "$MIGRATION"

ACTOR='11111111-1111-4111-8111-111111111111'
OTHER='22222222-2222-4222-8222-222222222222'
INACTIVE='33333333-3333-4333-8333-333333333333'
MISSING='99999999-9999-4999-8999-999999999999'

psql_cmd -q <<'SQL'
DO $proof$
BEGIN
  IF pg_catalog.has_table_privilege(
    'authenticated',
    'public.bookmark_folders',
    'INSERT,UPDATE,DELETE'
  )
    OR pg_catalog.has_table_privilege(
      'service_role',
      'public.bookmark_folders',
      'INSERT,UPDATE,DELETE'
    )
    OR NOT pg_catalog.has_table_privilege(
      'authenticated',
      'public.bookmark_folders',
      'SELECT'
    )
    OR NOT pg_catalog.has_function_privilege(
      'authenticated',
      'public.mutate_bookmark_folder_atomic(text,uuid,text,text,text,boolean,boolean,boolean,boolean,boolean)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'anon',
      'public.mutate_bookmark_folder_atomic(text,uuid,text,text,text,boolean,boolean,boolean,boolean,boolean)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.mutate_bookmark_folder_atomic(text,uuid,text,text,text,boolean,boolean,boolean,boolean,boolean)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      'public.read_bookmark_folder_mutation_payload(uuid)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'bookmark folder lifecycle privilege boundary failed';
  END IF;
END
$proof$;
SQL

expect_failure \
  'authenticated direct folder insert' \
  "SET ROLE authenticated;
   SET request.jwt.claim.role = 'authenticated';
   SET request.jwt.claim.sub = '$ACTOR';
   INSERT INTO public.bookmark_folders (user_id, name)
   VALUES ('$ACTOR', 'Bypass');"
expect_failure \
  'service direct folder delete' \
  "SET ROLE service_role;
   DELETE FROM public.bookmark_folders WHERE user_id = '$ACTOR';"

CREATE_RESULT="$(authenticated_query "$ACTOR" "
  SELECT public.mutate_bookmark_folder_atomic(
    'create', NULL, 'Research', 'Initial notes', NULL, true,
    true, true, true, true
  );
")"
FOLDER_ID="$(psql_cmd -qAtc "SELECT '$CREATE_RESULT'::jsonb->'folder'->>'id';")"
expect_value \
  'exact create acknowledgement' \
  "created|$ACTOR|Research|Initial notes|true|false|0|0" \
  "$(psql_cmd -qAtc "
    SELECT
      (result->>'status') || '|' ||
      (result->>'user_id') || '|' ||
      (result->'folder'->>'name') || '|' ||
      (result->'folder'->>'description') || '|' ||
      (result->'folder'->>'is_public') || '|' ||
      (result->'folder'->>'is_default') || '|' ||
      (result->'folder'->>'post_count') || '|' ||
      (result->'folder'->>'subscriber_count')
    FROM (SELECT '$CREATE_RESULT'::jsonb AS result) AS mutation;
  ")"

expect_value \
  'duplicate create' \
  'name_conflict' \
  "$(authenticated_query "$ACTOR" "
    SELECT public.mutate_bookmark_folder_atomic(
      'create', NULL, 'Research', NULL, NULL, false,
      true, true, true, true
    )->>'status';
  ")"
expect_value \
  'inactive create' \
  'account_inactive' \
  "$(authenticated_query "$INACTIVE" "
    SELECT public.mutate_bookmark_folder_atomic(
      'create', NULL, 'Inactive', NULL, NULL, false,
      true, true, true, true
    )->>'status';
  ")"
expect_value \
  'ambiguous omitted field rejection' \
  'invalid' \
  "$(authenticated_query "$ACTOR" "
    SELECT public.mutate_bookmark_folder_atomic(
      'update', '$FOLDER_ID', NULL, 'hidden value', NULL, NULL,
      false, false, false, false
    )->>'status';
  ")"

expect_value \
  'partial update' \
  'updated|Research|Updated notes|true' \
  "$(authenticated_query "$ACTOR" "
    SELECT
      (result->>'status') || '|' ||
      (result->'folder'->>'name') || '|' ||
      (result->'folder'->>'description') || '|' ||
      (result->'folder'->>'is_public')
    FROM (
      SELECT public.mutate_bookmark_folder_atomic(
        'update', '$FOLDER_ID', NULL, 'Updated notes', NULL, NULL,
        false, true, false, false
      ) AS result
    ) AS mutation;
  ")"
expect_value \
  'explicit description clear' \
  'updated|true' \
  "$(authenticated_query "$ACTOR" "
    SELECT
      (result->>'status') || '|' ||
      ((result->'folder'->'description') = 'null'::jsonb)::text
    FROM (
      SELECT public.mutate_bookmark_folder_atomic(
        'update', '$FOLDER_ID', NULL, NULL, NULL, NULL,
        false, true, false, false
      ) AS result
    ) AS mutation;
  ")"
expect_value \
  'foreign owner update' \
  'folder_forbidden' \
  "$(authenticated_query "$OTHER" "
    SELECT public.mutate_bookmark_folder_atomic(
      'update', '$FOLDER_ID', 'Stolen', NULL, NULL, NULL,
      true, false, false, false
    )->>'status';
  ")"
expect_value \
  'missing update' \
  'folder_not_found' \
  "$(authenticated_query "$ACTOR" "
    SELECT public.mutate_bookmark_folder_atomic(
      'update', '$MISSING', 'Missing', NULL, NULL, NULL,
      true, false, false, false
    )->>'status';
  ")"

# ensure_default remains the sole authenticated default creator after table
# writes are revoked, and the lifecycle authority protects that row.
DEFAULT_ID="$(authenticated_query "$ACTOR" "
  SELECT public.ensure_default_bookmark_folder('$ACTOR');
")"
expect_value \
  'default rename protection' \
  'default_protected' \
  "$(authenticated_query "$ACTOR" "
    SELECT public.mutate_bookmark_folder_atomic(
      'update', '$DEFAULT_ID', 'Renamed default', NULL, NULL, NULL,
      true, false, false, false
    )->>'status';
  ")"
expect_value \
  'default same-name metadata update' \
  'updated|true' \
  "$(authenticated_query "$ACTOR" "
    SELECT
      (result->>'status') || '|' || (result->'folder'->>'is_public')
    FROM (
      SELECT public.mutate_bookmark_folder_atomic(
        'update', '$DEFAULT_ID', 'Default', NULL, NULL, true,
        true, false, false, true
      ) AS result
    ) AS mutation;
  ")"
expect_value \
  'default delete protection' \
  'default_protected' \
  "$(authenticated_query "$ACTOR" "
    SELECT public.mutate_bookmark_folder_atomic(
      'delete', '$DEFAULT_ID', NULL, NULL, NULL, NULL,
      false, false, false, false
    )->>'status';
  ")"

# Add exact child state, then make the folder private. The 173000 trigger must
# purge subscriptions before the lifecycle acknowledgement counts them.
authenticated_query "$OTHER" "
  SELECT public.mutate_bookmark_folder_subscription_atomic(
    '$FOLDER_ID', 'add'
  );
" >/dev/null
psql_cmd -qAtc "
  INSERT INTO public.post_bookmarks (post_id, user_id, folder_id)
  VALUES (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '$ACTOR',
    '$FOLDER_ID'
  );
" >/dev/null
expect_value \
  'privacy update exact child counts' \
  'updated|false|1|0' \
  "$(authenticated_query "$ACTOR" "
    SELECT
      (result->>'status') || '|' ||
      (result->'folder'->>'is_public') || '|' ||
      (result->'folder'->>'post_count') || '|' ||
      (result->'folder'->>'subscriber_count')
    FROM (
      SELECT public.mutate_bookmark_folder_atomic(
        'update', '$FOLDER_ID', NULL, NULL, NULL, false,
        false, false, false, true
      ) AS result
    ) AS mutation;
  ")"

expect_value \
  'delete acknowledgement' \
  "deleted|$ACTOR|$FOLDER_ID" \
  "$(authenticated_query "$ACTOR" "
    SELECT
      (result->>'status') || '|' ||
      (result->>'user_id') || '|' ||
      (result->>'folder_id')
    FROM (
      SELECT public.mutate_bookmark_folder_atomic(
        'delete', '$FOLDER_ID', NULL, NULL, NULL, NULL,
        false, false, false, false
      ) AS result
    ) AS mutation;
  ")"
expect_value \
  'delete child cascade' \
  '0|0' \
  "$(psql_cmd -qAtc "
    SELECT
      (SELECT pg_catalog.count(*) FROM public.post_bookmarks
       WHERE folder_id = '$FOLDER_ID')::text || '|' ||
      (SELECT pg_catalog.count(*) FROM public.folder_subscriptions
       WHERE folder_id = '$FOLDER_ID')::text;
  ")"

# Two same-owner/same-name creates race. The account lifecycle key serializes
# them and exact uniqueness yields one created plus one deterministic conflict.
RACE_SQL="
  SELECT public.mutate_bookmark_folder_atomic(
    'create', NULL, 'Concurrent', NULL, NULL, false,
    true, true, true, true
  )->>'status';
"
(authenticated_query "$ACTOR" "$RACE_SQL") >"$CREATE_ONE_LOG" 2>&1 &
create_one_pid=$!
(authenticated_query "$ACTOR" "$RACE_SQL") >"$CREATE_TWO_LOG" 2>&1 &
create_two_pid=$!
wait "$create_one_pid"
wait "$create_two_pid"
expect_value \
  'concurrent same-name create statuses' \
  $'created\nname_conflict' \
  "$(sort "$CREATE_ONE_LOG" "$CREATE_TWO_LOG")"
expect_value \
  'concurrent same-name row count' \
  '1' \
  "$(psql_cmd -qAtc "
    SELECT pg_catalog.count(*)
    FROM public.bookmark_folders
    WHERE user_id = '$ACTOR' AND name = 'Concurrent';
  ")"

echo "atomic bookmark folder lifecycle PostgreSQL 17 proof passed"
