#!/usr/bin/env bash

# Disposable PostgreSQL 17 proof for the atomic copier artifact@2 publisher.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260808021000_publish_copier_snapshot_trust_v2.sql"
V1_SUBSTRATE="$ROOT_DIR/supabase/migrations/20260804053000_copier_snapshot_publication_substrate.sql"
V1_PUBLISHER="$ROOT_DIR/supabase/migrations/20260804054000_publish_copier_snapshot_atomically.sql"
RAW_ROLE="$ROOT_DIR/supabase/migrations/20260808010000_copier_snapshot_trust_raw_role.sql"
V2_SUBSTRATE="$ROOT_DIR/supabase/migrations/20260808020000_copier_snapshot_trust_publication_substrate.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$executable" ]] || {
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  }
done
[[ "$("$PG_BIN/psql" --version)" == psql\ \(PostgreSQL\)\ 17.* ]] || {
  echo 'This integration proof requires PostgreSQL 17' >&2
  exit 1
}

TMP_ROOT="$(mktemp -d /tmp/publish-copier-snapshot-trust-v2-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 7000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
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
  local label="$1" expected="$2" actual="$3"
  [[ "$expected" == "$actual" ]] || {
    echo "$label changed: expected '$expected', got '$actual'" >&2
    exit 1
  }
}

expect_failure_contains() {
  local label="$1" needle="$2" sql="$3"
  local log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if psql_cmd -v VERBOSITY=verbose -c "$sql" >"$log" 2>&1; then
    echo "$label succeeded unexpectedly" >&2
    exit 1
  fi
  if ! rg -Fq "$needle" "$log"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,180p' "$log" >&2
    exit 1
  fi
}

expect_migration_failure() {
  local label="$1" needle="$2"
  local log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if psql_cmd -v VERBOSITY=verbose -f "$MIGRATION" >"$log" 2>&1; then
    echo "$label succeeded unexpectedly" >&2
    exit 1
  fi
  if ! rg -Fq "$needle" "$log"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,180p' "$log" >&2
    exit 1
  fi
}

sha256_text() {
  printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
}

decode_fixture() {
  printf '%s' "$1" | base64 --decode
}

legacy_v1_fingerprint() {
  psql_cmd -Atqc "
    WITH catalog_shape AS (
      SELECT pg_catalog.jsonb_build_object(
        'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.pg_get_constraintdef(c.oid)
          ORDER BY r.relname,c.conname) FROM pg_catalog.pg_constraint c
          JOIN pg_catalog.pg_class r ON r.oid=c.conrelid WHERE c.conrelid IN
          ('arena.copier_snapshot_publications'::regclass,'arena.copier_snapshot_rows'::regclass)),
        'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          r.relname,a.attnum,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),
          a.attnotnull,a.attidentity,pg_catalog.pg_get_expr(d.adbin,d.adrelid))
          ORDER BY r.relname,a.attnum) FROM pg_catalog.pg_attribute a
          JOIN pg_catalog.pg_class r ON r.oid=a.attrelid LEFT JOIN pg_catalog.pg_attrdef d
          ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attnum>0 AND NOT a.attisdropped
          AND a.attrelid IN ('arena.copier_snapshot_publications'::regclass,
          'arena.copier_snapshot_rows'::regclass)),
        'indexes',(SELECT pg_catalog.jsonb_agg(pg_catalog.pg_get_indexdef(i.indexrelid)
          ORDER BY pg_catalog.pg_get_indexdef(i.indexrelid)) FROM pg_catalog.pg_index i
          WHERE i.indrelid IN ('arena.copier_snapshot_publications'::regclass,
          'arena.copier_snapshot_rows'::regclass)),
        'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.pg_get_triggerdef(t.oid)
          ORDER BY t.tgname) FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal
          AND t.tgrelid IN ('arena.copier_snapshot_publications'::regclass,
          'arena.copier_snapshot_rows'::regclass))
      ) AS value
    )
    SELECT pg_catalog.md5(pg_catalog.jsonb_build_object(
      'header_acl',h.relacl::text,'header_rls',h.relrowsecurity,'header_force',h.relforcerowsecurity,
      'row_acl',r.relacl::text,'row_rls',r.relrowsecurity,'row_force',r.relforcerowsecurity,
      'catalog',catalog_shape.value,'publisher',pg_catalog.pg_get_functiondef(p.oid),
      'publisher_acl',p.proacl::text,
      'headers',(SELECT pg_catalog.jsonb_agg(to_jsonb(x) ORDER BY publication_id)
        FROM arena.copier_snapshot_publications x),
      'rows',(SELECT pg_catalog.jsonb_agg(to_jsonb(x) ORDER BY publication_id,row_ordinal)
        FROM arena.copier_snapshot_rows x))::text)
    FROM pg_catalog.pg_class h CROSS JOIN pg_catalog.pg_class r
    CROSS JOIN pg_catalog.pg_proc p CROSS JOIN catalog_shape
    WHERE h.oid='arena.copier_snapshot_publications'::regclass
      AND r.oid='arena.copier_snapshot_rows'::regclass
      AND p.oid=to_regprocedure('arena.publish_copier_snapshot(smallint,bigint,text,bigint,text,text,timestamp with time zone,boolean,integer,integer,jsonb)');"
}

"$PG_BIN/initdb" -D "$DATA_DIR" --username=postgres --auth-local=trust \
  --auth-host=trust --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE outsider NOLOGIN NOBYPASSRLS;
CREATE SCHEMA arena AUTHORIZATION postgres;
CREATE SCHEMA supabase_migrations AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA arena TO anon,authenticated,service_role,outsider;

CREATE TABLE supabase_migrations.schema_migrations (
  version text PRIMARY KEY, statements text[] NOT NULL DEFAULT ARRAY[]::text[],
  name text NOT NULL, created_by text NOT NULL DEFAULT 'test',
  idempotency_key text NOT NULL DEFAULT 'test'
);
CREATE TABLE arena.sources (
  id smallint PRIMARY KEY, slug text UNIQUE NOT NULL, adapter_slug text NOT NULL,
  product_type text NOT NULL, currency text NOT NULL, copier_table_depth text NOT NULL,
  fetch_region text NOT NULL, status text NOT NULL, serving_mode text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY, source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL, meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY, source_id smallint NOT NULL REFERENCES arena.sources(id),
  job_type text NOT NULL, trader_id bigint, timeframe smallint,
  fetched_at timestamptz NOT NULL, storage_path text NOT NULL UNIQUE,
  bytes integer NOT NULL, content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false, meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_run_id text, trust_artifact_role text
);
ALTER TABLE arena.raw_objects ADD CONSTRAINT raw_objects_metric_trust_binding CHECK (
  (source_run_id IS NULL AND trust_artifact_role IS NULL) OR (
    source_run_id ~ '^[0-9a-f]{64}$' AND trust_artifact_role IN (
      'source_payload','population_manifest','normalization_components','event_history',
      'price_history','opening_inventory','copier_snapshot'
    )
  )
);
CREATE TABLE arena.raw_object_gc_queue (
  raw_object_id bigint NOT NULL UNIQUE, storage_path text PRIMARY KEY,
  content_hash text NOT NULL, enqueued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  attempts integer NOT NULL DEFAULT 0, last_attempt_at timestamptz, last_error text
);
CREATE TABLE arena.copier_records (
  trader_id bigint NOT NULL REFERENCES arena.traders(id), ts timestamptz NOT NULL,
  copier_label text, copier_pnl numeric, copier_invested numeric,
  copy_duration_days integer, currency text NOT NULL, dedupe_hash text NOT NULL, raw jsonb
);
ALTER TABLE arena.raw_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA arena FROM PUBLIC,anon,authenticated,service_role,outsider;
GRANT SELECT,INSERT,UPDATE,DELETE ON arena.raw_objects TO service_role;
CREATE POLICY service_role_raw_write ON arena.raw_objects FOR ALL TO service_role
  USING (true) WITH CHECK (true);
SQL

psql_cmd -q -f "$V1_SUBSTRATE"
psql_cmd -q -f "$V1_PUBLISHER"

record_ledger() {
  local version="$1" name="$2" file="$3" body
  body="$(dd if="$file" status=none; printf '%s' '__LEDGER_SENTINEL__')"
  body="${body%__LEDGER_SENTINEL__}"
  psql_cmd -q -v version="$version" -v name="$name" -v body="$body" <<'SQL'
INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
VALUES (:'version',:'name',ARRAY[:'body']::text[]);
SQL
}

record_ledger 20260804054000 publish_copier_snapshot_atomically "$V1_PUBLISHER"
psql_cmd -q -f "$RAW_ROLE"
record_ledger 20260808010000 copier_snapshot_trust_raw_role "$RAW_ROLE"
psql_cmd -q -f "$V2_SUBSTRATE"
record_ledger 20260808020000 wrong_copier_snapshot_trust_publication_substrate "$V2_SUBSTRATE"

V1_BEFORE="$(legacy_v1_fingerprint)"
expect_migration_failure 'wrong @2 substrate migration ledger' \
  'requires one exact copier_snapshot_trust_publication_substrate migration ledger name and body'
psql_cmd -q -c "UPDATE supabase_migrations.schema_migrations
  SET name='copier_snapshot_trust_publication_substrate'
  WHERE version='20260808020000'"
psql_cmd -q -f "$MIGRATION"
assert_equal 'legacy v1 fingerprint' "$V1_BEFORE" "$(legacy_v1_fingerprint)"

# Function/table ACL fingerprint: only service_role can execute the definer;
# no API role can execute helpers or directly read/write the private substrate.
ACL_FINGERPRINT="$(psql_cmd -Atqc "
  SELECT p.proowner='postgres'::regrole,p.prosecdef,p.proconfig::text,
         has_function_privilege('anon',p.oid,'EXECUTE'),
         has_function_privilege('authenticated',p.oid,'EXECUTE'),
         has_function_privilege('service_role',p.oid,'EXECUTE'),
         has_table_privilege('service_role','arena.copier_snapshot_trust_publications','SELECT,INSERT,UPDATE,DELETE'),
         has_table_privilege('service_role','arena.copier_snapshot_trust_rows','SELECT,INSERT,UPDATE,DELETE')
    FROM pg_catalog.pg_proc p
   WHERE p.oid='arena.publish_copier_snapshot_trust_v2(bigint,smallint,bigint,text,text,text,text,text,text)'::regprocedure")"
assert_equal 'service-role-only SECURITY DEFINER ACL fingerprint' \
  't|t|{"search_path=pg_catalog, pg_temp",row_security=off,standard_conforming_strings=on}|f|f|t|f|f' \
  "$ACL_FINGERPRINT"
expect_failure_contains 'anon publisher execute ACL' 'permission denied for function' \
  "SET ROLE anon; SELECT * FROM arena.publish_copier_snapshot_trust_v2(1::bigint,1::smallint,1::bigint,'tier_c'::text,repeat('a',64),'{}'::text,'{}'::text,'{}'::text,'{}'::text)"

psql_cmd -q <<'SQL'
INSERT INTO arena.sources VALUES
  (1,'bingx_futures','bingx','futures','USDT','full','local','active','serving','{}'),
  (2,'gate_futures','gate','futures','USDT','top10','local','active','serving','{"boardKey":"futures"}'),
  (3,'okx_futures','okx','futures','USDT','full','vps_sg','active','serving','{"inst_type":"SWAP"}');
INSERT INTO arena.traders VALUES
  (101,1,'trader-101','{}'),(102,1,'trader-102','{}'),(103,1,'trader-103','{}');

CREATE SCHEMA test_support AUTHORIZATION postgres;
CREATE FUNCTION test_support.install_copier_trust_raw(
  p_raw_id bigint, p_source_id smallint, p_trader_id bigint, p_lane text,
  p_snapshot text, p_candidate text, p_parser text, p_projection text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,pg_temp SET row_security=off AS $f$
DECLARE
  snapshot_hash text := encode(sha256(convert_to(p_snapshot,'UTF8')),'hex');
  candidate_hash text := encode(sha256(convert_to(p_candidate,'UTF8')),'hex');
  parser_hash text := encode(sha256(convert_to(p_parser,'UTF8')),'hex');
  projection_hash text := encode(sha256(convert_to(p_projection,'UTF8')),'hex');
  outer_text text;
  outer_hash text;
  snapshot jsonb;
  observed_text text;
  source_slug text;
  compressed_bytes integer := 512;
BEGIN
  outer_text := '{"candidate_ledger":'||p_candidate||
    ',"candidate_ledger_sha256":"'||candidate_hash||'"'||
    ',"contract":"arena.ingest.copier-snapshot-artifact@2"'||
    ',"parser_conservation":'||p_parser||
    ',"parser_conservation_sha256":"'||parser_hash||'"'||
    ',"projection_ledger":'||p_projection||
    ',"projection_ledger_sha256":"'||projection_hash||'"'||
    ',"serialization_contract":"arena.strict-canonical-json@1"'||
    ',"snapshot":'||p_snapshot||
    ',"snapshot_source_run_id":"'||snapshot_hash||'"}';
  outer_hash := encode(sha256(convert_to(outer_text,'UTF8')),'hex');
  snapshot := p_snapshot::jsonb;
  observed_text := snapshot->>'observed_at';
  source_slug := snapshot->'source'->>'slug';
  INSERT INTO arena.raw_objects(
    id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,
    content_hash,quarantined,meta,source_run_id,trust_artifact_role
  ) VALUES (
    p_raw_id,p_source_id,CASE p_lane WHEN 'tier_b' THEN 'history:copiers' ELSE 'tier_c' END,
    p_trader_id,NULL,observed_text::timestamptz,
    source_slug||'/copier_snapshot_trust/'||p_lane||'/'||outer_hash||
      '/copier_snapshot_trust_'||outer_hash||'.json.gz',
    compressed_bytes,outer_hash,false,
    jsonb_build_object(
      'surface','copiers','data_contract','arena.ingest.copier-snapshot-artifact@2',
      'source_run_id',outer_hash,'source_id',p_source_id,'source_slug',source_slug,
      'trader_id',p_trader_id,'lane',p_lane,'observed_at',observed_text,
      'snapshot_artifact_contract','arena.ingest.copier-snapshot-artifact@1',
      'snapshot_source_run_id',snapshot_hash,
      'candidate_ledger_contract','arena.ingest.copier-candidate-ledger@1',
      'candidate_ledger_sha256',candidate_hash,
      'parser_conservation_contract','arena.ingest.copier-parser-conservation@1',
      'parser_conservation_sha256',parser_hash,
      'projection_ledger_contract','arena.ingest.copier-projection-ledger@1',
      'projection_ledger_sha256',projection_hash,
      'raw_integrity',jsonb_build_object(
        'version',1,'content_type','application/json','encoding','utf-8',
        'compression','gzip','hash_algorithm','sha256','hash_scope','json_utf8',
        'serialization_contract','arena.strict-canonical-json@1',
        'compressed_bytes',compressed_bytes,'uncompressed_bytes',octet_length(outer_text)
      )
    ),outer_hash,'copier_snapshot_trust'
  );
  RETURN outer_hash;
END $f$;
REVOKE ALL ON SCHEMA test_support FROM PUBLIC,anon,authenticated,service_role,outsider;
SQL

install_raw() {
  local raw="$1" source="$2" trader="$3" lane="$4" snapshot="$5" candidate="$6" parser="$7" projection="$8"
  psql_cmd -Atq -v raw="$raw" -v source="$source" -v trader="$trader" -v lane="$lane" \
    -v snapshot="$snapshot" -v candidate="$candidate" -v parser="$parser" -v projection="$projection" <<'SQL'
SELECT test_support.install_copier_trust_raw(
  :'raw'::bigint,:'source'::smallint,:'trader'::bigint,:'lane',
  :'snapshot',:'candidate',:'parser',:'projection'
);
SQL
}

publish_result() {
  local raw="$1" source="$2" trader="$3" lane="$4" outer="$5" snapshot="$6" candidate="$7" parser="$8" projection="$9"
  psql_cmd -Atq -v raw="$raw" -v source="$source" -v trader="$trader" -v lane="$lane" \
    -v outer="$outer" -v snapshot="$snapshot" -v candidate="$candidate" \
    -v parser="$parser" -v projection="$projection" <<'SQL'
SET ROLE service_role;
SELECT source_id||'|'||trader_id||'|'||lane||'|'||raw_object_id_at_publication||'|'||
       outer_source_run_id||'|'||to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||'|'||
       parsed_row_count||'|'||coverage_state||'|'||rank_eligible||'|'||replayed||'|'||is_current_head
  FROM arena.publish_copier_snapshot_trust_v2(
    :'raw'::bigint,:'source'::smallint,:'trader'::bigint,:'lane',:'outer',
    :'snapshot',:'candidate',:'parser',:'projection'
  );
SQL
}

expect_publish_failure() {
  local label="$1" needle="$2" raw="$3" source="$4" trader="$5" lane="$6" outer="$7" snapshot="$8" candidate="$9"
  shift 9
  local parser="$1" projection="$2" log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if psql_cmd -v VERBOSITY=verbose -v raw="$raw" -v source="$source" -v trader="$trader" \
    -v lane="$lane" -v outer="$outer" -v snapshot="$snapshot" -v candidate="$candidate" \
    -v parser="$parser" -v projection="$projection" >"$log" 2>&1 <<'SQL'
SET ROLE service_role;
SELECT * FROM arena.publish_copier_snapshot_trust_v2(
  :'raw'::bigint,:'source'::smallint,:'trader'::bigint,:'lane',:'outer',
  :'snapshot',:'candidate',:'parser',:'projection'
);
SQL
  then
    echo "$label succeeded unexpectedly" >&2
    exit 1
  fi
  if ! rg -Fq "$needle" "$log"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,180p' "$log" >&2
    exit 1
  fi
}

# Cross-language golden fixture emitted once by the reviewed TypeScript @2
# builder and stored as base64 only to keep shell quoting lossless.
SNAPSHOT="$(decode_fixture 'eyJjYWxsZXJfbGltaXRlZCI6ZmFsc2UsImNvbnRyYWN0IjoiYXJlbmEuaW5nZXN0LmNvcGllci1zbmFwc2hvdC1hcnRpZmFjdEAxIiwibGFuZSI6InRpZXJfYyIsIm9ic2VydmVkX2F0IjoiMjAyNi0wOC0wNFQxMjowMDowMS4wMDBaIiwicGFnZV9jb3VudCI6MSwicGFnZXMiOlt7ImZldGNoZWRBdCI6IjIwMjYtMDgtMDRUMTI6MDA6MDEuMDAwWiIsInBhZ2VJbmRleCI6MSwicGF5bG9hZCI6eyJjb2RlIjowLCJkYXRhIjp7ImZvbGxvd2VyRGV0YWlsc1ZvTGlzdCI6W3siY29weUFtb3VudCI6IjEwIiwiZm9sbG93aW5nRGF5cyI6MiwiZm9sbG93aW5nUHJvZml0TG9zcyI6IjEuMjUiLCJuaWNrTmFtZSI6InByaXZhdGUtYSIsInVpZCI6ImEifV19fSwidXJsIjoiaHR0cHM6Ly9leGFtcGxlLnRlc3QvY29waWVycz9wYWdlPTEifV0sInJlcXVlc3RfdGltZWZyYW1lIjowLCJzY2FuX3Rlcm1pbmFsX3N0YXRlIjoic3RyZWFtX2V4aGF1c3RlZF91bnZlcmlmaWVkIiwic291cmNlIjp7ImNvcGllcl90YWJsZV9kZXB0aCI6ImZ1bGwiLCJjdXJyZW5jeSI6IlVTRFQiLCJmZXRjaF9yZWdpb24iOiJsb2NhbCIsImlkIjoxLCJzbHVnIjoiYmluZ3hfZnV0dXJlcyJ9LCJzb3VyY2VfcmVwb3J0ZWRfcm93X2NvdW50IjpudWxsLCJ0cmFkZXIiOnsiZXhjaGFuZ2VfdHJhZGVyX2lkIjoidHJhZGVyLTEwMSIsImlkIjoxMDF9fQ==')"
CANDIDATE="$(decode_fixture 'eyJjYW5kaWRhdGVfbXVsdGlzZXRfc2hhMjU2IjoiN2EyNjM0ZTAzMWUxZDAwNTczMDlmZGIyN2U5ZGZmZjQyM2FhMWMxNWRhNDI2MzRhMzM2YThkNWM2Y2RiM2Q3MCIsImNvbnRyYWN0IjoiYXJlbmEuaW5nZXN0LmNvcGllci1jYW5kaWRhdGUtbGVkZ2VyQDEiLCJleGNoYW5nZV90cmFkZXJfaWQiOiJ0cmFkZXItMTAxIiwibXVsdGlzZXRfY29udHJhY3QiOiJhcmVuYS5pbmdlc3QuY29waWVyLWNhbmRpZGF0ZS1tdWx0aXNldEAxIiwib2JzZXJ2ZWRfY2FuZGlkYXRlX2NvdW50IjoxLCJwYWdlX2NvdW50IjoxLCJwYWdlcyI6W3siY2FuZGlkYXRlX2NvdW50IjoxLCJsb2NhdG9yX2NvbnRyYWN0IjoiYXJlbmEuaW5nZXN0LmNvcGllci1jYW5kaWRhdGUtbG9jYXRvci5iaW5neEAxIiwib2NjdXJyZW5jZXMiOlt7ImNhbmRpZGF0ZV9vcmRpbmFsIjoxLCJyYXdfY2FuZGlkYXRlX3NoYTI1NiI6IjRiZTNlNjk1Mjc4ZTQwNTQzYTk5YzIzYzY4YjJlYzY4MzU5MTBjNTE2ZjdlMWI0MGUzYjFmYmE4ZDQxNDMzZTkifV0sInBhZ2Vfb3JkaW5hbCI6MSwic291cmNlX3BhZ2VfaW5kZXgiOjF9XSwic2VyaWFsaXphdGlvbl9jb250cmFjdCI6ImFyZW5hLnN0cmljdC1jYW5vbmljYWwtanNvbkAxIiwic291cmNlIjp7ImFkYXB0ZXJfc2x1ZyI6ImJpbmd4IiwiaWQiOjEsInNsdWciOiJiaW5neF9mdXR1cmVzIn19')"
PARSER="$(decode_fixture 'eyJjYW5kaWRhdGVfbGVkZ2VyX3NoYTI1NiI6IjRiYjNiYzcxMjUzOWNmOGU1NGU5MGViM2E0Y2JhZjE0ZTk2Nzc3NjkyYzdmMmM3OWIxNzYxZDMzMTM3M2QwZTEiLCJjYW5kaWRhdGVfbXVsdGlzZXRfc2hhMjU2IjoiN2EyNjM0ZTAzMWUxZDAwNTczMDlmZGIyN2U5ZGZmZjQyM2FhMWMxNWRhNDI2MzRhMzM2YThkNWM2Y2RiM2Q3MCIsImNvbnRyYWN0IjoiYXJlbmEuaW5nZXN0LmNvcGllci1wYXJzZXItY29uc2VydmF0aW9uQDEiLCJleGNoYW5nZV90cmFkZXJfaWQiOiJ0cmFkZXItMTAxIiwib2JzZXJ2ZWRfY2FuZGlkYXRlX2NvdW50IjoxLCJwYXJzZWRfcmF3X211bHRpc2V0X3NoYTI1NiI6IjdhMjYzNGUwMzFlMWQwMDU3MzA5ZmRiMjdlOWRmZmY0MjNhYTFjMTVkYTQyNjM0YTMzNmE4ZDVjNmNkYjNkNzAiLCJwYXJzZWRfcm93X2NvdW50IjoxLCJyb3dzIjpbeyJyYXdfY2FuZGlkYXRlX3NoYTI1NiI6IjRiZTNlNjk1Mjc4ZTQwNTQzYTk5YzIzYzY4YjJlYzY4MzU5MTBjNTE2ZjdlMWI0MGUzYjFmYmE4ZDQxNDMzZTkiLCJyb3dfb3JkaW5hbCI6MH1dLCJzZXJpYWxpemF0aW9uX2NvbnRyYWN0IjoiYXJlbmEuc3RyaWN0LWNhbm9uaWNhbC1qc29uQDEiLCJzb3VyY2UiOnsiYWRhcHRlcl9zbHVnIjoiYmluZ3giLCJpZCI6MSwic2x1ZyI6ImJpbmd4X2Z1dHVyZXMifX0=')"
PROJECTION="$(decode_fixture 'eyJiaW5kaW5nIjp7ImFkYXB0ZXJfc2x1ZyI6ImJpbmd4IiwiY2FuZGlkYXRlX2xvY2F0b3JfY29udHJhY3QiOiJhcmVuYS5pbmdlc3QuY29waWVyLWNhbmRpZGF0ZS1sb2NhdG9yLmJpbmd4QDEiLCJjb250cmFjdCI6ImFyZW5hLmluZ2VzdC5jb3BpZXItcGFyc2VyLXJlcGxheS1iaW5kaW5nQDEiLCJwYXJzZXJfY29udHJhY3QiOiJhcmVuYS5pbmdlc3QuY29waWVyLXBhcnNlci5iaW5neEAxIiwicHJvZHVjdF90eXBlIjoiZnV0dXJlcyJ9LCJjYW5kaWRhdGVfbGVkZ2VyX3NoYTI1NiI6IjRiYjNiYzcxMjUzOWNmOGU1NGU5MGViM2E0Y2JhZjE0ZTk2Nzc3NjkyYzdmMmM3OWIxNzYxZDMzMTM3M2QwZTEiLCJjYW5kaWRhdGVfcHJvamVjdGlvbl9maXhlZF9tdWx0aXNldF9jb250cmFjdCI6ImFyZW5hLmluZ2VzdC5jb3BpZXItY2FuZGlkYXRlLXByb2plY3Rpb24tc2hhMjU2LW11bHRpc2V0LmRvbWFpbi1jb3VudC1maXhlZC1ieXRlc0AxIiwiY2FuZGlkYXRlX3Byb2plY3Rpb25fZml4ZWRfbXVsdGlzZXRfc2hhMjU2IjoiY2E5ZDdkOWJlOWIyYTg0ZTJhZDM5YTk3NTU0OWM2MmY0ZmFlZWQwODJlY2Q5MmVlNDk2ZDNhOGYyNjUyMjVkMyIsImNvbnRyYWN0IjoiYXJlbmEuaW5nZXN0LmNvcGllci1wcm9qZWN0aW9uLWxlZGdlckAxIiwicGFyc2VyX2NvbnNlcnZhdGlvbl9zaGEyNTYiOiI0YTg3MDFkYWQ2ZmMxNzI2MTAyZGQ2MzgwZTE1ZTUyNGMwMGIwMTlkNGQ2MDEzOWUwMmI1MWUxNWIwNGZlODA3IiwicGFyc2VyX2NvbnRleHQiOnsiY3VycmVuY3kiOiJVU0RUIiwibWV0YSI6e30sInNjcmFwZWRBdCI6IjIwMjYtMDgtMDRUMTI6MDA6MDEuMDAwWiIsInNvdXJjZVNsdWciOiJiaW5neF9mdXR1cmVzIiwidGZMYWJlbE1hcCI6e319LCJwcm9qZWN0aW9uX2VuY29kaW5nX2NvbnRyYWN0IjoiYXJlbmEuaW5nZXN0Lmxlbmd0aC1wcmVmaXhlZC11dGY4Lm5vbm5lZ2F0aXZlLWludDMyYmVAMSIsInByb2plY3Rpb25fdHVwbGVfY29udHJhY3QiOiJhcmVuYS5pbmdlc3QuY29waWVyLXByb2plY3Rpb24tdHVwbGVAMSIsInJvd19jb3VudCI6MSwicm93cyI6W3siY2FuZGlkYXRlX29yZGluYWwiOjEsInByb2plY3Rpb24iOnsiY29udHJhY3QiOiJhcmVuYS5pbmdlc3QuY29waWVyLXByb2plY3Rpb24tdHVwbGVAMSIsImNvcGllcl9pbnZlc3RlZCI6IjEwIiwiY29waWVyX2xhYmVsIjoicHJpdmF0ZS1hIiwiY29waWVyX3BubCI6IjEuMjUiLCJjb3B5X2R1cmF0aW9uX2RheXMiOiIyIiwiZGVkdXBlX2hhc2giOiJiMzY3OTAxOTM3MWNhYTEyYjYzYWRhZjcxNzg0NzJlMzU1ZmFkNTQ0Iiwic291cmNlX2NhbmRpZGF0ZV9zaGEyNTYiOiI0YmUzZTY5NTI3OGU0MDU0M2E5OWMyM2M2OGIyZWM2ODM1OTEwYzUxNmY3ZTFiNDBlM2IxZmJhOGQ0MTQzM2U5Iiwic291cmNlX2V2ZW50X2F0IjpudWxsfSwicHJvamVjdGlvbl9zaGEyNTYiOiI2MTMzZWE2NTBjZGY2YmE3MTRmMmEwM2FmNjQ1MzNhNTQzZmQ1MjA5ZTBhMDJkZTA1ZWQ1MTZkMDgxMTRiMGYzIiwicm93X29yZGluYWwiOjAsInNvdXJjZV9jYW5kaWRhdGVfc2hhMjU2IjoiNGJlM2U2OTUyNzhlNDA1NDNhOTljMjNjNjhiMmVjNjgzNTkxMGM1MTZmN2UxYjQwZTNiMWZiYThkNDE0MzNlOSIsInNvdXJjZV9wYWdlX29yZGluYWwiOjF9XSwic2VyaWFsaXphdGlvbl9jb250cmFjdCI6ImFyZW5hLnN0cmljdC1jYW5vbmljYWwtanNvbkAxIiwic25hcHNob3RfYXJ0aWZhY3RfY29udHJhY3QiOiJhcmVuYS5pbmdlc3QuY29waWVyLXNuYXBzaG90LWFydGlmYWN0QDEiLCJzbmFwc2hvdF9zb3VyY2VfcnVuX2lkIjoiZjk5MzBjM2M4ZTRkYzE5M2ZkNGU1NmQxMzg0ZDFmN2U0ODA5NzFkZTBhZDc3YTU3NDA0MmM0ZWQ3ZGNmNzIzYSIsInNvdXJjZV9jYW5kaWRhdGVfZml4ZWRfbXVsdGlzZXRfY29udHJhY3QiOiJhcmVuYS5pbmdlc3QuY29waWVyLXNvdXJjZS1jYW5kaWRhdGUtc2hhMjU2LW11bHRpc2V0LmRvbWFpbi1jb3VudC1maXhlZC1ieXRlc0AxIiwic291cmNlX2NhbmRpZGF0ZV9maXhlZF9tdWx0aXNldF9zaGEyNTYiOiI3Y2E2Y2M3YjU5ZDgzY2NhMTUzMTkyZWJjMmNlYTNkMzg0OGNhMTczNzI1NmMxOTg0Y2U0NmRiNWJjNzVjZDk2In0=')"
GOLDEN_OUTER="b38e365a6287ca9ad897ab99f5870553319fb3a9f0e18dbd200af07610a6470a"

OUTER="$(install_raw 100 1 101 tier_c "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$PROJECTION")"
assert_equal 'fixed outer canonical preimage SHA-256' "$GOLDEN_OUTER" "$OUTER"
assert_equal 'RAW meta exact 17/9-key shape' '17|9' "$(psql_cmd -Atqc \
  "SELECT (SELECT count(*) FROM jsonb_object_keys(meta)) || '|' ||
          (SELECT count(*) FROM jsonb_object_keys(meta->'raw_integrity'))
     FROM arena.raw_objects WHERE id=100")"
FIRST_RESULT="$(publish_result 100 1 101 tier_c "$OUTER" "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$PROJECTION")"
assert_equal 'golden atomic publication receipt' \
  "1|101|tier_c|100|$OUTER|2026-08-04T12:00:01.000Z|1|unknown|false|false|true" \
  "$FIRST_RESULT"
assert_equal 'exact retry receipt and current head' \
  "1|101|tier_c|100|$OUTER|2026-08-04T12:00:01.000Z|1|unknown|false|true|true" \
  "$(publish_result 100 1 101 tier_c "$OUTER" "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$PROJECTION")"
assert_equal 'hostile extra_float_digits helper isolation' '0.1|-0.000000123' \
  "$(psql_cmd -Atqc "SET standard_conforming_strings=off;
    SET extra_float_digits=-15;
    SELECT arena.copier_snapshot_trust_float8_plain_decimal_v2('0.10000000000000001')||'|'||
           arena.copier_snapshot_trust_float8_plain_decimal_v2('-0.000000123')")"
assert_equal 'hostile session GUC exact retry isolation' \
  "1|101|tier_c|100|$OUTER|2026-08-04T12:00:01.000Z|1|unknown|false|true|true" \
  "$(psql_cmd -Atq -v outer="$OUTER" -v snapshot="$SNAPSHOT" -v candidate="$CANDIDATE" \
      -v parser="$PARSER" -v projection="$PROJECTION" <<'SQL'
SET ROLE service_role;
SET standard_conforming_strings=off;
SET extra_float_digits=-15;
SELECT source_id||'|'||trader_id||'|'||lane||'|'||raw_object_id_at_publication||'|'||
       outer_source_run_id||'|'||to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')||'|'||
       parsed_row_count||'|'||coverage_state||'|'||rank_eligible||'|'||replayed||'|'||is_current_head
FROM arena.publish_copier_snapshot_trust_v2(
  100::bigint,1::smallint,101::bigint,'tier_c',:'outer',
  :'snapshot',:'candidate',:'parser',:'projection');
SQL
)"

# Byte-level canonical text and child swaps fail against the independently
# addressed RAW anchor before jsonb parsing.
expect_publish_failure 'canonical-text whitespace tamper' 'RAW byte anchor' \
  100 1 101 tier_c "$OUTER" "$SNAPSHOT " "$CANDIDATE" "$PARSER" "$PROJECTION"
expect_publish_failure 'outer SHA tamper' 'RAW byte anchor' \
  100 1 101 tier_c "${OUTER%?}0" "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$PROJECTION"

# Re-anchor malicious but syntactically valid containers to prove PostgreSQL's
# projection replay, rather than only the immutable outer digest.
COUNT_PROJECTION="${PROJECTION/\"row_count\":1/\"row_count\":2}"
COUNT_OUTER="$(install_raw 110 1 101 tier_c "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$COUNT_PROJECTION")"
expect_publish_failure 'projection count omission' 'projection child binding failed' \
  110 1 101 tier_c "$COUNT_OUTER" "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$COUNT_PROJECTION"

REORDERED_PROJECTION="${PROJECTION/\"row_ordinal\":0/\"row_ordinal\":1}"
REORDERED_OUTER="$(install_raw 111 1 101 tier_c "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$REORDERED_PROJECTION")"
expect_publish_failure 'projection reorder' 'projection row shape failed' \
  111 1 101 tier_c "$REORDERED_OUTER" "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$REORDERED_PROJECTION"

HASH_PROJECTION="${PROJECTION/6133ea650cdf6ba714f2a03af64533a543fd5209e0a02de05ed516d08114b0f3/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff}"
HASH_OUTER="$(install_raw 112 1 101 tier_c "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$HASH_PROJECTION")"
expect_publish_failure 'projection tuple hash fabrication' 'tuple hash' \
  112 1 101 tier_c "$HASH_OUTER" "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$HASH_PROJECTION"

DOMAIN_PROJECTION="${PROJECTION/7ca6cc7b59d83cca153192ebc2cea3d3848ca1737256c1984ce46db5bc75cd96/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff}"
DOMAIN_OUTER="$(install_raw 113 1 101 tier_c "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$DOMAIN_PROJECTION")"
expect_publish_failure 'fixed multiset domain/hash tamper' 'fixed-byte multiset replay failed' \
  113 1 101 tier_c "$DOMAIN_OUTER" "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$DOMAIN_PROJECTION"

# Explicit audit regressions: candidate page_count must equal pages.length and
# decimal text must be the shortest JavaScript Number round-trip spelling.
TWO_PAGE_SNAPSHOT="$(decode_fixture 'eyJjYWxsZXJfbGltaXRlZCI6ZmFsc2UsImNvbnRyYWN0IjoiYXJlbmEuaW5nZXN0LmNvcGllci1zbmFwc2hvdC1hcnRpZmFjdEAxIiwibGFuZSI6InRpZXJfYyIsIm9ic2VydmVkX2F0IjoiMjAyNi0wOC0wNFQxMjowMDowMi4wMDBaIiwicGFnZV9jb3VudCI6MiwicGFnZXMiOlt7ImZldGNoZWRBdCI6IjIwMjYtMDgtMDRUMTI6MDA6MDEuMDAwWiIsInBhZ2VJbmRleCI6MSwicGF5bG9hZCI6eyJjb2RlIjowLCJkYXRhIjp7ImZvbGxvd2VyRGV0YWlsc1ZvTGlzdCI6W119fSwidXJsIjoiaHR0cHM6Ly9leGFtcGxlLnRlc3QvY29waWVycz9wYWdlPTEifSx7ImZldGNoZWRBdCI6IjIwMjYtMDgtMDRUMTI6MDA6MDIuMDAwWiIsInBhZ2VJbmRleCI6MiwicGF5bG9hZCI6eyJjb2RlIjowLCJkYXRhIjp7ImZvbGxvd2VyRGV0YWlsc1ZvTGlzdCI6W119fSwidXJsIjoiaHR0cHM6Ly9leGFtcGxlLnRlc3QvY29waWVycz9wYWdlPTIifV0sInJlcXVlc3RfdGltZWZyYW1lIjowLCJzY2FuX3Rlcm1pbmFsX3N0YXRlIjoic3RyZWFtX2V4aGF1c3RlZF91bnZlcmlmaWVkIiwic291cmNlIjp7ImNvcGllcl90YWJsZV9kZXB0aCI6ImZ1bGwiLCJjdXJyZW5jeSI6IlVTRFQiLCJmZXRjaF9yZWdpb24iOiJsb2NhbCIsImlkIjoxLCJzbHVnIjoiYmluZ3hfZnV0dXJlcyJ9LCJzb3VyY2VfcmVwb3J0ZWRfcm93X2NvdW50IjpudWxsLCJ0cmFkZXIiOnsiZXhjaGFuZ2VfdHJhZGVyX2lkIjoidHJhZGVyLTEwMSIsImlkIjoxMDF9fQ==')"
PAGE_COUNT_CANDIDATE="${CANDIDATE/\"page_count\":1/\"page_count\":2}"
PAGE_COUNT_OUTER="$(install_raw 114 1 101 tier_c "$TWO_PAGE_SNAPSHOT" "$PAGE_COUNT_CANDIDATE" "$PARSER" "$PROJECTION")"
expect_publish_failure 'candidate pages.length/page_count drift' 'candidate page count failed' \
  114 1 101 tier_c "$PAGE_COUNT_OUTER" "$TWO_PAGE_SNAPSHOT" "$PAGE_COUNT_CANDIDATE" "$PARSER" "$PROJECTION"

NON_SHORTEST_PROJECTION="${PROJECTION/\"copier_pnl\":\"1.25\"/\"copier_pnl\":\"0.10000000000000001\"}"
NON_SHORTEST_OUTER="$(install_raw 115 1 101 tier_c "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$NON_SHORTEST_PROJECTION")"
expect_publish_failure 'non-shortest JavaScript decimal' 'projection canonical text failed' \
  115 1 101 tier_c "$NON_SHORTEST_OUTER" "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$NON_SHORTEST_PROJECTION"

# Existing trader claim writes use both a JSON string and a JSON boolean.
# Exact retries must re-check either representation against live authority.
psql_cmd -q -c "UPDATE arena.traders SET meta='{\"claimed\":\"true\"}'::jsonb WHERE id=101"
expect_publish_failure 'string claimed trader' 'not an unclaimed source subject' \
  100 1 101 tier_c "$OUTER" "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$PROJECTION"
psql_cmd -q -c "UPDATE arena.traders SET meta='{\"claimed\":true}'::jsonb WHERE id=101"
expect_publish_failure 'boolean claimed trader' 'not an unclaimed source subject' \
  100 1 101 tier_c "$OUTER" "$SNAPSHOT" "$CANDIDATE" "$PARSER" "$PROJECTION"
