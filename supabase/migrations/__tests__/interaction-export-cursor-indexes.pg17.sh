#!/usr/bin/env bash

# PostgreSQL 17 proof for 2C interaction export cursor indexes. This script
# owns an isolated temporary cluster and never connects to a remote database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716101500_add_interaction_export_cursor_indexes.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/interaction-export-indexes-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((54000 + ($$ % 10000)))}"
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
CREATE TABLE public.notifications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  type text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  link text,
  read boolean DEFAULT false,
  actor_id uuid,
  reference_id uuid,
  created_at timestamptz DEFAULT now(),
  read_at timestamptz
);
CREATE TABLE public.comment_likes (
  id uuid PRIMARY KEY,
  comment_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz DEFAULT now(),
  reaction_type text NOT NULL,
  UNIQUE (comment_id, user_id)
);
CREATE TABLE public.post_emoji_reactions (
  id uuid PRIMARY KEY,
  post_id uuid NOT NULL,
  user_id uuid NOT NULL,
  emoji text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE (post_id, user_id, emoji)
);

-- Reproduce the relevant production owner and owner/time indexes. None can
-- both filter the authenticated owner and return the UUID cursor in order.
CREATE INDEX idx_notifications_user ON public.notifications (user_id);
CREATE INDEX idx_notifications_created
  ON public.notifications (user_id, created_at DESC);
CREATE INDEX idx_comment_likes_user ON public.comment_likes (user_id);
CREATE INDEX idx_post_emoji_reactions_user
  ON public.post_emoji_reactions (user_id);

INSERT INTO public.notifications (id, user_id, type, title, message, created_at)
SELECT
  md5('notification-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  'system',
  'title-' || value,
  'message-' || value,
  now() - make_interval(secs => value)
FROM generate_series(1, 6000) AS value;

INSERT INTO public.comment_likes
  (id, comment_id, user_id, reaction_type, created_at)
SELECT
  md5('comment-like-' || value)::uuid,
  md5('comment-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  'like',
  now() - make_interval(secs => value)
FROM generate_series(1, 6000) AS value;

INSERT INTO public.post_emoji_reactions
  (id, post_id, user_id, emoji, created_at)
SELECT
  md5('post-reaction-' || value)::uuid,
  md5('post-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  CASE WHEN value % 2 = 0 THEN 'thumbsup' ELSE 'heart' END,
  now() - make_interval(secs => value)
FROM generate_series(1, 6000) AS value;

ANALYZE public.notifications;
ANALYZE public.comment_likes;
ANALYZE public.post_emoji_reactions;
SQL

# Applying twice proves completed deployments are replay-safe. The second
# postflight still checks each real catalog definition after IF NOT EXISTS.
psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
SET enable_seqscan = off;
SET enable_bitmapscan = off;

DO $proof$
DECLARE
  v_table text;
  v_index text;
  v_plan json;
BEGIN
  FOR v_table, v_index IN
    SELECT expected.table_name, expected.index_name
    FROM (
      VALUES
        ('notifications', 'idx_notifications_export_user_id_id'),
        ('comment_likes', 'idx_comment_likes_export_user_id_id'),
        ('post_emoji_reactions', 'idx_post_emoji_reactions_export_user_id_id')
    ) AS expected(table_name, index_name)
  LOOP
    EXECUTE pg_catalog.format(
      'EXPLAIN (FORMAT JSON, COSTS OFF)
       SELECT * FROM public.%I
       WHERE user_id = %L::uuid
         AND id > %L::uuid
       ORDER BY id ASC LIMIT 1000',
      v_table,
      '11111111-1111-1111-1111-111111111111',
      '00000000-0000-0000-0000-000000000000'
    ) INTO v_plan;
    IF v_plan::text NOT LIKE '%' || v_index || '%' THEN
      RAISE EXCEPTION '% export did not use %: %', v_table, v_index, v_plan;
    END IF;
  END LOOP;
END
$proof$;
SQL

# IF NOT EXISTS must not hide a same-name index with reversed keys for any of
# the three datasets. Restore each correct definition before testing the next.
psql_cmd <<'SQL'
DROP INDEX public.idx_notifications_export_user_id_id;
CREATE INDEX idx_notifications_export_user_id_id
  ON public.notifications (id, user_id);
SQL

if psql_cmd -f "$MIGRATION" >/dev/null 2>&1; then
  echo "migration accepted a wrong notifications export index" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP INDEX public.idx_notifications_export_user_id_id;
CREATE INDEX idx_notifications_export_user_id_id
  ON public.notifications (user_id, id);
DROP INDEX public.idx_comment_likes_export_user_id_id;
CREATE INDEX idx_comment_likes_export_user_id_id
  ON public.comment_likes (id, user_id);
SQL

if psql_cmd -f "$MIGRATION" >/dev/null 2>&1; then
  echo "migration accepted a wrong comment_likes export index" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP INDEX public.idx_comment_likes_export_user_id_id;
CREATE INDEX idx_comment_likes_export_user_id_id
  ON public.comment_likes (user_id, id);
DROP INDEX public.idx_post_emoji_reactions_export_user_id_id;
CREATE INDEX idx_post_emoji_reactions_export_user_id_id
  ON public.post_emoji_reactions (id, user_id);
SQL

if psql_cmd -f "$MIGRATION" >/dev/null 2>&1; then
  echo "migration accepted a wrong post_emoji_reactions export index" >&2
  exit 1
fi
