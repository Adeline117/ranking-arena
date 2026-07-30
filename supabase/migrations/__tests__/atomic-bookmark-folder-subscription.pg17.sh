#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for subscription privacy, idempotency, exact
# counts, direct-write revocation, and both orderings of the add/privacy race.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BARRIER="$ROOT_DIR/supabase/migrations/20260729154500_inactive_auth_subject_mutation_barrier.sql"
FOUNDATION="$ROOT_DIR/supabase/migrations/20260729172750_bookmark_folders_foundation.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729173000_atomic_bookmark_folder_subscription.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-folder-subscription-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
FAILURE_LOG="$TMP_ROOT/expected-failure.log"
ADD_FIRST_LOG="$TMP_ROOT/add-first.log"
PRIVATE_FIRST_LOG="$TMP_ROOT/private-first.log"
PORT="$(( 55000 + RANDOM % 5000 ))"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    for diagnostic in \
      "$FAILURE_LOG" "$ADD_FIRST_LOG" "$PRIVATE_FIRST_LOG" "$LOG_FILE"; do
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

wait_for_signal_lock() {
  local lock_key="$1"
  local attempt
  local result
  for attempt in $(seq 1 200); do
    result="$(psql_cmd -qAtc "
      SELECT CASE
        WHEN pg_catalog.pg_try_advisory_lock($lock_key)
        THEN pg_catalog.pg_advisory_unlock($lock_key)::text
        ELSE 'ready'
      END;
    ")"
    if [[ "$result" == "ready" ]]; then
      return 0
    fi
    sleep 0.01
  done
  echo "race session never acquired signal lock $lock_key" >&2
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
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');
INSERT INTO public.user_profiles (
  id, deleted_at, banned_at, is_banned, ban_expires_at
) VALUES
  ('11111111-1111-4111-8111-111111111111', NULL, NULL, false, NULL),
  ('22222222-2222-4222-8222-222222222222', NULL, NULL, false, NULL),
  ('33333333-3333-4333-8333-333333333333', NULL, NULL, true, NULL),
  ('44444444-4444-4444-8444-444444444444', NULL, NULL, false, NULL);
SQL

psql_cmd -q -f "$BARRIER"
psql_cmd -q -f "$FOUNDATION"

ACTOR_ONE='11111111-1111-4111-8111-111111111111'
OWNER='22222222-2222-4222-8222-222222222222'
INACTIVE_ACTOR='33333333-3333-4333-8333-333333333333'
ACTOR_TWO='44444444-4444-4444-8444-444444444444'
PUBLIC_FOLDER='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
PRIVATE_FOLDER='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
OWN_FOLDER='cccccccc-cccc-4ccc-8ccc-cccccccccccc'
ADD_FIRST_FOLDER='dddddddd-dddd-4ddd-8ddd-dddddddddddd'
PRIVATE_FIRST_FOLDER='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
OWNER_CHANGE_FOLDER='ffffffff-ffff-4fff-8fff-ffffffffffff'
MISSING_FOLDER='99999999-9999-4999-8999-999999999999'

psql_cmd -q <<SQL
INSERT INTO public.bookmark_folders (
  id, user_id, name, is_public, is_default
) VALUES
  ('$PUBLIC_FOLDER', '$OWNER', 'Public', true, false),
  ('$PRIVATE_FOLDER', '$OWNER', 'Private', false, false),
  ('$OWN_FOLDER', '$ACTOR_ONE', 'Own', true, false),
  ('$ADD_FIRST_FOLDER', '$OWNER', 'Add first race', true, false),
  ('$PRIVATE_FIRST_FOLDER', '$OWNER', 'Privacy first race', true, false),
  ('$OWNER_CHANGE_FOLDER', '$OWNER', 'Owner change', true, false);

-- Reproduce rows admitted by the old user_id-only INSERT policy.
INSERT INTO public.folder_subscriptions (user_id, folder_id) VALUES
  ('$ACTOR_ONE', '$PRIVATE_FOLDER'),
  ('$ACTOR_ONE', '$OWN_FOLDER'),
  ('$ACTOR_TWO', '$OWNER_CHANGE_FOLDER');
SQL

psql_cmd -q -f "$MIGRATION"
psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
DO $proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.folder_subscriptions AS subscription
    JOIN public.bookmark_folders AS folder
      ON folder.id = subscription.folder_id
    WHERE folder.is_public IS DISTINCT FROM true
      OR folder.user_id = subscription.user_id
  )
    OR pg_catalog.has_table_privilege(
      'authenticated',
      'public.folder_subscriptions',
      'INSERT,UPDATE,DELETE'
    )
    OR pg_catalog.has_table_privilege(
      'service_role',
      'public.folder_subscriptions',
      'INSERT,UPDATE,DELETE'
    )
    OR NOT pg_catalog.has_table_privilege(
      'authenticated',
      'public.folder_subscriptions',
      'SELECT'
    )
    OR NOT pg_catalog.has_function_privilege(
      'authenticated',
      'public.mutate_bookmark_folder_subscription_atomic(uuid,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'anon',
      'public.mutate_bookmark_folder_subscription_atomic(uuid,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.mutate_bookmark_folder_subscription_atomic(uuid,text)',
      'EXECUTE'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid =
          'public.bookmark_folders'::pg_catalog.regclass
        AND trigger_row.tgname =
          'trg_bookmark_folders_80_purge_subscriptions'
        AND NOT trigger_row.tgisinternal
    )
  THEN
    RAISE EXCEPTION 'atomic folder subscription boundary failed';
  END IF;
END
$proof$;
SQL

expect_failure \
  'authenticated direct subscription insert' \
  "SET ROLE authenticated;
   SET request.jwt.claim.role = 'authenticated';
   SET request.jwt.claim.sub = '$ACTOR_ONE';
   INSERT INTO public.folder_subscriptions (user_id, folder_id)
   VALUES ('$ACTOR_ONE', '$PUBLIC_FOLDER');"

expect_failure \
  'service direct subscription insert' \
  "SET ROLE service_role;
   INSERT INTO public.folder_subscriptions (user_id, folder_id)
   VALUES ('$ACTOR_ONE', '$PUBLIC_FOLDER');"

expect_value \
  'invalid action' \
  'invalid' \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT public.mutate_bookmark_folder_subscription_atomic(
      '$PUBLIC_FOLDER', 'toggle'
    )->>'status';
  ")"
expect_value \
  'missing folder' \
  'folder_not_found' \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT public.mutate_bookmark_folder_subscription_atomic(
      '$MISSING_FOLDER', 'add'
    )->>'status';
  ")"
expect_value \
  'private folder' \
  'folder_private' \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT public.mutate_bookmark_folder_subscription_atomic(
      '$PRIVATE_FOLDER', 'add'
    )->>'status';
  ")"
expect_value \
  'own folder' \
  'owner_forbidden' \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT public.mutate_bookmark_folder_subscription_atomic(
      '$OWN_FOLDER', 'add'
    )->>'status';
  ")"
expect_value \
  'inactive account' \
  'account_inactive' \
  "$(authenticated_query "$INACTIVE_ACTOR" "
    SELECT public.mutate_bookmark_folder_subscription_atomic(
      '$PUBLIC_FOLDER', 'add'
    )->>'status';
  ")"

expect_value \
  'exact first add' \
  "added|true|1|$ACTOR_ONE|$PUBLIC_FOLDER" \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT
      (result->>'status') || '|' ||
      (result->>'is_subscribed') || '|' ||
      (result->>'subscriber_count') || '|' ||
      (result->>'user_id') || '|' ||
      (result->>'folder_id')
    FROM (
      SELECT public.mutate_bookmark_folder_subscription_atomic(
        '$PUBLIC_FOLDER', 'add'
      ) AS result
    ) AS mutation;
  ")"
expect_value \
  'idempotent add' \
  'already_subscribed|1' \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT (result->>'status') || '|' || (result->>'subscriber_count')
    FROM (
      SELECT public.mutate_bookmark_folder_subscription_atomic(
        '$PUBLIC_FOLDER', 'add'
      ) AS result
    ) AS mutation;
  ")"
expect_value \
  'second exact add' \
  'added|2' \
  "$(authenticated_query "$ACTOR_TWO" "
    SELECT (result->>'status') || '|' || (result->>'subscriber_count')
    FROM (
      SELECT public.mutate_bookmark_folder_subscription_atomic(
        '$PUBLIC_FOLDER', 'add'
      ) AS result
    ) AS mutation;
  ")"
expect_value \
  'exact remove' \
  'removed|false|1' \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT
      (result->>'status') || '|' ||
      (result->>'is_subscribed') || '|' ||
      (result->>'subscriber_count')
    FROM (
      SELECT public.mutate_bookmark_folder_subscription_atomic(
        '$PUBLIC_FOLDER', 'remove'
      ) AS result
    ) AS mutation;
  ")"
expect_value \
  'idempotent remove' \
  'not_subscribed|1' \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT (result->>'status') || '|' || (result->>'subscriber_count')
    FROM (
      SELECT public.mutate_bookmark_folder_subscription_atomic(
        '$PUBLIC_FOLDER', 'remove'
      ) AS result
    ) AS mutation;
  ")"

# Add linearizes first and holds the folder row. The later privacy update must
# wait, then purge the committed subscription in its own transaction.
(
  psql_cmd -qAtc "
    BEGIN;
    SET ROLE authenticated;
    SET request.jwt.claim.role = 'authenticated';
    SET request.jwt.claim.sub = '$ACTOR_ONE';
    SELECT public.mutate_bookmark_folder_subscription_atomic(
      '$ADD_FIRST_FOLDER', 'add'
    )->>'status';
    SELECT pg_catalog.pg_advisory_lock(1730001);
    SELECT pg_catalog.pg_sleep(0.6);
    SELECT pg_catalog.pg_advisory_unlock(1730001);
    COMMIT;
  "
) >"$ADD_FIRST_LOG" 2>&1 &
add_first_pid=$!
wait_for_signal_lock 1730001
authenticated_query "$OWNER" "
  UPDATE public.bookmark_folders
  SET is_public = false
  WHERE id = '$ADD_FIRST_FOLDER';
" >/dev/null
wait "$add_first_pid"
if ! grep -qx 'added' "$ADD_FIRST_LOG"; then
  echo "add-first race did not commit an add" >&2
  exit 1
fi
expect_value \
  'add-first privacy convergence' \
  'false|0' \
  "$(psql_cmd -qAtc "
    SELECT folder.is_public::text || '|' || pg_catalog.count(subscription.id)
    FROM public.bookmark_folders AS folder
    LEFT JOIN public.folder_subscriptions AS subscription
      ON subscription.folder_id = folder.id
    WHERE folder.id = '$ADD_FIRST_FOLDER'
    GROUP BY folder.is_public;
  ")"

# Privacy linearizes first and holds the folder row. The later add must wait and
# then observe the private state instead of inserting a stale subscription.
(
  psql_cmd -qAtc "
    BEGIN;
    SET ROLE authenticated;
    SET request.jwt.claim.role = 'authenticated';
    SET request.jwt.claim.sub = '$OWNER';
    UPDATE public.bookmark_folders
    SET is_public = false
    WHERE id = '$PRIVATE_FIRST_FOLDER';
    SELECT pg_catalog.pg_advisory_lock(1730002);
    SELECT pg_catalog.pg_sleep(0.6);
    SELECT pg_catalog.pg_advisory_unlock(1730002);
    COMMIT;
  "
) >"$PRIVATE_FIRST_LOG" 2>&1 &
private_first_pid=$!
wait_for_signal_lock 1730002
expect_value \
  'privacy-first add rejection' \
  'folder_private' \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT public.mutate_bookmark_folder_subscription_atomic(
      '$PRIVATE_FIRST_FOLDER', 'add'
    )->>'status';
  ")"
wait "$private_first_pid"
expect_value \
  'privacy-first empty invariant' \
  '0' \
  "$(psql_cmd -qAtc "
    SELECT pg_catalog.count(*)
    FROM public.folder_subscriptions
    WHERE folder_id = '$PRIVATE_FIRST_FOLDER';
  ")"

# Ownership changes cannot leave the new owner subscribed to their own folder.
psql_cmd -qAtc "
  UPDATE public.bookmark_folders
  SET user_id = '$ACTOR_TWO'
  WHERE id = '$OWNER_CHANGE_FOLDER';
" >/dev/null
expect_value \
  'owner-change self-subscription purge' \
  '0' \
  "$(psql_cmd -qAtc "
    SELECT pg_catalog.count(*)
    FROM public.folder_subscriptions
    WHERE folder_id = '$OWNER_CHANGE_FOLDER';
  ")"

echo "atomic bookmark folder subscription PostgreSQL 17 proof passed"
