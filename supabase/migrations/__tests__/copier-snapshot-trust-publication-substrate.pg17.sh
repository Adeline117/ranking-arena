#!/usr/bin/env bash

# Disposable PostgreSQL 17 proof for the private artifact@2 copier publication substrate.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260808020000_copier_snapshot_trust_publication_substrate.sql"
V1_SUBSTRATE="$ROOT_DIR/supabase/migrations/20260804053000_copier_snapshot_publication_substrate.sql"
V1_PUBLISHER="$ROOT_DIR/supabase/migrations/20260804054000_publish_copier_snapshot_atomically.sql"
RAW_ROLE="$ROOT_DIR/supabase/migrations/20260808010000_copier_snapshot_trust_raw_role.sql"
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

TMP_ROOT="$(mktemp -d /tmp/copier-snapshot-trust-publication-pg17.XXXXXX)"
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
    sed -n '1,160p' "$log" >&2
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

legacy_v1_fingerprint() {
  psql_cmd -Atqc "
    WITH catalog_shape AS (
      SELECT pg_catalog.jsonb_build_object(
        'constraints', (SELECT pg_catalog.jsonb_agg(
          pg_catalog.pg_get_constraintdef(c.oid) ORDER BY r.relname,c.conname)
          FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class r ON r.oid=c.conrelid
          WHERE c.conrelid IN ('arena.copier_snapshot_publications'::regclass,'arena.copier_snapshot_rows'::regclass)),
        'columns', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
          r.relname,a.attnum,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod),
          a.attnotnull,a.attidentity,pg_catalog.pg_get_expr(d.adbin,d.adrelid))
          ORDER BY r.relname,a.attnum)
          FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class r ON r.oid=a.attrelid
          LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
          WHERE a.attnum>0 AND NOT a.attisdropped AND a.attrelid IN
          ('arena.copier_snapshot_publications'::regclass,'arena.copier_snapshot_rows'::regclass)),
        'indexes', (SELECT pg_catalog.jsonb_agg(pg_catalog.pg_get_indexdef(i.indexrelid)
          ORDER BY pg_catalog.pg_get_indexdef(i.indexrelid)) FROM pg_catalog.pg_index i
          WHERE i.indrelid IN ('arena.copier_snapshot_publications'::regclass,'arena.copier_snapshot_rows'::regclass)),
        'triggers', (SELECT pg_catalog.jsonb_agg(pg_catalog.pg_get_triggerdef(t.oid) ORDER BY t.tgname)
          FROM pg_catalog.pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid IN
          ('arena.copier_snapshot_publications'::regclass,'arena.copier_snapshot_rows'::regclass))
      ) AS value
    )
    SELECT pg_catalog.md5(pg_catalog.jsonb_build_object(
      'header_acl',h.relacl::text,'header_rls',h.relrowsecurity,'header_force',h.relforcerowsecurity,
      'row_acl',r.relacl::text,'row_rls',r.relrowsecurity,'row_force',r.relforcerowsecurity,
      'catalog',catalog_shape.value,'publisher',pg_catalog.pg_get_functiondef(p.oid),
      'publisher_acl',p.proacl::text,
      'headers',(SELECT pg_catalog.jsonb_agg(to_jsonb(x) ORDER BY publication_id) FROM arena.copier_snapshot_publications x),
      'rows',(SELECT pg_catalog.jsonb_agg(to_jsonb(x) ORDER BY publication_id,row_ordinal) FROM arena.copier_snapshot_rows x)
    )::text)
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
  id smallint PRIMARY KEY, slug text UNIQUE NOT NULL, currency text NOT NULL,
  copier_table_depth text NOT NULL, status text NOT NULL,
  serving_mode text NOT NULL, fetch_region text NOT NULL
);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY, source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL
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
CREATE TABLE arena.copier_records (
  trader_id bigint NOT NULL REFERENCES arena.traders(id), ts timestamptz NOT NULL,
  copier_label text, copier_pnl numeric, copier_invested numeric,
  copy_duration_days integer, currency text NOT NULL, dedupe_hash text NOT NULL, raw jsonb
);
ALTER TABLE arena.raw_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA arena FROM PUBLIC,anon,authenticated,service_role,outsider;
GRANT SELECT,INSERT ON arena.raw_objects TO service_role;
CREATE POLICY service_role_raw_write ON arena.raw_objects FOR ALL TO service_role
  USING (true) WITH CHECK (true);
INSERT INTO arena.sources VALUES (1,'gate','USDT','full','active','serving','local');
INSERT INTO arena.traders VALUES
  (101,1,'trader-101'),(102,1,'trader-102'),(103,1,'trader-103'),
  (104,1,'trader-104');
SQL

psql_cmd -q -f "$V1_SUBSTRATE"
psql_cmd -q -f "$V1_PUBLISHER"
V1_BODY="$(dd if="$V1_PUBLISHER" status=none; printf '%s' '__LEDGER_SENTINEL__')"
V1_BODY="${V1_BODY%__LEDGER_SENTINEL__}"
psql_cmd -q -v body="$V1_BODY" <<'SQL'
INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
VALUES ('20260804054000','publish_copier_snapshot_atomically',ARRAY[:'body']::text[]);
SQL
psql_cmd -q -f "$RAW_ROLE"
RAW_ROLE_BODY="$(dd if="$RAW_ROLE" status=none; printf '%s' '__LEDGER_SENTINEL__')"
RAW_ROLE_BODY="${RAW_ROLE_BODY%__LEDGER_SENTINEL__}"
psql_cmd -q -v body="$RAW_ROLE_BODY" <<'SQL'
INSERT INTO supabase_migrations.schema_migrations(version,name,statements)
VALUES ('20260808010000','wrong_copier_snapshot_trust_raw_role',ARRAY[:'body']::text[]);
SQL

expect_migration_failure 'wrong trust RAW role migration ledger' \
  'requires one exact copier_snapshot_trust_raw_role migration ledger name and body'
psql_cmd -q -c "UPDATE supabase_migrations.schema_migrations
  SET name='copier_snapshot_trust_raw_role' WHERE version='20260808010000'"

# Keep a populated v1 receipt/row and fingerprint its catalog, ACL, function,
# and data before installing the sibling @2 substrate.
psql_cmd -q <<'SQL'
INSERT INTO arena.raw_objects VALUES (
  1,1,'tier_c',101,NULL,statement_timestamp()-interval '2 days',
  'gate/copier_snapshot/tier_c/legacy.json.gz',100,repeat('f',64),false,
  '{}'::jsonb,repeat('f',64),'copier_snapshot'
);
INSERT INTO arena.copier_snapshot_publications (
  source_id,trader_id,lane,source_run_id,live_raw_object_id,
  raw_object_id_at_publication,raw_storage_path,raw_content_hash,
  raw_fetched_at,observed_at,scan_terminal_state,caller_limited,
  page_count,parsed_row_count,source_depth,currency,row_set_sha256,
  evidence_contract,privacy_contract,data_contract,parser_contract,
  row_hash_contract,publisher_contract
) VALUES (
  1,101,'tier_c',repeat('f',64),1,1,
  'gate/copier_snapshot/tier_c/legacy.json.gz',repeat('f',64),
  statement_timestamp()-interval '2 days',statement_timestamp()-interval '2 days',
  'stream_exhausted_unverified',false,1,1,'full','USDT',repeat('e',64),
  'arena.copier-snapshot-publication@1','arena.copier-histogram-k-anonymity@1',
  'arena.ingest.copier-snapshot-artifact@1','arena.ingest.copier-parser@1',
  'arena.ingest.copier-row-set.pg-jsonb-row-hashes@1',
  'arena.ingest.copier-snapshot-publisher@1'
);
INSERT INTO arena.copier_snapshot_rows VALUES (
  1,0,NULL,'legacy-private',1.5,10,2,'legacy-row',repeat('d',64)
);
SQL

LEGACY_BEFORE="$(legacy_v1_fingerprint)"
[[ -n "$LEGACY_BEFORE" ]] || { echo 'legacy v1 fingerprint was empty' >&2; exit 1; }
psql_cmd -q -f "$MIGRATION"
assert_equal 'legacy v1 fingerprint after substrate migration' \
  "$LEGACY_BEFORE" "$(legacy_v1_fingerprint)"

RAW_PROTECT_FINGERPRINT="$(psql_cmd -Atqc "
  SELECT concat_ws('|',p.proowner::regrole::text,p.prosecdef,
    p.proconfig=ARRAY['search_path=pg_catalog, pg_temp','row_security=off']::text[],
    has_function_privilege('anon',p.oid,'EXECUTE'),
    has_function_privilege('authenticated',p.oid,'EXECUTE'),
    has_function_privilege('service_role',p.oid,'EXECUTE'))
  FROM pg_catalog.pg_proc p
  WHERE p.oid='arena.protect_copier_snapshot_trust_raw_object()'::regprocedure")"
assert_equal 'RAW protect SECURITY DEFINER/ACL fingerprint' \
  'postgres|t|t|f|f|f' "$RAW_PROTECT_FINGERPRINT"

# Both the old and new RAW triggers must remain no-ops for an unbound legacy
# pointer when the postgres owner performs ordinary maintenance.
psql_cmd -q <<'SQL'
INSERT INTO arena.raw_objects VALUES (
  300,1,'tier_c',101,NULL,statement_timestamp()-interval '1 day',
  'gate/copier_snapshot/tier_c/unbound-old.json.gz',100,repeat('c',64),false,
  '{}'::jsonb,repeat('c',64),'copier_snapshot'
);
UPDATE arena.raw_objects SET meta='{"ordinary_owner_maintenance":true}'::jsonb
 WHERE id=300;
DELETE FROM arena.raw_objects WHERE id=300;
DO $assert_old_raw$
BEGIN
  IF EXISTS (SELECT 1 FROM arena.raw_objects WHERE id=300) THEN
    RAISE EXCEPTION 'postgres owner ordinary old RAW DML regressed';
  END IF;
END $assert_old_raw$;
SQL

# Test-only owner helper: the migration itself intentionally exposes no writer.
psql_cmd -q <<'SQL'
CREATE FUNCTION arena.test_insert_copier_snapshot_trust_publication(
  p_trader_id bigint, p_lane text, p_raw_id bigint, p_previous bigint,
  p_depth text, p_coverage text, p_rank boolean, p_row_count integer
) RETURNS bigint LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $f$
DECLARE
  r arena.raw_objects%ROWTYPE;
  exchange_id text;
  result_id bigint;
BEGIN
  SELECT * INTO STRICT r FROM arena.raw_objects WHERE id=p_raw_id;
  SELECT exchange_trader_id INTO STRICT exchange_id FROM arena.traders WHERE id=p_trader_id;
  INSERT INTO arena.copier_snapshot_trust_publications (
    source_id,trader_id,lane,outer_source_run_id,live_raw_object_id,
    raw_object_id_at_publication,raw_storage_path,raw_content_hash,raw_fetched_at,
    observed_at,previous_publication_id,source_slug_at_publication,
    exchange_trader_id_at_publication,adapter_slug,product_type,currency,
    source_depth_at_publication,request_timeframe,scan_terminal_state,caller_limited,
    source_reported_row_count,page_count,observed_candidate_count,parsed_row_count,
    snapshot_source_run_id,candidate_ledger_sha256,parser_conservation_sha256,
    projection_ledger_sha256,source_candidate_fixed_multiset_sha256,
    candidate_projection_fixed_multiset_sha256,raw_artifact_role,evidence_contract,
    serialization_contract,data_contract,snapshot_artifact_contract,
    candidate_ledger_contract,parser_conservation_contract,projection_ledger_contract,
    candidate_locator_contract,parser_contract,projection_tuple_contract,
    projection_encoding_contract,source_candidate_fixed_multiset_contract,
    candidate_projection_fixed_multiset_contract,occurrence_policy_contract,
    publisher_contract,coverage_state,rank_eligible
  ) VALUES (
    1,p_trader_id,p_lane,r.source_run_id,r.id,r.id,r.storage_path,r.content_hash,
    r.fetched_at,r.fetched_at,p_previous,'gate',exchange_id,'gate','futures','USDT',
    p_depth,CASE WHEN p_lane='tier_b' THEN NULL ELSE 30 END,
    CASE WHEN p_coverage='partial' THEN 'caller_limited'
         ELSE 'stream_exhausted_unverified' END,
    p_coverage='partial',NULL,1,p_row_count,p_row_count,
    repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),repeat('5',64),
    repeat('6',64),'copier_snapshot_trust',
    'arena.copier-snapshot-publication-evidence@2','arena.strict-canonical-json@1',
    'arena.ingest.copier-snapshot-artifact@2','arena.ingest.copier-snapshot-artifact@1',
    'arena.ingest.copier-candidate-ledger@1',
    'arena.ingest.copier-parser-conservation@1',
    'arena.ingest.copier-projection-ledger@1',
    'arena.ingest.copier-candidate-locator.gate@1',
    'arena.ingest.copier-parser.gate@1','arena.ingest.copier-projection-tuple@1',
    'arena.ingest.length-prefixed-utf8.nonnegative-int32be@1',
    'arena.ingest.copier-source-candidate-sha256-multiset.domain-count-fixed-bytes@1',
    'arena.ingest.copier-candidate-projection-sha256-multiset.domain-count-fixed-bytes@1',
    'arena.ingest.copier-occurrence-uniqueness.reject-batch@1',
    'arena.ingest.copier-snapshot-publisher@2',p_coverage,p_rank
  ) RETURNING publication_id INTO result_id;
  RETURN result_id;
END $f$;

WITH fixture(id,trader_id,lane,age) AS (VALUES
  (101::bigint,101::bigint,'tier_b'::text,interval '10 hours'),
  (102,101,'tier_b',interval '9 hours'),(103,101,'tier_c',interval '8 hours'),
  (104,101,'tier_b',interval '7 hours'),(105,101,'tier_b',interval '6 hours'),
  (106,101,'tier_c',interval '5 hours'),(107,101,'tier_b',interval '11 hours'),
  (201,102,'tier_b',interval '4 hours'),(202,103,'tier_b',interval '3 hours'),
  (203,103,'tier_b',interval '2 hours'),(204,104,'tier_b',interval '1 hour')
)
INSERT INTO arena.raw_objects
SELECT id,1,CASE lane WHEN 'tier_b' THEN 'history:copiers' ELSE 'tier_c' END,
       trader_id,NULL,statement_timestamp()-age,
       'gate/copier_snapshot_trust/'||lane||'/'||lpad(id::text,64,'0')||
       '/copier_snapshot_trust_'||lpad(id::text,64,'0')||'.json.gz',
       100,lpad(id::text,64,'0'),false,'{}'::jsonb,lpad(id::text,64,'0'),
       'copier_snapshot_trust'
FROM fixture;
SQL

# The insert validator's FOR SHARE lock must conflict with a non-key RAW
# update. Hold the publication transaction open, prove the updater is waiting
# on a lock, then prove it rechecks after commit and is rejected by protection.
HOLDER_LOG="$TMP_ROOT/publication-lock-holder.log"
UPDATER_LOG="$TMP_ROOT/raw-concurrent-updater.log"
(
  export PGAPPNAME='copier-trust-publication-lock-holder'
  psql_cmd -q >"$HOLDER_LOG" 2>&1 <<'SQL'
BEGIN;
SELECT arena.test_insert_copier_snapshot_trust_publication(
  104,'tier_b',204,NULL,'full','unknown',false,0
);
SELECT pg_catalog.pg_sleep(3);
COMMIT;
SQL
) &
HOLDER_PID=$!

HOLDER_READY=0
for _ in {1..100}; do
  if [[ "$(psql_cmd -Atqc "
    SELECT count(*) FROM pg_catalog.pg_stat_activity
    WHERE application_name='copier-trust-publication-lock-holder'
      AND state='active' AND query LIKE '%pg_sleep(3)%'")" == '1' ]]; then
    HOLDER_READY=1
    break
  fi
  sleep 0.05
done
assert_equal 'publication FOR SHARE holder did not become ready' '1' "$HOLDER_READY"

(
  export PGAPPNAME='copier-trust-raw-concurrent-updater'
  psql_cmd -v VERBOSITY=verbose \
    -c "UPDATE arena.raw_objects SET content_hash=repeat('e',64) WHERE id=204" \
    >"$UPDATER_LOG" 2>&1
) &
UPDATER_PID=$!

UPDATER_BLOCKED=0
for _ in {1..100}; do
  if [[ "$(psql_cmd -Atqc "
    SELECT count(*) FROM pg_catalog.pg_stat_activity
    WHERE application_name='copier-trust-raw-concurrent-updater'
      AND state='active' AND wait_event_type='Lock'")" == '1' ]]; then
    UPDATER_BLOCKED=1
    break
  fi
  sleep 0.05
done
assert_equal 'concurrent RAW updater blocked by publication FOR SHARE' \
  '1' "$UPDATER_BLOCKED"

wait "$HOLDER_PID"
set +e
wait "$UPDATER_PID"
UPDATER_STATUS=$?
set -e
if ((UPDATER_STATUS == 0)) || ! rg -Fq \
  'copier snapshot trust RAW evidence 204 cannot be mutated' "$UPDATER_LOG"; then
  echo 'concurrent RAW updater rejected after publication commit proof failed' >&2
  sed -n '1,160p' "$UPDATER_LOG" >&2
  exit 1
fi
assert_equal 'concurrent RAW updater changed protected content hash' \
  "$(printf '%064d' 204)" \
  "$(psql_cmd -Atqc 'SELECT content_hash FROM arena.raw_objects WHERE id=204')"

PUB_ROOT="$(psql_cmd -Atqc \
  "SELECT arena.test_insert_copier_snapshot_trust_publication(101,'tier_b',101,NULL,'full','unknown',false,1)")"
PUB_SUCCESSOR="$(psql_cmd -Atqc \
  "SELECT arena.test_insert_copier_snapshot_trust_publication(101,'tier_b',102,$PUB_ROOT,'full','unknown',false,1)")"
PUB_TIER_C="$(psql_cmd -Atqc \
  "SELECT arena.test_insert_copier_snapshot_trust_publication(101,'tier_c',103,NULL,'top10','partial',false,1)")"
PUB_BATCH="$(psql_cmd -Atqc \
  "SELECT arena.test_insert_copier_snapshot_trust_publication(102,'tier_b',201,NULL,'full','unknown',false,2)")"

expect_failure_contains 'duplicate publication idempotency identity' \
  'uq_copier_snapshot_trust_publication_outer' \
  "SELECT arena.test_insert_copier_snapshot_trust_publication(101,'tier_b',101,NULL,'full','unknown',false,1)"
expect_failure_contains 'second lane root' \
  'uidx_copier_snapshot_trust_publication_root' \
  "SELECT arena.test_insert_copier_snapshot_trust_publication(101,'tier_b',104,NULL,'full','unknown',false,0)"
expect_failure_contains 'publication fork' \
  'uidx_copier_snapshot_trust_publication_predecessor' \
  "SELECT arena.test_insert_copier_snapshot_trust_publication(101,'tier_b',105,$PUB_ROOT,'full','unknown',false,0)"
expect_failure_contains 'cross-lane predecessor' \
  'predecessor must belong to the same lane' \
  "SELECT arena.test_insert_copier_snapshot_trust_publication(101,'tier_c',106,$PUB_SUCCESSOR,'full','unknown',false,0)"
expect_failure_contains 'stale successor clock' \
  'successor clock must increase' \
  "SELECT arena.test_insert_copier_snapshot_trust_publication(101,'tier_b',107,$PUB_SUCCESSOR,'full','unknown',false,0)"
expect_failure_contains 'complete coverage claim' \
  'copier_snapshot_trust_publication_coverage_shape' \
  "SELECT arena.test_insert_copier_snapshot_trust_publication(103,'tier_b',202,NULL,'full','complete',false,0)"
expect_failure_contains 'rank eligibility claim' 'rank_eligible_check' \
  "SELECT arena.test_insert_copier_snapshot_trust_publication(103,'tier_b',203,NULL,'full','unknown',true,0)"

psql_cmd -q -c "
  INSERT INTO arena.copier_snapshot_trust_rows VALUES (
    $PUB_ROOT,0,1,1,repeat('a',64),repeat('b',64),NULL,
    'private-a','0.0000001','10.5','30','dedupe-a'
  )"
expect_failure_contains 'duplicate source occurrence' \
  'uq_copier_snapshot_trust_row_source_candidate' \
  "INSERT INTO arena.copier_snapshot_trust_rows VALUES ($PUB_ROOT,1,1,2,repeat('a',64),repeat('c',64),NULL,'private-b','1','2','3','dedupe-b')"
expect_failure_contains 'duplicate projection occurrence' \
  'uq_copier_snapshot_trust_row_projection' \
  "INSERT INTO arena.copier_snapshot_trust_rows VALUES ($PUB_ROOT,1,1,2,repeat('c',64),repeat('b',64),NULL,'private-b','1','2','3','dedupe-b')"
expect_failure_contains 'duplicate source occurrence whole batch' \
  'uq_copier_snapshot_trust_row_source_candidate' \
  "INSERT INTO arena.copier_snapshot_trust_rows VALUES ($PUB_BATCH,0,1,1,repeat('7',64),repeat('8',64),NULL,'one','1','2','3','one'),($PUB_BATCH,1,1,2,repeat('7',64),repeat('9',64),NULL,'two','4','5','6','two')"
assert_equal 'duplicate occurrence batch was not rejected atomically' '0' \
  "$(psql_cmd -Atqc "SELECT count(*) FROM arena.copier_snapshot_trust_rows WHERE publication_id=$PUB_BATCH")"
expect_failure_contains 'noncanonical decimal projection text' \
  'copier_snapshot_trust_rows_copier_pnl_text_check' \
  "INSERT INTO arena.copier_snapshot_trust_rows VALUES ($PUB_TIER_C,0,1,1,repeat('c',64),repeat('d',64),NULL,'private-c','1e-7','2','3','dedupe-c')"
expect_failure_contains 'non-null projection source event' \
  'copier_snapshot_trust_rows_source_event_at_check' \
  "INSERT INTO arena.copier_snapshot_trust_rows VALUES ($PUB_TIER_C,0,1,1,repeat('c',64),repeat('d',64),statement_timestamp(),'private-c','1','2','3','dedupe-c')"

expect_failure_contains 'publication receipt mutation' 'publication receipts are immutable' \
  "UPDATE arena.copier_snapshot_trust_publications SET parsed_row_count=2 WHERE publication_id=$PUB_ROOT"
expect_failure_contains 'publication receipt deletion' 'publication receipts are immutable' \
  "DELETE FROM arena.copier_snapshot_trust_publications WHERE publication_id=$PUB_ROOT"
expect_failure_contains 'publication receipt truncate' 'are immutable' \
  'TRUNCATE arena.copier_snapshot_trust_publications, arena.copier_snapshot_trust_rows'
expect_failure_contains 'publication row mutation' 'publication rows are immutable' \
  "UPDATE arena.copier_snapshot_trust_rows SET copier_pnl_text='2' WHERE publication_id=$PUB_ROOT"
expect_failure_contains 'publication row truncate' 'publication rows are immutable' \
  'TRUNCATE arena.copier_snapshot_trust_rows'

expect_failure_contains 'private API table ACL' \
  'permission denied for table copier_snapshot_trust_publications' \
  'SET ROLE service_role; SELECT * FROM arena.copier_snapshot_trust_publications'
expect_failure_contains 'private browser row ACL' \
  'permission denied for table copier_snapshot_trust_rows' \
  'SET ROLE authenticated; INSERT INTO arena.copier_snapshot_trust_rows DEFAULT VALUES'
ACL_RESULT="$(psql_cmd -Atqc "
  SELECT concat_ws('|',
    has_table_privilege('anon','arena.copier_snapshot_trust_publications','SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
    has_table_privilege('authenticated','arena.copier_snapshot_trust_publications','SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
    has_table_privilege('service_role','arena.copier_snapshot_trust_publications','SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
    has_table_privilege('anon','arena.copier_snapshot_trust_rows','SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
    has_table_privilege('authenticated','arena.copier_snapshot_trust_rows','SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
    has_table_privilege('service_role','arena.copier_snapshot_trust_rows','SELECT,INSERT,UPDATE,DELETE,TRUNCATE'),
    (SELECT count(*) FROM pg_catalog.pg_policy WHERE polrelid IN
      ('arena.copier_snapshot_trust_publications'::regclass,'arena.copier_snapshot_trust_rows'::regclass)))")"
assert_equal 'private API table ACL and policy count' 'f|f|f|f|f|f|0' "$ACL_RESULT"

expect_failure_contains 'bound trust RAW identity mutation' \
  'RAW evidence 103 cannot be mutated' \
  "UPDATE arena.raw_objects SET content_hash=repeat('a',64) WHERE id=103"
psql_cmd -q -c 'UPDATE arena.raw_objects SET quarantined=true WHERE id=102'
expect_failure_contains 'quarantined trust RAW delete' \
  'quarantined copier snapshot trust RAW evidence cannot be deleted' \
  'DELETE FROM arena.raw_objects WHERE id=102'

psql_cmd -q -c 'DELETE FROM arena.raw_objects WHERE id=101'
GC_RESULT="$(psql_cmd -Atqc "
  SELECT coalesce(live_raw_object_id::text,'NULL')||'|'||
         raw_object_id_at_publication::text||'|'||raw_storage_path||'|'||raw_content_hash
  FROM arena.copier_snapshot_trust_publications WHERE publication_id=$PUB_ROOT")"
OUTER_101="$(printf '%064d' 101)"
assert_equal 'ordinary RAW GC tombstone' \
  "NULL|101|gate/copier_snapshot_trust/tier_b/$OUTER_101/copier_snapshot_trust_$OUTER_101.json.gz|$OUTER_101" \
  "$GC_RESULT"

assert_equal 'legacy v1 fingerprint after all artifact@2 proof writes' \
  "$LEGACY_BEFORE" "$(legacy_v1_fingerprint)"

echo 'copier snapshot trust publication substrate PostgreSQL 17 proof passed'
