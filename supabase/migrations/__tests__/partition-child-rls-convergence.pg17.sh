#!/usr/bin/env bash

# PostgreSQL 17 proof that partition children are private implementation
# details while parent-table reads/writes retain their intended semantics.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RANGE_GUARD="$ROOT_DIR/supabase/migrations/20260718133000_history_partition_range_guard.sql"
CONVERGENCE="$ROOT_DIR/supabase/migrations/20260718135000_partition_child_rls_convergence.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi
if ! rg -Uq \
  'LOCK TABLE[[:space:][:print:]]*IN SHARE UPDATE EXCLUSIVE MODE;' \
  "$CONVERGENCE"; then
  echo "convergence migration is missing its parent partition-DDL lock" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/partition-child-rls-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((58000 + ($$ % 7000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -160 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
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

psql_cmd -q <<'SQL'
CREATE ROLE postgres SUPERUSER NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role BYPASSRLS NOLOGIN;
CREATE ROLE legacy_reader NOLOGIN;
SET ROLE postgres;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role, legacy_reader;

CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL,
  payload text
) PARTITION BY RANGE (scraped_at);
CREATE TABLE arena.trader_series (
  ts timestamptz NOT NULL,
  payload text
) PARTITION BY RANGE (ts);
CREATE TABLE arena.position_history (
  closed_at timestamptz NOT NULL,
  payload text
) PARTITION BY RANGE (closed_at);
CREATE TABLE arena.order_records (
  ts timestamptz NOT NULL,
  payload text
) PARTITION BY RANGE (ts);
CREATE TABLE arena.transfer_history (
  ts timestamptz NOT NULL,
  payload text
) PARTITION BY RANGE (ts);
CREATE TABLE arena.copier_records (
  ts timestamptz NOT NULL,
  payload text
) PARTITION BY RANGE (ts);

ALTER TABLE arena.leaderboard_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.trader_series ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.position_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.order_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.transfer_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_records ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON
  arena.leaderboard_entries,
  arena.trader_series,
  arena.position_history,
  arena.order_records,
  arena.transfer_history
TO anon, authenticated;
GRANT ALL ON
  arena.leaderboard_entries,
  arena.trader_series,
  arena.position_history,
  arena.order_records,
  arena.transfer_history,
  arena.copier_records
TO service_role;

CREATE POLICY parent_public_leaderboard_entries ON arena.leaderboard_entries
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY parent_public_trader_series ON arena.trader_series
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY parent_public_position_history ON arena.position_history
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY parent_public_order_records ON arena.order_records
  FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY parent_public_transfer_history ON arena.transfer_history
  FOR SELECT TO anon, authenticated USING (true);

CREATE FUNCTION arena.ensure_month_partitions(
  parent_table text,
  months_ahead integer DEFAULT 2,
  months_back integer DEFAULT 0
)
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
AS $$ SELECT 0 $$;

DO $seed_exposed_children$
DECLARE
  v_month date := date_trunc('month', statement_timestamp())::date;
  v_parent text;
  v_key text;
  v_child text;
BEGIN
  FOR v_parent, v_key IN
    SELECT *
    FROM (
      VALUES
        ('leaderboard_entries', 'scraped_at'),
        ('trader_series', 'ts'),
        ('position_history', 'closed_at'),
        ('order_records', 'ts'),
        ('transfer_history', 'ts'),
        ('copier_records', 'ts')
    ) AS parents(parent_name, partition_key)
  LOOP
    v_child := format(
      '%s_y%sm%s',
      v_parent,
      to_char(v_month, 'YYYY'),
      to_char(v_month, 'MM')
    );
    EXECUTE format(
      'CREATE TABLE arena.%I PARTITION OF arena.%I FOR VALUES FROM (%L) TO (%L)',
      v_child,
      v_parent,
      v_month,
      (v_month + interval '1 month')::date
    );
    EXECUTE format(
      'GRANT ALL ON TABLE arena.%I TO PUBLIC, anon, authenticated, service_role, legacy_reader',
      v_child
    );
    EXECUTE format(
      'CREATE POLICY %I ON arena.%I FOR SELECT TO anon, authenticated USING (true)',
      'public_read_' || v_child,
      v_child
    );
  END LOOP;
END
$seed_exposed_children$;

DO $seed_nested_exposed_child$
DECLARE
  v_month date := (date_trunc('month', statement_timestamp()) - interval '3 months')::date;
BEGIN
  EXECUTE format(
    'CREATE TABLE arena.leaderboard_entries_nested PARTITION OF arena.leaderboard_entries
       FOR VALUES FROM (%L) TO (%L) PARTITION BY LIST (payload)',
    v_month,
    (v_month + interval '1 month')::date
  );
  CREATE TABLE arena.leaderboard_entries_nested_leaf
    PARTITION OF arena.leaderboard_entries_nested DEFAULT;
  GRANT ALL ON TABLE arena.leaderboard_entries_nested_leaf
    TO PUBLIC, anon, authenticated, service_role, legacy_reader;
  CREATE POLICY nested_public_read
    ON arena.leaderboard_entries_nested_leaf
    FOR SELECT TO anon, authenticated USING (true);
  EXECUTE format(
    'INSERT INTO arena.leaderboard_entries VALUES (%L, %L)',
    v_month + interval '1 day',
    'nested-public-row'
  );
END
$seed_nested_exposed_child$;

INSERT INTO arena.order_records VALUES (now(), 'public-parent-route');
INSERT INTO arena.copier_records VALUES (now(), 'private-parent-route');
SQL

# Install the already-committed range guard first. Its CONTINUE path deliberately
# reproduces the bug by leaving the six pre-existing current-month children open.
psql_cmd -q -f "$RANGE_GUARD"

CURRENT_SUFFIX="$(psql_cmd -Atqc "SELECT to_char(now(), 'YYYY\"m\"MM')")"
ORDER_CHILD="arena.order_records_y${CURRENT_SUFFIX}"
COPIER_CHILD="arena.copier_records_y${CURRENT_SUFFIX}"

PRE_EXPOSURE="$(
  psql_cmd -Atqc "SET ROLE anon; SELECT count(*) FROM ${COPIER_CHILD};"
)"
if [[ "$PRE_EXPOSURE" != "1" ]]; then
  echo "pre-migration copier child exposure was not reproduced: $PRE_EXPOSURE" >&2
  exit 1
fi

psql_cmd -q -f "$CONVERGENCE"

CATALOG_RESULT="$(
  psql_cmd -Atqc "
    WITH RECURSIVE roots(root_oid) AS (
      SELECT parent.oid
      FROM pg_catalog.pg_class AS parent
      JOIN pg_catalog.pg_namespace AS parent_schema
        ON parent_schema.oid = parent.relnamespace
      WHERE parent_schema.nspname = 'arena'
        AND parent.relname IN (
          'leaderboard_entries',
          'trader_series',
          'position_history',
          'order_records',
          'transfer_history',
          'copier_records'
        )
    ),
    descendants(relid) AS (
      SELECT inheritance.inhrelid
      FROM roots
      JOIN pg_catalog.pg_inherits AS inheritance
        ON inheritance.inhparent = roots.root_oid
      UNION ALL
      SELECT inheritance.inhrelid
      FROM descendants
      JOIN pg_catalog.pg_inherits AS inheritance
        ON inheritance.inhparent = descendants.relid
    ),
    children AS (
      SELECT child.oid, child.relowner, child.relrowsecurity
      FROM descendants
      JOIN pg_catalog.pg_class AS child
        ON child.oid = descendants.relid
    )
    SELECT
      (SELECT count(*) FROM children WHERE NOT relrowsecurity) || '|' ||
      (
        SELECT count(*)
        FROM children
        WHERE relowner <> 'postgres'::regrole::oid
      ) || '|' ||
      (
        SELECT count(DISTINCT children.oid)
        FROM children
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            (SELECT relation.relacl FROM pg_catalog.pg_class AS relation
             WHERE relation.oid = children.oid),
            pg_catalog.acldefault('r', children.relowner)
          )
        ) AS privilege
        WHERE privilege.grantee <> children.relowner
      ) || '|' ||
      (
        SELECT count(*)
        FROM children
        JOIN pg_catalog.pg_policy AS policy
          ON policy.polrelid = children.oid
      );
  "
)"
if [[ "$CATALOG_RESULT" != "0|0|0|0" ]]; then
  echo "partition catalog did not converge: $CATALOG_RESULT" >&2
  exit 1
fi

if psql_cmd -q -c \
  "SET ROLE anon; SELECT count(*) FROM ${COPIER_CHILD};" \
  >"$TMP_ROOT/anon-child.log" 2>&1; then
  echo "anon retained direct copier child access" >&2
  exit 1
fi
if ! rg -q 'permission denied for table copier_records_' "$TMP_ROOT/anon-child.log"; then
  cat "$TMP_ROOT/anon-child.log" >&2
  exit 1
fi
if psql_cmd -q -c \
  "SET ROLE anon; SELECT count(*) FROM arena.leaderboard_entries_nested_leaf;" \
  >"$TMP_ROOT/anon-nested-child.log" 2>&1; then
  echo "anon retained direct nested-child access" >&2
  exit 1
fi
if ! rg -q 'permission denied for table leaderboard_entries_nested_leaf' \
  "$TMP_ROOT/anon-nested-child.log"; then
  cat "$TMP_ROOT/anon-nested-child.log" >&2
  exit 1
fi
NESTED_PARENT_RESULT="$(
  psql_cmd -Atqc "
    SET ROLE anon;
    SELECT count(*)
    FROM arena.leaderboard_entries
    WHERE payload = 'nested-public-row';
  "
)"
if [[ "$NESTED_PARENT_RESULT" != "1" ]]; then
  echo "anon recursive parent read stopped routing: $NESTED_PARENT_RESULT" >&2
  exit 1
fi

PUBLIC_PARENT_RESULT="$(
  psql_cmd -Atqc "SET ROLE anon; SELECT count(*) FROM arena.order_records;"
)"
if [[ "$PUBLIC_PARENT_RESULT" != "1" ]]; then
  echo "anon parent read stopped routing after child convergence: $PUBLIC_PARENT_RESULT" >&2
  exit 1
fi

SERVICE_PARENT_RESULT="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    INSERT INTO arena.copier_records VALUES (now(), 'service-parent-route');
    SELECT count(*) FROM arena.copier_records;
  "
)"
if [[ "$SERVICE_PARENT_RESULT" != "2" ]]; then
  echo "service_role parent write/read stopped routing: $SERVICE_PARENT_RESULT" >&2
  exit 1
fi
if psql_cmd -q -c \
  "SET ROLE service_role; SELECT count(*) FROM ${COPIER_CHILD};" \
  >"$TMP_ROOT/service-child.log" 2>&1; then
  echo "service_role retained unnecessary direct child access" >&2
  exit 1
fi

# Re-expose an attached child, then prove the helper's existing-child path
# converges it instead of returning early.
psql_cmd -q -c "
  ALTER TABLE ${ORDER_CHILD} DISABLE ROW LEVEL SECURITY;
  GRANT SELECT ON ${ORDER_CHILD} TO anon, legacy_reader;
  CREATE POLICY reexposed_order_child ON ${ORDER_CHILD}
    FOR SELECT TO anon USING (true);
  SELECT arena.ensure_month_partitions('order_records', 2, 0);
"
EXISTING_RESULT="$(
  psql_cmd -Atqc "
    SELECT
      relation.relrowsecurity || '|' ||
      (
        SELECT count(*)
        FROM pg_catalog.aclexplode(
          COALESCE(
            relation.relacl,
            pg_catalog.acldefault('r', relation.relowner)
          )
        ) AS privilege
        WHERE privilege.grantee <> relation.relowner
      ) || '|' ||
      (
        SELECT count(*)
        FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = relation.oid
      )
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = '${ORDER_CHILD}'::regclass;
  "
)"
if [[ "$EXISTING_RESULT" != "true|0|0" ]]; then
  echo "existing child helper path did not converge: $EXISTING_RESULT" >&2
  exit 1
fi

# Prove the new-child path creates and hardens an older required history month.
TARGET_SUFFIX="$(
  psql_cmd -Atqc "SELECT to_char(now() - interval '18 months', 'YYYY\"m\"MM')"
)"
TARGET_CHILD="arena.transfer_history_y${TARGET_SUFFIX}"
if [[ "$(psql_cmd -Atqc "SELECT to_regclass('${TARGET_CHILD}') IS NULL")" != "t" ]]; then
  echo "target history child unexpectedly existed before the new-child proof" >&2
  exit 1
fi
psql_cmd -q -c "
  SELECT arena.ensure_history_partitions(
    'transfer_history',
    ARRAY[now() - interval '18 months']::timestamptz[]
  );
"
NEW_RESULT="$(
  psql_cmd -Atqc "
    SELECT
      relation.relrowsecurity || '|' ||
      (
        SELECT count(*)
        FROM pg_catalog.aclexplode(
          COALESCE(
            relation.relacl,
            pg_catalog.acldefault('r', relation.relowner)
          )
        ) AS privilege
        WHERE privilege.grantee <> relation.relowner
      ) || '|' ||
      (
        SELECT count(*)
        FROM pg_catalog.pg_policy AS policy
        WHERE policy.polrelid = relation.oid
      )
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = '${TARGET_CHILD}'::regclass;
  "
)"
if [[ "$NEW_RESULT" != "true|0|0" ]]; then
  echo "new child helper path did not converge: $NEW_RESULT" >&2
  exit 1
fi

echo "partition child RLS/ACL convergence PostgreSQL 17 proof passed"
