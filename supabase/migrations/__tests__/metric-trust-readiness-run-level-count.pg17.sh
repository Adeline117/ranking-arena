#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261124224208: the readiness RPC counts the rankable
# observations of runs whose lineage does not hold and no longer re-validates
# every observation's page ordinal.
#
# The count query of 20261122152622 (run-level verdict AND per-row ordinal
# rules) and the one of 20261124224208 (run-level verdict only) are lifted
# verbatim out of the two migration files and run side by side on a fixture of
# the relations they read:
#   = for every run-level violation (unordered / malformed / out-of-range
#     parser ordinals, wrong artifact role, missing or disagreeing terminal,
#     unknown manifest contract, exhaustion without its proof) the two agree,
#     run by run: every rankable observation of the run is counted
#   = quarantined artifacts, expired observations, runs before the horizon and
#     non-complete observations stay excluded by both
#   - the one intended difference: a NULL / zero / non-member ordinal inside a
#     run whose lineage holds is no longer counted here (the per-statement
#     insert trigger refuses such a row; the readiness RPC requires that
#     trigger, proven in metric-trust-observation-lineage-per-statement)
#   = with those rows absent, as the trigger guarantees, the counts are equal
#   + with 200,000 rankable observations in healthy runs, the new query reads
#     only the observations of the failing runs (asserted on the executed plan)
# It owns an isolated cluster on a private socket and never touches
# application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
OLD_MIGRATION="$MIGRATIONS/20261122152622_metric_trust_observation_lineage_per_statement.sql"
NEW_MIGRATION="$MIGRATIONS/20261124224208_readiness_counts_untrusted_runs_not_rows.sql"
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

TMP_ROOT="$(mktemp -d /tmp/readiness-bounded-count-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((53000 + ($$ % 3000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -60 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

assert_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "$1: expected '$2', got '$3'" >&2
    exit 1
  fi
  echo "ok: $1"
}

# Lift the two count queries out of the migrations as standalone statements.
extract_count() {
  # extract_count <migration> <first line marker>
  awk -v start="$2" '
    index($0, start) == 1 { on = 1 }
    on && index($0, "  SELECT COALESCE(") == 1 { exit }
    on && index($0, "    INTO STRICT v_legacy_complete_verified_count") == 1 { next }
    on { print }
  ' "$1"
}
OLD_COUNT="$TMP_ROOT/old-count.sql"
NEW_COUNT="$TMP_ROOT/new-count.sql"
extract_count "$OLD_MIGRATION" "  WITH horizon AS (" >"$OLD_COUNT"
extract_count "$NEW_MIGRATION" "  WITH horizon AS (" >"$NEW_COUNT"
for extracted in "$OLD_COUNT" "$NEW_COUNT"; do
  grep -q "arena.metric_trust_observations AS observation" "$extracted" || {
    echo "could not lift the count query into $extracted" >&2
    exit 1
  }
  grep -q "leaderboard_outcome_exhaustion_bound" "$extracted" || {
    echo "the lifted query lost its exhaustion branch: $extracted" >&2
    exit 1
  }
done
if grep -q "INTO STRICT" "$OLD_COUNT" "$NEW_COUNT"; then
  echo "a lifted query still assigns into a PL/pgSQL variable" >&2
  exit 1
fi

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

psql_db -q <<'SQL'
CREATE SCHEMA arena;

CREATE TABLE arena.metric_source_contracts (
  id bigint PRIMARY KEY,
  max_freshness interval NOT NULL
);
INSERT INTO arena.metric_source_contracts VALUES (1, interval '6 hours'), (2, interval '2 hours');

CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  source_run_id text NOT NULL,
  trust_artifact_role text NOT NULL,
  content_hash text NOT NULL,
  storage_path text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL
);

CREATE TABLE arena.metric_trust_runs (
  source_run_id text PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  snapshot_id bigint NOT NULL,
  snapshot_scraped_at timestamptz NOT NULL,
  population_raw_object_id bigint NOT NULL,
  manifest_raw_object_id bigint NOT NULL,
  started_at timestamptz NOT NULL,
  completed_at timestamptz NOT NULL,
  acquisition_state text NOT NULL DEFAULT 'complete',
  population_state text NOT NULL DEFAULT 'verified',
  reported_population integer,
  fetched_population integer NOT NULL,
  caller_limited boolean NOT NULL DEFAULT false
);

CREATE TABLE arena.metric_trust_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL,
  snapshot_id bigint NOT NULL,
  snapshot_scraped_at timestamptz NOT NULL,
  source_run_id text NOT NULL,
  timeframe smallint NOT NULL,
  valid_until timestamptz NOT NULL,
  quality text NOT NULL DEFAULT 'complete',
  population_state text NOT NULL DEFAULT 'verified',
  window_state text NOT NULL DEFAULT 'verified',
  unit_state text NOT NULL DEFAULT 'verified',
  freshness_state text NOT NULL DEFAULT 'verified',
  blocking_reasons jsonb NOT NULL DEFAULT '[]',
  source_page_ordinal integer
);
CREATE INDEX idx_arena_metric_trust_observations_run
  ON arena.metric_trust_observations (source_id, source_run_id, snapshot_id);

-- The terminal view of the acquisition ledger, as a table of the columns read.
CREATE TABLE arena.leaderboard_acquisition_attempt_states (
  attempt_seq bigint PRIMARY KEY,
  attempt_id uuid NOT NULL,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL,
  source_status text NOT NULL DEFAULT 'active',
  source_serving_mode text NOT NULL DEFAULT 'serving',
  worker_region text DEFAULT 'local',
  source_fetch_region text DEFAULT 'local',
  capture_contract text NOT NULL,
  attempt_binding_contract text NOT NULL
    DEFAULT 'arena.ingest.leaderboard-acquisition-attempt-binding@1',
  observation_cycle_id text,
  runner_git_sha text,
  recorded_started_at timestamptz NOT NULL,
  acquisition_state text NOT NULL DEFAULT 'complete',
  capture_evidence_state text NOT NULL DEFAULT 'verified',
  termination_reason text DEFAULT 'short_page',
  capture_started_at timestamptz NOT NULL,
  capture_completed_at timestamptz NOT NULL,
  source_run_id text NOT NULL,
  source_payload_raw_object_id bigint NOT NULL,
  source_payload_content_hash text NOT NULL,
  source_payload_storage_path text NOT NULL,
  manifest_raw_object_id bigint NOT NULL,
  manifest_content_hash text NOT NULL,
  manifest_storage_path text NOT NULL,
  diagnostic_raw_object_id bigint,
  diagnostic_content_hash text,
  diagnostic_storage_path text,
  reported_population integer,
  source_page_count integer,
  accepted_population integer NOT NULL,
  rejected_row_count integer NOT NULL DEFAULT 0,
  caller_limited boolean NOT NULL DEFAULT false,
  safety_limited boolean NOT NULL DEFAULT false,
  failure_stage text,
  terminal_state text NOT NULL,
  population_state text NOT NULL,
  population_report_state text NOT NULL,
  observed_population integer NOT NULL,
  deduplicated_row_count integer NOT NULL DEFAULT 0,
  reason_code text
);

-- Exhaustion evidence: attempts listed here hold a recorded, valid proof.
CREATE TABLE arena.exhaustion_bound_attempts (attempt_seq bigint PRIMARY KEY);
CREATE FUNCTION arena.leaderboard_outcome_exhaustion_bound(p_attempt_seq bigint)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM arena.exhaustion_bound_attempts AS bound WHERE bound.attempt_seq = p_attempt_seq
  )
$$;

-- One run with its two RAW objects, its terminal outcome and its observations.
--   p_kind:    'v2' | 'v3_total' | 'v3_exhausted' | 'v3_no_terminal' | 'unknown_contract'
--   p_ordinals: the parser's source-page ordinals (jsonb), p_pages: pageCount
--   p_observation_ordinals: one observation per element (NULL allowed)
CREATE FUNCTION public.fixture_run(
  p_run int, p_kind text, p_completed_ago interval, p_valid_for interval,
  p_ordinals jsonb, p_pages int, p_observation_ordinals int[],
  p_terminal_pages int DEFAULT NULL, p_role text DEFAULT 'source_payload',
  p_quarantined boolean DEFAULT false, p_exhaustion_bound boolean DEFAULT true
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_run text := pg_catalog.lpad(pg_catalog.to_hex(p_run), 64, '0');
  v_payload bigint := p_run * 10 + 1;
  v_manifest bigint := p_run * 10 + 2;
  v_completed timestamptz := pg_catalog.now() - p_completed_ago;
  v_started timestamptz := pg_catalog.now() - p_completed_ago - interval '10 minutes';
  v_attempt uuid := ('00000000-0000-4000-8000-' || pg_catalog.lpad(p_run::text, 12, '0'))::uuid;
  v_contract text := CASE p_kind
    WHEN 'v2' THEN 'arena.ingest.leaderboard-acquisition-manifest@2'
    WHEN 'unknown_contract' THEN 'arena.ingest.leaderboard-acquisition-manifest@9'
    ELSE 'arena.ingest.leaderboard-acquisition-manifest@3' END;
  v_fetched int := 100;
  v_integrity jsonb := '{"hash_algorithm": "sha256", "hash_scope": "json_utf8"}';
BEGIN
  INSERT INTO arena.raw_objects VALUES
    (v_payload, 1, 30, v_run, p_role, pg_catalog.repeat('a', 64), 'payload/' || p_run,
     p_quarantined,
     pg_catalog.jsonb_build_object('pageCount', p_pages,
       'parserPageCount', pg_catalog.jsonb_array_length(p_ordinals),
       'parserSourcePageOrdinals', p_ordinals, 'raw_integrity', v_integrity)),
    (v_manifest, 1, 30, v_run, 'population_manifest', v_run, 'manifest/' || p_run, false,
     pg_catalog.jsonb_build_object('data_contract', v_contract, 'raw_integrity', v_integrity,
       'observation_cycle_id', 'cycle-' || p_run,
       'acquisition_attempt', pg_catalog.jsonb_build_object(
         'binding_contract', 'arena.ingest.leaderboard-acquisition-attempt-binding@1',
         'attempt_id', v_attempt::text, 'attempt_seq', p_run::text,
         'runner_git_sha', pg_catalog.repeat('1', 40))));
  INSERT INTO arena.metric_trust_runs
    (source_run_id, source_id, timeframe, snapshot_id, snapshot_scraped_at,
     population_raw_object_id, manifest_raw_object_id, started_at, completed_at,
     reported_population, fetched_population)
  VALUES (v_run, 1, 30, p_run, v_completed, v_payload, v_manifest, v_started, v_completed,
          CASE WHEN p_kind = 'v3_exhausted' THEN NULL ELSE v_fetched END, v_fetched);
  IF p_kind IN ('v3_total', 'v3_exhausted') THEN
    INSERT INTO arena.leaderboard_acquisition_attempt_states
      (attempt_seq, attempt_id, source_id, timeframe, capture_contract, observation_cycle_id,
       runner_git_sha, recorded_started_at, capture_started_at, capture_completed_at,
       source_run_id, source_payload_raw_object_id, source_payload_content_hash,
       source_payload_storage_path, manifest_raw_object_id, manifest_content_hash,
       manifest_storage_path, reported_population, source_page_count, accepted_population,
       terminal_state, population_state, population_report_state, observed_population,
       reason_code)
    VALUES (p_run, v_attempt, 1, 30, v_contract, 'cycle-' || p_run, pg_catalog.repeat('1', 40),
       v_started, v_started, v_completed, v_run, v_payload, pg_catalog.repeat('a', 64),
       'payload/' || p_run, v_manifest, v_run, 'manifest/' || p_run,
       CASE WHEN p_kind = 'v3_exhausted' THEN NULL ELSE v_fetched END,
       COALESCE(p_terminal_pages, p_pages), v_fetched,
       CASE WHEN p_kind = 'v3_exhausted' THEN 'unknown' ELSE 'complete' END,
       CASE WHEN p_kind = 'v3_exhausted' THEN 'unknown' ELSE 'verified' END,
       CASE WHEN p_kind = 'v3_exhausted' THEN 'unknown' ELSE 'consistent' END,
       v_fetched,
       CASE WHEN p_kind = 'v3_exhausted' THEN 'population_unknown' END);
    IF p_kind = 'v3_exhausted' AND p_exhaustion_bound THEN
      INSERT INTO arena.exhaustion_bound_attempts VALUES (p_run);
    END IF;
  END IF;
  INSERT INTO arena.metric_trust_observations
    (source_id, snapshot_id, snapshot_scraped_at, source_run_id, timeframe, valid_until,
     source_page_ordinal)
  SELECT 1, p_run, v_completed, v_run, 30, v_completed + p_valid_for, ordinal
    FROM pg_catalog.unnest(p_observation_ordinals) AS ordinal;
END
$$;

-- Runs completed an hour ago whose observations are valid for six hours: every
-- one of their observations can still be ranked.
DO $data$
DECLARE
  h interval := interval '1 hour';
  v interval := interval '6 hours';
BEGIN
  -- Trustworthy lineage: nothing to count.
  PERFORM public.fixture_run(101, 'v2', h, v, '[1,2,3]', 3, ARRAY[1, 2, 3, 3]);
  PERFORM public.fixture_run(102, 'v3_total', h, v, '[1,2,3]', 3, ARRAY[1, 2, 3]);
  PERFORM public.fixture_run(103, 'v3_exhausted', h, v, '[1,3]', 3, ARRAY[1, 3]);
  -- Per-observation violations on an otherwise valid run.
  PERFORM public.fixture_run(110, 'v3_total', h, v, '[1,3]', 3, ARRAY[1, 2, NULL, 0, 3]);
  -- Run-level violations: every observation of the run counts.
  PERFORM public.fixture_run(120, 'v3_total', h, v, '[3,1]', 3, ARRAY[1, 3]);            -- not increasing
  PERFORM public.fixture_run(121, 'v3_total', h, v, '[1,"2"]', 3, ARRAY[1]);             -- malformed ordinal
  PERFORM public.fixture_run(122, 'v3_total', h, v, '[1,5]', 3, ARRAY[1]);               -- ordinal out of range
  PERFORM public.fixture_run(123, 'v3_total', h, v, '[1,2]', 3, ARRAY[1, 2],
    p_role => 'diagnostic');                                                             -- wrong artifact role
  PERFORM public.fixture_run(124, 'v3_no_terminal', h, v, '[1,2]', 2, ARRAY[1, 2]);      -- no terminal outcome
  PERFORM public.fixture_run(125, 'v3_total', h, v, '[1,2]', 2, ARRAY[1, 2],
    p_terminal_pages => 4);                                                              -- page count disagrees
  PERFORM public.fixture_run(126, 'unknown_contract', h, v, '[1,2]', 2, ARRAY[1]);       -- unknown manifest
  PERFORM public.fixture_run(127, 'v3_exhausted', h, v, '[1,2]', 2, ARRAY[1, 2],
    p_exhaustion_bound => false);                                                        -- no exhaustion proof
  -- Quarantined artifacts: excluded by both queries.
  PERFORM public.fixture_run(130, 'v3_no_terminal', h, v, '[1]', 1, ARRAY[1, 1],
    p_quarantined => true);
END
$data$;

-- Observations that are not complete/verified are never counted.
UPDATE arena.metric_trust_observations SET quality = 'partial'
 WHERE source_run_id = pg_catalog.lpad(pg_catalog.to_hex(126), 64, '0');
INSERT INTO arena.metric_trust_observations
  (source_id, snapshot_id, snapshot_scraped_at, source_run_id, timeframe, valid_until,
   source_page_ordinal)
SELECT 1, 126, snapshot_scraped_at, source_run_id, 30, pg_catalog.now() + interval '1 hour', 9
  FROM arena.metric_trust_runs WHERE snapshot_id = 126;
ANALYZE;
SQL

OLD_LIVE="$(psql_db -Atq -f "$OLD_COUNT")"
NEW_LIVE="$(psql_db -Atq -f "$NEW_COUNT")"
# 110: ordinals 2, NULL and 0 (3, row-level) | 120: 2 | 121: 1 | 122: 1 | 123: 2 |
# 124: 2 | 125: 2 | 126: the one complete observation (1) | 127: 2  => 16 / 13
assert_equal "the per-row query counts every violation" "16" "$OLD_LIVE"
assert_equal "the run-level query counts the observations of failing runs only" "13" "$NEW_LIVE"

# Run by run: keep one run's observations at a time.
psql_db -q -c "CREATE TABLE public.kept AS SELECT * FROM arena.metric_trust_observations"
restore_observations() {
  psql_db -q -c "TRUNCATE arena.metric_trust_observations;
    INSERT INTO arena.metric_trust_observations
      (source_id, snapshot_id, snapshot_scraped_at, source_run_id, timeframe, valid_until,
       quality, population_state, window_state, unit_state, freshness_state,
       blocking_reasons, source_page_ordinal)
    SELECT source_id, snapshot_id, snapshot_scraped_at, source_run_id, timeframe, valid_until,
       quality, population_state, window_state, unit_state, freshness_state,
       blocking_reasons, source_page_ordinal
      FROM public.kept WHERE $1"
}
for run in 101 102 103 120 121 122 123 124 125 126 127 130; do
  restore_observations "snapshot_id = $run"
  if [[ "$(psql_db -Atq -f "$OLD_COUNT")" != "$(psql_db -Atq -f "$NEW_COUNT")" ]]; then
    echo "run $run: per-row and run-level counts differ" >&2
    exit 1
  fi
done
echo "ok: both queries agree on every healthy, run-level-violating and quarantined run taken alone"

# The intended difference: bad ordinals inside a run whose lineage holds.
restore_observations "snapshot_id = 110"
assert_equal "per-row: the three bad ordinals of a healthy run are counted" "3" \
  "$(psql_db -Atq -f "$OLD_COUNT")"
assert_equal "run-level: a healthy run contributes nothing" "0" \
  "$(psql_db -Atq -f "$NEW_COUNT")"

# What the insert trigger guarantees: no such row exists. Then they are equal.
restore_observations "NOT (snapshot_id = 110 AND (source_page_ordinal IS NULL OR source_page_ordinal NOT IN (1, 3)))"
assert_equal "without trigger-refused rows the per-row count is the run-level count" \
  "$(psql_db -Atq -f "$OLD_COUNT")" "$(psql_db -Atq -f "$NEW_COUNT")"
assert_equal "and it is the 13 observations of the failing runs" "13" \
  "$(psql_db -Atq -f "$NEW_COUNT")"

# Expired history and the horizon are bounded exactly as before.
psql_db -q >/dev/null <<'SQL'
-- Completed 30 hours ago, expired 24 hours ago: a violating run of the past.
SELECT public.fixture_run(200, 'v3_no_terminal', interval '30 hours', interval '6 hours',
  '[1,2]', 2, ARRAY[1, 2, 2]);
-- A recent run with one observation that already expired.
SELECT public.fixture_run(201, 'v3_no_terminal', interval '1 hour', interval '6 hours',
  '[1,2]', 2, ARRAY[1]);
INSERT INTO arena.metric_trust_observations
  (source_id, snapshot_id, snapshot_scraped_at, source_run_id, timeframe, valid_until,
   source_page_ordinal)
SELECT 1, 201, snapshot_scraped_at, source_run_id, 30, pg_catalog.now() - interval '1 minute', 2
  FROM arena.metric_trust_runs WHERE snapshot_id = 201;
-- A run just inside the horizon (max_freshness 6h + 5 minutes).
SELECT public.fixture_run(202, 'v3_no_terminal', interval '6 hours 4 minutes',
  interval '7 hours', '[1]', 1, ARRAY[1]);
ANALYZE;
SQL
# 13 + the one rankable row of 201 + the one of 202 = 15, for both.
assert_equal "per-row: expired history and old runs stay excluded" "15" \
  "$(psql_db -Atq -f "$OLD_COUNT")"
assert_equal "run-level: the same bound" "15" "$(psql_db -Atq -f "$NEW_COUNT")"

# Scale: 400 healthy recent runs x 500 rankable observations. The executed plan
# of the new query must read only the observations of the failing runs.
psql_db -q <<'SQL'
INSERT INTO arena.raw_objects
SELECT r * 10 + k, 1, 30, pg_catalog.lpad(pg_catalog.to_hex(r), 64, '0'),
       CASE k WHEN 1 THEN 'source_payload' ELSE 'population_manifest' END,
       CASE k WHEN 1 THEN pg_catalog.repeat('a', 64)
              ELSE pg_catalog.lpad(pg_catalog.to_hex(r), 64, '0') END,
       'recent/' || r || '/' || k, false,
       CASE k WHEN 1 THEN pg_catalog.jsonb_build_object('pageCount', 400, 'parserPageCount', 400,
                 'parserSourcePageOrdinals',
                 (SELECT pg_catalog.jsonb_agg(n) FROM pg_catalog.generate_series(1, 400) AS n),
                 'raw_integrity', '{"hash_algorithm": "sha256", "hash_scope": "json_utf8"}'::jsonb)
              ELSE pg_catalog.jsonb_build_object('data_contract',
                 'arena.ingest.leaderboard-acquisition-manifest@2',
                 'raw_integrity', '{"hash_algorithm": "sha256", "hash_scope": "json_utf8"}'::jsonb)
       END
  FROM pg_catalog.generate_series(1000, 1399) AS r, pg_catalog.generate_series(1, 2) AS k;
INSERT INTO arena.metric_trust_runs
  (source_run_id, source_id, timeframe, snapshot_id, snapshot_scraped_at,
   population_raw_object_id, manifest_raw_object_id, started_at, completed_at,
   reported_population, fetched_population)
SELECT pg_catalog.lpad(pg_catalog.to_hex(r), 64, '0'), 1, 30, r,
       pg_catalog.now() - interval '1 hour', r * 10 + 1, r * 10 + 2,
       pg_catalog.now() - interval '1 hour 10 minutes', pg_catalog.now() - interval '1 hour',
       100, 100
  FROM pg_catalog.generate_series(1000, 1399) AS r;
INSERT INTO arena.metric_trust_observations
  (source_id, snapshot_id, snapshot_scraped_at, source_run_id, timeframe, valid_until,
   source_page_ordinal)
SELECT 1, r, pg_catalog.now() - interval '1 hour', pg_catalog.lpad(pg_catalog.to_hex(r), 64, '0'),
       30, pg_catalog.now() + interval '5 hours', 1 + (n % 400)
  FROM pg_catalog.generate_series(1000, 1399) AS r, pg_catalog.generate_series(1, 500) AS n;
ANALYZE;
SQL
assert_equal "per-row: 200,000 rankable observations of healthy runs add nothing" "15" \
  "$(psql_db -Atq -f "$OLD_COUNT")"
assert_equal "run-level: nor here" "15" "$(psql_db -Atq -f "$NEW_COUNT")"

FAILING_RUN_ROWS="$(psql_db -Atqc "
  SELECT count(*) FROM arena.metric_trust_observations WHERE snapshot_id < 1000")"
rows_read() {
  { echo "EXPLAIN (ANALYZE, FORMAT JSON)"; cat "$1"; } >"$TMP_ROOT/explain.sql"
  psql_db -Atq -f "$TMP_ROOT/explain.sql" >"$TMP_ROOT/plan.json"
  node -e '
    const plan = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[0].Plan
    let read = 0
    const walk = (node) => {
      if (node["Relation Name"] === "metric_trust_observations") {
        read += (node["Actual Rows"] + (node["Rows Removed by Filter"] ?? 0)) * node["Actual Loops"]
      }
      for (const child of node.Plans ?? []) walk(child)
    }
    walk(plan)
    console.log(Math.round(read))
  ' "$TMP_ROOT/plan.json"
}
OLD_ROWS_READ="$(rows_read "$OLD_COUNT")"
NEW_ROWS_READ="$(rows_read "$NEW_COUNT")"
if ((NEW_ROWS_READ > FAILING_RUN_ROWS)); then
  echo "the run-level query read $NEW_ROWS_READ observations; the failing and fixture runs hold only $FAILING_RUN_ROWS" >&2
  exit 1
fi
if ((OLD_ROWS_READ < 100000)); then
  echo "expected the per-row query to read the healthy runs too (read $OLD_ROWS_READ)" >&2
  exit 1
fi
echo "ok: per-row read $OLD_ROWS_READ observations, run-level read $NEW_ROWS_READ (failing and fixture runs hold $FAILING_RUN_ROWS)"

echo "metric trust readiness run-level count PostgreSQL 17 proof passed"
