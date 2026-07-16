#!/usr/bin/env bash

# PostgreSQL 17 proof for the six account-security export cursor indexes. This
# script owns an isolated temporary cluster and never touches a remote database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716091500_add_security_export_cursor_indexes.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/security-export-indexes-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55470
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
DO $schema$
DECLARE
  v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'login_sessions',
    'api_keys',
    'user_passkeys',
    'push_subscriptions',
    'backup_codes',
    'account_recovery_tokens'
  ]
  LOOP
    EXECUTE pg_catalog.format(
      'CREATE TABLE public.%I (
         id uuid PRIMARY KEY,
         user_id uuid NOT NULL,
         created_at timestamptz NOT NULL DEFAULT now()
       )',
      v_table
    );
    EXECUTE pg_catalog.format(
      'CREATE INDEX %I ON public.%I (user_id, created_at DESC)',
      'idx_' || v_table || '_historical_owner_time',
      v_table
    );
    EXECUTE pg_catalog.format(
      'INSERT INTO public.%I (id, user_id, created_at)
       SELECT md5(%L || value)::uuid,
              CASE WHEN value %% 2 = 0
                THEN %L::uuid ELSE %L::uuid END,
              now() - make_interval(secs => value)
       FROM generate_series(1, 4000) AS value',
      v_table,
      v_table || '-',
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222'
    );
    EXECUTE pg_catalog.format('ANALYZE public.%I', v_table);
  END LOOP;
END
$schema$;
SQL

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
        ('login_sessions', 'idx_login_sessions_export_user_id_id'),
        ('api_keys', 'idx_api_keys_export_user_id_id'),
        ('user_passkeys', 'idx_user_passkeys_export_user_id_id'),
        ('push_subscriptions', 'idx_push_subscriptions_export_user_id_id'),
        ('backup_codes', 'idx_backup_codes_export_user_id_id'),
        ('account_recovery_tokens', 'idx_account_recovery_tokens_export_user_id_id')
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

# IF NOT EXISTS must not hide a same-name index with reversed keys.
psql_cmd <<'SQL'
DROP INDEX public.idx_account_recovery_tokens_export_user_id_id;
CREATE INDEX idx_account_recovery_tokens_export_user_id_id
  ON public.account_recovery_tokens (id, user_id);
SQL

if psql_cmd -f "$MIGRATION" >/dev/null 2>&1; then
  echo "migration accepted a same-name security export index with the wrong key order" >&2
  exit 1
fi
