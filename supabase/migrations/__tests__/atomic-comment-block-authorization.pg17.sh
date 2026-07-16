#!/usr/bin/env bash

# PostgreSQL 17 proof for the advisory-first comment authorization boundary.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716114500_atomic_comment_block_authorization.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-comment-block-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55492
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
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

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE drifted_comment_writer NOLOGIN;

CREATE TYPE public.post_status AS ENUM ('active', 'locked', 'deleted');

CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL,
  blocked_id uuid NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL,
  original_post_id uuid REFERENCES public.posts(id),
  group_id uuid,
  visibility text NOT NULL DEFAULT 'public',
  status public.post_status NOT NULL DEFAULT 'active',
  deleted_at timestamptz
);
CREATE TABLE public.comments (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id),
  user_id uuid NOT NULL,
  parent_id uuid REFERENCES public.comments(id),
  content text NOT NULL,
  deleted_at timestamptz
);
CREATE TABLE public.comment_likes (
  comment_id uuid NOT NULL REFERENCES public.comments(id),
  user_id uuid NOT NULL,
  reaction_type text NOT NULL,
  PRIMARY KEY (comment_id, user_id)
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  banned_at timestamptz,
  deleted_at timestamptz
);
CREATE TABLE public.groups (id uuid PRIMARY KEY);
CREATE TABLE public.group_members (group_id uuid, user_id uuid);
CREATE TABLE public.group_bans (group_id uuid, user_id uuid);
CREATE TABLE public.user_follows (follower_id uuid, following_id uuid);

CREATE OR REPLACE FUNCTION public.validate_comment_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_post_author_id uuid;
  v_parent_author_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.post_id IS DISTINCT FROM OLD.post_id
    OR NEW.parent_id IS DISTINCT FROM OLD.parent_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
  ) THEN
    RAISE EXCEPTION 'comment post_id, parent_id, and user_id are immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT post_row.author_id
  INTO v_post_author_id
  FROM public.posts AS post_row
  WHERE post_row.id = NEW.post_id
    AND post_row.deleted_at IS NULL
    AND post_row.status = 'active'
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active post required' USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' AND EXISTS (
    SELECT 1 FROM public.blocked_users AS block_edge
    WHERE (block_edge.blocker_id = NEW.user_id
           AND block_edge.blocked_id = v_post_author_id)
       OR (block_edge.blocker_id = v_post_author_id
           AND block_edge.blocked_id = NEW.user_id)
  ) THEN
    RAISE EXCEPTION 'post author blocked' USING ERRCODE = '42501';
  END IF;

  IF NEW.parent_id IS NOT NULL THEN
    SELECT parent_row.user_id
    INTO v_parent_author_id
    FROM public.comments AS parent_row
    WHERE parent_row.id = NEW.parent_id
      AND parent_row.post_id = NEW.post_id
      AND parent_row.parent_id IS NULL
      AND parent_row.deleted_at IS NULL
    FOR NO KEY UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'active top-level parent required' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'INSERT' AND EXISTS (
      SELECT 1 FROM public.blocked_users AS block_edge
      WHERE (block_edge.blocker_id = NEW.user_id
             AND block_edge.blocked_id = v_parent_author_id)
         OR (block_edge.blocker_id = v_parent_author_id
             AND block_edge.blocked_id = NEW.user_id)
    ) THEN
      RAISE EXCEPTION 'parent author blocked' USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.validate_comment_integrity() OWNER TO postgres;

CREATE TRIGGER trg_comments_10_validate_integrity
BEFORE INSERT OR UPDATE OF parent_id, post_id, user_id, content, deleted_at
ON public.comments
FOR EACH ROW
EXECUTE FUNCTION public.validate_comment_integrity();

CREATE OR REPLACE FUNCTION public.validate_comment_reaction_integrity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_post_id uuid;
  v_post_author_id uuid;
  v_comment_author_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.comment_id IS DISTINCT FROM OLD.comment_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
  ) THEN
    RAISE EXCEPTION 'comment reaction identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  SELECT comment_row.post_id, comment_row.user_id
  INTO v_post_id, v_comment_author_id
  FROM public.comments AS comment_row
  WHERE comment_row.id = NEW.comment_id
    AND comment_row.deleted_at IS NULL
  FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'active comment required' USING ERRCODE = '23514';
  END IF;

  SELECT post_row.author_id
  INTO v_post_author_id
  FROM public.posts AS post_row
  WHERE post_row.id = v_post_id
  FOR SHARE;

  IF EXISTS (
    SELECT 1 FROM public.blocked_users AS block_edge
    WHERE block_edge.blocker_id IN (NEW.user_id, v_post_author_id, v_comment_author_id)
      AND block_edge.blocked_id IN (NEW.user_id, v_post_author_id, v_comment_author_id)
      AND block_edge.blocker_id <> block_edge.blocked_id
  ) THEN
    RAISE EXCEPTION 'reaction blocked' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;
ALTER FUNCTION public.validate_comment_reaction_integrity() OWNER TO postgres;

CREATE TRIGGER trg_comment_likes_10_validate_integrity
BEFORE INSERT OR UPDATE OF comment_id, user_id, reaction_type
ON public.comment_likes
FOR EACH ROW
EXECUTE FUNCTION public.validate_comment_reaction_integrity();

-- These simplified mature implementations deliberately preserve the old
-- row-before-advisory order. The migration must make their public wrappers
-- acquire every advisory edge before entering them.
CREATE FUNCTION public.lock_actor_can_interact_with_post(
  p_post_id uuid,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_author_id uuid;
BEGIN
  SELECT post_row.author_id
  INTO v_author_id
  FROM public.posts AS post_row
  WHERE post_row.id = p_post_id
    AND post_row.deleted_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF v_author_id <> p_actor_id THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'post-audience:block:' || LEAST(p_actor_id::text, v_author_id::text)
          || ':' || GREATEST(p_actor_id::text, v_author_id::text),
        0
      )
    );
  END IF;
  RETURN NOT EXISTS (
    SELECT 1 FROM public.blocked_users AS block_edge
    WHERE (block_edge.blocker_id = p_actor_id AND block_edge.blocked_id = v_author_id)
       OR (block_edge.blocker_id = v_author_id AND block_edge.blocked_id = p_actor_id)
  );
END
$function$;
ALTER FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.toggle_comment_reaction(
  p_post_id uuid,
  p_comment_id uuid,
  p_user_id uuid,
  p_reaction_type text DEFAULT 'like'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_existing_type text;
BEGIN
  IF p_post_id IS NULL OR p_comment_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'ids required' USING ERRCODE = '22023';
  END IF;
  IF p_reaction_type NOT IN ('like', 'dislike') THEN
    RAISE EXCEPTION 'invalid reaction' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.posts WHERE id = p_post_id FOR SHARE;
  PERFORM 1 FROM public.comments
  WHERE id = p_comment_id AND post_id = p_post_id FOR UPDATE;
  SELECT reaction_type INTO v_existing_type
  FROM public.comment_likes
  WHERE comment_id = p_comment_id AND user_id = p_user_id
  FOR UPDATE;
  PERFORM pg_catalog.set_config('app.comment_reaction_path', 'toggle_comment_reaction', true);
  IF FOUND AND v_existing_type = p_reaction_type THEN
    DELETE FROM public.comment_likes
    WHERE comment_id = p_comment_id AND user_id = p_user_id;
    RETURN pg_catalog.jsonb_build_object('action', 'removed');
  ELSIF v_existing_type IS NOT NULL THEN
    UPDATE public.comment_likes SET reaction_type = p_reaction_type
    WHERE comment_id = p_comment_id AND user_id = p_user_id;
    RETURN pg_catalog.jsonb_build_object('action', 'changed');
  ELSE
    INSERT INTO public.comment_likes(comment_id, user_id, reaction_type)
    VALUES (p_comment_id, p_user_id, p_reaction_type);
    RETURN pg_catalog.jsonb_build_object('action', 'added');
  END IF;
END
$function$;
ALTER FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text)
  TO service_role;

CREATE FUNCTION public.update_own_comment(
  p_comment_id uuid,
  p_post_id uuid,
  p_user_id uuid,
  p_content text
)
RETURNS SETOF public.comments
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_comment_id IS NULL OR p_post_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'ids required' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.posts WHERE id = p_post_id FOR NO KEY UPDATE;
  PERFORM 1 FROM public.comments
  WHERE id = p_comment_id AND user_id = p_user_id FOR UPDATE;
  RETURN QUERY
  UPDATE public.comments AS comment_row
  SET content = p_content
  WHERE comment_row.id = p_comment_id
    AND comment_row.post_id = p_post_id
    AND comment_row.user_id = p_user_id
  RETURNING comment_row.*;
END
$function$;
ALTER FUNCTION public.update_own_comment(uuid, uuid, uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_own_comment(uuid, uuid, uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_own_comment(uuid, uuid, uuid, text)
  TO service_role;

CREATE FUNCTION public.submit_content_report(
  p_reporter_id uuid,
  p_content_type text,
  p_content_id uuid,
  p_reason text,
  p_description text DEFAULT NULL,
  p_images text[] DEFAULT ARRAY[]::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_candidate_post_id uuid;
BEGIN
  CASE p_content_type
    WHEN 'post' THEN
      IF NOT public.lock_actor_can_interact_with_post(
        p_content_id,
        p_reporter_id
      ) THEN
        RAISE EXCEPTION 'unavailable';
      END IF;
      PERFORM 1 FROM public.posts WHERE id = p_content_id FOR SHARE;
    WHEN 'comment' THEN
      SELECT post_id INTO v_candidate_post_id
      FROM public.comments WHERE id = p_content_id;
      IF NOT public.lock_actor_can_interact_with_post(
        v_candidate_post_id,
        p_reporter_id
      ) THEN
        RAISE EXCEPTION 'unavailable';
      END IF;
      PERFORM 1 FROM public.comments WHERE id = p_content_id FOR SHARE;
    WHEN 'user' THEN
      NULL;
    WHEN 'message' THEN
      NULL;
  END CASE;
  RETURN pg_catalog.jsonb_build_object('ok', true);
END
$function$;
ALTER FUNCTION public.submit_content_report(uuid, text, uuid, text, text, text[])
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.submit_content_report(uuid, text, uuid, text, text, text[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_content_report(uuid, text, uuid, text, text, text[])
  TO service_role;

INSERT INTO public.user_profiles(id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333'),
  ('44444444-4444-4444-8444-444444444444');
INSERT INTO public.posts(id, author_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '22222222-2222-4222-8222-222222222222');
INSERT INTO public.posts(id, author_id) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '44444444-4444-4444-8444-444444444444');
INSERT INTO public.posts(id, author_id, original_post_id) VALUES
  (
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3',
    '22222222-2222-4222-8222-222222222222',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
  );
INSERT INTO public.comments(id, post_id, user_id, content) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '33333333-3333-4333-8333-333333333333', 'parent');
INSERT INTO public.comments(id, post_id, user_id, content) VALUES
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3', '11111111-1111-4111-8111-111111111111', 'actor repost comment');
SQL

# A missing OLD+NEW block serializer must fail before any helper/trigger rename.
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/missing-dependency.log" 2>&1; then
  echo "Migration unexpectedly accepted a missing block serializer" >&2
  exit 1
fi
if ! grep -Fq 'comment authorization requires 20260715091500' \
  "$TMP_ROOT/missing-dependency.log"; then
  cat "$TMP_ROOT/missing-dependency.log" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname='lock_post_interaction_block_edges'")" != "0" ]]; then
  echo "Failed preflight left comment authorization helpers behind" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname='toggle_comment_reaction_locked_impl'")" != "0" ]]; then
  echo "Failed preflight renamed a canonical implementation" >&2
  exit 1
fi

psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.serialize_post_audience_block_edge()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_pairs text[] := ARRAY[]::text[];
  v_pair text;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_pairs := pg_catalog.array_append(
      v_pairs,
      LEAST(OLD.blocker_id::text, OLD.blocked_id::text)
        || ':' || GREATEST(OLD.blocker_id::text, OLD.blocked_id::text)
    );
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_pairs := pg_catalog.array_append(
      v_pairs,
      LEAST(NEW.blocker_id::text, NEW.blocked_id::text)
        || ':' || GREATEST(NEW.blocker_id::text, NEW.blocked_id::text)
    );
  END IF;
  FOR v_pair IN
    SELECT DISTINCT affected_pair
    FROM pg_catalog.unnest(v_pairs) AS affected(affected_pair)
    ORDER BY affected_pair
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('post-audience:block:' || v_pair, 0)
    );
  END LOOP;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;
ALTER FUNCTION public.serialize_post_audience_block_edge() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.serialize_post_audience_block_edge()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER trg_serialize_post_audience_block_edge
BEFORE INSERT OR DELETE OR UPDATE OF blocker_id, blocked_id
ON public.blocked_users
FOR EACH ROW
EXECUTE FUNCTION public.serialize_post_audience_block_edge();
SQL

# A canonical-looking serializer with WHEN(false) does not serialize anything.
# The migration keeps this dependency, so it must reject conditional drift
# before renaming or creating any comment authority.
psql_cmd <<'SQL'
DROP TRIGGER trg_serialize_post_audience_block_edge ON public.blocked_users;
CREATE TRIGGER trg_serialize_post_audience_block_edge
BEFORE INSERT OR DELETE OR UPDATE OF blocker_id, blocked_id
ON public.blocked_users
FOR EACH ROW
WHEN (false)
EXECUTE FUNCTION public.serialize_post_audience_block_edge();
SQL
if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/conditional-block-serializer.log" 2>&1; then
  echo "Migration unexpectedly accepted a conditional block serializer" >&2
  exit 1
fi
grep -Fq 'block-edge serialization contract has drifted' \
  "$TMP_ROOT/conditional-block-serializer.log"
if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_proc WHERE pronamespace='public'::regnamespace AND proname='lock_post_interaction_block_edges'")" != "0" ]]; then
  echo "Conditional dependency failure left comment helpers behind" >&2
  exit 1
fi
psql_cmd <<'SQL'
DROP TRIGGER trg_serialize_post_audience_block_edge ON public.blocked_users;
CREATE TRIGGER trg_serialize_post_audience_block_edge
BEFORE INSERT OR DELETE OR UPDATE OF blocker_id, blocked_id
ON public.blocked_users
FOR EACH ROW
EXECUTE FUNCTION public.serialize_post_audience_block_edge();
SQL

# A report caller that holds target rows before entering the shared helper is a
# hard deployment dependency failure: changing the helper under that caller
# would create a row/advisory lock inversion.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.submit_content_report(
  p_reporter_id uuid,
  p_content_type text,
  p_content_id uuid,
  p_reason text,
  p_description text DEFAULT NULL,
  p_images text[] DEFAULT ARRAY[]::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_candidate_post_id uuid;
BEGIN
  CASE p_content_type
    WHEN 'post' THEN
      PERFORM 1 FROM public.posts WHERE id = p_content_id FOR SHARE;
      PERFORM public.lock_actor_can_interact_with_post(p_content_id, p_reporter_id);
    WHEN 'comment' THEN
      SELECT post_id INTO v_candidate_post_id
      FROM public.comments WHERE id = p_content_id;
      PERFORM 1 FROM public.comments WHERE id = p_content_id FOR SHARE;
      PERFORM public.lock_actor_can_interact_with_post(v_candidate_post_id, p_reporter_id);
    WHEN 'user' THEN NULL;
    WHEN 'message' THEN NULL;
  END CASE;
  RETURN pg_catalog.jsonb_build_object('ok', true);
END
$function$;
ALTER FUNCTION public.submit_content_report(uuid, text, uuid, text, text, text[])
  OWNER TO postgres;
SQL

if psql_cmd -f "$MIGRATION" >"$TMP_ROOT/row-first-report.log" 2>&1; then
  echo "Migration unexpectedly accepted a row-first report caller" >&2
  exit 1
fi
grep -Fq 'report target authorization must call the post helper before target row locks' \
  "$TMP_ROOT/row-first-report.log"

psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.submit_content_report(
  p_reporter_id uuid,
  p_content_type text,
  p_content_id uuid,
  p_reason text,
  p_description text DEFAULT NULL,
  p_images text[] DEFAULT ARRAY[]::text[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_candidate_post_id uuid;
BEGIN
  CASE p_content_type
    WHEN 'post' THEN
      IF NOT public.lock_actor_can_interact_with_post(p_content_id, p_reporter_id) THEN
        RAISE EXCEPTION 'unavailable';
      END IF;
      PERFORM 1 FROM public.posts WHERE id = p_content_id FOR SHARE;
    WHEN 'comment' THEN
      SELECT post_id INTO v_candidate_post_id
      FROM public.comments WHERE id = p_content_id;
      IF NOT public.lock_actor_can_interact_with_post(v_candidate_post_id, p_reporter_id) THEN
        RAISE EXCEPTION 'unavailable';
      END IF;
      PERFORM 1 FROM public.comments WHERE id = p_content_id FOR SHARE;
    WHEN 'user' THEN NULL;
    WHEN 'message' THEN NULL;
  END CASE;
  RETURN pg_catalog.jsonb_build_object('ok', true);
END
$function$;
ALTER FUNCTION public.submit_content_report(uuid, text, uuid, text, text, text[])
  OWNER TO postgres;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $catalog_proof$
BEGIN
  IF pg_catalog.has_function_privilege(
       'service_role',
       'public.lock_post_interaction_block_edges(uuid,uuid,uuid)',
       'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'service_role',
       'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)',
       'EXECUTE'
     ) OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.toggle_comment_reaction(uuid,uuid,uuid,text)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'comment authorization ACL convergence failed';
  END IF;
END
$catalog_proof$;
SQL

ACTOR='11111111-1111-4111-8111-111111111111'
POST_AUTHOR='22222222-2222-4222-8222-222222222222'
TARGET_AUTHOR='33333333-3333-4333-8333-333333333333'
OTHER='44444444-4444-4444-8444-444444444444'
POST_ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
PARENT_ID='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
REPOST_ID='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
REPOST_COMMENT_ID='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb6'

wait_for_sleeping_app() {
  local app_name=$1
  for _ in $(seq 1 100); do
    if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name='$app_name' AND state='active' AND query LIKE '%pg_sleep%'")" == "1" ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "Transaction gate did not become ready: $app_name" >&2
  return 1
}

wait_for_advisory_wait() {
  local app_name=$1
  for _ in $(seq 1 100); do
    if [[ "$(psql_cmd -Atqc "SELECT count(*) FROM pg_catalog.pg_stat_activity WHERE application_name='$app_name' AND wait_event='advisory'")" == "1" ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "Expected advisory wait was not observed: $app_name" >&2
  return 1
}

# The wrapper post author is an authorization edge even for a top-level
# comment. Prove both transaction orders before exercising the extra reply
# target edge.
PGAPPNAME=post_author_block_first psql_cmd >"$TMP_ROOT/post-author-block-first.out" 2>&1 <<SQL &
BEGIN;
INSERT INTO public.blocked_users(blocker_id, blocked_id)
VALUES ('$POST_AUTHOR', '$ACTOR');
SELECT pg_catalog.pg_sleep(1.2);
COMMIT;
SQL
block_pid=$!
wait_for_sleeping_app post_author_block_first
if psql_cmd -c "INSERT INTO public.comments(id,post_id,user_id,content) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbba1','$POST_ID','$ACTOR','blocked top level')" >"$TMP_ROOT/blocked-top-level.out" 2>&1; then
  echo "Top-level comment unexpectedly crossed a post-author block" >&2
  exit 1
fi
wait "$block_pid"
grep -Fq 'post author blocked' "$TMP_ROOT/blocked-top-level.out"

psql_cmd -c "DELETE FROM public.blocked_users WHERE blocker_id='$POST_AUTHOR' AND blocked_id='$ACTOR'" >/dev/null
PGAPPNAME=top_level_first psql_cmd >"$TMP_ROOT/top-level-first.out" 2>&1 <<SQL &
BEGIN;
INSERT INTO public.comments(id,post_id,user_id,content)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbba2','$POST_ID','$ACTOR','allowed top level');
SELECT pg_catalog.pg_sleep(1.2);
COMMIT;
SQL
top_level_pid=$!
wait_for_sleeping_app top_level_first
PGAPPNAME=top_level_waiting_block psql_cmd >"$TMP_ROOT/top-level-waiting-block.out" 2>&1 <<SQL &
INSERT INTO public.blocked_users(blocker_id, blocked_id)
VALUES ('$POST_AUTHOR', '$ACTOR');
SQL
waiting_block_pid=$!
wait_for_advisory_wait top_level_waiting_block
wait "$top_level_pid"
wait "$waiting_block_pid"
psql_cmd -c "DELETE FROM public.blocked_users WHERE blocker_id='$POST_AUTHOR' AND blocked_id='$ACTOR'" >/dev/null

# Block-first reply: direct service INSERT waits, then the validator observes
# the committed target-author block and rejects.
PGAPPNAME=comment_block_first psql_cmd >"$TMP_ROOT/comment-block-first.out" 2>&1 <<SQL &
BEGIN;
INSERT INTO public.blocked_users(blocker_id, blocked_id)
VALUES ('$TARGET_AUTHOR', '$ACTOR');
SELECT pg_catalog.pg_sleep(1.2);
COMMIT;
SQL
block_pid=$!
wait_for_sleeping_app comment_block_first
if psql_cmd -c "INSERT INTO public.comments(id,post_id,user_id,parent_id,content) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2','$POST_ID','$ACTOR','$PARENT_ID','blocked reply')" >"$TMP_ROOT/blocked-reply.out" 2>&1; then
  echo "Reply unexpectedly crossed a committed target block" >&2
  exit 1
fi
wait "$block_pid"
grep -Fq 'parent author blocked' "$TMP_ROOT/blocked-reply.out"

# Interaction-first reply: block waits on the exact target edge and commits
# only after the reply transaction has committed.
psql_cmd -c "DELETE FROM public.blocked_users WHERE blocker_id='$TARGET_AUTHOR' AND blocked_id='$ACTOR'" >/dev/null
PGAPPNAME=comment_reply_first psql_cmd >"$TMP_ROOT/comment-reply-first.out" 2>&1 <<SQL &
BEGIN;
INSERT INTO public.comments(id,post_id,user_id,parent_id,content)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3','$POST_ID','$ACTOR','$PARENT_ID','allowed reply');
SELECT pg_catalog.pg_sleep(1.2);
COMMIT;
SQL
reply_pid=$!
wait_for_sleeping_app comment_reply_first
PGAPPNAME=comment_waiting_block psql_cmd >"$TMP_ROOT/comment-waiting-block.out" 2>&1 <<SQL &
INSERT INTO public.blocked_users(blocker_id, blocked_id)
VALUES ('$TARGET_AUTHOR', '$ACTOR');
SQL
waiting_block_pid=$!
wait_for_advisory_wait comment_waiting_block
wait "$reply_pid"
wait "$waiting_block_pid"

# Seed a reaction without a block, then prove a reaction_type UPDATE through
# the canonical RPC is block-serialized as well.
psql_cmd -c "DELETE FROM public.blocked_users WHERE blocker_id='$TARGET_AUTHOR' AND blocked_id='$ACTOR'" >/dev/null
psql_cmd -c "SELECT public.toggle_comment_reaction('$POST_ID','$PARENT_ID','$ACTOR','like')" >/dev/null
PGAPPNAME=reaction_block_first psql_cmd >"$TMP_ROOT/reaction-block-first.out" 2>&1 <<SQL &
BEGIN;
INSERT INTO public.blocked_users(blocker_id, blocked_id)
VALUES ('$TARGET_AUTHOR', '$ACTOR');
SELECT pg_catalog.pg_sleep(1.2);
COMMIT;
SQL
block_pid=$!
wait_for_sleeping_app reaction_block_first
if psql_cmd -c "SELECT public.toggle_comment_reaction('$POST_ID','$PARENT_ID','$ACTOR','dislike')" >"$TMP_ROOT/blocked-change.out" 2>&1; then
  echo "Reaction change unexpectedly crossed a committed target block" >&2
  exit 1
fi
wait "$block_pid"
grep -Fq 'reaction blocked' "$TMP_ROOT/blocked-change.out"

# Deadlock regression: the reaction wrapper owns all advisory edges before its
# old row-locking implementation. A concurrent reply waits on advisory, never
# while holding a row needed by the reaction.
psql_cmd -c "DELETE FROM public.blocked_users WHERE blocker_id='$TARGET_AUTHOR' AND blocked_id='$ACTOR'" >/dev/null
PGAPPNAME=reaction_holds_rows psql_cmd >"$TMP_ROOT/reaction-holds-rows.out" 2>&1 <<SQL &
BEGIN;
SELECT public.toggle_comment_reaction('$POST_ID','$PARENT_ID','$ACTOR','dislike');
SELECT pg_catalog.pg_sleep(1.2);
COMMIT;
SQL
reaction_pid=$!
wait_for_sleeping_app reaction_holds_rows
PGAPPNAME=reply_waits_before_rows psql_cmd >"$TMP_ROOT/reply-waits-before-rows.out" 2>&1 <<SQL &
INSERT INTO public.comments(id,post_id,user_id,parent_id,content)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4','$POST_ID','$ACTOR','$PARENT_ID','no deadlock');
SQL
waiting_reply_pid=$!
wait_for_advisory_wait reply_waits_before_rows
wait "$reaction_pid"
wait "$waiting_reply_pid"

# Report integration regression: 113800 enters the shared helper before its
# target row lock. Once 114500 wraps that helper advisory-first, a concurrent
# reply waits without holding the post row needed by the report transaction.
PGAPPNAME=report_holds_edge psql_cmd >"$TMP_ROOT/report-holds-edge.out" 2>&1 <<SQL &
BEGIN;
SELECT public.submit_content_report(
  '$ACTOR',
  'post',
  '$POST_ID',
  'spam',
  'sufficient report description',
  ARRAY[]::text[]
);
SELECT pg_catalog.pg_sleep(1.2);
COMMIT;
SQL
report_pid=$!
wait_for_sleeping_app report_holds_edge
PGAPPNAME=report_safe_reply psql_cmd >"$TMP_ROOT/report-safe-reply.out" 2>&1 <<SQL &
INSERT INTO public.comments(id,post_id,user_id,parent_id,content)
VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5','$POST_ID','$ACTOR','$PARENT_ID','report safe');
SQL
report_reply_pid=$!
wait_for_advisory_wait report_safe_reply
wait "$report_pid"
wait "$report_reply_pid"

# Repost interactions inherit the root author's block contract. The serializer
# rejects new comments and reaction additions/changes, while an existing
# reaction can still be withdrawn. Comment edits are fresh interactions and
# are rejected by the advisory-first edit wrapper.
psql_cmd -c "SELECT public.toggle_comment_reaction('$REPOST_ID','$REPOST_COMMENT_ID','$ACTOR','like')" >/dev/null
psql_cmd -c "INSERT INTO public.blocked_users(blocker_id, blocked_id) VALUES ('$OTHER', '$ACTOR')" >/dev/null

if psql_cmd -c "INSERT INTO public.comments(id,post_id,user_id,content) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb7','$REPOST_ID','$ACTOR','blocked by root')" >"$TMP_ROOT/root-blocked-comment.out" 2>&1; then
  echo "Comment unexpectedly crossed a repost-root block" >&2
  exit 1
fi
grep -Fq 'a root-author block prevents this comment interaction' \
  "$TMP_ROOT/root-blocked-comment.out"

psql_cmd -Atqc "SELECT public.toggle_comment_reaction('$REPOST_ID','$REPOST_COMMENT_ID','$ACTOR','like')->>'action'" \
  | grep -Fxq 'removed'
if psql_cmd -c "SELECT public.toggle_comment_reaction('$REPOST_ID','$REPOST_COMMENT_ID','$ACTOR','like')" >"$TMP_ROOT/root-blocked-reaction.out" 2>&1; then
  echo "Reaction addition unexpectedly crossed a repost-root block" >&2
  exit 1
fi
grep -Fq 'a root-author block prevents this comment interaction' \
  "$TMP_ROOT/root-blocked-reaction.out"

if psql_cmd -c "SELECT * FROM public.update_own_comment('$REPOST_COMMENT_ID','$REPOST_ID','$ACTOR','blocked edit')" >"$TMP_ROOT/root-blocked-edit.out" 2>&1; then
  echo "Comment edit unexpectedly crossed a repost-root block" >&2
  exit 1
fi
grep -Fq 'a root-author block prevents comment edits on this post' \
  "$TMP_ROOT/root-blocked-edit.out"

psql_cmd -c "DELETE FROM public.blocked_users WHERE blocker_id='$OTHER' AND blocked_id='$ACTOR'" >/dev/null

# The wrapper/root and author identities that determine advisory keys are frozen.
if psql_cmd -c "UPDATE public.posts SET author_id='$OTHER' WHERE id='$POST_ID'" >"$TMP_ROOT/post-author-rewrite.out" 2>&1; then
  echo "Post author identity rewrite unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq 'post author and repost root identity are immutable' \
  "$TMP_ROOT/post-author-rewrite.out"

# Replay repairs arbitrary ACL and same-name trigger drift without changing
# committed interaction/block evidence.
psql_cmd <<'SQL'
GRANT EXECUTE ON FUNCTION public.lock_post_interaction_block_edges(uuid,uuid,uuid)
  TO drifted_comment_writer;
DROP TRIGGER trg_comments_09_serialize_block_authorization ON public.comments;
CREATE TRIGGER trg_comments_09_serialize_block_authorization
BEFORE INSERT ON public.comments
FOR EACH STATEMENT
EXECUTE FUNCTION public.serialize_comment_block_authorization();
SQL
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $replay_proof$
BEGIN
  IF pg_catalog.has_function_privilege(
       'drifted_comment_writer',
       'public.lock_post_interaction_block_edges(uuid,uuid,uuid)',
       'EXECUTE'
     ) OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.comments'::regclass
         AND trigger_row.tgname = 'trg_comments_09_serialize_block_authorization'
         AND trigger_row.tgtype = 7
     ) OR (
       SELECT pg_catalog.count(*) FROM public.comments
       WHERE id IN (
         'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3',
         'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb4',
         'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb5',
         'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbba2'
       )
     ) <> 4 THEN
    RAISE EXCEPTION 'comment authorization replay did not converge';
  END IF;
END
$replay_proof$;
SQL

echo "atomic comment block authorization PostgreSQL 17 proof passed"
