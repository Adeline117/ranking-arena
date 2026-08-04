#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for 054200 copier receipt clock, subject,
# claimed-owner serialization, source-event provenance, and histogram privacy.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SUBSTRATE="$ROOT_DIR/supabase/migrations/20260804053000_copier_snapshot_publication_substrate.sql"
AUTHORITY="$ROOT_DIR/supabase/migrations/20260804054000_copier_snapshot_publication_authority.sql"
HARDENING="$ROOT_DIR/supabase/migrations/20260804054200_harden_copier_snapshot_receipt_provenance.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo 'This integration proof requires PostgreSQL 17' >&2
  exit 1
fi
for migration in "$SUBSTRATE" "$AUTHORITY" "$HARDENING"; do
  if [[ ! -f "$migration" ]]; then
    echo "Required migration not found: $migration" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/copier-snapshot-provenance-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((62000 + ($$ % 2000)))}"
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

wait_for_activity() {
  local label="$1"
  local sql="$2"
  local attempt
  local observed
  for attempt in $(seq 1 120); do
    observed="$(psql_cmd -Atqc "$sql")"
    if [[ "$observed" == 't' || "$observed" == 'true' ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "$label was not observed" >&2
  for activity_log in "$TMP_ROOT"/*holder.out "$TMP_ROOT"/*publisher.out; do
    if [[ -f "$activity_log" ]]; then
      echo "--- $activity_log" >&2
      sed -n '1,180p' "$activity_log" >&2
    fi
  done
  psql_cmd -x -c \
    "SELECT application_name,state,wait_event_type,wait_event,query FROM pg_catalog.pg_stat_activity WHERE datname=current_database()" \
    >&2 || true
  exit 1
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
  exchange_trader_id text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
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
  (2, 'inactive_source', 'inactive', 'serving', 'full', 'USDT'),
  (3, 'demoted_source', 'active', 'shadow', 'full', 'USDT'),
  (4, 'other_source', 'active', 'serving', 'full', 'USDT');

INSERT INTO arena.traders (
  id, source_id, exchange_trader_id, meta
) VALUES
  (101, 1, 'five-pnl', '{}'),
  (102, 1, 'claimed', '{"claimed":true}'),
  (103, 2, 'inactive', '{}'),
  (104, 3, 'demoted', '{}'),
  (105, 4, 'wrong-subject', '{}'),
  (106, 1, 'claim-first', '{}'),
  (107, 1, 'ten-pnl', '{}'),
  (108, 1, 'all-null-pnl', '{}'),
  (109, 1, 'concurrent-replay', '{}'),
  (110, 1, 'publication-first', '{}');

CREATE FUNCTION public.arena_copier_aggregate(p_source text, p_trader text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  -- arena.copier-aggregate-containment@1
  SELECT NULL::jsonb;
$function$;
ALTER FUNCTION public.arena_copier_aggregate(text, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.arena_copier_aggregate(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.arena_copier_aggregate(text, text)
  TO anon, authenticated, service_role;
SQL

psql_cmd -q -f "$SUBSTRATE"
psql_cmd -q -f "$AUTHORITY"
psql_cmd -q -f "$HARDENING"

psql_cmd -q -c \
  'GRANT EXECUTE ON FUNCTION arena.guard_copier_snapshot_publication_insert_v1() TO anon'
DRIFT_REPLAY_LOG="$TMP_ROOT/drifted-empty-hardening-replay.log"
if psql_cmd -q -f "$HARDENING" >"$DRIFT_REPLAY_LOG" 2>&1; then
  echo 'drifted hardening replay repaired ACL instead of failing closed' >&2
  exit 1
fi
if ! grep -Fq 'provenance hardening replay lineage drifted' "$DRIFT_REPLAY_LOG"; then
  echo 'drifted hardening replay failed for an unexpected reason' >&2
  sed -n '1,180p' "$DRIFT_REPLAY_LOG" >&2
  exit 1
fi
psql_cmd -q -c \
  'REVOKE ALL ON FUNCTION arena.guard_copier_snapshot_publication_insert_v1() FROM anon'

EMPTY_STATE_BEFORE="$(psql_cmd -Atqc "
  SELECT
    (NOT attribute.attnotnull)::text || '|' ||
    pg_catalog.count(trigger.*)::text
  FROM pg_catalog.pg_attribute AS attribute
  CROSS JOIN pg_catalog.pg_trigger AS trigger
  WHERE attribute.attrelid='arena.copier_snapshot_rows'::regclass
    AND attribute.attname='source_event_at'
    AND trigger.tgrelid IN (
      'arena.copier_snapshot_publications'::regclass,
      'arena.copier_snapshot_rows'::regclass
    )
    AND NOT trigger.tgisinternal
    AND trigger.tgname IN (
      'copier_snapshot_publication_guard_insert_v1',
      'copier_snapshot_row_normalize_source_event_v1'
    )
  GROUP BY attribute.attnotnull;
")"
psql_cmd -q -f "$HARDENING"
EMPTY_STATE_AFTER="$(psql_cmd -Atqc "
  SELECT
    (NOT attribute.attnotnull)::text || '|' ||
    pg_catalog.count(trigger.*)::text
  FROM pg_catalog.pg_attribute AS attribute
  CROSS JOIN pg_catalog.pg_trigger AS trigger
  WHERE attribute.attrelid='arena.copier_snapshot_rows'::regclass
    AND attribute.attname='source_event_at'
    AND trigger.tgrelid IN (
      'arena.copier_snapshot_publications'::regclass,
      'arena.copier_snapshot_rows'::regclass
    )
    AND NOT trigger.tgisinternal
    AND trigger.tgname IN (
      'copier_snapshot_publication_guard_insert_v1',
      'copier_snapshot_row_normalize_source_event_v1'
    )
  GROUP BY attribute.attnotnull;
")"
assert_equal 'empty hardening replay drifted' "$EMPTY_STATE_BEFORE" "$EMPTY_STATE_AFTER"
assert_equal 'hardening did not install nullable provenance and two triggers' 'true|2' "$EMPTY_STATE_AFTER"

psql_cmd -q <<'SQL'
CREATE FUNCTION public.copier_fixture_request(
  p_source_id integer,
  p_trader_id bigint,
  p_raw_object_id bigint,
  p_source_run_id text,
  p_observed_at timestamptz,
  p_row_count integer,
  p_non_null_pnl_count integer
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
            'copierPnl', CASE
              WHEN row_number <= p_non_null_pnl_count
              THEN row_number * 10
              ELSE NULL
            END,
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
  )
  SELECT
    p_id,
    source_row.id,
    'history:copiers',
    trader_row.id,
    NULL,
    p_observed_at,
    source_row.slug || '/history/' || p_source_run_id || '.json.gz',
    100,
    p_source_run_id,
    false,
    pg_catalog.jsonb_build_object(
      'data_contract', 'arena.ingest.history-acquisition-artifact@1',
      'history_evidence_contract',
        'arena.event-history-publication-evidence@1',
      'source_run_id', p_source_run_id,
      'source_slug', source_row.slug,
      'exchange_trader_id', trader_row.exchange_trader_id,
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
    p_source_run_id,
    'event_history'
  FROM arena.traders AS trader_row
  JOIN arena.sources AS source_row
    ON source_row.id = trader_row.source_id
  WHERE trader_row.id = p_trader_id;
$function$;

SELECT public.insert_copier_raw(
  1, 101, repeat('a', 64), '2025-08-04 10:00:00+00'
);
SELECT public.insert_copier_raw(
  2, 107, repeat('b', 64), '2025-08-04 10:10:00+00'
);
SELECT public.insert_copier_raw(
  3, 108, repeat('c', 64), '2025-08-04 10:20:00+00'
);
SELECT public.insert_copier_raw(
  4, 102, repeat('d', 64), '2025-08-04 10:30:00+00'
);
SELECT public.insert_copier_raw(
  5, 109, repeat('e', 64), '2025-08-04 10:40:00+00'
);
SELECT public.insert_copier_raw(
  6, 106, repeat('f', 64), '2025-08-04 10:50:00+00'
);
SELECT public.insert_copier_raw(
  7, 110, repeat('1', 64), '2025-08-04 11:00:00+00'
);
SELECT public.insert_copier_raw(
  8,
  101,
  repeat('2', 64),
  pg_catalog.date_trunc(
    'milliseconds',
    pg_catalog.statement_timestamp() + interval '10 minutes'
  )
);
SQL

FIVE_REQUEST="public.copier_fixture_request(1,101,1,repeat('a',64),'2025-08-04 10:00:00+00',10,5)"
TEN_REQUEST="public.copier_fixture_request(1,107,2,repeat('b',64),'2025-08-04 10:10:00+00',10,10)"
NULL_REQUEST="public.copier_fixture_request(1,108,3,repeat('c',64),'2025-08-04 10:20:00+00',10,0)"
CLAIMED_REQUEST="public.copier_fixture_request(1,102,4,repeat('d',64),'2025-08-04 10:30:00+00',0,0)"
CONCURRENT_REQUEST="public.copier_fixture_request(1,109,5,repeat('e',64),'2025-08-04 10:40:00+00',0,0)"
CLAIM_FIRST_REQUEST="public.copier_fixture_request(1,106,6,repeat('f',64),'2025-08-04 10:50:00+00',0,0)"
PUBLICATION_FIRST_REQUEST="public.copier_fixture_request(1,110,7,repeat('1',64),'2025-08-04 11:00:00+00',0,0)"
FUTURE_OBSERVED="$(psql_cmd -Atqc "
  SELECT pg_catalog.to_char(
    fetched_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD HH24:MI:SS.MS+00'
  )
  FROM arena.raw_objects
  WHERE id=8
")"
FUTURE_REQUEST="public.copier_fixture_request(1,101,8,repeat('2',64),'$FUTURE_OBSERVED',0,0)"

expect_failure_contains \
  'future database observation clock was accepted' \
  'copier snapshot observed_at exceeds the database publication clock' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($FUTURE_REQUEST)"

expect_failure_contains \
  'claimed trader receipt was accepted' \
  'claimed trader copier snapshots cannot be published' \
  "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($CLAIMED_REQUEST)"

expect_failure_contains \
  'inactive source receipt was accepted' \
  'copier snapshot source is not active serving or its publication contract drifted' \
  "INSERT INTO arena.copier_snapshot_publications (source_id,trader_id,observed_at,source_depth,currency) VALUES (2,103,'2025-08-04 10:00:00+00','full','USDT')"

expect_failure_contains \
  'demoted source receipt was accepted' \
  'copier snapshot source is not active serving or its publication contract drifted' \
  "INSERT INTO arena.copier_snapshot_publications (source_id,trader_id,observed_at,source_depth,currency) VALUES (3,104,'2025-08-04 10:00:00+00','full','USDT')"

expect_failure_contains \
  'wrong source/trader subject was accepted' \
  'copier snapshot subject is not one exact source/trader pair' \
  "INSERT INTO arena.copier_snapshot_publications (source_id,trader_id,observed_at,source_depth,currency) VALUES (1,105,'2025-08-04 10:00:00+00','full','USDT')"

FIVE_RECEIPT="$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($FIVE_REQUEST)::text")"
FIVE_REPLAY="$(psql_cmd -Atqc "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($FIVE_REQUEST)::text")"
assert_equal 'exact provenance receipt replay drifted' "$FIVE_RECEIPT" "$FIVE_REPLAY"

assert_equal \
  'publisher acquisition clock survived as source-event provenance' \
  '10|10|0' \
  "$(psql_cmd -Atqc "
    SELECT
      publication.parsed_row_count::text || '|' ||
      pg_catalog.count(row_value.*)::text || '|' ||
      pg_catalog.count(row_value.source_event_at)::text
    FROM arena.copier_snapshot_publications AS publication
    JOIN arena.copier_snapshot_rows AS row_value
      ON row_value.publication_id=publication.publication_id
    WHERE publication.source_run_id=repeat('a',64)
    GROUP BY publication.parsed_row_count
  ")"

assert_equal \
  'five-person PnL cohort escaped the public aggregate' \
  'true|10|[]' \
  "$(psql_cmd -Atqc "
    SELECT
      (aggregate_value->>'receiptBound') || '|' ||
      (aggregate_value->>'copierCount') || '|' ||
      (aggregate_value->'pnlDistribution')::text
    FROM (
      SELECT public.arena_copier_aggregate(
        'gate_futures','five-pnl'
      ) AS aggregate_value
    ) AS aggregate_result
  ")"

psql_cmd -q -c "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($TEN_REQUEST)" >/dev/null
assert_equal \
  'ten-person PnL cohort was suppressed' \
  'true|10|[{"count": 10, "bucket": "0~1000"}]' \
  "$(psql_cmd -Atqc "
    SELECT
      (aggregate_value->>'receiptBound') || '|' ||
      (aggregate_value->>'copierCount') || '|' ||
      (aggregate_value->'pnlDistribution')::text
    FROM (
      SELECT public.arena_copier_aggregate(
        'gate_futures','ten-pnl'
      ) AS aggregate_value
    ) AS aggregate_result
  ")"

psql_cmd -q -c "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($NULL_REQUEST)" >/dev/null
assert_equal \
  'all-null PnL receipt exposed a distribution' \
  'true|10|[]' \
  "$(psql_cmd -Atqc "
    SELECT
      (aggregate_value->>'receiptBound') || '|' ||
      (aggregate_value->>'copierCount') || '|' ||
      (aggregate_value->'pnlDistribution')::text
    FROM (
      SELECT public.arena_copier_aggregate(
        'gate_futures','all-null-pnl'
      ) AS aggregate_value
    ) AS aggregate_result
  ")"

# A claim that owns the trader UPDATE lock first must make the final INSERT
# admission wait. Once the claim commits, EvalPlanQual exposes claimed=true and
# the receipt fails closed instead of crossing the claim boundary.
(
  psql_cmd -q >"$TMP_ROOT/claim-first-holder.out" 2>&1 <<'SQL'
SET application_name = 'claim-first-holder';
BEGIN;
UPDATE arena.traders
SET meta = meta || '{"claimed":true}'::jsonb
WHERE id = 106;
SELECT pg_catalog.pg_advisory_lock(54, 201);
SELECT pg_catalog.pg_sleep(4);
COMMIT;
SQL
) &
claim_first_holder_pid=$!

wait_for_activity \
  'claim-first holder' \
  "SELECT CASE WHEN pg_catalog.pg_try_advisory_lock(54,201) THEN NOT pg_catalog.pg_advisory_unlock(54,201) ELSE true END"

(
  if psql_cmd -v VERBOSITY=verbose \
    -c "SET application_name='claim-first-publisher'; SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($CLAIM_FIRST_REQUEST)" \
    >"$TMP_ROOT/claim-first-publisher.out" 2>&1; then
    echo success >"$TMP_ROOT/claim-first-publisher.status"
  else
    echo failure >"$TMP_ROOT/claim-first-publisher.status"
  fi
) &
claim_first_publisher_pid=$!

wait_for_activity \
  'claim-first publication did not wait for the claim lock' \
  "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid<>pg_catalog.pg_backend_pid() AND locktype='transactionid' AND NOT granted)"

wait "$claim_first_holder_pid"
wait "$claim_first_publisher_pid"
assert_equal \
  'claim-first publication escaped claimed rejection' \
  'failure' \
  "$(<"$TMP_ROOT/claim-first-publisher.status")"
if ! grep -Fq 'claimed trader copier snapshots cannot be published' \
  "$TMP_ROOT/claim-first-publisher.out"; then
  echo 'claim-first publication escaped claimed rejection' >&2
  sed -n '1,180p' "$TMP_ROOT/claim-first-publisher.out" >&2
  exit 1
fi

# When publication owns the FOR SHARE lock first, a claim UPDATE must wait for
# the receipt transaction to commit. This proves the opposite serialization
# direction, not merely a claimed-state predicate check.
(
  psql_cmd -q >"$TMP_ROOT/publication-first-holder.out" 2>&1 <<SQL
SET application_name = 'publication-first-holder';
BEGIN;
SET ROLE service_role;
SELECT public.publish_copier_snapshot_v1($PUBLICATION_FIRST_REQUEST);
SELECT pg_catalog.pg_advisory_lock(54, 202);
SELECT pg_catalog.pg_sleep(4);
COMMIT;
SQL
) &
publication_first_holder_pid=$!

wait_for_activity \
  'publication-first holder' \
  "SELECT CASE WHEN pg_catalog.pg_try_advisory_lock(54,202) THEN NOT pg_catalog.pg_advisory_unlock(54,202) ELSE true END"

(
  psql_cmd -q \
    -c "SET application_name='publication-first-claim'; UPDATE arena.traders SET meta=meta || '{\"claimed\":true}'::jsonb WHERE id=110" \
    >"$TMP_ROOT/publication-first-claim.out" 2>&1
) &
publication_first_claim_pid=$!

wait_for_activity \
  'publication-first claim did not wait for the publication lock' \
  "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_locks WHERE pid<>pg_catalog.pg_backend_pid() AND locktype='transactionid' AND NOT granted)"

wait "$publication_first_holder_pid"
wait "$publication_first_claim_pid"
assert_equal \
  'publication-first serialization lost receipt or claim state' \
  '1|true' \
  "$(psql_cmd -Atqc "
    SELECT
      pg_catalog.count(publication.*)::text || '|' ||
      (trader.meta->>'claimed')
    FROM arena.traders AS trader
    LEFT JOIN arena.copier_snapshot_publications AS publication
      ON publication.trader_id=trader.id
     AND publication.source_run_id=repeat('1',64)
    WHERE trader.id=110
    GROUP BY trader.meta
  ")"

# Exact concurrent calls retain 054000 idempotency with both new INSERT guards.
(
  psql_cmd -Atqc \
    "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($CONCURRENT_REQUEST)::text" \
    >"$TMP_ROOT/concurrent-a.out"
) &
pid_a=$!
(
  psql_cmd -Atqc \
    "SET ROLE service_role; SELECT public.publish_copier_snapshot_v1($CONCURRENT_REQUEST)::text" \
    >"$TMP_ROOT/concurrent-b.out"
) &
pid_b=$!
wait "$pid_a"
wait "$pid_b"
assert_equal \
  'concurrent exact replay returned different receipts' \
  "$(<"$TMP_ROOT/concurrent-a.out")" \
  "$(<"$TMP_ROOT/concurrent-b.out")"

# Once any receipt/row exists, replaying the schema hardening is intentionally
# forbidden: changing provenance semantics after evidence exists is not safe.
DATA_REPLAY_LOG="$TMP_ROOT/data-bearing-hardening-replay.log"
if psql_cmd -q -f "$HARDENING" >"$DATA_REPLAY_LOG" 2>&1; then
  echo 'data-bearing hardening replay did not fail closed' >&2
  exit 1
fi
if ! grep -Fq 'requires zero existing receipts and rows' "$DATA_REPLAY_LOG"; then
  echo 'data-bearing hardening replay did not fail closed with the expected preflight' >&2
  sed -n '1,180p' "$DATA_REPLAY_LOG" >&2
  exit 1
fi

FINAL_STATE="$(psql_cmd -Atqc "
  SELECT
    (NOT attribute.attnotnull)::text || '|' ||
    pg_catalog.has_function_privilege(
      'service_role',
      'public.publish_copier_snapshot_v1(jsonb)',
      'EXECUTE'
    )::text || '|' ||
    pg_catalog.has_function_privilege(
      'service_role',
      'arena.guard_copier_snapshot_publication_insert_v1()',
      'EXECUTE'
    )::text || '|' ||
    pg_catalog.has_table_privilege(
      'anon',
      'arena.copier_snapshot_rows',
      'SELECT'
    )::text
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid='arena.copier_snapshot_rows'::regclass
    AND attribute.attname='source_event_at'
")"
assert_equal 'final copier provenance ACL/state drifted' 'true|true|false|false' "$FINAL_STATE"

echo 'copier snapshot receipt provenance 054200 PostgreSQL 17 proof passed'
