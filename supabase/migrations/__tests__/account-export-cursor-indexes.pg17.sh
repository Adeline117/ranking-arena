#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the account-export keyset indexes. It owns
# an isolated temporary cluster and never connects to a developer or remote DB.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716090000_add_account_export_cursor_indexes.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/export-cursor-indexes-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55469
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if (( exit_code != 0 )) && [[ -f "$LOG_FILE" ]]; then
    tail -120 "$LOG_FILE" >&2 || true
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
CREATE TABLE public.posts (
  id uuid PRIMARY KEY,
  author_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.comments (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.user_follows (
  id uuid PRIMARY KEY,
  follower_id uuid NOT NULL,
  following_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (follower_id, following_id)
);
CREATE TABLE public.tips (
  id uuid PRIMARY KEY,
  from_user_id uuid NOT NULL,
  to_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Reproduce the adjacent historical indexes. None can both constrain owner
-- and provide the export's id ordering.
CREATE INDEX idx_posts_author_created ON public.posts (author_id, created_at DESC);
CREATE INDEX idx_comments_created ON public.comments (created_at);
CREATE INDEX idx_user_follows_follower_created
  ON public.user_follows (follower_id, created_at DESC);
CREATE INDEX idx_user_follows_following ON public.user_follows (following_id);
CREATE INDEX idx_tips_from_user ON public.tips (from_user_id, created_at DESC);
CREATE INDEX idx_tips_to_user ON public.tips (to_user_id, created_at DESC);

INSERT INTO public.posts (id, author_id, created_at)
SELECT
  md5('post-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  now() - make_interval(secs => value)
FROM generate_series(1, 4000) AS value;

INSERT INTO public.comments (id, user_id, created_at)
SELECT
  md5('comment-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  now() - make_interval(secs => value)
FROM generate_series(1, 4000) AS value;

INSERT INTO public.user_follows (id, follower_id, following_id, created_at)
SELECT
  md5('follow-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  md5('follow-target-' || value)::uuid,
  now() - make_interval(secs => value)
FROM generate_series(1, 4000) AS value;

INSERT INTO public.tips (id, from_user_id, to_user_id, created_at)
SELECT
  md5('tip-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  CASE WHEN value % 3 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  now() - make_interval(secs => value)
FROM generate_series(1, 4000) AS value;

ANALYZE public.posts;
ANALYZE public.comments;
ANALYZE public.user_follows;
ANALYZE public.tips;
SQL

# Applying twice proves a completed deployment is replay-safe. The second run
# emits PostgreSQL's "already exists" notices and the catalog postflight still
# verifies the actual definitions.
psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
SET enable_seqscan = off;
SET enable_bitmapscan = off;

DO $proof$
DECLARE
  v_plan json;
BEGIN
  EXECUTE $query$
    EXPLAIN (FORMAT JSON, COSTS OFF)
    SELECT * FROM public.posts
    WHERE author_id = '11111111-1111-1111-1111-111111111111'
      AND id > '00000000-0000-0000-0000-000000000000'
    ORDER BY id ASC LIMIT 1000
  $query$ INTO v_plan;
  IF v_plan::text NOT LIKE '%idx_posts_export_author_id_id%' THEN
    RAISE EXCEPTION 'posts export did not use its owner/id cursor index: %', v_plan;
  END IF;

  EXECUTE $query$
    EXPLAIN (FORMAT JSON, COSTS OFF)
    SELECT * FROM public.comments
    WHERE user_id = '11111111-1111-1111-1111-111111111111'
      AND id > '00000000-0000-0000-0000-000000000000'
    ORDER BY id ASC LIMIT 1000
  $query$ INTO v_plan;
  IF v_plan::text NOT LIKE '%idx_comments_export_user_id_id%' THEN
    RAISE EXCEPTION 'comments export did not use its owner/id cursor index: %', v_plan;
  END IF;

  EXECUTE $query$
    EXPLAIN (FORMAT JSON, COSTS OFF)
    SELECT * FROM public.user_follows
    WHERE follower_id = '11111111-1111-1111-1111-111111111111'
      AND id > '00000000-0000-0000-0000-000000000000'
    ORDER BY id ASC LIMIT 1000
  $query$ INTO v_plan;
  IF v_plan::text NOT LIKE '%idx_user_follows_export_follower_id_id%' THEN
    RAISE EXCEPTION 'following export did not use its owner/id cursor index: %', v_plan;
  END IF;

  EXECUTE $query$
    EXPLAIN (FORMAT JSON, COSTS OFF)
    SELECT * FROM public.user_follows
    WHERE following_id = '11111111-1111-1111-1111-111111111111'
      AND id > '00000000-0000-0000-0000-000000000000'
    ORDER BY id ASC LIMIT 1000
  $query$ INTO v_plan;
  IF v_plan::text NOT LIKE '%idx_user_follows_export_following_id_id%' THEN
    RAISE EXCEPTION 'followers export did not use its owner/id cursor index: %', v_plan;
  END IF;

  EXECUTE $query$
    EXPLAIN (FORMAT JSON, COSTS OFF)
    SELECT * FROM public.tips
    WHERE from_user_id = '11111111-1111-1111-1111-111111111111'
      AND id > '00000000-0000-0000-0000-000000000000'
    ORDER BY id ASC LIMIT 1000
  $query$ INTO v_plan;
  IF v_plan::text NOT LIKE '%idx_tips_export_from_user_id_id%' THEN
    RAISE EXCEPTION 'sent tips export did not use its owner/id cursor index: %', v_plan;
  END IF;

  EXECUTE $query$
    EXPLAIN (FORMAT JSON, COSTS OFF)
    SELECT * FROM public.tips
    WHERE to_user_id = '11111111-1111-1111-1111-111111111111'
      AND id > '00000000-0000-0000-0000-000000000000'
    ORDER BY id ASC LIMIT 1000
  $query$ INTO v_plan;
  IF v_plan::text NOT LIKE '%idx_tips_export_to_user_id_id%' THEN
    RAISE EXCEPTION 'received tips export did not use its owner/id cursor index: %', v_plan;
  END IF;
END
$proof$;
SQL

# A same-name object is not sufficient for IF NOT EXISTS. Prove the catalog
# postflight rejects a definition that cannot serve the recipient cursor.
psql_cmd <<'SQL'
DROP INDEX public.idx_tips_export_to_user_id_id;
CREATE INDEX idx_tips_export_to_user_id_id ON public.tips (id, to_user_id);
SQL

if psql_cmd -f "$MIGRATION" >/dev/null 2>&1; then
  echo "migration accepted a same-name export index with the wrong key order" >&2
  exit 1
fi
