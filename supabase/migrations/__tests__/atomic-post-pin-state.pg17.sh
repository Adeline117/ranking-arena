#!/usr/bin/env bash

# PostgreSQL 17 proof for atomic post pin state. It owns an isolated temporary
# cluster and never connects to an application database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729182500_atomic_post_pin_state.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/atomic-post-pin-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=$((57000 + ($$ % 4000)))
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

expect_failure() {
  local sql=$1
  if psql_cmd -c "$sql" >"$TMP_ROOT/expected-failure.out" 2>&1; then
    echo "Expected SQL to fail: $sql" >&2
    return 1
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

psql_cmd <<'SQL'
CREATE ROLE postgres SUPERUSER NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE rogue_role NOLOGIN;

CREATE SCHEMA auth;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT COALESCE(
    NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    NULLIF(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb
      ->> 'role'
  )::text
$function$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, rogue_role;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role, rogue_role;

CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE public.post_status AS ENUM ('active', 'locked', 'deleted');

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  dissolved_at timestamptz
);
CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL REFERENCES auth.users(id),
  group_id uuid REFERENCES public.groups(id),
  is_pinned boolean,
  visibility text NOT NULL DEFAULT 'public',
  status public.post_status NOT NULL DEFAULT 'active',
  deleted_at timestamptz
);
CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.member_role NOT NULL DEFAULT 'member',
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL REFERENCES auth.users(id),
  blocked_id uuid NOT NULL REFERENCES auth.users(id),
  PRIMARY KEY (blocker_id, blocked_id)
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.groups OWNER TO postgres;
ALTER TABLE public.posts OWNER TO postgres;
ALTER TABLE public.group_members OWNER TO postgres;
ALTER TABLE public.blocked_users OWNER TO postgres;

CREATE FUNCTION public.lock_post_interaction_block_edges(
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
  v_author_id uuid;
BEGIN
  SELECT target.author_id
  INTO v_author_id
  FROM public.posts AS target
  WHERE target.id = p_post_id;
  IF NOT FOUND OR p_actor_id IS NULL OR p_target_comment_id IS NOT NULL THEN
    RETURN false;
  END IF;

  IF v_author_id <> p_actor_id THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'post-audience:block:' || LEAST(p_actor_id::text, v_author_id::text)
          || ':' || GREATEST(p_actor_id::text, v_author_id::text),
        0
      )
    );
  END IF;
  RETURN true;
END
$function$;
ALTER FUNCTION public.lock_post_interaction_block_edges(uuid, uuid, uuid)
  OWNER TO postgres;

CREATE FUNCTION public.lock_actor_can_interact_with_post_locked_impl(
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
DECLARE
  v_post public.posts%ROWTYPE;
BEGIN
  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL
    AND NOT profile.is_banned
  FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT target.*
  INTO v_post
  FROM public.posts AS target
  WHERE target.id = p_post_id
  FOR SHARE;
  IF NOT FOUND
     OR v_post.deleted_at IS NOT NULL
     OR v_post.status NOT IN ('active', 'locked')
  THEN
    RETURN false;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.blocked_users AS edge
    WHERE (edge.blocker_id = p_actor_id AND edge.blocked_id = v_post.author_id)
       OR (edge.blocker_id = v_post.author_id AND edge.blocked_id = p_actor_id)
  ) THEN
    RETURN false;
  END IF;

  IF v_post.group_id IS NOT NULL THEN
    PERFORM target_group.id
    FROM public.groups AS target_group
    WHERE target_group.id = v_post.group_id
      AND target_group.dissolved_at IS NULL
    FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;

    PERFORM member.user_id
    FROM public.group_members AS member
    WHERE member.group_id = v_post.group_id
      AND member.user_id = p_actor_id
    FOR SHARE;
    IF NOT FOUND AND v_post.author_id <> p_actor_id THEN RETURN false; END IF;
  ELSIF v_post.visibility <> 'public' AND v_post.author_id <> p_actor_id THEN
    RETURN false;
  END IF;

  RETURN true;
END
$function$;
ALTER FUNCTION public.lock_actor_can_interact_with_post_locked_impl(uuid, uuid)
  OWNER TO postgres;

CREATE FUNCTION public.lock_actor_can_interact_with_post(
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
ALTER FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

INSERT INTO auth.users (id) VALUES
  ('a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000002'),
  ('a0000000-0000-4000-8000-000000000003'),
  ('a0000000-0000-4000-8000-000000000004'),
  ('a0000000-0000-4000-8000-000000000005');
INSERT INTO public.user_profiles (id)
SELECT id FROM auth.users;
INSERT INTO public.groups (id) VALUES
  ('b0000000-0000-4000-8000-000000000001');
INSERT INTO public.group_members (group_id, user_id, role) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000002', 'owner'),
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 'admin'),
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000004', 'member');
INSERT INTO public.posts (id, author_id, group_id, is_pinned) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', NULL, false),
  ('c0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', NULL, false),
  ('c0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', false),
  ('c0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000004', 'b0000000-0000-4000-8000-000000000001', false),
  ('c0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', false);
UPDATE public.posts
SET deleted_at = pg_catalog.clock_timestamp()
WHERE id = 'c0000000-0000-4000-8000-000000000005';
SQL

echo 'PG17: install atomic post pin state authority'
psql_cmd -f "$MIGRATION" >/dev/null

echo 'PG17: enforce service-only ACL and auth.role boundary'
expect_failure "SET ROLE anon; SELECT public.set_post_pin_state_atomic('a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',true);"
expect_failure "SET ROLE authenticated; SELECT public.set_post_pin_state_atomic('a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',true);"
expect_failure "SET ROLE service_role; SET request.jwt.claim.role='authenticated'; SELECT public.set_post_pin_state_atomic('a0000000-0000-4000-8000-000000000001','c0000000-0000-4000-8000-000000000001',true);"

psql_cmd <<'SQL'
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';

DO $proof$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.set_post_pin_state_atomic(
    'a0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    true
  );
  IF v_result->>'success' <> 'true'
     OR v_result->>'scope_type' <> 'author'
     OR v_result->>'scope_id' <> 'a0000000-0000-4000-8000-000000000001'
     OR v_result->>'is_pinned' <> 'true'
     OR v_result->>'already_set' <> 'false'
  THEN
    RAISE EXCEPTION 'personal pin acknowledgement failed: %', v_result;
  END IF;

  v_result := public.set_post_pin_state_atomic(
    'a0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000001',
    true
  );
  IF v_result->>'already_set' <> 'true'
     OR v_result->>'unpinned_count' <> '0'
  THEN
    RAISE EXCEPTION 'same desired state was not idempotent: %', v_result;
  END IF;

  v_result := public.set_post_pin_state_atomic(
    'a0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000002',
    true
  );
  IF v_result->>'success' <> 'true'
     OR v_result->>'unpinned_count' <> '1'
  THEN
    RAISE EXCEPTION 'personal replacement pin failed: %', v_result;
  END IF;
END
$proof$;

RESET ROLE;

DO $state$
BEGIN
  IF (SELECT is_pinned FROM public.posts WHERE id = 'c0000000-0000-4000-8000-000000000001')
     OR NOT (SELECT is_pinned FROM public.posts WHERE id = 'c0000000-0000-4000-8000-000000000002')
  THEN
    RAISE EXCEPTION 'personal pin replacement did not leave exactly the requested target';
  END IF;
END
$state$;
SQL

echo 'PG17: prove group author, owner, and admin authority; deny ordinary non-author'
psql_cmd <<'SQL'
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';

DO $proof$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.set_post_pin_state_atomic(
    'a0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000003',
    true
  );
  IF v_result->>'success' <> 'true' OR v_result->>'scope_type' <> 'group' THEN
    RAISE EXCEPTION 'group author could not pin: %', v_result;
  END IF;

  v_result := public.set_post_pin_state_atomic(
    'a0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000004',
    true
  );
  IF v_result->>'success' <> 'true' OR v_result->>'unpinned_count' <> '1' THEN
    RAISE EXCEPTION 'group owner could not replace pin: %', v_result;
  END IF;

  v_result := public.set_post_pin_state_atomic(
    'a0000000-0000-4000-8000-000000000003',
    'c0000000-0000-4000-8000-000000000003',
    true
  );
  IF v_result->>'success' <> 'true' OR v_result->>'unpinned_count' <> '1' THEN
    RAISE EXCEPTION 'group admin could not replace pin: %', v_result;
  END IF;

  v_result := public.set_post_pin_state_atomic(
    'a0000000-0000-4000-8000-000000000004',
    'c0000000-0000-4000-8000-000000000003',
    false
  );
  IF v_result <> '{"reason":"PERMISSION_DENIED","success":false}'::jsonb THEN
    RAISE EXCEPTION 'ordinary non-author was not denied: %', v_result;
  END IF;
END
$proof$;
SQL

echo 'PG17: fail closed for inactive actors, deleted targets, and block edges'
psql_cmd <<'SQL'
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';

DO $proof$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.set_post_pin_state_atomic(
    'a0000000-0000-4000-8000-000000000001',
    'c0000000-0000-4000-8000-000000000005',
    true
  );
  IF v_result <> '{"reason":"POST_NOT_FOUND","success":false}'::jsonb THEN
    RAISE EXCEPTION 'deleted target was exposed: %', v_result;
  END IF;
END
$proof$;

RESET ROLE;
INSERT INTO public.blocked_users (blocker_id, blocked_id) VALUES
  ('a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001');

SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
DO $proof$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.set_post_pin_state_atomic(
    'a0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000003',
    false
  );
  IF v_result <> '{"reason":"POST_NOT_FOUND","success":false}'::jsonb THEN
    RAISE EXCEPTION 'blocked target was exposed: %', v_result;
  END IF;
END
$proof$;

RESET ROLE;
DELETE FROM public.blocked_users;
UPDATE public.user_profiles
SET is_banned = true
WHERE id = 'a0000000-0000-4000-8000-000000000002';

SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
DO $proof$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.set_post_pin_state_atomic(
    'a0000000-0000-4000-8000-000000000002',
    'c0000000-0000-4000-8000-000000000004',
    false
  );
  IF v_result <> '{"reason":"ACTOR_UNAVAILABLE","success":false}'::jsonb THEN
    RAISE EXCEPTION 'banned actor was not rejected: %', v_result;
  END IF;
END
$proof$;
RESET ROLE;
UPDATE public.user_profiles
SET is_banned = false
WHERE id = 'a0000000-0000-4000-8000-000000000002';
SQL

echo 'PG17: prove a target write failure rolls the old pin back intact'
psql_cmd <<'SQL'
UPDATE public.posts SET is_pinned = false
WHERE group_id = 'b0000000-0000-4000-8000-000000000001';
UPDATE public.posts SET is_pinned = true
WHERE id = 'c0000000-0000-4000-8000-000000000003';

CREATE FUNCTION public.fail_second_pin_for_proof()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.id = 'c0000000-0000-4000-8000-000000000004'::uuid
     AND NEW.is_pinned IS TRUE
  THEN
    RAISE EXCEPTION 'injected target pin failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_posts_fail_second_pin_for_proof
BEFORE UPDATE OF is_pinned ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.fail_second_pin_for_proof();
SQL

expect_failure "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.set_post_pin_state_atomic('a0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000004',true);"

psql_cmd <<'SQL'
DO $proof$
BEGIN
  IF NOT (SELECT is_pinned FROM public.posts WHERE id = 'c0000000-0000-4000-8000-000000000003')
     OR (SELECT is_pinned FROM public.posts WHERE id = 'c0000000-0000-4000-8000-000000000004')
  THEN
    RAISE EXCEPTION 'target failure committed a partial unpin';
  END IF;
END
$proof$;
DROP TRIGGER trg_posts_fail_second_pin_for_proof ON public.posts;
DROP FUNCTION public.fail_second_pin_for_proof();
SQL

echo 'PG17: concurrent pins serialize and leave exactly one group target'
psql_cmd <<'SQL'
UPDATE public.posts SET is_pinned = false
WHERE group_id = 'b0000000-0000-4000-8000-000000000001';

CREATE FUNCTION public.delay_pin_for_concurrency_proof()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.is_pinned IS TRUE AND OLD.is_pinned IS DISTINCT FROM true THEN
    PERFORM pg_catalog.pg_sleep(0.35);
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_posts_delay_pin_for_concurrency_proof
BEFORE UPDATE OF is_pinned ON public.posts
FOR EACH ROW EXECUTE FUNCTION public.delay_pin_for_concurrency_proof();
SQL

psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.set_post_pin_state_atomic('a0000000-0000-4000-8000-000000000002','c0000000-0000-4000-8000-000000000003',true);" >"$TMP_ROOT/pin-a.out" &
pid_a=$!
psql_cmd -Atqc "SET ROLE service_role; SET request.jwt.claim.role='service_role'; SELECT public.set_post_pin_state_atomic('a0000000-0000-4000-8000-000000000003','c0000000-0000-4000-8000-000000000004',true);" >"$TMP_ROOT/pin-b.out" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

if ! grep -q '"success": true' "$TMP_ROOT/pin-a.out" || ! grep -q '"success": true' "$TMP_ROOT/pin-b.out"; then
  echo 'Concurrent pin call did not return success' >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP TRIGGER trg_posts_delay_pin_for_concurrency_proof ON public.posts;
DROP FUNCTION public.delay_pin_for_concurrency_proof();
DO $proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.posts
    WHERE group_id = 'b0000000-0000-4000-8000-000000000001'
      AND COALESCE(is_pinned, false)
  ) <> 1 THEN
    RAISE EXCEPTION 'concurrent pins left zero or multiple targets';
  END IF;
END
$proof$;
SQL

echo 'PG17: migration replay preserves state and exact ACL'
before_replay="$(psql_cmd -Atqc "SELECT id::text || ':' || is_pinned::text FROM public.posts WHERE group_id='b0000000-0000-4000-8000-000000000001' AND COALESCE(is_pinned,false);")"
psql_cmd -f "$MIGRATION" >/dev/null
after_replay="$(psql_cmd -Atqc "SELECT id::text || ':' || is_pinned::text FROM public.posts WHERE group_id='b0000000-0000-4000-8000-000000000001' AND COALESCE(is_pinned,false);")"
if [[ "$before_replay" != "$after_replay" ]]; then
  echo 'Migration replay changed the committed pin state' >&2
  exit 1
fi

psql_cmd <<'SQL'
DO $acl$
DECLARE
  v_function regprocedure :=
    'public.set_post_pin_state_atomic(uuid,uuid,boolean)'::regprocedure;
BEGIN
  IF NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('rogue_role', v_function, 'EXECUTE')
  THEN
    RAISE EXCEPTION 'atomic post pin ACL drifted';
  END IF;
END
$acl$;
SQL

echo 'atomic-post-pin-state PG17 tests passed'
