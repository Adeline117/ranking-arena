#!/usr/bin/env bash
# PG17 proof for the Tier-A window republish lookup
# (worker/src/ingest/tier-a-window-republish.ts, LATEST_TIER_A_WINDOW_ATTEMPT_SQL).
#
# The query runs against the REAL acquisition ledger: the metric-trust /
# attempt-ledger chain (20260721120000 .. 20260722050000), the rank
# publication foundations, the public-source registrations and
# 20261115141050 (exhaustion completeness evidence), applied on the same stub
# base tables as bitget-spot-live-board-exhaustion-contract.pg17.sh. Only the
# two execution-claim columns of 20260729015500 are added as a fixture: that
# migration needs the whole ingest-worker fence substrate, and the lookup only
# reads the two columns it adds (copied verbatim from its ALTER TABLE).
#
# Ledger rows are written by the superuser with session_replication_role =
# replica, because the ledger's append-only triggers only admit its own
# begin/finish functions; every CHECK constraint still applies. The lookup
# itself runs through the worker's own TypeScript (findLatestTierAWindowAttempt
# and classifyTierAWindowRepublishCandidate, over node-postgres) as
# service_role, so the column list, the casts, the parser and the read grants
# are all proven at once.
#
#   + 7D: the newest attempt wins over an older complete one; its exhausted
#     outcome reports its exhaustion proof and the GATED snapshot carrying its
#     source payload RAW; the classifier skips it as count_check_gated
#   + 30D: a newer in-progress attempt is the latest; it has no outcome, so
#     there is no candidate even though an older complete outcome exists
#   + 90D: a complete, ungated outcome of an earlier queue attempt is a
#     candidate with every RAW pointer and count mapped from its outcome row
#   + a window with no attempt returns null
#   + the statement passes the worker's fenced-statement contract

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
TSX_BIN="${TSX_BIN:-$ROOT_DIR/node_modules/.bin/tsx}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ ! -x "$TSX_BIN" ]]; then
  echo "Repository tsx executable not found: $TSX_BIN" >&2
  exit 1
fi
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/tier-a-republish-lookup-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((51000 + ($$ % 5000)))}"
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

psql_db() {
  PGOPTIONS='-c client_min_messages=warning' \
    "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

psql_admin() {
  PGOPTIONS='-c client_min_messages=warning' \
    "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U supabase_admin -d postgres "$@"
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U supabase_admin --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

psql_admin -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE BYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER;
CREATE ROLE service_role NOLOGIN NOSUPERUSER;
GRANT anon, authenticated, service_role TO postgres;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL

# Base tables as the 20260610/20260721 foundations shape them.
psql_db -q <<'SQL'
CREATE SCHEMA arena;

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  adapter_slug text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL CHECK (currency IN ('USDT', 'USDx', 'USDC', 'USD')),
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
  (1, 'binance_futures', 'binance', 'active', 'serving', 'USDT', 'futures', 'local', '{7,30,90}', 30),
  (2, 'binance_web3_bsc', 'binance_web3', 'active', 'serving', 'USDT', 'onchain', 'local', '{7,30,90}', 24),
  (3, 'bitget_futures', 'bitget', 'active', 'serving', 'USDT', 'futures', 'local', '{7,30,90}', 30),
  (4, 'bitget_spot', 'bitget', 'active', 'serving', 'USDT', 'spot', 'local', '{7,30,90}', 30),
  (5, 'bitget_cfd', 'bitget', 'active', 'serving', 'USDT', 'cfd', 'local', '{7,30,90}', 30);
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
  psql_db -q -f "$MIGRATIONS/$migration" >/dev/null
done

psql_db -q <<'SQL'
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
for migration in \
  20261114193017_rank_publication_requires_attempt_bound_evidence.sql \
  20261114211033_public_source_board_metric_contracts.sql \
  20261114211034_public_source_attempt_bound_capture_contracts.sql \
  20261115141050_leaderboard_exhaustion_completeness_evidence.sql; do
  psql_db -q -f "$MIGRATIONS/$migration" >/dev/null
done

# Fixture for 20260729015500 (verbatim column shapes from its ALTER TABLE).
psql_db -q <<'SQL'
ALTER TABLE arena.leaderboard_acquisition_attempts
  ADD COLUMN IF NOT EXISTS execution_claim_id uuid,
  ADD COLUMN IF NOT EXISTS execution_generation_seq bigint;
SQL
echo "ok: real acquisition ledger and exhaustion evidence installed as a non-superuser"

# Ledger rows. Attempt seq n has attempt_id ...00n; source payload RAW 100n,
# manifest RAW 200n.
psql_admin -q <<'SQL'
SET session_replication_role = replica;

INSERT INTO arena.leaderboard_acquisition_attempts (
  attempt_id, source_id, source_slug, adapter_slug, timeframe,
  observation_cycle_id, queue_job_id, queue_attempt, capture_contract,
  attempt_binding_contract, runner_git_sha, worker_region, source_status,
  source_serving_mode, source_currency, source_fetch_region,
  recorded_started_at, execution_claim_id, execution_generation_seq
)
SELECT ('00000000-0000-4000-8000-00000000000' || fixture.n)::uuid, 1,
       'binance_futures', 'binance', fixture.timeframe, 'cycle-1', 'job-1',
       fixture.queue_attempt, 'arena.ingest.leaderboard-acquisition-manifest@3',
       'arena.ingest.leaderboard-acquisition-attempt-binding@1',
       pg_catalog.repeat('c', 40), 'local', 'active', 'serving', 'USDT', 'local',
       TIMESTAMPTZ '2026-11-27 10:00:00.123+00' + fixture.n * INTERVAL '1 minute',
       '10000000-0000-4000-8000-000000000001', 16
  FROM (VALUES (1, 7, 0), (2, 7, 1), (3, 30, 0), (4, 30, 1), (5, 90, 1))
       AS fixture(n, timeframe, queue_attempt)
 ORDER BY fixture.n;

-- 1, 3, 5: complete; 2: exhausted (population unknown, proof recorded).
INSERT INTO arena.leaderboard_acquisition_outcomes (
  attempt_seq, terminal_state, acquisition_state, population_state,
  capture_evidence_state, termination_reason, capture_started_at,
  capture_completed_at, source_run_id, source_payload_raw_object_id,
  source_payload_content_hash, source_payload_storage_path,
  manifest_raw_object_id, manifest_content_hash, manifest_storage_path,
  reported_population, population_report_state, source_page_count,
  reported_page_count, page_count_report_state, observed_population,
  accepted_population, rejected_row_count, deduplicated_row_count,
  caller_limited, safety_limited, failure_stage, reason_code,
  recorded_completed_at
)
SELECT attempt.attempt_seq,
       CASE WHEN attempt.attempt_seq = 2 THEN 'unknown' ELSE 'complete' END,
       'complete',
       CASE WHEN attempt.attempt_seq = 2 THEN 'unknown' ELSE 'verified' END,
       'verified',
       CASE WHEN attempt.attempt_seq = 2 THEN 'short_page' ELSE 'reported_population_reached' END,
       attempt.recorded_started_at,
       attempt.recorded_started_at + INTERVAL '107 minutes',
       pg_catalog.repeat(pg_catalog.chr(96 + attempt.attempt_seq::integer), 64),
       1000 + attempt.attempt_seq,
       pg_catalog.repeat('d', 64),
       'binance_futures/tier_a_trust/source_payload_' || attempt.attempt_seq || '.json.gz',
       2000 + attempt.attempt_seq,
       pg_catalog.repeat(pg_catalog.chr(96 + attempt.attempt_seq::integer), 64),
       'binance_futures/tier_a_trust/population_manifest_' || attempt.attempt_seq || '.json.gz',
       CASE WHEN attempt.attempt_seq = 2 THEN NULL ELSE 10 END,
       CASE WHEN attempt.attempt_seq = 2 THEN 'unknown' ELSE 'consistent' END,
       1, NULL, 'unknown', 10, 10, 0, 0, false, false, NULL,
       CASE WHEN attempt.attempt_seq = 2 THEN 'population_unknown' END,
       attempt.recorded_started_at + INTERVAL '108 minutes'
  FROM arena.leaderboard_acquisition_attempts AS attempt
 WHERE attempt.attempt_seq IN (1, 2, 3, 5);

INSERT INTO arena.leaderboard_acquisition_exhaustion_evidence (
  attempt_seq, source_id, timeframe, source_run_id, manifest_raw_object_id,
  completeness_contract
) VALUES (
  2, 1, 7, pg_catalog.repeat('b', 64), 2002,
  'arena.ingest.leaderboard-exhaustion-completeness@1'
);

-- The 7D republish GATED its snapshot; 90D's own snapshot passed (not
-- relevant, it carries another RAW) and a foreign GATED snapshot carries a
-- RAW of another window.
INSERT INTO arena.leaderboard_snapshots
  (id, source_id, timeframe, scraped_at, actual_count, count_check_passed, raw_object_id)
VALUES
  (501, 1, 7, TIMESTAMPTZ '2026-11-27 12:00:00+00', 9, false, 1002),
  (502, 1, 90, TIMESTAMPTZ '2026-11-27 12:00:00+00', 9, false, 1001);
SQL
echo "ok: ledger fixture rows satisfy the real CHECK constraints"

LOOKUP_TS="$ROOT_DIR/worker/tests/tier-a-window-republish-lookup.pg17.ts"

(cd "$ROOT_DIR" && PG_SOCKET_DIR="$SOCKET_DIR" PG_PORT="$PORT" "$TSX_BIN" "$LOOKUP_TS")
echo "ok: Tier-A window republish lookup proven on PostgreSQL 17"
