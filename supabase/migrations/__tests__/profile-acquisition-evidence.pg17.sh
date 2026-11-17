#!/usr/bin/env bash

# PostgreSQL 17 proof for attempt-bound Tier-B profile evidence. It owns an
# isolated cluster on a private socket and never connects to application data.
#
# Chain applied on a minimal fixture of the relations it reads:
#   20260721175746 arena_score_inputs_publish_bundle
#   20260725012000 strengthen_arena_score_publish_evidence
#   (the 20261115013558 Bitget-bot bundle rewrite, replayed verbatim)
#   20261116204006 publication_score_rows_board_headline_only     (#489 step 1)
#   20261116205144 trader_stats_score_input_evidence_pointer      (#489 step 2a)
#   20261116210122 publication_score_rows_require_stats_evidence  (#489 step 2b)
#   20261116215328 profile_acquisition_evidence_ledger
#   20261116215329 publication_score_rows_profile_attested
#
# Proves, with positive and negative cases:
#   ledger   - RPC-owned and append-only; start refuses an unregistered or
#              drifted contract, an undeclared timeframe and a foreign trader;
#              finish refuses a RAW of another trader/timeframe/attempt, a
#              manifest not bound to its attempt, metrics outside the contract,
#              a manifest on an incomplete outcome and a second terminal;
#   trigger  - a profile pointer must name a complete capture of the same
#              trader and timeframe; it attests only values equal to the
#              captured ones; a later overwrite strips that metric; board and
#              profile attestations merge per metric and survive each other's
#              writes when the value is unchanged;
#   writer   - the exact publishProfile upsert (profile-stats-sql.ts) stamps an
#              attested publish, keeps the attestation through an unattested
#              publish of equal values, strips only the metric a later publish
#              changes, never attests a value retained by the fill-metrics
#              guard, and refuses a pointer of another trader;
#   reader   - a profile-attested value is published (also for a headline the
#              board lacks); a stale capture, a wrong trader, a wrong timeframe
#              and an incomplete outcome are refused even when a forged pointer
#              bypasses the trigger; as_of is the oldest observation used;
#              without profile evidence @3 returns exactly what @2 returns.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
STEP1=20261116204006_publication_score_rows_board_headline_only.sql
STEP2A=20261116205144_trader_stats_score_input_evidence_pointer.sql
STEP2B=20261116210122_publication_score_rows_require_stats_evidence.sql
LEDGER=20261116215328_profile_acquisition_evidence_ledger.sql
READER=20261116215329_publication_score_rows_profile_attested.sql
WRITER_MODULE="$ROOT_DIR/lib/ingest/serving/profile-stats-sql.ts"
CHAIN=(
  20260721175746_arena_score_inputs_publish_bundle.sql
  20260725012000_strengthen_arena_score_publish_evidence.sql
)

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

TMP_ROOT="$(mktemp -d /tmp/profile-acquisition-evidence-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((55000 + ($$ % 3000)))}"
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
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres \
    -d postgres "$@"
}

expect_failure() {
  local label="$1" pattern="$2" sql="$3"
  local output
  if output="$(psql_db -c "$sql" 2>&1)"; then
    echo "$label: expected failure, succeeded" >&2
    exit 1
  fi
  if ! grep -q -- "$pattern" <<<"$output"; then
    echo "$label: expected '$pattern', got: $output" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U postgres --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

# ---------------------------------------------------------------------------
# Fixture: the relations the bundle, the readers and the ledger read.
# ---------------------------------------------------------------------------
psql_db <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA arena;
GRANT USAGE ON SCHEMA public, arena TO anon, authenticated, service_role;

CREATE TABLE arena.score_inputs (marker text);
CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  adapter_slug text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  currency text NOT NULL DEFAULT 'USDT',
  product_type text NOT NULL DEFAULT 'futures',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  timeframes_native integer[] NOT NULL DEFAULT '{90}',
  timeframes_derived integer[] NOT NULL DEFAULT '{}'
);
CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  actual_count integer NOT NULL,
  count_check_passed boolean NOT NULL,
  raw_object_id bigint
);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  trader_kind text,
  nickname text,
  avatar_url_mirror text,
  avatar_url_origin text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE arena.leaderboard_entries (
  scraped_at timestamptz NOT NULL,
  snapshot_id bigint NOT NULL,
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  rank integer NOT NULL,
  headline_roi numeric,
  headline_pnl numeric,
  headline_win_rate numeric,
  PRIMARY KEY (scraped_at, snapshot_id, trader_id)
);
CREATE TABLE arena.trader_stats (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  timeframe smallint NOT NULL,
  as_of timestamptz NOT NULL,
  currency text NOT NULL DEFAULT 'USDT',
  roi numeric,
  pnl numeric,
  win_rate numeric,
  mdd numeric,
  sharpe numeric,
  copier_count integer,
  total_positions integer,
  win_positions integer,
  copier_pnl numeric,
  aum numeric,
  volume numeric,
  profit_share_rate numeric,
  holding_duration_avg interval,
  trading_preferences jsonb,
  extras jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (trader_id, timeframe)
);
CREATE TABLE arena.raw_objects (
  id bigint PRIMARY KEY,
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
CREATE TABLE arena.leaderboard_acquisition_attempts (
  attempt_seq bigint PRIMARY KEY,
  source_id smallint NOT NULL,
  timeframe smallint NOT NULL
);
CREATE TABLE arena.leaderboard_acquisition_outcomes (
  attempt_seq bigint PRIMARY KEY REFERENCES arena.leaderboard_acquisition_attempts(attempt_seq),
  source_run_id text,
  source_payload_raw_object_id bigint
);

CREATE FUNCTION public.arena_score_inputs_json(
  p_window text,
  p_per_platform_limit int DEFAULT 1000,
  p_max_age_hours int DEFAULT 48
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('legacy_reader', true))
$$;
REVOKE ALL ON FUNCTION public.arena_score_inputs_json(text, int, int)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_score_inputs_json(text, int, int) TO service_role;
SQL

for migration in "${CHAIN[@]}"; do
  psql_db -f "$MIGRATIONS/$migration"
done

psql_db <<'SQL'
DO $replay$
DECLARE
  v_function oid := 'public.arena_score_inputs_publish_bundle_json(text,integer,integer)'::regprocedure;
  v_needle text := E'source_row.serving_mode = ''serving''\n';
  v_sha text;
BEGIN
  EXECUTE replace(pg_get_functiondef(v_function), v_needle, v_needle || format(
$predicate$%2$s-- bitget-bot-cumulative-rank-quarantine@1
%2$sAND NOT (
%2$s  %1$s.slug = ANY (
%2$s    ARRAY[
%2$s      'bitget_bots_futures',
%2$s      'bitget_bots_spot'
%2$s    ]::pg_catalog.text[]
%2$s  )
%2$s  OR %1$s.adapter_slug = 'bitget_bots'
%2$s)
$predicate$, 'source_row', '      '));
  SELECT encode(sha256(convert_to(prosrc, 'UTF8')), 'hex') INTO v_sha
  FROM pg_proc WHERE oid = v_function;
  IF v_sha <> 'f1c2aa2f9c5bb32c70fc585fce0a5a424028041ff4473fa89984f293e2eb85bc' THEN
    RAISE EXCEPTION 'fixture bundle is not the reviewed quarantined body: %', v_sha;
  END IF;
END
$replay$;
SQL

expect_failure 'the ledger refuses to run before the #489 pointer' \
  'profile acquisition evidence requires 20261116205144' \
  "\\i $MIGRATIONS/$LEDGER"

psql_db -f "$MIGRATIONS/$STEP1"
psql_db -f "$MIGRATIONS/$STEP2A"
expect_failure 'the @3 reader refuses to run before the ledger' \
  'profile-attested publication requires' "\\i $MIGRATIONS/$READER"
psql_db -f "$MIGRATIONS/$STEP2B"
psql_db -f "$MIGRATIONS/$LEDGER"
expect_failure 'the ledger runs once' 'profile acquisition evidence already exists' \
  "\\i $MIGRATIONS/$LEDGER"

# ---------------------------------------------------------------------------
# Data. Source 1 serves a 90D board (RAW 5011, attempt-bound run c...). Its
# board carries ROI and win rate for every entry, PnL only for 'full'.
# ---------------------------------------------------------------------------
psql_db <<'SQL'
INSERT INTO arena.sources (id, slug, adapter_slug, status, serving_mode) VALUES
  (1, 'alpha_futures', 'alpha', 'active', 'serving'),
  (2, 'beta_futures', 'beta', 'active', 'serving');

INSERT INTO arena.leaderboard_snapshots VALUES
  (11, 1, 90, now() - interval '1 hour', 7, true, 5011);

INSERT INTO arena.traders (id, source_id, exchange_trader_id, nickname) VALUES
  (101, 1, 'full', 'Full'),
  (102, 1, 'no-pnl', 'NoPnl'),
  (103, 1, 'stale', 'Stale'),
  (104, 1, 'wrong-tf', 'WrongTf'),
  (105, 1, 'incomplete', 'Incomplete'),
  (106, 1, 'wrong-trader', 'WrongTrader'),
  (107, 1, 'mismatch', 'Mismatch'),
  (201, 2, 'foreign', 'Foreign');

INSERT INTO arena.leaderboard_entries
  (scraped_at, snapshot_id, trader_id, timeframe, rank, headline_roi, headline_pnl, headline_win_rate)
SELECT s.scraped_at, 11, e.trader_id, 90, e.rank, e.roi, e.pnl, 60
FROM (VALUES
  (101, 1, 50.0, 1000.0), (102, 2, 40.0, NULL), (103, 3, 30.0, NULL),
  (104, 4, 20.0, NULL), (105, 5, 10.0, NULL), (106, 6, 5.0, NULL), (107, 7, 4.0, NULL)
) AS e(trader_id, rank, roi, pnl)
CROSS JOIN arena.leaderboard_snapshots AS s WHERE s.id = 11;

-- Board attempt 1 produced RAW 5011; its write attested 'full's Sharpe.
INSERT INTO arena.leaderboard_acquisition_attempts VALUES (1, 1, 90);
INSERT INTO arena.leaderboard_acquisition_outcomes VALUES (1, repeat('c', 64), 5011);

INSERT INTO arena.trader_stats
  (trader_id, timeframe, as_of, roi, pnl, win_rate, mdd, sharpe, total_positions)
VALUES
  (101, 90, now() - interval '1 hour', 50, 1000, 60, 12, 1.5, 40),
  (102, 90, now() - interval '1 hour', 40, 900, 60, 20, NULL, 12),
  (103, 90, now() - interval '1 hour', 30, 800, 60, 21, NULL, NULL),
  (104, 90, now() - interval '1 hour', 20, 700, 60, 22, NULL, NULL),
  (105, 90, now() - interval '1 hour', 10, 600, 60, 23, NULL, NULL),
  (106, 90, now() - interval '1 hour', 5, 500, 60, 24, NULL, NULL),
  (107, 90, now() - interval '1 hour', 4, 400, 60, 25, NULL, NULL),
  (104, 30, now() - interval '1 hour', 20, 700, 60, 22, NULL, NULL);
UPDATE arena.trader_stats SET evidence_raw_object_id = 5011,
  evidence_source_run_id = repeat('c', 64), evidence_metrics = ARRAY['sharpe']
WHERE trader_id = 101 AND timeframe = 90;

-- Rows before any profile evidence: @2 output, kept to compare with @3.
CREATE TABLE public.rows_v2 AS
  SELECT arena.publication_score_rows_json('90D', 1000, 48) AS rows;

-- Test-only capture helper: what the worker does through the two RPCs, with
-- the tier_b RAW written in between. Returns the attempt sequence.
CREATE FUNCTION public.capture(
  p_trader bigint, p_timeframe int, p_metrics jsonb, p_raw bigint,
  p_state text DEFAULT 'complete', p_contract_sha text DEFAULT repeat('a', 64)
)
RETURNS bigint
LANGUAGE plpgsql
AS $$
DECLARE
  v_id uuid := gen_random_uuid();
  v_seq bigint;
  v_run text := encode(sha256(convert_to(v_id::text, 'UTF8')), 'hex');
  v_source smallint;
  v_ext text;
BEGIN
  SELECT source_id, exchange_trader_id INTO v_source, v_ext FROM arena.traders WHERE id = p_trader;
  SELECT attempt_seq INTO v_seq FROM arena.start_profile_acquisition_attempt(
    v_id, v_source, p_trader, p_timeframe, 'alpha_futures-profile-capture@1', p_contract_sha, NULL);
  INSERT INTO arena.raw_objects (id, source_id, job_type, trader_id, timeframe, fetched_at,
    storage_path, bytes, content_hash, meta)
  VALUES (p_raw, v_source, 'tier_b', p_trader, p_timeframe, clock_timestamp(),
    'raw/' || p_raw, 1, repeat('e', 64),
    jsonb_build_object('profile_capture', jsonb_build_object(
      'attempt_id', v_id::text,
      'capture_contract', 'alpha_futures-profile-capture@1')));
  IF p_state = 'complete' THEN
    PERFORM arena.finish_profile_acquisition_attempt(v_seq, v_id, 'complete', NULL, p_raw, v_run,
      jsonb_build_object(
        'contract', 'profile-acquisition-manifest@1',
        'attempt_id', v_id::text,
        'capture_contract', 'alpha_futures-profile-capture@1',
        'capture_contract_sha256', p_contract_sha,
        'timeframe', p_timeframe,
        'exchange_trader_id', v_ext,
        'requests', jsonb_build_array(jsonb_build_object(
          'endpoint', 'detail',
          'request_projection_sha256', repeat('1', 64),
          'response_sha256', repeat('2', 64))),
        'metrics', p_metrics));
  ELSE
    PERFORM arena.finish_profile_acquisition_attempt(v_seq, v_id, p_state, 'pagination_partial',
      p_raw, NULL, NULL);
  END IF;
  RETURN v_seq;
END
$$;
SQL

# ---------------------------------------------------------------------------
# Ledger: registry, RPC ownership and terminal binding.
# ---------------------------------------------------------------------------
expect_failure 'start refuses an unregistered contract' 'is not registered' \
  "SELECT public.capture(101, 90, '{}', 9001)"
psql_db <<'SQL'
INSERT INTO arena.profile_capture_contracts
  (source_id, capture_contract, contract_sha256, timeframes, attestable_metrics)
VALUES (1, 'alpha_futures-profile-capture@1', repeat('a', 64), '{30,90}',
        '{pnl,win_rate,mdd,total_positions}');
SQL
expect_failure 'contracts are append-only' 'append-only' \
  "UPDATE arena.profile_capture_contracts SET attestable_metrics = '{sharpe}'"
expect_failure 'start refuses a drifted contract hash' 'is not registered' \
  "SELECT public.capture(101, 90, '{}', 9001, 'complete', repeat('b', 64))"
expect_failure 'start refuses an undeclared timeframe' 'is not registered' \
  "SELECT public.capture(101, 7, '{}', 9001)"
expect_failure 'start refuses a trader of another source' 'does not belong to source' \
  "SELECT arena.start_profile_acquisition_attempt(gen_random_uuid(), 1, 201, 90,
     'alpha_futures-profile-capture@1', repeat('a', 64), NULL)"
expect_failure 'the attempt ledger is RPC-owned' 'append-only and RPC-owned' \
  "INSERT INTO arena.profile_acquisition_attempts (attempt_id, source_id, trader_id, timeframe,
     capture_contract, recorded_started_at)
   VALUES (gen_random_uuid(), 1, 101, 90, 'alpha_futures-profile-capture@1', now())"
expect_failure 'finish refuses metrics outside the contract' 'attests metrics outside contract' \
  "SELECT public.capture(101, 90, '{\"sharpe\":{\"value\":1.5}}', 9001)"
expect_failure 'finish refuses a non-numeric attested value' 'attests metrics outside contract' \
  "SELECT public.capture(101, 90, '{\"mdd\":{\"value\":\"12\"}}', 9001)"

psql_db <<'SQL'
-- A manifest that is valid for (attempt, exchange trader) in every other way.
CREATE FUNCTION public.manifest_for(p_id uuid, p_ext text) RETURNS jsonb LANGUAGE sql AS $$
  SELECT jsonb_build_object('contract', 'profile-acquisition-manifest@1',
    'attempt_id', p_id::text, 'capture_contract', 'alpha_futures-profile-capture@1',
    'capture_contract_sha256', repeat('a', 64), 'timeframe', 90, 'exchange_trader_id', p_ext,
    'requests', jsonb_build_array(jsonb_build_object('endpoint', 'detail',
      'request_projection_sha256', repeat('1', 64), 'response_sha256', repeat('2', 64))),
    'metrics', '{"mdd":{"value":12}}'::jsonb)
$$;
CREATE FUNCTION public.tier_b_raw(p_id bigint, p_trader bigint, p_attempt uuid) RETURNS void
LANGUAGE sql AS $$
  INSERT INTO arena.raw_objects VALUES (p_id, 1, 'tier_b', p_trader, 90, clock_timestamp(),
    'raw/' || p_id, 1, repeat('e', 64), false, jsonb_build_object('profile_capture',
      jsonb_build_object('attempt_id', p_attempt::text,
        'capture_contract', 'alpha_futures-profile-capture@1')))
$$;

DO $proof$
DECLARE
  v_id uuid := gen_random_uuid();
  v_seq bigint;
BEGIN
  SELECT attempt_seq INTO v_seq FROM arena.start_profile_acquisition_attempt(
    v_id, 1, 101, 90, 'alpha_futures-profile-capture@1', repeat('a', 64), NULL);
  PERFORM public.tier_b_raw(9101, 102, v_id);              -- another trader
  PERFORM public.tier_b_raw(9102, 101, gen_random_uuid()); -- another attempt
  PERFORM public.tier_b_raw(9103, 101, v_id);              -- this attempt

  -- Positive control: the exact RAW and manifest close the attempt (rolled back).
  BEGIN
    PERFORM arena.finish_profile_acquisition_attempt(v_seq, v_id, 'complete', NULL, 9103,
      repeat('f', 64), public.manifest_for(v_id, 'full'));
    RAISE EXCEPTION USING ERRCODE = 'P0099';
  EXCEPTION WHEN SQLSTATE 'P0099' THEN NULL;
  END;
  BEGIN
    PERFORM arena.finish_profile_acquisition_attempt(v_seq, v_id, 'complete', NULL, 9101,
      repeat('f', 64), public.manifest_for(v_id, 'full'));
    RAISE EXCEPTION 'a RAW of another trader closed the attempt';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM arena.finish_profile_acquisition_attempt(v_seq, v_id, 'complete', NULL, 9102,
      repeat('f', 64), public.manifest_for(v_id, 'full'));
    RAISE EXCEPTION 'a RAW of another attempt closed the attempt';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM arena.finish_profile_acquisition_attempt(v_seq, v_id, 'complete', NULL, 9103,
      repeat('f', 64), public.manifest_for(v_id, 'no-pnl'));
    RAISE EXCEPTION 'a manifest of another trader closed the attempt';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM arena.finish_profile_acquisition_attempt(v_seq, v_id, 'complete', NULL, 9103,
      repeat('f', 64), public.manifest_for(gen_random_uuid(), 'full'));
    RAISE EXCEPTION 'a manifest of another attempt closed the attempt';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM arena.finish_profile_acquisition_attempt(v_seq, v_id, 'partial', 'endpoint_missing',
      9103, NULL, public.manifest_for(v_id, 'full'));
    RAISE EXCEPTION 'an incomplete outcome carried a manifest';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  -- One typed terminal per attempt.
  PERFORM arena.finish_profile_acquisition_attempt(v_seq, v_id, 'upstream_failed', 'upstream_gone',
    NULL, NULL, NULL);
  BEGIN
    PERFORM arena.finish_profile_acquisition_attempt(v_seq, v_id, 'upstream_failed', 'upstream_gone',
      NULL, NULL, NULL);
    RAISE EXCEPTION 'a second terminal was recorded';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$proof$;
SQL
expect_failure 'the outcome ledger is append-only' 'append-only and RPC-owned' \
  "UPDATE arena.profile_acquisition_outcomes SET terminal_state = 'complete'"

echo "profile-acquisition-evidence.pg17: ledger ok"

# ---------------------------------------------------------------------------
# Trigger: per-metric profile attestation beside the board pointer.
# ---------------------------------------------------------------------------
psql_db <<'SQL'
CREATE TABLE public.seqs (name text PRIMARY KEY, seq bigint NOT NULL);
INSERT INTO public.seqs VALUES
  ('full', public.capture(101, 90, '{"mdd":{"value":12},"total_positions":{"value":40},"win_rate":{"value":60}}', 7101)),
  ('no-pnl', public.capture(102, 90, '{"pnl":{"value":900},"mdd":{"value":20}}', 7102)),
  ('stale', public.capture(103, 90, '{"pnl":{"value":800},"mdd":{"value":21}}', 7103)),
  ('wrong-tf-30', public.capture(104, 30, '{"pnl":{"value":700},"mdd":{"value":22}}', 7104)),
  ('incomplete', public.capture(105, 90, '{}', 7105, 'partial')),
  ('other-trader', public.capture(102, 90, '{"pnl":{"value":500},"mdd":{"value":24}}', 7106)),
  ('mismatch', public.capture(107, 90, '{"pnl":{"value":401},"mdd":{"value":25}}', 7107));
SQL

expect_failure 'a pointer must name a complete outcome' 'is not a complete capture' \
  "UPDATE arena.trader_stats SET profile_evidence_attempt_seq = (SELECT seq FROM public.seqs WHERE name = 'incomplete'),
     profile_evidence_metrics = '{mdd}' WHERE trader_id = 105 AND timeframe = 90"
expect_failure 'a pointer must name a capture of the same trader' 'is not a complete capture' \
  "UPDATE arena.trader_stats SET profile_evidence_attempt_seq = (SELECT seq FROM public.seqs WHERE name = 'other-trader'),
     profile_evidence_metrics = '{mdd}' WHERE trader_id = 106 AND timeframe = 90"
expect_failure 'a pointer must name a capture of the same timeframe' 'is not a complete capture' \
  "UPDATE arena.trader_stats SET profile_evidence_attempt_seq = (SELECT seq FROM public.seqs WHERE name = 'wrong-tf-30'),
     profile_evidence_metrics = '{mdd}' WHERE trader_id = 104 AND timeframe = 90"

psql_db <<'SQL'
-- The profile writer stamps what it wrote (ON CONFLICT path, like publishProfile).
INSERT INTO arena.trader_stats AS s
  (trader_id, timeframe, as_of, roi, pnl, win_rate, mdd, total_positions,
   profile_evidence_attempt_seq, profile_evidence_metrics)
VALUES (101, 90, now(), 50, 1000, 60, 12, 40, (SELECT seq FROM public.seqs WHERE name = 'full'),
        '{mdd,total_positions,win_rate,sharpe}')
ON CONFLICT (trader_id, timeframe) DO UPDATE SET
  as_of = EXCLUDED.as_of, roi = EXCLUDED.roi, pnl = EXCLUDED.pnl, win_rate = EXCLUDED.win_rate,
  mdd = EXCLUDED.mdd, total_positions = EXCLUDED.total_positions,
  profile_evidence_attempt_seq = EXCLUDED.profile_evidence_attempt_seq,
  profile_evidence_metrics = EXCLUDED.profile_evidence_metrics;
UPDATE arena.trader_stats SET profile_evidence_attempt_seq = (SELECT seq FROM public.seqs WHERE name = 'no-pnl'),
  profile_evidence_metrics = '{pnl,mdd}' WHERE trader_id = 102 AND timeframe = 90;
UPDATE arena.trader_stats SET profile_evidence_attempt_seq = (SELECT seq FROM public.seqs WHERE name = 'wrong-tf-30'),
  profile_evidence_metrics = '{pnl,mdd}' WHERE trader_id = 104 AND timeframe = 30;
-- Stored PnL 400 is not the captured 401: only the drawdown is attested.
UPDATE arena.trader_stats SET profile_evidence_attempt_seq = (SELECT seq FROM public.seqs WHERE name = 'mismatch'),
  profile_evidence_metrics = '{pnl,mdd}' WHERE trader_id = 107 AND timeframe = 90;

DO $proof$
DECLARE
  v_row arena.trader_stats%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_row FROM arena.trader_stats WHERE trader_id = 101 AND timeframe = 90;
  -- Sharpe is not in the capture: not profile-attested; the board keeps it.
  IF v_row.profile_evidence_metrics <> '{mdd,total_positions,win_rate}'
     OR v_row.evidence_metrics <> '{sharpe}' THEN
    RAISE EXCEPTION 'board and profile attestations did not merge: % / %',
      v_row.profile_evidence_metrics, v_row.evidence_metrics;
  END IF;
  SELECT * INTO STRICT v_row FROM arena.trader_stats WHERE trader_id = 107 AND timeframe = 90;
  IF v_row.profile_evidence_metrics <> '{mdd}' THEN
    RAISE EXCEPTION 'a value unequal to the capture was attested: %', v_row.profile_evidence_metrics;
  END IF;
END
$proof$;
SQL

# Forged pointers that bypass the trigger (session_replication_role, test
# only): the reader itself refuses a stale, foreign-trader or incomplete
# capture.
psql_db <<'SQL'
SET session_replication_role = replica;
UPDATE arena.trader_stats SET profile_evidence_attempt_seq = (SELECT seq FROM public.seqs WHERE name = 'other-trader'),
  profile_evidence_metrics = '{pnl,mdd}' WHERE trader_id = 106 AND timeframe = 90;
UPDATE arena.trader_stats SET profile_evidence_attempt_seq = (SELECT seq FROM public.seqs WHERE name = 'incomplete'),
  profile_evidence_metrics = '{mdd}' WHERE trader_id = 105 AND timeframe = 90;
UPDATE arena.trader_stats SET profile_evidence_attempt_seq = (SELECT seq FROM public.seqs WHERE name = 'wrong-tf-30'),
  profile_evidence_metrics = '{pnl,mdd}' WHERE trader_id = 104 AND timeframe = 90;
UPDATE arena.trader_stats SET profile_evidence_attempt_seq = (SELECT seq FROM public.seqs WHERE name = 'stale'),
  profile_evidence_metrics = '{pnl,mdd}' WHERE trader_id = 103 AND timeframe = 90;
-- The stale capture began 3 days ago (fixture-only rewrite of the ledger).
UPDATE arena.profile_acquisition_attempts SET recorded_started_at = now() - interval '72 hours'
WHERE attempt_seq = (SELECT seq FROM public.seqs WHERE name = 'stale');
SET session_replication_role = origin;
SQL

echo "profile-acquisition-evidence.pg17: trigger ok"

# ---------------------------------------------------------------------------
# Reader @3.
# ---------------------------------------------------------------------------
psql_db -f "$MIGRATIONS/$READER"
psql_db -f "$MIGRATIONS/$READER"

psql_db <<'SQL'
DO $proof$
DECLARE
  v_rows jsonb := arena.publication_score_rows_json('90D', 1000, 48);
  v_row jsonb;
BEGIN
  IF v_rows IS DISTINCT FROM public.arena_score_inputs_publish_bundle_json('90D', 1000, 48)->'scoreRows'
     OR jsonb_array_length(v_rows) <> 7 THEN
    RAISE EXCEPTION 'bundle rows drifted: %', v_rows;
  END IF;

  -- Board Sharpe + profile drawdown and trade count: merged.
  SELECT r INTO STRICT v_row FROM jsonb_array_elements(v_rows) AS r WHERE r->>'trader_key' = 'full';
  IF (v_row->>'max_drawdown')::numeric <> 12 OR (v_row->>'sharpe_ratio')::numeric <> 1.5
     OR (v_row->>'trades_count')::int <> 40 OR (v_row->>'pnl_usd')::numeric <> 1000
     OR v_row->'unevidenced_metrics' <> '[]'::jsonb
     OR (v_row->>'as_of')::timestamptz > (SELECT scraped_at FROM arena.leaderboard_snapshots WHERE id = 11) THEN
    RAISE EXCEPTION 'merged row drifted: %', v_row;
  END IF;

  -- A headline the board lacks (PnL) comes from the fresh profile capture.
  SELECT r INTO STRICT v_row FROM jsonb_array_elements(v_rows) AS r WHERE r->>'trader_key' = 'no-pnl';
  IF (v_row->>'pnl_usd')::numeric <> 900 OR (v_row->>'max_drawdown')::numeric <> 20
     OR v_row->'unevidenced_metrics' <> '["trades_count"]'::jsonb THEN
    RAISE EXCEPTION 'profile-attested row drifted: %', v_row;
  END IF;

  -- Stale capture, capture of another timeframe, incomplete outcome and a
  -- capture of another trader: all refused, all named as unevidenced.
  FOR v_row IN
    SELECT r FROM jsonb_array_elements(v_rows) AS r
    WHERE r->>'trader_key' IN ('stale', 'wrong-tf', 'incomplete', 'wrong-trader')
  LOOP
    IF v_row->'pnl_usd' <> 'null'::jsonb OR v_row->'max_drawdown' <> 'null'::jsonb
       OR v_row->'unevidenced_metrics' <> '["pnl_usd", "max_drawdown"]'::jsonb
       OR (v_row->>'as_of')::timestamptz <> (SELECT scraped_at FROM arena.leaderboard_snapshots WHERE id = 11) THEN
      RAISE EXCEPTION 'a refused capture was published: %', v_row;
    END IF;
  END LOOP;

  -- Only the value equal to the capture is published.
  SELECT r INTO STRICT v_row FROM jsonb_array_elements(v_rows) AS r WHERE r->>'trader_key' = 'mismatch';
  IF v_row->'pnl_usd' <> 'null'::jsonb OR (v_row->>'max_drawdown')::numeric <> 25
     OR v_row->'unevidenced_metrics' <> '["pnl_usd"]'::jsonb THEN
    RAISE EXCEPTION 'mismatched capture value drifted: %', v_row;
  END IF;

  IF has_function_privilege('anon', 'arena.publication_score_rows_json(text,integer,integer)', 'EXECUTE')
     OR has_function_privilege('service_role', 'arena.publication_score_rows_json(text,integer,integer)', 'EXECUTE')
     OR has_table_privilege('service_role', 'arena.profile_acquisition_outcomes', 'INSERT')
     OR NOT has_function_privilege('service_role',
       'arena.finish_profile_acquisition_attempt(bigint,uuid,text,text,bigint,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon',
       'arena.start_profile_acquisition_attempt(uuid,integer,bigint,integer,text,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'execution boundary drifted';
  END IF;
END
$proof$;

-- A later board write that leaves the profile values alone keeps their
-- attestation (and the board keeps its own).
UPDATE arena.trader_stats SET sharpe = 1.5, evidence_raw_object_id = 5011,
  evidence_source_run_id = repeat('c', 64), evidence_metrics = ARRAY['sharpe']
WHERE trader_id = 101 AND timeframe = 90;
-- An unattested overwrite strips only the metric it changed.
UPDATE arena.trader_stats SET mdd = 30 WHERE trader_id = 102 AND timeframe = 90;

DO $proof$
DECLARE
  v_rows jsonb := arena.publication_score_rows_json('90D', 1000, 48);
  v_row jsonb;
  v_stats arena.trader_stats%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_stats FROM arena.trader_stats WHERE trader_id = 101 AND timeframe = 90;
  IF v_stats.profile_evidence_metrics <> '{mdd,total_positions,win_rate}'
     OR v_stats.evidence_metrics <> '{sharpe}' THEN
    RAISE EXCEPTION 'a board write voided profile attestations: % / %',
      v_stats.profile_evidence_metrics, v_stats.evidence_metrics;
  END IF;
  SELECT r INTO STRICT v_row FROM jsonb_array_elements(v_rows) AS r WHERE r->>'trader_key' = 'no-pnl';
  IF (v_row->>'pnl_usd')::numeric <> 900 OR v_row->'max_drawdown' <> 'null'::jsonb
     OR v_row->'unevidenced_metrics' <> '["max_drawdown", "trades_count"]'::jsonb THEN
    RAISE EXCEPTION 'an overwritten profile value was still published: %', v_row;
  END IF;
  SELECT * INTO STRICT v_stats FROM arena.trader_stats WHERE trader_id = 102 AND timeframe = 90;
  IF v_stats.profile_evidence_metrics <> '{pnl}' THEN
    RAISE EXCEPTION 'overwrite stripping drifted: %', v_stats.profile_evidence_metrics;
  END IF;
END
$proof$;

-- A write that clears the pointer removes every profile attestation.
UPDATE arena.trader_stats SET profile_evidence_attempt_seq = NULL WHERE trader_id = 102 AND timeframe = 90;
DO $proof$
BEGIN
  IF (SELECT profile_evidence_metrics FROM arena.trader_stats WHERE trader_id = 102 AND timeframe = 90)
     IS NOT NULL THEN
    RAISE EXCEPTION 'a cleared pointer kept its metrics';
  END IF;
END
$proof$;
SQL

# Without any profile evidence, @3 is @2.
psql_db <<'SQL'
SET session_replication_role = replica;
UPDATE arena.trader_stats SET profile_evidence_attempt_seq = NULL, profile_evidence_metrics = NULL;
UPDATE arena.trader_stats SET mdd = 20 WHERE trader_id = 102 AND timeframe = 90;
UPDATE arena.trader_stats SET evidence_metrics = ARRAY['sharpe'] WHERE trader_id = 101 AND timeframe = 90;
UPDATE arena.trader_stats SET as_of = now() - interval '1 hour';
SET session_replication_role = origin;
DO $proof$
DECLARE
  v_now jsonb := arena.publication_score_rows_json('90D', 1000, 48);
  v_then jsonb := (SELECT rows FROM public.rows_v2);
BEGIN
  -- as_of moved with the fixture rewrite; everything else must be identical.
  IF (SELECT jsonb_agg(r - 'as_of' ORDER BY r->>'trader_key') FROM jsonb_array_elements(v_now) r)
     IS DISTINCT FROM
     (SELECT jsonb_agg(r - 'as_of' ORDER BY r->>'trader_key') FROM jsonb_array_elements(v_then) r) THEN
    RAISE EXCEPTION '@3 without profile evidence differs from @2: % vs %', v_now, v_then;
  END IF;
END
$proof$;
SQL

echo "profile-acquisition-evidence.pg17: reader ok"

# ---------------------------------------------------------------------------
# Writer: the exact publishProfile statement.
# ---------------------------------------------------------------------------
UPSERT_SQL="$(node -e '
const s = require("fs").readFileSync(process.argv[1], "utf8")
const key = s.match(/PROFILE_PUBLICATION_EPOCH_KEY = \x27([^\x27]+)\x27/)
const m = s.match(/PROFILE_STATS_UPSERT_SQL = `([\s\S]*?)`/)
if (!key || !m) { console.error("profile stats SQL not found"); process.exit(1) }
process.stdout.write(m[1].split("${PROFILE_PUBLICATION_EPOCH_KEY}").join(key[1]))
' "$WRITER_MODULE")"

psql_db <<SQL
INSERT INTO arena.traders (id, source_id, exchange_trader_id) VALUES (108, 1, 'writer');
INSERT INTO public.seqs VALUES
  ('writer', public.capture(108, 90, '{"pnl":{"value":900},"mdd":{"value":20},"win_rate":{"value":55}}', 7108)),
  ('writer-2', public.capture(108, 90, '{"pnl":{"value":900},"mdd":{"value":20},"win_rate":{"value":55}}', 7110)),
  ('writer-other', public.capture(102, 90, '{"mdd":{"value":20}}', 7109));
PREPARE profile_upsert(bigint, smallint, timestamptz, text, numeric, numeric, numeric, numeric,
  numeric, integer, integer, numeric, integer, numeric, numeric, numeric, numeric, jsonb, jsonb,
  boolean, bigint, text[]) AS $UPSERT_SQL;
SELECT seq AS writer_seq FROM public.seqs WHERE name = 'writer' \gset
SELECT seq AS writer2_seq FROM public.seqs WHERE name = 'writer-2' \gset

CREATE FUNCTION public.writer_state() RETURNS text[] LANGUAGE sql AS \$\$
  SELECT profile_evidence_metrics FROM arena.trader_stats WHERE trader_id = 108 AND timeframe = 90
\$\$;

-- 1. An attested publish stamps exactly the captured, stored values.
EXECUTE profile_upsert(108, 90, now() - interval '3 minutes', 'USDT', 10, 900, NULL, 20, 55,
  NULL, 30, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', false,
  :writer_seq, '{mdd,pnl,win_rate}');
DO \$\$ BEGIN
  IF public.writer_state() IS DISTINCT FROM '{mdd,pnl,win_rate}' THEN
    RAISE EXCEPTION 'attested publish did not stamp: %', public.writer_state();
  END IF;
END \$\$;

-- 2. An unattested publish of equal values keeps the attestation.
EXECUTE profile_upsert(108, 90, now() - interval '2 minutes', 'USDT', 10, 900, NULL, 20, 55,
  NULL, 31, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', false, NULL, NULL);
DO \$\$ BEGIN
  IF public.writer_state() IS DISTINCT FROM '{mdd,pnl,win_rate}' THEN
    RAISE EXCEPTION 'an equal unattested publish voided evidence: %', public.writer_state();
  END IF;
END \$\$;

-- 3. An unattested publish that changes the drawdown strips only it.
EXECUTE profile_upsert(108, 90, now() - interval '1 minute', 'USDT', 10, 900, NULL, 21, 55,
  NULL, 31, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{}', false, NULL, NULL);
DO \$\$ BEGIN
  IF public.writer_state() IS DISTINCT FROM '{pnl,win_rate}' THEN
    RAISE EXCEPTION 'overwrite stripping drifted: %', public.writer_state();
  END IF;
END \$\$;

-- 4. A new capture published with the fill-metrics guard on: the retained
--    (old) win rate 54 is not the captured 55, so it is not attested.
UPDATE arena.trader_stats SET win_rate = 54 WHERE trader_id = 108 AND timeframe = 90;
EXECUTE profile_upsert(108, 90, now(), 'USDT', 10, 900, NULL, 20, 55,
  NULL, 31, NULL, NULL, NULL, NULL, NULL, NULL, NULL, '{"fills_metrics_complete":false}', true,
  :writer2_seq, '{mdd,pnl,win_rate}');
DO \$\$ BEGIN
  IF public.writer_state() IS DISTINCT FROM '{mdd,pnl}' THEN
    RAISE EXCEPTION 'a retained value was attested: %', public.writer_state();
  END IF;
END \$\$;
SQL

OTHER_SEQ="$(psql_db -At -c "SELECT seq FROM public.seqs WHERE name = 'writer-other'")"
expect_failure 'the writer cannot stamp another trader''s capture' 'is not a complete capture' \
  "PREPARE p(bigint, smallint, timestamptz, text, numeric, numeric, numeric, numeric,
     numeric, integer, integer, numeric, integer, numeric, numeric, numeric, numeric, jsonb, jsonb,
     boolean, bigint, text[]) AS $UPSERT_SQL;
   EXECUTE p(108, 90, now(), 'USDT', 10, 900, NULL, 20, 55, NULL, 31, NULL, NULL, NULL, NULL,
     NULL, NULL, NULL, '{}', false, $OTHER_SEQ, '{mdd}')"

echo "profile-acquisition-evidence.pg17: writer ok"
