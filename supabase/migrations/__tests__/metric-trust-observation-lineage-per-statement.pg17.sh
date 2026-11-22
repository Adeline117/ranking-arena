#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261122152622: an observation batch's source-page
# lineage is validated once per acquisition run, with unchanged outcomes.
#
# The 20261118112703 row trigger is installed on a fixture of the relations it
# reads; every case below is one INSERT statement whose outcome (rows kept and
# their downgraded state, or SQLSTATE + message) is recorded. The migration is
# then applied as written and every case is replayed:
#   = every case has the identical outcome before and after: valid @2, @3
#     total and @3 exhaustion runs; a NULL ordinal (kept, downgraded); a
#     non-positive ordinal; a non-member; a missing run; a quarantined or
#     wrong-role artifact; malformed / inconsistent page metadata; unordered,
#     out-of-range or non-integer parser ordinals; a missing or disagreeing
#     terminal; an exhaustion run without its proof; an unknown manifest
#     contract; a batch with one bad row; a statement spanning two runs
#   - a refused statement keeps none of its rows
#   + the readiness RPC's pins follow: they hold after the migration, not
#     before, and break when the statement trigger is disabled
#   + the exhaustion proof is evaluated once per run per statement instead of
#     once per row, and a 20,000-row / 433-page batch is at least 10x faster
# Isolated cluster on a private socket; never touches application data.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
OLD_MIGRATION="$MIGRATIONS/20261118112703_metric_trust_exhaustion_observation_authority.sql"
NEW_MIGRATION="$MIGRATIONS/20261122152622_metric_trust_observation_lineage_per_statement.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/lineage-statement-pg17.XXXXXX)"
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
    tail -40 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_db() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

# The row trigger function exactly as 20261118112703 defines it.
OLD_FUNCTION="$TMP_ROOT/old-function.sql"
awk '/^CREATE OR REPLACE FUNCTION arena.validate_metric_trust_source_page_lineage\(\)/ { on = 1 }
     on { print }
     on && /^\$function\$;/ { exit }' "$OLD_MIGRATION" >"$OLD_FUNCTION"
grep -q "leaderboard_outcome_exhaustion_bound" "$OLD_FUNCTION"

psql_db -q >/dev/null <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;
CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY, source_id int, timeframe int, source_run_id text,
  trust_artifact_role text, content_hash text, quarantined boolean NOT NULL DEFAULT false,
  meta jsonb
);
CREATE TABLE arena.metric_trust_runs (
  source_run_id text PRIMARY KEY, source_id int, timeframe int, snapshot_id bigint,
  population_raw_object_id bigint, manifest_raw_object_id bigint,
  population_state text NOT NULL DEFAULT 'verified', reported_population int
);
-- The terminal view, as a table of the columns the trigger reads.
CREATE TABLE arena.latest_terminal_leaderboard_acquisitions (
  attempt_seq bigint, source_id int, timeframe int, source_run_id text,
  source_payload_raw_object_id bigint, manifest_raw_object_id bigint, capture_contract text,
  acquisition_state text, capture_evidence_state text, source_page_count int,
  caller_limited boolean, safety_limited boolean, failure_stage text, terminal_state text,
  population_state text, reason_code text, population_report_state text,
  reported_population int
);
-- Exhaustion proofs: attempts listed here hold one. Every evaluation is counted.
CREATE TABLE arena.exhaustion_bound_attempts (attempt_seq bigint PRIMARY KEY);
CREATE SEQUENCE arena.exhaustion_bound_calls;
CREATE FUNCTION arena.leaderboard_outcome_exhaustion_bound(p_attempt_seq bigint)
RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  PERFORM pg_catalog.nextval('arena.exhaustion_bound_calls');
  RETURN EXISTS (SELECT 1 FROM arena.exhaustion_bound_attempts AS bound
                  WHERE bound.attempt_seq = p_attempt_seq);
END $$;
CREATE TABLE arena.metric_trust_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id int, snapshot_id bigint, source_run_id text, timeframe int,
  source_page_ordinal int, freshness_state text NOT NULL DEFAULT 'verified',
  quality text NOT NULL DEFAULT 'complete', blocking_reasons jsonb NOT NULL DEFAULT '[]'
);

-- One run: its two RAW objects and (for @3) its terminal outcome.
CREATE FUNCTION public.fixture_run(
  p_run int, p_kind text, p_ordinals jsonb, p_pages text,
  p_parser_pages text DEFAULT NULL, p_terminal_pages int DEFAULT NULL,
  p_role text DEFAULT 'source_payload', p_quarantined boolean DEFAULT false,
  p_bound boolean DEFAULT true
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_run text := 'run-' || p_run;
  v_contract text := CASE p_kind
    WHEN 'v2' THEN 'arena.ingest.leaderboard-acquisition-manifest@2'
    WHEN 'unknown_contract' THEN 'arena.ingest.leaderboard-acquisition-manifest@9'
    ELSE 'arena.ingest.leaderboard-acquisition-manifest@3' END;
BEGIN
  INSERT INTO arena.raw_objects VALUES
    (p_run * 10 + 1, 1, 7, v_run, p_role, pg_catalog.repeat('a', 64), p_quarantined,
     pg_catalog.jsonb_build_object('pageCount', p_pages::jsonb,
       'parserPageCount', COALESCE(p_parser_pages,
         pg_catalog.jsonb_array_length(p_ordinals)::text)::jsonb,
       'parserSourcePageOrdinals', p_ordinals)),
    (p_run * 10 + 2, 1, 7, v_run, 'population_manifest', v_run, false,
     pg_catalog.jsonb_build_object('data_contract', v_contract));
  INSERT INTO arena.metric_trust_runs VALUES
    (v_run, 1, 7, p_run, p_run * 10 + 1, p_run * 10 + 2, 'verified',
     CASE WHEN p_kind = 'v3_exhausted' THEN NULL ELSE 100 END);
  IF p_kind IN ('v3_total', 'v3_exhausted') THEN
    INSERT INTO arena.latest_terminal_leaderboard_acquisitions VALUES
      (p_run, 1, 7, v_run, p_run * 10 + 1, p_run * 10 + 2,
       'arena.ingest.leaderboard-acquisition-manifest@3', 'complete', 'verified',
       COALESCE(p_terminal_pages, (p_pages::jsonb #>> '{}')::int), false, false, NULL,
       CASE WHEN p_kind = 'v3_exhausted' THEN 'unknown' ELSE 'complete' END,
       CASE WHEN p_kind = 'v3_exhausted' THEN 'unknown' ELSE 'verified' END,
       CASE WHEN p_kind = 'v3_exhausted' THEN 'population_unknown' END,
       CASE WHEN p_kind = 'v3_exhausted' THEN 'unknown' ELSE 'consistent' END,
       CASE WHEN p_kind = 'v3_exhausted' THEN NULL ELSE 100 END);
    IF p_kind = 'v3_exhausted' AND p_bound THEN
      INSERT INTO arena.exhaustion_bound_attempts VALUES (p_run);
    END IF;
  END IF;
END $$;

SELECT public.fixture_run(1, 'v3_total', '[1,2,3]', '3');
SELECT public.fixture_run(2, 'v3_exhausted', '[1,3]', '3');
SELECT public.fixture_run(3, 'v2', '[1,2]', '2');
SELECT public.fixture_run(10, 'v3_total', '[1,2]', '2', p_quarantined => true);
SELECT public.fixture_run(11, 'v3_total', '[1,2]', '2', p_role => 'diagnostic');
SELECT public.fixture_run(12, 'v3_total', '[1,2]', '"two"', p_terminal_pages => 2);
SELECT public.fixture_run(13, 'v3_total', '[1,2]', '0');
SELECT public.fixture_run(14, 'v3_total', '[1,2]', '3', p_parser_pages => '5');
SELECT public.fixture_run(15, 'v3_total', '[1,2,3]', '2');
SELECT public.fixture_run(16, 'v3_total', '[2,1]', '2');
SELECT public.fixture_run(17, 'v3_total', '[1,5]', '3');
SELECT public.fixture_run(18, 'v3_total', '[1,"2"]', '2');
SELECT public.fixture_run(19, 'v3_total', '[1,2.5]', '3');
SELECT public.fixture_run(20, 'v3_total', '[1,2]', '2', p_terminal_pages => 4);
SELECT public.fixture_run(21, 'v3_no_terminal', '[1,2]', '2');
SELECT public.fixture_run(22, 'v3_exhausted', '[1,2]', '2', p_bound => false);
SELECT public.fixture_run(23, 'unknown_contract', '[1,2]', '2');
SELECT public.fixture_run(24, 'v3_total', '{"a":1}', '2', p_parser_pages => '1');

-- One case = one INSERT statement of (run, ordinal) rows; rolled back.
CREATE TABLE public.cases (name text PRIMARY KEY, batch jsonb NOT NULL);
INSERT INTO public.cases VALUES
  ('valid v3 total',            '[[1,1],[1,2],[1,3],[1,3]]'),
  ('valid v3 exhaustion',       '[[2,1],[2,3],[2,3]]'),
  ('valid v2',                  '[[3,1],[3,2]]'),
  ('null ordinal is downgraded','[[1,null],[1,2]]'),
  ('only null ordinals',        '[[21,null]]'),
  ('zero ordinal',              '[[1,0]]'),
  ('negative ordinal',          '[[1,-2]]'),
  ('non-member ordinal',        '[[2,2]]'),
  ('ordinal beyond the pages',  '[[1,4]]'),
  ('one bad row in a batch',    '[[1,1],[1,2],[1,9],[1,3]]'),
  ('missing run',               '[[99,1]]'),
  ('quarantined payload',       '[[10,1]]'),
  ('wrong artifact role',       '[[11,1]]'),
  ('page count is not a number','[[12,1]]'),
  ('page count is zero',        '[[13,1]]'),
  ('parser count mismatch',     '[[14,1]]'),
  ('parser pages exceed pages', '[[15,1]]'),
  ('ordinals not increasing',   '[[16,1]]'),
  ('ordinal out of range',      '[[17,1]]'),
  ('ordinal is a string',       '[[18,1]]'),
  ('ordinal is a fraction',     '[[19,1]]'),
  ('terminal pages disagree',   '[[20,1]]'),
  ('terminal is missing',       '[[21,1]]'),
  ('exhaustion without proof',  '[[22,1]]'),
  ('unknown manifest contract', '[[23,1]]'),
  ('ordinals are not an array', '[[24,1]]'),
  ('two valid runs',            '[[1,1],[2,3],[1,2]]'),
  ('valid run and a bad run',   '[[1,1],[21,1]]');

CREATE FUNCTION public.run_case(p_name text) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  v_batch jsonb;
  v_result text;
BEGIN
  SELECT batch INTO STRICT v_batch FROM public.cases WHERE name = p_name;
  BEGIN
    INSERT INTO arena.metric_trust_observations
      (source_id, snapshot_id, source_run_id, timeframe, source_page_ordinal)
    SELECT 1, (item.value->>0)::int, 'run-' || (item.value->>0), 7, (item.value->>1)::int
      FROM pg_catalog.jsonb_array_elements(v_batch) WITH ORDINALITY AS item(value, position)
     ORDER BY item.position;
    SELECT 'kept ' || pg_catalog.string_agg(
             pg_catalog.concat_ws('/', COALESCE(source_page_ordinal::text, 'null'),
               quality, freshness_state, blocking_reasons::text), ' ' ORDER BY id)
      INTO v_result
      FROM arena.metric_trust_observations;
    -- Undo the rows of an accepted statement.
    RAISE EXCEPTION USING ERRCODE = 'P0999', MESSAGE = v_result;
  EXCEPTION
    WHEN SQLSTATE 'P0999' THEN
      RETURN SQLERRM;
    WHEN OTHERS THEN
      IF EXISTS (SELECT 1 FROM arena.metric_trust_observations) THEN
        RETURN 'refused but rows were kept';
      END IF;
      RETURN 'refused ' || SQLSTATE || ' ' || SQLERRM;
  END;
END $$;
SQL

# The readiness RPC exactly as 20261121185937 defines it. Its body references
# the whole metric-trust schema and is not called here; the migration checks
# its text before re-creating it.
READINESS_MIGRATION="$MIGRATIONS/20261121185937_metric_trust_readiness_bounded_lineage_count.sql"
awk '/^CREATE OR REPLACE FUNCTION public.arena_metric_trust_release_readiness\(\)/ { on = 1 }
     on { print }
     on && /^\$function\$;/ { exit }' "$READINESS_MIGRATION" >"$TMP_ROOT/old-readiness.sql"
psql_db -q -c "SET check_function_bodies = off" -f "$TMP_ROOT/old-readiness.sql"

# The section of the new readiness RPC that pins the two triggers and their
# functions, lifted out of the migration as one boolean.
{
  echo "SELECT EXISTS ("
  awk '/-- lineage-trigger-contract:begin/ { on = 1; next }
       /-- lineage-trigger-contract:end/ { on = 0 }
       on { print }' "$NEW_MIGRATION" | sed "s/v_postgres/pg_catalog.to_regrole('postgres')/g"
  echo ");"
} >"$TMP_ROOT/readiness-contract.sql"
grep -q "tgnewtable = 'inserted_observations'" "$TMP_ROOT/readiness-contract.sql"

psql_db -q -f "$OLD_FUNCTION"
psql_db -q <<'SQL'
ALTER FUNCTION arena.validate_metric_trust_source_page_lineage() OWNER TO postgres;
CREATE TRIGGER metric_trust_observations_source_page_lineage_before_insert
BEFORE INSERT ON arena.metric_trust_observations
FOR EACH ROW EXECUTE FUNCTION arena.validate_metric_trust_source_page_lineage();
SQL

outcomes() {
  psql_db -Atq -F $'\t' -c "SELECT name, public.run_case(name) FROM public.cases ORDER BY name"
}
exhaustion_calls_for() {
  # exhaustion proof evaluations spent on one statement
  psql_db -Atq -c "SELECT setval('arena.exhaustion_bound_calls', 1, false);
                   SELECT public.run_case('$1');
                   SELECT last_value - (NOT is_called)::int FROM arena.exhaustion_bound_calls" | tail -1
}
big_batch_ms() {
  psql_db -Atq <<'SQL' | tail -1
BEGIN;
SELECT public.fixture_run(500, 'v3_exhausted',
  (SELECT pg_catalog.jsonb_agg(n) FROM pg_catalog.generate_series(1, 433) AS n), '433');
CREATE TEMP TABLE timing ON COMMIT DROP AS SELECT pg_catalog.clock_timestamp() AS started;
INSERT INTO arena.metric_trust_observations
  (source_id, snapshot_id, source_run_id, timeframe, source_page_ordinal)
SELECT 1, 500, 'run-500', 7, 1 + (n % 433) FROM pg_catalog.generate_series(1, 20000) AS n;
SELECT pg_catalog.round(1000 * pg_catalog.date_part('epoch',
         pg_catalog.clock_timestamp() - started))::int FROM timing;
ROLLBACK;
SQL
}

BEFORE="$(outcomes)"
BEFORE_CALLS="$(exhaustion_calls_for 'valid v3 exhaustion')"
BEFORE_MS="$(big_batch_ms)"

# Sanity of the baseline itself: the cases exercise every refusal.
for expected in \
  $'valid v3 total\tkept 1/complete/verified/[] 2/complete/verified/[] 3/complete/verified/[] 3/complete/verified/[]' \
  $'zero ordinal\trefused 23514 source-page ordinal must be positive' \
  $'non-member ordinal\trefused 23514 source-page ordinal is not a parser input member' \
  $'missing run\trefused 23503 source-page ordinal has no exact immutable parser evidence' \
  $'terminal is missing\trefused 23503 source-page ordinal has no exact immutable parser evidence' \
  $'exhaustion without proof\trefused 23503 source-page ordinal has no exact immutable parser evidence' \
  $'terminal pages disagree\trefused 23514 parser-page evidence disagrees with the exact v3 terminal page count' \
  $'unknown manifest contract\trefused 23514 source-page ordinal uses an unsupported manifest contract'; do
  if ! grep -qxF "$expected" <<<"$BEFORE"; then
    echo "baseline outcome missing: $expected" >&2
    echo "$BEFORE" >&2
    exit 1
  fi
done
if [[ "$(grep -c $'\tkept ' <<<"$BEFORE")" != "6" ]]; then
  echo "expected exactly six accepted baseline cases" >&2
  echo "$BEFORE" >&2
  exit 1
fi
grep -qF $'null ordinal is downgraded\tkept null/unknown/unknown/[{"code": "source_page_lineage_missing", "state": "unknown"}] 2/complete/verified/[]' <<<"$BEFORE"
echo "ok: baseline (per-row trigger) accepts 6 of 28 cases and refuses the rest"

if [[ "$(psql_db -Atq -f "$TMP_ROOT/readiness-contract.sql")" != "f" ]]; then
  echo "the new readiness contract must not hold before the migration" >&2
  exit 1
fi

psql_db -q -f "$NEW_MIGRATION" >/dev/null

if [[ "$(psql_db -Atq -f "$TMP_ROOT/readiness-contract.sql")" != "t" ]]; then
  echo "the readiness RPC's trigger contract does not hold after the migration" >&2
  exit 1
fi
echo "ok: the readiness RPC's pins on both triggers and functions hold after the migration (not before)"
# Disabling or dropping the statement trigger must fail the startup gate.
psql_db -q -c "ALTER TABLE arena.metric_trust_observations DISABLE TRIGGER metric_trust_observations_source_page_lineage_after_statement"
if [[ "$(psql_db -Atq -f "$TMP_ROOT/readiness-contract.sql")" != "f" ]]; then
  echo "a disabled statement trigger still satisfies the readiness contract" >&2
  exit 1
fi
psql_db -q -c "ALTER TABLE arena.metric_trust_observations ENABLE TRIGGER metric_trust_observations_source_page_lineage_after_statement"
echo "ok: disabling the statement trigger breaks the readiness contract"
if [[ "$(psql_db -Atq -c "SELECT pg_catalog.strpos(prosrc, 'v_actual_ordinal = NEW.source_page_ordinal') FROM pg_proc WHERE oid = 'public.arena_metric_trust_release_readiness()'::regprocedure")" != "0" ]]; then
  echo "the readiness RPC still pins the per-row membership text" >&2
  exit 1
fi

AFTER="$(outcomes)"
if [[ "$BEFORE" != "$AFTER" ]]; then
  echo "outcomes changed after the migration:" >&2
  diff <(echo "$BEFORE") <(echo "$AFTER") >&2 || true
  exit 1
fi
echo "ok: all 28 cases have the identical outcome (rows kept, SQLSTATE and message) after the migration"

AFTER_CALLS="$(exhaustion_calls_for 'valid v3 exhaustion')"
if [[ "$BEFORE_CALLS" != "3" || "$AFTER_CALLS" != "1" ]]; then
  echo "exhaustion proof evaluations for a 3-row statement: before $BEFORE_CALLS (want 3), after $AFTER_CALLS (want 1)" >&2
  exit 1
fi
echo "ok: a 3-row exhaustion statement evaluates the proof once instead of 3 times"

AFTER_MS="$(big_batch_ms)"
if ((AFTER_MS * 10 > BEFORE_MS)); then
  echo "20,000 rows x 433 pages: before ${BEFORE_MS}ms, after ${AFTER_MS}ms (want at least 10x faster)" >&2
  exit 1
fi
echo "ok: 20,000 rows x 433 pages: ${BEFORE_MS}ms per row -> ${AFTER_MS}ms per statement"

# The migration refuses to run twice or over an unexpected definition.
if psql_db -q -f "$NEW_MIGRATION" >/dev/null 2>"$TMP_ROOT/replay.err"; then
  echo "replaying the migration was not refused" >&2
  exit 1
fi
grep -q "is not the 20261118112703 definition" "$TMP_ROOT/replay.err"
echo "ok: a replay is refused"

echo "metric trust observation lineage per statement PostgreSQL 17 proof passed"
