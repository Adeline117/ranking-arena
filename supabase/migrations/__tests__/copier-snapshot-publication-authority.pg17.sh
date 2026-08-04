#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the 054000 copier snapshot writer,
# receipt-first reader, exact replay, privacy boundary, and quarantine rules.
# The separate 055000 wrapper opts into the irreversible cutover assertions.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SUBSTRATE="$ROOT_DIR/supabase/migrations/20260804053000_copier_snapshot_publication_substrate.sql"
AUTHORITY="$ROOT_DIR/supabase/migrations/20260804054000_copier_snapshot_publication_authority.sql"
CUTOVER="$ROOT_DIR/supabase/migrations/20260804055000_copier_snapshot_direct_write_cutover.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
PROOF_MODE="${COPIER_SNAPSHOT_PROOF_MODE:-authority}"

if [[ "$PROOF_MODE" != authority && "$PROOF_MODE" != cutover ]]; then
  echo "Unknown copier snapshot proof mode: $PROOF_MODE" >&2
  exit 2
fi

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

required_migrations=("$SUBSTRATE" "$AUTHORITY")
if [[ "$PROOF_MODE" == cutover ]]; then
  required_migrations+=("$CUTOVER")
fi
for migration in "${required_migrations[@]}"; do
  if [[ ! -f "$migration" ]]; then
    echo "Required migration not found: $migration" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/copier-snapshot-authority-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((61000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -220 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
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
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE outsider NOLOGIN NOBYPASSRLS;
CREATE SCHEMA arena AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA public, arena
  TO anon, authenticated, service_role, outsider;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  copier_table_depth text NOT NULL,
  currency text NOT NULL
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL
);

CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  job_type text NOT NULL,
  trader_id bigint,
  timeframe smallint,
  fetched_at timestamptz NOT NULL,
  storage_path text NOT NULL UNIQUE,
  bytes integer NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_run_id text,
  trust_artifact_role text
);

CREATE TABLE arena.copier_records (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  ts timestamptz NOT NULL,
  copier_label text,
  copier_pnl numeric,
  copier_invested numeric,
  copy_duration_days integer,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb
);

ALTER TABLE arena.raw_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE arena.copier_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA arena
  FROM PUBLIC, anon, authenticated, service_role, outsider;

INSERT INTO arena.sources (
  id, slug, status, serving_mode, copier_table_depth, currency
) VALUES
  (1, 'gate_futures', 'active', 'serving', 'full', 'USDT'),
  (2, 'no_copiers', 'active', 'serving', 'none', 'USDT');
INSERT INTO arena.traders (id, source_id, exchange_trader_id) VALUES
  (101, 1, 'zero-trader'),
  (102, 1, 'row-trader'),
  (103, 1, 'legacy-only'),
  (104, 2, 'not-applicable'),
  (105, 1, 'all-null-pnl');

INSERT INTO arena.copier_records (
  trader_id, ts, copier_label, copier_pnl, currency, dedupe_hash, raw
) VALUES (
  103, '2025-01-01 00:00:00+00', 'legacy-private', 999,
  'USDT', 'legacy-private', '{"email":"legacy@example.invalid"}'::jsonb
);

CREATE FUNCTION public.arena_copier_aggregate(p_source text, p_trader text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  -- arena.copier-aggregate-containment@1
  SELECT CASE WHEN p_source = 'gate_futures' THEN
    pg_catalog.jsonb_build_object(
      'copierCount', 99,
      'copierCountMax', NULL,
      'totalCopierPnl', 999,
      'currency', 'USDT',
      'depth', 'full',
      'asOf', NULL,
      'sourceAsOf', NULL,
      'observedAt', NULL,
      'publishedAt', NULL,
      'pnlDistribution', '[]'::jsonb
    )
  ELSE NULL END;
$function$;
ALTER FUNCTION public.arena_copier_aggregate(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_copier_aggregate(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)
  TO anon, authenticated, service_role;
SQL

psql_cmd -q -f "$SUBSTRATE"
psql_cmd -q -f "$AUTHORITY"

psql_cmd -q <<'SQL'
CREATE FUNCTION public.copier_fixture_request(
  p_source_id integer,
  p_trader_id bigint,
  p_raw_object_id bigint,
  p_source_run_id text,
  p_observed_at timestamptz,
  p_row_count integer,
  p_pnl_base numeric DEFAULT 10
) RETURNS jsonb
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'contract', 'arena.copier-snapshot-publication@1',
    'sourceId', p_source_id,
    'traderId', p_trader_id,
    'rawObjectId', p_raw_object_id,
    'sourceRunId', p_source_run_id,
    'observedAt', pg_catalog.to_char(
      p_observed_at AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ),
    'currency', 'USDT',
    'evidenceState', 'verified',
    'scanTerminalState', 'exhausted',
    'blockerReasons', '[]'::jsonb,
    'rows', COALESCE(
      (
        SELECT pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'ts', pg_catalog.to_char(
              (p_observed_at - (row_number || ' days')::interval)
                AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
            'copierLabel', 'private-' || row_number::text,
            'copierPnl', p_pnl_base * row_number,
            'copierInvested', 100 * row_number,
            'copyDurationDays', row_number,
            'dedupeHash', 'row-' || row_number::text,
            'raw', pg_catalog.jsonb_build_object(
              'email', 'private-' || row_number::text || '@example.invalid'
            )
          )
          ORDER BY row_number
        )
        FROM pg_catalog.generate_series(1, p_row_count) AS row_number
      ),
      '[]'::jsonb
    )
  );
$function$;

CREATE FUNCTION public.insert_copier_raw(
  p_id bigint,
  p_trader_id bigint,
  p_source_run_id text,
  p_observed_at timestamptz
) RETURNS void
LANGUAGE sql
SET search_path = pg_catalog, pg_temp
AS $function$
  INSERT INTO arena.raw_objects (
    id, source_id, job_type, trader_id, timeframe, fetched_at,
    storage_path, bytes, content_hash, quarantined, meta,
    source_run_id, trust_artifact_role
  ) VALUES (
    p_id, 1, 'history:copiers', p_trader_id, NULL, p_observed_at,
    'gate/history/' || p_source_run_id || '.json.gz', 100,
    p_source_run_id, false,
    pg_catalog.jsonb_build_object(
      'data_contract', 'arena.ingest.history-acquisition-artifact@1',
      'history_evidence_contract',
        'arena.event-history-publication-evidence@1',
      'source_run_id', p_source_run_id,
      'source_slug', 'gate_futures',
      'exchange_trader_id', (
        SELECT trader.exchange_trader_id
        FROM arena.traders AS trader
        WHERE trader.id = p_trader_id
      ),
      'observed_at', pg_catalog.to_char(
        p_observed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'history_kind', 'copiers',
      'starting_cursor', NULL,
      'capture_config', pg_catalog.jsonb_build_object(
        'caller_page_cap', NULL
      ),
      'terminal_evidence_state', 'verified',
      'scan_terminal_state', 'exhausted',
      'verifier_contract',
        'arena.ingest.history-terminal-verifier.gate.copiers@1',
      'page_count', 1,
      'termination', pg_catalog.jsonb_build_object(
        'evidence_state', 'verified',
        'claim_observations', pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'segment_id', 'gate_terminal',
            'reason', 'snapshot_complete',
            'page_ordinal', 1
          )
        ),
        'scan_terminal_state', 'exhausted',
        'terminal_cursor_value', NULL,
        'overlap_event_at', NULL,
        'verifier_contract',
          'arena.ingest.history-terminal-verifier.gate.copiers@1',
        'blocker_reasons', '[]'::jsonb
      )
    ),
    p_source_run_id, 'event_history'
  );
$function$;

SELECT public.insert_copier_raw(
  1, 101, repeat('a', 64), '2026-08-04 10:00:00+00'
);
SELECT public.insert_copier_raw(
  2, 102, repeat('b', 64), '2026-08-04 11:00:00+00'
);
SELECT public.insert_copier_raw(
  5, 101, repeat('e', 64), '2026-08-04 09:00:00+00'
);
SELECT public.insert_copier_raw(
  9, 105, repeat('f', 64), '2026-08-04 10:15:00+00'
);
SQL

LEGACY_BRIDGE="$(
  psql_cmd -Atqc "
    SELECT public.arena_copier_aggregate(
      'gate_futures', 'legacy-only'
    )->>'receiptBound';
  "
)"
assert_equal 'rolling bridge did not label legacy fallback' 'false' "$LEGACY_BRIDGE"

ZERO_REQUEST="public.copier_fixture_request(1,101,1,repeat('a',64),'2026-08-04 10:00:00+00',0)"
ZERO_RECEIPT="$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($ZERO_REQUEST)::text")"
ZERO_AGGREGATE="$(psql_cmd -Atqc "SELECT public.arena_copier_aggregate('gate_futures','zero-trader')::text")"

assert_equal \
  'measured zero receipt row count drifted' \
  '0' \
  "$(psql_cmd -Atqc "SELECT parsed_row_count FROM arena.copier_snapshot_publications WHERE source_run_id=repeat('a',64)")"
assert_equal \
  'measured zero aggregate did not mask legacy state' \
  'true|0|0|[]' \
  "$(psql_cmd -Atqc "SELECT (public.arena_copier_aggregate('gate_futures','zero-trader')->>'receiptBound') || '|' || (public.arena_copier_aggregate('gate_futures','zero-trader')->>'copierCount') || '|' || (public.arena_copier_aggregate('gate_futures','zero-trader')->>'totalCopierPnl') || '|' || (public.arena_copier_aggregate('gate_futures','zero-trader')->'pnlDistribution')::text")"

ZERO_REPLAY="$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($ZERO_REQUEST)::text")"
assert_equal 'exact zero replay minted a new receipt' "$ZERO_RECEIPT" "$ZERO_REPLAY"

expect_failure_contains \
  'verified projection accepted null blocker reasons' \
  'copier_snapshot_publication_verified_projection' \
  "SET session_replication_role=replica; UPDATE arena.copier_snapshot_publications SET blocker_reasons=NULL WHERE source_run_id=repeat('a',64)"

expect_failure_contains \
  'same source run accepted a different request' \
  'sourceRunId replay conflicts with its immutable request' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1(public.copier_fixture_request(1,101,1,repeat('a',64),'2026-08-04 10:00:00+00',1))"
expect_failure_contains \
  'fractional JSON source id was accepted' \
  'identifiers must be positive JSON integers' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1(pg_catalog.jsonb_set($ZERO_REQUEST,'{sourceId}','1.5'::jsonb))"
expect_failure_contains \
  'non-canonical observation clock was accepted' \
  'coordinates are outside their contract' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1(pg_catalog.jsonb_set($ZERO_REQUEST,'{observedAt}','\"2026-08-04T10:00:00+00:00\"'::jsonb))"
expect_failure_contains \
  'non-canonical row clock was accepted' \
  'numeric or clock value is invalid' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1(pg_catalog.jsonb_set(public.copier_fixture_request(1,101,1,repeat('a',64),'2026-08-04 10:00:00+00',1),'{rows,0,ts}','\"2026-08-03T10:00:00+00:00\"'::jsonb))"

EVIDENCE_REQUEST="public.copier_fixture_request(1,101,5,repeat('e',64),'2026-08-04 09:00:00+00',0)"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=meta-'data_contract' WHERE id=5"
expect_failure_contains \
  'missing RAW data contract was promoted' \
  'RAW pointer does not prove the exact verified acquisition' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($EVIDENCE_REQUEST)"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=meta || pg_catalog.jsonb_build_object('data_contract','arena.ingest.history-acquisition-artifact@1') WHERE id=5"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=pg_catalog.jsonb_set(meta,'{exchange_trader_id}','\"foreign-trader\"'::jsonb) WHERE id=5"
expect_failure_contains \
  'foreign RAW exchange identity was promoted' \
  'RAW pointer does not prove the exact verified acquisition' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($EVIDENCE_REQUEST)"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=pg_catalog.jsonb_set(meta,'{exchange_trader_id}','\"zero-trader\"'::jsonb) WHERE id=5"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=pg_catalog.jsonb_set(meta,'{capture_config,caller_page_cap}','2'::jsonb) WHERE id=5"
expect_failure_contains \
  'caller-limited RAW capture config was promoted' \
  'RAW pointer does not prove the exact verified acquisition' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($EVIDENCE_REQUEST)"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=pg_catalog.jsonb_set(meta,'{capture_config,caller_page_cap}','null'::jsonb) WHERE id=5"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=pg_catalog.jsonb_set(meta,'{termination,evidence_state}','\"self_asserted\"'::jsonb) WHERE id=5"
expect_failure_contains \
  'nested terminal evidence drift was promoted' \
  'RAW pointer does not prove the exact verified acquisition' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($EVIDENCE_REQUEST)"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=pg_catalog.jsonb_set(meta,'{termination,evidence_state}','\"verified\"'::jsonb) WHERE id=5"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=pg_catalog.jsonb_set(meta,'{termination,claim_observations,0,page_ordinal}','2'::jsonb) WHERE id=5"
expect_failure_contains \
  'terminal observation outside captured pages was promoted' \
  'terminal observation is outside captured pages' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($EVIDENCE_REQUEST)"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=pg_catalog.jsonb_set(meta,'{termination,claim_observations,0,page_ordinal}','1'::jsonb) WHERE id=5"
psql_cmd -q -c "UPDATE arena.raw_objects SET meta=pg_catalog.jsonb_set(meta,'{termination,unexpected}','true'::jsonb) WHERE id=5"
expect_failure_contains \
  'terminal claim with extra key was promoted' \
  'terminal claim keys are not exact' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($EVIDENCE_REQUEST)"

NULL_PNL_REQUEST="public.copier_fixture_request(1,105,9,repeat('f',64),'2026-08-04 10:15:00+00',3,NULL)"
psql_cmd -q -c "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($NULL_PNL_REQUEST)" >/dev/null
assert_equal \
  'all-null PnL snapshot was confused with measured zero' \
  'true|3|null|[]|3' \
  "$(psql_cmd -Atqc "SELECT (aggregate_value->>'receiptBound') || '|' || (aggregate_value->>'copierCount') || '|' || pg_catalog.jsonb_typeof(aggregate_value->'totalCopierPnl') || '|' || (aggregate_value->'pnlDistribution')::text || '|' || (SELECT pg_catalog.count(*)::text FROM arena.copier_snapshot_rows AS row_value JOIN arena.copier_snapshot_publications AS publication ON publication.publication_id=row_value.publication_id WHERE publication.source_run_id=repeat('f',64)) FROM (SELECT public.arena_copier_aggregate('gate_futures','all-null-pnl') AS aggregate_value) AS aggregate_result")"

ROW_REQUEST="public.copier_fixture_request(1,102,2,repeat('b',64),'2026-08-04 11:00:00+00',10,10)"
ROW_RECEIPT="$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($ROW_REQUEST)::text")"
ROW_AGGREGATE="$(psql_cmd -Atqc "SELECT public.arena_copier_aggregate('gate_futures','row-trader')::text")"
assert_equal \
  'non-empty receipt aggregate projection drifted' \
  'true|10|550|[{"count": 10, "bucket": "0~1000"}]' \
  "$(psql_cmd -Atqc "SELECT (public.arena_copier_aggregate('gate_futures','row-trader')->>'receiptBound') || '|' || (public.arena_copier_aggregate('gate_futures','row-trader')->>'copierCount') || '|' || (public.arena_copier_aggregate('gate_futures','row-trader')->>'totalCopierPnl') || '|' || (public.arena_copier_aggregate('gate_futures','row-trader')->'pnlDistribution')::text")"

PRIVATE_COUNTS="$(
  psql_cmd -Atqc "
    SELECT publication.parsed_row_count::text || '|' ||
           pg_catalog.count(row_value.*)::text
    FROM arena.copier_snapshot_publications AS publication
    LEFT JOIN arena.copier_snapshot_rows AS row_value
      ON row_value.publication_id = publication.publication_id
    WHERE publication.source_run_id = repeat('b', 64)
    GROUP BY publication.parsed_row_count;
  "
)"
assert_equal 'receipt and private rows did not commit atomically' '10|10' "$PRIVATE_COUNTS"

if [[ "$ROW_AGGREGATE" == *private-* || "$ROW_AGGREGATE" == *example.invalid* ]]; then
  echo 'public copier aggregate leaked private row data' >&2
  exit 1
fi

expect_failure_contains \
  'anonymous publisher execution succeeded' \
  'permission denied for function publish_copier_snapshot_v1' \
  "SET ROLE anon; SELECT public.publish_copier_snapshot_v1($ZERO_REQUEST)"
expect_failure_contains \
  'browser read private copier rows succeeded' \
  'permission denied for table copier_snapshot_rows' \
  'SET ROLE authenticated; SELECT * FROM arena.copier_snapshot_rows'

psql_cmd -q <<'SQL'
SELECT public.insert_copier_raw(
  3, 102, repeat('c', 64), '2026-08-04 10:30:00+00'
);
SQL
LATE_REQUEST="public.copier_fixture_request(1,102,3,repeat('c',64),'2026-08-04 10:30:00+00',0)"
psql_cmd -q -c "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($LATE_REQUEST)" >/dev/null
assert_equal \
  'late older observation replaced the newer receipt' \
  "$(printf 'b%.0s' {1..64})" \
  "$(psql_cmd -Atqc "SELECT public.arena_copier_aggregate('gate_futures','row-trader')->>'sourceRunId'")"

# One additional RAW/request proves concurrent exact calls serialize and return
# the same immutable receipt instead of racing into two publications.
psql_cmd -q <<'SQL'
SELECT public.insert_copier_raw(
  4, 101, repeat('d', 64), '2026-08-04 11:15:00+00'
);
SQL
CONCURRENT_REQUEST="public.copier_fixture_request(1,101,4,repeat('d',64),'2026-08-04 11:15:00+00',0)"
(
  psql_cmd -Atqc "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($CONCURRENT_REQUEST)::text" \
    >"$TMP_ROOT/concurrent-a.out"
) &
pid_a=$!
(
  psql_cmd -Atqc "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($CONCURRENT_REQUEST)::text" \
    >"$TMP_ROOT/concurrent-b.out"
) &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
assert_equal \
  'concurrent exact replay returned different receipts' \
  "$(<"$TMP_ROOT/concurrent-a.out")" \
  "$(<"$TMP_ROOT/concurrent-b.out")"

# Non-quarantined RAW GC tombstones only the live FK. The immutable receipt is
# still readable and exact replay must return the same receipt.
psql_cmd -q -c "DELETE FROM arena.raw_objects WHERE id=4"
assert_equal \
  'RAW GC did not tombstone the live receipt pointer' \
  'true' \
  "$(psql_cmd -Atqc "SELECT (live_raw_object_id IS NULL)::text FROM arena.copier_snapshot_publications WHERE source_run_id=repeat('d',64)")"
assert_equal \
  'RAW GC hid the frozen receipt aggregate' \
  'true|0|0' \
  "$(psql_cmd -Atqc "SELECT (public.arena_copier_aggregate('gate_futures','zero-trader')->>'receiptBound') || '|' || (public.arena_copier_aggregate('gate_futures','zero-trader')->>'copierCount') || '|' || (public.arena_copier_aggregate('gate_futures','zero-trader')->>'totalCopierPnl')")"
GC_REPLAY="$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($CONCURRENT_REQUEST)::text")"
assert_equal \
  'RAW GC exact replay changed the frozen receipt' \
  "$(<"$TMP_ROOT/concurrent-a.out")" \
  "$GC_REPLAY"

# Quarantine remains attached to the live pointer. It must immediately hide the
# latest receipt, prevent successful publisher replay, and make evidence delete
# fail closed. Older receipts for the same subject must not reappear.
psql_cmd -q -c "UPDATE arena.raw_objects SET quarantined = true WHERE id = 2"
assert_equal \
  'quarantined latest receipt lost its live pointer' \
  'true|true' \
  "$(psql_cmd -Atqc "SELECT (publication.live_raw_object_id IS NOT NULL)::text || '|' || raw_object.quarantined::text FROM arena.copier_snapshot_publications AS publication JOIN arena.raw_objects AS raw_object ON raw_object.id=publication.live_raw_object_id WHERE publication.source_run_id=repeat('b',64)")"
assert_equal \
  'quarantined latest receipt fell back to an older snapshot' \
  '' \
  "$(psql_cmd -Atqc "SELECT public.arena_copier_aggregate('gate_futures','row-trader')::text")"
expect_failure_contains \
  'quarantined exact replay returned a successful receipt' \
  'RAW pointer does not prove the exact verified acquisition' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($ROW_REQUEST)"
expect_failure_contains \
  'quarantined receipt RAW evidence was deleted' \
  'quarantined copier snapshot RAW evidence cannot be deleted' \
  'DELETE FROM arena.raw_objects WHERE id=2'

if [[ "$PROOF_MODE" == authority ]]; then
  FINAL_AUTHORITY_STATE="$(
    psql_cmd -Atqc "
      SELECT
        arena.copier_snapshot_legacy_fallback_enabled()::text || '|' ||
        pg_catalog.has_function_privilege(
          'service_role', 'public.publish_copier_snapshot_v1(jsonb)', 'EXECUTE'
        )::text || '|' ||
        pg_catalog.has_function_privilege(
          'anon', 'public.publish_copier_snapshot_v1(jsonb)', 'EXECUTE'
        )::text || '|' ||
        pg_catalog.has_table_privilege(
          'anon', 'arena.copier_snapshot_publications', 'SELECT'
        )::text;
    "
  )"
  assert_equal '054000 copier authority ACL/state drifted' 'true|true|false|false' "$FINAL_AUTHORITY_STATE"
  echo 'copier snapshot publication authority 054000 PostgreSQL 17 proof passed'
  exit 0
fi

cutover_failure_log="$TMP_ROOT/cutover-without-attestation.log"
if psql_cmd -q -f "$CUTOVER" >"$cutover_failure_log" 2>&1; then
  echo '055000 cutover succeeded without explicit attestation' >&2
  exit 1
fi
if ! grep -Fq 'explicit receipt coverage attestation' "$cutover_failure_log"; then
  echo '055000 cutover failed without the expected attestation gate' >&2
  sed -n '1,180p' "$cutover_failure_log" >&2
  exit 1
fi

apply_attested_cutover() {
  psql_cmd -q \
    -c "SET arena.copier_snapshot_direct_write_cutover_attestation='RECEIPT_CAPABLE_TIER_C_FULLY_DEPLOYED_LEGACY_DRAINED_COVERAGE_APPROVED'" \
    -f "$CUTOVER"
}

apply_attested_cutover

assert_equal \
  'strict cutover retained a legacy aggregate' \
  '' \
  "$(psql_cmd -Atqc "SELECT public.arena_copier_aggregate('gate_futures','legacy-only')::text")"
assert_equal \
  'strict cutover lost explicit depth-none N/A' \
  'false|none' \
  "$(psql_cmd -Atqc "SELECT (public.arena_copier_aggregate('no_copiers','not-applicable')->>'receiptBound') || '|' || (public.arena_copier_aggregate('no_copiers','not-applicable')->>'depth')")"
assert_equal \
  'strict cutover changed a receipt-bound aggregate' \
  'true|0|0' \
  "$(psql_cmd -Atqc "SELECT (public.arena_copier_aggregate('gate_futures','zero-trader')->>'receiptBound') || '|' || (public.arena_copier_aggregate('gate_futures','zero-trader')->>'copierCount') || '|' || (public.arena_copier_aggregate('gate_futures','zero-trader')->>'totalCopierPnl')")"
expect_failure_contains \
  'legacy direct copier insert survived cutover' \
  'legacy unbound copier_records inserts are retired' \
  "INSERT INTO arena.copier_records (trader_id,ts,copier_label,currency,dedupe_hash,raw) VALUES (103,now(),'blocked','USDT','blocked','{}')"

# Response-loss replay of 054000 after the irreversible cutover may restore its
# bridge-shaped wrapper, but the one-way marker must keep fallback disabled.
psql_cmd -q -f "$AUTHORITY"
assert_equal \
  'authority replay reopened legacy fallback after cutover' \
  '' \
  "$(psql_cmd -Atqc "SELECT public.arena_copier_aggregate('gate_futures','legacy-only')::text")"
apply_attested_cutover

FINAL_STATE="$(
  psql_cmd -Atqc "
    SELECT
      arena.copier_snapshot_legacy_fallback_enabled()::text || '|' ||
      pg_catalog.has_function_privilege(
        'service_role', 'public.publish_copier_snapshot_v1(jsonb)', 'EXECUTE'
      )::text || '|' ||
      pg_catalog.has_function_privilege(
        'anon', 'public.publish_copier_snapshot_v1(jsonb)', 'EXECUTE'
      )::text || '|' ||
      pg_catalog.has_table_privilege(
        'anon', 'arena.copier_snapshot_publications', 'SELECT'
      )::text;
  "
)"
assert_equal 'final copier authority ACL/state drifted' 'false|true|false|false' "$FINAL_STATE"

echo 'copier snapshot direct-write cutover 055000 PostgreSQL 17 proof passed'
