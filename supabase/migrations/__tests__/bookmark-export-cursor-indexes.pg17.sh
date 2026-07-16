#!/usr/bin/env bash

# PostgreSQL 17 proof for bookmark export cursor indexes. This script owns an
# isolated temporary cluster and never connects to a developer or remote DB.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716094500_add_bookmark_export_cursor_indexes.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/bookmark-export-indexes-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55473
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
CREATE TABLE public.bookmark_folders (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE TABLE public.post_bookmarks (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  post_id uuid NOT NULL,
  folder_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (post_id, user_id)
);

-- Reproduce the relevant production indexes verified before this migration.
-- They filter by owner but cannot also provide the export's id ordering.
CREATE INDEX idx_bookmark_folders_user_id
  ON public.bookmark_folders (user_id);
CREATE INDEX idx_post_bookmarks_user_id
  ON public.post_bookmarks (user_id);

INSERT INTO public.bookmark_folders (id, user_id, name, created_at)
SELECT
  md5('folder-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  'folder-' || value,
  now() - make_interval(secs => value)
FROM generate_series(1, 4000) AS value;

INSERT INTO public.post_bookmarks (id, user_id, post_id, created_at)
SELECT
  md5('bookmark-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  md5('post-' || value)::uuid,
  now() - make_interval(secs => value)
FROM generate_series(1, 4000) AS value;

ANALYZE public.bookmark_folders;
ANALYZE public.post_bookmarks;
SQL

# Applying twice proves completed deployments are replay-safe. The postflight
# checks the actual catalog definition after IF NOT EXISTS skips each rebuild.
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
    SELECT * FROM public.bookmark_folders
    WHERE user_id = '11111111-1111-1111-1111-111111111111'
      AND id > '00000000-0000-0000-0000-000000000000'
    ORDER BY id ASC LIMIT 1000
  $query$ INTO v_plan;
  IF v_plan::text NOT LIKE '%idx_bookmark_folders_export_user_id_id%' THEN
    RAISE EXCEPTION 'bookmark folders export did not use its owner/id index: %', v_plan;
  END IF;

  EXECUTE $query$
    EXPLAIN (FORMAT JSON, COSTS OFF)
    SELECT * FROM public.post_bookmarks
    WHERE user_id = '11111111-1111-1111-1111-111111111111'
      AND id > '00000000-0000-0000-0000-000000000000'
    ORDER BY id ASC LIMIT 1000
  $query$ INTO v_plan;
  IF v_plan::text NOT LIKE '%idx_post_bookmarks_export_user_id_id%' THEN
    RAISE EXCEPTION 'post bookmarks export did not use its owner/id index: %', v_plan;
  END IF;
END
$proof$;
SQL

# Prove IF NOT EXISTS cannot hide a same-name index with reversed keys for
# either dataset. Restore the first correct definition before testing the next.
psql_cmd <<'SQL'
DROP INDEX public.idx_bookmark_folders_export_user_id_id;
CREATE INDEX idx_bookmark_folders_export_user_id_id
  ON public.bookmark_folders (id, user_id);
SQL

if psql_cmd -f "$MIGRATION" >/dev/null 2>&1; then
  echo "migration accepted a wrong bookmark_folders export index" >&2
  exit 1
fi

psql_cmd <<'SQL'
DROP INDEX public.idx_bookmark_folders_export_user_id_id;
CREATE INDEX idx_bookmark_folders_export_user_id_id
  ON public.bookmark_folders (user_id, id);
DROP INDEX public.idx_post_bookmarks_export_user_id_id;
CREATE INDEX idx_post_bookmarks_export_user_id_id
  ON public.post_bookmarks (id, user_id);
SQL

if psql_cmd -f "$MIGRATION" >/dev/null 2>&1; then
  echo "migration accepted a wrong post_bookmarks export index" >&2
  exit 1
fi
