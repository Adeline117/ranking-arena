#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BOUNDARY_MIGRATION="$ROOT_DIR/supabase/migrations/20260803101000_close_post_interaction_child_direct_writes.sql"
REACTION_MIGRATION="$ROOT_DIR/supabase/migrations/20260803102000_set_post_reaction_desired_state.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803103000_set_post_vote_desired_state.sql"
ATTESTATION="$ROOT_DIR/docs/sql/post-vote-desired-state-attestation.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/set-post-vote-state-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="$((57700 + ($$ % 400)))"

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

service_scalar() {
  local query="$1"
  psql_cmd -At -c \
    "SET ROLE service_role; SET request.jwt.claim.role = 'service_role'; $query"
}

assert_service() {
  local expected="$1"
  local query="$2"
  local actual
  actual="$(service_scalar "$query")"
  if [[ "$actual" != "$expected" ]]; then
    echo "service assertion failed: expected '$expected', got '$actual'" >&2
    echo "$query" >&2
    exit 1
  fi
}

wait_for_activity() {
  local predicate="$1"
  local expected="$2"
  local label="$3"
  local actual='0'
  for _ in {1..80}; do
    actual="$(psql_cmd -At -c \
      "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE $predicate")"
    [[ "$actual" == "$expected" ]] && return 0
    sleep 0.05
  done
  echo "$label: expected $expected matching sessions, saw $actual" >&2
  psql_cmd -x -c \
    "SELECT application_name, state, wait_event_type, wait_event, query
       FROM pg_catalog.pg_stat_activity
      WHERE datname = current_database()" >&2
  return 1
}

start_post_gate() {
  local post_id="$1"
  PGAPPNAME=desired_state_gate psql_cmd >"$TMP_ROOT/gate.out" 2>"$TMP_ROOT/gate.err" <<SQL &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('post-reaction-counts:$post_id', 0)
);
SELECT pg_catalog.pg_sleep(4);
COMMIT;
SQL
  GATE_PID=$!
  wait_for_activity \
    "application_name = 'desired_state_gate' AND wait_event = 'PgSleep'" \
    '1' \
    'post-wide advisory gate did not become ready'
}

wait_for_two_writers() {
  wait_for_activity \
    "application_name LIKE 'desired_state_writer_%' AND wait_event_type = 'Lock'" \
    '2' \
    'post interaction writers did not both queue behind the shared post lock'
}

psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

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

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  poll_enabled boolean DEFAULT false,
  like_count integer NOT NULL DEFAULT 0,
  dislike_count integer NOT NULL DEFAULT 0,
  poll_bull integer DEFAULT 0,
  poll_bear integer DEFAULT 0,
  poll_wait integer DEFAULT 0
);

CREATE TABLE public.post_likes (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction_type text,
  UNIQUE (post_id, user_id)
);

CREATE TABLE public.post_votes (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  choice text NOT NULL,
  UNIQUE (post_id, user_id)
);

CREATE TABLE public.post_bookmarks (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id uuid,
  UNIQUE (post_id, user_id)
);

CREATE TABLE public.post_emoji_reactions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  UNIQUE (post_id, user_id, emoji)
);

CREATE TABLE public.poll_votes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
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
    'post_emoji_reactions',
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

CREATE TABLE public.canonical_post_access (
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  actor_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  allowed boolean NOT NULL DEFAULT true,
  PRIMARY KEY (post_id, actor_id)
);

CREATE OR REPLACE FUNCTION public.lock_post_interaction_block_edges(
  p_post_id uuid,
  p_actor_id uuid,
  p_comment_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  RETURN p_post_id IS NOT NULL
    AND p_actor_id IS NOT NULL
    AND (p_comment_id IS NULL OR p_comment_id IS NOT NULL);
END
$function$;

CREATE OR REPLACE FUNCTION public.lock_actor_can_interact_with_post_locked_impl(
  p_post_id uuid,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM 1
  FROM public.posts AS target
  WHERE target.id = p_post_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  RETURN EXISTS (
    SELECT 1
    FROM public.canonical_post_access AS access_row
    WHERE access_row.post_id = p_post_id
      AND access_row.actor_id = p_actor_id
      AND access_row.allowed
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.lock_actor_can_interact_with_post(
  p_post_id uuid,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF NOT public.lock_post_interaction_block_edges(
    p_post_id,
    p_actor_id,
    NULL::uuid
  ) THEN
    RETURN false;
  END IF;
  RETURN public.lock_actor_can_interact_with_post_locked_impl(
    p_post_id,
    p_actor_id
  );
END
$function$;

REVOKE ALL ON FUNCTION public.lock_post_interaction_block_edges(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.lock_actor_can_interact_with_post_locked_impl(uuid, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

DO $audience_digest$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.lock_actor_can_interact_with_post_locked_impl(uuid,uuid)'::regprocedure;
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.lock_actor_can_interact_with_post_locked_impl(uuid,uuid) IS %L',
    'atomic-comment-block-authorization:v1:' || pg_catalog.md5(v_source)
  );
END
$audience_digest$;

CREATE OR REPLACE FUNCTION public.enforce_current_post_child_interaction()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.post_id IS NULL
     OR NEW.user_id IS NULL
     OR NOT public.lock_actor_can_interact_with_post(NEW.post_id, NEW.user_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'post is not currently interactable';
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.enforce_current_post_child_interaction() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_current_post_child_interaction()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE TRIGGER trg_post_votes_15_current_interaction
  BEFORE INSERT OR UPDATE ON public.post_votes
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_current_post_child_interaction();

CREATE OR REPLACE FUNCTION public.toggle_post_reaction(
  p_post_id uuid,
  p_user_id uuid,
  p_reaction_type text DEFAULT 'up'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_existing_id uuid;
  v_like_count bigint;
  v_dislike_count bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-reaction:' || p_post_id::text || ':' || p_user_id::text,
      0
    )
  );
  IF NOT public.lock_actor_can_interact_with_post(p_post_id, p_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT reaction.id
  INTO v_existing_id
  FROM public.post_likes AS reaction
  WHERE reaction.post_id = p_post_id
    AND reaction.user_id = p_user_id
  FOR UPDATE;
  IF FOUND THEN
    DELETE FROM public.post_likes WHERE id = v_existing_id;
  ELSE
    INSERT INTO public.post_likes(post_id, user_id, reaction_type)
    VALUES (p_post_id, p_user_id, p_reaction_type);
  END IF;
  UPDATE public.post_likes
  SET reaction_type = reaction_type
  WHERE false;
  SELECT
    pg_catalog.count(*) FILTER (WHERE reaction.reaction_type = 'up'),
    pg_catalog.count(*) FILTER (WHERE reaction.reaction_type = 'down')
  INTO v_like_count, v_dislike_count
  FROM public.post_likes AS reaction
  WHERE reaction.post_id = p_post_id;
  UPDATE public.posts
  SET like_count = v_like_count::integer,
      dislike_count = v_dislike_count::integer
  WHERE id = p_post_id;
  RETURN pg_catalog.jsonb_build_object('status', 'ok');
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
DECLARE
  v_existing_id uuid;
  v_existing_choice text;
  v_action text;
  v_vote text;
  v_bull integer;
  v_bear integer;
  v_wait integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL
     OR p_post_id IS NULL
     OR p_choice NOT IN ('bull', 'bear', 'wait')
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-vote:' || p_post_id::text || ':' || p_actor_id::text,
      0
    )
  );
  IF NOT public.lock_actor_can_interact_with_post(p_post_id, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT vote.id, vote.choice
  INTO v_existing_id, v_existing_choice
  FROM public.post_votes AS vote
  WHERE vote.post_id = p_post_id
    AND vote.user_id = p_actor_id
  FOR UPDATE;

  IF FOUND AND v_existing_choice = p_choice THEN
    DELETE FROM public.post_votes WHERE id = v_existing_id;
    v_action := 'removed';
    v_vote := NULL;
  ELSIF v_existing_id IS NULL THEN
    INSERT INTO public.post_votes (post_id, user_id, choice)
    VALUES (p_post_id, p_actor_id, p_choice);
    v_action := 'added';
    v_vote := p_choice;
  ELSE
    UPDATE public.post_votes SET choice = p_choice WHERE id = v_existing_id;
    v_action := 'changed';
    v_vote := p_choice;
  END IF;

  SELECT
    pg_catalog.count(*) FILTER (WHERE vote.choice = 'bull')::integer,
    pg_catalog.count(*) FILTER (WHERE vote.choice = 'bear')::integer,
    pg_catalog.count(*) FILTER (WHERE vote.choice = 'wait')::integer
  INTO v_bull, v_bear, v_wait
  FROM public.post_votes AS vote
  WHERE vote.post_id = p_post_id;

  UPDATE public.posts
  SET poll_bull = COALESCE(v_bull, 0),
      poll_bear = COALESCE(v_bear, 0),
      poll_wait = COALESCE(v_wait, 0)
  WHERE id = p_post_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_action,
    'action', v_action,
    'vote', v_vote,
    'poll', pg_catalog.jsonb_build_object(
      'bull', COALESCE(v_bull, 0),
      'bear', COALESCE(v_bear, 0),
      'wait', COALESCE(v_wait, 0)
    )
  );
END
$function$;
CREATE OR REPLACE FUNCTION public.toggle_post_bookmark_atomic(uuid, uuid, uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$ SELECT '{"status":"ok"}'::jsonb $function$;
CREATE OR REPLACE FUNCTION public.toggle_post_emoji_reaction_atomic(uuid, uuid, text)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$ SELECT '{"status":"ok"}'::jsonb $function$;
CREATE OR REPLACE FUNCTION public.cast_post_poll_vote_atomic(uuid, uuid, integer[])
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$ SELECT '{"status":"ok"}'::jsonb $function$;
CREATE OR REPLACE FUNCTION public.cast_post_poll_vote_expected_atomic(uuid, uuid, uuid, integer[])
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$ SELECT '{"status":"ok"}'::jsonb $function$;
CREATE OR REPLACE FUNCTION public.save_post_bookmark_to_folder_atomic(uuid, uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$ SELECT '{"status":"ok"}'::jsonb $function$;
CREATE OR REPLACE FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid, uuid, uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$ SELECT '{"status":"ok"}'::jsonb $function$;

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
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');

INSERT INTO public.posts(
  id,
  poll_enabled,
  like_count,
  dislike_count,
  poll_bull,
  poll_bear,
  poll_wait
) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', true, 0, 0, NULL, NULL, NULL),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', true, 0, 0, 0, 0, 0),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', true, 0, 0, 0, 0, 0),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4', true, 0, 0, 0, 0, 0),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5', true, 0, 0, 0, 0, 0),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6', true, 0, 0, 0, 0, 0),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7', false, 0, 0, 4, 3, 2);

INSERT INTO public.canonical_post_access(post_id, actor_id)
SELECT post_row.id, actor_row.id
FROM public.posts AS post_row
CROSS JOIN auth.users AS actor_row;

INSERT INTO public.post_votes(id, post_id, user_id, choice)
VALUES (
  'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
  '11111111-1111-4111-8111-111111111111',
  'bull'
);
SQL

if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/missing-dependency.err"; then
  echo 'vote desired-state migration unexpectedly ran before its dependencies' >&2
  exit 1
fi
grep -q '20260803101000, 20260803102000, and canonical post vote authorities must deploy first' \
  "$TMP_ROOT/missing-dependency.err"
echo 'vote desired-state migration fails closed before the child boundary'

psql_cmd -f "$BOUNDARY_MIGRATION"
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/missing-reaction-dependency.err"; then
  echo 'vote desired-state migration unexpectedly ran before 20260803102000' >&2
  exit 1
fi
grep -q '20260803101000, 20260803102000, and canonical post vote authorities must deploy first' \
  "$TMP_ROOT/missing-reaction-dependency.err"
echo 'vote desired-state migration fails closed until the shared reaction domain exists'

psql_cmd -f "$REACTION_MIGRATION"
psql_cmd -f "$MIGRATION"

assert_scalar 'gen_random_uuid()' "
  SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid, true)
  FROM pg_catalog.pg_attrdef AS default_row
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = default_row.adrelid
   AND attribute.attnum = default_row.adnum
  WHERE default_row.adrelid = 'public.post_votes'::regclass
    AND attribute.attname = 'id'
"
echo 'missing historical post_votes id default converges before explicit-UUID writers publish'

assert_scalar 'set_post_vote_desired_state_atomic|p_actor_id,p_post_id,p_desired_choice|0' "
  SELECT function_row.proname || '|' ||
         pg_catalog.array_to_string(function_row.proargnames, ',') || '|' ||
         function_row.pronargdefaults
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.set_post_vote_desired_state_atomic(uuid,uuid,text)'::regprocedure
"

assert_service '{"status": "invalid"}' "
  SELECT public.set_post_vote_desired_state_atomic(
    NULL,
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'bull'
  )::text
"
assert_service '{"status": "invalid"}' "
  SELECT public.set_post_vote_desired_state_atomic(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'sideways'
  )::text
"
assert_service '{"status": "not_found"}' "
  SELECT public.set_post_vote_desired_state_atomic(
    '11111111-1111-4111-8111-111111111111',
    'ffffffff-ffff-4fff-8fff-ffffffffffff',
    'bull'
  )::text
"
assert_service '{"status": "not_found"}' "
  SELECT public.set_post_vote_desired_state_atomic(
    '99999999-9999-4999-8999-999999999999',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'bull'
  )::text
"
psql_cmd -c "
  UPDATE public.canonical_post_access
  SET allowed = false
  WHERE post_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    AND actor_id = '11111111-1111-4111-8111-111111111111'
"
assert_service '{"status": "not_found"}' "
  SELECT public.set_post_vote_desired_state_atomic(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    'bull'
  )::text
"
psql_cmd -c "
  UPDATE public.canonical_post_access
  SET allowed = true
  WHERE post_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    AND actor_id = '11111111-1111-4111-8111-111111111111'
"
assert_scalar '0|<null>|<null>|<null>' "
  SELECT (SELECT count(*) FROM public.post_votes
          WHERE post_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1') || '|' ||
         COALESCE(target.poll_bull::text, '<null>') || '|' ||
         COALESCE(target.poll_bear::text, '<null>') || '|' ||
         COALESCE(target.poll_wait::text, '<null>')
  FROM public.posts AS target
  WHERE target.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
"
echo 'invalid plus missing account/post and audience-denial ACKs are exact and side-effect free'

assert_service '{"status": "not_found"}' "
  SELECT public.toggle_post_vote_atomic(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
    'wait'
  )::text
"
assert_service '{"status": "not_found"}' "
  SELECT public.set_post_vote_desired_state_atomic(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
    'bear'
  )::text
"
assert_scalar '1|bull|4|3|2' "
  SELECT (SELECT count(*) FROM public.post_votes
          WHERE post_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7') || '|' ||
         (SELECT choice FROM public.post_votes
          WHERE post_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7') || '|' ||
         target.poll_bull || '|' || target.poll_bear || '|' || target.poll_wait
  FROM public.posts AS target
  WHERE target.id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7'
"
assert_service 'removed|removed|<null>|0|0|0' "
  SELECT (result ->> 'status') || '|' || (result ->> 'action') || '|' ||
         COALESCE(result ->> 'vote', '<null>') || '|' ||
         (result -> 'poll' ->> 'bull') || '|' ||
         (result -> 'poll' ->> 'bear') || '|' ||
         (result -> 'poll' ->> 'wait')
  FROM (
    SELECT public.set_post_vote_desired_state_atomic(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
      NULL
    ) AS result
  ) AS call
"
assert_service 'unchanged|unchanged|<null>|0|0|0' "
  SELECT (result ->> 'status') || '|' || (result ->> 'action') || '|' ||
         COALESCE(result ->> 'vote', '<null>') || '|' ||
         (result -> 'poll' ->> 'bull') || '|' ||
         (result -> 'poll' ->> 'bear') || '|' ||
         (result -> 'poll' ->> 'wait')
  FROM (
    SELECT public.set_post_vote_desired_state_atomic(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa7',
      NULL
    ) AS result
  ) AS call
"
echo 'disabled polls reject non-null legacy/desired votes while desired NULL cleans and recounts'

if psql_cmd >/dev/null 2>"$TMP_ROOT/browser-execute.err" <<'SQL'; then
\set VERBOSITY verbose
SET ROLE authenticated;
SET request.jwt.claim.role = 'authenticated';
SELECT public.set_post_vote_desired_state_atomic(
  '11111111-1111-4111-8111-111111111111',
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  'bull'
);
SQL
  echo 'authenticated unexpectedly executed vote desired-state authority' >&2
  exit 1
fi
grep -q '42501' "$TMP_ROOT/browser-execute.err"
echo 'vote desired-state authority is service-role only'

assert_scalar 'false|false|false|false' "
  SELECT
    pg_catalog.has_function_privilege(
      'anon',
      'public.lock_actor_can_interact_with_post(uuid,uuid)'::regprocedure,
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'authenticated',
      'public.lock_actor_can_interact_with_post(uuid,uuid)'::regprocedure,
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'authenticator',
      'public.lock_actor_can_interact_with_post(uuid,uuid)'::regprocedure,
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'service_role',
      'public.lock_actor_can_interact_with_post(uuid,uuid)'::regprocedure,
      'EXECUTE'
    )
"
echo 'canonical audience helper remains internal-only behind owner-executed RPCs'

success_projection="
  WITH ack AS (
    SELECT public.set_post_vote_desired_state_atomic(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      %s
    ) AS value
  )
  SELECT (
           SELECT pg_catalog.string_agg(key_name, ',' ORDER BY key_name)
           FROM pg_catalog.jsonb_object_keys(ack.value) AS keys(key_name)
         ) || '|' ||
         (ack.value ->> 'status') || '|' ||
         (ack.value ->> 'action') || '|' ||
         COALESCE(ack.value ->> 'vote', '<null>') || '|' ||
         (
           SELECT pg_catalog.string_agg(key_name, ',' ORDER BY key_name)
           FROM pg_catalog.jsonb_object_keys(ack.value -> 'poll')
             AS poll_keys(key_name)
         ) || '|' ||
         (ack.value -> 'poll' ->> 'bull') || '|' ||
         (ack.value -> 'poll' ->> 'bear') || '|' ||
         (ack.value -> 'poll' ->> 'wait')
  FROM ack
"

assert_service \
  'action,poll,status,vote|unchanged|unchanged|<null>|bear,bull,wait|0|0|0' \
  "$(printf "$success_projection" 'NULL::text')"
assert_scalar '0|0|0' "
  SELECT poll_bull || '|' || poll_bear || '|' || poll_wait
  FROM public.posts
  WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
"
assert_service \
  'action,poll,status,vote|added|added|bull|bear,bull,wait|1|0|0' \
  "$(printf "$success_projection" "'bull'")"
psql_cmd -c "
  UPDATE public.posts
  SET poll_bull = 77, poll_bear = NULL, poll_wait = -5
  WHERE id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
"
assert_service \
  'action,poll,status,vote|unchanged|unchanged|bull|bear,bull,wait|1|0|0' \
  "$(printf "$success_projection" "'bull'")"
assert_service \
  'action,poll,status,vote|changed|changed|bear|bear,bull,wait|0|1|0' \
  "$(printf "$success_projection" "'bear'")"
assert_service \
  'action,poll,status,vote|changed|changed|wait|bear,bull,wait|0|0|1' \
  "$(printf "$success_projection" "'wait'")"
assert_service \
  'action,poll,status,vote|unchanged|unchanged|wait|bear,bull,wait|0|0|1' \
  "$(printf "$success_projection" "'wait'")"
assert_service \
  'action,poll,status,vote|removed|removed|<null>|bear,bull,wait|0|0|0' \
  "$(printf "$success_projection" 'NULL::text')"
assert_service \
  'action,poll,status,vote|unchanged|unchanged|<null>|bear,bull,wait|0|0|0' \
  "$(printf "$success_projection" 'NULL::text')"
echo 'bull/bear/wait desired state, exact ACKs, replay, removal, and absolute repair hold'

assert_service '{"status": "invalid"}' "
  SELECT public.toggle_post_vote_atomic(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    NULL
  )::text
"
legacy_projection="
  SELECT (result ->> 'status') || '|' || (result ->> 'action') || '|' ||
         COALESCE(result ->> 'vote', '<null>') || '|' ||
         (result -> 'poll' ->> 'bull') || '|' ||
         (result -> 'poll' ->> 'bear') || '|' ||
         (result -> 'poll' ->> 'wait')
  FROM (
    SELECT public.toggle_post_vote_atomic(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      %s
    ) AS result
  ) AS call
"
assert_service 'added|added|bull|1|0|0' \
  "$(printf "$legacy_projection" "'bull'")"
assert_service 'changed|changed|bear|0|1|0' \
  "$(printf "$legacy_projection" "'bear'")"
assert_service 'changed|changed|wait|0|0|1' \
  "$(printf "$legacy_projection" "'wait'")"
assert_service 'removed|removed|<null>|0|0|0' \
  "$(printf "$legacy_projection" "'wait'")"
echo 'legacy bull/bear/wait toggle ACKs remain compatible while explicit NULL fails cleanly'

POST_TWO='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
start_post_gate "$POST_TWO"
PGAPPNAME=desired_state_writer_a psql_cmd -At \
  >"$TMP_ROOT/two-actor-a.out" 2>"$TMP_ROOT/two-actor-a.err" <<SQL &
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.set_post_vote_desired_state_atomic(
  '11111111-1111-4111-8111-111111111111', '$POST_TWO', 'bull'
) ->> 'action';
SQL
writer_a_pid=$!
PGAPPNAME=desired_state_writer_b psql_cmd -At \
  >"$TMP_ROOT/two-actor-b.out" 2>"$TMP_ROOT/two-actor-b.err" <<SQL &
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.set_post_vote_desired_state_atomic(
  '22222222-2222-4222-8222-222222222222', '$POST_TWO', 'bear'
) ->> 'action';
SQL
writer_b_pid=$!
wait_for_two_writers
wait "$GATE_PID"
wait "$writer_a_pid"
wait "$writer_b_pid"
[[ "$(tr -d '[:space:]' <"$TMP_ROOT/two-actor-a.out")" == 'added' ]]
[[ "$(tr -d '[:space:]' <"$TMP_ROOT/two-actor-b.out")" == 'added' ]]
assert_service 'added' "
  SELECT public.set_post_vote_desired_state_atomic(
    '33333333-3333-4333-8333-333333333333', '$POST_TWO', 'wait'
  ) ->> 'action'
"
assert_scalar '3|1|1|1' "
  SELECT (SELECT count(*) FROM public.post_votes WHERE post_id = '$POST_TWO') ||
         '|' || target.poll_bull || '|' || target.poll_bear || '|' ||
         target.poll_wait
  FROM public.posts AS target
  WHERE target.id = '$POST_TWO'
"
echo 'different vote actors serialize to exact bull/bear/wait child truth and counters'

POST_THREE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
start_post_gate "$POST_THREE"
for suffix in a b; do
  PGAPPNAME="desired_state_writer_$suffix" psql_cmd -At \
    >"$TMP_ROOT/replay-$suffix.out" 2>"$TMP_ROOT/replay-$suffix.err" <<SQL &
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.set_post_vote_desired_state_atomic(
  '33333333-3333-4333-8333-333333333333', '$POST_THREE', 'wait'
) ->> 'action';
SQL
  if [[ "$suffix" == 'a' ]]; then replay_a_pid=$!; else replay_b_pid=$!; fi
done
wait_for_two_writers
wait "$GATE_PID"
wait "$replay_a_pid"
wait "$replay_b_pid"
replay_actions="$(
  { tr -d '[:space:]' <"$TMP_ROOT/replay-a.out"; echo;
    tr -d '[:space:]' <"$TMP_ROOT/replay-b.out"; echo; } | sort | paste -sd'|' -
)"
[[ "$replay_actions" == 'added|unchanged' ]]
assert_scalar '1|0|0|1' "
  SELECT (SELECT count(*) FROM public.post_votes WHERE post_id = '$POST_THREE') ||
         '|' || target.poll_bull || '|' || target.poll_bear || '|' ||
         target.poll_wait
  FROM public.posts AS target
  WHERE target.id = '$POST_THREE'
"
echo 'same-actor concurrent vote replay applies one edge and one unchanged intent'

POST_FOUR='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'
start_post_gate "$POST_FOUR"
PGAPPNAME=desired_state_writer_legacy psql_cmd -At \
  >"$TMP_ROOT/legacy-overlap.out" 2>"$TMP_ROOT/legacy-overlap.err" <<SQL &
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.toggle_post_vote_atomic(
  '11111111-1111-4111-8111-111111111111', '$POST_FOUR', 'bear'
) ->> 'action';
SQL
legacy_pid=$!
PGAPPNAME=desired_state_writer_new psql_cmd -At \
  >"$TMP_ROOT/new-overlap.out" 2>"$TMP_ROOT/new-overlap.err" <<SQL &
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.set_post_vote_desired_state_atomic(
  '11111111-1111-4111-8111-111111111111', '$POST_FOUR', 'bull'
) ->> 'action';
SQL
new_pid=$!
wait_for_two_writers
wait "$GATE_PID"
wait "$legacy_pid"
wait "$new_pid"
overlap_actions="$(
  { tr -d '[:space:]' <"$TMP_ROOT/legacy-overlap.out"; echo;
    tr -d '[:space:]' <"$TMP_ROOT/new-overlap.out"; echo; } | sort | paste -sd'|' -
)"
[[ "$overlap_actions" == 'added|changed' ]]
assert_scalar '1|1|1' "
  SELECT (SELECT count(*) FROM public.post_votes WHERE post_id = '$POST_FOUR') ||
         '|' || (target.poll_bull + target.poll_bear + target.poll_wait) ||
         '|' || CASE vote.choice
           WHEN 'bull' THEN target.poll_bull
           WHEN 'bear' THEN target.poll_bear
           WHEN 'wait' THEN target.poll_wait
         END
  FROM public.posts AS target
  JOIN public.post_votes AS vote ON vote.post_id = target.id
  WHERE target.id = '$POST_FOUR'
"
if grep -q 'deadlock detected' "$TMP_ROOT/legacy-overlap.err" "$TMP_ROOT/new-overlap.err"; then
  echo 'legacy/new vote overlap deadlocked' >&2
  exit 1
fi
echo 'legacy and desired vote writers share actor and post rolling-deploy locks'

POST_SIX='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6'
start_post_gate "$POST_SIX"
PGAPPNAME=desired_state_writer_reaction psql_cmd -At \
  >"$TMP_ROOT/reaction-overlap.out" 2>"$TMP_ROOT/reaction-overlap.err" <<SQL &
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.set_post_reaction_desired_state_atomic(
  '11111111-1111-4111-8111-111111111111', '$POST_SIX', 'up'
) ->> 'action';
SQL
reaction_pid=$!
PGAPPNAME=desired_state_writer_vote psql_cmd -At \
  >"$TMP_ROOT/vote-overlap.out" 2>"$TMP_ROOT/vote-overlap.err" <<SQL &
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.set_post_vote_desired_state_atomic(
  '22222222-2222-4222-8222-222222222222', '$POST_SIX', 'wait'
) ->> 'action';
SQL
vote_pid=$!
wait_for_two_writers
wait "$GATE_PID"
wait "$reaction_pid"
wait "$vote_pid"
[[ "$(tr -d '[:space:]' <"$TMP_ROOT/reaction-overlap.out")" == 'added' ]]
[[ "$(tr -d '[:space:]' <"$TMP_ROOT/vote-overlap.out")" == 'added' ]]
if grep -q 'deadlock detected' \
  "$TMP_ROOT/reaction-overlap.err" "$TMP_ROOT/vote-overlap.err"; then
  echo 'reaction/vote overlap deadlocked' >&2
  exit 1
fi
assert_scalar '1|1|1|0|0|1' "
  SELECT (SELECT count(*) FROM public.post_likes WHERE post_id = '$POST_SIX') ||
         '|' || target.like_count || '|' ||
         (SELECT count(*) FROM public.post_votes WHERE post_id = '$POST_SIX') ||
         '|' || target.poll_bull || '|' || target.poll_bear || '|' ||
         target.poll_wait
  FROM public.posts AS target
  WHERE target.id = '$POST_SIX'
"
echo 'reaction and vote authorities share one post counter lock without deadlock'

assert_service 'removed' "
  SELECT public.set_post_reaction_desired_state_atomic(
    '11111111-1111-4111-8111-111111111111', '$POST_SIX', NULL
  ) ->> 'action'
"
assert_service 'removed' "
  SELECT public.set_post_vote_desired_state_atomic(
    '22222222-2222-4222-8222-222222222222', '$POST_SIX', NULL
  ) ->> 'action'
"
start_post_gate "$POST_SIX"
PGAPPNAME=desired_state_writer_legacy_reaction psql_cmd -At \
  >"$TMP_ROOT/legacy-reaction-overlap.out" \
  2>"$TMP_ROOT/legacy-reaction-overlap.err" <<SQL &
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.toggle_post_reaction(
  '$POST_SIX', '33333333-3333-4333-8333-333333333333', 'up'
) ->> 'action';
SQL
legacy_reaction_pid=$!
PGAPPNAME=desired_state_writer_vote_with_legacy_reaction psql_cmd -At \
  >"$TMP_ROOT/vote-with-legacy-reaction.out" \
  2>"$TMP_ROOT/vote-with-legacy-reaction.err" <<SQL &
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.set_post_vote_desired_state_atomic(
  '11111111-1111-4111-8111-111111111111', '$POST_SIX', 'bear'
) ->> 'action';
SQL
vote_with_legacy_reaction_pid=$!
wait_for_two_writers
wait "$GATE_PID"
wait "$legacy_reaction_pid"
wait "$vote_with_legacy_reaction_pid"
[[ "$(tr -d '[:space:]' <"$TMP_ROOT/legacy-reaction-overlap.out")" == 'added' ]]
[[ "$(tr -d '[:space:]' <"$TMP_ROOT/vote-with-legacy-reaction.out")" == 'added' ]]
if grep -q 'deadlock detected' \
  "$TMP_ROOT/legacy-reaction-overlap.err" \
  "$TMP_ROOT/vote-with-legacy-reaction.err"; then
  echo 'legacy reaction/desired vote overlap deadlocked' >&2
  exit 1
fi
assert_scalar '1|1|1|0|1|0' "
  SELECT (SELECT count(*) FROM public.post_likes WHERE post_id = '$POST_SIX') ||
         '|' || target.like_count || '|' ||
         (SELECT count(*) FROM public.post_votes WHERE post_id = '$POST_SIX') ||
         '|' || target.poll_bull || '|' || target.poll_bear || '|' ||
         target.poll_wait
  FROM public.posts AS target
  WHERE target.id = '$POST_SIX'
"
echo 'legacy reaction and desired vote also share the post counter lock domain'

POST_FIVE='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'
PGAPPNAME=desired_state_account_holder psql_cmd -At \
  >"$TMP_ROOT/account-holder.out" 2>"$TMP_ROOT/account-holder.err" <<SQL &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.set_post_vote_desired_state_atomic(
  '44444444-4444-4444-8444-444444444444', '$POST_FIVE', 'bull'
) ->> 'action';
SELECT pg_catalog.pg_sleep(4);
COMMIT;
SQL
account_holder_pid=$!
wait_for_activity \
  "application_name = 'desired_state_account_holder' AND wait_event = 'PgSleep'" \
  '1' \
  'vote transaction did not retain the account lifecycle lock'

PGAPPNAME=desired_state_account_delete psql_cmd \
  >"$TMP_ROOT/account-delete.out" 2>"$TMP_ROOT/account-delete.err" <<'SQL' &
SET lock_timeout = '8s';
DELETE FROM auth.users
WHERE id = '44444444-4444-4444-8444-444444444444';
SQL
account_delete_pid=$!
wait_for_activity \
  "application_name = 'desired_state_account_delete' AND wait_event_type = 'Lock'" \
  '1' \
  'account delete did not wait behind the RPC account guard'
wait "$account_holder_pid"
wait "$account_delete_pid"
if grep -q 'deadlock detected' "$TMP_ROOT/account-holder.err" "$TMP_ROOT/account-delete.err"; then
  echo 'vote/account lifecycle overlap deadlocked' >&2
  exit 1
fi
assert_scalar '0|0|1|0|0' "
  SELECT
    (SELECT count(*) FROM auth.users
      WHERE id = '44444444-4444-4444-8444-444444444444') || '|' ||
    (SELECT count(*) FROM public.post_votes
      WHERE post_id = '$POST_FIVE') || '|' ||
    target.poll_bull || '|' || target.poll_bear || '|' || target.poll_wait
  FROM public.posts AS target
  WHERE target.id = '$POST_FIVE'
"
assert_service 'unchanged|0|0|0' "
  SELECT (result ->> 'action') || '|' ||
         (result -> 'poll' ->> 'bull') || '|' ||
         (result -> 'poll' ->> 'bear') || '|' ||
         (result -> 'poll' ->> 'wait')
  FROM (
    SELECT public.set_post_vote_desired_state_atomic(
      '11111111-1111-4111-8111-111111111111', '$POST_FIVE', NULL
    ) AS result
  ) AS call
"
echo 'account delete waits without deadlock; a no-op vote call repairs cascade counter drift'

psql_cmd -f "$MIGRATION"
echo 'clean migration replay succeeds'

psql_cmd <<'SQL'
GRANT EXECUTE ON FUNCTION public.set_post_vote_desired_state_atomic(uuid, uuid, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_post_vote_desired_state_atomic(uuid, uuid, text)
  TO service_role WITH GRANT OPTION;
ALTER FUNCTION public.set_post_vote_desired_state_atomic(uuid, uuid, text)
  SET search_path = public;
COMMENT ON FUNCTION public.set_post_vote_desired_state_atomic(uuid, uuid, text)
  IS 'drift';
COMMENT ON FUNCTION public.toggle_post_vote_atomic(uuid, uuid, text)
  IS 'legacy drift';
ALTER TABLE public.post_votes
  DROP CONSTRAINT post_votes_choice_desired_state_check;
ALTER TABLE public.post_votes
  ALTER COLUMN id DROP DEFAULT;
SQL
psql_cmd -f "$MIGRATION"
assert_scalar 'true|false|false|true' "
  SELECT
    pg_catalog.has_function_privilege(
      'service_role',
      'public.set_post_vote_desired_state_atomic(uuid,uuid,text)'::regprocedure,
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'authenticated',
      'public.set_post_vote_desired_state_atomic(uuid,uuid,text)'::regprocedure,
      'EXECUTE'
    ) || '|' ||
    pg_catalog.has_function_privilege(
      'anon',
      'public.set_post_vote_desired_state_atomic(uuid,uuid,text)'::regprocedure,
      'EXECUTE'
    ) || '|' || (
      SELECT pg_catalog.cardinality(function_row.proconfig) = 4
        AND function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off',
          'lock_timeout=5s',
          'statement_timeout=15s'
        ]::text[]
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid =
        'public.set_post_vote_desired_state_atomic(uuid,uuid,text)'::regprocedure
    )
"
assert_scalar '2' "
  SELECT count(*)
  FROM pg_catalog.pg_proc AS function_row
  WHERE pg_catalog.obj_description(function_row.oid, 'pg_proc') =
    CASE function_row.proname
      WHEN 'toggle_post_vote_atomic' THEN
        'post-vote-desired-state:legacy-v2:' || pg_catalog.md5(function_row.prosrc)
      WHEN 'set_post_vote_desired_state_atomic' THEN
        'post-vote-desired-state:v1:' || pg_catalog.md5(function_row.prosrc)
    END
    AND function_row.proname IN (
      'toggle_post_vote_atomic',
      'set_post_vote_desired_state_atomic'
    )
"
assert_scalar 'false|gen_random_uuid()|true' "
  SELECT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_proc AS function_row
           CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
           WHERE function_row.oid =
             'public.set_post_vote_desired_state_atomic(uuid,uuid,text)'::regprocedure
             AND acl_entry.grantee =
               (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role')
             AND acl_entry.privilege_type = 'EXECUTE'
             AND acl_entry.is_grantable
         ) || '|' || (
           SELECT pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid, true)
           FROM pg_catalog.pg_attrdef AS default_row
           JOIN pg_catalog.pg_attribute AS attribute
             ON attribute.attrelid = default_row.adrelid
            AND attribute.attnum = default_row.adnum
           WHERE default_row.adrelid = 'public.post_votes'::regclass
             AND attribute.attname = 'id'
         ) || '|' || EXISTS (
           SELECT 1
           FROM pg_catalog.pg_constraint AS constraint_row
           WHERE constraint_row.conrelid = 'public.post_votes'::regclass
             AND constraint_row.conname =
               'post_votes_choice_desired_state_check'
             AND constraint_row.contype = 'c'
             AND constraint_row.convalidated
             AND pg_catalog.pg_get_expr(
               constraint_row.conbin,
               constraint_row.conrelid,
               true
             ) =
               'choice IS NOT NULL AND (choice = ANY (''{bull,bear,wait}''::text[]))'
         )
"
echo 'vote replay converges RPC ACL/grant-option/config, id default, CHECK, and digests'

psql_cmd <<'SQL'
ALTER TABLE public.post_votes
  DROP CONSTRAINT post_votes_choice_desired_state_check;
INSERT INTO public.post_votes(post_id, user_id, choice)
VALUES (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
  '22222222-2222-4222-8222-222222222222',
  'sideways'
);
SQL
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/invalid-history.err"; then
  echo 'migration unexpectedly accepted an invalid historical vote' >&2
  exit 1
fi
grep -q 'contains 1 invalid vote rows' "$TMP_ROOT/invalid-history.err"
psql_cmd -c "
  DELETE FROM public.post_votes
  WHERE choice = 'sideways'
"
psql_cmd -f "$MIGRATION"
echo 'invalid historical vote rows fail closed before CHECK convergence'

psql_cmd -c "
  ALTER TABLE public.post_votes
  DROP CONSTRAINT post_votes_post_id_user_id_key
"
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/composite-key-drift.err"; then
  echo 'migration unexpectedly accepted missing composite vote identity' >&2
  exit 1
fi
grep -q 'requires an exact valid UNIQUE (post_id, user_id) key' \
  "$TMP_ROOT/composite-key-drift.err"
psql_cmd -c "
  ALTER TABLE public.post_votes
  ADD CONSTRAINT post_votes_post_id_user_id_key UNIQUE (post_id, user_id)
"

psql_cmd -c "
  ALTER TABLE public.post_votes
  DROP CONSTRAINT post_votes_pkey
"
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/id-key-drift.err"; then
  echo 'migration unexpectedly accepted missing vote id primary key' >&2
  exit 1
fi
grep -q 'requires exact PRIMARY KEY (id)' "$TMP_ROOT/id-key-drift.err"
psql_cmd -c "
  ALTER TABLE public.post_votes
  ADD CONSTRAINT post_votes_pkey PRIMARY KEY (id)
"

psql_cmd -c "
  ALTER TABLE public.post_votes
  DROP CONSTRAINT post_votes_post_id_fkey
"
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/post-fk-drift.err"; then
  echo 'migration unexpectedly accepted missing post cascade foreign key' >&2
  exit 1
fi
grep -q 'requires exact post/account ON DELETE CASCADE foreign keys' \
  "$TMP_ROOT/post-fk-drift.err"
psql_cmd -c "
  ALTER TABLE public.post_votes
  ADD CONSTRAINT post_votes_post_id_fkey
  FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE
"

psql_cmd -c "
  ALTER TABLE public.post_votes
  DROP CONSTRAINT post_votes_user_id_fkey
"
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/account-fk-drift.err"; then
  echo 'migration unexpectedly accepted missing account cascade foreign key' >&2
  exit 1
fi
grep -q 'requires exact post/account ON DELETE CASCADE foreign keys' \
  "$TMP_ROOT/account-fk-drift.err"
psql_cmd -c "
  ALTER TABLE public.post_votes
  ADD CONSTRAINT post_votes_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
"

psql_cmd -c "
  ALTER TABLE public.post_votes
  DISABLE TRIGGER trg_post_votes_15_current_interaction
"
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/vote-trigger-drift.err"; then
  echo 'migration unexpectedly accepted a disabled vote audience guard' >&2
  exit 1
fi
grep -q 'post_votes canonical INSERT/UPDATE audience guard drifted' \
  "$TMP_ROOT/vote-trigger-drift.err"
psql_cmd -c "
  ALTER TABLE public.post_votes
  ENABLE TRIGGER trg_post_votes_15_current_interaction
"

psql_cmd -c "
  GRANT EXECUTE ON FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  TO service_role
"
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/audience-acl-drift.err"; then
  echo 'migration unexpectedly accepted route-visible canonical audience helper' >&2
  exit 1
fi
grep -q 'canonical post audience wrapper chain or internal-only ACL drifted' \
  "$TMP_ROOT/audience-acl-drift.err"
psql_cmd -c "
  REVOKE ALL ON FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  FROM service_role
"
psql_cmd -f "$MIGRATION"
echo 'vote identity, both cascade FKs, trigger guard, and audience ACL drift fail closed'

psql_cmd -c "
  GRANT UPDATE (choice) ON TABLE public.post_votes TO authenticated
"
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/vote-column-acl-drift.err"; then
  echo 'migration unexpectedly accepted browser column-level vote mutation' >&2
  exit 1
fi
grep -q 'post_votes browser ACL boundary drifted' \
  "$TMP_ROOT/vote-column-acl-drift.err"
psql_cmd -c "
  REVOKE UPDATE (choice) ON TABLE public.post_votes FROM authenticated;
  REVOKE SELECT ON TABLE public.post_votes FROM service_role
"
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/vote-service-read-drift.err"; then
  echo 'migration unexpectedly accepted missing service vote read authority' >&2
  exit 1
fi
grep -q 'post_votes browser ACL boundary drifted' \
  "$TMP_ROOT/vote-service-read-drift.err"
psql_cmd -c "
  GRANT SELECT ON TABLE public.post_votes TO service_role
"
psql_cmd -f "$MIGRATION"
echo 'vote table and column ACL drift fail closed'

psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.set_post_reaction_desired_state_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_desired_reaction text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
BEGIN
  RETURN pg_catalog.jsonb_build_object('status', 'drift');
END
$function$;
SQL
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/reaction-source-drift.err"; then
  echo 'migration unexpectedly accepted drifted shared reaction source' >&2
  exit 1
fi
grep -q 'shared post counter authority drifted: public.set_post_reaction_desired_state_atomic' \
  "$TMP_ROOT/reaction-source-drift.err"
psql_cmd -f "$REACTION_MIGRATION"
psql_cmd -f "$MIGRATION"

psql_cmd -c "
  GRANT EXECUTE ON FUNCTION public.toggle_post_reaction(uuid, uuid, text)
  TO authenticated
"
if psql_cmd -f "$MIGRATION" >/dev/null 2>"$TMP_ROOT/reaction-acl-drift.err"; then
  echo 'migration unexpectedly accepted route-visible shared reaction authority' >&2
  exit 1
fi
grep -q 'shared post counter authority drifted: public.toggle_post_reaction' \
  "$TMP_ROOT/reaction-acl-drift.err"
psql_cmd -c "
  REVOKE ALL ON FUNCTION public.toggle_post_reaction(uuid, uuid, text)
  FROM authenticated
"
psql_cmd -f "$REACTION_MIGRATION"
psql_cmd -f "$MIGRATION"
echo 'shared reaction source and route ACL drift fail closed before vote publication'

psql_cmd -f "$ATTESTATION"
echo 'post vote desired-state PG17 proof passed'
