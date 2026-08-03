#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EDIT_MIGRATION="$ROOT_DIR/supabase/migrations/20260729183500_atomic_post_edit.sql"
UPDATE_CLOSURE="$ROOT_DIR/supabase/migrations/20260729184000_close_post_direct_writes.sql"
CREATE_MIGRATION="$ROOT_DIR/supabase/migrations/20260729184500_atomic_post_create.sql"
CLOSURE_MIGRATION="$ROOT_DIR/supabase/migrations/20260729185000_close_post_create_direct_writes.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/close-post-create-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="$((56500 + ($$ % 700)))"

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
"$PG_BIN/initdb" -D "$PGDATA" --auth=trust --username=postgres --no-locale --encoding=UTF8 >/dev/null
"$PG_BIN/pg_ctl" -D "$PGDATA" -o "-F -k $SOCKET_DIR -p $PORT" -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -q -h "$SOCKET_DIR" -p "$PORT" -U postgres postgres "$@"
}

psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
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

CREATE TYPE public.post_status AS ENUM ('active', 'locked', 'deleted');

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id),
  handle text NOT NULL UNIQUE,
  reputation_score integer DEFAULT 0,
  is_verified_trader boolean DEFAULT false,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  dissolved_at timestamptz
);
CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  muted_until timestamptz,
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.group_bans (
  group_id uuid NOT NULL REFERENCES public.groups(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.group_subscriptions (
  group_id uuid NOT NULL REFERENCES public.groups(id),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'active',
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.subscriptions (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  status text NOT NULL DEFAULT 'active'
);

CREATE TABLE public.posts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  author_id uuid NOT NULL REFERENCES auth.users(id),
  author_handle text,
  author_arena_score integer DEFAULT 0,
  author_is_verified boolean DEFAULT false,
  group_id uuid REFERENCES public.groups(id),
  title text,
  content text,
  images text[],
  poll_enabled boolean DEFAULT false,
  poll_id uuid,
  visibility text NOT NULL DEFAULT 'public',
  is_sensitive boolean DEFAULT false,
  content_warning text,
  language text DEFAULT 'zh',
  mentions text[] DEFAULT '{}',
  hashtags text[] DEFAULT '{}',
  is_pinned boolean DEFAULT false,
  status public.post_status NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);
CREATE TABLE public.polls (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  post_id uuid REFERENCES public.posts(id) ON DELETE CASCADE,
  question text NOT NULL,
  options json NOT NULL DEFAULT '[]'::json,
  type text,
  end_at timestamptz,
  created_at timestamptz DEFAULT pg_catalog.statement_timestamp(),
  updated_at timestamptz DEFAULT pg_catalog.statement_timestamp()
);
ALTER TABLE public.posts
  ADD CONSTRAINT posts_poll_id_fkey
  FOREIGN KEY (poll_id) REFERENCES public.polls(id) ON DELETE SET NULL;

CREATE TABLE public.hashtags (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  tag text NOT NULL UNIQUE,
  post_count integer DEFAULT 0
);
CREATE TABLE public.post_hashtags (
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  hashtag_id uuid NOT NULL REFERENCES public.hashtags(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, hashtag_id)
);

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.polls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.polls FORCE ROW LEVEL SECURITY;
ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hashtags FORCE ROW LEVEL SECURITY;
ALTER TABLE public.post_hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_hashtags FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_read ON public.posts
  FOR SELECT TO anon, authenticated, authenticator USING (true);
CREATE POLICY browser_read ON public.polls
  FOR SELECT TO anon, authenticated, authenticator USING (true);
CREATE POLICY browser_read ON public.hashtags
  FOR SELECT TO anon, authenticated, authenticator USING (true);
CREATE POLICY browser_read ON public.post_hashtags
  FOR SELECT TO anon, authenticated, authenticator USING (true);

CREATE OR REPLACE FUNCTION public.has_current_group_entitlement(uuid, uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $function$ SELECT true $function$;

CREATE OR REPLACE FUNCTION public.enforce_current_group_post_publish()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_posts_15_current_group_publish
BEFORE INSERT OR UPDATE ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.enforce_current_group_post_publish();

CREATE OR REPLACE FUNCTION public.set_post_pin_state_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_is_pinned boolean
)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT pg_catalog.jsonb_build_object('success', false)
$function$;
ALTER FUNCTION public.set_post_pin_state_atomic(uuid, uuid, boolean)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.recount_hashtag_posts(hashtag_ids uuid[])
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $function$
  UPDATE hashtags h
  SET post_count = COALESCE(sub.cnt, 0)
  FROM (
    SELECT hashtag_id, count(*)::int AS cnt
    FROM post_hashtags
    WHERE hashtag_id = ANY(hashtag_ids)
    GROUP BY hashtag_id
  ) sub
  WHERE h.id = sub.hashtag_id;
$function$;

GRANT USAGE ON SCHEMA public, auth
  TO anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role()
  TO authenticated, service_role;
GRANT SELECT ON TABLE public.posts,
  public.polls,
  public.hashtags,
  public.post_hashtags
  TO anon, authenticated, authenticator, service_role;
GRANT INSERT, UPDATE, DELETE ON TABLE public.posts,
  public.polls,
  public.hashtags,
  public.post_hashtags
  TO service_role;
SQL

psql_cmd -f "$EDIT_MIGRATION"
psql_cmd -f "$UPDATE_CLOSURE"
psql_cmd -f "$CREATE_MIGRATION"

ACTOR="11111111-1111-4111-8111-111111111111"
DUPLICATE_POST="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1"
LINK_POST_A="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2"
LINK_POST_B="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3"
FLAG_POST="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4"

psql_cmd -v actor="$ACTOR" <<'SQL'
INSERT INTO auth.users (id) VALUES (:'actor');
INSERT INTO public.user_profiles (
  id, handle, reputation_score, is_verified_trader
) VALUES (:'actor', 'alice', 42, true);
SQL

# Duplicate post_id values must abort before the unique index, triggers, or ACL
# cutover can become visible.
psql_cmd -v actor="$ACTOR" -v post="$DUPLICATE_POST" <<'SQL'
INSERT INTO public.posts (
  id, author_id, title, content, poll_enabled
) VALUES (:'post', :'actor', 'duplicate fixture', 'body', true);
INSERT INTO public.polls (post_id, question, options)
VALUES
  (:'post', 'one', '[{"text":"yes"}]'::json),
  (:'post', 'two', '[{"text":"no"}]'::json);
SQL
if psql_cmd -f "$CLOSURE_MIGRATION" >"$TMP_ROOT/duplicate.out" 2>"$TMP_ROOT/duplicate.err"; then
  echo 'duplicate historical polls unexpectedly migrated' >&2
  exit 1
fi
grep -q 'duplicate custom polls exist for one post' "$TMP_ROOT/duplicate.err" || {
  cat "$TMP_ROOT/duplicate.err" >&2
  exit 1
}
[[ "$(psql_cmd -At -c "SELECT pg_catalog.to_regclass('public.polls_one_custom_per_post_idx') IS NULL")" == 't' ]]
[[ "$(psql_cmd -At -c "SELECT pg_catalog.has_column_privilege('authenticated', 'public.posts', 'poll_id', 'UPDATE')")" == 't' ]]
echo 'duplicate migration rollback'
psql_cmd -v post="$DUPLICATE_POST" <<'SQL'
DELETE FROM public.polls WHERE post_id = :'post';
DELETE FROM public.posts WHERE id = :'post';
SQL

# A post pointing at a poll owned by another post must also abort without any
# repair or partial DDL.
psql_cmd -v actor="$ACTOR" -v post_a="$LINK_POST_A" -v post_b="$LINK_POST_B" <<'SQL'
INSERT INTO public.posts (id, author_id, title, content, poll_enabled)
VALUES
  (:'post_a', :'actor', 'link a', 'body', true),
  (:'post_b', :'actor', 'link b', 'body', true);
INSERT INTO public.polls (post_id, question, options)
VALUES (:'post_b', 'cross linked', '[{"text":"yes"}]'::json);
UPDATE public.posts
SET poll_id = (SELECT id FROM public.polls WHERE post_id = :'post_b')
WHERE id = :'post_a';
SQL
if psql_cmd -f "$CLOSURE_MIGRATION" >"$TMP_ROOT/link.out" 2>"$TMP_ROOT/link.err"; then
  echo 'historical link drift unexpectedly migrated' >&2
  exit 1
fi
grep -q 'post and custom poll links are not bidirectionally consistent' "$TMP_ROOT/link.err" || {
  cat "$TMP_ROOT/link.err" >&2
  exit 1
}
[[ "$(psql_cmd -At -c "SELECT pg_catalog.to_regclass('public.polls_one_custom_per_post_idx') IS NULL")" == 't' ]]
echo 'link drift migration rollback'
psql_cmd -v post_a="$LINK_POST_A" -v post_b="$LINK_POST_B" <<'SQL'
UPDATE public.posts SET poll_id = NULL WHERE id = :'post_a';
DELETE FROM public.polls WHERE post_id = :'post_b';
DELETE FROM public.posts WHERE id IN (:'post_a', :'post_b');
SQL

# A fully linked custom poll on a false poll_enabled flag is not guessed into
# a new state; the entire migration rolls back.
psql_cmd -v actor="$ACTOR" -v post="$FLAG_POST" <<'SQL'
INSERT INTO public.posts (id, author_id, title, content, poll_enabled)
VALUES (:'post', :'actor', 'flag drift', 'body', false);
INSERT INTO public.polls (post_id, question, options)
VALUES (:'post', 'disabled custom', '[{"text":"yes"}]'::json);
UPDATE public.posts
SET poll_id = (SELECT id FROM public.polls WHERE post_id = :'post')
WHERE id = :'post';
SQL
if psql_cmd -f "$CLOSURE_MIGRATION" >"$TMP_ROOT/flag.out" 2>"$TMP_ROOT/flag.err"; then
  echo 'historical poll-enabled drift unexpectedly migrated' >&2
  exit 1
fi
grep -q 'custom poll exists for a post that is not poll-enabled' "$TMP_ROOT/flag.err" || {
  cat "$TMP_ROOT/flag.err" >&2
  exit 1
}
[[ "$(psql_cmd -At -c "SELECT pg_catalog.to_regclass('public.polls_one_custom_per_post_idx') IS NULL")" == 't' ]]
echo 'poll-enabled drift migration rollback'
psql_cmd -v post="$FLAG_POST" <<'SQL'
UPDATE public.posts SET poll_id = NULL WHERE id = :'post';
DELETE FROM public.polls WHERE post_id = :'post';
DELETE FROM public.posts WHERE id = :'post';
SQL

# Model both stale table grants and stale column grants. The postdeploy
# migration must converge these without removing SELECT or service writes.
psql_cmd <<'SQL'
GRANT INSERT, UPDATE, DELETE ON TABLE public.posts,
  public.polls,
  public.hashtags,
  public.post_hashtags
  TO PUBLIC, anon, authenticated, authenticator;
GRANT INSERT (title), UPDATE (poll_id)
  ON TABLE public.posts TO authenticated;
GRANT INSERT (question), UPDATE (post_id)
  ON TABLE public.polls TO anon;
GRANT INSERT (tag), UPDATE (post_count)
  ON TABLE public.hashtags TO authenticator;
GRANT INSERT (post_id), UPDATE (hashtag_id)
  ON TABLE public.post_hashtags TO PUBLIC;
SQL

psql_cmd -f "$CLOSURE_MIGRATION"
psql_cmd -f "$CLOSURE_MIGRATION"
echo 'migration replay'

if psql_cmd -v actor="$ACTOR" >/dev/null 2>"$TMP_ROOT/create-rpc.err" <<'SQL'
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT public.create_post_atomic(
  :'actor',
  '10000000-0000-4000-8000-000000000001',
  'browser bypass',
  'body',
  NULL,
  ARRAY[]::text[],
  false,
  NULL,
  NULL,
  NULL,
  'public',
  false,
  NULL,
  'en',
  ARRAY[]::text[],
  ARRAY[]::text[]
);
SQL
then
  echo 'authenticated create RPC unexpectedly succeeded' >&2
  exit 1
fi
grep -qi 'permission denied' "$TMP_ROOT/create-rpc.err"

if psql_cmd >/dev/null 2>"$TMP_ROOT/recount-rpc.err" <<'SQL'
SET ROLE authenticated;
SELECT public.recount_hashtag_posts(ARRAY[]::uuid[]);
SQL
then
  echo 'authenticated hashtag recount unexpectedly succeeded' >&2
  exit 1
fi
grep -qi 'permission denied' "$TMP_ROOT/recount-rpc.err"
echo 'browser authorities revoked'

OPERATION="10000000-0000-4000-8000-000000000002"
created="$(psql_cmd -At -v actor="$ACTOR" -v operation="$OPERATION" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.create_post_atomic(
  :'actor',
  :'operation',
  'service create',
  'body with #btc',
  NULL,
  ARRAY[]::text[],
  true,
  ARRAY['Yes', 'No']::text[],
  'single',
  24,
  'public',
  false,
  NULL,
  'en',
  ARRAY[]::text[],
  ARRAY['btc']::text[]
);
SQL
)"
grep -q '"status": "created"' <<<"$created"
grep -q '"poll_enabled": true' <<<"$created"
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.posts AS p JOIN public.polls AS q ON q.id = p.poll_id AND q.post_id = p.id WHERE p.title = 'service create'")" == '1' ]]

replayed="$(psql_cmd -At -v actor="$ACTOR" -v operation="$OPERATION" <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.create_post_atomic(
  :'actor',
  :'operation',
  'service create',
  'body with #btc',
  NULL,
  ARRAY[]::text[],
  true,
  ARRAY['Yes', 'No']::text[],
  'single',
  24,
  'public',
  false,
  NULL,
  'en',
  ARRAY[]::text[],
  ARRAY['btc']::text[]
);
SQL
)"
grep -q '"status": "replayed"' <<<"$replayed"
grep -q '"applied": false' <<<"$replayed"
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.posts WHERE title = 'service create'")" == '1' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.post_create_operation_results WHERE operation_id = '$OPERATION'::uuid")" == '1' ]]
echo 'service lost acknowledgement replay retained'

psql_cmd <<'SQL'
SET ROLE service_role;
SELECT public.recount_hashtag_posts(
  ARRAY(SELECT id FROM public.hashtags WHERE tag = 'btc')
);
SQL
[[ "$(psql_cmd -At -c "SELECT post_count FROM public.hashtags WHERE tag = 'btc'")" == '1' ]]
echo 'service atomic create retained'

expect_authenticated_denied() {
  local label="$1"
  local statement="$2"
  if psql_cmd >/dev/null 2>"$TMP_ROOT/$label.err" <<SQL
SET ROLE authenticated;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'authenticated', false);
SELECT pg_catalog.set_config('request.jwt.claim.sub', '$ACTOR', false);
$statement
SQL
  then
    echo "authenticated direct DML unexpectedly succeeded: $label" >&2
    exit 1
  fi
  grep -qi 'permission denied' "$TMP_ROOT/$label.err"
}

SERVICE_POST="$(psql_cmd -At -c "SELECT id FROM public.posts WHERE title = 'service create'")"
SERVICE_POLL="$(psql_cmd -At -c "SELECT poll_id FROM public.posts WHERE id = '$SERVICE_POST'::uuid")"
SERVICE_TAG="$(psql_cmd -At -c "SELECT id FROM public.hashtags WHERE tag = 'btc'")"

expect_authenticated_denied post_insert \
  "INSERT INTO public.posts (author_id, title, content) VALUES ('$ACTOR', 'x', 'x');"
expect_authenticated_denied post_update \
  "UPDATE public.posts SET poll_id = NULL WHERE id = '$SERVICE_POST';"
expect_authenticated_denied post_delete \
  "DELETE FROM public.posts WHERE id = '$SERVICE_POST';"
expect_authenticated_denied poll_insert \
  "INSERT INTO public.polls (post_id, question) VALUES (NULL, 'x');"
expect_authenticated_denied poll_update \
  "UPDATE public.polls SET question = 'x' WHERE id = '$SERVICE_POLL';"
expect_authenticated_denied poll_delete \
  "DELETE FROM public.polls WHERE id = '$SERVICE_POLL';"
expect_authenticated_denied hashtag_insert \
  "INSERT INTO public.hashtags (tag) VALUES ('bypass');"
expect_authenticated_denied hashtag_update \
  "UPDATE public.hashtags SET post_count = 0 WHERE id = '$SERVICE_TAG';"
expect_authenticated_denied hashtag_delete \
  "DELETE FROM public.hashtags WHERE id = '$SERVICE_TAG';"
expect_authenticated_denied post_hashtag_insert \
  "INSERT INTO public.post_hashtags (post_id, hashtag_id) VALUES ('$SERVICE_POST', '$SERVICE_TAG');"
expect_authenticated_denied post_hashtag_update \
  "UPDATE public.post_hashtags SET hashtag_id = '$SERVICE_TAG' WHERE post_id = '$SERVICE_POST';"
expect_authenticated_denied post_hashtag_delete \
  "DELETE FROM public.post_hashtags WHERE post_id = '$SERVICE_POST';"

auth_select="$(psql_cmd -At <<'SQL'
SET ROLE authenticated;
SELECT count(*) FROM public.posts;
SQL
)"
[[ "$auth_select" -ge 1 ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM pg_catalog.pg_class WHERE oid IN ('public.posts'::regclass, 'public.polls'::regclass, 'public.hashtags'::regclass, 'public.post_hashtags'::regclass) AND relrowsecurity AND relforcerowsecurity")" == '4' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid IN ('public.posts'::regclass, 'public.polls'::regclass, 'public.hashtags'::regclass, 'public.post_hashtags'::regclass) AND polcmd = 'r'")" == '4' ]]
echo 'select and RLS retained'
echo 'browser post poll and hashtag DML revoked'

# A valid raw transaction follows the same post -> poll -> backlink order as
# create_post_atomic and therefore proves the checks are actually deferred.
LEGAL_POST="20000000-0000-4000-8000-000000000001"
LEGAL_POLL="20000000-0000-4000-8000-000000000002"
psql_cmd -v actor="$ACTOR" -v post="$LEGAL_POST" -v poll="$LEGAL_POLL" <<'SQL'
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
INSERT INTO public.posts (
  id, author_id, title, content, poll_enabled
) VALUES (:'post', :'actor', 'legal deferred', 'body', true);
INSERT INTO public.polls (id, post_id, question, options)
VALUES (:'poll', :'post', 'legal', '[{"text":"yes"}]'::json);
UPDATE public.posts SET poll_id = :'poll' WHERE id = :'post';
COMMIT;
SQL
echo 'service cron direct writes retained'

if psql_cmd -v actor="$ACTOR" >/dev/null 2>"$TMP_ROOT/wrong-link.err" <<'SQL'
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
INSERT INTO public.posts (id, author_id, title, content, poll_enabled)
VALUES
  ('30000000-0000-4000-8000-000000000001', :'actor', 'wrong a', 'body', true),
  ('30000000-0000-4000-8000-000000000002', :'actor', 'wrong b', 'body', true);
INSERT INTO public.polls (id, post_id, question, options)
VALUES (
  '30000000-0000-4000-8000-000000000003',
  '30000000-0000-4000-8000-000000000002',
  'wrong',
  '[{"text":"yes"}]'::json
);
UPDATE public.posts
SET poll_id = '30000000-0000-4000-8000-000000000003'
WHERE id = '30000000-0000-4000-8000-000000000001';
COMMIT;
SQL
then
  echo 'deferred wrong link unexpectedly committed' >&2
  exit 1
fi
grep -q 'post and custom poll must be bidirectionally consistent' "$TMP_ROOT/wrong-link.err"
echo 'deferred wrong-link rejection'

if psql_cmd -v actor="$ACTOR" >/dev/null 2>"$TMP_ROOT/poll-side.err" <<'SQL'
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
INSERT INTO public.posts (id, author_id, title, content, poll_enabled)
VALUES (
  '40000000-0000-4000-8000-000000000001',
  :'actor',
  'missing backlink',
  'body',
  true
);
INSERT INTO public.polls (id, post_id, question, options)
VALUES (
  '40000000-0000-4000-8000-000000000002',
  '40000000-0000-4000-8000-000000000001',
  'missing backlink',
  '[{"text":"yes"}]'::json
);
COMMIT;
SQL
then
  echo 'poll-side drift unexpectedly committed' >&2
  exit 1
fi
grep -q 'post and custom poll must be bidirectionally consistent' "$TMP_ROOT/poll-side.err"
echo 'deferred poll-side rejection'

if psql_cmd -v actor="$ACTOR" >/dev/null 2>"$TMP_ROOT/poll-enabled.err" <<'SQL'
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
INSERT INTO public.posts (id, author_id, title, content, poll_enabled)
VALUES (
  '50000000-0000-4000-8000-000000000001',
  :'actor',
  'disabled custom',
  'body',
  false
);
INSERT INTO public.polls (id, post_id, question, options)
VALUES (
  '50000000-0000-4000-8000-000000000002',
  '50000000-0000-4000-8000-000000000001',
  'disabled custom',
  '[{"text":"yes"}]'::json
);
UPDATE public.posts
SET poll_id = '50000000-0000-4000-8000-000000000002'
WHERE id = '50000000-0000-4000-8000-000000000001';
COMMIT;
SQL
then
  echo 'poll-enabled drift unexpectedly committed' >&2
  exit 1
fi
grep -q 'post and custom poll must be bidirectionally consistent' "$TMP_ROOT/poll-enabled.err"
echo 'deferred poll-enabled rejection'

# Legacy rows can express false, true-without-custom-options, or NULL without a
# custom poll. An unassigned poll row is also allowed until it is bound.
psql_cmd -v actor="$ACTOR" <<'SQL'
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
INSERT INTO public.posts (id, author_id, title, content, poll_enabled)
VALUES
  ('60000000-0000-4000-8000-000000000001', :'actor', 'legacy false', 'body', false),
  ('60000000-0000-4000-8000-000000000002', :'actor', 'legacy true', 'body', true),
  ('60000000-0000-4000-8000-000000000003', :'actor', 'legacy null', 'body', NULL);
INSERT INTO public.polls (id, post_id, question, options)
VALUES (
  '60000000-0000-4000-8000-000000000004',
  NULL,
  'unassigned',
  '[{"text":"yes"}]'::json
);
COMMIT;
SQL
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.posts WHERE id::text LIKE '60000000-0000-4000-8000-%'")" == '3' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.polls WHERE id = '60000000-0000-4000-8000-000000000004'::uuid AND post_id IS NULL")" == '1' ]]
echo 'legacy poll tri-state retained'

# Deleting the post queues both the post constraint trigger and the poll's FK
# cascade/constraint trigger. They must inspect the final empty state, not the
# intermediate circular relationship.
psql_cmd -v post="$LEGAL_POST" <<'SQL'
BEGIN;
SET LOCAL ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', true);
DELETE FROM public.posts WHERE id = :'post';
COMMIT;
SQL
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.posts WHERE id = '$LEGAL_POST'::uuid")" == '0' ]]
[[ "$(psql_cmd -At -c "SELECT count(*) FROM public.polls WHERE id = '$LEGAL_POLL'::uuid")" == '0' ]]
echo 'deferred delete and cascade compatibility'

echo 'post create closure PostgreSQL 17 proof passed'
