#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803105000_bind_bookmark_count_consistency.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/bookmark-count-consistency-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="$((59400 + ($$ % 200)))"

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
    "SET request.jwt.claim.role = 'service_role';
     SET ROLE service_role;
     $query"
}

auth_scalar() {
  local actor_id="$1"
  local query="$2"
  psql_cmd -At -c \
    "SET request.jwt.claim.role = 'authenticated';
     SET request.jwt.claim.sub = '$actor_id';
     SET ROLE authenticated;
     $query"
}

wait_for_backend() {
  local application_name="$1"
  local predicate="$2"
  local backend_pid
  local attempt
  for attempt in {1..100}; do
    backend_pid="$(psql_cmd -At -c \
      "SELECT COALESCE(pg_catalog.max(pid)::text, '')
       FROM pg_catalog.pg_stat_activity
       WHERE application_name = '$application_name'
         AND ($predicate)")"
    if [[ -n "$backend_pid" ]]; then
      printf '%s\n' "$backend_pid"
      return 0
    fi
    sleep 0.05
  done
  echo "timed out waiting for backend: $application_name ($predicate)" >&2
  return 1
}

psql_cmd <<'SQL'
CREATE ROLE anon NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER BYPASSRLS;
GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth, public
  TO anon, authenticated, authenticator, service_role;

CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;

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

GRANT EXECUTE ON FUNCTION auth.role(), auth.uid()
  TO anon, authenticated, authenticator, service_role;

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

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  like_count integer DEFAULT 0,
  dislike_count integer DEFAULT 0,
  poll_bull integer DEFAULT 0,
  poll_bear integer DEFAULT 0,
  poll_wait integer DEFAULT 0,
  bookmark_count integer DEFAULT 0
);

CREATE TABLE public.bookmark_folders (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp()
);
CREATE UNIQUE INDEX bookmark_folders_default_one
  ON public.bookmark_folders(user_id)
  WHERE is_default IS TRUE;

CREATE TABLE public.post_likes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction_type text NOT NULL,
  UNIQUE (post_id, user_id)
);

CREATE TABLE public.post_votes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  choice text NOT NULL,
  UNIQUE (post_id, user_id)
);

CREATE TABLE public.post_bookmarks (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  folder_id uuid REFERENCES public.bookmark_folders(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  UNIQUE (post_id, user_id)
);

CREATE TABLE public.post_interaction_count_repair_queue (
  post_id uuid PRIMARY KEY,
  enqueued_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  next_attempt_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  attempt_count integer NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0 AND attempt_count <= 1000000)
);
CREATE INDEX idx_post_interaction_count_repair_queue_oldest
  ON public.post_interaction_count_repair_queue(
    next_attempt_at,
    enqueued_at,
    post_id
  );
ALTER TABLE public.post_interaction_count_repair_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_interaction_count_repair_queue FORCE ROW LEVEL SECURITY;

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
BEGIN
  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM target.id
  FROM public.posts AS target
  WHERE target.id = p_post_id
  FOR SHARE;
  RETURN FOUND;
END
$function$;

CREATE FUNCTION public.enforce_current_post_child_interaction()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NOT public.lock_actor_can_interact_with_post(NEW.post_id, NEW.user_id) THEN
    RAISE EXCEPTION 'post is not currently interactable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$function$;

CREATE TRIGGER trg_post_bookmarks_15_current_interaction
BEFORE INSERT OR UPDATE ON public.post_bookmarks
FOR EACH ROW
EXECUTE FUNCTION public.enforce_current_post_child_interaction();

CREATE FUNCTION public.enqueue_post_interaction_count_repair()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_post_id uuid;
BEGIN
  IF TG_TABLE_NAME NOT IN ('post_likes', 'post_votes') THEN
    RAISE EXCEPTION 'attached incorrectly';
  END IF;
  v_post_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.post_id ELSE NEW.post_id END;
  INSERT INTO public.post_interaction_count_repair_queue(post_id)
  VALUES (v_post_id)
  ON CONFLICT (post_id) DO NOTHING;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

CREATE TRIGGER trg_post_likes_90_enqueue_count_repair
AFTER INSERT OR DELETE OR UPDATE OF post_id, reaction_type ON public.post_likes
FOR EACH ROW EXECUTE FUNCTION public.enqueue_post_interaction_count_repair();
CREATE TRIGGER trg_post_votes_90_enqueue_count_repair
AFTER INSERT OR DELETE OR UPDATE OF post_id, choice ON public.post_votes
FOR EACH ROW EXECUTE FUNCTION public.enqueue_post_interaction_count_repair();

CREATE FUNCTION public.repair_post_interaction_counts_atomic(
  p_limit integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_post_id uuid;
  v_claimed_post_id uuid;
BEGIN
  IF p_limit IS DISTINCT FROM 1 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;
  SELECT repair_queue.post_id INTO v_post_id
  FROM public.post_interaction_count_repair_queue AS repair_queue
  WHERE repair_queue.next_attempt_at <= pg_catalog.statement_timestamp()
  LIMIT 1;
  IF v_post_id IS NULL THEN RETURN '{}'::jsonb; END IF;
  PERFORM pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('post-reaction-counts:' || v_post_id::text, 0)
  );
  PERFORM locked_post.id
  FROM public.posts AS locked_post
  WHERE locked_post.id = v_post_id
  FOR UPDATE;
  SELECT repair_queue.post_id INTO v_claimed_post_id
  FROM public.post_interaction_count_repair_queue AS repair_queue
  WHERE repair_queue.post_id = v_post_id
  FOR UPDATE;
  DELETE FROM public.post_interaction_count_repair_queue
  WHERE post_id = v_claimed_post_id;
  RETURN pg_catalog.jsonb_build_object('status', 'processed');
END
$function$;

CREATE FUNCTION public.toggle_post_reaction(uuid, uuid, text DEFAULT 'up')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-reaction-counts:' || $1::text, 0)
  );
  UPDATE public.posts SET like_count = like_count WHERE id = $1;
  RETURN '{}'::jsonb;
END
$function$;
CREATE FUNCTION public.set_post_reaction_desired_state_atomic(uuid, uuid, text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-reaction-counts:' || $2::text, 0)
  );
  UPDATE public.posts SET like_count = like_count WHERE id = $2;
  RETURN '{}'::jsonb;
END
$function$;
CREATE FUNCTION public.toggle_post_vote_atomic(uuid, uuid, text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-reaction-counts:' || $2::text, 0)
  );
  UPDATE public.posts SET poll_bull = poll_bull WHERE id = $2;
  RETURN '{}'::jsonb;
END
$function$;
CREATE FUNCTION public.set_post_vote_desired_state_atomic(uuid, uuid, text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-reaction-counts:' || $2::text, 0)
  );
  UPDATE public.posts SET poll_bull = poll_bull WHERE id = $2;
  RETURN '{}'::jsonb;
END
$function$;

CREATE FUNCTION public.toggle_post_bookmark_atomic(uuid, uuid, uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_count bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-bookmark:' || $2::text || ':' || $1::text, 0)
  );
  PERFORM 1 FROM public.post_bookmarks WHERE post_id = $2;
  SELECT count(*) INTO v_count FROM public.post_bookmarks WHERE post_id = $2;
  UPDATE public.posts SET bookmark_count = v_count WHERE id = $2;
  RETURN pg_catalog.jsonb_build_object('bookmark_count', v_count);
END
$function$;
CREATE FUNCTION public.save_post_bookmark_to_folder_atomic(uuid, uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_count bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-bookmark:' || $1::text, 0)
  );
  PERFORM 1 FROM public.post_bookmarks WHERE post_id = $1;
  SELECT count(*) INTO v_count FROM public.post_bookmarks WHERE post_id = $1;
  UPDATE public.posts SET bookmark_count = v_count WHERE id = $1;
  RETURN pg_catalog.jsonb_build_object('bookmark_count', v_count);
END
$function$;
CREATE FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid, uuid, uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE v_count bigint;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-bookmark:' || $1::text, 0)
  );
  PERFORM 1 FROM public.post_bookmarks WHERE post_id = $1;
  SELECT count(*) INTO v_count FROM public.post_bookmarks WHERE post_id = $1;
  UPDATE public.posts SET bookmark_count = v_count WHERE id = $1;
  RETURN pg_catalog.jsonb_build_object('bookmark_count', v_count);
END
$function$;

CREATE FUNCTION public.increment_bookmark_count(post_id uuid)
RETURNS TABLE(bookmark_count integer)
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY UPDATE public.posts
  SET bookmark_count = COALESCE(posts.bookmark_count, 0) + 1
  WHERE id = post_id RETURNING posts.bookmark_count;
END
$function$;
CREATE FUNCTION public.decrement_bookmark_count(post_id uuid)
RETURNS TABLE(bookmark_count integer)
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN QUERY UPDATE public.posts
  SET bookmark_count = GREATEST(0, COALESCE(posts.bookmark_count, 0) - 1)
  WHERE id = post_id RETURNING posts.bookmark_count;
END
$function$;

REVOKE ALL ON FUNCTION public.toggle_post_bookmark_atomic(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.toggle_post_bookmark_atomic(uuid,uuid,uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.save_post_bookmark_to_folder_atomic(uuid,uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.save_post_bookmark_to_folder_atomic(uuid,uuid)
  TO authenticated;
REVOKE ALL ON FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)
  TO authenticated;

REVOKE ALL ON TABLE public.post_interaction_count_repair_queue
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.enqueue_post_interaction_count_repair()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.repair_post_interaction_counts_atomic(integer)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.repair_post_interaction_counts_atomic(integer)
  TO service_role;

ALTER TABLE public.post_bookmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY post_bookmarks_select_own_canonical
  ON public.post_bookmarks FOR SELECT TO authenticated
  USING ((SELECT auth.uid()) = user_id);
REVOKE ALL ON TABLE public.post_bookmarks
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT SELECT ON TABLE public.post_bookmarks TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.post_bookmarks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.posts,
  public.bookmark_folders, public.user_profiles TO service_role;

INSERT INTO auth.users(id) VALUES
  ('10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000003');
INSERT INTO public.user_profiles(id) SELECT id FROM auth.users;
INSERT INTO public.posts(id, bookmark_count)
SELECT ('20000000-0000-0000-0000-' || pg_catalog.lpad(value::text, 12, '0'))::uuid,
       CASE WHEN value = 1 THEN NULL ELSE 0 END
FROM pg_catalog.generate_series(1, 20) AS value;
INSERT INTO public.bookmark_folders(id, user_id, name, is_default) VALUES
  ('30000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Default', true),
  ('30000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'Default', true),
  ('30000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000003', 'Default', true);
INSERT INTO public.post_bookmarks(id, post_id, user_id, folder_id) VALUES (
  '40000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  '30000000-0000-0000-0000-000000000001'
);
SQL

psql_cmd -f "$MIGRATION"

assert_scalar '1' \
  "SELECT count(*) FROM public.post_interaction_count_repair_queue
   WHERE post_id = '20000000-0000-0000-0000-000000000001'"
assert_scalar 't|f|f|t|t|f' \
  "SELECT
     has_function_privilege('service_role', 'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)', 'EXECUTE'),
     has_function_privilege('authenticated', 'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)', 'EXECUTE'),
     has_function_privilege('service_role', 'public.save_post_bookmark_to_folder_atomic(uuid,uuid)', 'EXECUTE'),
     has_function_privilege('authenticated', 'public.save_post_bookmark_to_folder_atomic(uuid,uuid)', 'EXECUTE'),
     has_function_privilege('authenticated', 'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)', 'EXECUTE'),
     has_function_privilege('service_role', 'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)', 'EXECUTE')"
assert_scalar '3' \
  "SELECT count(*) FROM pg_catalog.pg_trigger
   WHERE tgname IN (
     'trg_post_likes_90_enqueue_count_repair',
     'trg_post_votes_90_enqueue_count_repair',
     'trg_post_bookmarks_90_enqueue_count_repair'
   ) AND tgfoid = 'public.enqueue_post_interaction_count_repair()'::regprocedure"
assert_scalar '3' \
  "SELECT count(*) FROM pg_catalog.pg_proc
   WHERE oid IN (
     'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)'::regprocedure,
     'public.save_post_bookmark_to_folder_atomic(uuid,uuid)'::regprocedure,
     'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'::regprocedure
   ) AND strpos(prosrc, '''post-reaction-counts:''') > 0
     AND strpos(prosrc, '''post-bookmark:''') > strpos(prosrc, '''post-reaction-counts:''')"
assert_scalar '2' \
  "SELECT count(*) FROM pg_catalog.pg_proc
   WHERE oid IN (
     'public.save_post_bookmark_to_folder_atomic(uuid,uuid)'::regprocedure,
     'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'::regprocedure
   ) AND strpos(prosrc, '''account-recovery-admission:''') >
         strpos(prosrc, '''post-bookmark:''')
     AND strpos(prosrc, 'FROM auth.users AS actor_account') >
         strpos(prosrc, '''account-recovery-admission:''')
     AND strpos(prosrc, 'FROM public.user_profiles AS profile') >
         strpos(prosrc, 'FROM auth.users AS actor_account')"
echo 'P -> B -> account recovery breaks the former three-way cycle'

# Backfill and absolute worker truth.
assert_scalar '1' \
  "SET request.jwt.claim.role='service_role';
   SELECT public.repair_post_interaction_counts_atomic(1)->>'repaired_count'"
assert_scalar '1|0' \
  "SELECT bookmark_count,
          (SELECT count(*) FROM public.post_interaction_count_repair_queue)
   FROM public.posts WHERE id='20000000-0000-0000-0000-000000000001'"

# A clean replay must not refill Q merely because canonical bookmarks exist.
psql_cmd -f "$MIGRATION"
assert_scalar '0' \
  'SELECT count(*) FROM public.post_interaction_count_repair_queue'
echo 'clean replay added no bookmark repair work'

# concurrent same-post bookmark writers: P serializes actors and prevents a
# lost absolute count even though the pair locks differ.
echo 'concurrent same-post bookmark writers'
service_scalar \
  "SELECT public.toggle_post_bookmark_atomic(
     '10000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000002', NULL)->>'status'" \
  >"$TMP_ROOT/toggle-a.out" &
pid_a=$!
service_scalar \
  "SELECT public.toggle_post_bookmark_atomic(
     '10000000-0000-0000-0000-000000000002',
     '20000000-0000-0000-0000-000000000002', NULL)->>'status'" \
  >"$TMP_ROOT/toggle-b.out" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
grep -qx 'added' "$TMP_ROOT/toggle-a.out"
grep -qx 'added' "$TMP_ROOT/toggle-b.out"
assert_scalar '2|2' \
  "SELECT count(*), target.bookmark_count
   FROM public.post_bookmarks AS bookmark
   JOIN public.posts AS target ON target.id=bookmark.post_id
   WHERE bookmark.post_id='20000000-0000-0000-0000-000000000002'
   GROUP BY target.bookmark_count"

# Same actor toggle/save must serialize through P then B. Either legal order is
# accepted, but source truth and cache must be equal and uniqueness must hold.
service_scalar \
  "SELECT public.toggle_post_bookmark_atomic(
     '10000000-0000-0000-0000-000000000001',
     '20000000-0000-0000-0000-000000000003', NULL)->>'status'" \
  >"$TMP_ROOT/pair-toggle.out" &
pid_a=$!
auth_scalar '10000000-0000-0000-0000-000000000001' \
  "SELECT public.save_post_bookmark_to_folder_atomic(
     '20000000-0000-0000-0000-000000000003',
     '30000000-0000-0000-0000-000000000001')->>'status'" \
  >"$TMP_ROOT/pair-save.out" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
assert_scalar 't' \
  "SELECT target.bookmark_count = (
            SELECT count(*) FROM public.post_bookmarks
            WHERE post_id=target.id
          )
      AND target.bookmark_count BETWEEN 0 AND 1
   FROM public.posts AS target
   WHERE target.id='20000000-0000-0000-0000-000000000003'"

# Preserve save/remove ACK semantics.
assert_scalar 'added' \
  "SET request.jwt.claim.role='authenticated';
   SET request.jwt.claim.sub='10000000-0000-0000-0000-000000000001';
   SET ROLE authenticated;
   SELECT public.save_post_bookmark_to_folder_atomic(
     '20000000-0000-0000-0000-000000000004',
     '30000000-0000-0000-0000-000000000001')->>'status'"
bookmark_id="$(psql_cmd -At -c \
  "SELECT id FROM public.post_bookmarks
   WHERE post_id='20000000-0000-0000-0000-000000000004'
     AND user_id='10000000-0000-0000-0000-000000000001'")"
assert_scalar 'removed|0' \
  "SET request.jwt.claim.role='authenticated';
   SET request.jwt.claim.sub='10000000-0000-0000-0000-000000000001';
   SET ROLE authenticated;
   SELECT result->>'status', result->>'bookmark_count'
   FROM (SELECT public.remove_post_bookmark_from_folder_atomic(
     '20000000-0000-0000-0000-000000000004',
     '$bookmark_id',
     '30000000-0000-0000-0000-000000000001') AS result) AS receipt"

# A save that has passed A must pin auth.users before it waits on profile or
# folder state. The concurrent account delete must be blocked directly by the
# save backend, then cascade safely after the save commits.
echo 'save pins auth.users against concurrent account deletion'
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES ('10000000-0000-0000-0000-000000000006');
INSERT INTO public.user_profiles(id) VALUES ('10000000-0000-0000-0000-000000000006');
INSERT INTO public.bookmark_folders(id,user_id,name,is_default) VALUES (
  '30000000-0000-0000-0000-000000000006',
  '10000000-0000-0000-0000-000000000006','Default',true
);
TRUNCATE public.post_interaction_count_repair_queue;
SQL
psql_cmd <<'SQL' >"$TMP_ROOT/profile-blocker.out" &
SET application_name = 'bookmark-profile-lock-holder';
BEGIN;
SELECT id FROM public.user_profiles
WHERE id='10000000-0000-0000-0000-000000000006' FOR UPDATE;
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
profile_holder_pid=$!
wait_for_backend 'bookmark-profile-lock-holder' \
  "state = 'active' AND query LIKE '%pg_sleep%'" >/dev/null
auth_scalar '10000000-0000-0000-0000-000000000006' \
  "SET application_name = 'bookmark-save-delete-race';
   SELECT public.save_post_bookmark_to_folder_atomic(
     '20000000-0000-0000-0000-000000000010',
     '30000000-0000-0000-0000-000000000006')->>'status'" \
  >"$TMP_ROOT/save-delete-save.out" &
save_client_pid=$!
save_backend_pid="$(wait_for_backend 'bookmark-save-delete-race' \
  "wait_event_type = 'Lock'")"
psql_cmd -c \
  "SET application_name = 'bookmark-auth-delete-race';
   DELETE FROM auth.users
   WHERE id='10000000-0000-0000-0000-000000000006'" \
  >"$TMP_ROOT/save-delete-delete.out" &
delete_client_pid=$!
delete_backend_pid="$(wait_for_backend 'bookmark-auth-delete-race' \
  "wait_event_type = 'Lock'")"
assert_scalar 't' \
  "SELECT $save_backend_pid = ANY(
     pg_catalog.pg_blocking_pids($delete_backend_pid)
   )"
wait "$profile_holder_pid"
wait "$save_client_pid"
wait "$delete_client_pid"
grep -qx 'added' "$TMP_ROOT/save-delete-save.out"
assert_scalar '0|0|0|1' \
  "SELECT
     (SELECT count(*) FROM auth.users
      WHERE id='10000000-0000-0000-0000-000000000006'),
     (SELECT count(*) FROM public.user_profiles
      WHERE id='10000000-0000-0000-0000-000000000006'),
     (SELECT count(*) FROM public.post_bookmarks
      WHERE post_id='20000000-0000-0000-0000-000000000010'),
     (SELECT count(*) FROM public.post_interaction_count_repair_queue
      WHERE post_id='20000000-0000-0000-0000-000000000010')"
assert_scalar '0|1' \
  "SELECT count(bookmark.id), target.bookmark_count
   FROM public.posts AS target
   LEFT JOIN public.post_bookmarks AS bookmark ON bookmark.post_id=target.id
   WHERE target.id='20000000-0000-0000-0000-000000000010'
   GROUP BY target.bookmark_count"
service_scalar "SELECT public.repair_post_interaction_counts_atomic(1)" >/dev/null
assert_scalar '0' \
  "SELECT bookmark_count FROM public.posts
   WHERE id='20000000-0000-0000-0000-000000000010'"

# Direct row DML is durable and the worker restores an intentionally corrupt
# cache from source truth.
psql_cmd -c 'TRUNCATE public.post_interaction_count_repair_queue'
service_scalar \
  "INSERT INTO public.post_bookmarks(post_id,user_id,folder_id) VALUES (
     '20000000-0000-0000-0000-000000000005',
     '10000000-0000-0000-0000-000000000003',
     '30000000-0000-0000-0000-000000000003');"
psql_cmd -c \
  "UPDATE public.posts SET bookmark_count=99
   WHERE id='20000000-0000-0000-0000-000000000005'"
assert_scalar '1' \
  "SET request.jwt.claim.role='service_role';
   SELECT public.repair_post_interaction_counts_atomic(1)->>'repaired_count'"
assert_scalar '1' \
  "SELECT bookmark_count FROM public.posts
   WHERE id='20000000-0000-0000-0000-000000000005'"

# direct mutation re-enqueues Q after an in-flight drain.
echo 'direct mutation re-enqueues Q after an in-flight drain'
psql_cmd -c 'TRUNCATE public.post_interaction_count_repair_queue'
psql_cmd -c \
  "INSERT INTO public.post_interaction_count_repair_queue(post_id) VALUES
   ('20000000-0000-0000-0000-000000000006')"
psql_cmd <<'SQL' >"$TMP_ROOT/drain.out" &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'post-reaction-counts:20000000-0000-0000-0000-000000000006', 0
  )
);
SELECT id FROM public.posts
WHERE id='20000000-0000-0000-0000-000000000006' FOR UPDATE;
SELECT post_id FROM public.post_interaction_count_repair_queue
WHERE post_id='20000000-0000-0000-0000-000000000006' FOR UPDATE;
DELETE FROM public.post_interaction_count_repair_queue
WHERE post_id='20000000-0000-0000-0000-000000000006';
SELECT pg_catalog.pg_sleep(0.6);
COMMIT;
SQL
drain_pid=$!
sleep 0.1
service_scalar \
  "INSERT INTO public.post_bookmarks(post_id,user_id,folder_id) VALUES (
     '20000000-0000-0000-0000-000000000006',
     '10000000-0000-0000-0000-000000000003',
     '30000000-0000-0000-0000-000000000003');" \
  >"$TMP_ROOT/direct-after-drain.out" &
direct_pid=$!
wait "$drain_pid"
wait "$direct_pid"
assert_scalar '1' \
  "SELECT count(*) FROM public.post_interaction_count_repair_queue
   WHERE post_id='20000000-0000-0000-0000-000000000006'"
service_scalar "SELECT public.repair_post_interaction_counts_atomic(1)" >/dev/null
assert_scalar '1' \
  "SELECT bookmark_count FROM public.posts
   WHERE id='20000000-0000-0000-0000-000000000006'"

# auth cascade never waits on P: enqueue takes no post/auth lock and leaves a
# repair obligation while the actor and folder disappear.
echo 'auth cascade never waits on P'
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES ('10000000-0000-0000-0000-000000000004');
INSERT INTO public.user_profiles(id) VALUES ('10000000-0000-0000-0000-000000000004');
INSERT INTO public.bookmark_folders(id,user_id,name,is_default) VALUES (
  '30000000-0000-0000-0000-000000000004',
  '10000000-0000-0000-0000-000000000004','Default',true
);
INSERT INTO public.post_bookmarks(post_id,user_id,folder_id) VALUES (
  '20000000-0000-0000-0000-000000000007',
  '10000000-0000-0000-0000-000000000004',
  '30000000-0000-0000-0000-000000000004'
);
UPDATE public.posts SET bookmark_count=1
WHERE id='20000000-0000-0000-0000-000000000007';
TRUNCATE public.post_interaction_count_repair_queue;
SQL
psql_cmd <<'SQL' >"$TMP_ROOT/hold-p.out" &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'post-reaction-counts:20000000-0000-0000-0000-000000000007', 0
  )
);
SELECT pg_catalog.pg_sleep(0.6);
COMMIT;
SQL
hold_pid=$!
sleep 0.1
psql_cmd -c \
  "SET lock_timeout='300ms';
   DELETE FROM auth.users
   WHERE id='10000000-0000-0000-0000-000000000004'"
wait "$hold_pid"
assert_scalar '0|1' \
  "SELECT count(*),
          (SELECT count(*) FROM public.post_interaction_count_repair_queue
           WHERE post_id='20000000-0000-0000-0000-000000000007')
   FROM public.post_bookmarks
   WHERE post_id='20000000-0000-0000-0000-000000000007'"
service_scalar "SELECT public.repair_post_interaction_counts_atomic(1)" >/dev/null
assert_scalar '0' \
  "SELECT bookmark_count FROM public.posts
   WHERE id='20000000-0000-0000-0000-000000000007'"

# folder cascade enqueues every affected post without acquiring multiple P
# locks; bounded worker calls repair one post per transaction.
echo 'folder cascade enqueues every affected post'
psql_cmd <<'SQL'
INSERT INTO auth.users(id) VALUES ('10000000-0000-0000-0000-000000000005');
INSERT INTO public.user_profiles(id) VALUES ('10000000-0000-0000-0000-000000000005');
INSERT INTO public.bookmark_folders(id,user_id,name,is_default) VALUES (
  '30000000-0000-0000-0000-000000000005',
  '10000000-0000-0000-0000-000000000005','Batch',false
);
INSERT INTO public.post_bookmarks(post_id,user_id,folder_id) VALUES
  ('20000000-0000-0000-0000-000000000008','10000000-0000-0000-0000-000000000005','30000000-0000-0000-0000-000000000005'),
  ('20000000-0000-0000-0000-000000000009','10000000-0000-0000-0000-000000000005','30000000-0000-0000-0000-000000000005');
UPDATE public.posts SET bookmark_count=1
WHERE id IN (
  '20000000-0000-0000-0000-000000000008',
  '20000000-0000-0000-0000-000000000009'
);
TRUNCATE public.post_interaction_count_repair_queue;
DELETE FROM public.bookmark_folders
WHERE id='30000000-0000-0000-0000-000000000005';
SQL
assert_scalar '2' \
  "SELECT count(*) FROM public.post_interaction_count_repair_queue
   WHERE post_id IN (
     '20000000-0000-0000-0000-000000000008',
     '20000000-0000-0000-0000-000000000009'
   )"
service_scalar "SELECT public.repair_post_interaction_counts_atomic(1)" >/dev/null
service_scalar "SELECT public.repair_post_interaction_counts_atomic(1)" >/dev/null
assert_scalar '0|0' \
  "SELECT min(bookmark_count), max(bookmark_count) FROM public.posts
   WHERE id IN (
     '20000000-0000-0000-0000-000000000008',
     '20000000-0000-0000-0000-000000000009'
   )"

# The grouped mismatch watermark must stay bounded at a representative scale
# and enqueue only drifted posts: 2,000 child-backed + 500 stale-positive,
# while 500 exact zeroes remain absent from Q.
echo 'grouped mismatch backfill stays within the scale budget'
psql_cmd <<'SQL'
UPDATE public.posts AS target
SET bookmark_count = (
  SELECT pg_catalog.count(*)::integer
  FROM public.post_bookmarks AS bookmark
  WHERE bookmark.post_id = target.id
);
INSERT INTO public.posts(id, bookmark_count)
SELECT (
         '21000000-0000-0000-0000-' ||
         pg_catalog.lpad(value::text, 12, '0')
       )::uuid,
       CASE WHEN value BETWEEN 2001 AND 2500 THEN 7 ELSE 0 END
FROM pg_catalog.generate_series(1, 3000) AS value;
INSERT INTO public.post_bookmarks(post_id,user_id,folder_id)
SELECT (
         '21000000-0000-0000-0000-' ||
         pg_catalog.lpad(value::text, 12, '0')
       )::uuid,
       '10000000-0000-0000-0000-000000000003'::uuid,
       '30000000-0000-0000-0000-000000000003'::uuid
FROM pg_catalog.generate_series(1, 2000) AS value;
TRUNCATE public.post_interaction_count_repair_queue;
SQL
scale_started=$SECONDS
psql_cmd -f "$MIGRATION"
scale_elapsed=$((SECONDS - scale_started))
if (( scale_elapsed > 15 )); then
  echo "grouped mismatch backfill exceeded 15s budget: ${scale_elapsed}s" >&2
  exit 1
fi
assert_scalar '2500' \
  "SELECT count(*) FROM public.post_interaction_count_repair_queue
   WHERE post_id::text LIKE '21000000-%'"
assert_scalar '0' \
  "SELECT count(*) FROM public.post_interaction_count_repair_queue
   WHERE post_id::text LIKE '21000000-%'
     AND post_id::text >= '21000000-0000-0000-0000-000000002501'"
psql_cmd <<'SQL'
DELETE FROM public.posts WHERE id::text LIKE '21000000-%';
TRUNCATE public.post_interaction_count_repair_queue;
SQL

# Non-owner TRUNCATE and legacy arithmetic paths are closed.
if service_scalar 'TRUNCATE public.post_bookmarks' \
  >"$TMP_ROOT/truncate.out" 2>"$TMP_ROOT/truncate.err"; then
  echo 'service_role retained post_bookmarks TRUNCATE' >&2
  exit 1
fi
if service_scalar \
  "SELECT * FROM public.increment_bookmark_count(
     '20000000-0000-0000-0000-000000000001')" \
  >"$TMP_ROOT/legacy.out" 2>"$TMP_ROOT/legacy.err"; then
  echo 'service_role retained legacy bookmark arithmetic execute' >&2
  exit 1
fi

# Replay converges ACL/config/comment/trigger/TRUNCATE drift.
psql_cmd <<'SQL'
GRANT EXECUTE ON FUNCTION public.toggle_post_bookmark_atomic(uuid,uuid,uuid) TO PUBLIC;
GRANT EXECUTE ON FUNCTION public.save_post_bookmark_to_folder_atomic(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.repair_post_interaction_counts_atomic(integer)
  TO service_role WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION public.increment_bookmark_count(uuid) TO PUBLIC;
GRANT TRUNCATE ON public.post_bookmarks TO service_role;
ALTER FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)
  RESET lock_timeout;
DROP TRIGGER trg_post_bookmarks_90_enqueue_count_repair ON public.post_bookmarks;
COMMENT ON FUNCTION public.save_post_bookmark_to_folder_atomic(uuid,uuid) IS 'drift';
SQL
psql_cmd -f "$MIGRATION"
assert_scalar 't|f|t|f|f|f|3' \
  "SELECT
     has_function_privilege('service_role','public.toggle_post_bookmark_atomic(uuid,uuid,uuid)','EXECUTE'),
     has_function_privilege('authenticated','public.toggle_post_bookmark_atomic(uuid,uuid,uuid)','EXECUTE'),
     has_function_privilege('authenticated','public.save_post_bookmark_to_folder_atomic(uuid,uuid)','EXECUTE'),
     has_function_privilege('service_role','public.save_post_bookmark_to_folder_atomic(uuid,uuid)','EXECUTE'),
     has_function_privilege('service_role','public.increment_bookmark_count(uuid)','EXECUTE'),
     has_table_privilege('service_role','public.post_bookmarks','TRUNCATE'),
     (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgname IN (
       'trg_post_likes_90_enqueue_count_repair',
       'trg_post_votes_90_enqueue_count_repair',
       'trg_post_bookmarks_90_enqueue_count_repair'
     ))"
echo 'replay reconverged bookmark authority'

# Fail closed on queue schema drift.
psql_cmd -c \
  'ALTER TABLE public.post_interaction_count_repair_queue ADD COLUMN drift boolean'
if psql_cmd -f "$MIGRATION" \
  >"$TMP_ROOT/queue-drift.out" 2>"$TMP_ROOT/queue-drift.err"; then
  echo 'migration accepted queue schema drift' >&2
  exit 1
fi
grep -q 'repair queue relation/column/RLS contract drifted' "$TMP_ROOT/queue-drift.err"
psql_cmd -c \
  'ALTER TABLE public.post_interaction_count_repair_queue DROP COLUMN drift'

# Fail closed when the 1040 queue loses its ordering index or retains the same
# column list with non-default DESC/NULL ordering.
psql_cmd -c \
  'DROP INDEX public.idx_post_interaction_count_repair_queue_oldest'
if psql_cmd -f "$MIGRATION" \
  >"$TMP_ROOT/index-missing.out" 2>"$TMP_ROOT/index-missing.err"; then
  echo 'migration accepted missing queue ordering index' >&2
  exit 1
fi
grep -q 'repair queue ordering index drifted' "$TMP_ROOT/index-missing.err"
psql_cmd -c \
  "CREATE INDEX idx_post_interaction_count_repair_queue_oldest
   ON public.post_interaction_count_repair_queue(
     next_attempt_at DESC, enqueued_at, post_id
   )"
if psql_cmd -f "$MIGRATION" \
  >"$TMP_ROOT/index-order.out" 2>"$TMP_ROOT/index-order.err"; then
  echo 'migration accepted non-default queue ordering index' >&2
  exit 1
fi
grep -q 'repair queue ordering index drifted' "$TMP_ROOT/index-order.err"
psql_cmd -c \
  "DROP INDEX public.idx_post_interaction_count_repair_queue_oldest;
   CREATE INDEX idx_post_interaction_count_repair_queue_oldest
   ON public.post_interaction_count_repair_queue(
     next_attempt_at, enqueued_at, post_id
   )"

# Fail closed if a reaction/vote writer leaves the shared P domain.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.toggle_post_reaction(uuid, uuid, text DEFAULT 'up')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  UPDATE public.posts SET like_count=like_count WHERE id=$1;
  RETURN '{}'::jsonb;
END
$function$;
SQL
if psql_cmd -f "$MIGRATION" \
  >"$TMP_ROOT/p-drift.out" 2>"$TMP_ROOT/p-drift.err"; then
  echo 'migration accepted shared P authority drift' >&2
  exit 1
fi
grep -q 'reaction/vote shared P authority drifted' "$TMP_ROOT/p-drift.err"
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.toggle_post_reaction(uuid, uuid, text DEFAULT 'up')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-reaction-counts:' || $1::text, 0)
  );
  UPDATE public.posts SET like_count=like_count WHERE id=$1;
  RETURN '{}'::jsonb;
END
$function$;
SQL

# Fail closed when a correctly named 1040 trigger omits a watched column.
psql_cmd <<'SQL'
DROP TRIGGER trg_post_likes_90_enqueue_count_repair ON public.post_likes;
CREATE TRIGGER trg_post_likes_90_enqueue_count_repair
AFTER INSERT OR DELETE OR UPDATE OF post_id ON public.post_likes
FOR EACH ROW EXECUTE FUNCTION public.enqueue_post_interaction_count_repair();
SQL
if psql_cmd -f "$MIGRATION" \
  >"$TMP_ROOT/trigger-column-drift.out" \
  2>"$TMP_ROOT/trigger-column-drift.err"; then
  echo 'migration accepted wrong-column reaction repair trigger' >&2
  exit 1
fi
grep -q '1040 source repair trigger drifted' \
  "$TMP_ROOT/trigger-column-drift.err"

# Exact type/function/tgattr is still insufficient when WHEN(false) can
# suppress every durable obligation; tgqual must be NULL.
psql_cmd <<'SQL'
DROP TRIGGER trg_post_likes_90_enqueue_count_repair ON public.post_likes;
CREATE TRIGGER trg_post_likes_90_enqueue_count_repair
AFTER INSERT OR DELETE OR UPDATE OF post_id, reaction_type ON public.post_likes
FOR EACH ROW WHEN (false)
EXECUTE FUNCTION public.enqueue_post_interaction_count_repair();
SQL
if psql_cmd -f "$MIGRATION" \
  >"$TMP_ROOT/trigger-when-drift.out" \
  2>"$TMP_ROOT/trigger-when-drift.err"; then
  echo 'migration accepted conditional reaction repair trigger' >&2
  exit 1
fi
grep -q '1040 source repair trigger drifted' \
  "$TMP_ROOT/trigger-when-drift.err"
psql_cmd <<'SQL'
DROP TRIGGER trg_post_likes_90_enqueue_count_repair ON public.post_likes;
CREATE TRIGGER trg_post_likes_90_enqueue_count_repair
AFTER INSERT OR DELETE OR UPDATE OF post_id, reaction_type ON public.post_likes
FOR EACH ROW EXECUTE FUNCTION public.enqueue_post_interaction_count_repair();
SQL
psql_cmd -f "$MIGRATION"

echo 'bookmark count consistency PG17 proof passed'
