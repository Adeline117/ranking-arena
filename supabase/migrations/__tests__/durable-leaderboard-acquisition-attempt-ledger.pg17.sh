#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql"
COMPAT_MIGRATION="$ROOT_DIR/supabase/migrations/20260722040000_leaderboard_acquisition_manifest_v3_compat.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/leaderboard-acquisition-ledger-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((58000 + ($$ % 7000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -180 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure() {
  local label="$1"
  local sql="$2"
  local expected="${3:-}"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ -n "$expected" ]] && [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
    echo "$label failed for the wrong reason; expected: $expected" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
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
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  adapter_slug text NOT NULL,
  timeframes_native integer[] NOT NULL DEFAULT '{}',
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL,
  fetch_region text NOT NULL
);

CREATE TABLE arena.raw_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  job_type text NOT NULL,
  trader_id bigint,
  timeframe smallint,
  fetched_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  storage_path text NOT NULL UNIQUE,
  bytes integer NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}',
  source_run_id text,
  trust_artifact_role text
);

INSERT INTO arena.sources (
  id, slug, adapter_slug, timeframes_native, status, serving_mode, currency, fetch_region
) VALUES
  (1, 'binance_futures', 'binance', '{30}', 'active', 'serving', 'USDT', 'vps_sg'),
  (2, 'inactive_board', 'legacy', '{30}', 'inactive', 'legacy', 'USDT', 'local'),
  (3, 'legacy_board', 'legacy', '{30}', 'active', 'legacy', 'USDT', 'local'),
  (4, 'other_source', 'binance', '{30}', 'active', 'shadow', 'USDT', 'vps_jp');
SQL

psql_cmd -q -f "$MIGRATION"
psql_cmd -q -f "$COMPAT_MIGRATION"

psql_cmd -q <<'SQL'
CREATE TABLE public.ledger_test_pairs (
  attempt_id uuid PRIMARY KEY,
  capture_started_at timestamptz NOT NULL,
  capture_completed_at timestamptz NOT NULL,
  source_run_id text NOT NULL,
  payload_id bigint NOT NULL,
  manifest_id bigint NOT NULL
);

CREATE FUNCTION public.make_ledger_test_pair(
  p_attempt_id uuid,
  p_evidence_source_id integer,
  p_run_seed text,
  p_path_prefix text,
  p_quarantined boolean DEFAULT false,
  p_payload_role text DEFAULT 'source_payload',
  p_manifest_role text DEFAULT 'population_manifest',
  p_summary jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_attempt arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_completed_at timestamptz := pg_catalog.clock_timestamp();
  v_run_id text := pg_catalog.md5(p_run_seed)
    || pg_catalog.md5(p_run_seed || ':ledger');
  v_payload_id bigint;
  v_manifest_id bigint;
  v_default_summary jsonb := '{
    "capture_evidence_state":"verified",
    "termination_reason":"reported_population_reached",
    "source_page_count":1,
    "population_report_state":"consistent",
    "reported_population":1,
    "page_count_report_state":"consistent",
    "reported_page_count":1,
    "observed_population":1,
    "accepted_population":1,
    "rejected_row_count":0,
    "deduplicated_row_count":0,
    "caller_limited":false,
    "safety_limited":false,
    "acquisition_state":"complete",
    "population_state":"verified"
  }'::jsonb;
  v_attempt_summary jsonb;
BEGIN
  SELECT * INTO STRICT v_attempt
    FROM arena.leaderboard_acquisition_attempts
   WHERE attempt_id = p_attempt_id;

  v_attempt_summary := pg_catalog.jsonb_build_object(
    'binding_contract', v_attempt.attempt_binding_contract,
    'attempt_id', v_attempt.attempt_id,
    'attempt_seq', v_attempt.attempt_seq,
    'runner_git_sha', v_attempt.runner_git_sha,
    'capture_started_at', v_attempt.recorded_started_at,
    'capture_completed_at', v_completed_at
  ) || v_default_summary || p_summary;

  INSERT INTO arena.raw_objects (
    source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
    bytes, content_hash, quarantined, meta, source_run_id, trust_artifact_role
  ) VALUES (
    p_evidence_source_id,
    'tier_a',
    NULL,
    v_attempt.timeframe,
    v_completed_at,
    p_path_prefix || '/payload.json.gz',
    100,
    pg_catalog.repeat('a', 64),
    p_quarantined,
    pg_catalog.jsonb_build_object(
      'surface', 'tier_a_leaderboard',
      'source_run_id', v_run_id,
      'observation_cycle_id', v_attempt.observation_cycle_id,
      'acquisition_attempt', v_attempt_summary,
      'raw_integrity', pg_catalog.jsonb_build_object(
        'hash_algorithm', 'sha256',
        'hash_scope', 'json_utf8',
        'serialization_contract', 'arena.strict-canonical-json@1'
      )
    ),
    v_run_id,
    p_payload_role
  ) RETURNING id INTO STRICT v_payload_id;

  INSERT INTO arena.raw_objects (
    source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
    bytes, content_hash, quarantined, meta, source_run_id, trust_artifact_role
  ) VALUES (
    p_evidence_source_id,
    'tier_a_manifest',
    NULL,
    v_attempt.timeframe,
    v_completed_at,
    p_path_prefix || '/manifest.json.gz',
    100,
    v_run_id,
    p_quarantined,
    pg_catalog.jsonb_build_object(
      'surface', 'tier_a_leaderboard',
      'source_run_id', v_run_id,
      'observation_cycle_id', v_attempt.observation_cycle_id,
      'data_contract', v_attempt.capture_contract,
      'acquisition_attempt', v_attempt_summary,
      'raw_integrity', pg_catalog.jsonb_build_object(
        'hash_algorithm', 'sha256',
        'hash_scope', 'json_utf8',
        'serialization_contract', 'arena.strict-canonical-json@1'
      )
    ),
    v_run_id,
    p_manifest_role
  ) RETURNING id INTO STRICT v_manifest_id;

  INSERT INTO public.ledger_test_pairs (
    attempt_id,
    capture_started_at,
    capture_completed_at,
    source_run_id,
    payload_id,
    manifest_id
  ) VALUES (
    p_attempt_id,
    v_attempt.recorded_started_at,
    v_completed_at,
    v_run_id,
    v_payload_id,
    v_manifest_id
  );
END
$function$;
SQL

psql_cmd -q <<'SQL'
DO $test$
DECLARE
  v_first_seq bigint;
  v_replay_seq bigint;
  v_first_started timestamptz;
  v_replay_started timestamptz;
BEGIN
  SELECT attempt_seq, recorded_started_at
    INTO v_first_seq, v_first_started
    FROM arena.start_leaderboard_acquisition_attempt(
      '00000000-0000-0000-0000-000000000001',
      1,
      30,
      'tier-a:binance_futures:job-1:1000',
      'job-1',
      0,
      'arena.ingest.leaderboard-acquisition-manifest@2',
      repeat('1', 40),
      'vps_sg'
    );

  SELECT attempt_seq, recorded_started_at
    INTO v_replay_seq, v_replay_started
    FROM arena.start_leaderboard_acquisition_attempt(
      '00000000-0000-0000-0000-000000000001',
      1,
      30,
      'tier-a:binance_futures:job-1:1000',
      'job-1',
      0,
      'arena.ingest.leaderboard-acquisition-manifest@2',
      repeat('1', 40),
      'vps_sg'
    );

  IF v_first_seq IS DISTINCT FROM v_replay_seq
     OR v_first_started IS DISTINCT FROM v_replay_started
     OR v_first_started IS DISTINCT FROM pg_catalog.date_trunc(
       'milliseconds', v_first_started
     )
     OR (
       SELECT pg_catalog.count(*)
         FROM arena.leaderboard_acquisition_attempts
        WHERE attempt_id = '00000000-0000-0000-0000-000000000001'
     ) <> 1 THEN
    RAISE EXCEPTION 'begin exact replay was not idempotent';
  END IF;
END
$test$;

-- Exact replay remains valid after mutable registry state changes.
UPDATE arena.sources SET status = 'inactive' WHERE id = 1;
SELECT attempt_seq
  FROM arena.start_leaderboard_acquisition_attempt(
    '00000000-0000-0000-0000-000000000001',
    1,
    30,
    'tier-a:binance_futures:job-1:1000',
    'job-1',
    0,
    'arena.ingest.leaderboard-acquisition-manifest@2',
    repeat('1', 40),
    'vps_sg'
  );
UPDATE arena.sources SET status = 'active' WHERE id = 1;

-- Build the exact canonical RAW pair for attempt 1.
CREATE TEMP TABLE capture_clock AS
SELECT
  recorded_started_at AS capture_started_at,
  pg_catalog.clock_timestamp() AS capture_completed_at
FROM arena.leaderboard_acquisition_attempts
WHERE attempt_id = '00000000-0000-0000-0000-000000000001';

INSERT INTO arena.raw_objects (
  source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
  bytes, content_hash, quarantined, meta, source_run_id, trust_artifact_role
)
SELECT
  1,
  artifact.job_type,
  NULL,
  30,
  capture_clock.capture_completed_at,
  artifact.storage_path,
  100,
  artifact.content_hash,
  false,
  pg_catalog.jsonb_build_object(
    'surface', 'tier_a_leaderboard',
    'source_run_id', repeat('b', 64),
    'observation_cycle_id', 'tier-a:binance_futures:job-1:1000',
    'data_contract', artifact.data_contract,
    'acquisition_attempt', pg_catalog.jsonb_build_object(
      'binding_contract', 'arena.ingest.leaderboard-acquisition-attempt-binding@1',
      'attempt_id', '00000000-0000-0000-0000-000000000001',
      'attempt_seq', 1,
      'runner_git_sha', repeat('1', 40),
      'capture_started_at', capture_clock.capture_started_at,
      'capture_completed_at', capture_clock.capture_completed_at,
      'capture_evidence_state', 'verified',
      'termination_reason', 'reported_population_reached',
      'source_page_count', 1,
      'population_report_state', 'consistent',
      'reported_population', 2,
      'page_count_report_state', 'consistent',
      'reported_page_count', 1,
      'observed_population', 2,
      'accepted_population', 2,
      'rejected_row_count', 0,
      'deduplicated_row_count', 0,
      'caller_limited', false,
      'safety_limited', false,
      'acquisition_state', 'complete',
      'population_state', 'verified'
    ),
    'raw_integrity', pg_catalog.jsonb_build_object(
      'hash_algorithm', 'sha256',
      'hash_scope', 'json_utf8',
      'serialization_contract', 'arena.strict-canonical-json@1'
    )
  ),
  repeat('b', 64),
  artifact.role
FROM capture_clock
CROSS JOIN (
  VALUES
    ('tier_a'::text, 'run-a/payload.json.gz'::text, repeat('a', 64),
     NULL::text, 'source_payload'::text),
    ('tier_a_manifest'::text, 'run-a/manifest.json.gz'::text, repeat('b', 64),
     'arena.ingest.leaderboard-acquisition-manifest@2'::text,
     'population_manifest'::text)
) AS artifact(job_type, storage_path, content_hash, data_contract, role);

SELECT attempt_seq
  FROM arena.finish_leaderboard_acquisition_attempt(
    '00000000-0000-0000-0000-000000000001',
    'complete',
    'complete',
    'verified',
    'verified',
    'reported_population_reached',
    (SELECT capture_started_at FROM capture_clock),
    (SELECT capture_completed_at FROM capture_clock),
    repeat('b', 64),
    (SELECT id FROM arena.raw_objects WHERE storage_path = 'run-a/payload.json.gz'),
    (SELECT id FROM arena.raw_objects WHERE storage_path = 'run-a/manifest.json.gz'),
    NULL,
    2, 'consistent', 1, 1, 'consistent',
    2, 2, 0, 0,
    false, false,
    NULL,
    NULL
  );

DO $test$
DECLARE
  v_first arena.leaderboard_acquisition_outcomes%ROWTYPE;
  v_replay arena.leaderboard_acquisition_outcomes%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_first
    FROM arena.leaderboard_acquisition_outcomes
   WHERE attempt_seq = 1;

  SELECT * INTO STRICT v_replay
    FROM arena.finish_leaderboard_acquisition_attempt(
      '00000000-0000-0000-0000-000000000001',
      'complete',
      'complete',
      'verified',
      'verified',
      'reported_population_reached',
      (SELECT capture_started_at FROM capture_clock),
      (SELECT capture_completed_at FROM capture_clock),
      repeat('b', 64),
      (SELECT id FROM arena.raw_objects WHERE storage_path = 'run-a/payload.json.gz'),
      (SELECT id FROM arena.raw_objects WHERE storage_path = 'run-a/manifest.json.gz'),
      NULL,
      2, 'consistent', 1, 1, 'consistent',
      2, 2, 0, 0,
      false, false,
      NULL,
      NULL
    );

  IF v_first IS DISTINCT FROM v_replay THEN
    RAISE EXCEPTION 'finish exact replay changed the terminal row';
  END IF;
END
$test$;

-- A later started attempt is visible operationally, while terminal evidence
-- continues to point at the still-fresh prior success.
SELECT attempt_seq
  FROM arena.start_leaderboard_acquisition_attempt(
    '00000000-0000-0000-0000-000000000002',
    1,
    30,
    'tier-a:binance_futures:job-1:1000',
    'job-1',
    1,
    'arena.ingest.leaderboard-acquisition-manifest@2',
    repeat('1', 40),
    'vps_sg'
  );

DO $test$
BEGIN
  IF (SELECT attempt_id FROM arena.latest_leaderboard_acquisition_attempts
       WHERE source_id = 1 AND timeframe = 30)
       IS DISTINCT FROM '00000000-0000-0000-0000-000000000002'::uuid
     OR (SELECT attempt_status FROM arena.latest_leaderboard_acquisition_attempts
          WHERE source_id = 1 AND timeframe = 30)
          IS DISTINCT FROM 'started'
     OR (SELECT attempt_id FROM arena.latest_terminal_leaderboard_acquisitions
          WHERE source_id = 1 AND timeframe = 30)
          IS DISTINCT FROM '00000000-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'started-versus-terminal latest semantics are wrong';
  END IF;
END
$test$;

-- Same observation cycle is grouping metadata, not a uniqueness key.
DO $test$
DECLARE
  v_a bigint;
  v_b bigint;
BEGIN
  SELECT attempt_seq INTO v_a
    FROM arena.leaderboard_acquisition_attempts
   WHERE attempt_id = '00000000-0000-0000-0000-000000000001';
  SELECT attempt_seq INTO v_b
    FROM arena.leaderboard_acquisition_attempts
   WHERE attempt_id = '00000000-0000-0000-0000-000000000002';
  IF v_b <= v_a THEN
    RAISE EXCEPTION 'database attempt sequence is not increasing';
  END IF;
END
$test$;

-- A verified partial terminal now suppresses the prior complete terminal.
CREATE TEMP TABLE capture_clock_b AS
SELECT
  recorded_started_at AS capture_started_at,
  pg_catalog.clock_timestamp() AS capture_completed_at
FROM arena.leaderboard_acquisition_attempts
WHERE attempt_id = '00000000-0000-0000-0000-000000000002';

INSERT INTO arena.raw_objects (
  source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
  bytes, content_hash, quarantined, meta, source_run_id, trust_artifact_role
)
SELECT
  1,
  artifact.job_type,
  NULL,
  30,
  capture_clock_b.capture_completed_at,
  artifact.storage_path,
  100,
  artifact.content_hash,
  false,
  pg_catalog.jsonb_build_object(
    'surface', 'tier_a_leaderboard',
    'source_run_id', repeat('c', 64),
    'observation_cycle_id', 'tier-a:binance_futures:job-1:1000',
    'data_contract', artifact.data_contract,
    'acquisition_attempt', pg_catalog.jsonb_build_object(
      'binding_contract', 'arena.ingest.leaderboard-acquisition-attempt-binding@1',
      'attempt_id', '00000000-0000-0000-0000-000000000002',
      'attempt_seq', 2,
      'runner_git_sha', repeat('1', 40),
      'capture_started_at', capture_clock_b.capture_started_at,
      'capture_completed_at', capture_clock_b.capture_completed_at,
      'capture_evidence_state', 'verified',
      'termination_reason', 'caller_limit',
      'source_page_count', 1,
      'population_report_state', 'consistent',
      'reported_population', 5,
      'page_count_report_state', 'consistent',
      'reported_page_count', 2,
      'observed_population', 3,
      'accepted_population', 3,
      'rejected_row_count', 0,
      'deduplicated_row_count', 0,
      'caller_limited', true,
      'safety_limited', false,
      'acquisition_state', 'partial',
      'population_state', 'partial'
    ),
    'raw_integrity', pg_catalog.jsonb_build_object(
      'hash_algorithm', 'sha256',
      'hash_scope', 'json_utf8',
      'serialization_contract', 'arena.strict-canonical-json@1'
    )
  ),
  repeat('c', 64),
  artifact.role
FROM capture_clock_b
CROSS JOIN (
  VALUES
    ('tier_a'::text, 'run-b/payload.json.gz'::text, repeat('d', 64),
     NULL::text, 'source_payload'::text),
    ('tier_a_manifest'::text, 'run-b/manifest.json.gz'::text, repeat('c', 64),
     'arena.ingest.leaderboard-acquisition-manifest@2'::text,
     'population_manifest'::text)
) AS artifact(job_type, storage_path, content_hash, data_contract, role);

SELECT attempt_seq
  FROM arena.finish_leaderboard_acquisition_attempt(
    '00000000-0000-0000-0000-000000000002',
    'partial',
    'partial',
    'partial',
    'verified',
    'caller_limit',
    (SELECT capture_started_at FROM capture_clock_b),
    (SELECT capture_completed_at FROM capture_clock_b),
    repeat('c', 64),
    (SELECT id FROM arena.raw_objects WHERE storage_path = 'run-b/payload.json.gz'),
    (SELECT id FROM arena.raw_objects WHERE storage_path = 'run-b/manifest.json.gz'),
    NULL,
    5, 'consistent', 1, 2, 'consistent',
    3, 3, 0, 0,
    true, false,
    'upstream_fetch',
    'pagination_partial'
  );

DO $test$
BEGIN
  IF (SELECT attempt_id FROM arena.latest_terminal_leaderboard_acquisitions
       WHERE source_id = 1 AND timeframe = 30)
       IS DISTINCT FROM '00000000-0000-0000-0000-000000000002'::uuid
     OR (SELECT data_state FROM arena.latest_terminal_leaderboard_acquisitions
          WHERE source_id = 1 AND timeframe = 30)
          IS DISTINCT FROM 'partial' THEN
    RAISE EXCEPTION 'newer partial terminal did not suppress prior complete evidence';
  END IF;
END
$test$;

-- A newer failed attempt remains authoritative even if an older overlapping
-- attempt finishes complete afterward.
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000003', 1, 30,
  'tier-a:binance_futures:job-2:2000', 'job-2', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000004', 1, 30,
  'tier-a:binance_futures:job-3:3000', 'job-3', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT attempt_seq FROM arena.finish_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000004',
  'processing_failed', 'unknown', 'unknown', 'unassessed', NULL, NULL, NULL,
  NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, false,
  'session_open', 'upstream_unavailable'
);

CREATE TEMP TABLE capture_clock_c AS
SELECT
  recorded_started_at AS capture_started_at,
  pg_catalog.clock_timestamp() AS capture_completed_at
FROM arena.leaderboard_acquisition_attempts
WHERE attempt_id = '00000000-0000-0000-0000-000000000003';

INSERT INTO arena.raw_objects (
  source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
  bytes, content_hash, quarantined, meta, source_run_id, trust_artifact_role
)
SELECT
  1,
  artifact.job_type,
  NULL,
  30,
  capture_clock_c.capture_completed_at,
  artifact.storage_path,
  100,
  artifact.content_hash,
  false,
  pg_catalog.jsonb_build_object(
    'surface', 'tier_a_leaderboard',
    'source_run_id', repeat('e', 64),
    'observation_cycle_id', 'tier-a:binance_futures:job-2:2000',
    'data_contract', artifact.data_contract,
    'acquisition_attempt', pg_catalog.jsonb_build_object(
      'binding_contract', 'arena.ingest.leaderboard-acquisition-attempt-binding@1',
      'attempt_id', '00000000-0000-0000-0000-000000000003',
      'attempt_seq', 3,
      'runner_git_sha', repeat('1', 40),
      'capture_started_at', capture_clock_c.capture_started_at,
      'capture_completed_at', capture_clock_c.capture_completed_at,
      'capture_evidence_state', 'verified',
      'termination_reason', 'reported_population_reached',
      'source_page_count', 1,
      'population_report_state', 'consistent',
      'reported_population', 1,
      'page_count_report_state', 'consistent',
      'reported_page_count', 1,
      'observed_population', 1,
      'accepted_population', 1,
      'rejected_row_count', 0,
      'deduplicated_row_count', 0,
      'caller_limited', false,
      'safety_limited', false,
      'acquisition_state', 'complete',
      'population_state', 'verified'
    ),
    'raw_integrity', pg_catalog.jsonb_build_object(
      'hash_algorithm', 'sha256',
      'hash_scope', 'json_utf8',
      'serialization_contract', 'arena.strict-canonical-json@1'
    )
  ),
  repeat('e', 64),
  artifact.role
FROM capture_clock_c
CROSS JOIN (
  VALUES
    ('tier_a'::text, 'run-c/payload.json.gz'::text, repeat('f', 64),
     NULL::text, 'source_payload'::text),
    ('tier_a_manifest'::text, 'run-c/manifest.json.gz'::text, repeat('e', 64),
     'arena.ingest.leaderboard-acquisition-manifest@2'::text,
     'population_manifest'::text)
) AS artifact(job_type, storage_path, content_hash, data_contract, role);

SELECT attempt_seq FROM arena.finish_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000003',
  'complete', 'complete', 'verified', 'verified', 'reported_population_reached',
  (SELECT capture_started_at FROM capture_clock_c),
  (SELECT capture_completed_at FROM capture_clock_c),
  repeat('e', 64),
  (SELECT id FROM arena.raw_objects WHERE storage_path = 'run-c/payload.json.gz'),
  (SELECT id FROM arena.raw_objects WHERE storage_path = 'run-c/manifest.json.gz'),
  NULL, 1, 'consistent', 1, 1, 'consistent',
  1, 1, 0, 0, false, false, NULL, NULL
);

DO $test$
BEGIN
  IF (SELECT attempt_id FROM arena.latest_terminal_leaderboard_acquisitions
       WHERE source_id = 1 AND timeframe = 30)
       IS DISTINCT FROM '00000000-0000-0000-0000-000000000004'::uuid
     OR (SELECT attempt_status FROM arena.latest_terminal_leaderboard_acquisitions
          WHERE source_id = 1 AND timeframe = 30)
          IS DISTINCT FROM 'failed' THEN
    RAISE EXCEPTION 'late older completion overrode a newer terminal attempt';
  END IF;
END
$test$;

-- Legacy capture remains explicitly unknown and retains its unverified RAW.
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000010', 3, 30,
  'tier-a:legacy_board:job-10:10000', 'job-10', 0,
  'legacy_unverified', NULL, 'local'
);
CREATE TEMP TABLE legacy_clock AS
SELECT attempt_id, attempt_seq, attempt_binding_contract, recorded_started_at,
       pg_catalog.clock_timestamp() AS completed_at
FROM arena.leaderboard_acquisition_attempts
WHERE attempt_id = '00000000-0000-0000-0000-000000000010';
INSERT INTO arena.raw_objects (
  source_id, job_type, timeframe, fetched_at, storage_path, bytes,
  content_hash, quarantined, meta
)
SELECT
  3, 'tier_a', 30, completed_at, 'legacy/payload.json.gz', 50,
  repeat('9', 64), false,
  pg_catalog.jsonb_build_object(
    'observation_cycle_id', 'tier-a:legacy_board:job-10:10000',
    'acquisition_attempt', pg_catalog.jsonb_build_object(
      'binding_contract', attempt_binding_contract,
      'attempt_id', attempt_id,
      'attempt_seq', attempt_seq
    ),
    'raw_integrity', pg_catalog.jsonb_build_object(
      'hash_algorithm', 'sha256',
      'hash_scope', 'json_utf8'
    )
  )
FROM legacy_clock;
SELECT attempt_seq FROM arena.finish_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000010',
  'unknown', 'unknown', 'unknown', 'legacy_unverified', NULL,
  (SELECT recorded_started_at FROM legacy_clock),
  (SELECT completed_at FROM legacy_clock),
  NULL, NULL, NULL,
  (SELECT id FROM arena.raw_objects WHERE storage_path = 'legacy/payload.json.gz'),
  NULL, NULL, NULL, NULL, NULL, NULL, 4, 0, NULL,
  false, false, NULL, 'legacy_unverified'
);

-- RAW retention may delete pointers without deleting the durable ledger;
-- exact finish replay returns before trying to re-read the retired objects.
DELETE FROM arena.raw_objects
WHERE storage_path IN ('run-a/payload.json.gz', 'run-a/manifest.json.gz');
SELECT attempt_seq
  FROM arena.finish_leaderboard_acquisition_attempt(
    '00000000-0000-0000-0000-000000000001',
    'complete',
    'complete',
    'verified',
    'verified',
    'reported_population_reached',
    (SELECT capture_started_at FROM capture_clock),
    (SELECT capture_completed_at FROM capture_clock),
    repeat('b', 64),
    1,
    2,
    NULL,
    2, 'consistent', 1, 1, 'consistent',
    2, 2, 0, 0,
    false, false,
    NULL,
    NULL
  );

DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM arena.leaderboard_acquisition_outcomes
     WHERE source_payload_content_hash = repeat('a', 64)
       AND manifest_content_hash = repeat('b', 64)
  ) THEN
    RAISE EXCEPTION 'RAW deletion erased frozen ledger identity';
  END IF;
END
$test$;
SQL

psql_cmd -q <<'SQL'
-- Fresh attempts used by negative-path tests. They must not reuse already
-- terminal attempts, otherwise a replay conflict could mask the intended gate.
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000011', 3, 30,
  'tier-a:legacy_board:job-11:11000', 'job-11', 0,
  'legacy_unverified', NULL, 'local'
);
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000022', 1, 30,
  'tier-a:binance_futures:job-22:22000', 'job-22', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);

SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000023', 1, 30,
  'tier-a:binance_futures:job-23:23000', 'job-23', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000023', 4, '1', 'cross-source'
);

SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000024', 1, 30,
  'tier-a:binance_futures:job-24:24000', 'job-24', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000024', 1, '2', 'quarantined', true
);

SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000025', 1, 30,
  'tier-a:binance_futures:job-25:25000', 'job-25', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000025', 1, '3', 'bad-role', false,
  'population_manifest', 'source_payload'
);

SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000026', 1, 30,
  'tier-a:binance_futures:job-26:26000', 'job-26', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000026', 1, '4', 'null-count-complete',
  false, 'source_payload', 'population_manifest',
  '{
    "capture_evidence_state":"verified",
    "termination_reason":"reported_population_reached",
    "source_page_count":1,
    "population_report_state":"consistent",
    "reported_population":0,
    "page_count_report_state":"consistent",
    "reported_page_count":1,
    "observed_population":null,
    "accepted_population":null,
    "rejected_row_count":null,
    "deduplicated_row_count":null,
    "caller_limited":false,
    "safety_limited":false,
    "acquisition_state":"complete",
    "population_state":"verified"
  }'::jsonb
);

-- A capture may be structurally complete while population proof is unknown;
-- it remains explicitly unknown and cannot rank.
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000027', 1, 30,
  'tier-a:binance_futures:job-27:27000', 'job-27', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000027', 1, '5', 'verified-unknown',
  false, 'source_payload', 'population_manifest',
  '{
    "capture_evidence_state":"verified",
    "termination_reason":"reported_page_count_reached",
    "source_page_count":1,
    "population_report_state":"unknown",
    "reported_population":null,
    "page_count_report_state":"consistent",
    "reported_page_count":1,
    "observed_population":10,
    "accepted_population":10,
    "rejected_row_count":0,
    "deduplicated_row_count":0,
    "caller_limited":false,
    "safety_limited":false,
    "acquisition_state":"complete",
    "population_state":"unknown"
  }'::jsonb
);
SELECT outcome.attempt_seq
FROM public.ledger_test_pairs AS pair
CROSS JOIN LATERAL arena.finish_leaderboard_acquisition_attempt(
  pair.attempt_id,
  'unknown', 'complete', 'unknown', 'verified', 'reported_page_count_reached',
  pair.capture_started_at, pair.capture_completed_at,
  pair.source_run_id, pair.payload_id, pair.manifest_id, NULL,
  NULL, 'unknown', 1, 1, 'consistent',
  10, 10, 0, 0, false, false, NULL, 'population_unknown'
) AS outcome
WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000027';

SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000028', 1, 30,
  'tier-a:binance_futures:job-28:28000', 'job-28', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT attempt_seq FROM arena.finish_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000028',
  'abandoned', 'unknown', 'unknown', 'unassessed', NULL, NULL, NULL,
  NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, false,
  'stale_timeout', 'stale_timeout'
);

-- Fresh attempts reserved for adversarial contract-binding tests.
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000029', 1, 30,
  'tier-a:binance_futures:job-29:29000', 'job-29', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000032', 1, 30,
  'tier-a:binance_futures:job-1:1000', 'job-32', 2,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000033', 1, 30,
  'tier-a:binance_futures:job-33:33000', 'job-33', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000033', 1, '6', 'conflicting-pages',
  false, 'source_payload', 'population_manifest',
  '{
    "capture_evidence_state":"verified",
    "termination_reason":"reported_population_reached",
    "source_page_count":1,
    "population_report_state":"consistent",
    "reported_population":1,
    "page_count_report_state":"conflicting",
    "reported_page_count":null,
    "observed_population":1,
    "accepted_population":1,
    "rejected_row_count":0,
    "deduplicated_row_count":0,
    "caller_limited":false,
    "safety_limited":false,
    "acquisition_state":"complete",
    "population_state":"verified"
  }'::jsonb
);
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000034', 1, 30,
  'tier-a:binance_futures:job-34:34000', 'job-34', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000034', 1, '7', 'null-termination',
  false, 'source_payload', 'population_manifest',
  '{"termination_reason":null}'::jsonb
);
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000035', 1, 30,
  'tier-a:binance_futures:job-35:35000', 'job-35', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000035', 1, '8', 'null-page-state',
  false, 'source_payload', 'population_manifest',
  '{"termination_reason":"short_page","page_count_report_state":null,"reported_page_count":null}'::jsonb
);
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000036', 1, 30,
  'tier-a:binance_futures:job-36:36000', 'job-36', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000036', 1, '9', 'null-population-state',
  false, 'source_payload', 'population_manifest',
  '{"population_report_state":null}'::jsonb
);
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000037', 1, 30,
  'tier-a:binance_futures:job-37:37000', 'job-37', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000037', 1, '0', 'false-page-total',
  false, 'source_payload', 'population_manifest',
  '{"termination_reason":"reported_page_count_reached","source_page_count":1,"reported_page_count":100}'::jsonb
);
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000038', 1, 30,
  'tier-a:binance_futures:job-38:38000', 'job-38', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000038', 1, 'single-count',
  'false-single-snapshot', false, 'source_payload', 'population_manifest',
  '{"termination_reason":"single_snapshot","source_page_count":10,"page_count_report_state":"unknown","reported_page_count":null}'::jsonb
);

-- An empty sentinel page after the reported final page is a valid natural
-- termination in manifest v2 and must not be over-rejected by the DB mirror.
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000039', 1, 30,
  'tier-a:binance_futures:job-39:39000', 'job-39', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000039', 1, 'empty-plus-one',
  'valid-empty-plus-one', false, 'source_payload', 'population_manifest',
  '{"termination_reason":"empty_page","source_page_count":2,"page_count_report_state":"consistent","reported_page_count":1}'::jsonb
);
SELECT outcome.attempt_seq
FROM public.ledger_test_pairs AS pair
CROSS JOIN LATERAL arena.finish_leaderboard_acquisition_attempt(
  pair.attempt_id,
  'complete', 'complete', 'verified', 'verified', 'empty_page',
  pair.capture_started_at, pair.capture_completed_at,
  pair.source_run_id, pair.payload_id, pair.manifest_id, NULL,
  1, 'consistent', 2, 1, 'consistent',
  1, 1, 0, 0, false, false, NULL, NULL
) AS outcome
WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000039';

SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000041', 1, 30,
  'tier-a:binance_futures:job-41:41000', 'job-41', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000041', 1, 'bad-population-reason',
  'bad-population-reason', false, 'source_payload', 'population_manifest',
  '{"termination_reason":"reported_population_reached","population_report_state":"unknown","reported_population":null,"acquisition_state":"complete","population_state":"unknown"}'::jsonb
);
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000042', 1, 30,
  'tier-a:binance_futures:job-42:42000', 'job-42', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000042', 1, 'unknown-page-total',
  'unknown-page-total', false, 'source_payload', 'population_manifest',
  '{"termination_reason":"reported_page_count_reached","page_count_report_state":"unknown","reported_page_count":null}'::jsonb
);
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000043', 1, 30,
  'tier-a:binance_futures:job-43:43000', 'job-43', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000043', 1, 'short-population',
  'short-population', false, 'source_payload', 'population_manifest',
  '{"termination_reason":"short_page","population_report_state":"consistent","reported_population":10,"page_count_report_state":"unknown","reported_page_count":null,"observed_population":5,"accepted_population":5,"rejected_row_count":0,"deduplicated_row_count":0,"acquisition_state":"complete","population_state":"partial"}'::jsonb
);

-- A fully retained verified capture can still be unknown when upstream
-- reports contradict the apparent natural stop. It must finalize unknown,
-- never remain an in-progress attempt and never become rankable.
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000044', 1, 30,
  'tier-a:binance_futures:job-44:44000', 'job-44', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000044', 1, 'conflicting-natural',
  'conflicting-natural', false, 'source_payload', 'population_manifest',
  '{"termination_reason":"short_page","population_report_state":"conflicting","reported_population":null,"page_count_report_state":"consistent","reported_page_count":100,"acquisition_state":"unknown","population_state":"unknown"}'::jsonb
);
SELECT outcome.attempt_seq
FROM public.ledger_test_pairs AS pair
CROSS JOIN LATERAL arena.finish_leaderboard_acquisition_attempt(
  pair.attempt_id,
  'unknown', 'unknown', 'unknown', 'verified', 'short_page',
  pair.capture_started_at, pair.capture_completed_at,
  pair.source_run_id, pair.payload_id, pair.manifest_id, NULL,
  NULL, 'conflicting', 1, 100, 'consistent',
  1, 1, 0, 0, false, false, NULL, 'population_unknown'
) AS outcome
WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000044';

SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000045', 1, 30,
  'tier-a:binance_futures:job-45:45000', 'job-45', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000045', 1, 'zero-payload-hash',
  'zero-payload-hash'
);
UPDATE arena.raw_objects
   SET content_hash = repeat('0', 64)
 WHERE storage_path = 'zero-payload-hash/payload.json.gz';
SQL

expect_failure \
  "conflicting begin replay" \
  "SELECT arena.start_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000001', 1, 30, 'different-cycle', 'job-1', 0, 'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1',40), 'vps_sg')" \
  "attempt id replay conflicts with prior begin"

expect_failure \
  "inactive source begin" \
  "SELECT arena.start_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000020', 2, 30, NULL, NULL, 0, 'legacy_unverified', NULL, NULL)" \
  "is not active"

expect_failure \
  "non-native timeframe begin" \
  "SELECT arena.start_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000021', 1, 7, NULL, NULL, 0, 'legacy_unverified', NULL, NULL)" \
  "is not native"

expect_failure \
  "unregistered verified source begin" \
  "SELECT arena.start_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000080', 4, 30, NULL, NULL, 0, 'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1',40), 'vps_jp')" \
  "is not registered for source other_source"

expect_failure \
  "verified begin without runner SHA" \
  "SELECT arena.start_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000081', 1, 30, NULL, NULL, 0, 'arena.ingest.leaderboard-acquisition-manifest@2', NULL, 'vps_sg')" \
  "requires a full runner git SHA"

expect_failure \
  "verified begin with zero runner SHA" \
  "SELECT arena.start_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000082', 1, 30, NULL, NULL, 0, 'arena.ingest.leaderboard-acquisition-manifest@2', repeat('0',40), 'vps_sg')" \
  "invalid leaderboard acquisition begin arguments"

expect_failure \
  "conflicting finish replay" \
  "SELECT arena.finish_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000001', 'unknown', 'unknown', 'unknown', 'unassessed', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, false, 'session_open', 'upstream_unavailable')" \
  "finish replay conflicts with terminal outcome"

expect_failure \
  "legacy complete claim" \
  "SELECT arena.finish_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000011', 'complete', 'complete', 'verified', 'legacy_unverified', NULL, (SELECT recorded_started_at FROM arena.leaderboard_acquisition_attempts WHERE attempt_id='00000000-0000-0000-0000-000000000011'), clock_timestamp(), NULL, NULL, NULL, NULL, 1, 'consistent', 1, 1, 'consistent', 1, 1, 0, 0, false, false, NULL, NULL)" \
  "legacy acquisition cannot claim complete or partial evidence"

expect_failure \
  "future capture completion" \
  "SELECT arena.finish_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000022', 'processing_failed', 'unknown', 'unknown', 'unassessed', NULL, (SELECT recorded_started_at FROM arena.leaderboard_acquisition_attempts WHERE attempt_id='00000000-0000-0000-0000-000000000022'), clock_timestamp() + interval '1 hour', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, false, 'upstream_fetch', 'upstream_unavailable')" \
  "capture completion timestamp is invalid"

expect_failure \
  "capture predates durable begin" \
  "SELECT arena.finish_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000029', 'processing_failed', 'unknown', 'unknown', 'unassessed', NULL, (SELECT recorded_started_at - interval '1 millisecond' FROM arena.leaderboard_acquisition_attempts WHERE attempt_id='00000000-0000-0000-0000-000000000029'), (SELECT recorded_started_at FROM arena.leaderboard_acquisition_attempts WHERE attempt_id='00000000-0000-0000-0000-000000000029'), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, false, 'upstream_fetch', 'upstream_unavailable')" \
  "capture start must equal the database attempt start"

expect_failure \
  "verified attempt cannot downgrade capture contract" \
  "SELECT arena.finish_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000022', 'unknown', 'unknown', 'unknown', 'legacy_unverified', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, false, false, NULL, 'legacy_unverified')" \
  "capture evidence state does not match the attempt contract"

expect_failure \
  "cross-source RAW pair" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'complete', 'complete', 'verified', 'verified', 'reported_population_reached', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 1, 'consistent', 1, 1, 'consistent', 1, 1, 0, 0, false, false, NULL, NULL) FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000023'" \
  "source payload RAW does not match the acquisition attempt"

expect_failure \
  "quarantined RAW pair" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'complete', 'complete', 'verified', 'verified', 'reported_population_reached', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 1, 'consistent', 1, 1, 'consistent', 1, 1, 0, 0, false, false, NULL, NULL) FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000024'" \
  "source payload RAW does not match the acquisition attempt"

expect_failure \
  "wrong RAW role pair" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'complete', 'complete', 'verified', 'verified', 'reported_population_reached', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 1, 'consistent', 1, 1, 'consistent', 1, 1, 0, 0, false, false, NULL, NULL) FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000025'" \
  "source payload RAW does not match the acquisition attempt"

expect_failure \
  "complete outcome with NULL population counts" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'complete', 'complete', 'verified', 'verified', 'reported_population_reached', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 0, 'consistent', 1, 1, 'consistent', NULL, NULL, NULL, NULL, false, false, NULL, NULL) FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000026'" \
  "leaderboard_acquisition_terminal_shape"

expect_failure \
  "complete outcome with conflicting page count" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'complete', 'complete', 'verified', 'verified', 'reported_population_reached', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 1, 'consistent', 1, NULL, 'conflicting', 1, 1, 0, 0, false, false, NULL, NULL) FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000033'" \
  "leaderboard_acquisition_terminal_shape"

expect_failure \
  "complete outcome with NULL termination" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'complete', 'complete', 'verified', 'verified', NULL, pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 1, 'consistent', 1, 1, 'consistent', 1, 1, 0, 0, false, false, NULL, NULL) FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000034'" \
  "leaderboard_acquisition_terminal_shape"

expect_failure \
  "complete outcome with NULL page report state" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'complete', 'complete', 'verified', 'verified', 'short_page', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 1, 'consistent', 1, NULL, NULL, 1, 1, 0, 0, false, false, NULL, NULL) FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000035'" \
  "leaderboard_acquisition_terminal_shape"

expect_failure \
  "complete outcome with NULL population report state" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'complete', 'complete', 'verified', 'verified', 'reported_population_reached', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 1, NULL, 1, 1, 'consistent', 1, 1, 0, 0, false, false, NULL, NULL) FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000036'" \
  "leaderboard_acquisition_population_report_shape"

expect_failure \
  "complete outcome with false reported page total" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'complete', 'complete', 'verified', 'verified', 'reported_page_count_reached', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 1, 'consistent', 1, 100, 'consistent', 1, 1, 0, 0, false, false, NULL, NULL) FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000037'" \
  "leaderboard_acquisition_terminal_shape"

expect_failure \
  "single snapshot with multiple source pages" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'complete', 'complete', 'verified', 'verified', 'single_snapshot', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 1, 'consistent', 10, NULL, 'unknown', 1, 1, 0, 0, false, false, NULL, NULL) FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000038'" \
  "leaderboard_acquisition_terminal_shape"

expect_failure \
  "unknown population cannot claim reported population termination" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'unknown', 'complete', 'unknown', 'verified', 'reported_population_reached', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, NULL, 'unknown', 1, 1, 'consistent', 1, 1, 0, 0, false, false, NULL, 'population_unknown') FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000041'" \
  "leaderboard_acquisition_terminal_shape"

expect_failure \
  "reported page termination requires a page report" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'complete', 'complete', 'verified', 'verified', 'reported_page_count_reached', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 1, 'consistent', 1, NULL, 'unknown', 1, 1, 0, 0, false, false, NULL, NULL) FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000042'" \
  "leaderboard_acquisition_terminal_shape"

expect_failure \
  "natural partial cannot stop below reported population" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'partial', 'complete', 'partial', 'verified', 'short_page', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 10, 'consistent', 1, NULL, 'unknown', 5, 5, 0, 0, false, false, NULL, 'population_partial') FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000043'" \
  "leaderboard_acquisition_terminal_shape"

expect_failure \
  "zero RAW content digest" \
  "SELECT arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'complete', 'complete', 'verified', 'verified', 'reported_population_reached', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 1, 'consistent', 1, 1, 'consistent', 1, 1, 0, 0, false, false, NULL, NULL) FROM public.ledger_test_pairs AS pair WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000045'" \
  "source payload RAW does not match the acquisition attempt"

expect_failure \
  "physical retry cannot reuse prior RAW pair" \
  "SELECT arena.finish_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000032', 'partial', 'partial', 'partial', 'verified', 'caller_limit', (SELECT recorded_started_at FROM arena.leaderboard_acquisition_attempts WHERE attempt_id='00000000-0000-0000-0000-000000000032'), clock_timestamp(), repeat('c',64), (SELECT id FROM arena.raw_objects WHERE storage_path='run-b/payload.json.gz'), (SELECT id FROM arena.raw_objects WHERE storage_path='run-b/manifest.json.gz'), NULL, 5, 'consistent', 1, 2, 'consistent', 3, 3, 0, 0, true, false, 'upstream_fetch', 'pagination_partial')" \
  "source payload RAW does not match the acquisition attempt"

# The function-scoped GUC must be restored before control returns, even inside
# the caller's still-open transaction. Otherwise an owner could accidentally
# bypass the insert trigger after using the canonical RPC.
expect_failure \
  "begin mutation path leak" \
  "BEGIN; SELECT arena.start_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000030', 1, 30, NULL, NULL, 0, 'legacy_unverified', NULL, NULL); INSERT INTO arena.leaderboard_acquisition_attempts (attempt_id, source_id, source_slug, adapter_slug, timeframe, queue_attempt, capture_contract, source_status, source_serving_mode, source_currency, source_fetch_region, recorded_started_at) VALUES ('00000000-0000-0000-0000-000000000031', 1, 'binance_futures', 'binance', 30, 0, 'legacy_unverified', 'active', 'serving', 'USDT', 'vps_sg', clock_timestamp()); COMMIT" \
  "ledger is append-only and RPC-owned"

expect_failure \
  "finish mutation path leak" \
  "BEGIN; SELECT arena.start_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000070', 1, 30, 'tier-a:binance_futures:job-70:70000', 'job-70', 0, 'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1',40), 'vps_sg'); SELECT arena.start_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000071', 1, 30, 'tier-a:binance_futures:job-71:71000', 'job-71', 0, 'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1',40), 'vps_sg'); SELECT arena.finish_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000070', 'processing_failed', 'unknown', 'unknown', 'unassessed', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, false, 'session_open', 'upstream_unavailable'); INSERT INTO arena.leaderboard_acquisition_outcomes (attempt_seq, terminal_state, acquisition_state, population_state, capture_evidence_state, caller_limited, safety_limited, failure_stage, reason_code, recorded_completed_at) SELECT attempt_seq, 'processing_failed', 'unknown', 'unknown', 'unassessed', false, false, 'session_open', 'upstream_unavailable', clock_timestamp() FROM arena.leaderboard_acquisition_attempts WHERE attempt_id = '00000000-0000-0000-0000-000000000071'; COMMIT" \
  "ledger is append-only and RPC-owned"

expect_failure \
  "owner direct update" \
  "UPDATE arena.leaderboard_acquisition_attempts SET queue_attempt = queue_attempt + 1 WHERE attempt_seq = 1"
expect_failure \
  "owner direct delete" \
  "DELETE FROM arena.leaderboard_acquisition_outcomes WHERE attempt_seq = 1"
expect_failure \
  "owner direct truncate" \
  "TRUNCATE arena.leaderboard_acquisition_outcomes"

expect_failure \
  "owner capture registry update" \
  "UPDATE arena.leaderboard_capture_contracts SET adapter_slug = 'forged' WHERE source_id = 1"
expect_failure \
  "owner capture registry delete" \
  "DELETE FROM arena.leaderboard_capture_contracts WHERE source_id = 1"
expect_failure \
  "owner capture registry truncate" \
  "TRUNCATE arena.leaderboard_capture_contracts"

expect_failure \
  "bound RAW identity mutation" \
  "UPDATE arena.raw_objects SET meta = meta || '{\"forged\":true}'::jsonb WHERE storage_path = 'run-b/payload.json.gz'" \
  "cannot be mutated"

expect_failure \
  "service direct insert" \
  "SET ROLE service_role; INSERT INTO arena.leaderboard_acquisition_outcomes (attempt_seq, terminal_state, acquisition_state, population_state, capture_evidence_state, caller_limited, safety_limited, recorded_completed_at) VALUES (999, 'processing_failed', 'unknown', 'unknown', 'unassessed', false, false, clock_timestamp())"
expect_failure \
  "service capture registry insert" \
  "SET ROLE service_role; INSERT INTO arena.leaderboard_capture_contracts (source_id, capture_contract, adapter_slug, attempt_binding_contract) VALUES (3, 'arena.ingest.leaderboard-acquisition-manifest@2', 'legacy', 'arena.ingest.leaderboard-acquisition-attempt-binding@1')"
expect_failure \
  "anon private read" \
  "SET ROLE anon; SELECT * FROM arena.leaderboard_acquisition_attempts"
expect_failure \
  "anon capture registry read" \
  "SET ROLE anon; SELECT * FROM arena.leaderboard_capture_contracts"
expect_failure \
  "authenticated private RPC" \
  "SET ROLE authenticated; SELECT arena.start_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000040', 1, 30, NULL, NULL, 0, 'legacy_unverified', NULL, NULL)"

psql_cmd -q <<'SQL'
SET ROLE service_role;
SELECT attempt_seq FROM arena.leaderboard_acquisition_attempts ORDER BY attempt_seq LIMIT 1;
SELECT attempt_seq FROM arena.latest_terminal_leaderboard_acquisitions
ORDER BY attempt_seq LIMIT 1;
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000050', 1, 30,
  NULL, NULL, 0, 'legacy_unverified', NULL, NULL
);
SELECT attempt_seq FROM arena.finish_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000050',
  'processing_failed', 'unknown', 'unknown', 'unassessed', NULL, NULL, NULL,
  NULL, NULL, NULL, NULL,
  NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, false, false,
  'session_open', 'upstream_unavailable'
);
RESET ROLE;

DO $test$
DECLARE
  v_raw_fks bigint;
  v_restrict_fks bigint;
  v_unique_raw_identities bigint;
BEGIN
  IF pg_catalog.has_sequence_privilege(
       'service_role',
       'arena.leaderboard_acquisition_attempts_attempt_seq_seq',
       'USAGE'
     )
     OR pg_catalog.has_sequence_privilege(
       'service_role',
       'arena.leaderboard_acquisition_attempts_attempt_seq_seq',
       'SELECT'
     ) THEN
    RAISE EXCEPTION 'service role retained direct sequence access';
  END IF;

  SELECT pg_catalog.count(*)
    INTO v_raw_fks
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.conrelid = 'arena.leaderboard_acquisition_outcomes'::regclass
     AND constraint_row.contype = 'f'
     AND constraint_row.confrelid = 'arena.raw_objects'::regclass;
  IF v_raw_fks <> 0 THEN
    RAISE EXCEPTION 'outcome RAW pointers are not soft references';
  END IF;

  SELECT pg_catalog.count(*)
    INTO v_restrict_fks
    FROM pg_catalog.pg_constraint AS constraint_row
   WHERE constraint_row.contype = 'f'
     AND constraint_row.confdeltype = 'r'
     AND (
       constraint_row.conname = 'leaderboard_acquisition_attempts_source_id_fkey'
       OR constraint_row.conname = 'leaderboard_acquisition_outcomes_attempt_seq_fkey'
     );
  IF v_restrict_fks <> 2 THEN
    RAISE EXCEPTION 'ledger parent foreign keys are not both ON DELETE RESTRICT';
  END IF;

  SELECT pg_catalog.count(*)
    INTO v_unique_raw_identities
    FROM pg_catalog.pg_indexes AS index_row
   WHERE index_row.schemaname = 'arena'
     AND index_row.indexname = ANY (ARRAY[
       'uidx_leaderboard_acquisition_outcomes_source_run',
       'uidx_leaderboard_acquisition_outcomes_source_payload',
       'uidx_leaderboard_acquisition_outcomes_manifest',
       'uidx_leaderboard_acquisition_outcomes_diagnostic'
     ])
     AND index_row.indexdef LIKE 'CREATE UNIQUE INDEX%';
  IF v_unique_raw_identities <> 4 THEN
    RAISE EXCEPTION 'ledger RAW identities are not uniquely owned';
  END IF;

  IF pg_catalog.has_table_privilege(
       'service_role', 'arena.leaderboard_acquisition_attempts',
       'INSERT,UPDATE,DELETE,TRUNCATE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.leaderboard_acquisition_outcomes',
       'INSERT,UPDATE,DELETE,TRUNCATE'
     ) THEN
    RAISE EXCEPTION 'service role retained direct ledger mutation privileges';
  END IF;
END
$test$;
SQL

# Prove there is no validate-to-insert race: finish holds every referenced RAW
# row lock until COMMIT. A concurrent mutation must wait, then see the durable
# outcome in the protection trigger and fail rather than diverging live/frozen
# evidence identity.
psql_cmd -q <<'SQL'
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000090', 1, 30,
  'tier-a:binance_futures:job-90:90000', 'job-90', 0,
  'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000090', 1, 'concurrent-raw',
  'concurrent-raw'
);
SQL

RAW_RACE_LOG="$TMP_ROOT/raw-race-finish.log"
RAW_RACE_ERROR="$TMP_ROOT/raw-race-update.log"
psql_cmd -q -c \
  "BEGIN; SELECT outcome.attempt_seq FROM public.ledger_test_pairs AS pair CROSS JOIN LATERAL arena.finish_leaderboard_acquisition_attempt(pair.attempt_id, 'complete', 'complete', 'verified', 'verified', 'reported_population_reached', pair.capture_started_at, pair.capture_completed_at, pair.source_run_id, pair.payload_id, pair.manifest_id, NULL, 1, 'consistent', 1, 1, 'consistent', 1, 1, 0, 0, false, false, NULL, NULL) AS outcome WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000090'; SELECT pg_sleep(1); COMMIT" \
  >"$RAW_RACE_LOG" 2>&1 &
raw_finish_pid=$!

raw_lock_seen=false
for _ in {1..40}; do
  if [[ "$(psql_cmd -Atq -c "SELECT pg_catalog.count(*) FROM pg_catalog.pg_locks WHERE relation = 'arena.raw_objects'::regclass AND mode = 'RowShareLock' AND granted")" -gt 0 ]]; then
    raw_lock_seen=true
    break
  fi
  sleep 0.05
done
if [[ "$raw_lock_seen" != true ]]; then
  echo "finish never acquired the RAW validation lock" >&2
  wait "$raw_finish_pid" || cat "$RAW_RACE_LOG" >&2
  exit 1
fi

if psql_cmd -q -c \
  "UPDATE arena.raw_objects SET content_hash = repeat('0',64) WHERE storage_path = 'concurrent-raw/payload.json.gz'" \
  >"$RAW_RACE_ERROR" 2>&1; then
  echo "concurrent RAW mutation unexpectedly succeeded" >&2
  wait "$raw_finish_pid" || true
  exit 1
fi
if [[ "$(<"$RAW_RACE_ERROR")" != *"cannot be mutated"* ]]; then
  echo "concurrent RAW mutation failed for the wrong reason" >&2
  cat "$RAW_RACE_ERROR" >&2
  wait "$raw_finish_pid" || true
  exit 1
fi
wait "$raw_finish_pid"

psql_cmd -q <<'SQL'
DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM arena.leaderboard_acquisition_outcomes AS outcome
      JOIN arena.raw_objects AS raw_object
        ON raw_object.id = outcome.source_payload_raw_object_id
     WHERE outcome.attempt_seq = (
       SELECT attempt_seq
         FROM arena.leaderboard_acquisition_attempts
        WHERE attempt_id = '00000000-0000-0000-0000-000000000090'
     )
       AND outcome.source_payload_content_hash = raw_object.content_hash
       AND outcome.source_payload_storage_path = raw_object.storage_path
  ) THEN
    RAISE EXCEPTION 'concurrent finish diverged frozen and live RAW identity';
  END IF;
END
$test$;
SQL

CONCURRENT_LOG="$TMP_ROOT/concurrent-begin.log"
psql_cmd -q -c \
  "BEGIN; SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000060', 1, 30, 'tier-a:binance_futures:job-60:60000', 'job-60', 0, 'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1',40), 'vps_sg'); SELECT pg_sleep(1); COMMIT" \
  >"$CONCURRENT_LOG" 2>&1 &
first_pid=$!
sleep 0.2
psql_cmd -q -c \
  "SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt('00000000-0000-0000-0000-000000000060', 1, 30, 'tier-a:binance_futures:job-60:60000', 'job-60', 0, 'arena.ingest.leaderboard-acquisition-manifest@2', repeat('1',40), 'vps_sg')" \
  >>"$CONCURRENT_LOG" 2>&1
wait "$first_pid"

psql_cmd -q <<'SQL'
DO $test$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
      FROM arena.leaderboard_acquisition_attempts
     WHERE attempt_id = '00000000-0000-0000-0000-000000000060'
  ) <> 1 THEN
    RAISE EXCEPTION 'concurrent exact begin created duplicate attempts';
  END IF;
END
$test$;
SQL

# The additive compatibility migration must admit a new attempt-bound v3 run
# without weakening the still-valid v2 proofs above.
psql_cmd -q <<'SQL'
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-0000-0000-000000000091', 1, 30,
  'tier-a:binance_futures:job-91:91000', 'job-91', 0,
  'arena.ingest.leaderboard-acquisition-manifest@3', repeat('1', 40), 'vps_sg'
);
SELECT public.make_ledger_test_pair(
  '00000000-0000-0000-0000-000000000091', 1, 'manifest-v3-complete',
  'manifest-v3-complete'
);
SELECT outcome.attempt_seq
FROM public.ledger_test_pairs AS pair
CROSS JOIN LATERAL arena.finish_leaderboard_acquisition_attempt(
  pair.attempt_id,
  'complete', 'complete', 'verified', 'verified',
  'reported_population_reached',
  pair.capture_started_at, pair.capture_completed_at,
  pair.source_run_id, pair.payload_id, pair.manifest_id, NULL,
  1, 'consistent', 1, 1, 'consistent',
  1, 1, 0, 0, false, false, NULL, NULL
) AS outcome
WHERE pair.attempt_id = '00000000-0000-0000-0000-000000000091';

DO $test$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM arena.leaderboard_acquisition_attempts AS attempt
      JOIN arena.leaderboard_acquisition_outcomes AS outcome
        ON outcome.attempt_seq = attempt.attempt_seq
      JOIN public.ledger_test_pairs AS pair
        ON pair.attempt_id = attempt.attempt_id
      JOIN arena.raw_objects AS manifest
        ON manifest.id = outcome.manifest_raw_object_id
     WHERE attempt.attempt_id =
           '00000000-0000-0000-0000-000000000091'::uuid
       AND attempt.capture_contract =
           'arena.ingest.leaderboard-acquisition-manifest@3'
       AND outcome.terminal_state = 'complete'
       AND outcome.acquisition_state = 'complete'
       AND outcome.population_state = 'verified'
       AND outcome.source_run_id = pair.source_run_id
       AND manifest.content_hash = pair.source_run_id
       AND manifest.meta->>'data_contract' =
           'arena.ingest.leaderboard-acquisition-manifest@3'
       AND manifest.meta->'acquisition_attempt'->>'attempt_id' =
           attempt.attempt_id::text
       AND (manifest.meta->'acquisition_attempt'->>'attempt_seq')::bigint =
           attempt.attempt_seq
  ) THEN
    RAISE EXCEPTION 'manifest v3 complete RAW/finish proof failed';
  END IF;
END
$test$;
SQL

echo "durable leaderboard acquisition attempt ledger PG17 proof passed"
