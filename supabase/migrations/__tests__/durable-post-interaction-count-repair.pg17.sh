#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803104000_durable_post_interaction_count_repair.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TMP_ROOT="$(mktemp -d /tmp/post-interaction-count-repair-pg17.XXXXXX)"
PGDATA="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
PORT="$((58100 + ($$ % 400)))"

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
  for _ in {1..100}; do
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
  id uuid PRIMARY KEY,
  like_count integer DEFAULT 0,
  dislike_count integer DEFAULT 0,
  poll_bull integer DEFAULT 0,
  poll_bear integer DEFAULT 0,
  poll_wait integer DEFAULT 0
);

CREATE TABLE public.post_likes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reaction_type text NOT NULL CHECK (reaction_type IN ('up', 'down')),
  UNIQUE (post_id, user_id)
);

CREATE TABLE public.post_votes (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  choice text NOT NULL CHECK (choice IN ('bull', 'bear', 'wait')),
  UNIQUE (post_id, user_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.posts, public.post_likes, public.post_votes
  TO service_role;

CREATE OR REPLACE FUNCTION public.increment_like_count(post_id uuid)
RETURNS TABLE(like_count integer)
LANGUAGE sql
AS $function$
  UPDATE public.posts
  SET like_count = COALESCE(posts.like_count, 0) + 1
  WHERE id = post_id
  RETURNING posts.like_count
$function$;

CREATE OR REPLACE FUNCTION public.decrement_like_count(post_id uuid)
RETURNS TABLE(like_count integer)
LANGUAGE sql
AS $function$
  UPDATE public.posts
  SET like_count = GREATEST(0, COALESCE(posts.like_count, 0) - 1)
  WHERE id = post_id
  RETURNING posts.like_count
$function$;

CREATE OR REPLACE FUNCTION public.toggle_post_reaction(
  p_post_id uuid,
  p_user_id uuid,
  p_reaction_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-reaction-counts:' || p_post_id::text, 0)
  );
  UPDATE public.posts SET like_count = like_count WHERE id = p_post_id;
  RETURN '{}'::jsonb;
END
$function$;

CREATE OR REPLACE FUNCTION public.set_post_reaction_desired_state_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_desired_reaction text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-reaction-counts:' || p_post_id::text, 0)
  );
  UPDATE public.posts SET like_count = like_count WHERE id = p_post_id;
  RETURN '{}'::jsonb;
END
$function$;

CREATE OR REPLACE FUNCTION public.toggle_post_vote_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_choice text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-reaction-counts:' || p_post_id::text, 0)
  );
  UPDATE public.posts SET poll_bull = poll_bull WHERE id = p_post_id;
  RETURN '{}'::jsonb;
END
$function$;

CREATE OR REPLACE FUNCTION public.set_post_vote_desired_state_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_desired_choice text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-reaction-counts:' || p_post_id::text, 0)
  );
  UPDATE public.posts SET poll_bull = poll_bull WHERE id = p_post_id;
  RETURN '{}'::jsonb;
END
$function$;

INSERT INTO auth.users (id) VALUES
  ('10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000003');

INSERT INTO public.posts (
  id,
  like_count,
  dislike_count,
  poll_bull,
  poll_bear,
  poll_wait
) VALUES (
  '20000000-0000-0000-0000-000000000001',
  99,
  98,
  97,
  96,
  95
), (
  '20000000-0000-0000-0000-000000000099',
  NULL,
  NULL,
  NULL,
  NULL,
  NULL
);

INSERT INTO public.post_likes (post_id, user_id, reaction_type) VALUES
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'up'
  ),
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000002',
    'down'
  );

INSERT INTO public.post_votes (post_id, user_id, choice) VALUES
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'bull'
  ),
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000002',
    'wait'
  );
SQL

psql_cmd -f "$MIGRATION"

assert_scalar 'f|f|f|f' \
  "SELECT
     has_function_privilege('anon', 'public.increment_like_count(uuid)', 'EXECUTE'),
     has_function_privilege('authenticated', 'public.decrement_like_count(uuid)', 'EXECUTE'),
     has_function_privilege('authenticator', 'public.increment_like_count(uuid)', 'EXECUTE'),
     has_function_privilege('service_role', 'public.decrement_like_count(uuid)', 'EXECUTE')"
if psql_cmd -At -c \
  "SET ROLE authenticated;
   SELECT * FROM public.increment_like_count(
     '20000000-0000-0000-0000-000000000001'
   )" >"$TMP_ROOT/legacy-like.out" 2>"$TMP_ROOT/legacy-like.err"; then
  echo 'legacy arithmetic like counter remained callable' >&2
  exit 1
fi
grep -q 'permission denied for function increment_like_count' "$TMP_ROOT/legacy-like.err"

# Migration backfill identifies both stale nonzero caches and source rows.
assert_scalar '1' \
  "SELECT count(*) FROM public.post_interaction_count_repair_queue"
assert_service 'processed|1|1|0|0|false' \
  "SELECT result->>'status', result->>'processed_count', result->>'repaired_count',
          result->>'discarded_count', result->>'contended_count', result->>'has_more'
     FROM public.repair_post_interaction_counts_atomic(1) AS result"
assert_scalar '1|1|1|0|1' \
  "SELECT like_count, dislike_count, poll_bull, poll_bear, poll_wait
     FROM public.posts
    WHERE id = '20000000-0000-0000-0000-000000000001'"
assert_scalar '0' \
  "SELECT count(*) FROM public.post_interaction_count_repair_queue"

# Invalid calls are exact and the service claim is independently enforced.
assert_service '{"status": "invalid"}' \
  "SELECT public.repair_post_interaction_counts_atomic(0)"
if psql_cmd -At -c \
  "SET ROLE service_role; SELECT public.repair_post_interaction_counts_atomic(1)" \
  >"$TMP_ROOT/missing-claim.out" 2>"$TMP_ROOT/missing-claim.err"; then
  echo 'repair worker accepted a missing service claim' >&2
  exit 1
fi
grep -q 'service role required' "$TMP_ROOT/missing-claim.err"

# Every direct source mutation creates one coalesced durable obligation.
psql_cmd <<'SQL'
SET ROLE service_role;
INSERT INTO public.post_likes (post_id, user_id, reaction_type)
VALUES (
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000003',
  'up'
);
UPDATE public.post_votes
SET choice = 'bear'
WHERE post_id = '20000000-0000-0000-0000-000000000001'
  AND user_id = '10000000-0000-0000-0000-000000000002';
SQL
assert_scalar '1' \
  "SELECT count(*) FROM public.post_interaction_count_repair_queue"
assert_service 'processed|1|1|0' \
  "SELECT result->>'status', result->>'processed_count',
          result->>'repaired_count', result->>'discarded_count'
     FROM public.repair_post_interaction_counts_atomic(1) AS result"
assert_scalar '2|1|1|1|0' \
  "SELECT like_count, dislike_count, poll_bull, poll_bear, poll_wait
     FROM public.posts
    WHERE id = '20000000-0000-0000-0000-000000000001'"

# auth.users cascade holds the parent/child side only; the trigger queues and a
# later worker repairs both reaction and vote caches without lock inversion.
psql_cmd -c \
  "DELETE FROM auth.users WHERE id = '10000000-0000-0000-0000-000000000001'"
assert_scalar '2|1|1|1|0|1' \
  "SELECT target.like_count, target.dislike_count,
          target.poll_bull, target.poll_bear, target.poll_wait,
          count(repair_queue.post_id)
     FROM public.posts AS target
     LEFT JOIN public.post_interaction_count_repair_queue AS repair_queue
       ON repair_queue.post_id = target.id
    WHERE target.id = '20000000-0000-0000-0000-000000000001'
    GROUP BY target.id"
assert_service 'processed|1|1|0' \
  "SELECT result->>'status', result->>'processed_count',
          result->>'repaired_count', result->>'discarded_count'
     FROM public.repair_post_interaction_counts_atomic(1) AS result"
assert_scalar '1|1|0|1|0' \
  "SELECT like_count, dislike_count, poll_bull, poll_bear, poll_wait
     FROM public.posts
    WHERE id = '20000000-0000-0000-0000-000000000001'"

# A post cascade can enqueue a now-stale identity; the no-FK queue drains it as
# discarded instead of blocking the destructive parent action.
psql_cmd <<'SQL'
INSERT INTO public.posts(id) VALUES
  ('20000000-0000-0000-0000-000000000002');
INSERT INTO public.post_likes(post_id, user_id, reaction_type) VALUES (
  '20000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000002',
  'up'
);
DELETE FROM public.posts
WHERE id = '20000000-0000-0000-0000-000000000002';
SQL
assert_service 'processed|1|0|1' \
  "SELECT result->>'status', result->>'processed_count',
          result->>'repaired_count', result->>'discarded_count'
     FROM public.repair_post_interaction_counts_atomic(1) AS result"

# A concurrent post hard-delete owns the parent row before cascading through
# child triggers. The worker must skip the locked post without ever claiming Q;
# after the delete commits, the durable stale identity is safely discarded.
psql_cmd <<'SQL'
INSERT INTO public.posts(id) VALUES
  ('20000000-0000-0000-0000-000000000003');
INSERT INTO public.post_likes(post_id, user_id, reaction_type) VALUES (
  '20000000-0000-0000-0000-000000000003',
  '10000000-0000-0000-0000-000000000002',
  'up'
);
SQL
PGAPPNAME=concurrent_post_delete psql_cmd \
  >"$TMP_ROOT/post-delete.out" 2>"$TMP_ROOT/post-delete.err" <<'SQL' &
BEGIN;
DELETE FROM public.posts
WHERE id = '20000000-0000-0000-0000-000000000003';
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
POST_DELETE_PID=$!
wait_for_activity \
  "application_name = 'concurrent_post_delete' AND wait_event = 'PgSleep'" \
  '1' \
  'concurrent post delete gate did not become ready'
assert_service 'processed|0|0|1|false' \
  "SELECT result->>'status', result->>'processed_count',
          result->>'repaired_count', result->>'contended_count', result->>'has_more'
     FROM public.repair_post_interaction_counts_atomic(1) AS result"
assert_scalar '1|t' \
  "SELECT attempt_count, next_attempt_at > statement_timestamp()
     FROM public.post_interaction_count_repair_queue
    WHERE post_id = '20000000-0000-0000-0000-000000000003'"
wait "$POST_DELETE_PID"
if [[ -s "$TMP_ROOT/post-delete.err" ]]; then
  cat "$TMP_ROOT/post-delete.err" >&2
  exit 1
fi
assert_scalar '0|1' \
  "SELECT
     (SELECT count(*) FROM public.posts
       WHERE id = '20000000-0000-0000-0000-000000000003'),
     (SELECT count(*) FROM public.post_interaction_count_repair_queue
       WHERE post_id = '20000000-0000-0000-0000-000000000003')"
psql_cmd -c \
  "UPDATE public.post_interaction_count_repair_queue
      SET next_attempt_at = statement_timestamp()
    WHERE post_id = '20000000-0000-0000-0000-000000000003'"
assert_service 'processed|1|0|1|false' \
  "SELECT result->>'status', result->>'processed_count',
          result->>'repaired_count', result->>'discarded_count', result->>'has_more'
     FROM public.repair_post_interaction_counts_atomic(1) AS result"

# Critical interleaving: the worker deletes Q and writes the currently visible
# count, while a direct child DELETE waits to UPSERT Q. Once the worker commits,
# the child transaction leaves a fresh obligation; a second pass converges.
psql_cmd -c \
  "UPDATE public.posts
      SET like_count = 1
    WHERE id = '20000000-0000-0000-0000-000000000001'"
psql_cmd -c \
  "INSERT INTO public.post_interaction_count_repair_queue(post_id)
   VALUES ('20000000-0000-0000-0000-000000000001')
   ON CONFLICT (post_id) DO NOTHING"

PGAPPNAME=repair_worker_gate psql_cmd \
  >"$TMP_ROOT/repair-worker.out" 2>"$TMP_ROOT/repair-worker.err" <<'SQL' &
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.repair_post_interaction_counts_atomic(1);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
WORKER_PID=$!
wait_for_activity \
  "application_name = 'repair_worker_gate' AND wait_event = 'PgSleep'" \
  '1' \
  'repair worker gate did not become ready'

PGAPPNAME=direct_child_delete psql_cmd \
  >"$TMP_ROOT/direct-delete.out" 2>"$TMP_ROOT/direct-delete.err" <<'SQL' &
DELETE FROM public.post_likes
WHERE post_id = '20000000-0000-0000-0000-000000000001'
  AND user_id = '10000000-0000-0000-0000-000000000003';
SQL
DELETE_PID=$!
wait_for_activity \
  "application_name = 'direct_child_delete' AND wait_event_type = 'Lock'" \
  '1' \
  'direct child delete did not wait on the durable queue identity'

wait "$WORKER_PID"
wait "$DELETE_PID"
if [[ -s "$TMP_ROOT/repair-worker.err" || -s "$TMP_ROOT/direct-delete.err" ]]; then
  cat "$TMP_ROOT/repair-worker.err" "$TMP_ROOT/direct-delete.err" >&2
  exit 1
fi
assert_scalar '1|0|1' \
  "SELECT target.like_count,
          (SELECT count(*) FROM public.post_likes AS reaction
            WHERE reaction.post_id = target.id
              AND reaction.reaction_type = 'up'),
          (SELECT count(*) FROM public.post_interaction_count_repair_queue AS repair_queue
            WHERE repair_queue.post_id = target.id)
     FROM public.posts AS target
    WHERE target.id = '20000000-0000-0000-0000-000000000001'"
assert_service 'processed|1|1|0' \
  "SELECT result->>'status', result->>'processed_count',
          result->>'repaired_count', result->>'discarded_count'
     FROM public.repair_post_interaction_counts_atomic(1) AS result"
assert_scalar '0|0|0' \
  "SELECT target.like_count,
          (SELECT count(*) FROM public.post_likes AS reaction
            WHERE reaction.post_id = target.id
              AND reaction.reaction_type = 'up'),
          (SELECT count(*) FROM public.post_interaction_count_repair_queue AS repair_queue
            WHERE repair_queue.post_id = target.id)
     FROM public.posts AS target
    WHERE target.id = '20000000-0000-0000-0000-000000000001'"

# Live post authority wins the post lock; the worker skips rather than taking Q
# first or waiting into a lock cycle, and the obligation remains retryable.
psql_cmd -c \
  "INSERT INTO public.post_interaction_count_repair_queue(post_id)
   VALUES ('20000000-0000-0000-0000-000000000001')
   ON CONFLICT (post_id) DO NOTHING"
PGAPPNAME=live_post_authority psql_cmd \
  >"$TMP_ROOT/live-authority.out" 2>"$TMP_ROOT/live-authority.err" <<'SQL' &
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'post-reaction-counts:20000000-0000-0000-0000-000000000001',
    0
  )
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
AUTHORITY_PID=$!
wait_for_activity \
  "application_name = 'live_post_authority' AND wait_event = 'PgSleep'" \
  '1' \
  'live post authority gate did not become ready'
assert_service 'processed|0|0|1|false' \
  "SELECT result->>'status', result->>'processed_count',
          result->>'repaired_count', result->>'contended_count', result->>'has_more'
     FROM public.repair_post_interaction_counts_atomic(1) AS result"
wait "$AUTHORITY_PID"
if [[ -s "$TMP_ROOT/live-authority.err" ]]; then
  cat "$TMP_ROOT/live-authority.err" >&2
  exit 1
fi
psql_cmd -c \
  "UPDATE public.post_interaction_count_repair_queue
      SET next_attempt_at = statement_timestamp()
    WHERE post_id = '20000000-0000-0000-0000-000000000001'"
assert_service 'processed|1|1|0|false' \
  "SELECT result->>'status', result->>'processed_count',
          result->>'repaired_count', result->>'contended_count', result->>'has_more'
     FROM public.repair_post_interaction_counts_atomic(1) AS result"

# Replaying the migration converges trigger/ACL definitions and re-enqueues the
# bounded source/cached candidate set without creating duplicate obligations.
psql_cmd <<'SQL'
GRANT SELECT (post_id)
  ON public.post_interaction_count_repair_queue TO authenticated;
GRANT UPDATE (next_attempt_at)
  ON public.post_interaction_count_repair_queue TO service_role;
SQL
psql_cmd -f "$MIGRATION"
assert_scalar 'f|f' \
  "SELECT
     has_column_privilege(
       'authenticated',
       'public.post_interaction_count_repair_queue',
       'post_id',
       'SELECT'
     ),
     has_column_privilege(
       'service_role',
       'public.post_interaction_count_repair_queue',
       'next_attempt_at',
       'UPDATE'
     )"
assert_scalar '1' \
  "SELECT count(*) FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.post_likes'::regclass
      AND tgname = 'trg_post_likes_90_enqueue_count_repair'
      AND NOT tgisinternal"
assert_scalar '1' \
  "SELECT count(*) FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'public.post_votes'::regclass
      AND tgname = 'trg_post_votes_90_enqueue_count_repair'
      AND NOT tgisinternal"
assert_service 'processed' \
  "SELECT result->>'status'
     FROM public.repair_post_interaction_counts_atomic(1) AS result"

# The migration refuses a live authority that no longer participates in the
# canonical shared post lock, then succeeds after the dependency is restored.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.toggle_post_vote_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_choice text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  UPDATE public.posts SET poll_bull = poll_bull WHERE id = p_post_id;
  RETURN '{}'::jsonb;
END
$function$;
SQL
if psql_cmd -f "$MIGRATION" \
  >"$TMP_ROOT/authority-drift.out" 2>"$TMP_ROOT/authority-drift.err"; then
  echo 'migration accepted an authority outside the shared post lock' >&2
  exit 1
fi
grep -q 'does not share the canonical repair lock' "$TMP_ROOT/authority-drift.err"

psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.toggle_post_vote_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_choice text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-reaction-counts:' || p_post_id::text, 0)
  );
  UPDATE public.posts SET poll_bull = poll_bull WHERE id = p_post_id;
  RETURN '{}'::jsonb;
END
$function$;
SQL
psql_cmd -f "$MIGRATION"

echo 'durable post interaction count repair PG17 proof passed'
