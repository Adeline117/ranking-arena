#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803106000_durable_comment_reaction_count_repair.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/comment-reaction-count-repair-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="$((58600 + ($$ % 300)))"

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

# A compact mature-schema fixture. Its public wrapper and sealed implementation
# intentionally model the deployed legacy toggle contract that 1060 must retain.
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

GRANT USAGE ON SCHEMA auth, public
  TO anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION auth.role()
  TO anon, authenticated, authenticator, service_role;

CREATE TABLE public.posts (
  id uuid PRIMARY KEY
);

CREATE TABLE public.comments (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL
    REFERENCES public.posts(id) ON DELETE CASCADE,
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

INSERT INTO auth.users (id) VALUES
  ('10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000003');
INSERT INTO public.posts (id) VALUES
  ('20000000-0000-0000-0000-000000000001');
INSERT INTO public.comments (id, post_id, like_count, dislike_count) VALUES (
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
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

CREATE OR REPLACE FUNCTION public.lock_post_interaction_block_edges(
  p_post_id uuid,
  p_actor_id uuid,
  p_comment_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'fixture:comment-block:' || p_actor_id::text || ':' || p_comment_id::text,
      0
    )
  );
  RETURN EXISTS (
    SELECT 1
    FROM public.posts AS target_post
    JOIN public.comments AS target_comment
      ON target_comment.post_id = target_post.id
    WHERE target_post.id = p_post_id
      AND target_comment.id = p_comment_id
  );
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
  v_comment_post_id uuid;
  v_existing_id uuid;
  v_existing_type text;
  v_has_existing boolean;
  v_is_removal boolean;
  v_action text;
  v_reaction text;
  v_like_count integer;
  v_dislike_count integer;
  v_previous_reaction_path text;
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
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'active post not found';
  END IF;

  SELECT target_comment.post_id
  INTO v_comment_post_id
  FROM public.comments AS target_comment
  WHERE target_comment.id = p_comment_id
    AND target_comment.post_id = p_post_id
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
  v_is_removal := v_has_existing AND v_existing_type = p_reaction_type;

  v_previous_reaction_path := pg_catalog.current_setting(
    'app.comment_reaction_path',
    true
  );
  PERFORM pg_catalog.set_config(
    'app.comment_reaction_path',
    'toggle_comment_reaction',
    true
  );

  IF v_is_removal THEN
    DELETE FROM public.comment_likes
    WHERE id = v_existing_id;
    v_action := 'removed';
    v_reaction := NULL;
  ELSIF v_has_existing THEN
    UPDATE public.comment_likes
    SET reaction_type = p_reaction_type
    WHERE id = v_existing_id;
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
    COALESCE(v_previous_reaction_path, ''),
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
    'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)'::pg_catalog.regprocedure;
  COMMENT ON FUNCTION public.toggle_comment_reaction_locked_impl(
    uuid, uuid, uuid, text
  ) IS 'temporary';
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
  THEN
    IF NOT public.lock_post_interaction_block_edges(
      p_post_id,
      p_user_id,
      p_comment_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'active comment not found for post';
    END IF;
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
RETURNS integer
LANGUAGE sql
AS $function$
  SELECT 0
$function$;
CREATE OR REPLACE FUNCTION public.decrement_comment_like_count(p_comment_id uuid)
RETURNS integer
LANGUAGE sql
AS $function$
  SELECT 0
$function$;

ALTER FUNCTION public.guard_canonical_comment_reaction_mutation() OWNER TO postgres;
ALTER FUNCTION public.sync_comment_reaction_counts() OWNER TO postgres;
ALTER FUNCTION public.guard_contract_comment_reaction_counts() OWNER TO postgres;
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
REVOKE ALL ON FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.increment_comment_like_count(uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.decrement_comment_like_count(uuid)
  TO service_role;
SQL

psql_cmd -f "$MIGRATION"

# Initial cutover backfill is absolute, not arithmetic.
assert_scalar '1' \
  "SELECT count(*) FROM public.comment_reaction_count_repair_queue"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"
assert_scalar '1|0|0' \
  "SELECT like_count || '|' || dislike_count || '|' ||
     (SELECT count(*) FROM public.comment_reaction_count_repair_queue)
   FROM public.comments
   WHERE id = '30000000-0000-0000-0000-000000000001'"

# The legacy ACK keeps six keys and synchronous add/change/remove counts.
assert_service 'added|dislike|1|1|6' \
  "SELECT (result->>'action') || '|' || (result->>'reaction') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
   FROM (SELECT public.toggle_comment_reaction(
     '20000000-0000-0000-0000-000000000001',
     '30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000002',
     'dislike'
   ) AS result) AS toggle_result"
assert_service 'changed|like|2|0|6' \
  "SELECT (result->>'action') || '|' || (result->>'reaction') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
   FROM (SELECT public.toggle_comment_reaction(
     '20000000-0000-0000-0000-000000000001',
     '30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000002',
     'like'
   ) AS result) AS toggle_result"
assert_service 'removed|null|1|0|6' \
  "SELECT (result->>'action') || '|' ||
          pg_catalog.jsonb_typeof(result->'reaction') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
   FROM (SELECT public.toggle_comment_reaction(
     '20000000-0000-0000-0000-000000000001',
     '30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000002',
     'like'
   ) AS result) AS toggle_result"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"

# direct_comment_like_dml: application DML is denied, and privileged canonical
# INSERT/UPDATE/DELETE each keep synchronous truth while enqueuing one Q row.
assert_fails direct_comment_like_insert \
  "INSERT INTO public.comment_likes (comment_id, user_id, reaction_type)
   VALUES (
     '30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000002',
     'dislike'
   )"
assert_fails service_comment_like_insert \
  "SET ROLE service_role; INSERT INTO public.comment_likes
   (comment_id, user_id, reaction_type) VALUES (
     '30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000002',
     'dislike'
   )"
psql_cmd <<'SQL'
BEGIN;
SELECT pg_catalog.set_config(
  'app.comment_reaction_path',
  'toggle_comment_reaction',
  true
);
INSERT INTO public.comment_likes (comment_id, user_id, reaction_type) VALUES (
  '30000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000002',
  'dislike'
);
COMMIT;
SQL
assert_scalar '1|1|1' \
  "SELECT like_count || '|' || dislike_count || '|' ||
     (SELECT count(*) FROM public.comment_reaction_count_repair_queue)
   FROM public.comments
   WHERE id = '30000000-0000-0000-0000-000000000001'"
assert_fails direct_comment_like_update \
  "UPDATE public.comment_likes SET reaction_type = 'like'
   WHERE comment_id = '30000000-0000-0000-0000-000000000001'
     AND user_id = '10000000-0000-0000-0000-000000000002'"
assert_fails direct_comment_like_delete \
  "DELETE FROM public.comment_likes
   WHERE comment_id = '30000000-0000-0000-0000-000000000001'
     AND user_id = '10000000-0000-0000-0000-000000000002'"
psql_cmd <<'SQL'
BEGIN;
SELECT pg_catalog.set_config(
  'app.comment_reaction_path',
  'toggle_comment_reaction',
  true
);
UPDATE public.comment_likes
SET reaction_type = 'like'
WHERE comment_id = '30000000-0000-0000-0000-000000000001'
  AND user_id = '10000000-0000-0000-0000-000000000002';
DELETE FROM public.comment_likes
WHERE comment_id = '30000000-0000-0000-0000-000000000001'
  AND user_id = '10000000-0000-0000-0000-000000000002';
COMMIT;
SQL
assert_scalar '1|0|1' \
  "SELECT like_count || '|' || dislike_count || '|' ||
     (SELECT count(*) FROM public.comment_reaction_count_repair_queue)
   FROM public.comments
   WHERE id = '30000000-0000-0000-0000-000000000001'"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"

# auth_account_cascade: child DELETE never updates comments in the FK trigger;
# it commits a durable Q obligation that the service worker repairs.
assert_service '2' \
  "SELECT public.toggle_comment_reaction(
    '20000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000003',
    'like'
  )->>'like_count'"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"
psql_cmd -c \
  "DELETE FROM auth.users
   WHERE id = '10000000-0000-0000-0000-000000000003'"
assert_scalar '2|1|1' \
  "SELECT like_count || '|' ||
          (SELECT count(*) FROM public.comment_likes WHERE comment_id = comments.id) || '|' ||
          (SELECT count(*) FROM public.comment_reaction_count_repair_queue
            WHERE comment_id = comments.id)
   FROM public.comments
   WHERE id = '30000000-0000-0000-0000-000000000001'"

# cascade_then_toggle_absolute_ack: do not run the worker. The next canonical
# toggle derives its ACK/cache from absolute source truth, not the stale delta.
assert_service 'added|dislike|1|1|6' \
  "SELECT (result->>'action') || '|' || (result->>'reaction') || '|' ||
          (result->>'like_count') || '|' || (result->>'dislike_count') || '|' ||
          (SELECT count(*) FROM pg_catalog.jsonb_object_keys(result))
   FROM (SELECT public.toggle_comment_reaction(
     '20000000-0000-0000-0000-000000000001',
     '30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000002',
     'dislike'
   ) AS result) AS toggle_result"
assert_scalar '1|1|1|1|1' \
  "SELECT comments.like_count || '|' || comments.dislike_count || '|' ||
          (SELECT count(*) FROM public.comment_likes AS reaction
            WHERE reaction.comment_id = comments.id
              AND reaction.reaction_type = 'like') || '|' ||
          (SELECT count(*) FROM public.comment_likes AS reaction
            WHERE reaction.comment_id = comments.id
              AND reaction.reaction_type = 'dislike') || '|' ||
          (SELECT count(*) FROM public.comment_reaction_count_repair_queue
            WHERE comment_id = comments.id)
   FROM public.comments
   WHERE id = '30000000-0000-0000-0000-000000000001'"
assert_service '1|0' \
  "SELECT (result->>'like_count') || '|' || (result->>'dislike_count')
   FROM (SELECT public.toggle_comment_reaction(
     '20000000-0000-0000-0000-000000000001',
     '30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000002',
     'dislike'
   ) AS result) AS toggle_result"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"
assert_scalar '1|0' \
  "SELECT like_count || '|' || dislike_count FROM public.comments
   WHERE id = '30000000-0000-0000-0000-000000000001'"

# comment_cascade retains a stale no-FK Q identity and discards it after commit.
psql_cmd <<'SQL'
INSERT INTO public.posts (id) VALUES
  ('20000000-0000-0000-0000-000000000002');
INSERT INTO public.comments (id, post_id) VALUES (
  '30000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000002'
);
SQL
assert_service '1' \
  "SELECT public.toggle_comment_reaction(
    '20000000-0000-0000-0000-000000000002',
    '30000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000002',
    'dislike'
  )->>'dislike_count'"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"
psql_cmd -c \
  "DELETE FROM public.comments
   WHERE id = '30000000-0000-0000-0000-000000000002'"
assert_scalar '0|0|1' \
  "SELECT
     (SELECT count(*) FROM public.comments
       WHERE id = '30000000-0000-0000-0000-000000000002') || '|' ||
     (SELECT count(*) FROM public.comment_likes
       WHERE comment_id = '30000000-0000-0000-0000-000000000002') || '|' ||
     (SELECT count(*) FROM public.comment_reaction_count_repair_queue
       WHERE comment_id = '30000000-0000-0000-0000-000000000002')"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'discarded_count'"

# post_cascade follows post -> comment -> child; Q survives both cascades.
psql_cmd <<'SQL'
INSERT INTO public.posts (id) VALUES
  ('20000000-0000-0000-0000-000000000003');
INSERT INTO public.comments (id, post_id) VALUES (
  '30000000-0000-0000-0000-000000000003',
  '20000000-0000-0000-0000-000000000003'
);
SQL
assert_service '1' \
  "SELECT public.toggle_comment_reaction(
    '20000000-0000-0000-0000-000000000003',
    '30000000-0000-0000-0000-000000000003',
    '10000000-0000-0000-0000-000000000002',
    'like'
  )->>'like_count'"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"
psql_cmd -c \
  "DELETE FROM public.posts
   WHERE id = '20000000-0000-0000-0000-000000000003'"
assert_scalar '0|0|0|1' \
  "SELECT
     (SELECT count(*) FROM public.posts
       WHERE id = '20000000-0000-0000-0000-000000000003') || '|' ||
     (SELECT count(*) FROM public.comments
       WHERE id = '30000000-0000-0000-0000-000000000003') || '|' ||
     (SELECT count(*) FROM public.comment_likes
       WHERE comment_id = '30000000-0000-0000-0000-000000000003') || '|' ||
     (SELECT count(*) FROM public.comment_reaction_count_repair_queue
       WHERE comment_id = '30000000-0000-0000-0000-000000000003')"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'discarded_count'"

# queue_rebuild_on_replay: a drained queue is rebuilt from exact cache/source
# mismatches, while a second replay over canonical data does not refill it.
assert_scalar '0' \
  "SELECT count(*) FROM public.comment_reaction_count_repair_queue"
psql_cmd <<'SQL'
BEGIN;
SELECT pg_catalog.set_config(
  'app.comment_reaction_repair_path',
  'repair_comment_reaction_counts_atomic',
  true
);
UPDATE public.comments
SET like_count = 77
WHERE id = '30000000-0000-0000-0000-000000000001';
COMMIT;
SQL
psql_cmd -f "$MIGRATION"
assert_scalar '1' \
  "SELECT count(*) FROM public.comment_reaction_count_repair_queue
   WHERE comment_id = '30000000-0000-0000-0000-000000000001'"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"
assert_scalar '1|0|0' \
  "SELECT like_count || '|' || dislike_count || '|' ||
     (SELECT count(*) FROM public.comment_reaction_count_repair_queue)
   FROM public.comments
   WHERE id = '30000000-0000-0000-0000-000000000001'"
psql_cmd -f "$MIGRATION"
assert_scalar '0' \
  "SELECT count(*) FROM public.comment_reaction_count_repair_queue"

# unknown_acl_drift: replay removes table, column and function grants for an
# unlisted role, and recloses legacy arithmetic counter functions.
psql_cmd <<'SQL'
CREATE ROLE unknown_acl_drift NOLOGIN;
GRANT DELETE ON TABLE public.comment_reaction_count_repair_queue
  TO unknown_acl_drift;
GRANT SELECT (comment_id)
  ON TABLE public.comment_reaction_count_repair_queue
  TO unknown_acl_drift;
GRANT EXECUTE ON FUNCTION public.enqueue_comment_reaction_count_repair()
  TO unknown_acl_drift;
GRANT EXECUTE ON FUNCTION public.increment_comment_like_count(uuid)
  TO service_role;
SQL
psql_cmd -f "$MIGRATION"
assert_scalar 'false|false|false|false' \
  "SELECT
     pg_catalog.has_table_privilege(
       'unknown_acl_drift',
       'public.comment_reaction_count_repair_queue',
       'DELETE'
     ) || '|' ||
     pg_catalog.has_column_privilege(
       'unknown_acl_drift',
       'public.comment_reaction_count_repair_queue',
       'comment_id',
       'SELECT'
     ) || '|' ||
     pg_catalog.has_function_privilege(
       'unknown_acl_drift',
       'public.enqueue_comment_reaction_count_repair()',
       'EXECUTE'
     ) || '|' ||
     pg_catalog.has_function_privilege(
       'service_role',
       'public.increment_comment_like_count(uuid)',
       'EXECUTE'
     )"
assert_service '0' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"

# unknown_source_acl_drift: preserve table/column SELECT, while dynamically
# removing every other PG17 privilege (including MAINTAIN), PUBLIC grants, and
# a WITH GRANT OPTION downstream chain using CASCADE.
psql_cmd <<'SQL'
CREATE ROLE unknown_source_acl_drift NOLOGIN;
CREATE ROLE unknown_source_acl_downstream NOLOGIN;
GRANT USAGE ON SCHEMA public
  TO unknown_source_acl_drift, unknown_source_acl_downstream;
GRANT SELECT ON TABLE public.comment_likes
  TO unknown_source_acl_drift;
GRANT SELECT (reaction_type) ON TABLE public.comment_likes
  TO unknown_source_acl_downstream;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON TABLE public.comment_likes
  TO unknown_source_acl_drift WITH GRANT OPTION;
GRANT UPDATE (reaction_type), REFERENCES (reaction_type)
  ON TABLE public.comment_likes
  TO unknown_source_acl_drift WITH GRANT OPTION;
GRANT INSERT, TRUNCATE ON TABLE public.comment_likes TO PUBLIC;
GRANT UPDATE (reaction_type) ON TABLE public.comment_likes TO PUBLIC;
SET ROLE unknown_source_acl_drift;
GRANT UPDATE, DELETE ON TABLE public.comment_likes
  TO unknown_source_acl_downstream;
GRANT UPDATE (reaction_type) ON TABLE public.comment_likes
  TO unknown_source_acl_downstream;
RESET ROLE;
SQL
psql_cmd -f "$MIGRATION"
assert_scalar '0' \
  "SELECT count(*)
   FROM (
     SELECT acl_entry.grantee, acl_entry.privilege_type
     FROM pg_catalog.pg_class AS relation
     CROSS JOIN LATERAL pg_catalog.aclexplode(
       COALESCE(
         relation.relacl,
         pg_catalog.acldefault('r', relation.relowner)
       )
     ) AS acl_entry
     WHERE relation.oid = 'public.comment_likes'::pg_catalog.regclass
       AND acl_entry.grantee <> pg_catalog.to_regrole('postgres')
       AND acl_entry.privilege_type <> 'SELECT'
     UNION ALL
     SELECT acl_entry.grantee, acl_entry.privilege_type
     FROM pg_catalog.pg_attribute AS attribute
     CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
     WHERE attribute.attrelid = 'public.comment_likes'::pg_catalog.regclass
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND acl_entry.grantee <> pg_catalog.to_regrole('postgres')
       AND acl_entry.privilege_type <> 'SELECT'
   ) AS leaked_acl"
assert_scalar 'true|true|false|false|false|false|false|false' \
  "SELECT
     pg_catalog.has_table_privilege(
       'unknown_source_acl_drift', 'public.comment_likes', 'SELECT'
     ) || '|' ||
     pg_catalog.has_column_privilege(
       'unknown_source_acl_downstream',
       'public.comment_likes',
       'reaction_type',
       'SELECT'
     ) || '|' ||
     pg_catalog.has_table_privilege(
       'unknown_source_acl_drift', 'public.comment_likes', 'INSERT'
     ) || '|' ||
     pg_catalog.has_table_privilege(
       'unknown_source_acl_drift', 'public.comment_likes', 'TRUNCATE'
     ) || '|' ||
     pg_catalog.has_table_privilege(
       'unknown_source_acl_drift', 'public.comment_likes', 'MAINTAIN'
     ) || '|' ||
     pg_catalog.has_table_privilege(
       'unknown_source_acl_downstream', 'public.comment_likes', 'UPDATE'
     ) || '|' ||
     pg_catalog.has_column_privilege(
       'unknown_source_acl_downstream',
       'public.comment_likes',
       'reaction_type',
       'UPDATE'
     ) || '|' ||
     pg_catalog.has_column_privilege(
       'anon',
       'public.comment_likes',
       'reaction_type',
       'UPDATE'
     )"
assert_fails unknown_source_dml \
  "SET ROLE unknown_source_acl_drift;
   INSERT INTO public.comment_likes (comment_id, user_id, reaction_type)
   VALUES (
     '30000000-0000-0000-0000-000000000001',
     '10000000-0000-0000-0000-000000000002',
     'like'
   )"
assert_fails unknown_source_truncate \
  "SET ROLE unknown_source_acl_drift; TRUNCATE public.comment_likes"

# wrong_queue_index_drift: IF NOT EXISTS must not bless a same-name DESC index.
psql_cmd <<'SQL'
DROP INDEX public.idx_comment_reaction_count_repair_queue_oldest;
CREATE INDEX idx_comment_reaction_count_repair_queue_oldest
ON public.comment_reaction_count_repair_queue (
  next_attempt_at DESC,
  enqueued_at,
  comment_id
);
SQL
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/wrong_queue_index_drift.out" 2>&1; then
  echo 'wrong_queue_index_drift unexpectedly passed postflight' >&2
  exit 1
fi
if ! rg -q 'queue index drifted' "$TMP_ROOT/wrong_queue_index_drift.out"; then
  echo 'wrong_queue_index_drift failed for an unexpected reason' >&2
  cat "$TMP_ROOT/wrong_queue_index_drift.out" >&2
  exit 1
fi
psql_cmd -c \
  'DROP INDEX public.idx_comment_reaction_count_repair_queue_oldest'
psql_cmd -f "$MIGRATION"
assert_scalar '0' \
  "SELECT count(*) FROM public.comment_reaction_count_repair_queue"

# wrong_trigger_when_false / wrong_update_of_drift: trigger replay converges
# wrong UPDATE OF vectors and predicates before exact tgattr/tgqual attestation.
psql_cmd <<'SQL'
-- source_guard_when_false_missing_delete also replaces the sealed body and
-- removes DELETE from the trigger before replay restores both contracts.
CREATE OR REPLACE FUNCTION public.guard_canonical_comment_reaction_mutation()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
AS $drift$
BEGIN
  RETURN NEW;
END
$drift$;
DROP TRIGGER trg_comment_likes_00_guard_canonical_mutation
  ON public.comment_likes;
CREATE TRIGGER trg_comment_likes_00_guard_canonical_mutation
BEFORE INSERT OR UPDATE
ON public.comment_likes
FOR EACH ROW
WHEN (false)
EXECUTE FUNCTION public.guard_canonical_comment_reaction_mutation();

DROP TRIGGER trg_comment_likes_20_sync_counts ON public.comment_likes;
CREATE TRIGGER trg_comment_likes_20_sync_counts
AFTER INSERT OR DELETE OR UPDATE OF reaction_type
ON public.comment_likes
FOR EACH ROW
WHEN (false)
EXECUTE FUNCTION public.sync_comment_reaction_counts();

DROP TRIGGER trg_comment_likes_90_enqueue_count_repair ON public.comment_likes;
CREATE TRIGGER trg_comment_likes_90_enqueue_count_repair
AFTER INSERT OR DELETE OR UPDATE OF user_id
ON public.comment_likes
FOR EACH ROW
WHEN (false)
EXECUTE FUNCTION public.enqueue_comment_reaction_count_repair();

DROP TRIGGER trg_comments_04_contract_reaction_counts ON public.comments;
CREATE TRIGGER trg_comments_04_contract_reaction_counts
BEFORE INSERT OR UPDATE OF dislike_count
ON public.comments
FOR EACH ROW
WHEN (false)
EXECUTE FUNCTION public.guard_contract_comment_reaction_counts();
SQL
psql_cmd -f "$MIGRATION"
assert_scalar '31|0|true|0|0|true|true' \
  "SELECT trigger_row.tgtype || '|' ||
          pg_catalog.cardinality(trigger_row.tgattr::smallint[]) || '|' ||
          (trigger_row.tgqual IS NULL) || '|' || trigger_row.tgnargs || '|' ||
          pg_catalog.octet_length(trigger_row.tgargs) || '|' ||
          (NOT function_row.prosecdef) || '|' ||
          (pg_catalog.obj_description(function_row.oid, 'pg_proc') =
            'comment-reaction-count-repair:source-guard-v1:' ||
            pg_catalog.md5(function_row.prosrc))
   FROM pg_catalog.pg_trigger AS trigger_row
   JOIN pg_catalog.pg_proc AS function_row
     ON function_row.oid = trigger_row.tgfoid
   WHERE trigger_row.tgrelid = 'public.comment_likes'::pg_catalog.regclass
     AND trigger_row.tgname = 'trg_comment_likes_00_guard_canonical_mutation'"
assert_scalar '29|comment_id,user_id,reaction_type|true' \
  "SELECT trigger_row.tgtype || '|' ||
          (
            SELECT pg_catalog.string_agg(
              attribute.attname,
              ',' ORDER BY trigger_column.ordinality
            )
            FROM pg_catalog.unnest(trigger_row.tgattr::smallint[])
              WITH ORDINALITY AS trigger_column(attnum, ordinality)
            JOIN pg_catalog.pg_attribute AS attribute
              ON attribute.attrelid = trigger_row.tgrelid
             AND attribute.attnum = trigger_column.attnum
          ) || '|' || (trigger_row.tgqual IS NULL)
   FROM pg_catalog.pg_trigger AS trigger_row
   WHERE trigger_row.tgrelid = 'public.comment_likes'::pg_catalog.regclass
     AND trigger_row.tgname = 'trg_comment_likes_20_sync_counts'"
assert_scalar '29|comment_id,reaction_type|true' \
  "SELECT trigger_row.tgtype || '|' ||
          (
            SELECT pg_catalog.string_agg(
              attribute.attname,
              ',' ORDER BY trigger_column.ordinality
            )
            FROM pg_catalog.unnest(trigger_row.tgattr::smallint[])
              WITH ORDINALITY AS trigger_column(attnum, ordinality)
            JOIN pg_catalog.pg_attribute AS attribute
              ON attribute.attrelid = trigger_row.tgrelid
             AND attribute.attnum = trigger_column.attnum
          ) || '|' || (trigger_row.tgqual IS NULL)
   FROM pg_catalog.pg_trigger AS trigger_row
   WHERE trigger_row.tgrelid = 'public.comment_likes'::pg_catalog.regclass
     AND trigger_row.tgname = 'trg_comment_likes_90_enqueue_count_repair'"
assert_scalar '23|like_count,dislike_count|true' \
  "SELECT trigger_row.tgtype || '|' ||
          (
            SELECT pg_catalog.string_agg(
              attribute.attname,
              ',' ORDER BY trigger_column.ordinality
            )
            FROM pg_catalog.unnest(trigger_row.tgattr::smallint[])
              WITH ORDINALITY AS trigger_column(attnum, ordinality)
            JOIN pg_catalog.pg_attribute AS attribute
              ON attribute.attrelid = trigger_row.tgrelid
             AND attribute.attnum = trigger_column.attnum
          ) || '|' || (trigger_row.tgqual IS NULL)
   FROM pg_catalog.pg_trigger AS trigger_row
   WHERE trigger_row.tgrelid = 'public.comments'::pg_catalog.regclass
     AND trigger_row.tgname = 'trg_comments_04_contract_reaction_counts'"

# schema_drift_probe: a queue FK is forbidden even when NOT VALID. The failed
# replay rolls back cleanly; dropping the rogue edge restores replayability.
psql_cmd -c \
  "ALTER TABLE public.comment_reaction_count_repair_queue
   ADD CONSTRAINT schema_drift_probe
   FOREIGN KEY (comment_id) REFERENCES public.comments(id) NOT VALID"
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/schema_drift_probe.out" 2>&1; then
  echo 'schema_drift_probe unexpectedly accepted a queue FK' >&2
  exit 1
fi
if ! rg -q 'queue PK/FK/backoff drifted' "$TMP_ROOT/schema_drift_probe.out"; then
  echo 'schema_drift_probe failed for an unexpected reason' >&2
  cat "$TMP_ROOT/schema_drift_probe.out" >&2
  exit 1
fi
psql_cmd -c \
  "ALTER TABLE public.comment_reaction_count_repair_queue
   DROP CONSTRAINT schema_drift_probe"
psql_cmd -f "$MIGRATION"
assert_scalar '1|1' \
  "SELECT
     (SELECT count(*) FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'public.comment_likes'::pg_catalog.regclass
         AND tgname = 'trg_comment_likes_20_sync_counts'
         AND NOT tgisinternal) || '|' ||
     (SELECT count(*) FROM pg_catalog.pg_trigger
       WHERE tgrelid = 'public.comment_likes'::pg_catalog.regclass
         AND tgname = 'trg_comment_likes_90_enqueue_count_repair'
         AND NOT tgisinternal)"
assert_service '0' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"

# worker_shared_gate_blocks_replay: a worker transaction retains the shared
# migration gate after its RPC. Replay fails fast, then succeeds on retry.
psql_cmd >"$TMP_ROOT/worker-shared-gate.out" 2>&1 <<'SQL' &
SET application_name = 'worker_shared_gate_blocks_replay';
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
BEGIN;
SELECT public.repair_comment_reaction_counts_atomic(1);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
worker_shared_gate_pid=$!
wait_for_activity \
  "application_name = 'worker_shared_gate_blocks_replay' AND state = 'active' AND query LIKE '%pg_sleep%'" \
  1 \
  worker_shared_gate_blocks_replay
assert_scalar '1' \
  "SELECT count(*)
   FROM pg_catalog.pg_locks AS held_lock
   JOIN pg_catalog.pg_stat_activity AS activity
     ON activity.pid = held_lock.pid
   WHERE activity.application_name = 'worker_shared_gate_blocks_replay'
     AND held_lock.locktype = 'advisory'
     AND held_lock.mode = 'ShareLock'
     AND held_lock.granted"
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/replay-vs-shared-worker.out" 2>&1; then
  echo 'worker_shared_gate_blocks_replay unexpectedly allowed replay' >&2
  exit 1
fi
if ! rg -q 'comment reaction count repair migration lock is busy' \
  "$TMP_ROOT/replay-vs-shared-worker.out"; then
  echo 'worker_shared_gate_blocks_replay failed for an unexpected reason' >&2
  cat "$TMP_ROOT/replay-vs-shared-worker.out" >&2
  exit 1
fi
wait_for_activity \
  "application_name = 'worker_shared_gate_blocks_replay' AND state = 'active'" \
  1 \
  worker_shared_gate_survived_replay
wait "$worker_shared_gate_pid"
psql_cmd -f "$MIGRATION"

# exclusive_migration_gate_rejects_prelocked_worker: even a transaction that
# entered with a parent row lock gets 55P03 immediately and releases that row;
# it can retry after the exclusive migration gate leaves.
psql_cmd >"$TMP_ROOT/exclusive-migration-gate.out" 2>&1 <<'SQL' &
SET application_name = 'exclusive_migration_gate_rejects_prelocked_worker';
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.comment-reaction-count-repair:migration',
    0
  )
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
exclusive_gate_pid=$!
wait_for_activity \
  "application_name = 'exclusive_migration_gate_rejects_prelocked_worker' AND state = 'active' AND query LIKE '%pg_sleep%'" \
  1 \
  exclusive_migration_gate_rejects_prelocked_worker
assert_fails prelocked_worker_gate_busy \
  "BEGIN;
   SET LOCAL request.jwt.claim.role = 'service_role';
   SELECT id FROM public.comments
   WHERE id = '30000000-0000-0000-0000-000000000001'
   FOR UPDATE;
   SELECT public.repair_comment_reaction_counts_atomic(1)"
if ! rg -q 'comment reaction repair migration gate is busy' \
  "$TMP_ROOT/prelocked_worker_gate_busy.out"; then
  echo 'prelocked worker failed for an unexpected reason' >&2
  cat "$TMP_ROOT/prelocked_worker_gate_busy.out" >&2
  exit 1
fi
assert_scalar '30000000-0000-0000-0000-000000000001' \
  "SELECT id FROM public.comments
   WHERE id = '30000000-0000-0000-0000-000000000001'
   FOR UPDATE NOWAIT"
wait_for_activity \
  "application_name = 'exclusive_migration_gate_rejects_prelocked_worker' AND state = 'active'" \
  1 \
  exclusive_gate_survived_prelocked_worker
wait "$exclusive_gate_pid"
assert_service 'processed' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'status'"

# live_toggle_vs_auth_delete: auth KEY SHARE is acquired before block/post/
# comment/source. Account deletion waits, then cascades without a deadlock.
psql_cmd <<'SQL'
INSERT INTO auth.users (id) VALUES
  ('10000000-0000-0000-0000-000000000004');
INSERT INTO public.posts (id) VALUES
  ('20000000-0000-0000-0000-000000000004');
INSERT INTO public.comments (id, post_id) VALUES (
  '30000000-0000-0000-0000-000000000004',
  '20000000-0000-0000-0000-000000000004'
);
SQL
psql_cmd >"$TMP_ROOT/live-toggle.out" 2>&1 <<'SQL' &
SET application_name = 'live_toggle_vs_auth_delete';
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
BEGIN;
SELECT public.toggle_comment_reaction(
  '20000000-0000-0000-0000-000000000004',
  '30000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000004',
  'like'
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
live_toggle_pid=$!
wait_for_activity \
  "application_name = 'live_toggle_vs_auth_delete' AND state = 'active' AND query LIKE '%pg_sleep%'" \
  1 \
  live_toggle_vs_auth_delete
psql_cmd >"$TMP_ROOT/live-auth-delete.out" 2>&1 <<'SQL' &
SET application_name = 'auth_delete_after_live_toggle';
DELETE FROM auth.users
WHERE id = '10000000-0000-0000-0000-000000000004';
SQL
live_auth_delete_pid=$!
wait_for_activity \
  "application_name = 'auth_delete_after_live_toggle' AND wait_event_type = 'Lock'" \
  1 \
  live_toggle_vs_auth_delete_lock
wait "$live_toggle_pid"
wait "$live_auth_delete_pid"
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

# worker_vs_comment_delete: the worker skips a locked comment, touches only Q
# for bounded backoff, and discards the stale identity after delete commits.
psql_cmd <<'SQL'
INSERT INTO public.posts (id) VALUES
  ('20000000-0000-0000-0000-000000000005');
INSERT INTO public.comments (id, post_id) VALUES (
  '30000000-0000-0000-0000-000000000005',
  '20000000-0000-0000-0000-000000000005'
);
SQL
assert_service '1' \
  "SELECT public.toggle_comment_reaction(
    '20000000-0000-0000-0000-000000000005',
    '30000000-0000-0000-0000-000000000005',
    '10000000-0000-0000-0000-000000000001',
    'like'
  )->>'like_count'"
psql_cmd >"$TMP_ROOT/comment-delete.out" 2>&1 <<'SQL' &
SET application_name = 'worker_vs_comment_delete';
BEGIN;
DELETE FROM public.comments
WHERE id = '30000000-0000-0000-0000-000000000005';
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
comment_delete_pid=$!
wait_for_activity \
  "application_name = 'worker_vs_comment_delete' AND state = 'active' AND query LIKE '%pg_sleep%'" \
  1 \
  worker_vs_comment_delete
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'contended_count'"
wait "$comment_delete_pid"
psql_cmd -c \
  "UPDATE public.comment_reaction_count_repair_queue
   SET next_attempt_at = pg_catalog.statement_timestamp() - interval '1 second'
   WHERE comment_id = '30000000-0000-0000-0000-000000000005'"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'discarded_count'"

# worker_vs_post_delete: a locked post is skipped before comment/Q ownership.
psql_cmd <<'SQL'
INSERT INTO public.posts (id) VALUES
  ('20000000-0000-0000-0000-000000000006');
INSERT INTO public.comments (id, post_id) VALUES (
  '30000000-0000-0000-0000-000000000006',
  '20000000-0000-0000-0000-000000000006'
);
SQL
assert_service '1' \
  "SELECT public.toggle_comment_reaction(
    '20000000-0000-0000-0000-000000000006',
    '30000000-0000-0000-0000-000000000006',
    '10000000-0000-0000-0000-000000000001',
    'dislike'
  )->>'dislike_count'"
psql_cmd >"$TMP_ROOT/post-delete.out" 2>&1 <<'SQL' &
SET application_name = 'worker_vs_post_delete';
BEGIN;
DELETE FROM public.posts
WHERE id = '20000000-0000-0000-0000-000000000006';
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
post_delete_pid=$!
wait_for_activity \
  "application_name = 'worker_vs_post_delete' AND state = 'active' AND query LIKE '%pg_sleep%'" \
  1 \
  worker_vs_post_delete
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'contended_count'"
wait "$post_delete_pid"
psql_cmd -c \
  "UPDATE public.comment_reaction_count_repair_queue
   SET next_attempt_at = pg_catalog.statement_timestamp() - interval '1 second'
   WHERE comment_id = '30000000-0000-0000-0000-000000000006'"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'discarded_count'"

# worker_vs_auth_delete / repair_worker_gate: worker owns post -> comment -> Q,
# then account cascade waits only on Q and recreates the obligation on commit.
psql_cmd <<'SQL'
INSERT INTO auth.users (id) VALUES
  ('10000000-0000-0000-0000-000000000007');
INSERT INTO public.posts (id) VALUES
  ('20000000-0000-0000-0000-000000000007');
INSERT INTO public.comments (id, post_id) VALUES (
  '30000000-0000-0000-0000-000000000007',
  '20000000-0000-0000-0000-000000000007'
);
SQL
assert_service '1' \
  "SELECT public.toggle_comment_reaction(
    '20000000-0000-0000-0000-000000000007',
    '30000000-0000-0000-0000-000000000007',
    '10000000-0000-0000-0000-000000000007',
    'like'
  )->>'like_count'"
psql_cmd >"$TMP_ROOT/repair-worker-gate.out" 2>&1 <<'SQL' &
SET application_name = 'repair_worker_gate_worker_vs_auth_delete';
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
BEGIN;
SELECT public.repair_comment_reaction_counts_atomic(1);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
repair_worker_pid=$!
wait_for_activity \
  "application_name = 'repair_worker_gate_worker_vs_auth_delete' AND state = 'active' AND query LIKE '%pg_sleep%'" \
  1 \
  repair_worker_gate
psql_cmd >"$TMP_ROOT/worker-auth-delete.out" 2>&1 <<'SQL' &
SET application_name = 'worker_vs_auth_delete';
DELETE FROM auth.users
WHERE id = '10000000-0000-0000-0000-000000000007';
SQL
worker_auth_delete_pid=$!
wait_for_activity \
  "application_name = 'worker_vs_auth_delete' AND wait_event_type = 'Lock'" \
  1 \
  worker_vs_auth_delete
wait "$repair_worker_pid"
wait "$worker_auth_delete_pid"
assert_scalar '0|1|0|1' \
  "SELECT
     (SELECT count(*) FROM public.comment_likes
       WHERE comment_id = '30000000-0000-0000-0000-000000000007') || '|' ||
     (SELECT like_count FROM public.comments
       WHERE id = '30000000-0000-0000-0000-000000000007') || '|' ||
     (SELECT dislike_count FROM public.comments
       WHERE id = '30000000-0000-0000-0000-000000000007') || '|' ||
     (SELECT count(*) FROM public.comment_reaction_count_repair_queue
       WHERE comment_id = '30000000-0000-0000-0000-000000000007')"
assert_service '1' \
  "SELECT public.repair_comment_reaction_counts_atomic(1)->>'repaired_count'"
assert_scalar '0|0|0' \
  "SELECT like_count || '|' || dislike_count || '|' ||
     (SELECT count(*) FROM public.comment_reaction_count_repair_queue
       WHERE comment_id = comments.id)
   FROM public.comments
   WHERE id = '30000000-0000-0000-0000-000000000007'"

echo 'durable comment reaction count repair PG17 proof passed'
