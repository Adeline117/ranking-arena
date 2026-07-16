#!/usr/bin/env bash

# PostgreSQL 17 proof for 2C domain export cursor indexes. This script owns an
# isolated temporary cluster and never connects to a developer or remote DB.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716110000_add_domain_export_cursor_indexes.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/domain-export-indexes-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((56000 + ($$ % 9000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
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
CREATE TABLE public.group_members (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'member',
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE public.group_subscriptions (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.group_applications (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  applicant_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.trader_alerts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  trader_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, trader_id)
);
CREATE TABLE public.user_collections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.collection_items (
  id uuid PRIMARY KEY,
  collection_id uuid NOT NULL,
  item_type text NOT NULL,
  item_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (collection_id, item_type, item_id)
);

-- Reproduce adjacent production-style owner and owner/time indexes. None can
-- both constrain the export boundary and return its UUID cursor in order.
CREATE INDEX idx_group_members_user ON public.group_members (user_id);
CREATE INDEX idx_group_subscriptions_user
  ON public.group_subscriptions (user_id);
CREATE INDEX idx_group_applications_applicant
  ON public.group_applications (applicant_id);
CREATE INDEX idx_trader_alerts_user ON public.trader_alerts (user_id);
CREATE INDEX idx_user_collections_user_created
  ON public.user_collections (user_id, created_at DESC);
CREATE INDEX idx_collection_items_collection
  ON public.collection_items (collection_id);

INSERT INTO public.group_members (group_id, user_id, joined_at)
SELECT
  md5('member-group-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  now() - make_interval(secs => value)
FROM generate_series(1, 6000) AS value;

INSERT INTO public.group_subscriptions (id, group_id, user_id, created_at)
SELECT
  md5('subscription-' || value)::uuid,
  md5('subscription-group-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  now() - make_interval(secs => value)
FROM generate_series(1, 6000) AS value;

INSERT INTO public.group_applications (id, group_id, applicant_id, created_at)
SELECT
  md5('application-' || value)::uuid,
  md5('application-group-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  now() - make_interval(secs => value)
FROM generate_series(1, 6000) AS value;

INSERT INTO public.trader_alerts (id, user_id, trader_id, created_at)
SELECT
  md5('alert-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  'trader-' || value,
  now() - make_interval(secs => value)
FROM generate_series(1, 6000) AS value;

INSERT INTO public.user_collections (id, user_id, name, created_at)
SELECT
  md5('collection-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '11111111-1111-1111-1111-111111111111'::uuid
    ELSE '22222222-2222-2222-2222-222222222222'::uuid
  END,
  'collection-' || value,
  now() - make_interval(secs => value)
FROM generate_series(1, 6000) AS value;

INSERT INTO public.collection_items
  (id, collection_id, item_type, item_id, created_at)
SELECT
  md5('collection-item-' || value)::uuid,
  CASE WHEN value % 2 = 0
    THEN '33333333-3333-3333-3333-333333333333'::uuid
    ELSE '44444444-4444-4444-4444-444444444444'::uuid
  END,
  'post',
  'item-' || value,
  now() - make_interval(secs => value)
FROM generate_series(1, 6000) AS value;

ANALYZE public.group_members;
ANALYZE public.group_subscriptions;
ANALYZE public.group_applications;
ANALYZE public.trader_alerts;
ANALYZE public.user_collections;
ANALYZE public.collection_items;
SQL

# Applying twice proves completed deployments are replay-safe. The second
# postflight still verifies each catalog definition after IF NOT EXISTS.
psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
SET enable_seqscan = off;
SET enable_bitmapscan = off;

DO $proof$
DECLARE
  v_table text;
  v_index text;
  v_owner_column text;
  v_cursor_column text;
  v_owner_value uuid;
  v_plan json;
BEGIN
  FOR v_table, v_index, v_owner_column, v_cursor_column, v_owner_value IN
    SELECT
      expected.table_name,
      expected.index_name,
      expected.owner_column,
      expected.cursor_column,
      expected.owner_value
    FROM (
      VALUES
        (
          'group_members',
          'idx_group_members_export_user_id_group_id',
          'user_id',
          'group_id',
          '11111111-1111-1111-1111-111111111111'::uuid
        ),
        (
          'group_subscriptions',
          'idx_group_subscriptions_export_user_id_id',
          'user_id',
          'id',
          '11111111-1111-1111-1111-111111111111'::uuid
        ),
        (
          'group_applications',
          'idx_group_applications_export_applicant_id_id',
          'applicant_id',
          'id',
          '11111111-1111-1111-1111-111111111111'::uuid
        ),
        (
          'trader_alerts',
          'idx_trader_alerts_export_user_id_id',
          'user_id',
          'id',
          '11111111-1111-1111-1111-111111111111'::uuid
        ),
        (
          'user_collections',
          'idx_user_collections_export_user_id_id',
          'user_id',
          'id',
          '11111111-1111-1111-1111-111111111111'::uuid
        ),
        (
          'collection_items',
          'idx_collection_items_export_collection_id_id',
          'collection_id',
          'id',
          '33333333-3333-3333-3333-333333333333'::uuid
        )
    ) AS expected(
      table_name,
      index_name,
      owner_column,
      cursor_column,
      owner_value
    )
  LOOP
    EXECUTE pg_catalog.format(
      'EXPLAIN (FORMAT JSON, COSTS OFF)
       SELECT * FROM public.%I
       WHERE %I = %L::uuid
         AND %I > %L::uuid
       ORDER BY %I ASC LIMIT 1000',
      v_table,
      v_owner_column,
      v_owner_value,
      v_cursor_column,
      '00000000-0000-0000-0000-000000000000',
      v_cursor_column
    ) INTO v_plan;
    IF v_plan::text NOT LIKE '%' || v_index || '%' THEN
      RAISE EXCEPTION '% export did not use %: %', v_table, v_index, v_plan;
    END IF;
  END LOOP;
END
$proof$;
SQL

# IF NOT EXISTS must not hide a same-name index with reversed keys for any of
# the six datasets. Restore each correct definition before testing the next.
wrong_index_cases=(
  'group_members:idx_group_members_export_user_id_group_id:user_id:group_id'
  'group_subscriptions:idx_group_subscriptions_export_user_id_id:user_id:id'
  'group_applications:idx_group_applications_export_applicant_id_id:applicant_id:id'
  'trader_alerts:idx_trader_alerts_export_user_id_id:user_id:id'
  'user_collections:idx_user_collections_export_user_id_id:user_id:id'
  'collection_items:idx_collection_items_export_collection_id_id:collection_id:id'
)

for index_case in "${wrong_index_cases[@]}"; do
  IFS=':' read -r table_name index_name owner_column cursor_column <<<"$index_case"

  psql_cmd <<SQL
DROP INDEX public.$index_name;
CREATE INDEX $index_name
  ON public.$table_name ($cursor_column, $owner_column);
SQL

  if psql_cmd -f "$MIGRATION" >/dev/null 2>&1; then
    echo "migration accepted a wrong $table_name export index" >&2
    exit 1
  fi

  psql_cmd <<SQL
DROP INDEX public.$index_name;
CREATE INDEX $index_name
  ON public.$table_name ($owner_column, $cursor_column);
SQL
done
