#!/usr/bin/env bash

# Executable PostgreSQL 17 integration proof for:
#   20260715091500_atomic_comment_integrity.sql
#   20260715093000_allow_hidden_comment_self_delete.sql
# and, when COMMENT_CONTRACT_MIGRATION points to the local contract migration:
#   20260715100000_contract_comment_write_boundary.sql
#
# The script owns an isolated temporary cluster, fails non-zero on every unmet
# assertion, and never connects to a developer, staging, or production database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
EXPAND_MIGRATION="$ROOT_DIR/supabase/migrations/20260715091500_atomic_comment_integrity.sql"
HIDDEN_DELETE_MIGRATION="$ROOT_DIR/supabase/migrations/20260715093000_allow_hidden_comment_self_delete.sql"
CONTRACT_MIGRATION="${COMMENT_CONTRACT_MIGRATION:-}"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

if [[ ! -f "$EXPAND_MIGRATION" || ! -f "$HIDDEN_DELETE_MIGRATION" ]]; then
  echo "Required comment migrations are missing" >&2
  exit 1
fi

if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/hcd-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55439
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    echo "PostgreSQL 17 integration cluster log:" >&2
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --no-locale >/dev/null

"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses= -c deadlock_timeout=100ms" \
  -w start >/dev/null

PSQL=(
  "$PG_BIN/psql"
  -X
  -v ON_ERROR_STOP=1
  -h "$SOCKET_DIR"
  -p "$PORT"
  -d postgres
)

"${PSQL[@]}" <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.role', true), '')
$$;

CREATE TYPE public.post_status AS ENUM ('draft', 'active', 'deleted');

CREATE FUNCTION public.wilson_score_lower(integer, integer)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN $1 + $2 = 0 THEN 0::double precision
    ELSE $1::double precision / ($1 + $2)::double precision
  END
$$;

CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  dissolved_at timestamptz
);

CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  author_id uuid NOT NULL,
  visibility text NOT NULL DEFAULT 'public',
  group_id uuid REFERENCES public.groups(id),
  status public.post_status NOT NULL DEFAULT 'active',
  deleted_at timestamptz,
  comment_count integer DEFAULT 0
);

CREATE TABLE public.comments (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  author_id uuid,
  author_handle text,
  content text NOT NULL,
  parent_id uuid REFERENCES public.comments(id) ON DELETE CASCADE,
  like_count integer DEFAULT 0,
  dislike_count integer DEFAULT 0,
  created_at timestamptz DEFAULT clock_timestamp(),
  updated_at timestamptz DEFAULT clock_timestamp(),
  deleted_at timestamptz,
  deleted_by uuid,
  delete_reason text
);

CREATE TABLE public.comment_likes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL REFERENCES public.comments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  reaction_type text
);

CREATE TABLE public.blocked_users (
  blocker_id uuid NOT NULL,
  blocked_id uuid NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE public.group_bans (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE public.group_members (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  muted_until timestamptz,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE public.user_follows (
  follower_id uuid NOT NULL,
  following_id uuid NOT NULL,
  PRIMARY KEY (follower_id, following_id)
);

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.comment_likes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Posts are viewable by everyone"
  ON public.posts FOR SELECT TO public USING (true);
CREATE POLICY "Comments are viewable by everyone"
  ON public.comments FOR SELECT TO public USING (true);
CREATE POLICY "Comment likes are viewable by everyone"
  ON public.comment_likes FOR SELECT TO public USING (true);

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
SQL

# 093000 must refuse a baseline which has not installed 091500. A false success
# here would make a manual out-of-order deployment look healthy.
if "${PSQL[@]}" -f "$HIDDEN_DELETE_MIGRATION" \
  >"$LOG_DIR/out-of-order.stdout" 2>"$LOG_DIR/out-of-order.stderr"; then
  echo "093000 unexpectedly succeeded before 091500" >&2
  exit 1
fi
if ! grep -q 'requires 20260715091500 before 20260715093000' \
  "$LOG_DIR/out-of-order.stderr"; then
  echo "093000 failed out of order without the expected fail-closed diagnostic" >&2
  sed -n '1,120p' "$LOG_DIR/out-of-order.stderr" >&2
  exit 1
fi

# Seed valid active trees plus historical hidden nested trees before 091500.
# The latter are intentionally outside 091500's active-only nesting preflight
# and prove that 093000 counts every physical FK descendant.
"${PSQL[@]}" <<'SQL'
INSERT INTO public.posts (
  id, author_id, visibility, status, comment_count
) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', 'public', 'active', 99),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '11111111-1111-1111-1111-111111111111', 'public', 'active', 99),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', '11111111-1111-1111-1111-111111111111', 'public', 'active', 99);

INSERT INTO public.comments (
  id, post_id, user_id, author_id, content, parent_id, deleted_at
) VALUES
  ('a1000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'active root', NULL, NULL),
  ('a1000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'active direct reply', 'a1000000-0000-0000-0000-000000000001', NULL),
  ('a1000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'historical hidden nested reply', 'a1000000-0000-0000-0000-000000000002', '2026-01-01 00:00:00+00'),
  ('a1000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'hidden direct reply', 'a1000000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  ('b1000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'hidden root', NULL, '2026-01-01 00:00:00+00'),
  ('b1000000-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'hidden child', 'b1000000-0000-0000-0000-000000000001', '2026-01-01 00:00:00+00'),
  ('b1000000-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '22222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', 'hidden grandchild', 'b1000000-0000-0000-0000-000000000002', '2026-01-01 00:00:00+00'),
  ('b1000000-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'historical hidden self-cycle', 'b1000000-0000-0000-0000-000000000004', '2026-01-01 00:00:00+00'),
  ('c1000000-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3', '11111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'error and named-argument target', NULL, NULL);

INSERT INTO public.comment_likes (id, comment_id, user_id, reaction_type) VALUES
  ('d1000000-0000-0000-0000-000000000001', 'a1000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'like'),
  ('d1000000-0000-0000-0000-000000000002', 'a1000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', NULL),
  ('d1000000-0000-0000-0000-000000000003', 'b1000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'dislike');
SQL

"${PSQL[@]}" -f "$EXPAND_MIGRATION" >/dev/null
"${PSQL[@]}" -f "$HIDDEN_DELETE_MIGRATION" >/dev/null

# Prove all seven canonical triggers by exact table, enabled state, tgfoid and
# PostgreSQL event/timing/row mask. Expected masks are ROW plus:
#   19 = BEFORE UPDATE, 23 = BEFORE INSERT/UPDATE,
#   17 = AFTER UPDATE, 29 = AFTER INSERT/DELETE/UPDATE.
"${PSQL[@]}" <<'SQL'
DO $trigger_contract$
DECLARE
  v_mismatch text;
BEGIN
  WITH expected(table_name, trigger_name, function_name, expected_tgtype) AS (
    VALUES
      ('public.comments', 'trg_comments_05_authoritative_reaction_counts', 'public.bridge_legacy_comment_reaction_counts()', 19),
      ('public.comments', 'trg_comments_10_validate_integrity', 'public.validate_comment_integrity()', 23),
      ('public.comments', 'trg_comments_10_cascade_soft_delete', 'public.cascade_comment_soft_delete()', 17),
      ('public.comments', 'trg_comments_20_sync_post_count', 'public.sync_post_comment_count()', 29),
      ('public.comment_likes', 'trg_comment_likes_10_validate_integrity', 'public.validate_comment_reaction_integrity()', 23),
      ('public.comment_likes', 'trg_comment_likes_20_sync_counts', 'public.sync_comment_reaction_counts()', 29),
      ('public.posts', 'trg_posts_05_authoritative_comment_count', 'public.bridge_legacy_post_comment_count()', 19)
  )
  SELECT string_agg(expected.trigger_name, ', ' ORDER BY expected.trigger_name)
  INTO v_mismatch
  FROM expected
  LEFT JOIN pg_catalog.pg_trigger AS actual
    ON actual.tgrelid = pg_catalog.to_regclass(expected.table_name)
   AND actual.tgname = expected.trigger_name
   AND NOT actual.tgisinternal
  WHERE actual.oid IS NULL
     OR actual.tgenabled IS DISTINCT FROM 'O'
     OR actual.tgfoid IS DISTINCT FROM pg_catalog.to_regprocedure(expected.function_name)
     OR actual.tgtype IS DISTINCT FROM expected.expected_tgtype;

  IF v_mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'canonical trigger mismatch: %', v_mismatch;
  END IF;
END
$trigger_contract$;

DO $rpc_contract$
DECLARE
  v_function pg_catalog.pg_proc%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_function
  FROM pg_catalog.pg_proc
  WHERE oid = 'public.delete_own_comment(uuid,uuid,uuid)'::regprocedure;

  IF NOT v_function.prosecdef
     OR NOT v_function.proretset
     OR v_function.proargnames IS DISTINCT FROM
        ARRAY['p_comment_id', 'p_post_id', 'p_user_id', 'deleted_count', 'comment_count']::text[]
     OR v_function.proargmodes IS DISTINCT FROM ARRAY['i', 'i', 'i', 't', 't']::"char"[]
     OR NOT ('search_path=public, pg_temp' = ANY(v_function.proconfig)) THEN
    RAISE EXCEPTION 'delete_own_comment signature or SECURITY DEFINER configuration drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', 'public.delete_own_comment(uuid,uuid,uuid)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', 'public.delete_own_comment(uuid,uuid,uuid)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', 'public.delete_own_comment(uuid,uuid,uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'delete_own_comment ACL is not service-only';
  END IF;
END
$rpc_contract$;

DO $repaired_counts$
BEGIN
  IF (SELECT comment_count FROM public.posts WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1') <> 2
     OR (SELECT comment_count FROM public.posts WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2') <> 0
     OR (SELECT comment_count FROM public.posts WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3') <> 1 THEN
    RAISE EXCEPTION '091500 active comment count repair failed';
  END IF;
END
$repaired_counts$;
SQL

"${PSQL[@]}" <<'SQL'
SET ROLE service_role;

DO $errors$
BEGIN
  BEGIN
    PERFORM * FROM public.delete_own_comment(
      'c1000000-0000-0000-0000-000000000001',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
      '33333333-3333-3333-3333-333333333333'
    );
    RAISE EXCEPTION 'wrong owner unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;

  BEGIN
    PERFORM * FROM public.delete_own_comment(
      'c1000000-0000-0000-0000-000000000001',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
      '11111111-1111-1111-1111-111111111111'
    );
    RAISE EXCEPTION 'wrong post unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE 'P0002' THEN
    NULL;
  END;

  BEGIN
    PERFORM * FROM public.delete_own_comment(
      NULL,
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
      '11111111-1111-1111-1111-111111111111'
    );
    RAISE EXCEPTION 'NULL argument unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '22023' THEN
    NULL;
  END;
END
$errors$;

DO $mixed_tree$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.delete_own_comment(
    p_comment_id => 'a1000000-0000-0000-0000-000000000001',
    p_post_id => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
    p_user_id => '11111111-1111-1111-1111-111111111111'
  );

  IF v_result.deleted_count <> 4 OR v_result.comment_count <> 0 THEN
    RAISE EXCEPTION 'mixed recursive tree ACK mismatch: %', row_to_json(v_result);
  END IF;
END
$mixed_tree$;

DO $hidden_tree$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.delete_own_comment(
    p_comment_id => 'b1000000-0000-0000-0000-000000000001',
    p_post_id => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    p_user_id => '11111111-1111-1111-1111-111111111111'
  );

  IF v_result.deleted_count <> 3 OR v_result.comment_count <> 0 THEN
    RAISE EXCEPTION 'hidden recursive tree ACK mismatch: %', row_to_json(v_result);
  END IF;
END
$hidden_tree$;

DO $cycle_row$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.delete_own_comment(
    p_comment_id => 'b1000000-0000-0000-0000-000000000004',
    p_post_id => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
    p_user_id => '11111111-1111-1111-1111-111111111111'
  );

  IF v_result.deleted_count <> 1 OR v_result.comment_count <> 0 THEN
    RAISE EXCEPTION 'cycle-safe hidden delete ACK mismatch: %', row_to_json(v_result);
  END IF;
END
$cycle_row$;

DO $named_active_delete$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.delete_own_comment(
    p_comment_id => 'c1000000-0000-0000-0000-000000000001',
    p_post_id => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3',
    p_user_id => '11111111-1111-1111-1111-111111111111'
  );

  IF v_result.deleted_count <> 1 OR v_result.comment_count <> 0 THEN
    RAISE EXCEPTION 'named active delete ACK mismatch: %', row_to_json(v_result);
  END IF;
END
$named_active_delete$;

RESET ROLE;

DO $cascade_truth$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.comments
    WHERE post_id IN (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa3'
    )
  ) THEN
    RAISE EXCEPTION 'comment FK cascade left a source row';
  END IF;

  IF EXISTS (SELECT 1 FROM public.comment_likes) THEN
    RAISE EXCEPTION 'reaction FK cascade left a source row';
  END IF;
END
$cascade_truth$;
SQL

# Parent/reply race: the reply insert owns the canonical post lock first; the
# root delete must wait, then recursively count and remove both committed rows.
"${PSQL[@]}" <<'SQL'
INSERT INTO public.posts (id, author_id, visibility, status, comment_count)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
  '11111111-1111-1111-1111-111111111111',
  'public',
  'active',
  0
);
INSERT INTO public.comments (id, post_id, user_id, author_id, content)
VALUES (
  'e1000000-0000-0000-0000-000000000001',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  'concurrent root'
);
SQL

"${PSQL[@]}" >"$LOG_DIR/reply-insert.log" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL statement_timeout = '5s';
INSERT INTO public.comments (
  id, post_id, user_id, author_id, content, parent_id
) VALUES (
  'e1000000-0000-0000-0000-000000000002',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
  '22222222-2222-2222-2222-222222222222',
  '22222222-2222-2222-2222-222222222222',
  'concurrent reply',
  'e1000000-0000-0000-0000-000000000001'
);
SELECT pg_sleep(1);
COMMIT;
SQL
reply_pid=$!
sleep 0.2

"${PSQL[@]}" -At >"$LOG_DIR/root-delete.log" 2>&1 <<'SQL' &
SET statement_timeout = '5s';
SET ROLE service_role;
SELECT deleted_count::text || ':' || comment_count::text
FROM public.delete_own_comment(
  p_comment_id => 'e1000000-0000-0000-0000-000000000001',
  p_post_id => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa4',
  p_user_id => '11111111-1111-1111-1111-111111111111'
);
SQL
delete_pid=$!

if ! wait "$reply_pid"; then
  echo "Concurrent reply insert failed" >&2
  sed -n '1,160p' "$LOG_DIR/reply-insert.log" >&2
  exit 1
fi
if ! wait "$delete_pid"; then
  echo "Concurrent root delete failed" >&2
  sed -n '1,160p' "$LOG_DIR/root-delete.log" >&2
  exit 1
fi
if ! grep -qx '2:0' "$LOG_DIR/root-delete.log"; then
  echo "Concurrent parent/reply ACK mismatch" >&2
  sed -n '1,160p' "$LOG_DIR/reply-insert.log" >&2
  sed -n '1,160p' "$LOG_DIR/root-delete.log" >&2
  exit 1
fi

# Reaction/delete race: toggle holds post SHARE and comment UPDATE locks until
# commit. Delete must wait at the post lock, never invert to comment -> post.
"${PSQL[@]}" <<'SQL'
INSERT INTO public.posts (id, author_id, visibility, status, comment_count)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5',
  '11111111-1111-1111-1111-111111111111',
  'public',
  'active',
  0
);
INSERT INTO public.comments (id, post_id, user_id, author_id, content)
VALUES (
  'e2000000-0000-0000-0000-000000000001',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5',
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  'reaction race root'
);
SQL

"${PSQL[@]}" >"$LOG_DIR/reaction.log" 2>&1 <<'SQL' &
BEGIN;
SET LOCAL statement_timeout = '5s';
SET ROLE service_role;
SELECT public.toggle_comment_reaction(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5',
  'e2000000-0000-0000-0000-000000000001',
  '22222222-2222-2222-2222-222222222222',
  'like'
);
SELECT pg_sleep(1);
COMMIT;
SQL
reaction_pid=$!
sleep 0.2

"${PSQL[@]}" -At >"$LOG_DIR/reaction-delete.log" 2>&1 <<'SQL' &
SET statement_timeout = '5s';
SET ROLE service_role;
SELECT deleted_count::text || ':' || comment_count::text
FROM public.delete_own_comment(
  'e2000000-0000-0000-0000-000000000001',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa5',
  '11111111-1111-1111-1111-111111111111'
);
SQL
reaction_delete_pid=$!

if ! wait "$reaction_pid"; then
  echo "Concurrent reaction failed" >&2
  sed -n '1,160p' "$LOG_DIR/reaction.log" >&2
  exit 1
fi
if ! wait "$reaction_delete_pid"; then
  echo "Concurrent reaction-target delete failed" >&2
  sed -n '1,160p' "$LOG_DIR/reaction-delete.log" >&2
  exit 1
fi
if ! grep -qx '1:0' "$LOG_DIR/reaction-delete.log"; then
  echo "Concurrent reaction/delete ACK mismatch" >&2
  sed -n '1,160p' "$LOG_DIR/reaction.log" >&2
  sed -n '1,160p' "$LOG_DIR/reaction-delete.log" >&2
  exit 1
fi
if grep -qE 'deadlock detected|40P01' "$LOG_DIR"/*.log; then
  echo "A canonical concurrency proof deadlocked" >&2
  grep -nE 'deadlock detected|40P01' "$LOG_DIR"/*.log >&2 || true
  exit 1
fi

"${PSQL[@]}" <<'SQL'
DO $concurrency_truth$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.posts AS post_row
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::integer AS source_count
      FROM public.comments AS comment_row
      WHERE comment_row.post_id = post_row.id
        AND comment_row.deleted_at IS NULL
    ) AS source_counts ON true
    WHERE post_row.comment_count IS DISTINCT FROM source_counts.source_count
  ) THEN
    RAISE EXCEPTION 'post comment count drift after concurrency proof';
  END IF;

  IF EXISTS (SELECT 1 FROM public.comment_likes) THEN
    RAISE EXCEPTION 'reaction cascade drift after concurrency proof';
  END IF;
END
$concurrency_truth$;
SQL

if [[ -n "$CONTRACT_MIGRATION" ]]; then
  if [[ ! -f "$CONTRACT_MIGRATION" ]]; then
    echo "COMMENT_CONTRACT_MIGRATION does not exist: $CONTRACT_MIGRATION" >&2
    exit 1
  fi

  "${PSQL[@]}" -f "$CONTRACT_MIGRATION" >/dev/null
  # Contract migrations must be safe to replay after an uncertain deploy.
  "${PSQL[@]}" -f "$CONTRACT_MIGRATION" >/dev/null

  # The contract allows service-role INSERT but blocks direct DELETE. Hide the
  # source through the canonical moderation RPC, replay 093000, then prove the
  # SECURITY DEFINER self-delete still crosses the contracted table boundary.
  "${PSQL[@]}" <<'SQL'
SET ROLE service_role;
INSERT INTO public.posts (id, author_id, visibility, status, comment_count)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6',
  '11111111-1111-1111-1111-111111111111',
  'public',
  'active',
  0
);
INSERT INTO public.comments (id, post_id, user_id, author_id, content)
VALUES (
  'e3000000-0000-0000-0000-000000000001',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6',
  '11111111-1111-1111-1111-111111111111',
  '11111111-1111-1111-1111-111111111111',
  'contract replay target'
);
DO $contract_write_boundary$
DECLARE
  v_reaction jsonb;
BEGIN
  IF NOT pg_catalog.has_table_privilege('service_role', 'public.comments', 'INSERT')
     OR pg_catalog.has_table_privilege('service_role', 'public.comments', 'UPDATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.comments', 'DELETE')
     OR pg_catalog.has_table_privilege('service_role', 'public.comment_likes', 'INSERT')
     OR pg_catalog.has_table_privilege('service_role', 'public.comment_likes', 'UPDATE')
     OR pg_catalog.has_table_privilege('service_role', 'public.comment_likes', 'DELETE') THEN
    RAISE EXCEPTION 'service_role table ACL does not match the comment contract';
  END IF;

  IF (SELECT comment_count FROM public.posts
      WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6') <> 1 THEN
    RAISE EXCEPTION 'clean contracted comment insert did not update the canonical post count';
  END IF;

  BEGIN
    UPDATE public.posts
    SET comment_count = 99
    WHERE id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6';
    RAISE EXCEPTION 'direct post comment counter update unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM <> 'direct post comment counter updates are disabled' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO public.posts (id, author_id, visibility, status, comment_count)
    VALUES (
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa7',
      '11111111-1111-1111-1111-111111111111',
      'public',
      'active',
      1
    );
    RAISE EXCEPTION 'post with a nonzero initial comment counter unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM <> 'new posts must start with a zero comment counter' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO public.comments (
      id, post_id, user_id, author_id, content, deleted_at
    ) VALUES (
      'e3000000-0000-0000-0000-000000000002',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6',
      '11111111-1111-1111-1111-111111111111',
      '11111111-1111-1111-1111-111111111111',
      'invalid hidden insert',
      clock_timestamp()
    );
    RAISE EXCEPTION 'comment with initial moderation state unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM <> 'new comments must start active without moderation metadata' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO public.comments (
      id, post_id, user_id, author_id, content, like_count
    ) VALUES (
      'e3000000-0000-0000-0000-000000000003',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6',
      '11111111-1111-1111-1111-111111111111',
      '11111111-1111-1111-1111-111111111111',
      'invalid counted insert',
      1
    );
    RAISE EXCEPTION 'comment with a nonzero initial reaction counter unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM <> 'new comments must start with zero reaction counters' THEN
        RAISE;
      END IF;
  END;

  SELECT public.toggle_comment_reaction(
    'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6',
    'e3000000-0000-0000-0000-000000000001',
    '22222222-2222-2222-2222-222222222222',
    'like'
  ) INTO STRICT v_reaction;

  IF v_reaction ->> 'action' IS DISTINCT FROM 'added'
     OR v_reaction ->> 'reaction' IS DISTINCT FROM 'like'
     OR (v_reaction ->> 'like_count')::integer IS DISTINCT FROM 1
     OR (v_reaction ->> 'dislike_count')::integer IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'canonical reaction did not cross the contracted boundary: %',
      v_reaction;
  END IF;
END
$contract_write_boundary$;
SELECT * FROM public.moderate_comment(
  'e3000000-0000-0000-0000-000000000001',
  NULL,
  'soft_delete',
  'Auto-hidden: integration proof'
);
RESET ROLE;
SQL

  "${PSQL[@]}" -f "$HIDDEN_DELETE_MIGRATION" >/dev/null

  "${PSQL[@]}" <<'SQL'
DO $contract_acl$
BEGIN
  IF pg_catalog.has_table_privilege('service_role', 'public.comments', 'DELETE')
     OR NOT pg_catalog.has_function_privilege(
       'service_role', 'public.delete_own_comment(uuid,uuid,uuid)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', 'public.delete_own_comment(uuid,uuid,uuid)', 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', 'public.delete_own_comment(uuid,uuid,uuid)', 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'contract replay widened the comment mutation boundary';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.comments'::regclass
      AND trigger_row.tgname = 'trg_comments_00_guard_canonical_mutation'
      AND trigger_row.tgfoid =
          'public.guard_canonical_comment_mutation()'::regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION '093000 replay removed or changed the contract guard';
  END IF;
END
$contract_acl$;

SET ROLE service_role;
DO $contract_hidden_delete$
DECLARE
  v_result record;
BEGIN
  SELECT * INTO STRICT v_result
  FROM public.delete_own_comment(
    p_comment_id => 'e3000000-0000-0000-0000-000000000001',
    p_post_id => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa6',
    p_user_id => '11111111-1111-1111-1111-111111111111'
  );

  IF v_result.deleted_count <> 1 OR v_result.comment_count <> 0 THEN
    RAISE EXCEPTION 'post-contract hidden delete ACK mismatch: %', row_to_json(v_result);
  END IF;
END
$contract_hidden_delete$;
RESET ROLE;
SQL
else
  echo "SKIP: set COMMENT_CONTRACT_MIGRATION to exercise 091500 -> 093000 -> 100000 -> 093000 replay"
fi

echo "PASS: hidden comment self-delete PostgreSQL 17 integration proof"
