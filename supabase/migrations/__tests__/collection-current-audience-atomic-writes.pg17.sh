#!/usr/bin/env bash

# PostgreSQL 17 proof for current collection audience, ACL convergence, and
# service-only atomic writes.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION_CANDIDATES=(
  "$ROOT_DIR"/supabase/migrations/*_collection_current_audience_and_atomic_writes.sql
)
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

if (( ${#MIGRATION_CANDIDATES[@]} != 1 )) \
  || [[ ! -f "${MIGRATION_CANDIDATES[0]}" ]]; then
  echo "Expected exactly one collection current-audience migration" >&2
  exit 1
fi
MIGRATION="${MIGRATION_CANDIDATES[0]}"

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

TMP_ROOT="$(mktemp -d /tmp/collection-current-audience-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=$((56000 + $$ % 5000))
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    echo "PostgreSQL 17 integration cluster log:" >&2
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop \
      >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --username=postgres \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null

"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

PSQL=(
  "$PG_BIN/psql"
  -X
  -v ON_ERROR_STOP=1
  -h "$SOCKET_DIR"
  -p "$PORT"
  -U postgres
  -d postgres
)

run_migration() {
  local label="$1"
  "${PSQL[@]}" -f "$MIGRATION" >"$LOG_DIR/$label.log" 2>&1
}

expect_migration_failure() {
  local label="$1"
  local expected="$2"
  if run_migration "$label"; then
    echo "Migration unexpectedly accepted drift: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$LOG_DIR/$label.log"; then
    echo "Migration failure did not contain '$expected': $label" >&2
    cat "$LOG_DIR/$label.log" >&2
    exit 1
  fi
}

expect_sql_failure() {
  local label="$1"
  local expected="$2"
  local statement="$3"
  if "${PSQL[@]}" -c "$statement" >"$LOG_DIR/$label.log" 2>&1; then
    echo "SQL unexpectedly succeeded: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" "$LOG_DIR/$label.log"; then
    echo "SQL failure did not contain '$expected': $label" >&2
    cat "$LOG_DIR/$label.log" >&2
    exit 1
  fi
}

"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE hostile_grantee NOLOGIN;
CREATE ROLE downstream_grantee NOLOGIN;
CREATE ROLE privileged_bridge NOLOGIN BYPASSRLS;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA public, auth
  TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  )::uuid
$function$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.role', true),
    ''
  )
$function$;

GRANT EXECUTE ON FUNCTION auth.uid(), auth.role()
  TO anon, authenticated, service_role;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean,
  ban_expires_at timestamptz
);

CREATE TABLE public.user_activities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL
);

CREATE TABLE public.groups (
  id uuid PRIMARY KEY
);

CREATE TABLE public.group_members (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  group_id uuid,
  visibility text NOT NULL,
  status text NOT NULL,
  deleted_at timestamptz
);

CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL,
  blocked_id uuid NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE public.user_collections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  name text NOT NULL,
  description text,
  is_public boolean,
  created_at timestamptz,
  updated_at timestamptz,
  UNIQUE (user_id, name)
);

CREATE TABLE public.collection_items (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL
    REFERENCES public.user_collections(id) ON DELETE CASCADE,
  item_type text NOT NULL,
  item_id text NOT NULL,
  note text,
  added_at timestamptz,
  UNIQUE (collection_id, item_type, item_id)
);

ALTER TABLE public.user_collections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_items ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.can_actor_read_post_id(
  p_post_id uuid,
  p_actor_id uuid DEFAULT NULL
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
      AND post.deleted_at IS NULL
      AND post.status = 'published'
      AND (
        post.visibility = 'public'
        OR post.user_id = p_actor_id
        OR (
          post.visibility = 'group'
          AND EXISTS (
            SELECT 1
            FROM public.group_members AS membership
            WHERE membership.group_id = post.group_id
              AND membership.user_id = p_actor_id
          )
        )
      )
      AND (
        p_actor_id IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.blocked_users AS block
          WHERE (
              block.blocker_id = post.user_id
              AND block.blocked_id = p_actor_id
            )
            OR (
              block.blocker_id = p_actor_id
              AND block.blocked_id = post.user_id
            )
        )
      )
  )
$function$;
ALTER FUNCTION public.can_actor_read_post_id(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_actor_read_post_id(uuid, uuid)
  FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ensure_default_collections(
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  INSERT INTO public.user_collections (
    id,
    user_id,
    name,
    description,
    is_public,
    created_at,
    updated_at
  ) VALUES
    (
      pg_catalog.gen_random_uuid(),
      p_user_id,
      '关注的交易员',
      'My followed traders',
      false,
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp()
    ),
    (
      pg_catalog.gen_random_uuid(),
      p_user_id,
      '我的书架',
      'My bookshelf',
      false,
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp()
    )
  ON CONFLICT (user_id, name) DO NOTHING;
END
$function$;

CREATE FUNCTION public.ensure_default_collections(p_user_id text)
RETURNS void
LANGUAGE sql
AS $function$
  SELECT NULL::void
$function$;

GRANT ALL PRIVILEGES
  ON public.user_collections, public.collection_items
  TO anon, authenticated, service_role;
GRANT SELECT ON public.user_profiles TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.user_collections, public.collection_items
  TO hostile_grantee WITH GRANT OPTION;
GRANT UPDATE (name)
  ON public.user_collections
  TO hostile_grantee WITH GRANT OPTION;

SET ROLE hostile_grantee;
GRANT SELECT
  ON public.user_collections, public.collection_items
  TO downstream_grantee;
GRANT UPDATE (name)
  ON public.user_collections
  TO downstream_grantee;
RESET ROLE;

CREATE POLICY public_collection_read
  ON public.user_collections
  FOR SELECT
  TO PUBLIC
  USING (is_public OR user_id = (SELECT auth.uid()));
CREATE POLICY own_collection_mutation
  ON public.user_collections
  FOR ALL
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY unsafe_collection_items_all
  ON public.collection_items
  FOR ALL
  TO PUBLIC
  USING (true)
  WITH CHECK (true);

INSERT INTO public.user_profiles (
  id, deleted_at, banned_at, is_banned, ban_expires_at
) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', NULL, NULL, false, NULL),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', NULL, NULL, false, NULL),
  (
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    pg_catalog.clock_timestamp(),
    NULL,
    false,
    NULL
  ),
  (
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    NULL,
    NULL,
    true,
    pg_catalog.clock_timestamp() + INTERVAL '1 day'
  ),
  (
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    NULL,
    NULL,
    true,
    pg_catalog.clock_timestamp() - INTERVAL '1 day'
  ),
  (
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    NULL,
    pg_catalog.clock_timestamp(),
    false,
    NULL
  ),
  ('88888888-8888-4888-8888-888888888888', NULL, NULL, false, NULL);

INSERT INTO public.groups (id)
VALUES ('90000000-0000-4000-8000-000000000001');
INSERT INTO public.group_members (group_id, user_id)
VALUES (
  '90000000-0000-4000-8000-000000000001',
  '88888888-8888-4888-8888-888888888888'
);

INSERT INTO public.posts (
  id, user_id, group_id, visibility, status, deleted_at
) VALUES
  (
    'a1111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    NULL,
    'public',
    'published',
    NULL
  ),
  (
    'a2222222-2222-4222-8222-222222222222',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    NULL,
    'public',
    'published',
    pg_catalog.clock_timestamp()
  ),
  (
    'a3333333-3333-4333-8333-333333333333',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '90000000-0000-4000-8000-000000000001',
    'group',
    'published',
    NULL
  ),
  (
    'a4444444-4444-4444-8444-444444444444',
    '88888888-8888-4888-8888-888888888888',
    NULL,
    'public',
    'published',
    NULL
  );

INSERT INTO public.blocked_users (blocker_id, blocked_id)
VALUES
  (
    '88888888-8888-4888-8888-888888888888',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  (
    '88888888-8888-4888-8888-888888888888',
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  );

INSERT INTO public.user_activities (
  id, user_id, target_type, target_id
) VALUES
  (
    'b1111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'profile',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ),
  (
    'b2222222-2222-4222-8222-222222222222',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    'a1111111-1111-4111-8111-111111111111'
  ),
  (
    'b3333333-3333-4333-8333-333333333333',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    'a3333333-3333-4333-8333-333333333333'
  ),
  (
    'b4444444-4444-4444-8444-444444444444',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'profile',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ),
  (
    'b5555555-5555-4555-8555-555555555555',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'post',
    'not-a-uuid'
  );

INSERT INTO public.user_collections (
  id, user_id, name, description, is_public, created_at, updated_at
) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A public',
    NULL,
    true,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'A private',
    NULL,
    false,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    'deleted public',
    NULL,
    true,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    'banned public',
    NULL,
    true,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000005',
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    'expired-ban public',
    NULL,
    true,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  ),
  (
    '10000000-0000-4000-8000-000000000006',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'hard-banned public',
    NULL,
    true,
    pg_catalog.clock_timestamp(),
    pg_catalog.clock_timestamp()
  );

INSERT INTO public.collection_items (
  id, collection_id, item_type, item_id, note, added_at
) VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'post',
    'a1111111-1111-4111-8111-111111111111',
    'public post',
    pg_catalog.clock_timestamp()
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    'post',
    'a2222222-2222-4222-8222-222222222222',
    'deleted post',
    pg_catalog.clock_timestamp()
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000001',
    'post',
    'a3333333-3333-4333-8333-333333333333',
    'private group post',
    pg_catalog.clock_timestamp()
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001',
    'post',
    'a4444444-4444-4444-8444-444444444444',
    'blocked post',
    pg_catalog.clock_timestamp()
  ),
  (
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000001',
    'activity',
    'b1111111-1111-4111-8111-111111111111',
    'plain activity',
    pg_catalog.clock_timestamp()
  ),
  (
    '20000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000001',
    'activity',
    'b2222222-2222-4222-8222-222222222222',
    'public-post activity',
    pg_catalog.clock_timestamp()
  ),
  (
    '20000000-0000-4000-8000-000000000007',
    '10000000-0000-4000-8000-000000000001',
    'activity',
    'b3333333-3333-4333-8333-333333333333',
    'private-post activity',
    pg_catalog.clock_timestamp()
  ),
  (
    '20000000-0000-4000-8000-000000000008',
    '10000000-0000-4000-8000-000000000001',
    'activity',
    'b4444444-4444-4444-8444-444444444444',
    'inactive-owner activity',
    pg_catalog.clock_timestamp()
  ),
  (
    '20000000-0000-4000-8000-000000000009',
    '10000000-0000-4000-8000-000000000002',
    'post',
    'a1111111-1111-4111-8111-111111111111',
    'private collection item',
    pg_catalog.clock_timestamp()
  ),
  (
    '20000000-0000-4000-8000-000000000010',
    '10000000-0000-4000-8000-000000000003',
    'post',
    'a1111111-1111-4111-8111-111111111111',
    'deleted owner item',
    pg_catalog.clock_timestamp()
  ),
  (
    '20000000-0000-4000-8000-000000000011',
    '10000000-0000-4000-8000-000000000005',
    'post',
    'a1111111-1111-4111-8111-111111111111',
    'expired-ban owner item',
    pg_catalog.clock_timestamp()
  ),
  (
    '20000000-0000-4000-8000-000000000012',
    '10000000-0000-4000-8000-000000000001',
    'activity',
    'b5555555-5555-4555-8555-555555555555',
    'legacy invalid-target activity',
    pg_catalog.clock_timestamp()
  );
SQL

# Fail closed on routine-kind collisions instead of issuing the wrong DROP.
"${PSQL[@]}" <<'SQL'
CREATE PROCEDURE public.can_actor_read_activity_id()
LANGUAGE sql
AS $procedure$
  SELECT 1
$procedure$;
SQL
expect_migration_failure \
  "procedure-collision" \
  "non-function collection routine name collision must be classified"
"${PSQL[@]}" -c \
  "DROP PROCEDURE public.can_actor_read_activity_id()" >/dev/null

# Browser roles must not bypass RLS directly or through SET/INHERIT authority.
"${PSQL[@]}" -c \
  "ALTER ROLE authenticated BYPASSRLS" >/dev/null
expect_migration_failure \
  "browser-bypass" \
  "browser collection roles can reach a privileged authority"
"${PSQL[@]}" -c \
  "ALTER ROLE authenticated NOBYPASSRLS" >/dev/null

"${PSQL[@]}" -c \
  "GRANT privileged_bridge TO authenticated" >/dev/null
expect_migration_failure \
  "browser-membership" \
  "browser collection roles can reach a privileged authority"
"${PSQL[@]}" -c \
  "REVOKE privileged_bridge FROM authenticated" >/dev/null

# The actor-parameterized post reader is an internal dependency, not a browser
# RPC. A PUBLIC grant would let callers forge the actor UUID.
"${PSQL[@]}" -c \
  "GRANT EXECUTE ON FUNCTION public.can_actor_read_post_id(uuid, uuid) TO PUBLIC" \
  >/dev/null
expect_migration_failure \
  "post-reader-public" \
  "post audience dependency function must remain owner-private"
"${PSQL[@]}" -c \
  "REVOKE EXECUTE ON FUNCTION public.can_actor_read_post_id(uuid, uuid) FROM PUBLIC" \
  >/dev/null

# Historical IDs are checked in phases so malformed values produce our
# fail-closed exception and are never cast accidentally.
"${PSQL[@]}" <<'SQL'
INSERT INTO public.collection_items (
  id, collection_id, item_type, item_id, added_at
) VALUES (
  '20000000-0000-4000-8000-000000000013',
  '10000000-0000-4000-8000-000000000001',
  'post',
  'not-a-uuid',
  pg_catalog.clock_timestamp()
);
SQL
expect_migration_failure \
  "malformed-item-id" \
  "collection item type/id historical data is incompatible"
"${PSQL[@]}" -c \
  "DELETE FROM public.collection_items WHERE id = '20000000-0000-4000-8000-000000000013'" \
  >/dev/null

"${PSQL[@]}" <<'SQL'
INSERT INTO public.collection_items (
  id, collection_id, item_type, item_id, added_at
) VALUES (
  '20000000-0000-4000-8000-000000000014',
  '10000000-0000-4000-8000-000000000001',
  'post',
  'A1111111-1111-4111-8111-111111111111',
  pg_catalog.clock_timestamp()
);
SQL
expect_migration_failure \
  "semantic-item-collision" \
  "collection item canonical identity collision exists"
"${PSQL[@]}" -c \
  "DELETE FROM public.collection_items WHERE id = '20000000-0000-4000-8000-000000000014'" \
  >/dev/null

"${PSQL[@]}" <<'SQL'
INSERT INTO public.collection_items (
  id, collection_id, item_type, item_id, added_at
) VALUES (
  '20000000-0000-4000-8000-000000000015',
  '10000000-0000-4000-8000-000000000001',
  'post',
  'C6666666-6666-4666-8666-666666666666',
  pg_catalog.clock_timestamp()
);
SQL
expect_migration_failure \
  "noncanonical-item-id" \
  "collection item id historical data is not canonical lowercase uuid"
"${PSQL[@]}" -c \
  "DELETE FROM public.collection_items WHERE id = '20000000-0000-4000-8000-000000000015'" \
  >/dev/null

run_migration "first-success"
run_migration "immediate-replay"

"${PSQL[@]}" <<'SQL'
DO $acl_contract$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.user_collections'::pg_catalog.regclass
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.collection_items'::pg_catalog.regclass
  ) <> 2
  THEN
    RAISE EXCEPTION 'canonical policy count failed';
  END IF;

  IF pg_catalog.has_table_privilege(
    'anon',
    'public.user_collections',
    'INSERT,UPDATE,DELETE'
  ) OR pg_catalog.has_table_privilege(
    'authenticated',
    'public.collection_items',
    'INSERT,UPDATE,DELETE'
  ) OR pg_catalog.has_any_column_privilege(
    'authenticated',
    'public.user_collections',
    'INSERT,UPDATE,REFERENCES'
  ) OR pg_catalog.has_table_privilege(
    'hostile_grantee',
    'public.user_collections',
    'SELECT,INSERT,UPDATE,DELETE'
  ) OR pg_catalog.has_table_privilege(
    'downstream_grantee',
    'public.collection_items',
    'SELECT'
  ) OR pg_catalog.has_any_column_privilege(
    'downstream_grantee',
    'public.user_collections',
    'UPDATE'
  ) THEN
    RAISE EXCEPTION 'collection ACL convergence failed';
  END IF;

  IF pg_catalog.to_regprocedure(
    'public.ensure_default_collections(text)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'legacy collection overload survived';
  END IF;
END
$acl_contract$;

SET ROLE anon;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'anon', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '', false);
DO $anonymous_audience$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.user_collections) <> 2
    OR (SELECT pg_catalog.count(*) FROM public.collection_items) <> 5
  THEN
    RAISE EXCEPTION 'anonymous current-audience contract failed';
  END IF;
END
$anonymous_audience$;

RESET ROLE;
SET ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim.role',
  'authenticated',
  false
);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  false
);
DO $other_user_audience$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.user_collections) <> 2
    OR (SELECT pg_catalog.count(*) FROM public.collection_items) <> 4
    OR EXISTS (
      SELECT 1
      FROM public.collection_items
      WHERE note IN (
        'deleted post',
        'private group post',
        'blocked post',
        'private-post activity',
        'inactive-owner activity',
        'legacy invalid-target activity',
        'private collection item',
        'deleted owner item'
      )
    )
  THEN
    RAISE EXCEPTION 'authenticated current-resource audience failed';
  END IF;
END
$other_user_audience$;

SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  false
);
DO $active_owner_audience$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.user_collections
    WHERE user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM public.collection_items
  ) <> 7 OR EXISTS (
    SELECT 1
    FROM public.collection_items
    WHERE note IN (
      'deleted post',
      'blocked post',
      'inactive-owner activity',
      'legacy invalid-target activity'
    )
  )
  THEN
    RAISE EXCEPTION 'active owner current-resource audience failed';
  END IF;
END
$active_owner_audience$;

SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  false
);
DO $deleted_owner_audience$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_collections
    WHERE user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  ) OR EXISTS (
    SELECT 1
    FROM public.collection_items
    WHERE collection_id = '10000000-0000-4000-8000-000000000003'
  ) THEN
    RAISE EXCEPTION 'deleted owner retained direct collection visibility';
  END IF;
END
$deleted_owner_audience$;

SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  false
);
DO $banned_owner_audience$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_collections
    WHERE user_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  ) THEN
    RAISE EXCEPTION 'currently banned owner retained direct visibility';
  END IF;
END
$banned_owner_audience$;

SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  false
);
DO $expired_ban_audience$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_collections
    WHERE user_id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
  ) THEN
    RAISE EXCEPTION 'expired ban did not follow active audience semantics';
  END IF;
END
$expired_ban_audience$;
RESET ROLE;
SQL

wait_for_log_marker() {
  local log_file="$1"
  local marker="$2"
  local attempt
  for ((attempt = 0; attempt < 200; attempt += 1)); do
    if [[ -f "$log_file" ]] && grep -Fq "$marker" "$log_file"; then
      return 0
    fi
    sleep 0.05
  done
  echo "Timed out waiting for '$marker' in $log_file" >&2
  [[ -f "$log_file" ]] && cat "$log_file" >&2
  return 1
}

# Hold the first transaction open after its ACK. The second caller must wait
# and then report the state that committed, never a duplicate success.
"${PSQL[@]}" -A -t -q >"$LOG_DIR/concurrent-create-first.log" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SELECT pg_catalog.set_config(
  'request.jwt.claim.role',
  'service_role',
  false
);
SELECT public.mutate_user_collection_atomic(
  'create',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  NULL,
  NULL,
  false,
  false,
  true,
  'Concurrent collection',
  true
) ->> 'result_code';
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
create_first_pid=$!
wait_for_log_marker \
  "$LOG_DIR/concurrent-create-first.log" \
  "created"
"${PSQL[@]}" -A -t -q >"$LOG_DIR/concurrent-create-second.log" 2>&1 <<'SQL'
BEGIN;
SET ROLE service_role;
SELECT pg_catalog.set_config(
  'request.jwt.claim.role',
  'service_role',
  false
);
SELECT public.mutate_user_collection_atomic(
  'create',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  NULL,
  NULL,
  false,
  false,
  true,
  'Concurrent collection',
  true
) ->> 'result_code';
COMMIT;
SQL
wait "$create_first_pid"

create_results="$(
  grep -Eh '^(created|already_exists)$' \
    "$LOG_DIR/concurrent-create-first.log" \
    "$LOG_DIR/concurrent-create-second.log" \
    | LC_ALL=C sort
)"
if [[ "$create_results" != $'already_exists\ncreated' ]]; then
  echo "Concurrent collection create ACKs were not exact:" >&2
  printf '%s\n' "$create_results" >&2
  exit 1
fi

concurrent_collection_id="$(
  "${PSQL[@]}" -A -t -q -c \
    "SELECT id FROM public.user_collections WHERE user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' AND name = 'Concurrent collection'"
)"
if [[ -z "$concurrent_collection_id" ]]; then
  echo "Concurrent collection was not persisted" >&2
  exit 1
fi

"${PSQL[@]}" -A -t -q \
  -v collection_id="$concurrent_collection_id" \
  >"$LOG_DIR/concurrent-add-first.log" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SELECT pg_catalog.set_config(
  'request.jwt.claim.role',
  'service_role',
  false
);
SELECT public.mutate_collection_item_atomic(
  'add',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  :'collection_id',
  'a1111111-1111-4111-8111-111111111111',
  'post',
  'concurrent add'
) ->> 'result_code';
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
add_first_pid=$!
wait_for_log_marker \
  "$LOG_DIR/concurrent-add-first.log" \
  "inserted"
"${PSQL[@]}" -A -t -q \
  -v collection_id="$concurrent_collection_id" \
  >"$LOG_DIR/concurrent-add-second.log" 2>&1 <<'SQL'
BEGIN;
SET ROLE service_role;
SELECT pg_catalog.set_config(
  'request.jwt.claim.role',
  'service_role',
  false
);
SELECT public.mutate_collection_item_atomic(
  'add',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  :'collection_id',
  'a1111111-1111-4111-8111-111111111111',
  'post',
  'concurrent add'
) ->> 'result_code';
COMMIT;
SQL
wait "$add_first_pid"

add_results="$(
  grep -Eh '^(inserted|already_exists)$' \
    "$LOG_DIR/concurrent-add-first.log" \
    "$LOG_DIR/concurrent-add-second.log" \
    | LC_ALL=C sort
)"
if [[ "$add_results" != $'already_exists\ninserted' ]]; then
  echo "Concurrent collection add ACKs were not exact:" >&2
  printf '%s\n' "$add_results" >&2
  exit 1
fi

"${PSQL[@]}" -A -t -q \
  -v collection_id="$concurrent_collection_id" \
  >"$LOG_DIR/concurrent-remove-first.log" 2>&1 <<'SQL' &
BEGIN;
SET ROLE service_role;
SELECT pg_catalog.set_config(
  'request.jwt.claim.role',
  'service_role',
  false
);
SELECT public.mutate_collection_item_atomic(
  'remove',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  :'collection_id',
  'a1111111-1111-4111-8111-111111111111',
  'post',
  NULL
) ->> 'result_code';
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
remove_first_pid=$!
wait_for_log_marker \
  "$LOG_DIR/concurrent-remove-first.log" \
  "removed"
"${PSQL[@]}" -A -t -q \
  -v collection_id="$concurrent_collection_id" \
  >"$LOG_DIR/concurrent-remove-second.log" 2>&1 <<'SQL'
BEGIN;
SET ROLE service_role;
SELECT pg_catalog.set_config(
  'request.jwt.claim.role',
  'service_role',
  false
);
SELECT public.mutate_collection_item_atomic(
  'remove',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  :'collection_id',
  'a1111111-1111-4111-8111-111111111111',
  'post',
  NULL
) ->> 'result_code';
COMMIT;
SQL
wait "$remove_first_pid"

remove_results="$(
  grep -Eh '^(removed|not_found)$' \
    "$LOG_DIR/concurrent-remove-first.log" \
    "$LOG_DIR/concurrent-remove-second.log" \
    | LC_ALL=C sort
)"
if [[ "$remove_results" != $'not_found\nremoved' ]]; then
  echo "Concurrent collection remove ACKs were not exact:" >&2
  printf '%s\n' "$remove_results" >&2
  exit 1
fi

"${PSQL[@]}" <<SQL
DO \$concurrency_final_state\$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.user_collections
    WHERE user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND name = 'Concurrent collection'
  ) <> 1 OR EXISTS (
    SELECT 1
    FROM public.collection_items
    WHERE collection_id = '$concurrent_collection_id'
      AND item_type = 'post'
      AND item_id = 'a1111111-1111-4111-8111-111111111111'
  ) THEN
    RAISE EXCEPTION 'concurrent collection final state failed';
  END IF;
END
\$concurrency_final_state\$;
SQL

# Current-resource decisions must follow live profile/post/group/block state.
"${PSQL[@]}" <<'SQL'
UPDATE public.user_activities
SET user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
WHERE id = 'b1111111-1111-4111-8111-111111111111';

SET ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim.role',
  'authenticated',
  false
);
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  false
);
DO $activity_owner_transition$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.collection_items
    WHERE id = '20000000-0000-4000-8000-000000000005'
  ) THEN
    RAISE EXCEPTION 'activity owner transition stayed stale';
  END IF;
END
$activity_owner_transition$;
RESET ROLE;

UPDATE public.user_activities
SET user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
WHERE id = 'b1111111-1111-4111-8111-111111111111';

UPDATE public.posts
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = 'a1111111-1111-4111-8111-111111111111';

SET ROLE authenticated;
SELECT pg_catalog.set_config(
  'request.jwt.claim.sub',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  false
);
DO $post_transition$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.collection_items
    WHERE item_id IN (
      'a1111111-1111-4111-8111-111111111111',
      'b2222222-2222-4222-8222-222222222222'
    )
  ) THEN
    RAISE EXCEPTION 'post deletion transition stayed stale';
  END IF;
END
$post_transition$;
RESET ROLE;

UPDATE public.posts
SET deleted_at = NULL
WHERE id = 'a1111111-1111-4111-8111-111111111111';

INSERT INTO public.group_members (group_id, user_id)
VALUES (
  '90000000-0000-4000-8000-000000000001',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
);
SET ROLE authenticated;
DO $group_transition$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.collection_items
    WHERE id = '20000000-0000-4000-8000-000000000003'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.collection_items
    WHERE id = '20000000-0000-4000-8000-000000000007'
  ) THEN
    RAISE EXCEPTION 'group membership transition did not become readable';
  END IF;
END
$group_transition$;
RESET ROLE;
DELETE FROM public.group_members
WHERE group_id = '90000000-0000-4000-8000-000000000001'
  AND user_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

DELETE FROM public.blocked_users
WHERE blocker_id = '88888888-8888-4888-8888-888888888888'
  AND blocked_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
SET ROLE authenticated;
DO $block_transition$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.collection_items
    WHERE id = '20000000-0000-4000-8000-000000000004'
  ) THEN
    RAISE EXCEPTION 'block removal transition stayed stale';
  END IF;
END
$block_transition$;
RESET ROLE;
INSERT INTO public.blocked_users (blocker_id, blocked_id)
VALUES (
  '88888888-8888-4888-8888-888888888888',
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
);
SQL

# An unrelated trigger-raised 23505 with the same constraint name must be
# rethrown instead of being mislabeled as the collection-name conflict ACK.
"${PSQL[@]}" <<'SQL'
CREATE OR REPLACE FUNCTION public.raise_hostile_collection_unique()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.name = 'hostile synthetic collision' THEN
    RAISE EXCEPTION 'hostile synthetic unique violation'
      USING
        ERRCODE = '23505',
        SCHEMA = 'hostile_schema',
        TABLE = 'hostile_table',
        CONSTRAINT = 'user_collections_user_id_name_key';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER hostile_collection_unique
BEFORE UPDATE ON public.user_collections
FOR EACH ROW
EXECUTE FUNCTION public.raise_hostile_collection_unique();
SQL

expect_sql_failure \
  "unrelated-unique-violation" \
  "hostile synthetic unique violation" \
  "SET ROLE service_role; SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false); SELECT public.mutate_user_collection_atomic('update', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '10000000-0000-4000-8000-000000000001', NULL, false, NULL, false, 'hostile synthetic collision', true)"

"${PSQL[@]}" <<'SQL'
DROP TRIGGER hostile_collection_unique ON public.user_collections;
DROP FUNCTION public.raise_hostile_collection_unique();

CREATE POLICY replay_unsafe_collection_policy
  ON public.user_collections
  FOR ALL
  TO PUBLIC
  USING (true)
  WITH CHECK (true);
CREATE POLICY replay_unsafe_item_policy
  ON public.collection_items
  FOR ALL
  TO PUBLIC
  USING (true)
  WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.user_collections, public.collection_items
  TO hostile_grantee WITH GRANT OPTION;
GRANT UPDATE (name)
  ON public.user_collections
  TO hostile_grantee WITH GRANT OPTION;
SET ROLE hostile_grantee;
GRANT SELECT
  ON public.user_collections, public.collection_items
  TO downstream_grantee;
GRANT UPDATE (name)
  ON public.user_collections
  TO downstream_grantee;
RESET ROLE;

ALTER FUNCTION public.mutate_user_collection_atomic(
  text, uuid, uuid, text, boolean, boolean, boolean, text, boolean
) SECURITY INVOKER;
ALTER FUNCTION public.mutate_user_collection_atomic(
  text, uuid, uuid, text, boolean, boolean, boolean, text, boolean
) SET search_path = public;
ALTER FUNCTION public.mutate_user_collection_atomic(
  text, uuid, uuid, text, boolean, boolean, boolean, text, boolean
) OWNER TO hostile_grantee;
GRANT EXECUTE ON FUNCTION public.mutate_user_collection_atomic(
  text, uuid, uuid, text, boolean, boolean, boolean, text, boolean
) TO downstream_grantee;

CREATE FUNCTION public.mutate_user_collection_atomic(p_action text)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT '{}'::jsonb
$function$;
SQL

run_migration "drift-convergence"
run_migration "post-drift-replay"

"${PSQL[@]}" <<'SQL'
DO $replay_convergence_contract$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.user_collections'::pg_catalog.regclass
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy
    WHERE polrelid = 'public.collection_items'::pg_catalog.regclass
  ) <> 2 OR pg_catalog.has_table_privilege(
    'hostile_grantee',
    'public.user_collections',
    'SELECT,INSERT,UPDATE,DELETE'
  ) OR pg_catalog.has_table_privilege(
    'downstream_grantee',
    'public.collection_items',
    'SELECT'
  ) OR pg_catalog.has_any_column_privilege(
    'downstream_grantee',
    'public.user_collections',
    'UPDATE'
  ) OR pg_catalog.has_function_privilege(
    'downstream_grantee',
    'public.mutate_user_collection_atomic(text,uuid,uuid,text,boolean,boolean,boolean,text,boolean)',
    'EXECUTE'
  ) OR pg_catalog.to_regprocedure(
    'public.mutate_user_collection_atomic(text)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'post-drift convergence contract failed';
  END IF;
END
$replay_convergence_contract$;
SQL

expect_sql_failure \
  "browser-table-write" \
  "permission denied for table user_collections" \
  "SET ROLE authenticated; INSERT INTO public.user_collections (id, user_id, name) VALUES ('10000000-0000-4000-8000-000000000090', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'browser write')"
expect_sql_failure \
  "browser-collection-rpc" \
  "permission denied for function mutate_user_collection_atomic" \
  "SET ROLE authenticated; SELECT public.mutate_user_collection_atomic('create', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', NULL, NULL, false, false, true, 'browser rpc', true)"
expect_sql_failure \
  "anonymous-item-rpc" \
  "permission denied for function mutate_collection_item_atomic" \
  "SET ROLE anon; SELECT public.mutate_collection_item_atomic('add', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '10000000-0000-4000-8000-000000000001', 'a1111111-1111-4111-8111-111111111111', 'post', NULL)"
expect_sql_failure \
  "browser-default-rpc" \
  "permission denied for function ensure_default_collections" \
  "SET ROLE authenticated; SELECT public.ensure_default_collections('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')"

"${PSQL[@]}" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config(
  'request.jwt.claim.role',
  'service_role',
  false
);

DO $atomic_ack_contract$
DECLARE
  v_ack jsonb;
  v_collection_id uuid;
  v_inactive_denied boolean := false;
  v_null_rejected boolean := false;
BEGIN
  v_ack := public.mutate_user_collection_atomic(
    'create',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    NULL,
    'created by atomic RPC',
    true,
    false,
    true,
    'RPC collection',
    true
  );
  IF v_ack ->> 'result_code' <> 'created'
    OR v_ack ->> 'applied' <> 'true'
    OR v_ack -> 'collection' ->> 'name' <> 'RPC collection'
  THEN
    RAISE EXCEPTION 'collection create ACK failed: %', v_ack;
  END IF;
  v_collection_id := (v_ack ->> 'collection_id')::uuid;

  v_ack := public.mutate_user_collection_atomic(
    'create',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    NULL,
    'duplicate',
    true,
    false,
    true,
    'RPC collection',
    true
  );
  IF v_ack ->> 'result_code' <> 'already_exists'
    OR v_ack ->> 'applied' <> 'false'
    OR v_ack -> 'collection' <> 'null'::jsonb
  THEN
    RAISE EXCEPTION 'duplicate collection create ACK failed: %', v_ack;
  END IF;

  v_ack := public.mutate_user_collection_atomic(
    'update',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000001',
    NULL,
    false,
    NULL,
    false,
    'A private',
    true
  );
  IF v_ack ->> 'result_code' <> 'already_exists'
    OR v_ack ->> 'applied' <> 'false'
    OR v_ack -> 'collection' <> 'null'::jsonb
    OR v_ack ->> 'collection_id' <>
      '10000000-0000-4000-8000-000000000001'
    OR (
      SELECT name
      FROM public.user_collections
      WHERE id = '10000000-0000-4000-8000-000000000001'
    ) <> 'A public'
  THEN
    RAISE EXCEPTION 'duplicate collection rename ACK failed: %', v_ack;
  END IF;

  v_ack := public.mutate_user_collection_atomic(
    'update',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000099',
    NULL,
    false,
    NULL,
    false,
    NULL,
    false
  );
  IF v_ack ->> 'result_code' <> 'not_found'
    OR v_ack ->> 'applied' <> 'false'
  THEN
    RAISE EXCEPTION 'missing collection update ACK failed: %', v_ack;
  END IF;

  v_ack := public.mutate_user_collection_atomic(
    'create',
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    NULL,
    NULL,
    false,
    false,
    true,
    'inactive create',
    true
  );
  IF v_ack ->> 'result_code' <> 'inactive_actor'
    OR v_ack ->> 'applied' <> 'false'
  THEN
    RAISE EXCEPTION 'inactive collection actor ACK failed: %', v_ack;
  END IF;

  v_ack := public.mutate_collection_item_atomic(
    'add',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    v_collection_id,
    'a1111111-1111-4111-8111-111111111111',
    'post',
    'atomic item'
  );
  IF v_ack ->> 'result_code' <> 'inserted'
    OR v_ack ->> 'applied' <> 'true'
    OR v_ack -> 'item' ->> 'item_id' <>
      'a1111111-1111-4111-8111-111111111111'
  THEN
    RAISE EXCEPTION 'collection item add ACK failed: %', v_ack;
  END IF;

  v_ack := public.mutate_collection_item_atomic(
    'add',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    v_collection_id,
    'a1111111-1111-4111-8111-111111111111',
    'post',
    'duplicate item'
  );
  IF v_ack ->> 'result_code' <> 'already_exists'
    OR v_ack ->> 'applied' <> 'false'
  THEN
    RAISE EXCEPTION 'duplicate collection item ACK failed: %', v_ack;
  END IF;

  v_ack := public.mutate_collection_item_atomic(
    'add',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    '10000000-0000-4000-8000-000000000099',
    'a1111111-1111-4111-8111-111111111111',
    'post',
    NULL
  );
  IF v_ack ->> 'result_code' <> 'collection_not_found'
    OR v_ack ->> 'applied' <> 'false'
  THEN
    RAISE EXCEPTION 'missing item parent ACK failed: %', v_ack;
  END IF;

  v_ack := public.mutate_collection_item_atomic(
    'add',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    v_collection_id,
    'c7777777-7777-4777-8777-777777777777',
    'post',
    NULL
  );
  IF v_ack ->> 'result_code' <> 'resource_not_found'
    OR v_ack ->> 'applied' <> 'false'
  THEN
    RAISE EXCEPTION 'missing collection resource ACK failed: %', v_ack;
  END IF;

  v_ack := public.mutate_collection_item_atomic(
    'remove',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    v_collection_id,
    'a1111111-1111-4111-8111-111111111111',
    'post',
    NULL
  );
  IF v_ack ->> 'result_code' <> 'removed'
    OR v_ack ->> 'applied' <> 'true'
  THEN
    RAISE EXCEPTION 'collection item remove ACK failed: %', v_ack;
  END IF;

  v_ack := public.mutate_collection_item_atomic(
    'remove',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    v_collection_id,
    'a1111111-1111-4111-8111-111111111111',
    'post',
    NULL
  );
  IF v_ack ->> 'result_code' <> 'not_found'
    OR v_ack ->> 'applied' <> 'false'
  THEN
    RAISE EXCEPTION 'idempotent item remove ACK failed: %', v_ack;
  END IF;

  PERFORM public.ensure_default_collections(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  PERFORM public.ensure_default_collections(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  );
  IF (
    SELECT pg_catalog.count(*)
    FROM public.user_collections
    WHERE user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      AND (
        (name = '关注的交易员' AND description = 'My followed traders')
        OR (name = '我的书架' AND description = 'My bookshelf')
      )
      AND is_public = false
  ) <> 2 THEN
    RAISE EXCEPTION 'default collection exact/replay contract failed';
  END IF;

  BEGIN
    PERFORM public.ensure_default_collections(
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    );
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_inactive_denied := true;
  END;
  IF NOT v_inactive_denied THEN
    RAISE EXCEPTION 'inactive default collection actor was not denied';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.user_collections
    WHERE user_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
      AND name IN ('关注的交易员', '我的书架')
  ) THEN
    RAISE EXCEPTION 'inactive default collection denial wrote rows';
  END IF;

  BEGIN
    PERFORM public.ensure_default_collections(NULL);
  EXCEPTION
    WHEN invalid_parameter_value THEN
      v_null_rejected := true;
  END;
  IF NOT v_null_rejected THEN
    RAISE EXCEPTION 'null default collection actor was accepted';
  END IF;
END
$atomic_ack_contract$;

RESET ROLE;
SQL

echo "collection current-audience/atomic-writes PG17 integration proof passed"
