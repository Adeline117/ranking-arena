#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729013000_bitget_bot_attempt_health_contract.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/bitget-bot-attempt-health-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 8000)))}"
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
  local expected="$3"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
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
CREATE ROLE service_role NOLOGIN;
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA arena TO service_role;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  product_type text NOT NULL,
  adapter_slug text NOT NULL,
  trader_kind_scope text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL,
  timeframes_native integer[] NOT NULL,
  timeframes_derived integer[] NOT NULL,
  page_size integer NOT NULL,
  pagination_kind text NOT NULL,
  meta jsonb NOT NULL
);

CREATE TABLE arena.leaderboard_capture_contracts (
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  capture_contract text NOT NULL,
  adapter_slug text NOT NULL,
  attempt_binding_contract text NOT NULL,
  requires_runner_git_sha boolean NOT NULL,
  PRIMARY KEY (source_id, capture_contract)
);

CREATE TABLE arena.leaderboard_acquisition_attempts (
  attempt_seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_id uuid NOT NULL UNIQUE,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  source_slug text NOT NULL,
  timeframe smallint NOT NULL,
  capture_contract text NOT NULL,
  recorded_started_at timestamptz NOT NULL
);

CREATE TABLE arena.leaderboard_acquisition_outcomes (
  attempt_seq bigint PRIMARY KEY REFERENCES arena.leaderboard_acquisition_attempts(attempt_seq),
  terminal_state text NOT NULL,
  recorded_completed_at timestamptz NOT NULL,
  source_run_id text,
  source_payload_raw_object_id bigint,
  manifest_raw_object_id bigint
);

CREATE TABLE arena.leaderboard_snapshots (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  count_check_passed boolean NOT NULL,
  is_derived boolean NOT NULL DEFAULT false,
  raw_object_id bigint,
  meta jsonb NOT NULL DEFAULT '{}'
);

CREATE VIEW arena.latest_leaderboard_acquisition_attempts
WITH (security_invoker = true)
AS
SELECT DISTINCT ON (attempt.source_id, attempt.timeframe)
  attempt.attempt_seq,
  attempt.attempt_id,
  attempt.source_id,
  attempt.source_slug,
  attempt.timeframe,
  attempt.capture_contract,
  attempt.recorded_started_at,
  COALESCE(outcome.terminal_state, 'in_progress') AS terminal_state,
  outcome.recorded_completed_at,
  outcome.source_run_id,
  outcome.source_payload_raw_object_id,
  outcome.manifest_raw_object_id
FROM arena.leaderboard_acquisition_attempts AS attempt
LEFT JOIN arena.leaderboard_acquisition_outcomes AS outcome
  ON outcome.attempt_seq = attempt.attempt_seq
ORDER BY attempt.source_id, attempt.timeframe, attempt.attempt_seq DESC;

CREATE FUNCTION arena.serialize_leaderboard_terminal_publication()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN NEW;
END
$function$;

CREATE TRIGGER leaderboard_acquisition_outcomes_serialize_terminal_publication
BEFORE INSERT ON arena.leaderboard_acquisition_outcomes
FOR EACH ROW EXECUTE FUNCTION arena.serialize_leaderboard_terminal_publication();

CREATE TABLE public.terminal_fence_before (
  function_definition text NOT NULL,
  trigger_definition text NOT NULL
);
INSERT INTO public.terminal_fence_before
SELECT
  pg_catalog.pg_get_functiondef(
    'arena.serialize_leaderboard_terminal_publication()'::pg_catalog.regprocedure
  ),
  pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
FROM pg_catalog.pg_trigger AS trigger_row
WHERE trigger_row.tgrelid = 'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
  AND trigger_row.tgname =
      'leaderboard_acquisition_outcomes_serialize_terminal_publication'
  AND NOT trigger_row.tgisinternal;

INSERT INTO arena.sources (
  id, slug, product_type, adapter_slug, trader_kind_scope, status, serving_mode,
  currency, timeframes_native, timeframes_derived, page_size, pagination_kind, meta
) VALUES
  (
    1, 'bitget_bots_futures', 'futures', 'bitget_bots', 'bot', 'active',
    'serving', 'USDT', ARRAY[30], ARRAY[]::integer[], 20, 'numeric',
    '{"boards":["futures_grid","futures_martingale"]}'
  ),
  (
    2, 'bitget_bots_spot', 'spot', 'bitget_bots', 'bot', 'active',
    'serving', 'USDT', ARRAY[30], ARRAY[]::integer[], 20, 'numeric',
    '{"boards":["spot_grid","spot_martingale"]}'
  ),
  (
    3, 'unrelated_board', 'futures', 'other', 'human', 'active',
    'serving', 'USDT', ARRAY[30], ARRAY[]::integer[], 20, 'numeric', '{}'
  );

INSERT INTO arena.leaderboard_capture_contracts
  (source_id, capture_contract, adapter_slug, attempt_binding_contract,
   requires_runner_git_sha)
VALUES
  (1, 'arena.ingest.leaderboard-acquisition-manifest@4', 'bitget_bots',
   'arena.ingest.leaderboard-acquisition-attempt-binding@1', true),
  (2, 'arena.ingest.leaderboard-acquisition-manifest@4', 'bitget_bots',
   'arena.ingest.leaderboard-acquisition-attempt-binding@1', true);

GRANT SELECT ON arena.sources, arena.leaderboard_capture_contracts,
  arena.leaderboard_acquisition_attempts, arena.leaderboard_acquisition_outcomes,
  arena.leaderboard_snapshots, arena.latest_leaderboard_acquisition_attempts
  TO service_role;
SQL

psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
DO $test$
BEGIN
  IF EXISTS (
       SELECT 1
       FROM public.terminal_fence_before AS before
       WHERE before.function_definition IS DISTINCT FROM pg_catalog.pg_get_functiondef(
               'arena.serialize_leaderboard_terminal_publication()'::pg_catalog.regprocedure
             )
          OR before.trigger_definition IS DISTINCT FROM (
               SELECT pg_catalog.pg_get_triggerdef(trigger_row.oid, true)
               FROM pg_catalog.pg_trigger AS trigger_row
               WHERE trigger_row.tgrelid =
                     'arena.leaderboard_acquisition_outcomes'::pg_catalog.regclass
                 AND trigger_row.tgname =
                     'leaderboard_acquisition_outcomes_serialize_terminal_publication'
                 AND NOT trigger_row.tgisinternal
             )
     ) THEN
    RAISE EXCEPTION 'attempt-health migration changed the terminal fence';
  END IF;
END
$test$;

CREATE FUNCTION public.assert_attempt_health(p_slug text, p_expected text)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_actual text;
BEGIN
  SELECT health.health_state
    INTO STRICT v_actual
    FROM public.arena_bitget_bot_acquisition_attempt_health() AS health
   WHERE health.source_slug = p_slug;
  IF v_actual IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'health mismatch for %: expected %, got %',
      p_slug, p_expected, v_actual;
  END IF;
END
$function$;

SET ROLE service_role;
DO $test$
BEGIN
  IF (SELECT pg_catalog.count(*)
        FROM public.arena_bitget_bot_acquisition_attempt_health()) <> 2 THEN
    RAISE EXCEPTION 'health contract did not return exactly two registry rows';
  END IF;
  PERFORM public.assert_attempt_health('bitget_bots_futures', 'not_started');
  PERFORM public.assert_attempt_health('bitget_bots_spot', 'not_started');
END
$test$;
RESET ROLE;

-- The append-only V4 registry, not mutable source rollout flags, owns the two
-- watchdog rows after install.
UPDATE arena.sources SET status = 'inactive' WHERE id = 2;
SET ROLE service_role;
DO $test$
BEGIN
  IF (SELECT pg_catalog.count(*)
        FROM public.arena_bitget_bot_acquisition_attempt_health()) <> 2 THEN
    RAISE EXCEPTION 'mutable source flags removed a fixed V4 registry row';
  END IF;
  PERFORM public.assert_attempt_health('bitget_bots_spot', 'not_started');
END
$test$;
RESET ROLE;

INSERT INTO arena.leaderboard_acquisition_attempts
  (attempt_id, source_id, source_slug, timeframe, capture_contract, recorded_started_at)
VALUES
  ('00000000-0000-0000-0000-000000000001', 3, 'unrelated_board', 30,
   'arena.ingest.leaderboard-acquisition-manifest@4', pg_catalog.statement_timestamp());

SET ROLE service_role;
SELECT public.assert_attempt_health('bitget_bots_futures', 'not_started');
RESET ROLE;

-- A latest physical row cannot disappear behind a mutable source-slug join or
-- inherit publication semantics from an older acquisition contract. Both a
-- Legacy or misbound latest attempts fail closed as unknown.
INSERT INTO arena.leaderboard_acquisition_attempts
  (attempt_id, source_id, source_slug, timeframe, capture_contract, recorded_started_at)
VALUES
  ('01000000-0000-0000-0000-000000000001', 1, 'bitget_bots_futures', 30,
   'arena.ingest.leaderboard-acquisition-manifest@3',
   pg_catalog.statement_timestamp());
SET ROLE service_role;
SELECT public.assert_attempt_health('bitget_bots_futures', 'unknown');
RESET ROLE;

INSERT INTO arena.leaderboard_acquisition_attempts
  (attempt_id, source_id, source_slug, timeframe, capture_contract, recorded_started_at)
VALUES
  ('01000000-0000-0000-0000-000000000002', 1, 'misbound_source_slug', 30,
   'arena.ingest.leaderboard-acquisition-manifest@4',
   pg_catalog.statement_timestamp());
SET ROLE service_role;
SELECT public.assert_attempt_health('bitget_bots_futures', 'unknown');
RESET ROLE;

INSERT INTO arena.leaderboard_acquisition_attempts
  (attempt_id, source_id, source_slug, timeframe, capture_contract, recorded_started_at)
VALUES
  ('10000000-0000-0000-0000-000000000001', 1, 'bitget_bots_futures', 30,
   'arena.ingest.leaderboard-acquisition-manifest@4',
   pg_catalog.statement_timestamp() - interval '1 hour');
SET ROLE service_role;
SELECT public.assert_attempt_health('bitget_bots_futures', 'open_fresh');
RESET ROLE;

INSERT INTO arena.leaderboard_acquisition_attempts
  (attempt_id, source_id, source_slug, timeframe, capture_contract, recorded_started_at)
VALUES
  ('10000000-0000-0000-0000-000000000002', 1, 'bitget_bots_futures', 30,
   'arena.ingest.leaderboard-acquisition-manifest@4',
   pg_catalog.statement_timestamp() - interval '2 hours');
SET ROLE service_role;
SELECT public.assert_attempt_health('bitget_bots_futures', 'open_stale_suspect');
RESET ROLE;

INSERT INTO arena.leaderboard_acquisition_attempts
  (attempt_id, source_id, source_slug, timeframe, capture_contract, recorded_started_at)
SELECT
  ('10000000-0000-0000-0000-' || pg_catalog.lpad(value.ordinal::text, 12, '0'))::uuid,
  1, 'bitget_bots_futures', 30,
  'arena.ingest.leaderboard-acquisition-manifest@4',
  pg_catalog.statement_timestamp() - interval '1 minute'
FROM (VALUES (3), (4), (5), (6)) AS value(ordinal);

INSERT INTO arena.leaderboard_acquisition_outcomes
  (attempt_seq, terminal_state, recorded_completed_at)
SELECT attempt.attempt_seq, terminal.state, pg_catalog.statement_timestamp()
FROM (
  VALUES
    ('10000000-0000-0000-0000-000000000003'::uuid, 'partial'::text),
    ('10000000-0000-0000-0000-000000000004'::uuid, 'unknown'::text),
    ('10000000-0000-0000-0000-000000000005'::uuid, 'processing_failed'::text),
    ('10000000-0000-0000-0000-000000000006'::uuid, 'abandoned'::text)
) AS terminal(attempt_id, state)
JOIN arena.leaderboard_acquisition_attempts AS attempt
  ON attempt.attempt_id = terminal.attempt_id;

-- Re-point the latest fence to each exact terminal without changing clocks.
SET ROLE service_role;
DO $test$
DECLARE
  v_expected text;
BEGIN
  SELECT health_state INTO STRICT v_expected
  FROM public.arena_bitget_bot_acquisition_attempt_health()
  WHERE source_slug = 'bitget_bots_futures';
  IF v_expected <> 'abandoned' THEN
    RAISE EXCEPTION 'latest physical attempt did not win: %', v_expected;
  END IF;
END
$test$;
RESET ROLE;

-- Exercise the other terminal classifiers by adding each as the newest row.
INSERT INTO arena.leaderboard_acquisition_attempts
  (attempt_id, source_id, source_slug, timeframe, capture_contract, recorded_started_at)
VALUES
  ('10000000-0000-0000-0000-000000000007', 1, 'bitget_bots_futures', 30,
   'arena.ingest.leaderboard-acquisition-manifest@4', pg_catalog.statement_timestamp());
INSERT INTO arena.leaderboard_acquisition_outcomes
  (attempt_seq, terminal_state, recorded_completed_at)
SELECT attempt_seq, 'partial', pg_catalog.statement_timestamp()
FROM arena.leaderboard_acquisition_attempts
WHERE attempt_id = '10000000-0000-0000-0000-000000000007';
SET ROLE service_role;
SELECT public.assert_attempt_health('bitget_bots_futures', 'partial');
RESET ROLE;

INSERT INTO arena.leaderboard_acquisition_attempts
  (attempt_id, source_id, source_slug, timeframe, capture_contract, recorded_started_at)
VALUES
  ('10000000-0000-0000-0000-000000000008', 1, 'bitget_bots_futures', 30,
   'arena.ingest.leaderboard-acquisition-manifest@4', pg_catalog.statement_timestamp());
INSERT INTO arena.leaderboard_acquisition_outcomes
  (attempt_seq, terminal_state, recorded_completed_at)
SELECT attempt_seq, 'unknown', pg_catalog.statement_timestamp()
FROM arena.leaderboard_acquisition_attempts
WHERE attempt_id = '10000000-0000-0000-0000-000000000008';
SET ROLE service_role;
SELECT public.assert_attempt_health('bitget_bots_futures', 'unknown');
RESET ROLE;

INSERT INTO arena.leaderboard_acquisition_attempts
  (attempt_id, source_id, source_slug, timeframe, capture_contract, recorded_started_at)
VALUES
  ('10000000-0000-0000-0000-000000000009', 1, 'bitget_bots_futures', 30,
   'arena.ingest.leaderboard-acquisition-manifest@4', pg_catalog.statement_timestamp());
INSERT INTO arena.leaderboard_acquisition_outcomes
  (attempt_seq, terminal_state, recorded_completed_at)
SELECT attempt_seq, 'processing_failed', pg_catalog.statement_timestamp()
FROM arena.leaderboard_acquisition_attempts
WHERE attempt_id = '10000000-0000-0000-0000-000000000009';
SET ROLE service_role;
SELECT public.assert_attempt_health('bitget_bots_futures', 'processing_failed');
RESET ROLE;

INSERT INTO arena.leaderboard_acquisition_attempts
  (attempt_id, source_id, source_slug, timeframe, capture_contract, recorded_started_at)
VALUES
  ('10000000-0000-0000-0000-000000000010', 1, 'bitget_bots_futures', 30,
   'arena.ingest.leaderboard-acquisition-manifest@4', pg_catalog.statement_timestamp());
INSERT INTO arena.leaderboard_acquisition_outcomes
  (attempt_seq, terminal_state, recorded_completed_at)
SELECT attempt_seq, 'abandoned', pg_catalog.statement_timestamp()
FROM arena.leaderboard_acquisition_attempts
WHERE attempt_id = '10000000-0000-0000-0000-000000000010';
SET ROLE service_role;
SELECT public.assert_attempt_health('bitget_bots_futures', 'abandoned');
RESET ROLE;

INSERT INTO arena.leaderboard_acquisition_attempts
  (attempt_id, source_id, source_slug, timeframe, capture_contract, recorded_started_at)
VALUES
  ('10000000-0000-0000-0000-000000000011', 1, 'bitget_bots_futures', 30,
   'arena.ingest.leaderboard-acquisition-manifest@4',
   pg_catalog.statement_timestamp() - interval '9 minutes');
INSERT INTO arena.leaderboard_acquisition_outcomes
  (attempt_seq, terminal_state, recorded_completed_at, source_run_id,
   source_payload_raw_object_id, manifest_raw_object_id)
SELECT attempt_seq, 'complete', pg_catalog.statement_timestamp() - interval '9 minutes',
  pg_catalog.repeat('a', 64), 401, 402
FROM arena.leaderboard_acquisition_attempts
WHERE attempt_id = '10000000-0000-0000-0000-000000000011';
SET ROLE service_role;
SELECT public.assert_attempt_health(
  'bitget_bots_futures', 'complete_in_publication_grace'
);
RESET ROLE;

INSERT INTO arena.leaderboard_acquisition_attempts
  (attempt_id, source_id, source_slug, timeframe, capture_contract, recorded_started_at)
VALUES
  ('10000000-0000-0000-0000-000000000012', 1, 'bitget_bots_futures', 30,
   'arena.ingest.leaderboard-acquisition-manifest@4',
   pg_catalog.statement_timestamp() - interval '11 minutes');
INSERT INTO arena.leaderboard_acquisition_outcomes
  (attempt_seq, terminal_state, recorded_completed_at, source_run_id,
   source_payload_raw_object_id, manifest_raw_object_id)
SELECT attempt_seq, 'complete', pg_catalog.statement_timestamp() - interval '10 minutes',
  pg_catalog.repeat('c', 64), 501, 502
FROM arena.leaderboard_acquisition_attempts
WHERE attempt_id = '10000000-0000-0000-0000-000000000012';

-- Near matches independently violate source, window, run, contract, RAW ids,
-- raw_object_id, derived shape, or JSON scalar types. None may publish.
INSERT INTO arena.leaderboard_snapshots
  (source_id, timeframe, scraped_at, count_check_passed, is_derived, raw_object_id, meta)
VALUES
  (2, 30, pg_catalog.statement_timestamp(), true, false, 501,
   pg_catalog.jsonb_build_object('source_run_id', pg_catalog.repeat('c', 64),
     'acquisition_contract', 'arena.ingest.leaderboard-acquisition-manifest@4',
     'source_payload_raw_object_id', 501, 'manifest_raw_object_id', 502)),
  (1, 7, pg_catalog.statement_timestamp(), true, false, 501,
   pg_catalog.jsonb_build_object('source_run_id', pg_catalog.repeat('c', 64),
     'acquisition_contract', 'arena.ingest.leaderboard-acquisition-manifest@4',
     'source_payload_raw_object_id', 501, 'manifest_raw_object_id', 502)),
  (1, 30, pg_catalog.statement_timestamp(), true, false, 501,
   pg_catalog.jsonb_build_object('source_run_id', pg_catalog.repeat('d', 64),
     'acquisition_contract', 'arena.ingest.leaderboard-acquisition-manifest@4',
     'source_payload_raw_object_id', 501, 'manifest_raw_object_id', 502)),
  (1, 30, pg_catalog.statement_timestamp(), true, false, 501,
   pg_catalog.jsonb_build_object('source_run_id', pg_catalog.repeat('c', 64),
     'acquisition_contract', 'arena.ingest.leaderboard-acquisition-manifest@3',
     'source_payload_raw_object_id', 501, 'manifest_raw_object_id', 502)),
  (1, 30, pg_catalog.statement_timestamp(), true, false, 501,
   pg_catalog.jsonb_build_object('source_run_id', pg_catalog.repeat('c', 64),
     'acquisition_contract', 'arena.ingest.leaderboard-acquisition-manifest@4',
     'source_payload_raw_object_id', 999, 'manifest_raw_object_id', 502)),
  (1, 30, pg_catalog.statement_timestamp(), true, false, 501,
   pg_catalog.jsonb_build_object('source_run_id', pg_catalog.repeat('c', 64),
     'acquisition_contract', 'arena.ingest.leaderboard-acquisition-manifest@4',
     'source_payload_raw_object_id', 501, 'manifest_raw_object_id', 999)),
  (1, 30, pg_catalog.statement_timestamp(), true, false, 999,
   pg_catalog.jsonb_build_object('source_run_id', pg_catalog.repeat('c', 64),
     'acquisition_contract', 'arena.ingest.leaderboard-acquisition-manifest@4',
     'source_payload_raw_object_id', 501, 'manifest_raw_object_id', 502)),
  (1, 30, pg_catalog.statement_timestamp(), true, true, 501,
   pg_catalog.jsonb_build_object('source_run_id', pg_catalog.repeat('c', 64),
     'acquisition_contract', 'arena.ingest.leaderboard-acquisition-manifest@4',
     'source_payload_raw_object_id', 501, 'manifest_raw_object_id', 502)),
  (1, 30, pg_catalog.statement_timestamp(), true, false, 501,
   pg_catalog.jsonb_build_object('source_run_id', pg_catalog.repeat('c', 64),
     'acquisition_contract', 'arena.ingest.leaderboard-acquisition-manifest@4',
     'source_payload_raw_object_id', '501', 'manifest_raw_object_id', '502'));

SET ROLE service_role;
SELECT public.assert_attempt_health('bitget_bots_futures', 'complete_unpublished');
RESET ROLE;

INSERT INTO arena.leaderboard_snapshots
  (source_id, timeframe, scraped_at, count_check_passed, is_derived, raw_object_id, meta)
VALUES
  (1, 30, pg_catalog.statement_timestamp(), false, false, 501,
   pg_catalog.jsonb_build_object('source_run_id', pg_catalog.repeat('c', 64),
     'acquisition_contract', 'arena.ingest.leaderboard-acquisition-manifest@4',
     'source_payload_raw_object_id', 501, 'manifest_raw_object_id', 502));
SET ROLE service_role;
SELECT public.assert_attempt_health('bitget_bots_futures', 'published_gated');
RESET ROLE;

INSERT INTO arena.leaderboard_snapshots
  (source_id, timeframe, scraped_at, count_check_passed, is_derived, raw_object_id, meta)
VALUES
  (1, 30, pg_catalog.statement_timestamp(), true, false, 501,
   pg_catalog.jsonb_build_object('source_run_id', pg_catalog.repeat('c', 64),
     'acquisition_contract', 'arena.ingest.leaderboard-acquisition-manifest@4',
     'source_payload_raw_object_id', 501, 'manifest_raw_object_id', 502));
SET ROLE service_role;
SELECT public.assert_attempt_health('bitget_bots_futures', 'published');
DO $test$
DECLARE
  v_attempt_count bigint;
  v_snapshot_count bigint;
BEGIN
  SELECT pg_catalog.count(*) INTO STRICT v_attempt_count
    FROM arena.leaderboard_acquisition_attempts;
  SELECT pg_catalog.count(*) INTO STRICT v_snapshot_count
    FROM arena.leaderboard_snapshots;
  PERFORM * FROM public.arena_bitget_bot_acquisition_attempt_health();
  IF v_attempt_count <> (SELECT pg_catalog.count(*) FROM arena.leaderboard_acquisition_attempts)
     OR v_snapshot_count <> (SELECT pg_catalog.count(*) FROM arena.leaderboard_snapshots) THEN
    RAISE EXCEPTION 'read-only health call mutated durable state';
  END IF;
END
$test$;
RESET ROLE;
SQL

expect_failure \
  "anonymous attempt-health read" \
  "SET ROLE anon; SELECT * FROM public.arena_bitget_bot_acquisition_attempt_health()" \
  "permission denied for function arena_bitget_bot_acquisition_attempt_health"
expect_failure \
  "authenticated attempt-health read" \
  "SET ROLE authenticated; SELECT * FROM public.arena_bitget_bot_acquisition_attempt_health()" \
  "permission denied for function arena_bitget_bot_acquisition_attempt_health"
expect_failure \
  "service attempt-ledger mutation" \
  "SET ROLE service_role; UPDATE arena.leaderboard_acquisition_attempts SET recorded_started_at = pg_catalog.now()" \
  "permission denied for table leaderboard_acquisition_attempts"

echo "Bitget bot attempt health PG17 proof passed"
