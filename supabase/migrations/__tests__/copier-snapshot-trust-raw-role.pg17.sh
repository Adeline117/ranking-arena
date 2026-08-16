#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the artifact@2 copier trust RAW role.
# The disposable cluster never connects to application or production data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260808010000_copier_snapshot_trust_raw_role.sql"
PUBLISHER_MIGRATION="$ROOT_DIR/supabase/migrations/20260804054000_publish_copier_snapshot_atomically.sql"
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

TMP_ROOT="$(mktemp -d /tmp/copier-snapshot-trust-role-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 6000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -180 "$LOG_FILE" >&2 || true
  fi
  find "$TMP_ROOT" -depth -delete
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label changed: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

expect_failure_contains() {
  local label="$1"
  local needle="$2"
  local sql="$3"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "$label succeeded unexpectedly" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,140p' "$failure_log" >&2
    exit 1
  fi
}

expect_migration_failure() {
  local label="$1"
  local needle="$2"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if psql_cmd -v VERBOSITY=verbose -f "$MIGRATION" >"$failure_log" 2>&1; then
    echo "$label succeeded unexpectedly" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,180p' "$failure_log" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --username=postgres \
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
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN BYPASSRLS;

CREATE SCHEMA arena AUTHORIZATION postgres;
CREATE SCHEMA supabase_migrations AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role;

CREATE TABLE supabase_migrations.schema_migrations (
  version text PRIMARY KEY,
  statements text[] NOT NULL DEFAULT ARRAY[]::text[],
  name text NOT NULL,
  created_by text NOT NULL DEFAULT 'test',
  idempotency_key text NOT NULL DEFAULT 'test'
);

INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20260804054000', 'publish_copier_snapshot_atomic');

CREATE TABLE arena.raw_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL,
  storage_path text NOT NULL UNIQUE,
  source_run_id text,
  trust_artifact_role text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

ALTER TABLE arena.raw_objects
  ADD CONSTRAINT raw_objects_metric_trust_binding CHECK (
    (source_run_id IS NULL AND trust_artifact_role IS NULL)
    OR (
      source_run_id ~ '^[0-9a-f]{64}$'
      AND trust_artifact_role IN (
        'source_payload',
        'population_manifest',
        'normalization_components',
        'event_history',
        'price_history',
        'opening_inventory',
        'copier_snapshot'
      )
    )
  );

ALTER TABLE arena.raw_objects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE arena.raw_objects FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON SEQUENCE arena.raw_objects_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE arena.raw_objects TO service_role;
GRANT USAGE ON SEQUENCE arena.raw_objects_id_seq TO service_role;

CREATE POLICY service_role_raw_write ON arena.raw_objects
  AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE FUNCTION arena.publish_copier_snapshot(
  p_source_id smallint,
  p_trader_id bigint,
  p_lane text,
  p_raw_object_id bigint,
  p_raw_storage_path text,
  p_raw_content_hash text,
  p_observed_at timestamptz,
  p_caller_limited boolean,
  p_page_count integer,
  p_source_reported_row_count integer,
  p_rows jsonb
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT 'copier_snapshot'::text
$function$;

REVOKE ALL ON FUNCTION arena.publish_copier_snapshot(
  smallint, bigint, text, bigint, text, text, timestamptz,
  boolean, integer, integer, jsonb
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION arena.publish_copier_snapshot(
  smallint, bigint, text, bigint, text, text, timestamptz,
  boolean, integer, integer, jsonb
) TO service_role;

INSERT INTO arena.raw_objects (
  source_id, storage_path, source_run_id, trust_artifact_role
) VALUES
  (1, 'legacy/copier/a.json.gz', repeat('a', 64), 'copier_snapshot'),
  (2, 'legacy/copier/b.json.gz', repeat('a', 64), 'copier_snapshot');
SQL

expect_migration_failure \
  'wrong predecessor migration ledger naming' \
  'requires one exact publish_copier_snapshot_atomically migration ledger name and body'

psql_cmd -q -c "
  UPDATE supabase_migrations.schema_migrations
     SET name = 'publish_copier_snapshot_atomically'
   WHERE version = '20260804054000';
"

expect_migration_failure \
  'drifted predecessor migration ledger body' \
  'requires one exact publish_copier_snapshot_atomically migration ledger name and body'

PUBLISHER_BODY="$(
  dd if="$PUBLISHER_MIGRATION" status=none
  printf '%s' '__ARENA_LEDGER_SENTINEL__'
)"
PUBLISHER_BODY="${PUBLISHER_BODY%__ARENA_LEDGER_SENTINEL__}"
psql_cmd -q -v publisher_body="$PUBLISHER_BODY" <<'SQL'
UPDATE supabase_migrations.schema_migrations
   SET statements = ARRAY[:'publisher_body']::text[]
 WHERE name = 'publish_copier_snapshot_atomically';
SQL

psql_cmd -q <<'SQL'
ALTER TABLE arena.raw_objects
  DROP CONSTRAINT raw_objects_metric_trust_binding,
  ADD CONSTRAINT raw_objects_metric_trust_binding CHECK (
    source_run_id IS NULL OR source_run_id ~ '^[0-9a-f]{64}$'
  );
SQL

expect_migration_failure \
  'same-name drifted RAW role constraint' \
  'raw_objects_metric_trust_binding has same-name drift'

psql_cmd -q <<'SQL'
ALTER TABLE arena.raw_objects
  DROP CONSTRAINT raw_objects_metric_trust_binding,
  ADD CONSTRAINT raw_objects_metric_trust_binding CHECK (
    (source_run_id IS NULL AND trust_artifact_role IS NULL)
    OR (
      source_run_id ~ '^[0-9a-f]{64}$'
      AND trust_artifact_role IN (
        'source_payload',
        'population_manifest',
        'normalization_components',
        'event_history',
        'price_history',
        'opening_inventory',
        'copier_snapshot'
      )
    )
  );

INSERT INTO arena.raw_objects (
  source_id, storage_path, source_run_id, trust_artifact_role
) VALUES (
  9, 'legacy/half-bound.json.gz', NULL, 'copier_snapshot'
);
SQL

expect_migration_failure \
  'half-bound legacy RAW trust row' \
  'half-bound legacy RAW trust rows must be quarantined before role registration'

psql_cmd -q -c "
  DELETE FROM arena.raw_objects
   WHERE storage_path = 'legacy/half-bound.json.gz';
"

psql_cmd -q <<'SQL'
CREATE INDEX uidx_raw_copier_snapshot_trust_per_run
  ON arena.raw_objects (id);
SQL

expect_migration_failure \
  'same-name drifted copier trust index' \
  'copier snapshot trust RAW identity index already exists or has same-name drift'

psql_cmd -q -c 'DROP INDEX arena.uidx_raw_copier_snapshot_trust_per_run'

SECURITY_BEFORE="$(
  psql_cmd -Atqc "
    WITH policy_fingerprint AS (
      SELECT COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'name', policy_row.polname,
                   'command', policy_row.polcmd,
                   'permissive', policy_row.polpermissive,
                   'roles', policy_row.polroles::text,
                   'using', pg_catalog.pg_get_expr(
                     policy_row.polqual,
                     policy_row.polrelid
                   ),
                   'check', pg_catalog.pg_get_expr(
                     policy_row.polwithcheck,
                     policy_row.polrelid
                   )
                 ) ORDER BY policy_row.polname
               ),
               '[]'::jsonb
             ) AS value
        FROM pg_catalog.pg_policy AS policy_row
       WHERE policy_row.polrelid = 'arena.raw_objects'::pg_catalog.regclass
    )
    SELECT pg_catalog.md5(
             pg_catalog.jsonb_build_object(
               'acl', COALESCE(relation_row.relacl::text, ''),
               'rls', relation_row.relrowsecurity,
               'force_rls', relation_row.relforcerowsecurity,
               'policies', policy_fingerprint.value
             )::text
           )
      FROM pg_catalog.pg_class AS relation_row
      CROSS JOIN policy_fingerprint
     WHERE relation_row.oid = 'arena.raw_objects'::pg_catalog.regclass;
  "
)"

PUBLISHER_BEFORE="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.md5(
             pg_catalog.pg_get_functiondef(procedure_row.oid)
             || COALESCE(procedure_row.proacl::text, '')
             || procedure_row.proowner::text
           )
      FROM pg_catalog.pg_proc AS procedure_row
     WHERE procedure_row.oid = pg_catalog.to_regprocedure(
       'arena.publish_copier_snapshot(smallint,bigint,text,bigint,text,text,timestamp with time zone,boolean,integer,integer,jsonb)'
     );
  "
)"

expect_failure_contains \
  'browser role read RAW before trust role migration' \
  'permission denied for table raw_objects' \
  'SET ROLE anon; SELECT * FROM arena.raw_objects'

psql_cmd -q -f "$MIGRATION"

SECURITY_AFTER="$(
  psql_cmd -Atqc "
    WITH policy_fingerprint AS (
      SELECT COALESCE(
               jsonb_agg(
                 jsonb_build_object(
                   'name', policy_row.polname,
                   'command', policy_row.polcmd,
                   'permissive', policy_row.polpermissive,
                   'roles', policy_row.polroles::text,
                   'using', pg_catalog.pg_get_expr(
                     policy_row.polqual,
                     policy_row.polrelid
                   ),
                   'check', pg_catalog.pg_get_expr(
                     policy_row.polwithcheck,
                     policy_row.polrelid
                   )
                 ) ORDER BY policy_row.polname
               ),
               '[]'::jsonb
             ) AS value
        FROM pg_catalog.pg_policy AS policy_row
       WHERE policy_row.polrelid = 'arena.raw_objects'::pg_catalog.regclass
    )
    SELECT pg_catalog.md5(
             pg_catalog.jsonb_build_object(
               'acl', COALESCE(relation_row.relacl::text, ''),
               'rls', relation_row.relrowsecurity,
               'force_rls', relation_row.relforcerowsecurity,
               'policies', policy_fingerprint.value
             )::text
           )
      FROM pg_catalog.pg_class AS relation_row
      CROSS JOIN policy_fingerprint
     WHERE relation_row.oid = 'arena.raw_objects'::pg_catalog.regclass;
  "
)"

PUBLISHER_AFTER="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.md5(
             pg_catalog.pg_get_functiondef(procedure_row.oid)
             || COALESCE(procedure_row.proacl::text, '')
             || procedure_row.proowner::text
           )
      FROM pg_catalog.pg_proc AS procedure_row
     WHERE procedure_row.oid = pg_catalog.to_regprocedure(
       'arena.publish_copier_snapshot(smallint,bigint,text,bigint,text,text,timestamp with time zone,boolean,integer,integer,jsonb)'
     );
  "
)"

assert_equal 'RAW ACL/RLS/policy fingerprint' "$SECURITY_BEFORE" "$SECURITY_AFTER"
assert_equal 'legacy copier publisher definition and ACL' "$PUBLISHER_BEFORE" "$PUBLISHER_AFTER"
assert_equal \
  'legacy copier publisher contract' \
  'copier_snapshot' \
  "$(psql_cmd -Atqc "SELECT arena.publish_copier_snapshot(1::smallint,1::bigint,'tier_c'::text,1::bigint,'p'::text,repeat('a',64)::text,now()::timestamptz,true,1::integer,NULL::integer,'[]'::jsonb)")"

expect_failure_contains \
  'browser role read RAW after trust role migration' \
  'permission denied for table raw_objects' \
  'SET ROLE authenticated; SELECT * FROM arena.raw_objects'

psql_cmd -q <<'SQL'
INSERT INTO arena.raw_objects (
  source_id, storage_path, source_run_id, trust_artifact_role,
  meta
) VALUES (
  1,
  'gate/copier_snapshot_trust/tier_c/outer-a/copier_snapshot_trust_outer-a.json.gz',
  repeat('b', 64),
  'copier_snapshot_trust',
  '{"contract":"arena.ingest.copier-snapshot-artifact@2"}'::jsonb
);

-- Old artifact@1 pointers remain outside the new identity index. Their prior
-- same-hash behavior and the ability to coexist with an @2 outer hash remain.
INSERT INTO arena.raw_objects (
  source_id, storage_path, source_run_id, trust_artifact_role
) VALUES
  (3, 'legacy/copier/c.json.gz', repeat('a', 64), 'copier_snapshot'),
  (4, 'legacy/copier/outer-b.json.gz', repeat('b', 64), 'copier_snapshot');

INSERT INTO arena.raw_objects (
  source_id, storage_path, source_run_id, trust_artifact_role
)
SELECT 10 + role_row.ordinality,
       'legacy/role/' || role_row.role || '.json.gz',
       pg_catalog.lpad(role_row.ordinality::text, 64, '0'),
       role_row.role
  FROM pg_catalog.unnest(ARRAY[
    'source_payload',
    'population_manifest',
    'normalization_components',
    'event_history',
    'price_history',
    'opening_inventory'
  ]::text[]) WITH ORDINALITY AS role_row(role, ordinality);
SQL

expect_failure_contains \
  'same outer hash with different path and source' \
  'uidx_raw_copier_snapshot_trust_per_run' \
  "INSERT INTO arena.raw_objects (source_id,storage_path,source_run_id,trust_artifact_role) VALUES (99,'other/copier_snapshot_trust/tier_b/outer-b.json.gz',repeat('b',64),'copier_snapshot_trust')"

expect_failure_contains \
  'unregistered RAW role' \
  'raw_objects_metric_trust_binding' \
  "INSERT INTO arena.raw_objects (source_id,storage_path,source_run_id,trust_artifact_role) VALUES (99,'invalid/role.json.gz',repeat('c',64),'copier_snapshot_artifact')"

expect_failure_contains \
  'trust role without outer hash' \
  'raw_objects_metric_trust_binding' \
  "INSERT INTO arena.raw_objects (source_id,storage_path,source_run_id,trust_artifact_role) VALUES (99,'invalid/null-hash.json.gz',NULL,'copier_snapshot_trust')"

expect_failure_contains \
  'malformed copier trust outer hash' \
  'raw_objects_metric_trust_binding' \
  "INSERT INTO arena.raw_objects (source_id,storage_path,source_run_id,trust_artifact_role) VALUES (99,'invalid/hash.json.gz',repeat('g',64),'copier_snapshot_trust')"

INDEX_SHAPE="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.concat_ws(
             '|',
             index_row.indisunique,
             index_row.indisvalid,
             index_row.indnkeyatts,
             index_row.indnatts,
             pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid)
           )
      FROM pg_catalog.pg_index AS index_row
     WHERE index_row.indexrelid =
           'arena.uidx_raw_copier_snapshot_trust_per_run'::pg_catalog.regclass;
  "
)"
assert_equal \
  'copier trust partial unique index shape' \
  "t|t|1|1|((source_run_id IS NOT NULL) AND (trust_artifact_role = 'copier_snapshot_trust'::text))" \
  "$INDEX_SHAPE"

ROLE_COUNTS="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.concat_ws(
             '|',
             pg_catalog.count(*) FILTER (
               WHERE trust_artifact_role = 'copier_snapshot_trust'
             ),
             pg_catalog.count(*) FILTER (
               WHERE trust_artifact_role = 'copier_snapshot'
             )
           )
      FROM arena.raw_objects;
  "
)"
assert_equal 'new and legacy copier RAW populations' '1|4' "$ROLE_COUNTS"

ROLE_PRIVILEGES="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.concat_ws(
      '|',
      pg_catalog.has_table_privilege('anon', 'arena.raw_objects', 'SELECT'),
      pg_catalog.has_table_privilege('authenticated', 'arena.raw_objects', 'SELECT'),
      pg_catalog.has_table_privilege('service_role', 'arena.raw_objects', 'SELECT'),
      pg_catalog.has_table_privilege('service_role', 'arena.raw_objects', 'INSERT'),
      pg_catalog.has_table_privilege('service_role', 'arena.raw_objects', 'UPDATE'),
      pg_catalog.has_table_privilege('service_role', 'arena.raw_objects', 'DELETE')
    );
  "
)"
assert_equal 'RAW role privileges' 'f|f|t|t|f|f' "$ROLE_PRIVILEGES"

psql_cmd -q <<'SQL'
INSERT INTO supabase_migrations.schema_migrations (version, name)
VALUES ('20260808010000', 'copier_snapshot_trust_raw_role');

DO $assert_ledger$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM supabase_migrations.schema_migrations AS ledger
     WHERE ledger.version = '20260808010000'
        OR ledger.name = 'copier_snapshot_trust_raw_role'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
      FROM supabase_migrations.schema_migrations AS ledger
     WHERE ledger.version = '20260808010000'
       AND ledger.name = 'copier_snapshot_trust_raw_role'
  ) THEN
    RAISE EXCEPTION 'new copier trust migration ledger naming drifted';
  END IF;
END
$assert_ledger$;
SQL

echo 'copier snapshot trust RAW role PostgreSQL 17 proof passed'
