#!/usr/bin/env bash
# PG17 proof for 20261115141050 (exhausted completeness mode). Real migrations
# 20260721120000..20260722050000 (attempt ledger, finish RPC, metric-trust
# outcome authority) and 20261114193017 (publication trust predicate) run on
# stub base tables; every outcome below goes through the real finish RPC.
#
#   + a registered flag/token board finishes with the truthful outcome
#     (unknown / acquisition complete / population unknown), records its
#     exhaustion proof, binds rank_publication_trust_evidence, and authorizes
#     a verified metric-trust run; a total-mode board still binds
#   + cross-page duplicates within the declared allowance bind
#   - missing end signal, early end, gap in pages, page-count mismatch,
#     duplicates above the allowance, version change, unregistered
#     declaration, no completeness block, moved re-read: recording refuses
#     (23514), nothing is recorded, the board does not bind
#   - an exhausted outcome without a recorded proof binds nothing and
#     authorizes no metric-trust run
#   - malformed declarations are refused; registry and proofs are append-only
#   - replaying the migration refuses
#   + 20261118114230: a registered live board (reported_total_drift) binds
#     while its total and its distinct rows stay within the declared allowance
#   - beyond the allowance, with the wrong evidence kind, or without a natural
#     end it is refused; the declaration is refused before that migration

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
TARGET="$MIGRATIONS/20261115141050_leaderboard_exhaustion_completeness_evidence.sql"
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

TMP_ROOT="$(mktemp -d /tmp/leaderboard-exhaustion-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((46000 + ($$ % 5000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -80 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure() {
  local label="$1" sql="$2" expected="$3" sqlstate="${4:-}"
  if psql_cmd -q -v VERBOSITY=verbose -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "FAIL: $label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$(<"$ERROR_FILE")" != *"$expected"* ]] ||
    [[ -n "$sqlstate" && "$(<"$ERROR_FILE")" != *"$sqlstate"* ]]; then
    echo "FAIL: $label failed for the wrong reason; expected: $expected $sqlstate" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
  echo "ok: $label refused"
}

assert_equal() {
  if [[ "$2" != "$3" ]]; then
    echo "FAIL: $1" >&2
    echo "  expected: $2" >&2
    echo "  actual:   $3" >&2
    exit 1
  fi
  echo "ok: $1"
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

# Base tables as the 20260610/20260721 foundations shape them.
psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE SCHEMA arena;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  adapter_slug text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL,
  product_type text NOT NULL,
  fetch_region text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}',
  timeframes_native integer[] NOT NULL DEFAULT '{}',
  timeframes_derived integer[] NOT NULL DEFAULT '{}',
  page_size int
);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  nickname text,
  avatar_url_mirror text,
  avatar_url_origin text,
  trader_kind text NOT NULL DEFAULT 'human'
);
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  actual_count int NOT NULL,
  count_check_passed boolean NOT NULL,
  is_derived boolean NOT NULL DEFAULT false,
  raw_object_id bigint
);
CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL,
  snapshot_id bigint NOT NULL,
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  rank int NOT NULL,
  currency text NOT NULL,
  PRIMARY KEY (scraped_at, snapshot_id, trader_id)
);
CREATE TABLE arena.raw_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  job_type text NOT NULL,
  trader_id bigint,
  timeframe smallint,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  storage_path text NOT NULL UNIQUE,
  bytes int NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}'
);
INSERT INTO arena.sources (
  id, slug, adapter_slug, status, serving_mode, currency, product_type,
  fetch_region, timeframes_native, page_size
) VALUES
  (1, 'binance_futures', 'binance', 'active', 'serving', 'USDT', 'futures', 'vps_sg', '{30}', 2),
  (2, 'binance_web3_bsc', 'binance_web3', 'active', 'serving', 'USDT', 'onchain', 'vps_sg', '{30}', 2);
INSERT INTO arena.traders (id, source_id, exchange_trader_id) VALUES (10, 1, 't10');
GRANT USAGE ON SCHEMA arena TO service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA arena TO service_role;
SQL

for migration in \
  20260721120000_metric_trust_shadow_gate.sql \
  20260721150000_metric_trust_raw_artifact_identity.sql \
  20260721180903_metric_rankable_score_inputs_shadow.sql \
  20260722030000_durable_leaderboard_acquisition_attempt_ledger.sql \
  20260722040000_leaderboard_acquisition_manifest_v3_compat.sql \
  20260722042000_leaderboard_terminal_publication_fence.sql \
  20260722050000_metric_trust_attempt_outcome_authority.sql; do
  PGOPTIONS='-c client_min_messages=warning' psql_cmd -q -f "$MIGRATIONS/$migration" >/dev/null
done

# 20261114193017 foundations (20261113110430 shapes), then the real predicate.
psql_cmd -q <<'SQL'
CREATE TABLE arena.leaderboard_rank_publications (
  id uuid PRIMARY KEY, season_id text NOT NULL, proofs jsonb NOT NULL
);
CREATE TABLE arena.leaderboard_rank_publication_source_evidence (
  score_cohort_id uuid, season_id text, source text, evidence_grade text,
  snapshot_ids bigint[], raw_object_ids bigint[], source_run_ids text[],
  manifest_raw_object_ids bigint[]
);
CREATE FUNCTION public.record_leaderboard_rank_publication_evidence(text, uuid, jsonb)
RETURNS jsonb LANGUAGE sql AS 'SELECT NULL::jsonb';
SQL
PGOPTIONS='-c client_min_messages=warning' psql_cmd -q \
  -f "$MIGRATIONS/20261114193017_rank_publication_requires_attempt_bound_evidence.sql" >/dev/null

PGOPTIONS='-c client_min_messages=warning' psql_cmd -q -f "$TARGET" >/dev/null
echo "ok: migration applies"
if PGOPTIONS='-c client_min_messages=warning' psql_cmd -q -f "$TARGET" >"$ERROR_FILE" 2>&1 ||
  [[ "$(<"$ERROR_FILE")" != *"exhaustion completeness evidence already exists"* ]]; then
  echo "FAIL: replay did not refuse" >&2
  cat "$ERROR_FILE" >&2
  exit 1
fi
echo "ok: replay refused"

# ── Registry ──

DECLARATION='{"completeness_mode":"exhausted","list_path":["data","rows"],"row_key_path":["uid"],"end_signal":{"kind":"flag","path":["data","nextFlag"],"end_values":[false]},"board_version":{"kind":"token","path":["data","dataVer"]},"max_duplicate_rows":1}'

expect_failure "declaration without an end-signal path" \
  "INSERT INTO arena.leaderboard_exhaustion_contracts (source_id, completeness_contract, declaration)
   VALUES (1, 'arena.ingest.leaderboard-exhaustion-completeness@1',
     jsonb_set('$DECLARATION'::jsonb, '{end_signal}', '{\"kind\":\"flag\",\"end_values\":[false]}'))" \
  "leaderboard_exhaustion_contracts_declaration_check" "23514"
expect_failure "declaration with an unknown mode" \
  "INSERT INTO arena.leaderboard_exhaustion_contracts (source_id, completeness_contract, declaration)
   VALUES (1, 'arena.ingest.leaderboard-exhaustion-completeness@1',
     jsonb_set('$DECLARATION'::jsonb, '{completeness_mode}', '\"total\"'))" \
  "leaderboard_exhaustion_contracts_declaration_check" "23514"

psql_cmd -q -c "INSERT INTO arena.leaderboard_exhaustion_contracts (source_id, completeness_contract, declaration)
  VALUES (1, 'arena.ingest.leaderboard-exhaustion-completeness@1', '$DECLARATION')"
echo "ok: registered source 1"
expect_failure "registry update" \
  "UPDATE arena.leaderboard_exhaustion_contracts SET declaration = declaration" \
  "append-only" "42501"
expect_failure "registry delete" \
  "DELETE FROM arena.leaderboard_exhaustion_contracts" "append-only" "42501"
assert_equal "service_role cannot read the internal check" "f" "$(psql_cmd -Atqc \
  "SELECT has_function_privilege('service_role', 'arena.leaderboard_outcome_exhaustion_bound(bigint)', 'EXECUTE')")"

# ── Test evidence builders (production tables and RPCs do the deciding) ──

psql_cmd -q <<SQL
CREATE TABLE public.exhaustion_cases (
  attempt_id uuid PRIMARY KEY, snapshot_id bigint UNIQUE, started_at timestamptz,
  completed_at timestamptz, source_run_id text, payload_id bigint, manifest_id bigint,
  summary jsonb
);

-- pages: [[row_count, end_signal_value, version_token_seed, row_keys_seed], ...]
CREATE FUNCTION public.exhaustion_completeness(
  p_pages jsonb, p_distinct integer, p_board_version jsonb DEFAULT '{"kind":"token"}',
  p_declaration jsonb DEFAULT '$DECLARATION'::jsonb, p_ordinal_offset integer DEFAULT 0
) RETURNS jsonb LANGUAGE sql AS \$\$
  SELECT jsonb_build_object(
    'data_contract', 'arena.ingest.leaderboard-exhaustion-completeness@1',
    'declaration', p_declaration,
    'pages', (
      SELECT jsonb_agg(jsonb_build_object(
        'ordinal', ord + p_ordinal_offset,
        'request_sha256', encode(sha256(convert_to('req' || ord, 'UTF8')), 'hex'),
        'response_sha256', encode(sha256(convert_to('resp' || ord, 'UTF8')), 'hex'),
        'row_count', page->0,
        'end_signal_value', page->1,
        'version_token_sha256', CASE WHEN page->>2 IS NULL THEN 'null'::jsonb
          ELSE to_jsonb(encode(sha256(convert_to(page->>2, 'UTF8')), 'hex')) END,
        'row_keys_sha256', encode(sha256(convert_to(COALESCE(page->>3, 'keys' || ord), 'UTF8')), 'hex')
      ) ORDER BY ord)
      FROM jsonb_array_elements(p_pages) WITH ORDINALITY AS item(page, ord)
    ),
    'row_keys', jsonb_build_object(
      'observed', (SELECT sum((page->>0)::int) FROM jsonb_array_elements(p_pages) AS item(page)),
      'distinct', p_distinct,
      'duplicate', (SELECT sum((page->>0)::int) FROM jsonb_array_elements(p_pages) AS item(page)) - p_distinct
    ),
    'board_version', p_board_version
  )
\$\$;

CREATE FUNCTION public.prepare_exhaustion_case(
  p_attempt_id uuid, p_snapshot_id bigint, p_termination text, p_page_count integer,
  p_observed integer, p_accepted integer, p_completeness jsonb,
  p_reported integer DEFAULT NULL
) RETURNS void LANGUAGE plpgsql AS \$\$
DECLARE
  v_attempt arena.leaderboard_acquisition_attempts%ROWTYPE;
  v_completed_at timestamptz := clock_timestamp();
  v_run text := md5(p_attempt_id::text) || md5(p_attempt_id::text || ':manifest');
  v_summary jsonb;
  v_payload bigint;
  v_manifest bigint;
BEGIN
  SELECT * INTO STRICT v_attempt FROM arena.leaderboard_acquisition_attempts WHERE attempt_id = p_attempt_id;
  v_summary := jsonb_build_object(
    'binding_contract', v_attempt.attempt_binding_contract,
    'attempt_id', v_attempt.attempt_id,
    'attempt_seq', v_attempt.attempt_seq,
    'runner_git_sha', v_attempt.runner_git_sha,
    'capture_started_at', v_attempt.recorded_started_at,
    'capture_completed_at', v_completed_at,
    'capture_evidence_state', 'verified',
    'termination_reason', p_termination,
    'source_page_count', p_page_count,
    'population_report_state', CASE WHEN p_reported IS NULL THEN 'unknown' ELSE 'consistent' END,
    'reported_population', p_reported,
    'page_count_report_state', 'unknown',
    'reported_page_count', NULL,
    'observed_population', p_observed,
    'accepted_population', p_accepted,
    'rejected_row_count', 0,
    'deduplicated_row_count', p_observed - p_accepted,
    'caller_limited', false,
    'safety_limited', false,
    'acquisition_state', 'complete',
    'population_state', CASE WHEN p_reported IS NULL THEN 'unknown' ELSE 'verified' END
  ) || CASE WHEN p_completeness IS NULL THEN '{}'::jsonb
            ELSE jsonb_build_object('completeness', p_completeness) END;

  INSERT INTO arena.raw_objects (source_id, job_type, timeframe, fetched_at, storage_path,
    bytes, content_hash, meta, source_run_id, trust_artifact_role)
  VALUES (v_attempt.source_id, 'tier_a', v_attempt.timeframe, v_completed_at,
    p_attempt_id || '/payload.json.gz', 100, repeat('a', 64),
    jsonb_build_object('surface', 'tier_a_leaderboard', 'source_run_id', v_run,
      'observation_cycle_id', v_attempt.observation_cycle_id, 'acquisition_attempt', v_summary,
      'raw_integrity', jsonb_build_object('hash_algorithm', 'sha256', 'hash_scope', 'json_utf8',
        'serialization_contract', 'arena.strict-canonical-json@1')),
    v_run, 'source_payload')
  RETURNING id INTO STRICT v_payload;

  INSERT INTO arena.raw_objects (source_id, job_type, timeframe, fetched_at, storage_path,
    bytes, content_hash, meta, source_run_id, trust_artifact_role)
  VALUES (v_attempt.source_id, 'tier_a_manifest', v_attempt.timeframe, v_completed_at,
    p_attempt_id || '/manifest.json.gz', 100, v_run,
    jsonb_build_object('surface', 'tier_a_leaderboard', 'source_run_id', v_run,
      'observation_cycle_id', v_attempt.observation_cycle_id,
      'data_contract', v_attempt.capture_contract, 'acquisition_attempt', v_summary,
      'raw_integrity', jsonb_build_object('hash_algorithm', 'sha256', 'hash_scope', 'json_utf8',
        'serialization_contract', 'arena.strict-canonical-json@1')),
    v_run, 'population_manifest')
  RETURNING id INTO STRICT v_manifest;

  INSERT INTO arena.leaderboard_snapshots (id, source_id, timeframe, scraped_at, actual_count,
    count_check_passed, is_derived, raw_object_id)
  VALUES (p_snapshot_id, v_attempt.source_id, v_attempt.timeframe, v_completed_at, p_accepted,
    true, false, v_payload);
  INSERT INTO arena.leaderboard_entries (scraped_at, snapshot_id, trader_id, timeframe, rank, currency)
  VALUES (v_completed_at, p_snapshot_id, 10, v_attempt.timeframe, 1, 'USDT');

  INSERT INTO public.exhaustion_cases VALUES (p_attempt_id, p_snapshot_id,
    v_attempt.recorded_started_at, v_completed_at, v_run, v_payload, v_manifest, v_summary);
END
\$\$;

CREATE FUNCTION public.finish_exhaustion_case(p_attempt_id uuid)
RETURNS text LANGUAGE sql AS \$\$
  SELECT outcome.terminal_state
    FROM public.exhaustion_cases AS c
    CROSS JOIN LATERAL arena.finish_leaderboard_acquisition_attempt(
      c.attempt_id,
      CASE WHEN c.summary->>'reported_population' IS NULL THEN 'unknown' ELSE 'complete' END,
      'complete', c.summary->>'population_state', 'verified',
      c.summary->>'termination_reason', c.started_at, c.completed_at,
      c.source_run_id, c.payload_id, c.manifest_id, NULL,
      (c.summary->>'reported_population')::int, c.summary->>'population_report_state',
      (c.summary->>'source_page_count')::int, NULL, 'unknown',
      (c.summary->>'observed_population')::int, (c.summary->>'accepted_population')::int,
      0, (c.summary->>'deduplicated_row_count')::int, false, false, NULL,
      CASE WHEN c.summary->>'reported_population' IS NULL THEN 'population_unknown' END
    ) AS outcome
   WHERE c.attempt_id = p_attempt_id
\$\$;
SQL

case_n=0
start_case() {
  # start_case <snapshot_id> <termination> <page_count> <observed> <accepted> <completeness-sql>
  case_n=$((case_n + 1))
  CASE_ID="$(printf '00000000-0000-4000-8000-%012d' "$case_n")"
  psql_cmd -q >/dev/null <<SQL
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '$CASE_ID', 1, 30, 'exhaustion:$case_n', 'exhaustion-job-$case_n', 0,
  'arena.ingest.leaderboard-acquisition-manifest@3', repeat('1', 40), 'vps_sg');
SELECT public.prepare_exhaustion_case('$CASE_ID', $1, '$2', $3, $4, $5, $6);
SQL
}

trust_bound() {
  psql_cmd -Atqc "SELECT trust_bound FROM public.rank_publication_trust_evidence(ARRAY[$1]::bigint[])"
}

record_sql() {
  echo "SELECT attempt_seq FROM arena.record_leaderboard_exhaustion_evidence('$1')"
}
metric_run_sql() {
  # metric_run_sql <attempt_id> <reported> <fetched>
  echo "INSERT INTO arena.metric_trust_runs (
    source_run_id, source_id, timeframe, snapshot_id, snapshot_scraped_at,
    population_raw_object_id, manifest_raw_object_id, started_at, completed_at,
    reported_population, fetched_population, caller_limited, acquisition_state, population_state)
  SELECT c.source_run_id, s.source_id, 30, s.id, s.scraped_at, c.payload_id, c.manifest_id,
         c.started_at, c.completed_at, $2, $3, false, 'complete', 'verified'
    FROM public.exhaustion_cases AS c JOIN arena.leaderboard_snapshots AS s ON s.id = c.snapshot_id
   WHERE c.attempt_id = '$1'"
}

# ── Positive: flag + token board, no reported total ──

start_case 100 cursor_exhausted 2 3 3 \
  "public.exhaustion_completeness('[[2,true,\"v1\"],[1,false,\"v1\"]]', 3)"
assert_equal "exhausted board keeps the truthful ledger outcome" "unknown" \
  "$(psql_cmd -Atqc "SELECT public.finish_exhaustion_case('$CASE_ID')")"
assert_equal "an unrecorded proof binds nothing" "f" "$(trust_bound 100)"
expect_failure "metric-trust run before the proof is recorded" \
  "$(metric_run_sql "$CASE_ID" NULL 3)" \
  "v3 metric-trust run is not authorized by the exact latest terminal outcome" "23514"
psql_cmd -q -c "SET ROLE service_role; $(record_sql "$CASE_ID")" >/dev/null
psql_cmd -q -c "$(record_sql "$CASE_ID")" >/dev/null
assert_equal "recording is idempotent" "1" "$(psql_cmd -Atqc "
  SELECT count(*) FROM arena.leaderboard_acquisition_exhaustion_evidence AS e
    JOIN arena.leaderboard_acquisition_attempts AS a USING (attempt_seq)
   WHERE a.attempt_id = '$CASE_ID'")"
assert_equal "exhausted board binds the publication predicate" "t" "$(trust_bound 100)"
expect_failure "metric-trust run claiming a reported total for an exhausted outcome" \
  "$(metric_run_sql "$CASE_ID" 3 3)" \
  "v3 metric-trust run is not authorized by the exact latest terminal outcome" "23514"
psql_cmd -q -c "$(metric_run_sql "$CASE_ID" NULL 3)" >/dev/null
echo "ok: verified metric-trust run authorized by the exhausted proof"
expect_failure "proof update" \
  "UPDATE arena.leaderboard_acquisition_exhaustion_evidence SET recorded_at = now()" \
  "append-only" "42501"

# ── Positive: duplicates within the declared allowance (max 1) ──

start_case 101 cursor_exhausted 2 3 2 \
  "public.exhaustion_completeness('[[2,true,\"v1\"],[1,false,\"v1\"]]', 2)"
psql_cmd -q -c "SELECT public.finish_exhaustion_case('$CASE_ID')" >/dev/null
psql_cmd -q -c "$(record_sql "$CASE_ID")" >/dev/null
assert_equal "one cross-page duplicate within the allowance binds" "t" "$(trust_bound 101)"
psql_cmd -q -c "$(metric_run_sql "$CASE_ID" NULL 2)" >/dev/null
echo "ok: metric-trust run authorized for observed = fetched + deduplicated"

# ── Negatives: recording refuses, nothing binds ──

refuse_case() {
  local label="$1"
  shift
  start_case "$@"
  psql_cmd -q -c "SELECT public.finish_exhaustion_case('$CASE_ID')" >/dev/null
  expect_failure "$label" "$(record_sql "$CASE_ID")" "has no holding exhaustion evidence" "23514"
  assert_equal "$label records no proof" "0" "$(psql_cmd -Atqc "
    SELECT count(*) FROM arena.leaderboard_acquisition_exhaustion_evidence AS e
      JOIN arena.leaderboard_acquisition_attempts AS a USING (attempt_seq)
     WHERE a.attempt_id = '$CASE_ID'")"
  assert_equal "$label snapshot is not trust-bound" "f" "$(trust_bound "$1")"
}

refuse_case "missing end signal on the last page" 110 cursor_exhausted 2 3 3 \
  "public.exhaustion_completeness('[[2,true,\"v1\"],[1,true,\"v1\"]]', 3)"
refuse_case "end signal before the last page" 111 cursor_exhausted 2 3 3 \
  "public.exhaustion_completeness('[[2,false,\"v1\"],[1,false,\"v1\"]]', 3)"
refuse_case "gap in pages" 112 cursor_exhausted 2 3 3 \
  "public.exhaustion_completeness('[[2,true,\"v1\"],[1,false,\"v1\"]]', 3, p_ordinal_offset => 1)"
refuse_case "page count differs from the source pages" 113 cursor_exhausted 3 3 3 \
  "public.exhaustion_completeness('[[2,true,\"v1\"],[1,false,\"v1\"]]', 3)"
refuse_case "duplicates above the allowance" 114 cursor_exhausted 3 4 2 \
  "public.exhaustion_completeness('[[2,true,\"v1\"],[1,true,\"v1\"],[1,false,\"v1\"]]', 2)"
refuse_case "board version changed between pages" 115 cursor_exhausted 2 3 3 \
  "public.exhaustion_completeness('[[2,true,\"v1\"],[1,false,\"v2\"]]', 3)"
refuse_case "declaration differs from the registered contract" 116 cursor_exhausted 2 3 3 \
  "public.exhaustion_completeness('[[2,true,\"v1\"],[1,false,\"v1\"]]', 3,
     p_declaration => jsonb_set('$DECLARATION'::jsonb, '{max_duplicate_rows}', '5'))"
refuse_case "termination that is not the declared end signal" 117 short_page 2 3 3 \
  "public.exhaustion_completeness('[[2,true,\"v1\"],[1,false,\"v1\"]]', 3)"
refuse_case "no completeness block" 118 cursor_exhausted 2 3 3 "NULL"

# first_page_reread: the re-read must yield page one's row keys.
REREAD_DECLARATION='{"completeness_mode":"exhausted","list_path":["data","rows"],"row_key_path":["uid"],"end_signal":{"kind":"short_page"},"board_version":{"kind":"first_page_reread"},"max_duplicate_rows":0}'
psql_cmd -q -c "INSERT INTO arena.leaderboard_exhaustion_contracts (source_id, completeness_contract, declaration)
  VALUES (2, 'arena.ingest.leaderboard-exhaustion-completeness@1', '$REREAD_DECLARATION')"
psql_cmd -q -c "INSERT INTO arena.leaderboard_capture_contracts
  (source_id, capture_contract, adapter_slug, attempt_binding_contract, requires_runner_git_sha)
  VALUES (2, 'arena.ingest.leaderboard-acquisition-manifest@3', 'binance_web3',
          'arena.ingest.leaderboard-acquisition-attempt-binding@1', true)"
reread_case() {
  # reread_case <snapshot> <re-read row-key seed>
  case_n=$((case_n + 1))
  CASE_ID="$(printf '00000000-0000-4000-8000-%012d' "$case_n")"
  psql_cmd -q >/dev/null <<SQL
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '$CASE_ID', 2, 30, 'exhaustion:$case_n', 'exhaustion-job-$case_n', 0,
  'arena.ingest.leaderboard-acquisition-manifest@3', repeat('1', 40), 'vps_sg');
SELECT public.prepare_exhaustion_case('$CASE_ID', $1, 'short_page', 2, 3, 3,
  public.exhaustion_completeness('[[2,null,null,"page-one"],[1,null,null,"page-two"]]', 3,
    jsonb_build_object('kind', 'first_page_reread', 'reread', jsonb_build_object(
      'request_sha256', repeat('b', 64), 'response_sha256', repeat('c', 64),
      'http_status', 200,
      'row_keys_sha256', encode(sha256(convert_to('$2', 'UTF8')), 'hex'))),
    '$REREAD_DECLARATION'::jsonb));
SELECT public.finish_exhaustion_case('$CASE_ID');
SQL
}
reread_case 120 page-one
psql_cmd -q -c "$(record_sql "$CASE_ID")" >/dev/null
assert_equal "stable re-read board binds" "t" "$(trust_bound 120)"
reread_case 121 moved-board
expect_failure "re-read with different row keys" "$(record_sql "$CASE_ID")" \
  "has no holding exhaustion evidence" "23514"

# ── Regression: a total-mode board still binds; its finish is unchanged ──

psql_cmd -q >/dev/null <<SQL
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '00000000-0000-4000-8000-000000000999', 1, 30, 'total:1', 'total-job-1', 0,
  'arena.ingest.leaderboard-acquisition-manifest@3', repeat('1', 40), 'vps_sg');
SELECT public.prepare_exhaustion_case('00000000-0000-4000-8000-000000000999', 140,
  'reported_population_reached', 1, 1, 1, NULL, p_reported => 1);
SQL
assert_equal "total-mode board finishes complete" "complete" \
  "$(psql_cmd -Atqc "SELECT public.finish_exhaustion_case('00000000-0000-4000-8000-000000000999')")"
expect_failure "recording a proof for a total-mode outcome" \
  "$(record_sql 00000000-0000-4000-8000-000000000999)" "has no holding exhaustion evidence" "23514"
assert_equal "total-mode board binds the publication predicate" "t" "$(trust_bound 140)"
psql_cmd -q -c "$(metric_run_sql 00000000-0000-4000-8000-000000000999 1 1)" >/dev/null
echo "ok: total-mode metric-trust run still authorized"
assert_equal "earlier exhausted board still binds" "t" "$(trust_bound 100)"

# ── 20261118114230: reported_total_drift, the proof for a live board ──

DRIFT_TARGET="$MIGRATIONS/20261118114230_leaderboard_exhaustion_reported_total_drift.sql"
DRIFT_DECLARATION='{"completeness_mode":"exhausted","list_path":["data","rows"],"row_key_path":["uid"],"end_signal":{"kind":"short_page"},"board_version":{"kind":"reported_total_drift","path":["data","total"],"max_drift_rows":1},"max_duplicate_rows":1}'
psql_cmd -q -c "INSERT INTO arena.sources (
    id, slug, adapter_slug, status, serving_mode, currency, product_type,
    fetch_region, timeframes_native, page_size)
  VALUES (3, 'binance_spot', 'binance', 'active', 'serving', 'USDT', 'spot', 'vps_sg', '{30}', 2)"
psql_cmd -q -c "INSERT INTO arena.leaderboard_capture_contracts
  (source_id, capture_contract, adapter_slug, attempt_binding_contract, requires_runner_git_sha)
  VALUES (3, 'arena.ingest.leaderboard-acquisition-manifest@3', 'binance',
          'arena.ingest.leaderboard-acquisition-attempt-binding@1', true)"
register_drift_sql() {
  echo "INSERT INTO arena.leaderboard_exhaustion_contracts (source_id, completeness_contract, declaration)
    VALUES (3, 'arena.ingest.leaderboard-exhaustion-completeness@1', $1)"
}
expect_failure "drift declaration before its migration" \
  "$(register_drift_sql "'$DRIFT_DECLARATION'")" \
  "leaderboard_exhaustion_contracts_declaration_check" "23514"

PGOPTIONS='-c client_min_messages=warning' psql_cmd -q -f "$DRIFT_TARGET" >/dev/null
echo "ok: drift migration applies"
if PGOPTIONS='-c client_min_messages=warning' psql_cmd -q -f "$DRIFT_TARGET" >"$ERROR_FILE" 2>&1 ||
  [[ "$(<"$ERROR_FILE")" != *"exhaustion completeness functions (20261115141050) drifted"* ]]; then
  echo "FAIL: drift migration replay did not refuse" >&2
  cat "$ERROR_FILE" >&2
  exit 1
fi
echo "ok: drift migration replay refused"

expect_failure "drift declaration without an allowance" \
  "$(register_drift_sql "'$DRIFT_DECLARATION'::jsonb #- '{board_version,max_drift_rows}'")" \
  "leaderboard_exhaustion_contracts_declaration_check" "23514"
expect_failure "drift declaration with a negative allowance" \
  "$(register_drift_sql "jsonb_set('$DRIFT_DECLARATION'::jsonb, '{board_version,max_drift_rows}', '-1')")" \
  "leaderboard_exhaustion_contracts_declaration_check" "23514"
psql_cmd -q -c "$(register_drift_sql "'$DRIFT_DECLARATION'")"
echo "ok: registered live source 3"

drift_case() {
  # drift_case <snapshot> <termination> <pages-json> <distinct> <board-version-json>
  case_n=$((case_n + 1))
  CASE_ID="$(printf '00000000-0000-4000-8000-%012d' "$case_n")"
  psql_cmd -q >/dev/null <<SQL
SELECT attempt_seq FROM arena.start_leaderboard_acquisition_attempt(
  '$CASE_ID', 3, 30, 'exhaustion:$case_n', 'exhaustion-job-$case_n', 0,
  'arena.ingest.leaderboard-acquisition-manifest@3', repeat('1', 40), 'vps_sg');
SELECT public.prepare_exhaustion_case('$CASE_ID', $1, '$2',
  jsonb_array_length('$3'::jsonb),
  (SELECT sum((page->>0)::int)::int FROM jsonb_array_elements('$3'::jsonb) AS item(page)),
  $4,
  public.exhaustion_completeness('$3', $4, '$5'::jsonb, '$DRIFT_DECLARATION'::jsonb));
SELECT public.finish_exhaustion_case('$CASE_ID');
SQL
}
totals() {
  echo "{\"kind\":\"reported_total_drift\",\"reported_totals\":{\"min\":$1,\"max\":$2,\"last\":$3}}"
}
drift_binds() {
  local label="$1"
  shift
  drift_case "$@"
  psql_cmd -q -c "$(record_sql "$CASE_ID")" >/dev/null
  assert_equal "$label" "t" "$(trust_bound "$1")"
}
drift_refuses() {
  local label="$1"
  shift
  drift_case "$@"
  expect_failure "$label" "$(record_sql "$CASE_ID")" "has no holding exhaustion evidence" "23514"
  assert_equal "$label snapshot is not trust-bound" "f" "$(trust_bound "$1")"
}

drift_binds "quiet live board binds" 150 short_page '[[2,null],[2,null],[1,null]]' 5 "$(totals 5 5 5)"
psql_cmd -q -c "$(metric_run_sql "$CASE_ID" NULL 5)" >/dev/null
echo "ok: metric-trust run authorized for a live board"
drift_binds "one trader crossing the cursor (1 duplicate, 1 missing) binds" \
  151 short_page '[[2,null],[2,null],[1,null]]' 4 "$(totals 5 5 5)"
drift_binds "total moving by one row binds" \
  152 short_page '[[2,null],[2,null],[1,null]]' 5 "$(totals 4 5 5)"
drift_binds "board ending on an empty page binds" \
  153 empty_page '[[2,null],[2,null],[0,null]]' 4 "$(totals 4 4 4)"

drift_refuses "total moving by more than the allowance" \
  160 short_page '[[2,null],[2,null],[1,null]]' 5 "$(totals 3 5 5)"
drift_refuses "more rows missing against the last total than the allowance" \
  161 short_page '[[2,null],[2,null],[1,null]]' 5 "$(totals 7 7 7)"
drift_refuses "more distinct rows than the last total allows" \
  162 short_page '[[2,null],[2,null],[1,null]]' 5 "$(totals 3 3 3)"
drift_refuses "last total outside the recorded range" \
  163 short_page '[[2,null],[2,null],[1,null]]' 5 "$(totals 5 5 6)"
drift_refuses "duplicates above the allowance" \
  164 short_page '[[2,null],[2,null],[1,null]]' 3 "$(totals 4 4 4)"
drift_refuses "token evidence for a live declaration" \
  165 short_page '[[2,null],[2,null],[1,null]]' 5 '{"kind":"token"}'
drift_refuses "live board that did not end on a short or empty page" \
  166 short_page '[[2,null],[2,null],[2,null]]' 6 "$(totals 6 6 6)"

assert_equal "earlier token board still binds" "t" "$(trust_bound 100)"
assert_equal "earlier re-read board still binds" "t" "$(trust_bound 120)"

echo "leaderboard exhaustion completeness PG17 proof passed"
