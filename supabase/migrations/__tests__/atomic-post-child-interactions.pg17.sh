#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716178000_atomic_post_child_interactions.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/arena-post-child.XXXXXX")"
PG_DATA="$TMP_ROOT/data"
PG_SOCKET="$TMP_ROOT/socket"
PG_PORT="$((42000 + RANDOM % 15000))"

if [[ ! -x "$PG_BIN/postgres" ]] || ! "$PG_BIN/postgres" --version | grep -q 'PostgreSQL) 17\.'; then
  echo "PostgreSQL 17 is required; set PG17_BIN to its bin directory" >&2
  exit 1
fi

cleanup() {
  "$PG_BIN/pg_ctl" -D "$PG_DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

mkdir -p "$PG_SOCKET"
"$PG_BIN/initdb" -D "$PG_DATA" -A trust -U postgres >/dev/null
"$PG_BIN/pg_ctl" -D "$PG_DATA" \
  -o "-F -p $PG_PORT -k $PG_SOCKET -c listen_addresses=''" \
  -w start >/dev/null

psql_cmd() {
  "$PG_BIN/psql" \
    -v ON_ERROR_STOP=1 \
    -h "$PG_SOCKET" \
    -p "$PG_PORT" \
    -U postgres \
    -d postgres \
    "$@"
}

psql_cmd >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;

CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$$;

CREATE TABLE public.posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  author_id uuid NOT NULL,
  original_post_id uuid,
  like_count integer NOT NULL DEFAULT 0,
  dislike_count integer NOT NULL DEFAULT 0,
  bookmark_count integer NOT NULL DEFAULT 0,
  poll_bull integer NOT NULL DEFAULT 0,
  poll_bear integer NOT NULL DEFAULT 0,
  poll_wait integer NOT NULL DEFAULT 0
);
CREATE TABLE public.post_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  reaction_type text,
  UNIQUE (post_id, user_id)
);
CREATE TABLE public.post_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  choice text NOT NULL,
  UNIQUE (post_id, user_id)
);
CREATE TABLE public.bookmark_folders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);
CREATE UNIQUE INDEX bookmark_default_one_per_user
  ON public.bookmark_folders (user_id) WHERE is_default;
CREATE TABLE public.post_bookmarks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  folder_id uuid,
  UNIQUE (post_id, user_id)
);
CREATE TABLE public.post_emoji_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  emoji text NOT NULL,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (post_id, user_id, emoji)
);
CREATE TABLE public.post_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  reaction_type text NOT NULL
);
CREATE TABLE public.comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  content text NOT NULL
);
CREATE TABLE public.comment_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL,
  user_id uuid NOT NULL,
  reaction_type text NOT NULL
);
CREATE TABLE public.polls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid,
  question text NOT NULL,
  options jsonb NOT NULL,
  type text,
  end_at timestamptz,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz
);
CREATE TABLE public.poll_votes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  poll_id uuid NOT NULL,
  user_id uuid NOT NULL,
  option_index integer NOT NULL,
  UNIQUE (poll_id, user_id, option_index)
);

CREATE TABLE public.canonical_post_access (
  post_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  allowed boolean NOT NULL,
  PRIMARY KEY (post_id, actor_id)
);

CREATE FUNCTION public.lock_actor_can_interact_with_post(
  p_post_id uuid,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE((
    SELECT access.allowed
    FROM public.canonical_post_access AS access
    WHERE access.post_id = p_post_id
      AND access.actor_id = p_actor_id
  ), false)
$$;
ALTER FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

INSERT INTO public.posts (id, author_id)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001'
);
INSERT INTO public.polls (id, post_id, question, options, type)
VALUES (
  '30000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'Direction?',
  '[{"text":"Up","votes":0},{"text":"Down","votes":0}]'::jsonb,
  'single'
);
INSERT INTO public.canonical_post_access (post_id, actor_id, allowed)
VALUES (
  '10000000-0000-4000-8000-000000000001',
  '40000000-0000-4000-8000-000000000001',
  true
);
SQL

psql_cmd <"$MIGRATION" >/dev/null

psql_cmd >/dev/null <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

DO $active_contract$
DECLARE
  v_result jsonb;
  v_comment_id uuid;
BEGIN
  v_result := public.toggle_post_reaction(
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'up'
  );
  IF v_result ->> 'status' <> 'added'
    OR (v_result ->> 'like_count')::integer <> 1
  THEN
    RAISE EXCEPTION 'active reaction failed: %', v_result;
  END IF;

  v_result := public.toggle_post_vote_atomic(
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'bull'
  );
  IF v_result ->> 'status' <> 'added'
    OR (v_result -> 'poll' ->> 'bull')::integer <> 1
  THEN
    RAISE EXCEPTION 'active post vote failed: %', v_result;
  END IF;

  v_result := public.toggle_post_bookmark_atomic(
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    NULL
  );
  IF v_result ->> 'status' <> 'added'
    OR (v_result ->> 'bookmark_count')::integer <> 1
    OR v_result ->> 'folder_id' IS NULL
  THEN
    RAISE EXCEPTION 'active bookmark failed: %', v_result;
  END IF;

  v_result := public.toggle_post_emoji_reaction_atomic(
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '🔥'
  );
  IF v_result ->> 'status' <> 'added'
    OR (v_result -> 'counts' ->> '🔥')::integer <> 1
  THEN
    RAISE EXCEPTION 'active emoji reaction failed: %', v_result;
  END IF;

  v_result := public.cast_post_poll_vote_atomic(
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    ARRAY[0]
  );
  IF v_result ->> 'status' <> 'voted'
    OR (v_result ->> 'total_votes')::integer <> 1
  THEN
    RAISE EXCEPTION 'active poll vote failed: %', v_result;
  END IF;

  INSERT INTO public.comments (post_id, user_id, content)
  VALUES (
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'active comment'
  )
  RETURNING id INTO v_comment_id;

  INSERT INTO public.comment_likes (comment_id, user_id, reaction_type)
  VALUES (
    v_comment_id,
    '40000000-0000-4000-8000-000000000001',
    'like'
  );

  INSERT INTO public.post_reactions (post_id, user_id, reaction_type)
  VALUES (
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'fire'
  );

  INSERT INTO public.posts (id, author_id, original_post_id)
  VALUES (
    '10000000-0000-4000-8000-000000000002',
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001'
  );
END
$active_contract$;
SQL

psql_cmd >/dev/null <<'SQL'
UPDATE public.canonical_post_access
SET allowed = false
WHERE post_id = '10000000-0000-4000-8000-000000000001'
  AND actor_id = '40000000-0000-4000-8000-000000000001';

SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

DO $expired_contract$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.toggle_post_reaction(
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000001',
    'up'
  );
  IF v_result <> '{"status":"not_found"}'::jsonb THEN
    RAISE EXCEPTION 'expired reaction changed retained state: %', v_result;
  END IF;

  v_result := public.toggle_post_vote_atomic(
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    'bull'
  );
  IF v_result <> '{"status":"not_found"}'::jsonb THEN
    RAISE EXCEPTION 'expired post vote changed retained state: %', v_result;
  END IF;

  v_result := public.toggle_post_bookmark_atomic(
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    NULL
  );
  IF v_result <> '{"status":"not_found"}'::jsonb THEN
    RAISE EXCEPTION 'expired bookmark changed retained state: %', v_result;
  END IF;

  v_result := public.toggle_post_emoji_reaction_atomic(
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    '🔥'
  );
  IF v_result <> '{"status":"not_found"}'::jsonb THEN
    RAISE EXCEPTION 'expired emoji reaction changed retained state: %', v_result;
  END IF;

  v_result := public.cast_post_poll_vote_atomic(
    '40000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    ARRAY[1]
  );
  IF v_result <> '{"status":"not_found"}'::jsonb THEN
    RAISE EXCEPTION 'expired poll vote changed retained state: %', v_result;
  END IF;

  IF (SELECT pg_catalog.count(*) FROM public.post_likes) <> 1
    OR (SELECT pg_catalog.count(*) FROM public.post_votes) <> 1
    OR (SELECT pg_catalog.count(*) FROM public.post_bookmarks) <> 1
    OR (SELECT pg_catalog.count(*) FROM public.post_emoji_reactions) <> 1
    OR (SELECT pg_catalog.count(*) FROM public.poll_votes) <> 1
  THEN
    RAISE EXCEPTION 'expired RPC changed a child row';
  END IF;
END
$expired_contract$;
SQL

expect_denied() {
  local sql="$1"
  if psql_cmd -c "SET ROLE service_role; SELECT pg_catalog.set_config('request.jwt.claim.role','service_role',false); $sql" >/dev/null 2>&1; then
    echo "expected canonical child trigger denial: $sql" >&2
    exit 1
  fi
}

expect_denied "INSERT INTO public.post_likes (post_id,user_id,reaction_type) VALUES ('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','down')"
expect_denied "UPDATE public.post_votes SET choice='bear' WHERE post_id='10000000-0000-4000-8000-000000000001'"
expect_denied "UPDATE public.post_bookmarks SET folder_id=folder_id WHERE post_id='10000000-0000-4000-8000-000000000001'"
expect_denied "UPDATE public.post_emoji_reactions SET emoji='🚀' WHERE post_id='10000000-0000-4000-8000-000000000001'"
expect_denied "INSERT INTO public.comments (post_id,user_id,content) VALUES ('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','expired comment')"
expect_denied "UPDATE public.comment_likes SET reaction_type='dislike'"
expect_denied "UPDATE public.poll_votes SET option_index=1"
expect_denied "INSERT INTO public.post_reactions (post_id,user_id,reaction_type) VALUES ('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','rocket')"
expect_denied "INSERT INTO public.posts (id,author_id,original_post_id) VALUES ('10000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001')"

psql_cmd >/dev/null <<'SQL'
DO $acl_contract$
DECLARE
  v_signature regprocedure;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.toggle_post_reaction(uuid,uuid,text)'::regprocedure,
    'public.toggle_post_vote_atomic(uuid,uuid,text)'::regprocedure,
    'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)'::regprocedure,
    'public.toggle_post_emoji_reaction_atomic(uuid,uuid,text)'::regprocedure,
    'public.cast_post_poll_vote_atomic(uuid,uuid,integer[])'::regprocedure
  ]
  LOOP
    IF NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE')
      OR pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
      OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
    THEN
      RAISE EXCEPTION 'service-only RPC ACL drifted: %', v_signature;
    END IF;
  END LOOP;
END
$acl_contract$;
SQL

# The migration is replay-safe and replay does not mutate retained interaction rows.
psql_cmd <"$MIGRATION" >/dev/null
psql_cmd -Atqc "SELECT count(*) FROM public.post_likes" | grep -qx '1'
psql_cmd -Atqc "SELECT count(*) FROM public.post_bookmarks" | grep -qx '1'

echo "atomic post child interaction PostgreSQL 17 checks passed"
