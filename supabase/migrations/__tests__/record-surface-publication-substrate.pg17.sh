#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the private record publication substrate.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803100000_record_surface_publication_substrate.sql"
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

TMP_ROOT="$(mktemp -d /tmp/record-surface-publication-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((61000 + ($$ % 2000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    echo "[record-publication] PostgreSQL log tail:" >&2
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
    echo "[record-publication] Expected failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[record-publication] Unexpected failure for $label" >&2
    sed -n '1,160p' "$failure_log" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth=trust --username=postgres >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -k $SOCKET_DIR -p $PORT" -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  GRANT SELECT ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA arena
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;

CREATE TABLE arena.sources (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE
);
CREATE TABLE arena.traders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE CASCADE,
  exchange_trader_id text NOT NULL,
  UNIQUE (source_id, exchange_trader_id)
);
CREATE TABLE arena.raw_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE CASCADE,
  job_type text NOT NULL,
  trader_id bigint,
  timeframe smallint,
  fetched_at timestamptz NOT NULL,
  storage_path text NOT NULL UNIQUE,
  bytes integer NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}',
  source_run_id text,
  trust_artifact_role text
);
CREATE TABLE arena.position_history (
  trader_id bigint NOT NULL REFERENCES arena.traders(id) ON DELETE CASCADE,
  opened_at timestamptz,
  closed_at timestamptz,
  symbol text NOT NULL,
  side text,
  leverage numeric,
  size numeric,
  entry_price numeric,
  exit_price numeric,
  realized_pnl numeric,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb
) PARTITION BY RANGE (closed_at);
CREATE UNIQUE INDEX uq_arena_position_history_dedupe
  ON arena.position_history (closed_at, dedupe_hash);
CREATE TABLE arena.position_history_default
  PARTITION OF arena.position_history DEFAULT;
ALTER TABLE arena.position_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read position_history" ON arena.position_history
  FOR SELECT TO anon, authenticated USING (true);
SQL

psql_cmd -q -f "$MIGRATION"

echo "[record-publication] prove private schema, ACL, binding, and trigger contracts"
psql_cmd -q <<'SQL'
DO $contract$
DECLARE
  v_receipt oid := 'arena.record_surface_publications'::regclass;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class
    WHERE oid = v_receipt
      AND relowner = 'postgres'::regrole
      AND relrowsecurity
      AND relforcerowsecurity
  ) OR EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = v_receipt
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS table_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(table_row.relacl, pg_catalog.acldefault('r', table_row.relowner))
    ) AS expanded
    WHERE table_row.oid = v_receipt
      AND expanded.grantee <> table_row.relowner
  ) THEN
    RAISE EXCEPTION 'receipt privacy contract failed';
  END IF;

  IF pg_catalog.has_table_privilege('anon', 'arena.position_history', 'SELECT')
     OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.position_history', 'SELECT'
     )
     OR pg_catalog.has_table_privilege(
       'anon', 'arena.position_history_default', 'SELECT'
     )
     OR EXISTS (
       SELECT 1 FROM pg_catalog.pg_policy
       WHERE polrelid = 'arena.position_history'::regclass
     ) THEN
    RAISE EXCEPTION 'position-history direct read remained public';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'arena.position_history'::regclass
      AND conname = 'position_history_verified_publication_fkey'
      AND confrelid = v_receipt
      AND confdeltype = 'r'
      AND convalidated
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS class_row ON class_row.oid = index_row.indexrelid
    WHERE index_row.indrelid = 'arena.position_history'::regclass
      AND class_row.relname = 'idx_arena_position_history_verified_trader_page'
      AND pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid) =
          '(verified_publication_id IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION 'verified-row binding contract failed';
  END IF;

  IF pg_catalog.has_schema_privilege('anon', 'arena', 'CREATE')
     OR pg_catalog.has_schema_privilege('authenticated', 'arena', 'CREATE') THEN
    RAISE EXCEPTION 'API roles unexpectedly create Arena tables';
  END IF;
END
$contract$;

CREATE TABLE arena.future_private_table (id bigint);
DO $future_default$
BEGIN
  IF pg_catalog.has_table_privilege('anon', 'arena.future_private_table', 'SELECT')
     OR pg_catalog.has_table_privilege(
       'authenticated', 'arena.future_private_table', 'SELECT'
     ) THEN
    RAISE EXCEPTION 'future Arena table inherited public SELECT';
  END IF;
END
$future_default$;
DROP TABLE arena.future_private_table;
SQL

expect_failure_contains \
  "anon-parent-read" \
  "permission denied for table position_history" \
  "SET ROLE anon; SELECT * FROM arena.position_history"
expect_failure_contains \
  "authenticated-child-read" \
  "permission denied for table position_history_default" \
  "SET ROLE authenticated; SELECT * FROM arena.position_history_default"
expect_failure_contains \
  "service-receipt-read" \
  "permission denied for table record_surface_publications" \
  "SET ROLE service_role; SELECT * FROM arena.record_surface_publications"

psql_cmd -q <<'SQL'
INSERT INTO arena.sources (slug) VALUES ('binance_futures');
INSERT INTO arena.traders (source_id, exchange_trader_id)
VALUES (1, 'portfolio-1');
INSERT INTO arena.raw_objects (
  source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
  bytes, content_hash, quarantined, meta, source_run_id, trust_artifact_role
) VALUES (
  1, 'history:position_history', 1, NULL, statement_timestamp(),
  'binance_futures/history/run-a.json.gz', 100, repeat('a', 64), false,
  '{}', repeat('a', 64), 'event_history'
);

INSERT INTO arena.record_surface_publications (
  source_id, trader_id, surface, lane, source_run_id, raw_object_id,
  raw_storage_path, raw_content_hash, raw_fetched_at, observed_at,
  source_as_of, previous_publication_id, evidence_contract, data_contract,
  verifier_contract, publisher_contract, scan_terminal_state,
  starting_cursor, effective_cursor_after, overlap_event_at, page_count,
  parsed_row_count, row_set_sha256, termination
)
SELECT
  1, 1, 'position_history', 'tier_b', repeat('a', 64), raw.id,
  raw.storage_path, raw.content_hash, raw.fetched_at, raw.fetched_at,
  NULL, NULL, 'arena.position-history-publication-evidence@1',
  'arena.ingest.history-acquisition-artifact@1',
  'arena.ingest.history-terminal-verifier.test.position_history@1',
  'arena.ingest.position-history-publisher.worker@1', 'exhausted',
  NULL, '2026-08-02T00:00:00Z', NULL, 1, 1, repeat('b', 64),
  jsonb_build_object(
    'evidence_state', 'verified',
    'blocker_reasons', '[]'::jsonb,
    'scan_terminal_state', 'exhausted',
    'verifier_contract',
      'arena.ingest.history-terminal-verifier.test.position_history@1',
    'terminal_cursor_value', NULL,
    'overlap_event_at', NULL
  )
FROM arena.raw_objects AS raw
WHERE raw.source_run_id = repeat('a', 64);

INSERT INTO arena.position_history (
  trader_id, opened_at, closed_at, symbol, side, leverage, size,
  entry_price, exit_price, realized_pnl, currency, dedupe_hash, raw,
  verified_publication_id
) VALUES (
  1, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', 'BTCUSDT',
  'long', 2, 1, 100, 110, 10, 'USDT', 'position-1', '{}', 1
);
SQL

expect_failure_contains \
  "receipt-update" \
  "record surface publication receipts are immutable" \
  "UPDATE arena.record_surface_publications SET parsed_row_count = 2 WHERE publication_id = 1"
expect_failure_contains \
  "receipt-delete" \
  "record surface publication receipts are immutable" \
  "DELETE FROM arena.record_surface_publications WHERE publication_id = 1"
expect_failure_contains \
  "receipt-truncate" \
  "record surface publication receipts are immutable" \
  "TRUNCATE arena.record_surface_publications, arena.position_history"
expect_failure_contains \
  "missing-terminal-blockers" \
  "violates check constraint" \
  "INSERT INTO arena.record_surface_publications (source_id,trader_id,surface,lane,source_run_id,raw_storage_path,raw_content_hash,raw_fetched_at,observed_at,evidence_contract,data_contract,verifier_contract,publisher_contract,scan_terminal_state,page_count,parsed_row_count,row_set_sha256,termination) VALUES (1,1,'position_history','tier_b',repeat('c',64),'missing.json.gz',repeat('c',64),now(),now(),'arena.position-history-publication-evidence@1','arena.ingest.history-acquisition-artifact@1','arena.ingest.history-terminal-verifier.test.position_history@1','arena.ingest.position-history-publisher.worker@1','exhausted',1,0,repeat('d',64),jsonb_build_object('evidence_state','verified','scan_terminal_state','exhausted','verifier_contract','arena.ingest.history-terminal-verifier.test.position_history@1','terminal_cursor_value',NULL,'overlap_event_at',NULL))"
expect_failure_contains \
  "future-observation" \
  "violates check constraint" \
  "INSERT INTO arena.record_surface_publications (source_id,trader_id,surface,lane,source_run_id,raw_storage_path,raw_content_hash,raw_fetched_at,observed_at,evidence_contract,data_contract,verifier_contract,publisher_contract,scan_terminal_state,page_count,parsed_row_count,row_set_sha256,termination) VALUES (1,1,'position_history','tier_b',repeat('e',64),'future.json.gz',repeat('e',64),now()+interval '10 minutes',now()+interval '10 minutes','arena.position-history-publication-evidence@1','arena.ingest.history-acquisition-artifact@1','arena.ingest.history-terminal-verifier.test.position_history@1','arena.ingest.position-history-publisher.worker@1','exhausted',1,0,repeat('f',64),jsonb_build_object('evidence_state','verified','blocker_reasons','[]'::jsonb,'scan_terminal_state','exhausted','verifier_contract','arena.ingest.history-terminal-verifier.test.position_history@1','terminal_cursor_value',NULL,'overlap_event_at',NULL))"
expect_failure_contains \
  "missing-overlap-terminal-values" \
  "violates check constraint" \
  "INSERT INTO arena.record_surface_publications (source_id,trader_id,surface,lane,source_run_id,raw_storage_path,raw_content_hash,raw_fetched_at,observed_at,previous_publication_id,evidence_contract,data_contract,verifier_contract,publisher_contract,scan_terminal_state,starting_cursor,effective_cursor_after,overlap_event_at,page_count,parsed_row_count,row_set_sha256,termination) VALUES (1,1,'position_history','tier_b',repeat('1',64),'overlap.json.gz',repeat('1',64),now(),now(),1,'arena.position-history-publication-evidence@1','arena.ingest.history-acquisition-artifact@1','arena.ingest.history-terminal-verifier.test.position_history@1','arena.ingest.position-history-publisher.worker@1','cursor_overlap','2026-08-02T00:00:00Z','2026-08-03T00:00:00Z','2026-08-01T00:00:00Z',1,0,repeat('2',64),jsonb_build_object('evidence_state','verified','blocker_reasons','[]'::jsonb,'scan_terminal_state','cursor_overlap','verifier_contract','arena.ingest.history-terminal-verifier.test.position_history@1'))"

echo "[record-publication] prove normal GC tombstone survives"
psql_cmd -q <<'SQL'
DELETE FROM arena.raw_objects WHERE id = 1;
DO $gc$
BEGIN
  IF (SELECT count(*) FROM arena.record_surface_publications) <> 1
     OR (SELECT raw_object_id FROM arena.record_surface_publications
         WHERE publication_id = 1) IS NOT NULL
     OR (SELECT raw_storage_path FROM arena.record_surface_publications
         WHERE publication_id = 1) <> 'binance_futures/history/run-a.json.gz'
     OR (SELECT verified_publication_id FROM arena.position_history
         WHERE dedupe_hash = 'position-1') <> 1 THEN
    RAISE EXCEPTION 'normal RAW GC did not preserve receipt and row lineage';
  END IF;
END
$gc$;

INSERT INTO arena.raw_objects (
  source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
  bytes, content_hash, quarantined, meta, source_run_id, trust_artifact_role
) VALUES (
  1, 'history:position_history', 1, NULL, statement_timestamp(),
  'binance_futures/history/run-b.json.gz', 100, repeat('c', 64), false,
  '{}', repeat('c', 64), 'event_history'
);
INSERT INTO arena.record_surface_publications (
  source_id,trader_id,surface,lane,source_run_id,raw_object_id,
  raw_storage_path,raw_content_hash,raw_fetched_at,observed_at,
  previous_publication_id,evidence_contract,data_contract,verifier_contract,
  publisher_contract,scan_terminal_state,page_count,parsed_row_count,
  row_set_sha256,termination
)
SELECT 1,1,'position_history','history_backfill',repeat('c',64),id,
       storage_path,content_hash,fetched_at,fetched_at,1,
       'arena.position-history-publication-evidence@1',
       'arena.ingest.history-acquisition-artifact@1',
       'arena.ingest.history-terminal-verifier.test.position_history@1',
       'arena.ingest.position-history-publisher.worker@1','exhausted',1,0,
       repeat('d',64),jsonb_build_object(
         'evidence_state','verified','blocker_reasons','[]'::jsonb,
         'scan_terminal_state','exhausted','verifier_contract',
         'arena.ingest.history-terminal-verifier.test.position_history@1',
         'terminal_cursor_value',NULL,'overlap_event_at',NULL)
FROM arena.raw_objects WHERE source_run_id = repeat('c',64);
UPDATE arena.raw_objects SET quarantined = true WHERE source_run_id = repeat('c',64);
SQL

expect_failure_contains \
  "quarantined-raw-delete" \
  "quarantined record publication RAW evidence cannot be deleted" \
  "DELETE FROM arena.raw_objects WHERE source_run_id = repeat('c',64)"
expect_failure_contains \
  "bound-raw-meta-mutation" \
  "record publication RAW evidence" \
  "UPDATE arena.raw_objects SET meta = '{\"forged\":true}' WHERE source_run_id = repeat('c',64)"

FINGERPRINT_BEFORE="$(psql_cmd -Atq -c "SELECT (SELECT count(*) FROM arena.record_surface_publications) || '|' || (SELECT count(*) FROM arena.position_history) || '|' || (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid IN ('arena.record_surface_publications'::regclass,'arena.raw_objects'::regclass) AND NOT tgisinternal)")"
expect_failure_contains \
  "fail-closed-replay" \
  "record publication substrate is already or partially installed" \
  "\\i $MIGRATION"
FINGERPRINT_AFTER="$(psql_cmd -Atq -c "SELECT (SELECT count(*) FROM arena.record_surface_publications) || '|' || (SELECT count(*) FROM arena.position_history) || '|' || (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid IN ('arena.record_surface_publications'::regclass,'arena.raw_objects'::regclass) AND NOT tgisinternal)")"
if [[ "$FINGERPRINT_BEFORE" != "$FINGERPRINT_AFTER" ]]; then
  echo "[record-publication] fail-closed replay changed durable state" >&2
  exit 1
fi

echo "record surface publication substrate PostgreSQL 17 proof passed"
