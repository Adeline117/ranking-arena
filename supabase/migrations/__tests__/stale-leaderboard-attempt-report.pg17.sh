#!/usr/bin/env bash

# PostgreSQL 17 behavioral proof for the service-only, read-only stale attempt
# report. The fixture verifies keyset pagination, snapshot inputs, authority
# classification, closed ACLs, secret omission, and ledger immutability.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729060000_stale_leaderboard_attempt_report.sql"
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

TMP_ROOT="$(mktemp -d /tmp/stale-attempt-report-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
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
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

expect_failure() {
  local label="$1"
  local pattern="$2"
  local sql="$3"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "$pattern" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,160p' "$ERROR_FILE" >&2
    exit 1
  fi
}

assert_sql_true() {
  local label="$1"
  local sql="$2"
  local result
  result="$(psql_cmd -Atq -c "$sql")"
  result="$(printf '%s\n' "$result" | rg -v '^$' | tail -1)"
  if [[ "$result" != "t" ]]; then
    echo "$label" >&2
    echo "query result: $result" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --username=postgres \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE fixture_rogue NOLOGIN;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  GRANT EXECUTE ON FUNCTIONS TO fixture_rogue WITH GRANT OPTION;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role, fixture_rogue;

CREATE TABLE arena.leaderboard_acquisition_attempts (
  attempt_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE,
  source_id smallint NOT NULL,
  source_slug text NOT NULL,
  timeframe smallint NOT NULL,
  observation_cycle_id text,
  queue_job_id text,
  queue_attempt integer NOT NULL,
  capture_contract text NOT NULL,
  recorded_started_at timestamptz NOT NULL,
  execution_claim_id uuid,
  execution_generation_seq bigint
);

CREATE INDEX idx_fixture_attempt_latest
  ON arena.leaderboard_acquisition_attempts (
    source_id, timeframe, attempt_seq DESC
  );

CREATE TABLE arena.leaderboard_acquisition_outcomes (
  attempt_seq bigint PRIMARY KEY,
  terminal_state text NOT NULL
);

CREATE TABLE arena.tier_a_execution_heads (
  source_id smallint PRIMARY KEY,
  generation_seq bigint NOT NULL,
  claim_id uuid,
  phase text NOT NULL,
  lease_expires_at timestamptz
);

INSERT INTO arena.leaderboard_acquisition_attempts (
  attempt_id, source_id, source_slug, timeframe, observation_cycle_id,
  queue_job_id, queue_attempt, capture_contract, recorded_started_at,
  execution_claim_id, execution_generation_seq
) VALUES
  (
    '00000000-0000-4000-8000-000000000001', 1, 'source_one', 30,
    'cycle-1', 'job-1', 0, 'legacy_unverified',
    pg_catalog.clock_timestamp() - interval '5 hours', NULL, NULL
  ),
  (
    '00000000-0000-4000-8000-000000000002', 1, 'source_one', 30,
    'cycle-2', 'job-2', 1,
    'arena.ingest.leaderboard-acquisition-manifest@4',
    pg_catalog.clock_timestamp() - interval '4 hours', NULL, NULL
  ),
  (
    '00000000-0000-4000-8000-000000000003', 2, 'source_two', 30,
    'cycle-3', 'job-3', 0,
    'arena.ingest.leaderboard-acquisition-manifest@4',
    pg_catalog.clock_timestamp() - interval '4 hours',
    '20000000-0000-4000-8000-000000000001', 1
  ),
  (
    '00000000-0000-4000-8000-000000000004', 3, 'source_three', 30,
    'cycle-4', 'job-4', 0,
    'arena.ingest.leaderboard-acquisition-manifest@4',
    pg_catalog.clock_timestamp() - interval '4 hours',
    '30000000-0000-4000-8000-000000000001', 1
  ),
  (
    '00000000-0000-4000-8000-000000000005', 4, 'source_four', 30,
    'cycle-5', 'job-5', 0,
    'arena.ingest.leaderboard-acquisition-manifest@4',
    pg_catalog.clock_timestamp() - interval '4 hours',
    '40000000-0000-4000-8000-000000000001', 1
  ),
  (
    '00000000-0000-4000-8000-000000000006', 5, 'source_five', 30,
    'cycle-6', 'job-6', 0,
    'arena.ingest.leaderboard-acquisition-manifest@4',
    pg_catalog.clock_timestamp() - interval '4 hours',
    '50000000-0000-4000-8000-000000000001', 1
  ),
  (
    '00000000-0000-4000-8000-000000000007', 6, 'closed_source', 30,
    'cycle-7', 'job-7', 0,
    'arena.ingest.leaderboard-acquisition-manifest@4',
    pg_catalog.clock_timestamp() - interval '4 hours', NULL, NULL
  ),
  (
    '00000000-0000-4000-8000-000000000008', 7, 'fresh_source', 30,
    'cycle-8', 'job-8', 0,
    'arena.ingest.leaderboard-acquisition-manifest@4',
    pg_catalog.clock_timestamp() - interval '1 minute', NULL, NULL
  );

INSERT INTO arena.leaderboard_acquisition_outcomes (attempt_seq, terminal_state)
VALUES (7, 'complete');

INSERT INTO arena.tier_a_execution_heads (
  source_id, generation_seq, claim_id, phase, lease_expires_at
) VALUES
  (
    2, 2, '20000000-0000-4000-8000-000000000002', 'active',
    pg_catalog.clock_timestamp() + interval '1 hour'
  ),
  (
    3, 1, '30000000-0000-4000-8000-000000000001', 'active',
    pg_catalog.clock_timestamp() - interval '1 minute'
  ),
  (
    4, 1, '40000000-0000-4000-8000-000000000001', 'failed', NULL
  ),
  (
    5, 1, '50000000-0000-4000-8000-000000000001', 'active',
    pg_catalog.clock_timestamp() + interval '1 hour'
  );
SQL

psql_cmd -q -f "$MIGRATION"

assert_sql_true \
  'report ACLs are not service-role-only' \
  "WITH function_row AS (SELECT function_row.proowner, function_row.proacl, function_row.proconfig FROM pg_catalog.pg_proc AS function_row WHERE function_row.oid = 'arena.report_stale_leaderboard_acquisition_attempts(jsonb)'::pg_catalog.regprocedure), acl_rows AS (SELECT acl_row.grantee, acl_row.privilege_type, acl_row.is_grantable FROM function_row CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(function_row.proacl, pg_catalog.acldefault('f', function_row.proowner))) AS acl_row), expected AS (SELECT role_row.oid AS grantee, 'EXECUTE'::text AS privilege_type, false AS is_grantable FROM pg_catalog.pg_roles AS role_row WHERE role_row.rolname IN ('postgres', 'service_role')) SELECT NOT EXISTS (SELECT * FROM acl_rows EXCEPT SELECT * FROM expected) AND NOT EXISTS (SELECT * FROM expected EXCEPT SELECT * FROM acl_rows) AND (SELECT pg_catalog.array_length(proconfig, 1) = 2 AND proconfig @> ARRAY['search_path=pg_catalog, pg_temp', 'statement_timeout=15s']::text[] FROM function_row)"

expect_failure \
  'anonymous report call' \
  'permission denied for function report_stale_leaderboard_acquisition_attempts' \
  "SET ROLE anon; SELECT arena.report_stale_leaderboard_acquisition_attempts('{}'::jsonb)"
expect_failure \
  'rogue report call' \
  'permission denied for function report_stale_leaderboard_acquisition_attempts' \
  "SET ROLE fixture_rogue; SELECT arena.report_stale_leaderboard_acquisition_attempts('{}'::jsonb)"

psql_cmd -q <<'SQL'
CREATE TABLE public.fixture_report_snapshot (
  report jsonb NOT NULL,
  attempt_count bigint NOT NULL,
  outcome_count bigint NOT NULL,
  head_count bigint NOT NULL
);
GRANT INSERT ON public.fixture_report_snapshot TO service_role;

SET ROLE service_role;
INSERT INTO public.fixture_report_snapshot (
  report, attempt_count, outcome_count, head_count
)
SELECT
  arena.report_stale_leaderboard_acquisition_attempts(
    pg_catalog.jsonb_build_object(
      'contract',
        'arena.ingest.stale-leaderboard-attempt-report-request@1',
      'observed_at', pg_catalog.to_char(
        pg_catalog.date_trunc('milliseconds', pg_catalog.statement_timestamp())
          AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'high_water_attempt_seq', NULL,
      'after_attempt_seq', NULL,
      'page_size', 2,
      'stale_after_seconds', 7200
    )
  ),
  8,
  1,
  4;
RESET ROLE;
SQL

assert_sql_true \
  'first page did not freeze the exact high-water and keyset cursor' \
  "SELECT report->>'high_water_attempt_seq' = '8' AND report->>'after_attempt_seq' IS NULL AND pg_catalog.jsonb_array_length(report->'rows') = 2 AND report->'page'->>'next_after_attempt_seq' = '2' AND (report->'page'->>'has_more')::boolean FROM fixture_report_snapshot"

assert_sql_true \
  'legacy current/superseded classification drifted' \
  "SELECT pg_catalog.jsonb_path_exists(report, '\$.rows[*] ? (@.attempt_seq == \"1\" && @.ownership == \"legacy\" && @.attempt_position == \"superseded\" && @.authority_state == \"legacy_unfenced\" && @.attempt_phase == \"open\")') AND pg_catalog.jsonb_path_exists(report, '\$.rows[*] ? (@.attempt_seq == \"2\" && @.attempt_position == \"current\")') FROM fixture_report_snapshot"

assert_sql_true \
  'second page did not preserve observed-at and high-water' \
  "WITH first AS (SELECT report FROM fixture_report_snapshot), second AS (SELECT arena.report_stale_leaderboard_acquisition_attempts(pg_catalog.jsonb_build_object('contract', 'arena.ingest.stale-leaderboard-attempt-report-request@1', 'observed_at', first.report->>'observed_at', 'high_water_attempt_seq', first.report->>'high_water_attempt_seq', 'after_attempt_seq', first.report->'page'->>'next_after_attempt_seq', 'page_size', 2, 'stale_after_seconds', 7200)) AS report FROM first) SELECT report->>'observed_at' = (SELECT report->>'observed_at' FROM first) AND report->>'high_water_attempt_seq' = '8' AND report->>'after_attempt_seq' = '2' AND report->'rows'->0->>'attempt_seq' = '3' AND report->'rows'->1->>'attempt_seq' = '4' FROM second"

assert_sql_true \
  'claimed fenced and expired classifications drifted' \
  "WITH snapshot AS (SELECT report FROM fixture_report_snapshot), page AS (SELECT arena.report_stale_leaderboard_acquisition_attempts(pg_catalog.jsonb_build_object('contract', 'arena.ingest.stale-leaderboard-attempt-report-request@1', 'observed_at', snapshot.report->>'observed_at', 'high_water_attempt_seq', '8', 'after_attempt_seq', '2', 'page_size', 2, 'stale_after_seconds', 7200)) AS report FROM snapshot) SELECT pg_catalog.jsonb_path_exists(report, '\$.rows[*] ? (@.attempt_seq == \"3\" && @.ownership == \"claimed\" && @.authority_state == \"fenced\" && @.execution_phase == \"active\")') AND pg_catalog.jsonb_path_exists(report, '\$.rows[*] ? (@.attempt_seq == \"4\" && @.authority_state == \"expired\" && @.execution_phase == \"active\")') FROM page"

assert_sql_true \
  'claimed closed and current classifications drifted' \
  "WITH snapshot AS (SELECT report FROM fixture_report_snapshot), page AS (SELECT arena.report_stale_leaderboard_acquisition_attempts(pg_catalog.jsonb_build_object('contract', 'arena.ingest.stale-leaderboard-attempt-report-request@1', 'observed_at', snapshot.report->>'observed_at', 'high_water_attempt_seq', '8', 'after_attempt_seq', '4', 'page_size', 2, 'stale_after_seconds', 7200)) AS report FROM snapshot) SELECT pg_catalog.jsonb_path_exists(report, '\$.rows[*] ? (@.attempt_seq == \"5\" && @.authority_state == \"closed\" && @.execution_phase == \"failed\")') AND pg_catalog.jsonb_path_exists(report, '\$.rows[*] ? (@.attempt_seq == \"6\" && @.authority_state == \"current\" && @.execution_phase == \"active\")') FROM page"

assert_sql_true \
  'closed or fresh attempts leaked into the stale report' \
  "WITH snapshot AS (SELECT report FROM fixture_report_snapshot), page AS (SELECT arena.report_stale_leaderboard_acquisition_attempts(pg_catalog.jsonb_build_object('contract', 'arena.ingest.stale-leaderboard-attempt-report-request@1', 'observed_at', snapshot.report->>'observed_at', 'high_water_attempt_seq', '8', 'after_attempt_seq', NULL, 'page_size', 100, 'stale_after_seconds', 7200)) AS report FROM snapshot) SELECT pg_catalog.jsonb_array_length(report->'rows') = 6 AND NOT pg_catalog.jsonb_path_exists(report, '\$.rows[*] ? (@.attempt_seq == \"7\" || @.attempt_seq == \"8\")') FROM page"

assert_sql_true \
  'report response exposed an authority or evidence secret key' \
  "WITH snapshot AS (SELECT report FROM fixture_report_snapshot), page AS (SELECT arena.report_stale_leaderboard_acquisition_attempts(pg_catalog.jsonb_build_object('contract', 'arena.ingest.stale-leaderboard-attempt-report-request@1', 'observed_at', snapshot.report->>'observed_at', 'high_water_attempt_seq', '8', 'after_attempt_seq', NULL, 'page_size', 100, 'stale_after_seconds', 7200))::text AS body FROM snapshot) SELECT body !~ '(bull_lock_token|source_lease|execution_claim_id|worker_instance|worker_node|worker_region|release_id|git_sha|source_run_id|raw_object|storage_path|content_hash)' FROM page"

psql_cmd -q <<'SQL'
INSERT INTO arena.leaderboard_acquisition_attempts (
  attempt_id, source_id, source_slug, timeframe, observation_cycle_id,
  queue_job_id, queue_attempt, capture_contract, recorded_started_at,
  execution_claim_id, execution_generation_seq
) VALUES (
  '00000000-0000-4000-8000-000000000009', 8, 'later_source', 30,
  'cycle-9', 'job-9', 0,
  'arena.ingest.leaderboard-acquisition-manifest@4',
  pg_catalog.clock_timestamp() - interval '4 hours', NULL, NULL
);
SQL

assert_sql_true \
  'fixed high-water admitted a later attempt' \
  "WITH snapshot AS (SELECT report FROM fixture_report_snapshot), page AS (SELECT arena.report_stale_leaderboard_acquisition_attempts(pg_catalog.jsonb_build_object('contract', 'arena.ingest.stale-leaderboard-attempt-report-request@1', 'observed_at', snapshot.report->>'observed_at', 'high_water_attempt_seq', '8', 'after_attempt_seq', NULL, 'page_size', 100, 'stale_after_seconds', 7200)) AS report FROM snapshot) SELECT report->>'high_water_attempt_seq' = '8' AND NOT pg_catalog.jsonb_path_exists(report, '\$.rows[*] ? (@.attempt_seq == \"9\")') FROM page"

assert_sql_true \
  'report mutated an acquisition outcome or execution head' \
  "SELECT (SELECT pg_catalog.count(*) FROM arena.leaderboard_acquisition_attempts) = 9 AND (SELECT pg_catalog.count(*) FROM arena.leaderboard_acquisition_outcomes) = 1 AND (SELECT pg_catalog.count(*) FROM arena.tier_a_execution_heads) = 4"

expect_failure \
  'extra request key' \
  'request envelope is malformed' \
  "SET ROLE service_role; SELECT arena.report_stale_leaderboard_acquisition_attempts(pg_catalog.jsonb_build_object('contract', 'arena.ingest.stale-leaderboard-attempt-report-request@1', 'observed_at', pg_catalog.to_char(pg_catalog.date_trunc('milliseconds', pg_catalog.statement_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), 'high_water_attempt_seq', NULL, 'after_attempt_seq', NULL, 'page_size', 100, 'stale_after_seconds', 7200, 'write', true))"
expect_failure \
  'oversized page' \
  'request values are malformed|outside its bounds' \
  "SET ROLE service_role; SELECT arena.report_stale_leaderboard_acquisition_attempts(pg_catalog.jsonb_build_object('contract', 'arena.ingest.stale-leaderboard-attempt-report-request@1', 'observed_at', pg_catalog.to_char(pg_catalog.date_trunc('milliseconds', pg_catalog.statement_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), 'high_water_attempt_seq', NULL, 'after_attempt_seq', NULL, 'page_size', 1001, 'stale_after_seconds', 7200))"
expect_failure \
  'cursor beyond high-water' \
  'cursor exceeds its high-water' \
  "SET ROLE service_role; SELECT arena.report_stale_leaderboard_acquisition_attempts(pg_catalog.jsonb_build_object('contract', 'arena.ingest.stale-leaderboard-attempt-report-request@1', 'observed_at', pg_catalog.to_char(pg_catalog.date_trunc('milliseconds', pg_catalog.statement_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), 'high_water_attempt_seq', '8', 'after_attempt_seq', '9', 'page_size', 100, 'stale_after_seconds', 7200))"
expect_failure \
  'unobservable high-water' \
  'high-water is not observable' \
  "SET ROLE service_role; SELECT arena.report_stale_leaderboard_acquisition_attempts(pg_catalog.jsonb_build_object('contract', 'arena.ingest.stale-leaderboard-attempt-report-request@1', 'observed_at', pg_catalog.to_char(pg_catalog.date_trunc('milliseconds', pg_catalog.statement_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), 'high_water_attempt_seq', '10', 'after_attempt_seq', NULL, 'page_size', 100, 'stale_after_seconds', 7200))"
expect_failure \
  'overflowing high-water' \
  'cursor values are malformed' \
  "SET ROLE service_role; SELECT arena.report_stale_leaderboard_acquisition_attempts(pg_catalog.jsonb_build_object('contract', 'arena.ingest.stale-leaderboard-attempt-report-request@1', 'observed_at', pg_catalog.to_char(pg_catalog.date_trunc('milliseconds', pg_catalog.statement_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), 'high_water_attempt_seq', '9223372036854775808', 'after_attempt_seq', NULL, 'page_size', 100, 'stale_after_seconds', 7200))"
expect_failure \
  'historical observed-at' \
  'outside its bounds' \
  "SET ROLE service_role; SELECT arena.report_stale_leaderboard_acquisition_attempts(pg_catalog.jsonb_build_object('contract', 'arena.ingest.stale-leaderboard-attempt-report-request@1', 'observed_at', pg_catalog.to_char(pg_catalog.date_trunc('milliseconds', pg_catalog.transaction_timestamp() - interval '5 minutes 1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), 'high_water_attempt_seq', NULL, 'after_attempt_seq', NULL, 'page_size', 100, 'stale_after_seconds', 7200))"
expect_failure \
  'future observed-at' \
  'outside its bounds' \
  "SET ROLE service_role; SELECT arena.report_stale_leaderboard_acquisition_attempts(pg_catalog.jsonb_build_object('contract', 'arena.ingest.stale-leaderboard-attempt-report-request@1', 'observed_at', pg_catalog.to_char(pg_catalog.date_trunc('milliseconds', pg_catalog.transaction_timestamp() + interval '5 minutes 1 second') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), 'high_water_attempt_seq', NULL, 'after_attempt_seq', NULL, 'page_size', 100, 'stale_after_seconds', 7200))"

echo "PostgreSQL 17 stale leaderboard attempt report proof passed"
