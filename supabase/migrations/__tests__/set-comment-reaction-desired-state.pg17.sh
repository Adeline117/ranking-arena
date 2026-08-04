#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
BASE_MIGRATION="$ROOT_DIR/supabase/migrations/20260803106000_durable_comment_reaction_count_repair.sql"
DESIRED_MIGRATION="$ROOT_DIR/supabase/migrations/20260803107000_set_comment_reaction_desired_state.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/comment-reaction-desired-state-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="$((58900 + ($$ % 300)))"

cleanup() {
  local exit_code=$?
  if [[ -s "$PGDATA/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

mkdir -p "$SOCKET_DIR"
"$PG_BIN/initdb" \
  -D "$PGDATA" \
  --auth-local=trust \
  --auth-host=trust \
  --username=postgres \
  --encoding=UTF8 \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$PGDATA" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

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

assert_service_fails_42501() {
  local label="$1"
  local query="$2"
  if psql_cmd --set=VERBOSITY=verbose \
    -c "SET ROLE service_role;
        SET request.jwt.claim.role = 'service_role';
        $query" >"$TMP_ROOT/$label.out" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! grep -q '42501:' "$TMP_ROOT/$label.out"; then
    echo "$label failed without SQLSTATE 42501" >&2
    cat "$TMP_ROOT/$label.out" >&2
    exit 1
  fi
}

seed_same_state_reaction() {
  local post_id="$1"
  local comment_id="$2"
  local actor_id="$3"
  assert_service 'added|like|1|0' \
    "SELECT (result->>'action') || '|' || (result->>'reaction') || '|' ||
            (result->>'like_count') || '|' || (result->>'dislike_count')
       FROM (SELECT public.set_comment_reaction_desired_state_atomic(
         '$actor_id', '$post_id', '$comment_id', 'like'
       ) AS result) AS desired"
  psql_cmd -c \
    "DELETE FROM public.comment_reaction_count_repair_queue
      WHERE comment_id = '$comment_id'" >/dev/null
}

assert_unchanged_authorization_denied_without_leak() {
  local label="$1"
  local post_id="$2"
  local absent_comment_id="$3"
  local same_comment_id="$4"
  local actor_id="$5"

  assert_service_fails_42501 "${label}_absent" \
    "SELECT public.set_comment_reaction_desired_state_atomic(
       '$actor_id', '$post_id', '$absent_comment_id', NULL
     )"
  assert_service_fails_42501 "${label}_same" \
    "SELECT public.set_comment_reaction_desired_state_atomic(
       '$actor_id', '$post_id', '$same_comment_id', 'like'
     )"

  assert_scalar '0|0|1|0|0|1|0' \
    "SELECT
       (SELECT count(*)
          FROM public.comment_reaction_count_repair_queue
         WHERE comment_id IN ('$absent_comment_id', '$same_comment_id')) || '|' ||
       (SELECT count(*)
          FROM public.comment_likes
         WHERE comment_id = '$absent_comment_id'
           AND user_id = '$actor_id') || '|' ||
       (SELECT count(*)
          FROM public.comment_likes
         WHERE comment_id = '$same_comment_id'
           AND user_id = '$actor_id'
           AND reaction_type = 'like') || '|' ||
       (SELECT like_count FROM public.comments
         WHERE id = '$absent_comment_id') || '|' ||
       (SELECT dislike_count FROM public.comments
         WHERE id = '$absent_comment_id') || '|' ||
       (SELECT like_count FROM public.comments
         WHERE id = '$same_comment_id') || '|' ||
       (SELECT dislike_count FROM public.comments
         WHERE id = '$same_comment_id')"
}

assert_removal_after_authorization_revoke() {
  local label="$1"
  local post_id="$2"
  local comment_id="$3"
  local actor_id="$4"

  assert_service 'removed||false|false|0|0|7' \
    "SELECT (result->>'action') || '|' ||
            COALESCE(result->>'reaction', '') || '|' ||
            (result->>'liked') || '|' || (result->>'disliked') || '|' ||
            (result->>'like_count') || '|' ||
            (result->>'dislike_count') || '|' ||
            (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
       FROM (SELECT public.set_comment_reaction_desired_state_atomic(
         '$actor_id', '$post_id', '$comment_id', NULL
       ) AS result) AS desired"
  assert_scalar '0|0|0|1' \
    "SELECT
       (SELECT count(*) FROM public.comment_likes
         WHERE comment_id = '$comment_id' AND user_id = '$actor_id') || '|' ||
       (SELECT like_count FROM public.comments WHERE id = '$comment_id') || '|' ||
       (SELECT dislike_count FROM public.comments WHERE id = '$comment_id') || '|' ||
       (SELECT count(*) FROM public.comment_reaction_count_repair_queue
         WHERE comment_id = '$comment_id')"
  psql_cmd -c \
    "DELETE FROM public.comment_reaction_count_repair_queue
      WHERE comment_id = '$comment_id'" >/dev/null
}

assert_fails() {
  local label="$1"
  local query="$2"
  if psql_cmd -c "$query" >"$TMP_ROOT/$label.out" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
}

wait_for_activity() {
  local predicate="$1"
  local expected="$2"
  local label="$3"
  local actual='0'
  for _ in {1..120}; do
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

# Compact mature-schema fixture. It contains the exact contracts consumed by
# 1060 plus the active/group columns locked by the new desired-state wrapper.
psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER BYPASSRLS;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;

CREATE TYPE public.post_status AS ENUM ('draft', 'active', 'archived');

CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  dissolved_at timestamptz
);

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL REFERENCES auth.users(id),
  group_id uuid REFERENCES public.groups(id),
  original_post_id uuid REFERENCES public.posts(id),
  visibility text NOT NULL DEFAULT 'public',
  deleted_at timestamptz,
  status public.post_status NOT NULL DEFAULT 'active'
);

CREATE TABLE public.comments (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL
    REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id),
  deleted_at timestamptz,
  like_count integer NOT NULL DEFAULT 0 CHECK (like_count >= 0),
  dislike_count integer NOT NULL DEFAULT 0 CHECK (dislike_count >= 0)
);

CREATE TABLE public.comment_likes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  comment_id uuid NOT NULL
    REFERENCES public.comments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL
    REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction_type text NOT NULL
    CHECK (reaction_type IN ('like', 'dislike')),
  UNIQUE (comment_id, user_id)
);

CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);

CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE public.group_bans (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE public.user_follows (
  follower_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  following_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)
);

GRANT USAGE ON SCHEMA auth, public
  TO anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION auth.role()
  TO anon, authenticated, authenticator, service_role;

INSERT INTO auth.users (id) VALUES
  ('10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000003');
INSERT INTO public.posts (id, author_id) VALUES (
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003'
);
INSERT INTO public.comments (
  id,
  post_id,
  user_id,
  like_count,
  dislike_count
) VALUES (
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003',
  99,
  98
);
INSERT INTO public.comment_likes (comment_id, user_id, reaction_type) VALUES (
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'like'
);

CREATE OR REPLACE FUNCTION public.guard_canonical_comment_reaction_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF pg_catalog.pg_trigger_depth() > 1
     OR pg_catalog.current_setting('app.comment_reaction_path', true) =
       'toggle_comment_reaction'
  THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '42501',
    MESSAGE = 'direct comment reaction mutation is disabled; use toggle_comment_reaction';
END
$function$;

CREATE OR REPLACE FUNCTION public.sync_comment_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_comment_id uuid;
  v_like_delta integer := 0;
  v_dislike_delta integer := 0;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    v_comment_id := OLD.comment_id;
    IF OLD.reaction_type = 'like' THEN
      v_like_delta := v_like_delta - 1;
    ELSE
      v_dislike_delta := v_dislike_delta - 1;
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_comment_id := NEW.comment_id;
    IF NEW.reaction_type = 'like' THEN
      v_like_delta := v_like_delta + 1;
    ELSE
      v_dislike_delta := v_dislike_delta + 1;
    END IF;
  END IF;
  UPDATE public.comments
  SET like_count = GREATEST(like_count + v_like_delta, 0),
      dislike_count = GREATEST(dislike_count + v_dislike_delta, 0)
  WHERE id = v_comment_id;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.guard_contract_comment_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.like_count IS DISTINCT FROM 0
       OR NEW.dislike_count IS DISTINCT FROM 0
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '42501',
        MESSAGE = 'new comments must start with zero reaction counters';
    END IF;
    RETURN NEW;
  END IF;
  IF pg_catalog.pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'direct comment reaction counter updates are disabled';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_comment_likes_00_guard_canonical_mutation
BEFORE INSERT OR UPDATE OR DELETE
ON public.comment_likes
FOR EACH ROW
EXECUTE FUNCTION public.guard_canonical_comment_reaction_mutation();

CREATE TRIGGER trg_comment_likes_20_sync_counts
AFTER INSERT OR DELETE OR UPDATE OF comment_id, user_id, reaction_type
ON public.comment_likes
FOR EACH ROW
EXECUTE FUNCTION public.sync_comment_reaction_counts();

CREATE TRIGGER trg_comments_04_contract_reaction_counts
BEFORE INSERT OR UPDATE OF like_count, dislike_count
ON public.comments
FOR EACH ROW
EXECUTE FUNCTION public.guard_contract_comment_reaction_counts();

CREATE OR REPLACE FUNCTION public.acquire_post_audience_block_edges(
  p_actor_id uuid,
  p_author_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_pair text;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'block-edge actor is required';
  END IF;

  FOR v_pair IN
    SELECT DISTINCT
      LEAST(p_actor_id::text, author_row.author_id::text)
        || ':' || GREATEST(p_actor_id::text, author_row.author_id::text)
          AS affected_pair
    FROM pg_catalog.unnest(
      COALESCE(p_author_ids, ARRAY[]::uuid[])
    ) AS author_row(author_id)
    WHERE author_row.author_id IS NOT NULL
      AND author_row.author_id <> p_actor_id
    ORDER BY affected_pair
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('post-audience:block:' || v_pair, 0)
    );
  END LOOP;
END
$function$;

CREATE OR REPLACE FUNCTION public.lock_post_interaction_block_edges(
  p_post_id uuid,
  p_actor_id uuid,
  p_target_comment_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_effective_post_id uuid := p_post_id;
  v_wrapper_author_id uuid;
  v_root_id uuid;
  v_root_author_id uuid;
  v_target_post_id uuid;
  v_target_author_id uuid;
BEGIN
  IF p_actor_id IS NULL
     OR (p_post_id IS NULL AND p_target_comment_id IS NULL)
  THEN
    RETURN false;
  END IF;

  IF p_target_comment_id IS NOT NULL THEN
    SELECT target_comment.post_id, target_comment.user_id
    INTO v_target_post_id, v_target_author_id
    FROM public.comments AS target_comment
    WHERE target_comment.id = p_target_comment_id;

    IF NOT FOUND THEN
      RETURN false;
    END IF;

    IF v_effective_post_id IS NULL THEN
      v_effective_post_id := v_target_post_id;
    ELSIF v_target_post_id IS DISTINCT FROM v_effective_post_id THEN
      RETURN false;
    END IF;
  END IF;

  SELECT wrapper.author_id, wrapper.original_post_id
  INTO v_wrapper_author_id, v_root_id
  FROM public.posts AS wrapper
  WHERE wrapper.id = v_effective_post_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_root_id IS NOT NULL THEN
    SELECT root.author_id
    INTO v_root_author_id
    FROM public.posts AS root
    WHERE root.id = v_root_id
      AND root.original_post_id IS NULL;

    IF NOT FOUND THEN
      RETURN false;
    END IF;
  END IF;

  PERFORM public.acquire_post_audience_block_edges(
    p_actor_id,
    ARRAY[
      v_wrapper_author_id,
      v_root_author_id,
      v_target_author_id
    ]::uuid[]
  );

  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION public.toggle_comment_reaction_locked_impl(
  p_post_id uuid,
  p_comment_id uuid,
  p_user_id uuid,
  p_reaction_type text DEFAULT 'like'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_existing_id uuid;
  v_existing_type text;
  v_has_existing boolean;
  v_action text;
  v_reaction text;
  v_like_count integer;
  v_dislike_count integer;
  v_previous_path text;
BEGIN
  IF p_post_id IS NULL OR p_comment_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post_id, comment_id, and user_id are required';
  END IF;
  IF p_reaction_type IS NULL
     OR p_reaction_type NOT IN ('like', 'dislike')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'reaction_type must be like or dislike';
  END IF;

  PERFORM 1
  FROM public.posts AS target_post
  WHERE target_post.id = p_post_id
    AND target_post.deleted_at IS NULL
    AND target_post.status = 'active'
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'active post not found';
  END IF;

  PERFORM 1
  FROM public.comments AS target_comment
  WHERE target_comment.id = p_comment_id
    AND target_comment.post_id = p_post_id
    AND target_comment.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'active comment not found';
  END IF;

  SELECT reaction.id, reaction.reaction_type
  INTO v_existing_id, v_existing_type
  FROM public.comment_likes AS reaction
  WHERE reaction.comment_id = p_comment_id
    AND reaction.user_id = p_user_id
  FOR UPDATE;
  v_has_existing := FOUND;

  v_previous_path := pg_catalog.current_setting(
    'app.comment_reaction_path',
    true
  );
  PERFORM pg_catalog.set_config(
    'app.comment_reaction_path',
    'toggle_comment_reaction',
    true
  );

  IF v_has_existing AND v_existing_type = p_reaction_type THEN
    DELETE FROM public.comment_likes AS reaction
    WHERE reaction.id = v_existing_id;
    v_action := 'removed';
    v_reaction := NULL;
  ELSIF v_has_existing THEN
    UPDATE public.comment_likes AS reaction
    SET reaction_type = p_reaction_type
    WHERE reaction.id = v_existing_id;
    v_action := 'changed';
    v_reaction := p_reaction_type;
  ELSE
    INSERT INTO public.comment_likes (comment_id, user_id, reaction_type)
    VALUES (p_comment_id, p_user_id, p_reaction_type);
    v_action := 'added';
    v_reaction := p_reaction_type;
  END IF;

  SELECT target_comment.like_count, target_comment.dislike_count
  INTO v_like_count, v_dislike_count
  FROM public.comments AS target_comment
  WHERE target_comment.id = p_comment_id;

  PERFORM pg_catalog.set_config(
    'app.comment_reaction_path',
    COALESCE(v_previous_path, ''),
    true
  );

  RETURN pg_catalog.jsonb_build_object(
    'action', v_action,
    'reaction', v_reaction,
    'liked', COALESCE(v_reaction = 'like', false),
    'disliked', COALESCE(v_reaction = 'dislike', false),
    'like_count', v_like_count,
    'dislike_count', v_dislike_count
  );
END
$function$;

DO $seal_internal$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)'::regprocedure;
  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text) IS %L',
    'atomic-comment-block-authorization:v1:' || pg_catalog.md5(v_source)
  );
END
$seal_internal$;

CREATE OR REPLACE FUNCTION public.toggle_comment_reaction(
  p_post_id uuid,
  p_comment_id uuid,
  p_user_id uuid,
  p_reaction_type text DEFAULT 'like'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF p_post_id IS NOT NULL
     AND p_comment_id IS NOT NULL
     AND p_user_id IS NOT NULL
     AND NOT public.lock_post_interaction_block_edges(
       p_post_id,
       p_user_id,
       p_comment_id
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'active comment not found for post';
  END IF;
  RETURN public.toggle_comment_reaction_locked_impl(
    p_post_id,
    p_comment_id,
    p_user_id,
    p_reaction_type
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.increment_comment_like_count(p_comment_id uuid)
RETURNS integer LANGUAGE sql AS $function$ SELECT 0 $function$;
CREATE OR REPLACE FUNCTION public.decrement_comment_like_count(p_comment_id uuid)
RETURNS integer LANGUAGE sql AS $function$ SELECT 0 $function$;

ALTER FUNCTION public.guard_canonical_comment_reaction_mutation() OWNER TO postgres;
ALTER FUNCTION public.sync_comment_reaction_counts() OWNER TO postgres;
ALTER FUNCTION public.guard_contract_comment_reaction_counts() OWNER TO postgres;
ALTER FUNCTION public.acquire_post_audience_block_edges(uuid, uuid[])
  OWNER TO postgres;
ALTER FUNCTION public.lock_post_interaction_block_edges(uuid, uuid, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.toggle_comment_reaction_locked_impl(uuid, uuid, uuid, text)
  OWNER TO postgres;
ALTER FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text)
  OWNER TO postgres;

REVOKE ALL ON TABLE public.comment_likes
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.comments
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.toggle_comment_reaction_locked_impl(
  uuid, uuid, uuid, text
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.acquire_post_audience_block_edges(uuid, uuid[])
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.lock_post_interaction_block_edges(
  uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_comment_like_count(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.decrement_comment_like_count(uuid)
  TO service_role;
SQL

psql_cmd -f "$BASE_MIGRATION"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"
assert_scalar '1|0' \
  "SELECT like_count || '|' || dislike_count
     FROM public.comments
    WHERE id = '30000000-0000-0000-0000-000000000001'"

psql_cmd -f "$DESIRED_MIGRATION"

# service_only_acl: exact shape and no browser execution path.
assert_scalar 'p_actor_id,p_post_id,p_comment_id,p_desired_reaction|0|true|false|false|false' \
  "SELECT pg_catalog.array_to_string(function_row.proargnames, ',') || '|' ||
          function_row.pronargdefaults || '|' ||
          pg_catalog.has_function_privilege(
            'service_role', function_row.oid, 'EXECUTE'
          )::text || '|' ||
          pg_catalog.has_function_privilege(
            'anon', function_row.oid, 'EXECUTE'
          )::text || '|' ||
          pg_catalog.has_function_privilege(
            'authenticated', function_row.oid, 'EXECUTE'
          )::text || '|' ||
          pg_catalog.has_function_privilege(
            'authenticator', function_row.oid, 'EXECUTE'
          )::text
     FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'::regprocedure"
assert_fails service_only_acl \
  "SET ROLE authenticated;
   SET request.jwt.claim.role = 'authenticated';
   SELECT public.set_comment_reaction_desired_state_atomic(
     '10000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000001',
     '30000000-0000-0000-0000-000000000001',
     'like'
   )"

assert_service 'invalid|1' \
  "SELECT result->>'status' || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.set_comment_reaction_desired_state_atomic(
       NULL::uuid,
       '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000001',
       'like'
     ) AS result) AS desired"
assert_service 'invalid' \
  "SELECT public.set_comment_reaction_desired_state_atomic(
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    'love'
  )->>'status'"
assert_service 'not_found' \
  "SELECT public.set_comment_reaction_desired_state_atomic(
    '10000000-0000-0000-0000-000000000099',
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    'like'
  )->>'status'"
assert_service 'not_found' \
  "SELECT public.set_comment_reaction_desired_state_atomic(
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000099',
    'like'
  )->>'status'"

# desired_state_replay: a lost-response retry is unchanged, never a toggle.
assert_service 'added|like|true|false|2|0|7' \
  "SELECT (result->>'action') || '|' || (result->>'reaction') || '|' ||
          (result->>'liked') || '|' || (result->>'disliked') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.set_comment_reaction_desired_state_atomic(
       '10000000-0000-0000-0000-000000000002',
       '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000001',
       'like'
     ) AS result) AS desired"
assert_service 'unchanged|like|2|0|7' \
  "SELECT (result->>'action') || '|' || (result->>'reaction') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.set_comment_reaction_desired_state_atomic(
       '10000000-0000-0000-0000-000000000002',
       '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000001',
       'like'
     ) AS result) AS desired"

# desired_state_change and desired_state_remove cover the complete matrix.
assert_service 'changed|dislike|1|1' \
  "SELECT (result->>'action') || '|' || (result->>'reaction') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count')
     FROM (SELECT public.set_comment_reaction_desired_state_atomic(
       '10000000-0000-0000-0000-000000000002',
       '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000001',
       'dislike'
     ) AS result) AS desired"
assert_service 'unchanged|dislike|1|1' \
  "SELECT (result->>'action') || '|' || (result->>'reaction') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count')
     FROM (SELECT public.set_comment_reaction_desired_state_atomic(
       '10000000-0000-0000-0000-000000000002',
       '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000001',
       'dislike'
     ) AS result) AS desired"
assert_service 'removed||false|false|1|0' \
  "SELECT (result->>'action') || '|' || COALESCE(result->>'reaction', '') || '|' ||
          (result->>'liked') || '|' || (result->>'disliked') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count')
     FROM (SELECT public.set_comment_reaction_desired_state_atomic(
       '10000000-0000-0000-0000-000000000002',
       '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000001',
       NULL
     ) AS result) AS desired"
assert_service 'unchanged||1|0' \
  "SELECT (result->>'action') || '|' || COALESCE(result->>'reaction', '') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count')
     FROM (SELECT public.set_comment_reaction_desired_state_atomic(
       '10000000-0000-0000-0000-000000000002',
       '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000001',
       NULL
     ) AS result) AS desired"

# Build three isolated audience fixtures. Every restricted scenario uses one
# absent reaction and one existing like so both no-op shapes can be exercised
# against the same frozen post/comment authorization snapshot.
psql_cmd <<'SQL'
INSERT INTO auth.users (id) VALUES
  ('10000000-0000-0000-0000-000000000010'),
  ('10000000-0000-0000-0000-000000000011'),
  ('10000000-0000-0000-0000-000000000012'),
  ('10000000-0000-0000-0000-000000000013'),
  ('10000000-0000-0000-0000-000000000014'),
  ('10000000-0000-0000-0000-000000000015'),
  ('10000000-0000-0000-0000-000000000016'),
  ('10000000-0000-0000-0000-000000000017');

INSERT INTO public.groups (id) VALUES
  ('40000000-0000-0000-0000-000000000001');

INSERT INTO public.posts (
  id,
  author_id,
  group_id,
  original_post_id,
  visibility
) VALUES
  (
    '20000000-0000-0000-0000-000000000010',
    '10000000-0000-0000-0000-000000000011',
    NULL,
    NULL,
    'public'
  ),
  (
    '20000000-0000-0000-0000-000000000011',
    '10000000-0000-0000-0000-000000000012',
    NULL,
    '20000000-0000-0000-0000-000000000010',
    'public'
  ),
  (
    '20000000-0000-0000-0000-000000000012',
    '10000000-0000-0000-0000-000000000014',
    '40000000-0000-0000-0000-000000000001',
    NULL,
    'group'
  ),
  (
    '20000000-0000-0000-0000-000000000013',
    '10000000-0000-0000-0000-000000000016',
    NULL,
    NULL,
    'followers'
  );

INSERT INTO public.comments (id, post_id, user_id) VALUES
  (
    '30000000-0000-0000-0000-000000000010',
    '20000000-0000-0000-0000-000000000011',
    '10000000-0000-0000-0000-000000000013'
  ),
  (
    '30000000-0000-0000-0000-000000000011',
    '20000000-0000-0000-0000-000000000011',
    '10000000-0000-0000-0000-000000000013'
  ),
  (
    '30000000-0000-0000-0000-000000000012',
    '20000000-0000-0000-0000-000000000012',
    '10000000-0000-0000-0000-000000000015'
  ),
  (
    '30000000-0000-0000-0000-000000000013',
    '20000000-0000-0000-0000-000000000012',
    '10000000-0000-0000-0000-000000000015'
  ),
  (
    '30000000-0000-0000-0000-000000000014',
    '20000000-0000-0000-0000-000000000013',
    '10000000-0000-0000-0000-000000000017'
  ),
  (
    '30000000-0000-0000-0000-000000000015',
    '20000000-0000-0000-0000-000000000013',
    '10000000-0000-0000-0000-000000000017'
  );

INSERT INTO public.group_members (group_id, user_id) VALUES (
  '40000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000010'
);
INSERT INTO public.user_follows (follower_id, following_id) VALUES (
  '10000000-0000-0000-0000-000000000010',
  '10000000-0000-0000-0000-000000000016'
);
DELETE FROM public.comment_reaction_count_repair_queue;
SQL

authorization_actor='10000000-0000-0000-0000-000000000010'
repost_id='20000000-0000-0000-0000-000000000011'
repost_absent_comment='30000000-0000-0000-0000-000000000010'
repost_same_comment='30000000-0000-0000-0000-000000000011'
group_post_id='20000000-0000-0000-0000-000000000012'
group_absent_comment='30000000-0000-0000-0000-000000000012'
group_same_comment='30000000-0000-0000-0000-000000000013'
follower_post_id='20000000-0000-0000-0000-000000000013'
follower_absent_comment='30000000-0000-0000-0000-000000000014'
follower_same_comment='30000000-0000-0000-0000-000000000015'

# unchanged_absent_authorization: absent + desired NULL is an authorized read,
# not a free existence/count oracle.
# unchanged_same_state_authorization: an already-satisfied desired reaction
# must cross the same wrapper/comment/root/audience checks as an add/change.
# removal_after_authorization_revoke: the existing edge remains removable after
# every block/audience revocation below.

# Wrapper-author block.
seed_same_state_reaction \
  "$repost_id" "$repost_same_comment" "$authorization_actor"
psql_cmd -c \
  "INSERT INTO public.blocked_users (blocker_id, blocked_id) VALUES (
    '$authorization_actor', '10000000-0000-0000-0000-000000000012'
  )" >/dev/null
assert_unchanged_authorization_denied_without_leak wrapper_block \
  "$repost_id" "$repost_absent_comment" "$repost_same_comment" \
  "$authorization_actor"
assert_removal_after_authorization_revoke wrapper_block \
  "$repost_id" "$repost_same_comment" "$authorization_actor"
psql_cmd -c \
  "DELETE FROM public.blocked_users
    WHERE blocker_id = '$authorization_actor'
      AND blocked_id = '10000000-0000-0000-0000-000000000012'" >/dev/null

# Target-comment-author block.
seed_same_state_reaction \
  "$repost_id" "$repost_same_comment" "$authorization_actor"
psql_cmd -c \
  "INSERT INTO public.blocked_users (blocker_id, blocked_id) VALUES (
    '$authorization_actor', '10000000-0000-0000-0000-000000000013'
  )" >/dev/null
assert_unchanged_authorization_denied_without_leak comment_block \
  "$repost_id" "$repost_absent_comment" "$repost_same_comment" \
  "$authorization_actor"
assert_removal_after_authorization_revoke comment_block \
  "$repost_id" "$repost_same_comment" "$authorization_actor"
psql_cmd -c \
  "DELETE FROM public.blocked_users
    WHERE blocker_id = '$authorization_actor'
      AND blocked_id = '10000000-0000-0000-0000-000000000013'" >/dev/null

# Repost-root-author block.
seed_same_state_reaction \
  "$repost_id" "$repost_same_comment" "$authorization_actor"
psql_cmd -c \
  "INSERT INTO public.blocked_users (blocker_id, blocked_id) VALUES (
    '$authorization_actor', '10000000-0000-0000-0000-000000000011'
  )" >/dev/null
assert_unchanged_authorization_denied_without_leak root_block \
  "$repost_id" "$repost_absent_comment" "$repost_same_comment" \
  "$authorization_actor"
assert_removal_after_authorization_revoke root_block \
  "$repost_id" "$repost_same_comment" "$authorization_actor"
psql_cmd -c \
  "DELETE FROM public.blocked_users
    WHERE blocker_id = '$authorization_actor'
      AND blocked_id = '10000000-0000-0000-0000-000000000011'" >/dev/null

# Active group ban.
seed_same_state_reaction \
  "$group_post_id" "$group_same_comment" "$authorization_actor"
psql_cmd -c \
  "INSERT INTO public.group_bans (group_id, user_id) VALUES (
    '40000000-0000-0000-0000-000000000001', '$authorization_actor'
  )" >/dev/null
assert_unchanged_authorization_denied_without_leak group_ban \
  "$group_post_id" "$group_absent_comment" "$group_same_comment" \
  "$authorization_actor"
assert_removal_after_authorization_revoke group_ban \
  "$group_post_id" "$group_same_comment" "$authorization_actor"
psql_cmd -c \
  "DELETE FROM public.group_bans
    WHERE group_id = '40000000-0000-0000-0000-000000000001'
      AND user_id = '$authorization_actor'" >/dev/null

# Group membership revoked.
seed_same_state_reaction \
  "$group_post_id" "$group_same_comment" "$authorization_actor"
psql_cmd -c \
  "DELETE FROM public.group_members
    WHERE group_id = '40000000-0000-0000-0000-000000000001'
      AND user_id = '$authorization_actor'" >/dev/null
assert_unchanged_authorization_denied_without_leak group_membership \
  "$group_post_id" "$group_absent_comment" "$group_same_comment" \
  "$authorization_actor"
assert_removal_after_authorization_revoke group_membership \
  "$group_post_id" "$group_same_comment" "$authorization_actor"
psql_cmd -c \
  "INSERT INTO public.group_members (group_id, user_id) VALUES (
    '40000000-0000-0000-0000-000000000001', '$authorization_actor'
  )" >/dev/null

# Dissolved group.
seed_same_state_reaction \
  "$group_post_id" "$group_same_comment" "$authorization_actor"
psql_cmd -c \
  "UPDATE public.groups
      SET dissolved_at = pg_catalog.statement_timestamp()
    WHERE id = '40000000-0000-0000-0000-000000000001'" >/dev/null
assert_unchanged_authorization_denied_without_leak group_dissolved \
  "$group_post_id" "$group_absent_comment" "$group_same_comment" \
  "$authorization_actor"
assert_removal_after_authorization_revoke group_dissolved \
  "$group_post_id" "$group_same_comment" "$authorization_actor"
psql_cmd -c \
  "UPDATE public.groups
      SET dissolved_at = NULL
    WHERE id = '40000000-0000-0000-0000-000000000001'" >/dev/null

# Followers-only access revoked.
seed_same_state_reaction \
  "$follower_post_id" "$follower_same_comment" "$authorization_actor"
psql_cmd -c \
  "DELETE FROM public.user_follows
    WHERE follower_id = '$authorization_actor'
      AND following_id = '10000000-0000-0000-0000-000000000016'" >/dev/null
assert_unchanged_authorization_denied_without_leak follower_access \
  "$follower_post_id" "$follower_absent_comment" "$follower_same_comment" \
  "$authorization_actor"
assert_removal_after_authorization_revoke follower_access \
  "$follower_post_id" "$follower_same_comment" "$authorization_actor"

# stale_cache_absolute_ack: unchanged requests return canonical source truth and
# leave Q, then the bounded worker repairs the deliberately stale cache.
psql_cmd <<'SQL'
BEGIN;
SELECT pg_catalog.set_config(
  'app.comment_reaction_repair_path',
  'repair_comment_reaction_counts_atomic',
  true
);
UPDATE public.comments
SET like_count = 77,
    dislike_count = 66
WHERE id = '30000000-0000-0000-0000-000000000001';
COMMIT;
SQL
assert_service 'unchanged|like|1|0' \
  "SELECT (result->>'action') || '|' || (result->>'reaction') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count')
     FROM (SELECT public.set_comment_reaction_desired_state_atomic(
       '10000000-0000-0000-0000-000000000001',
       '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000001',
       'like'
     ) AS result) AS desired"
assert_scalar '1' \
  "SELECT count(*)
     FROM public.comment_reaction_count_repair_queue
    WHERE comment_id = '30000000-0000-0000-0000-000000000001'"
assert_scalar '77|66' \
  "SELECT like_count || '|' || dislike_count
     FROM public.comments
    WHERE id = '30000000-0000-0000-0000-000000000001'"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"
assert_scalar '1|0' \
  "SELECT like_count || '|' || dislike_count
     FROM public.comments
    WHERE id = '30000000-0000-0000-0000-000000000001'"

# Legacy rolling-deploy compatibility remains intact.
assert_service 'added|dislike|1|1|6' \
  "SELECT (result->>'action') || '|' || (result->>'reaction') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
     FROM (SELECT public.toggle_comment_reaction(
       '20000000-0000-0000-0000-000000000001',
       '30000000-0000-0000-0000-000000000001',
       '10000000-0000-0000-0000-000000000003',
       'dislike'
     ) AS result) AS legacy"

# unknown_acl_drift: replay converges arbitrary grantees and grant options.
psql_cmd <<'SQL'
CREATE ROLE desired_acl_probe NOLOGIN;
GRANT EXECUTE ON FUNCTION
  public.set_comment_reaction_desired_state_atomic(uuid, uuid, uuid, text)
  TO desired_acl_probe WITH GRANT OPTION;
SQL
psql_cmd -f "$DESIRED_MIGRATION"
assert_scalar 'f' \
  "SELECT pg_catalog.has_function_privilege(
    'desired_acl_probe',
    'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)',
    'EXECUTE'
  )"

# dependency_source_drift: changing composed executable source while leaving
# its 1060 attestation behind fails closed.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.enqueue_comment_reaction_count_repair()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
BEGIN
  RAISE EXCEPTION 'dependency_source_drift';
END
$function$;
SQL
if psql_cmd -f "$DESIRED_MIGRATION" >"$TMP_ROOT/dependency_source_drift.out" 2>&1; then
  echo 'dependency_source_drift unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'comment reaction dependency source drifted' \
  "$TMP_ROOT/dependency_source_drift.out"
psql_cmd -f "$BASE_MIGRATION"
psql_cmd -f "$DESIRED_MIGRATION"

# Runtime shared gate blocks a concurrent migration replay before table locks.
psql_cmd >"$TMP_ROOT/runtime-gate.out" 2>&1 <<'SQL' &
SET application_name = 'runtime_shared_gate_blocks_replay';
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
BEGIN;
SELECT public.set_comment_reaction_desired_state_atomic(
  '10000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001',
  'like'
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
runtime_gate_pid=$!
wait_for_activity \
  "application_name = 'runtime_shared_gate_blocks_replay' AND state = 'active' AND query LIKE '%pg_sleep%'" \
  1 \
  runtime_shared_gate_blocks_replay
if psql_cmd -f "$DESIRED_MIGRATION" >"$TMP_ROOT/runtime-gate-replay.out" 2>&1; then
  echo 'runtime shared gate replay unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'comment reaction desired-state migration gate is busy' \
  "$TMP_ROOT/runtime-gate-replay.out"
wait "$runtime_gate_pid"
psql_cmd -f "$DESIRED_MIGRATION"

# desired_vs_auth_delete: while desired-state waits on C it already owns the
# actor KEY SHARE lock, so account deletion cannot cascade ahead of it.
psql_cmd <<'SQL'
DELETE FROM public.comment_reaction_count_repair_queue;
INSERT INTO auth.users (id) VALUES
  ('10000000-0000-0000-0000-000000000004');
INSERT INTO public.posts (id, author_id) VALUES (
  '20000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000003'
);
INSERT INTO public.comments (id, post_id, user_id) VALUES (
  '30000000-0000-0000-0000-000000000004',
  '20000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000003'
);
SQL
psql_cmd >"$TMP_ROOT/comment-holder.out" 2>&1 <<'SQL' &
SET application_name = 'desired_vs_auth_delete_comment_holder';
BEGIN;
SELECT 1
FROM public.comments
WHERE id = '30000000-0000-0000-0000-000000000004'
FOR UPDATE;
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
comment_holder_pid=$!
wait_for_activity \
  "application_name = 'desired_vs_auth_delete_comment_holder' AND state = 'active' AND query LIKE '%pg_sleep%'" \
  1 \
  desired_vs_auth_delete_comment_holder
psql_cmd >"$TMP_ROOT/desired-vs-auth.out" 2>&1 <<'SQL' &
SET application_name = 'desired_vs_auth_delete';
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.set_comment_reaction_desired_state_atomic(
  '10000000-0000-0000-0000-000000000004',
  '20000000-0000-0000-0000-000000000004',
  '30000000-0000-0000-0000-000000000004',
  'like'
);
SQL
desired_pid=$!
wait_for_activity \
  "application_name = 'desired_vs_auth_delete' AND wait_event_type = 'Lock'" \
  1 \
  desired_vs_auth_delete
psql_cmd >"$TMP_ROOT/auth-delete.out" 2>&1 <<'SQL' &
SET application_name = 'desired_vs_auth_delete_account_delete';
DELETE FROM auth.users
WHERE id = '10000000-0000-0000-0000-000000000004';
SQL
auth_delete_pid=$!
wait_for_activity \
  "application_name = 'desired_vs_auth_delete_account_delete' AND wait_event_type = 'Lock'" \
  1 \
  desired_vs_auth_delete_account_delete
wait "$comment_holder_pid"
wait "$desired_pid"
wait "$auth_delete_pid"
assert_scalar '0|0|1|1' \
  "SELECT
     (SELECT count(*) FROM auth.users
       WHERE id = '10000000-0000-0000-0000-000000000004') || '|' ||
     (SELECT count(*) FROM public.comment_likes
       WHERE comment_id = '30000000-0000-0000-0000-000000000004') || '|' ||
     (SELECT like_count FROM public.comments
       WHERE id = '30000000-0000-0000-0000-000000000004') || '|' ||
     (SELECT count(*) FROM public.comment_reaction_count_repair_queue
       WHERE comment_id = '30000000-0000-0000-0000-000000000004')"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"
assert_scalar '0|0' \
  "SELECT like_count || '|' || dislike_count
     FROM public.comments
    WHERE id = '30000000-0000-0000-0000-000000000004'"

# comment_likes_truncate_acl_drift: row triggers cannot observe TRUNCATE, so a
# replay must fail closed if any non-owner gains that source-destructive right.
psql_cmd -c \
  'GRANT TRUNCATE ON TABLE public.comment_likes TO service_role'
if psql_cmd -f "$DESIRED_MIGRATION" \
  >"$TMP_ROOT/comment_likes_truncate_acl_drift.out" 2>&1; then
  echo 'comment_likes_truncate_acl_drift unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'comment reaction source or repair queue ACL boundary drifted' \
  "$TMP_ROOT/comment_likes_truncate_acl_drift.out"
psql_cmd -c \
  'REVOKE TRUNCATE ON TABLE public.comment_likes FROM service_role'
psql_cmd -f "$DESIRED_MIGRATION"

# block_helper_source_drift: exact signature/metadata and an old attestation
# comment are insufficient when the executable helper body has changed.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.lock_post_interaction_block_edges(
  p_post_id uuid,
  p_actor_id uuid,
  p_target_comment_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  RETURN false;
END
$function$;
SQL
if psql_cmd -f "$DESIRED_MIGRATION" \
  >"$TMP_ROOT/block_helper_source_drift.out" 2>&1; then
  echo 'block_helper_source_drift unexpectedly succeeded' >&2
  exit 1
fi
grep -q 'comment reaction block-edge authorization dependency drifted' \
  "$TMP_ROOT/block_helper_source_drift.out"

echo 'comment reaction desired-state PG17 proof passed'
