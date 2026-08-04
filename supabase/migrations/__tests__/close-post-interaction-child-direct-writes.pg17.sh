#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803101000_close_post_interaction_child_direct_writes.sql"
ATTESTATION="$ROOT_DIR/docs/sql/post-interaction-child-boundary-attestation.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/close-post-interaction-child-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="$((57200 + ($$ % 500)))"

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

expect_42501() {
  local label="$1"
  local error_file="$TMP_ROOT/$(printf '%s' "$label" | tr -cs 'A-Za-z0-9' '_').err"
  if psql_cmd >/dev/null 2>"$error_file"; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! grep -q '42501' "$error_file"; then
    echo "$label failed for the wrong reason" >&2
    cat "$error_file" >&2
    exit 1
  fi
}

psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', true), '')::uuid
$function$;
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;

GRANT USAGE ON SCHEMA auth, public
  TO anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role()
  TO anon, authenticated, authenticator, service_role;

CREATE TABLE public.post_likes (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction_type text,
  UNIQUE (post_id, user_id)
);
CREATE TABLE public.post_votes (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  choice text NOT NULL,
  UNIQUE (post_id, user_id)
);
CREATE TABLE public.post_bookmarks (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id uuid,
  UNIQUE (post_id, user_id)
);
CREATE TABLE public.post_reactions (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction_type text NOT NULL,
  UNIQUE (post_id, user_id)
);
CREATE TABLE public.post_emoji_reactions (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  UNIQUE (post_id, user_id, emoji)
);
CREATE TABLE public.comment_emoji_reactions (
  id uuid PRIMARY KEY,
  comment_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  UNIQUE (comment_id, user_id, emoji)
);
CREATE TABLE public.poll_votes (
  id uuid PRIMARY KEY,
  poll_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  option_index integer NOT NULL,
  UNIQUE (poll_id, user_id, option_index)
);

DO $fixture_policies$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'post_likes',
    'post_votes',
    'post_bookmarks',
    'post_reactions',
    'post_emoji_reactions',
    'comment_emoji_reactions',
    'poll_votes'
  ]::text[]
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      v_table
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO PUBLIC USING (true)',
      v_table || '_legacy_public_read',
      v_table
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated
         USING ((SELECT auth.uid()) = user_id)
         WITH CHECK ((SELECT auth.uid()) = user_id)',
      v_table || '_legacy_own_write',
      v_table
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER
         ON TABLE public.%I TO PUBLIC, anon, authenticated, authenticator',
      v_table
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE public.%I TO service_role',
      v_table
    );
  END LOOP;
END
$fixture_policies$;

-- Simulate a historical column ACL that a table-level REVOKE alone misses.
GRANT UPDATE (reaction_type) ON TABLE public.post_likes TO authenticated;

CREATE OR REPLACE FUNCTION public.toggle_post_reaction(
  p_post_id uuid,
  p_user_id uuid,
  p_reaction_type text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO public.post_likes(id, post_id, user_id, reaction_type)
  VALUES (p_post_id, p_post_id, p_user_id, p_reaction_type);
  RETURN pg_catalog.jsonb_build_object('status', 'added');
END
$function$;

CREATE OR REPLACE FUNCTION public.toggle_post_vote_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_choice text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO public.post_votes(id, post_id, user_id, choice)
  VALUES (p_post_id, p_post_id, p_actor_id, p_choice);
  RETURN pg_catalog.jsonb_build_object('status', 'added');
END
$function$;

CREATE OR REPLACE FUNCTION public.toggle_post_bookmark_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_folder_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO public.post_bookmarks(id, post_id, user_id, folder_id)
  VALUES (p_post_id, p_post_id, p_actor_id, p_folder_id);
  RETURN pg_catalog.jsonb_build_object('status', 'added');
END
$function$;

CREATE OR REPLACE FUNCTION public.toggle_post_emoji_reaction_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_emoji text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO public.post_emoji_reactions(id, post_id, user_id, emoji)
  VALUES (p_post_id, p_post_id, p_actor_id, p_emoji);
  RETURN pg_catalog.jsonb_build_object('status', 'added');
END
$function$;

CREATE OR REPLACE FUNCTION public.cast_post_poll_vote_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_option_indexes integer[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO public.poll_votes(id, poll_id, user_id, option_index)
  VALUES (p_post_id, p_post_id, p_actor_id, p_option_indexes[1]);
  RETURN pg_catalog.jsonb_build_object('status', 'added');
END
$function$;

CREATE OR REPLACE FUNCTION public.cast_post_poll_vote_expected_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_expected_poll_id uuid,
  p_option_indexes integer[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  INSERT INTO public.poll_votes(id, poll_id, user_id, option_index)
  VALUES (
    p_expected_poll_id,
    p_expected_poll_id,
    p_actor_id,
    p_option_indexes[1]
  );
  RETURN pg_catalog.jsonb_build_object('status', 'added', 'post_id', p_post_id);
END
$function$;

CREATE OR REPLACE FUNCTION public.save_post_bookmark_to_folder_atomic(
  p_post_id uuid,
  p_folder_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_actor_id uuid := (SELECT auth.uid());
BEGIN
  INSERT INTO public.post_bookmarks(id, post_id, user_id, folder_id)
  VALUES (p_post_id, p_post_id, v_actor_id, p_folder_id);
  RETURN pg_catalog.jsonb_build_object('status', 'added');
END
$function$;

CREATE OR REPLACE FUNCTION public.remove_post_bookmark_from_folder_atomic(
  p_post_id uuid,
  p_bookmark_id uuid,
  p_folder_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  DELETE FROM public.post_bookmarks AS bookmark
  WHERE bookmark.id = p_bookmark_id
    AND bookmark.post_id = p_post_id
    AND bookmark.user_id = (SELECT auth.uid())
    AND bookmark.folder_id = p_folder_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN pg_catalog.jsonb_build_object(
    'status',
    CASE WHEN v_deleted = 1 THEN 'removed' ELSE 'conflict' END
  );
END
$function$;

DO $function_acl$
DECLARE
  v_function regprocedure;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.toggle_post_reaction(uuid,uuid,text)'::regprocedure,
    'public.toggle_post_vote_atomic(uuid,uuid,text)'::regprocedure,
    'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)'::regprocedure,
    'public.toggle_post_emoji_reaction_atomic(uuid,uuid,text)'::regprocedure,
    'public.cast_post_poll_vote_atomic(uuid,uuid,integer[])'::regprocedure,
    'public.cast_post_poll_vote_expected_atomic(uuid,uuid,uuid,integer[])'::regprocedure
  ]
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, authenticator, service_role',
      v_function
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %s TO service_role',
      v_function
    );
  END LOOP;
END
$function_acl$;

REVOKE ALL ON FUNCTION public.save_post_bookmark_to_folder_atomic(uuid, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.save_post_bookmark_to_folder_atomic(uuid, uuid)
  TO authenticated;
REVOKE ALL ON FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid, uuid, uuid)
  TO authenticated;

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');

INSERT INTO public.post_likes(id, post_id, user_id, reaction_type) VALUES
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'up'),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'down');
INSERT INTO public.post_votes(id, post_id, user_id, choice) VALUES
  ('10000000-0000-4000-8000-000000000011', '20000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'bull'),
  ('10000000-0000-4000-8000-000000000012', '20000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'bear');
INSERT INTO public.post_bookmarks(id, post_id, user_id) VALUES
  ('10000000-0000-4000-8000-000000000021', '20000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111'),
  ('10000000-0000-4000-8000-000000000022', '20000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222');
INSERT INTO public.post_reactions(id, post_id, user_id, reaction_type) VALUES
  ('10000000-0000-4000-8000-000000000031', '20000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'up'),
  ('10000000-0000-4000-8000-000000000032', '20000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'down');
INSERT INTO public.post_emoji_reactions(id, post_id, user_id, emoji) VALUES
  ('10000000-0000-4000-8000-000000000041', '20000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '🔥'),
  ('10000000-0000-4000-8000-000000000042', '20000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '💎'),
  ('10000000-0000-4000-8000-000000000043', '20000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '🧨');
INSERT INTO public.comment_emoji_reactions(id, comment_id, user_id, emoji) VALUES
  ('10000000-0000-4000-8000-000000000051', '30000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '👍'),
  ('10000000-0000-4000-8000-000000000052', '30000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', '😂'),
  ('10000000-0000-4000-8000-000000000053', '30000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', '🛸');
INSERT INTO public.poll_votes(id, poll_id, user_id, option_index) VALUES
  ('10000000-0000-4000-8000-000000000061', '40000000-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 0),
  ('10000000-0000-4000-8000-000000000062', '40000000-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 1);
SQL

psql_cmd -f "$MIGRATION"

assert_scalar '2' "SELECT count(*) FROM public.interaction_emoji_reaction_quarantine"
assert_scalar '🛸|🧨' "SELECT string_agg(payload->>'emoji', '|' ORDER BY source_table) FROM public.interaction_emoji_reaction_quarantine"
assert_scalar '0' "SELECT count(*) FROM public.post_emoji_reactions WHERE emoji NOT IN ('👍','🔥','💎','🚀','❤️','👀','🎯','💰','📈','📉','🤔','😂')"
assert_scalar '0' "SELECT count(*) FROM public.comment_emoji_reactions WHERE emoji NOT IN ('👍','🔥','💎','🚀','❤️','👀','🎯','💰','📈','📉','🤔','😂')"
echo 'unsupported legacy emoji quarantined before validated allowlist'

own_counts="$(psql_cmd -At <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SELECT
  (SELECT count(*) FROM public.post_likes) || '|' ||
  (SELECT count(*) FROM public.post_votes) || '|' ||
  (SELECT count(*) FROM public.post_bookmarks) || '|' ||
  (SELECT count(*) FROM public.post_reactions) || '|' ||
  (SELECT count(*) FROM public.post_emoji_reactions) || '|' ||
  (SELECT count(*) FROM public.comment_emoji_reactions) || '|' ||
  (SELECT count(*) FROM public.poll_votes);
SQL
)"
[[ "$own_counts" == *'1|1|1|1|1|1|1' ]]
echo 'authenticated own-only interaction reads retained'

service_read_counts="$(psql_cmd -At <<'SQL'
SET ROLE service_role;
SELECT
  (SELECT count(*) FROM public.post_likes) || '|' ||
  (SELECT count(*) FROM public.post_votes) || '|' ||
  (SELECT count(*) FROM public.post_bookmarks) || '|' ||
  (SELECT count(*) FROM public.post_reactions) || '|' ||
  (SELECT count(*) FROM public.post_emoji_reactions) || '|' ||
  (SELECT count(*) FROM public.comment_emoji_reactions) || '|' ||
  (SELECT count(*) FROM public.poll_votes);
SQL
)"
[[ "$service_read_counts" == '2|2|2|2|2|2|2' ]]
echo 'service aggregate reads retained through explicit BYPASSRLS authority'

# A production account hard delete locks auth.users and then cascades into the
# interaction children. Hold that real sequence open and prove a replay waits
# at the parent lock (55P03) instead of taking a child lock first and deadlocking.
psql_cmd >"$TMP_ROOT/account-delete.out" 2>"$TMP_ROOT/account-delete.err" <<'SQL' &
BEGIN;
DELETE FROM auth.users
WHERE id = '22222222-2222-4222-8222-222222222222'::uuid;
SELECT pg_catalog.pg_sleep(7);
ROLLBACK;
SQL
account_delete_pid=$!

account_delete_ready='0'
for _ in {1..50}; do
  account_delete_ready="$(psql_cmd -At -c "
    SELECT CASE WHEN EXISTS (
      SELECT 1
      FROM pg_catalog.pg_locks AS parent_lock
      JOIN pg_catalog.pg_locks AS child_lock
        ON child_lock.pid = parent_lock.pid
      WHERE parent_lock.relation = 'auth.users'::regclass
        AND parent_lock.mode = 'RowExclusiveLock'
        AND parent_lock.granted
        AND child_lock.relation = 'public.post_likes'::regclass
        AND child_lock.mode = 'RowExclusiveLock'
        AND child_lock.granted
    ) THEN 1 ELSE 0 END
  ")"
  [[ "$account_delete_ready" == '1' ]] && break
  sleep 0.1
done
if [[ "$account_delete_ready" != '1' ]]; then
  echo 'account-delete lock sequence was not observed' >&2
  wait "$account_delete_pid" || true
  cat "$TMP_ROOT/account-delete.err" >&2
  exit 1
fi

if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/account-delete-migration.err"; then
  echo 'migration unexpectedly passed through an active account delete' >&2
  wait "$account_delete_pid" || true
  exit 1
fi
grep -q 'canceling statement due to lock timeout' "$TMP_ROOT/account-delete-migration.err"
if grep -q 'deadlock detected' "$TMP_ROOT/account-delete-migration.err"; then
  echo 'migration/account-delete lock order deadlocked' >&2
  cat "$TMP_ROOT/account-delete-migration.err" >&2
  wait "$account_delete_pid" || true
  exit 1
fi
wait "$account_delete_pid"
psql_cmd -f "$MIGRATION"
echo 'account deletion and migration use parent-to-child lock ordering'

psql_cmd -c 'ALTER ROLE authenticated BYPASSRLS'
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/browser-bypass-migration.err"; then
  echo 'migration accepted authenticated BYPASSRLS drift' >&2
  exit 1
fi
grep -q 'browser roles must remain NOSUPERUSER NOBYPASSRLS' "$TMP_ROOT/browser-bypass-migration.err"
if psql_cmd -f "$ATTESTATION" >/dev/null 2>"$TMP_ROOT/browser-bypass-attestation.err"; then
  echo 'production attestation accepted authenticated BYPASSRLS drift' >&2
  exit 1
fi
grep -q 'browser roles must remain NOSUPERUSER NOBYPASSRLS' "$TMP_ROOT/browser-bypass-attestation.err"
psql_cmd -c 'ALTER ROLE authenticated NOBYPASSRLS'

psql_cmd -c 'ALTER ROLE authenticated SUPERUSER'
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/browser-superuser-migration.err"; then
  echo 'migration accepted authenticated SUPERUSER drift' >&2
  exit 1
fi
grep -q 'browser roles must remain NOSUPERUSER NOBYPASSRLS' "$TMP_ROOT/browser-superuser-migration.err"
if psql_cmd -f "$ATTESTATION" >/dev/null 2>"$TMP_ROOT/browser-superuser-attestation.err"; then
  echo 'production attestation accepted authenticated SUPERUSER drift' >&2
  exit 1
fi
grep -q 'browser roles must remain NOSUPERUSER NOBYPASSRLS' "$TMP_ROOT/browser-superuser-attestation.err"
psql_cmd -c 'ALTER ROLE authenticated NOSUPERUSER'
echo 'browser SUPERUSER and BYPASSRLS drift fail closed'

psql_cmd -c '
  ALTER TABLE public.post_reactions
    DROP CONSTRAINT post_reactions_post_id_user_id_key
'
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/unique-key-migration.err"; then
  echo 'migration accepted a missing controlled-writer unique key' >&2
  exit 1
fi
grep -q 'requires a valid exact UNIQUE key' "$TMP_ROOT/unique-key-migration.err"
if psql_cmd -f "$ATTESTATION" >/dev/null 2>"$TMP_ROOT/unique-key-attestation.err"; then
  echo 'production attestation accepted a missing controlled-writer unique key' >&2
  exit 1
fi
grep -q 'exact UNIQUE key drifted' "$TMP_ROOT/unique-key-attestation.err"
psql_cmd -c '
  ALTER TABLE public.post_reactions
    ADD CONSTRAINT post_reactions_post_id_user_id_key UNIQUE (post_id, user_id)
'
psql_cmd -f "$MIGRATION"
echo 'controlled-writer exact unique-key drift fails closed'

expect_42501 'anonymous raw identity read' <<'SQL'
\set VERBOSITY verbose
SET ROLE anon;
SELECT * FROM public.post_likes;
SQL

ACTOR='11111111-1111-4111-8111-111111111111'
while IFS='|' read -r table insert_sql; do
  [[ -z "$table" ]] && continue

  expect_42501 "$table authenticated insert" <<SQL
\set VERBOSITY verbose
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '$ACTOR', false);
$insert_sql
SQL

  expect_42501 "$table authenticated update" <<SQL
\set VERBOSITY verbose
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '$ACTOR', false);
UPDATE public.$table SET user_id = user_id WHERE user_id = '$ACTOR'::uuid;
SQL

  expect_42501 "$table authenticated delete" <<SQL
\set VERBOSITY verbose
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '$ACTOR', false);
DELETE FROM public.$table WHERE user_id = '$ACTOR'::uuid;
SQL
done <<'CASES'
post_likes|INSERT INTO public.post_likes VALUES ('90000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000101','11111111-1111-4111-8111-111111111111','up');
post_votes|INSERT INTO public.post_votes VALUES ('90000000-0000-4000-8000-000000000002','90000000-0000-4000-8000-000000000102','11111111-1111-4111-8111-111111111111','bull');
post_bookmarks|INSERT INTO public.post_bookmarks(id,post_id,user_id) VALUES ('90000000-0000-4000-8000-000000000003','90000000-0000-4000-8000-000000000103','11111111-1111-4111-8111-111111111111');
post_reactions|INSERT INTO public.post_reactions VALUES ('90000000-0000-4000-8000-000000000004','90000000-0000-4000-8000-000000000104','11111111-1111-4111-8111-111111111111','up');
post_emoji_reactions|INSERT INTO public.post_emoji_reactions VALUES ('90000000-0000-4000-8000-000000000005','90000000-0000-4000-8000-000000000105','11111111-1111-4111-8111-111111111111','🔥');
comment_emoji_reactions|INSERT INTO public.comment_emoji_reactions VALUES ('90000000-0000-4000-8000-000000000006','90000000-0000-4000-8000-000000000106','11111111-1111-4111-8111-111111111111','👍');
poll_votes|INSERT INTO public.poll_votes VALUES ('90000000-0000-4000-8000-000000000007','90000000-0000-4000-8000-000000000107','11111111-1111-4111-8111-111111111111',0);
CASES
echo 'raw browser interaction INSERT UPDATE DELETE denied'

assert_scalar '0' "
  SELECT count(*)
  FROM unnest(ARRAY['post_likes','post_votes','post_bookmarks','post_reactions','post_emoji_reactions','comment_emoji_reactions','poll_votes']) AS target(table_name)
  CROSS JOIN unnest(ARRAY['anon','authenticated','authenticator']) AS actor(role_name)
  CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS permission(privilege_name)
  WHERE has_table_privilege(actor.role_name, 'public.' || target.table_name, permission.privilege_name)
"
assert_scalar '0' "
  SELECT count(*)
  FROM unnest(ARRAY['post_likes','post_votes','post_bookmarks','post_reactions','post_emoji_reactions','comment_emoji_reactions','poll_votes']) AS target(table_name)
  CROSS JOIN unnest(ARRAY['anon','authenticated','authenticator']) AS actor(role_name)
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass('public.' || target.table_name)
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  CROSS JOIN unnest(ARRAY['INSERT','UPDATE','REFERENCES']) AS permission(privilege_name)
  WHERE has_column_privilege(actor.role_name, attribute.attrelid, attribute.attname, permission.privilege_name)
"
echo 'table and column mutation ACLs closed'

service_result="$(psql_cmd -At <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.concat_ws(
  '|',
  public.toggle_post_reaction(
    '50000000-0000-4000-8000-000000000001',
    '11111111-1111-4111-8111-111111111111',
    'up'
  )->>'status',
  public.toggle_post_vote_atomic(
    '11111111-1111-4111-8111-111111111111',
    '50000000-0000-4000-8000-000000000011',
    'bull'
  )->>'status',
  public.toggle_post_bookmark_atomic(
    '11111111-1111-4111-8111-111111111111',
    '50000000-0000-4000-8000-000000000021',
    NULL::uuid
  )->>'status',
  public.toggle_post_emoji_reaction_atomic(
    '11111111-1111-4111-8111-111111111111',
    '50000000-0000-4000-8000-000000000031',
    '🎯'
  )->>'status',
  public.cast_post_poll_vote_atomic(
    '11111111-1111-4111-8111-111111111111',
    '50000000-0000-4000-8000-000000000041',
    ARRAY[0]
  )->>'status',
  public.cast_post_poll_vote_expected_atomic(
    '11111111-1111-4111-8111-111111111111',
    '50000000-0000-4000-8000-000000000051',
    '50000000-0000-4000-8000-000000000052',
    ARRAY[1]
  )->>'status'
);
SQL
)"
[[ "$service_result" == *'added|added|added|added|added|added' ]]

folder_result="$(psql_cmd -At <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', false);
SELECT public.save_post_bookmark_to_folder_atomic(
  '50000000-0000-4000-8000-000000000061',
  '60000000-0000-4000-8000-000000000001'
)->>'status';
SELECT public.remove_post_bookmark_from_folder_atomic(
  '50000000-0000-4000-8000-000000000061',
  '50000000-0000-4000-8000-000000000061',
  '60000000-0000-4000-8000-000000000001'
)->>'status';
SQL
)"
[[ "$folder_result" == *$'added\nremoved' ]]
assert_scalar '1|1|1|1|2|0' "
  SELECT
    (SELECT count(*) FROM public.post_likes
     WHERE id = '50000000-0000-4000-8000-000000000001') || '|' ||
    (SELECT count(*) FROM public.post_votes
     WHERE id = '50000000-0000-4000-8000-000000000011') || '|' ||
    (SELECT count(*) FROM public.post_bookmarks
     WHERE id = '50000000-0000-4000-8000-000000000021') || '|' ||
    (SELECT count(*) FROM public.post_emoji_reactions
     WHERE id = '50000000-0000-4000-8000-000000000031') || '|' ||
    (SELECT count(*) FROM public.poll_votes
     WHERE id IN (
       '50000000-0000-4000-8000-000000000041',
       '50000000-0000-4000-8000-000000000052'
     )) || '|' ||
    (SELECT count(*) FROM public.post_bookmarks
     WHERE id = '50000000-0000-4000-8000-000000000061')
"
echo 'all eight postgres-owner SECURITY DEFINER interaction RPCs retained'

psql_cmd <<'SQL'
DROP POLICY post_likes_select_own_canonical ON public.post_likes;
CREATE POLICY post_likes_select_own_canonical
  ON public.post_likes
  FOR SELECT
  TO authenticated
  USING (user_id = user_id AND (SELECT auth.uid()) IS NOT NULL);
SQL
if psql_cmd -f "$ATTESTATION" >/dev/null 2>"$TMP_ROOT/wide-policy-attestation.err"; then
  echo 'production attestation accepted a semantically broad own-row policy' >&2
  exit 1
fi
grep -q 'own-only SELECT policy drifted' "$TMP_ROOT/wide-policy-attestation.err"
psql_cmd -f "$MIGRATION"

psql_cmd <<'SQL'
ALTER TABLE public.post_emoji_reactions
  DROP CONSTRAINT post_emoji_reactions_emoji_allowlist_check;
ALTER TABLE public.post_emoji_reactions
  ADD CONSTRAINT post_emoji_reactions_emoji_allowlist_check
  CHECK (
    emoji = ANY (
      '{👍,🔥,💎,🚀,❤️,👀,🎯,💰,📈,📉,🤔,😂,🪄}'::text[]
    )
  );
SQL
if psql_cmd -f "$ATTESTATION" >/dev/null 2>"$TMP_ROOT/wide-emoji-attestation.err"; then
  echo 'production attestation accepted a widened emoji allowlist' >&2
  exit 1
fi
grep -q 'emoji allowlist definition drifted' "$TMP_ROOT/wide-emoji-attestation.err"
psql_cmd -f "$MIGRATION"
echo 'exact policy and emoji allowlist semantics are attested'

psql_cmd <<'SQL'
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.post_likes
  TO PUBLIC, anon, authenticated, authenticator;
GRANT UPDATE (reaction_type) ON TABLE public.post_likes TO authenticated;
CREATE POLICY post_likes_drift_all
  ON public.post_likes FOR ALL TO PUBLIC USING (true) WITH CHECK (true);
ALTER TABLE public.post_votes DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_emoji_reactions
  DROP CONSTRAINT post_emoji_reactions_emoji_allowlist_check;
INSERT INTO public.post_emoji_reactions(id, post_id, user_id, emoji)
VALUES (
  '10000000-0000-4000-8000-000000000043',
  '20000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-111111111111',
  '🪄'
);
ALTER TABLE public.poll_votes FORCE ROW LEVEL SECURITY;

CREATE ROLE leaked_quarantine_acl NOLOGIN;
GRANT TRUNCATE
  ON TABLE public.interaction_emoji_reaction_quarantine
  TO leaked_quarantine_acl;
GRANT SELECT (payload), INSERT (payload_fingerprint)
  ON TABLE public.interaction_emoji_reaction_quarantine
  TO leaked_quarantine_acl;
GRANT leaked_quarantine_acl TO authenticated;
GRANT UPDATE (payload)
  ON TABLE public.interaction_emoji_reaction_quarantine
  TO service_role;
SQL

psql_cmd -f "$MIGRATION"
echo 'migration replay converged arbitrary ACL policy RLS and emoji drift'

assert_scalar '7' "
  SELECT count(*)
  FROM pg_catalog.pg_policy AS policy_row
  WHERE policy_row.polrelid IN (
    'public.post_likes'::regclass,
    'public.post_votes'::regclass,
    'public.post_bookmarks'::regclass,
    'public.post_reactions'::regclass,
    'public.post_emoji_reactions'::regclass,
    'public.comment_emoji_reactions'::regclass,
    'public.poll_votes'::regclass
  )
    AND policy_row.polcmd = 'r'
    AND policy_row.polname LIKE '%_select_own_canonical'
"
assert_scalar '3' "SELECT count(*) FROM public.interaction_emoji_reaction_quarantine"
assert_scalar '2|2|0' "
  SELECT
    count(*) || '|' ||
    count(DISTINCT payload_fingerprint) || '|' ||
    count(*) FILTER (
      WHERE payload_fingerprint IS DISTINCT FROM md5(payload::text)
    )
  FROM public.interaction_emoji_reaction_quarantine
  WHERE source_table = 'post_emoji_reactions'
    AND source_id = '10000000-0000-4000-8000-000000000043'
"
assert_scalar '🧨|🪄' "
  SELECT string_agg(payload->>'emoji', '|' ORDER BY payload->>'emoji')
  FROM public.interaction_emoji_reaction_quarantine
  WHERE source_table = 'post_emoji_reactions'
    AND source_id = '10000000-0000-4000-8000-000000000043'
"
assert_scalar '0' "SELECT count(*) FROM public.post_emoji_reactions WHERE emoji = '🪄'"
assert_scalar '0' "
  SELECT count(*)
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid IN (
    'public.post_likes'::regclass,
    'public.post_votes'::regclass,
    'public.post_bookmarks'::regclass,
    'public.post_reactions'::regclass,
    'public.post_emoji_reactions'::regclass,
    'public.comment_emoji_reactions'::regclass,
    'public.poll_votes'::regclass
  )
    AND (NOT relation.relrowsecurity OR relation.relforcerowsecurity)
"
assert_scalar '0' "
  SELECT count(*)
  FROM (
    VALUES
      (has_table_privilege(
        'authenticated',
        'public.interaction_emoji_reaction_quarantine',
        'TRUNCATE'
      )),
      (has_column_privilege(
        'authenticated',
        'public.interaction_emoji_reaction_quarantine',
        'payload',
        'SELECT'
      )),
      (has_column_privilege(
        'authenticated',
        'public.interaction_emoji_reaction_quarantine',
        'payload_fingerprint',
        'INSERT'
      )),
      (has_column_privilege(
        'service_role',
        'public.interaction_emoji_reaction_quarantine',
        'payload',
        'UPDATE'
      ))
  ) AS leaked_privilege(is_granted)
  WHERE is_granted
"
echo 'quarantine UUID reuse preserves versioned evidence and inherited ACL drift closes'

psql_cmd -f "$ATTESTATION" >/dev/null
echo 'production attestation covers extant optional interaction relations'

psql_cmd <<'SQL'
DROP TABLE public.post_reactions;
DROP TABLE public.comment_emoji_reactions;
SQL
psql_cmd -f "$MIGRATION"
psql_cmd -f "$ATTESTATION"
assert_scalar '' "SELECT pg_catalog.to_regclass('public.post_reactions')"
assert_scalar '' "SELECT pg_catalog.to_regclass('public.comment_emoji_reactions')"
echo 'optional historical interaction relations may be safely absent'
echo 'production read-only boundary attestation passed'

psql_cmd -c "DELETE FROM auth.users WHERE id='11111111-1111-4111-8111-111111111111'::uuid"
assert_scalar '0' "SELECT count(*) FROM public.interaction_emoji_reaction_quarantine"
assert_scalar '0' "
  SELECT
    (SELECT count(*) FROM public.post_likes
     WHERE user_id = '11111111-1111-4111-8111-111111111111') +
    (SELECT count(*) FROM public.post_votes
     WHERE user_id = '11111111-1111-4111-8111-111111111111') +
    (SELECT count(*) FROM public.post_bookmarks
     WHERE user_id = '11111111-1111-4111-8111-111111111111') +
    (SELECT count(*) FROM public.post_emoji_reactions
     WHERE user_id = '11111111-1111-4111-8111-111111111111') +
    (SELECT count(*) FROM public.poll_votes
     WHERE user_id = '11111111-1111-4111-8111-111111111111')
"
echo 'source and quarantined identity rows follow account hard deletion'

echo 'post interaction child direct-write closure PostgreSQL 17 proof passed'
