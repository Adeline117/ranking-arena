#!/usr/bin/env bash

# PostgreSQL 17 behavior proof for the immutable legacy
# public.trader_position_history relation family.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260804044000_freeze_legacy_position_history_relations.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi
if [[ ! -f "$MIGRATION" ]]; then
  echo "Migration not found: $MIGRATION" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/legacy-position-history-freeze-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((63000 + ($$ % 1500)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    echo "[legacy-history-freeze] PostgreSQL log tail:" >&2
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

expect_failure_contains() {
  local label="$1"
  local needle="$2"
  local sql="$3"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "[legacy-history-freeze] Expected failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[legacy-history-freeze] Unexpected failure for $label" >&2
    sed -n '1,180p' "$failure_log" >&2
    exit 1
  fi
}

wait_for_sql_true() {
  local label="$1"
  local sql="$2"
  local attempt
  local result
  for attempt in $(seq 1 500); do
    result="$(psql_cmd -Atq -c "$sql")"
    if [[ "$result" == "t" ]]; then
      return 0
    fi
    sleep 0.01
  done
  echo "[legacy-history-freeze] Timed out waiting for: $label" >&2
  return 1
}

apply_migration() {
  psql_cmd -q -f "$MIGRATION"
}

identity_digest() {
  psql_cmd -Atq <<'SQL'
WITH identities AS (
  SELECT
    'relation:' || relation.oid::text || ':' || namespace_row.nspname || '.' ||
      relation.relname || ':' || relation.relkind::text || ':' ||
      relation.relrowsecurity::text || ':' || relation.relforcerowsecurity::text || ':' ||
      COALESCE(relation.relacl::text, '<null>') AS identity
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = relation.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND (
      relation.relname IN (
        'trader_position_history',
        'trader_position_history_partitioned',
        'trader_position_history_old'
      )
      OR relation.relname LIKE 'tph\_%' ESCAPE '\'
    )
    AND relation.relkind IN ('r', 'p')
  UNION ALL
  SELECT
    'trigger:' || trigger_row.oid::text || ':' || trigger_row.tgrelid::text || ':' ||
      trigger_row.tgname || ':' || trigger_row.tgfoid::text || ':' ||
      trigger_row.tgtype::text || ':' || trigger_row.tgenabled::text || ':' ||
      trigger_row.tgparentid::text
  FROM pg_catalog.pg_trigger AS trigger_row
  WHERE trigger_row.tgname IN (
    'reject_legacy_position_history_before_write',
    'reject_legacy_position_history_before_truncate'
  )
  UNION ALL
  SELECT
    'policy:' || policy.oid::text || ':' || policy.polrelid::text || ':' ||
      policy.polname || ':' || policy.polroles::text || ':' ||
      pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polname = 'legacy_position_history_operator_read'
  UNION ALL
  SELECT
    'function:' || function_row.oid::text || ':' ||
      function_row.oid::pg_catalog.regprocedure::text || ':' ||
      pg_catalog.encode(
        pg_catalog.sha256(
          pg_catalog.convert_to(
            pg_catalog.pg_get_functiondef(function_row.oid),
            'UTF8'
          )
        ),
        'hex'
      ) || ':' || COALESCE(function_row.proacl::text, '<null>') || ':' ||
      COALESCE(
        pg_catalog.obj_description(function_row.oid, 'pg_proc'),
        '<null>'
      )
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid IN (
    pg_catalog.to_regprocedure(
      'public.reject_legacy_position_history_mutation()'
    ),
    pg_catalog.to_regprocedure('public.create_next_tph_partition()')
  )
)
SELECT pg_catalog.encode(
  pg_catalog.sha256(
    pg_catalog.convert_to(
      pg_catalog.string_agg(identities.identity, '|' ORDER BY identities.identity),
      'UTF8'
    )
  ),
  'hex'
)
FROM identities;
SQL
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth=trust --username=postgres >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -k $SOCKET_DIR -p $PORT" -w start >/dev/null

echo "[legacy-history-freeze] build side-by-side/manual-cutover fixture"
psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE fixture_writer NOLOGIN;
CREATE ROLE fixture_delegate NOLOGIN;
CREATE ROLE fixture_column_reader NOLOGIN;
GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role,
     fixture_writer, fixture_delegate, fixture_column_reader;

CREATE TABLE public.trader_position_history (
  id bigint GENERATED ALWAYS AS IDENTITY,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.trader_position_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read trader_position_history"
  ON public.trader_position_history FOR SELECT USING (true);
CREATE POLICY trader_position_history_insert_service_role
  ON public.trader_position_history FOR INSERT TO service_role WITH CHECK (true);

CREATE TABLE public.trader_position_history_partitioned (
  id bigint GENERATED ALWAYS AS IDENTITY,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (created_at);
ALTER TABLE public.trader_position_history_partitioned ENABLE ROW LEVEL SECURITY;
CREATE POLICY public_read ON public.trader_position_history_partitioned
  FOR SELECT USING (true);

CREATE TABLE public.tph_archive
  PARTITION OF public.trader_position_history_partitioned
  FOR VALUES FROM (MINVALUE) TO ('2026-01-01');
CREATE TABLE public.tph_2026_01
  PARTITION OF public.trader_position_history_partitioned
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE public.tph_2026_12
  PARTITION OF public.trader_position_history_partitioned
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');
CREATE TABLE public.tph_orphan (
  id bigint,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  symbol text NOT NULL,
  direction text NOT NULL,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);

GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.trader_position_history,
           public.trader_position_history_partitioned
  TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.tph_archive,
           public.tph_2026_01,
           public.tph_2026_12,
           public.tph_orphan
  TO anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tph_2026_01
  TO fixture_writer WITH GRANT OPTION;
SET ROLE fixture_writer;
GRANT INSERT, UPDATE ON public.tph_2026_01 TO fixture_delegate;
RESET ROLE;
GRANT SELECT (source, source_trader_id), UPDATE (symbol)
  ON public.tph_2026_01 TO fixture_column_reader;

INSERT INTO public.trader_position_history (
  source, source_trader_id, symbol, direction, captured_at, created_at
) VALUES (
  'binance_futures', 'flat-seed', 'BTCUSDT', 'long',
  '2026-01-10T00:00:00Z', '2026-01-10T00:00:00Z'
);
INSERT INTO public.trader_position_history_partitioned (
  source, source_trader_id, symbol, direction, captured_at, created_at
) VALUES (
  'binance_futures', 'child-seed', 'ETHUSDT', 'short',
  '2026-01-11T00:00:00Z', '2026-01-11T00:00:00Z'
);
INSERT INTO public.tph_orphan (
  id, source, source_trader_id, symbol, direction, captured_at, created_at
) VALUES (
  1, 'binance_futures', 'orphan-seed', 'SOLUSDT', 'long',
  '2026-01-12T00:00:00Z', '2026-01-12T00:00:00Z'
);

CREATE OR REPLACE FUNCTION public.create_next_tph_partition()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  next_month date;
  partition_name text;
  start_date text;
  end_date text;
BEGIN
  next_month := date_trunc('month', now()) + interval '2 months';
  partition_name := 'tph_' || to_char(next_month, 'YYYY_MM');
  start_date := to_char(next_month, 'YYYY-MM-DD');
  end_date := to_char(next_month + interval '1 month', 'YYYY-MM-DD');

  -- Check if partition already exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = partition_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF trader_position_history_partitioned FOR VALUES FROM (%L) TO (%L)',
      partition_name, start_date, end_date
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO postgres, service_role, authenticated, anon',
      partition_name
    );
    RAISE NOTICE 'Created partition: %', partition_name;
  END IF;
END;
$$;
ALTER FUNCTION public.create_next_tph_partition()
  SET search_path = public, pg_temp;
GRANT EXECUTE ON FUNCTION public.create_next_tph_partition()
  TO anon, authenticated, service_role, fixture_writer WITH GRANT OPTION;
SET ROLE fixture_writer;
GRANT EXECUTE ON FUNCTION public.create_next_tph_partition()
  TO fixture_delegate;
RESET ROLE;

CREATE FUNCTION public.fixture_dynamic_legacy_history_insert(
  p_relation text,
  p_trader text,
  p_created_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  EXECUTE
    'INSERT INTO public.' || pg_catalog.quote_ident(p_relation) ||
    ' (source,source_trader_id,symbol,direction,captured_at,created_at)' ||
    ' VALUES ($1,$2,$3,$4,$5,$5)'
  USING
    'binance_futures'::text,
    p_trader,
    'XRPUSDT'::text,
    'long'::text,
    p_created_at;
END
$function$;
ALTER FUNCTION public.fixture_dynamic_legacy_history_insert(
  text, text, timestamptz
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.fixture_dynamic_legacy_history_insert(
  text, text, timestamptz
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fixture_dynamic_legacy_history_insert(
  text, text, timestamptz
) TO service_role;
SQL

psql_cmd -q -c \
  "SET ROLE anon; INSERT INTO public.tph_2026_01 (source,source_trader_id,symbol,direction,captured_at,created_at) VALUES ('binance_futures','anon-pre','ADAUSDT','long','2026-01-13','2026-01-13')"
psql_cmd -q -c \
  "SET ROLE service_role; SELECT public.fixture_dynamic_legacy_history_insert('tph_2026_01','wrapper-pre','2026-01-14')"

echo "[legacy-history-freeze] reject dangerous role/object/trigger drift"
psql_cmd -q -c \
  "GRANT service_role TO anon WITH INHERIT FALSE, SET TRUE"
expect_failure_contains \
  "public-service-membership" \
  "public application role can assume service_role" \
  "\\i $MIGRATION"
psql_cmd -q -c "REVOKE service_role FROM anon"

psql_cmd -q -c \
  "GRANT postgres TO service_role WITH INHERIT FALSE, SET TRUE"
expect_failure_contains \
  "service-owner-membership" \
  "application role can assume a superuser or legacy relation owner" \
  "\\i $MIGRATION"
psql_cmd -q -c "REVOKE postgres FROM service_role"

psql_cmd -q -c "GRANT CREATE ON SCHEMA public TO service_role"
expect_failure_contains \
  "runtime-public-schema-create" \
  "runtime application role can create in public schema" \
  "\\i $MIGRATION"
psql_cmd -q -c "REVOKE CREATE ON SCHEMA public FROM service_role"

psql_cmd -q -c "ALTER TABLE public.tph_orphan OWNER TO fixture_writer"
expect_failure_contains \
  "wrong-relation-owner" \
  "relation namespace, kind, or owner drifted" \
  "\\i $MIGRATION"
psql_cmd -q -c "ALTER TABLE public.tph_orphan OWNER TO postgres"

psql_cmd -q <<'SQL'
CREATE FUNCTION public.fixture_rogue_legacy_guard()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RETURN NEW;
END
$function$;
CREATE TRIGGER reject_legacy_position_history_before_write
BEFORE INSERT OR UPDATE OR DELETE ON public.tph_orphan
FOR EACH ROW EXECUTE FUNCTION public.fixture_rogue_legacy_guard();
SQL
expect_failure_contains \
  "rogue-existing-trigger" \
  "guard trigger exists without its function" \
  "\\i $MIGRATION"
psql_cmd -q <<'SQL'
DROP TRIGGER reject_legacy_position_history_before_write ON public.tph_orphan;
DROP FUNCTION public.fixture_rogue_legacy_guard();
SQL

psql_cmd -q <<'SQL'
ALTER FUNCTION public.create_next_tph_partition()
  RENAME TO fixture_saved_create_next_tph_partition;
CREATE FUNCTION public.create_next_tph_partition(p_month date)
RETURNS void
LANGUAGE plpgsql
AS $function$
BEGIN
  RETURN;
END
$function$;
SQL
expect_failure_contains \
  "single-wrong-signature-creator" \
  "partition creator overload set drifted" \
  "\\i $MIGRATION"
psql_cmd -q <<'SQL'
DROP FUNCTION public.create_next_tph_partition(date);
ALTER FUNCTION public.fixture_saved_create_next_tph_partition()
  RENAME TO create_next_tph_partition;
SQL

CREATOR_OID_BEFORE="$(psql_cmd -Atq -c \
  "SELECT 'public.create_next_tph_partition()'::regprocedure::oid")"

echo "[legacy-history-freeze] serialize a committing concurrent partition before discovery"
CONCURRENT_DDL_LOG="$TMP_ROOT/concurrent-partition-ddl.log"
CONCURRENT_MIGRATION_LOG="$TMP_ROOT/concurrent-partition-migration.log"
(
  psql_cmd -v VERBOSITY=verbose -q -c \
    "SET application_name = 'legacy-history-concurrent-partition-ddl';
     BEGIN;
     CREATE TABLE public.tph_2026_02
       PARTITION OF public.trader_position_history_partitioned
       FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
     SELECT pg_sleep(4);
     COMMIT"
) >"$CONCURRENT_DDL_LOG" 2>&1 &
CONCURRENT_DDL_PID=$!

wait_for_sql_true \
  "concurrent partition DDL owns the legacy parent" \
  "SELECT EXISTS (
     SELECT 1
     FROM pg_catalog.pg_stat_activity AS activity
     WHERE activity.application_name =
             'legacy-history-concurrent-partition-ddl'
       AND activity.wait_event = 'PgSleep'
       AND EXISTS (
         SELECT 1
         FROM pg_catalog.pg_locks AS relation_lock
         WHERE relation_lock.pid = activity.pid
           AND relation_lock.relation =
                 'public.trader_position_history_partitioned'::regclass
           AND relation_lock.granted
       )
   )"

(
  psql_cmd -v VERBOSITY=verbose -q \
    -c "SET application_name = 'legacy-history-concurrent-freeze'" \
    -f "$MIGRATION"
) >"$CONCURRENT_MIGRATION_LOG" 2>&1 &
CONCURRENT_MIGRATION_PID=$!

wait_for_sql_true \
  "freeze waits behind committing partition DDL" \
  "SELECT EXISTS (
     SELECT 1
     FROM pg_catalog.pg_stat_activity AS activity
     WHERE activity.application_name = 'legacy-history-concurrent-freeze'
       AND activity.wait_event_type = 'Lock'
       AND pg_catalog.cardinality(
             pg_catalog.pg_blocking_pids(activity.pid)
           ) > 0
   )"

if ! wait "$CONCURRENT_DDL_PID"; then
  echo "[legacy-history-freeze] concurrent partition DDL failed" >&2
  sed -n '1,180p' "$CONCURRENT_DDL_LOG" >&2
  exit 1
fi
if ! wait "$CONCURRENT_MIGRATION_PID"; then
  echo "[legacy-history-freeze] concurrent freeze failed" >&2
  sed -n '1,220p' "$CONCURRENT_MIGRATION_LOG" >&2
  exit 1
fi

CREATOR_OID_AFTER="$(psql_cmd -Atq -c \
  "SELECT 'public.create_next_tph_partition()'::regprocedure::oid")"
if [[ "$CREATOR_OID_BEFORE" != "$CREATOR_OID_AFTER" ]]; then
  echo "[legacy-history-freeze] partition creator OID changed" >&2
  exit 1
fi

psql_cmd -q <<'SQL'
DO $assertions$
DECLARE
  v_relation regclass;
  v_service oid := 'service_role'::regrole;
  v_postgres oid := 'postgres'::regrole;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.trader_position_history'::regclass,
    'public.trader_position_history_partitioned'::regclass,
    'public.tph_archive'::regclass,
    'public.tph_2026_01'::regclass,
    'public.tph_2026_02'::regclass,
    'public.tph_2026_12'::regclass,
    'public.tph_orphan'::regclass
  ]::regclass[]
  LOOP
    IF NOT has_table_privilege('service_role', v_relation, 'SELECT')
       OR has_table_privilege(
         'service_role', v_relation,
         'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
         'anon', v_relation,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       )
       OR has_table_privilege(
         'authenticated', v_relation,
         'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
       ) THEN
      RAISE EXCEPTION 'effective ACL is open for %', v_relation;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'RLS is not forced for %', v_relation;
    END IF;

    IF (SELECT count(*) FROM pg_policy WHERE polrelid = v_relation) <> 1
       OR NOT EXISTS (
         SELECT 1 FROM pg_policy AS policy
         WHERE policy.polrelid = v_relation
           AND policy.polname = 'legacy_position_history_operator_read'
           AND policy.polcmd = 'r'
           AND cardinality(policy.polroles) = 2
           AND policy.polroles @> ARRAY[v_service, v_postgres]::oid[]
           AND pg_get_expr(policy.polqual, policy.polrelid) = 'true'
       ) THEN
      RAISE EXCEPTION 'operator policy is not exact for %', v_relation;
    END IF;

    IF (SELECT count(*) FROM pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = v_relation
          AND trigger_row.tgname IN (
            'reject_legacy_position_history_before_write',
            'reject_legacy_position_history_before_truncate'
          )) <> 2 THEN
      RAISE EXCEPTION 'guard trigger count is not exact for %', v_relation;
    END IF;
  END LOOP;

  IF has_function_privilege(
       'anon', 'public.create_next_tph_partition()', 'EXECUTE'
     )
     OR has_function_privilege(
       'authenticated', 'public.create_next_tph_partition()', 'EXECUTE'
     )
     OR has_function_privilege(
       'service_role', 'public.create_next_tph_partition()', 'EXECUTE'
     )
     OR has_function_privilege(
       'service_role',
       'public.reject_legacy_position_history_mutation()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'retired functions retained application execute';
  END IF;

  IF has_schema_privilege('service_role', 'public', 'CREATE')
     OR has_schema_privilege('anon', 'public', 'CREATE')
     OR has_schema_privilege('authenticated', 'public', 'CREATE') THEN
    RAISE EXCEPTION 'runtime role retained public schema CREATE';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.tph_2026_01'::regclass
      AND attribute.attacl IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM aclexplode(attribute.attacl) AS acl_entry
        WHERE acl_entry.grantee <> 'postgres'::regrole
      )
  ) THEN
    RAISE EXCEPTION 'column ACL delegation survived';
  END IF;
END
$assertions$;
SQL

expect_failure_contains \
  "anon-direct-read" \
  "permission denied for table tph_2026_01" \
  "SET ROLE anon; SELECT * FROM public.tph_2026_01"
expect_failure_contains \
  "anon-direct-child-insert" \
  "permission denied for table tph_2026_01" \
  "SET ROLE anon; INSERT INTO public.tph_2026_01 (source,source_trader_id,symbol,direction,captured_at,created_at) VALUES ('binance_futures','anon-post','ADAUSDT','long','2026-01-15','2026-01-15')"
expect_failure_contains \
  "owner-flat-insert" \
  "legacy trader position history is frozen" \
  "INSERT INTO public.trader_position_history (source,source_trader_id,symbol,direction,captured_at,created_at) VALUES ('binance_futures','owner-flat','BTCUSDT','long','2026-01-16','2026-01-16')"
expect_failure_contains \
  "owner-child-update" \
  "legacy trader position history is frozen" \
  "UPDATE public.tph_2026_01 SET symbol='BAD' WHERE source_trader_id='child-seed'"
expect_failure_contains \
  "owner-child-delete" \
  "legacy trader position history is frozen" \
  "DELETE FROM public.tph_2026_01 WHERE source_trader_id='child-seed'"
expect_failure_contains \
  "owner-orphan-truncate" \
  "legacy trader position history is frozen" \
  "TRUNCATE TABLE public.tph_orphan"
expect_failure_contains \
  "security-definer-dynamic-wrapper" \
  "legacy trader position history is frozen" \
  "SET ROLE service_role; SELECT public.fixture_dynamic_legacy_history_insert('tph_2026_01','wrapper-post','2026-01-17')"
expect_failure_contains \
  "owner-retired-partition-creator" \
  "legacy trader position-history partition creator is retired" \
  "SELECT public.create_next_tph_partition()"
expect_failure_contains \
  "service-retired-partition-creator" \
  "permission denied for function create_next_tph_partition" \
  "SET ROLE service_role; SELECT public.create_next_tph_partition()"

# Re-granting a table capability cannot bypass the unconditional row guard.
expect_failure_contains \
  "regranted-anon-insert-hits-guard" \
  "legacy trader position history is frozen" \
  "BEGIN; GRANT INSERT ON public.tph_2026_01 TO anon; SET LOCAL ROLE anon; INSERT INTO public.tph_2026_01 (source,source_trader_id,symbol,direction,captured_at,created_at) VALUES ('binance_futures','anon-regrant','ADAUSDT','long','2026-01-18','2026-01-18')"

echo "[legacy-history-freeze] reject replay-time trigger/policy/role drift"
psql_cmd -q -c \
  "ALTER TABLE public.tph_2026_01 DISABLE TRIGGER reject_legacy_position_history_before_write"
expect_failure_contains \
  "disabled-child-row-guard" \
  "row guard identity drifted" \
  "\\i $MIGRATION"
psql_cmd -q -c \
  "ALTER TABLE public.tph_2026_01 ENABLE TRIGGER reject_legacy_position_history_before_write"

psql_cmd -q <<'SQL'
DROP POLICY legacy_position_history_operator_read ON public.tph_orphan;
CREATE POLICY fixture_public_read ON public.tph_orphan FOR SELECT USING (true);
SQL
expect_failure_contains \
  "public-policy-replay-drift" \
  "frozen legacy position-history RLS policy drifted" \
  "\\i $MIGRATION"
psql_cmd -q <<'SQL'
DROP POLICY fixture_public_read ON public.tph_orphan;
CREATE POLICY legacy_position_history_operator_read
  ON public.tph_orphan AS PERMISSIVE FOR SELECT
  TO postgres, service_role USING (true);
SQL

psql_cmd -q -c \
  "GRANT service_role TO authenticated WITH INHERIT TRUE, SET FALSE"
expect_failure_contains \
  "inherited-public-service-membership" \
  "public application role can assume service_role" \
  "\\i $MIGRATION"
psql_cmd -q -c "REVOKE service_role FROM authenticated"

expect_failure_contains \
  "concurrent-child-row-guard-before-replay" \
  "legacy trader position history is frozen" \
  "INSERT INTO public.tph_2026_02 (source,source_trader_id,symbol,direction,captured_at,created_at) VALUES ('binance_futures','concurrent-owner','DOGEUSDT','long','2026-02-10','2026-02-10')"
expect_failure_contains \
  "concurrent-child-truncate-guard-before-replay" \
  "legacy trader position history is frozen" \
  "TRUNCATE TABLE public.tph_2026_02"

echo "[legacy-history-freeze] prove post-freeze runtime partition DDL is disabled"
expect_failure_contains \
  "runtime-future-child-create-disabled" \
  "permission denied for schema public" \
  "SET ROLE service_role; CREATE TABLE public.tph_2027_01 PARTITION OF public.trader_position_history_partitioned FOR VALUES FROM ('2027-01-01') TO ('2027-02-01')"

psql_cmd -q <<'SQL'
CREATE TABLE public.fixture_legacy_history_attach_candidate
  (LIKE public.trader_position_history_partitioned INCLUDING ALL);
ALTER TABLE public.fixture_legacy_history_attach_candidate OWNER TO service_role;
SQL
expect_failure_contains \
  "runtime-future-child-attach-disabled" \
  "must be owner of table trader_position_history_partitioned" \
  "SET ROLE service_role; ALTER TABLE public.trader_position_history_partitioned ATTACH PARTITION public.fixture_legacy_history_attach_candidate FOR VALUES FROM ('2027-01-01') TO ('2027-02-01')"
psql_cmd -q -c "DROP TABLE public.fixture_legacy_history_attach_candidate"

if [[ "$(psql_cmd -Atq -c \
  "SELECT to_regclass('public.tph_2027_01') IS NULL")" != "t" ]]; then
  echo "[legacy-history-freeze] runtime role created a future child" >&2
  exit 1
fi

echo "[legacy-history-freeze] prove byte/OID-stable replay"
IDENTITY_BEFORE_REPLAY="$(identity_digest)"
apply_migration
IDENTITY_AFTER_REPLAY="$(identity_digest)"
if [[ "$IDENTITY_BEFORE_REPLAY" != "$IDENTITY_AFTER_REPLAY" ]]; then
  echo "[legacy-history-freeze] replay changed OIDs, definitions, ACLs, or comments" >&2
  echo "before=$IDENTITY_BEFORE_REPLAY after=$IDENTITY_AFTER_REPLAY" >&2
  exit 1
fi

echo "[legacy-history-freeze] prove manual rename cutover topology"
FLAT_OID="$(psql_cmd -Atq -c \
  "SELECT 'public.trader_position_history'::regclass::oid")"
PARTITIONED_OID="$(psql_cmd -Atq -c \
  "SELECT 'public.trader_position_history_partitioned'::regclass::oid")"
psql_cmd -q <<'SQL'
ALTER TABLE public.trader_position_history
  RENAME TO trader_position_history_old;
ALTER TABLE public.trader_position_history_partitioned
  RENAME TO trader_position_history;
SQL
if [[ "$(psql_cmd -Atq -c \
  "SELECT 'public.trader_position_history_old'::regclass::oid")" != "$FLAT_OID" ]]; then
  echo "[legacy-history-freeze] flat relation OID changed across rename" >&2
  exit 1
fi
if [[ "$(psql_cmd -Atq -c \
  "SELECT 'public.trader_position_history'::regclass::oid")" != "$PARTITIONED_OID" ]]; then
  echo "[legacy-history-freeze] partitioned relation OID changed across rename" >&2
  exit 1
fi
apply_migration
expect_failure_contains \
  "renamed-parent-owner-insert" \
  "legacy trader position history is frozen" \
  "INSERT INTO public.trader_position_history (source,source_trader_id,symbol,direction,captured_at,created_at) VALUES ('binance_futures','renamed-parent','BTCUSDT','long','2026-01-19','2026-01-19')"

echo "[legacy-history-freeze] prove optional old parent and creator may be absent"
psql_cmd -q <<'SQL'
DROP TABLE public.trader_position_history_old;
DROP FUNCTION public.create_next_tph_partition();
SQL
apply_migration
if [[ "$(psql_cmd -Atq -c \
  "SELECT to_regprocedure('public.create_next_tph_partition()') IS NULL")" != "t" ]]; then
  echo "[legacy-history-freeze] absent retired creator was recreated" >&2
  exit 1
fi
expect_failure_contains \
  "optional-topology-child-still-frozen" \
  "legacy trader position history is frozen" \
  "DELETE FROM public.tph_2026_01 WHERE source_trader_id='child-seed'"

echo "[legacy-history-freeze] PostgreSQL 17 proof passed"
