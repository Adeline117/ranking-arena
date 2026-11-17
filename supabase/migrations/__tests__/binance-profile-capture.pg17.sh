#!/usr/bin/env bash

# PostgreSQL 17 proof that the binance_futures / binance_spot Tier-B profile
# captures (lib/ingest/adapters/binance/profile-capture-contract.ts) publish
# exactly their contracted metrics through the real ledger, writer and the
# publication_score_rows_json@3 reader. Isolated cluster on a private socket;
# never connects to application data.
#
# The relation fixture and migration chain are those of
# profile-acquisition-evidence.pg17.sh. The capture itself is the worker's:
# the real binance getProfile (recorded public responses, 2026-11-16 probe),
# parseBinanceProfile, staging validation, buildProfileAcquisition, the
# ledger client (start/finish) and the exact publishProfile upsert.
#
# Proves:
#   positive - futures 90D publishes the profile drawdown and trade count
#              next to the board headline; spot 90D publishes the profile
#              drawdown and stores no window win rate (lifetime ratio only);
#   negative - a capture of another trader or another timeframe, or an
#              incomplete capture, cannot be pointed at the row (22023); a
#              capture older than the freshness window is not published.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
STEP1=20261116204006_publication_score_rows_board_headline_only.sql
STEP2A=20261116205144_trader_stats_score_input_evidence_pointer.sql
STEP2B=20261116210122_publication_score_rows_require_stats_evidence.sql
LEDGER=20261116215328_profile_acquisition_evidence_ledger.sql
READER=20261116215329_publication_score_rows_profile_attested.sql
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

psql_db -f "$MIGRATIONS/$STEP1"
psql_db -f "$MIGRATIONS/$STEP2A"
psql_db -f "$MIGRATIONS/$STEP2B"
psql_db -f "$MIGRATIONS/$LEDGER"
psql_db -f "$MIGRATIONS/$READER"

# ---------------------------------------------------------------------------
# Data: one serving 90D board per source (attempt-bound, RAW 5011 / 5012).
# The futures board carries ROI, PnL and win rate; the spot board ROI and PnL.
# ---------------------------------------------------------------------------
psql_db <<'SQL'
INSERT INTO arena.sources (id, slug, adapter_slug, status, serving_mode, product_type) VALUES
  (1, 'binance_futures', 'binance', 'active', 'serving', 'futures'),
  (2, 'binance_spot', 'binance', 'active', 'serving', 'spot');
INSERT INTO arena.leaderboard_snapshots VALUES
  (11, 1, 90, now() - interval '1 hour', 5, true, 5011),
  (12, 2, 90, now() - interval '1 hour', 1, true, 5012);
INSERT INTO arena.traders (id, source_id, exchange_trader_id) VALUES
  (101, 1, '5076490769406674432'),
  (102, 1, '5000000000000000102'),
  (103, 1, '5000000000000000103'),
  (104, 1, '5000000000000000104'),
  (105, 1, '5000000000000000105'),
  (201, 2, '4163883351504751104');
INSERT INTO arena.leaderboard_entries
  (scraped_at, snapshot_id, trader_id, timeframe, rank, headline_roi, headline_pnl, headline_win_rate)
SELECT s.scraped_at, s.id, e.trader_id, 90, e.rank, e.roi, e.pnl, e.win_rate
FROM (VALUES
  (11, 101, 1, 0.34, 2.1, 66.67), (11, 102, 2, 1.0, 1.0, 50.0), (11, 103, 3, 1.0, 1.0, 50.0),
  (11, 104, 4, 1.0, 1.0, 50.0), (11, 105, 5, 1.0, 1.0, 50.0), (12, 201, 1, 57.52, 4351.51, NULL)
) AS e(snapshot_id, trader_id, rank, roi, pnl, win_rate)
JOIN arena.leaderboard_snapshots AS s ON s.id = e.snapshot_id;
INSERT INTO arena.leaderboard_acquisition_attempts VALUES (1, 1, 90), (2, 2, 90);
INSERT INTO arena.leaderboard_acquisition_outcomes VALUES
  (1, repeat('c', 64), 5011), (2, repeat('d', 64), 5012);
SQL

# ---------------------------------------------------------------------------
# The worker's capture path, run against the cluster. Prints one JSON object:
# per case the attempt sequence, terminal state, attested metrics and, for a
# publish that must be refused, the SQLSTATE it raised.
# ---------------------------------------------------------------------------
DRIVER_OUT="$(cd "$ROOT_DIR" && PGHOST="$SOCKET_DIR" PGPORT="$PORT" npx --no-install tsx -e '
import { readFileSync } from "fs"
import { join } from "path"
import { Client } from "pg"
import { binanceAdapter } from "./lib/ingest/adapters/binance/index"
import { parseBinanceProfile } from "./lib/ingest/adapters/binance/parsers"
import { buildProfileAcquisition, lastStatsBlock } from "./lib/ingest/profile-capture/capture"
import { getProfileCaptureContract, profileCaptureContractSha256 } from "./lib/ingest/profile-capture/contract"
import { finishProfileAcquisitionAttempt, profileCaptureRawMeta, startProfileAcquisitionAttempt } from "./lib/ingest/profile-capture/ledger"
import { PROFILE_PUBLICATION_EPOCH_KEY, PROFILE_STATS_UPSERT_SQL } from "./lib/ingest/serving/profile-stats-sql"
import { validateStats } from "./lib/ingest/staging/validate"

const FIX = "./lib/ingest/adapters/binance/__tests__/fixtures"
const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf8"))
type Board = "futures" | "spot"
const SOURCE_ID = { futures: 1, spot: 2 } as const
const db = new Client({ user: "postgres", database: "postgres" })

function sourceRow(board: Board): any {
  return { id: SOURCE_ID[board], slug: `binance_${board}`, adapter_slug: "binance",
    product_type: board, currency: "USDT", timeframes_native: [7, 30, 90], timeframes_derived: [],
    tf_label_map: {}, status: "active", serving_mode: "serving", meta: { boardKey: board } }
}

async function pages(board: Board, ext: string, tf: 7 | 30 | 90, performance: unknown) {
  const prefix = board === "spot" ? "spot-" : ""
  const respond = async (request: { url: string }) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith("/lead-portfolio/detail")) return { status: 200, json: fixture(`${prefix}detail.json`) }
    if (url.pathname.endsWith("/lead-portfolio/performance")) return { status: 200, json: performance }
    if (url.pathname.endsWith("/performance/coin") || url.pathname.endsWith("/coin-preference"))
      return { status: 200, json: fixture(`${prefix}coin-preference-7.json`) }
    const pnl = url.searchParams.get("dataType") === "PNL"
    return { status: 200, json: fixture(`${prefix}chart-${pnl ? "pnl" : "roi"}-7.json`) }
  }
  const page = { goto: async () => undefined, waitForLoadState: async () => undefined }
  const session: any = { sourceSlug: `binance_${board}`, page: async () => page, pageFetch: respond,
    paced: async (fn: () => Promise<unknown>) => fn() }
  return (await binanceAdapter.getProfile!(session, sourceRow(board), ext, tf)).pages
}

let rawId = 9000
/** Tier-B for one trader/timeframe: start, RAW, parse, validate, build, finish. */
async function capture(board: Board, traderId: number, ext: string, tf: 7 | 30 | 90, performance: unknown) {
  const contract = getProfileCaptureContract(`binance_${board}`)!
  const attempt = await startProfileAcquisitionAttempt(db, { sourceId: SOURCE_ID[board], traderId, timeframe: tf, contract })
  const rawPages = await pages(board, ext, tf, performance)
  rawId += 1
  await db.query(`INSERT INTO arena.raw_objects VALUES ($1, $2, $3, $4, $5, clock_timestamp(), $6, 1, $7, false, $8)`,
    [rawId, SOURCE_ID[board], "tier_b", traderId, tf, `raw/${rawId}`, "e".repeat(64), JSON.stringify(profileCaptureRawMeta(attempt))])
  const ctx: any = { sourceSlug: `binance_${board}`, currency: "USDT", tfLabelMap: {}, scrapedAt: new Date().toISOString(), meta: { boardKey: board } }
  const last = lastStatsBlock(rawPages.map((p) => parseBinanceProfile(p.payload, ctx)), tf)
  const stored = last === null ? null : (validateStats([last.block], []).valid[0] ?? null)
  const result = buildProfileAcquisition({ contract, contractSha256: attempt.contractSha256,
    attemptId: attempt.attemptId, exchangeTraderId: ext, timeframe: tf, pages: rawPages,
    parsed: last?.block ?? null, stored })
  await finishProfileAcquisitionAttempt(db, attempt, result, rawId)
  return { seq: attempt.attemptSeq, state: result.terminalState, reason: result.reasonCode,
    metrics: [...result.attestedMetrics], stored }
}

/** The exact publishProfile upsert (publish.ts parameter order). */
async function publish(traderId: number, tf: number, s: any, evidence: { seq: number; metrics: string[] } | null) {
  try {
    await db.query(PROFILE_STATS_UPSERT_SQL, [traderId, tf, s.asOf, "USDT", s.roi, s.pnl, s.sharpe, s.mdd,
      s.winRate, s.winPositions, s.totalPositions, s.copierPnl, s.copierCount, s.aum, s.volume,
      s.profitShareRate, s.holdingDurationAvgHours === null ? null : s.holdingDurationAvgHours * 3600,
      s.tradingPreferences ? JSON.stringify(s.tradingPreferences) : null,
      JSON.stringify({ ...s.extras, [PROFILE_PUBLICATION_EPOCH_KEY]: Date.parse(s.asOf) }), false,
      evidence?.seq ?? null, evidence ? evidence.metrics : null])
    return null
  } catch (error: any) {
    return String(error.code)
  }
}

async function main() {
  await db.connect()
  for (const board of ["futures", "spot"] as const) {
    const contract = getProfileCaptureContract(`binance_${board}`)!
    // What the combined registration migration inserts for this contract.
    await db.query(`INSERT INTO arena.profile_capture_contracts
      (source_id, capture_contract, contract_sha256, timeframes, attestable_metrics) VALUES ($1, $2, $3, $4, $5)`,
      [SOURCE_ID[board], contract.captureContract, profileCaptureContractSha256(contract),
       contract.timeframes, Object.keys(contract.metrics)])
  }
  const out: Record<string, unknown> = {}
  const futures90 = fixture("profile-performance-futures-90D.json")

  const f = await capture("futures", 101, "5076490769406674432", 90, futures90)
  out.futures = { ...f, refused: await publish(101, 90, f.stored, f) }
  const s = await capture("spot", 201, "4163883351504751104", 90, fixture("profile-performance-spot-90D.json"))
  out.spot = { ...s, refused: await publish(201, 90, s.stored, s) }

  // Another trader: 101s capture pointed at 102s row.
  out.wrongTrader = { refused: await publish(102, 90, f.stored, f) }
  // Another timeframe: a complete 30D capture pointed at the 90D row.
  const w = await capture("futures", 105, "5000000000000000105", 30, fixture("profile-performance-futures-30D-no-total.json"))
  out.wrongTimeframe = { state: w.state, refused: await publish(105, 90, { ...w.stored, timeframe: 90 }, w) }
  // Incomplete: a 90D request answered with the 30D window has no 90D block.
  const i = await capture("futures", 103, "5000000000000000103", 90, fixture("profile-performance-futures-30D-no-total.json"))
  out.incomplete = { state: i.state, reason: i.reason, metrics: i.metrics,
    refused: await publish(103, 90, f.stored, { seq: i.seq, metrics: ["mdd", "total_positions"] }) }
  // Stale: complete and stamped now; its start is moved out of the window below.
  const st = await capture("futures", 104, "5000000000000000104", 90, futures90)
  out.stale = { seq: st.seq, state: st.state, refused: await publish(104, 90, st.stored, st) }

  // The refused rows still get their (unattested) values, as the worker
  // publishes a profile whose capture carries no evidence.
  for (const id of [102, 103, 105]) await publish(id, 90, f.stored, null)
  await db.end()
  process.stdout.write(JSON.stringify(out))
}
main().catch((error) => { console.error(error); process.exit(1) })
')"

expect_json() {
  local label="$1" expression="$2"
  if ! node -e '
    const out = JSON.parse(process.argv[1])
    if (!(new Function("out", "return (" + process.argv[2] + ")"))(out)) process.exit(1)
  ' "$DRIVER_OUT" "$expression"; then
    echo "$label: unexpected driver output $DRIVER_OUT" >&2
    exit 1
  fi
}

expect_json 'futures capture attests exactly drawdown and trade count' \
  'out.futures.state === "complete" && out.futures.metrics.join() === "mdd,total_positions" && out.futures.refused === null'
expect_json 'spot capture attests exactly drawdown' \
  'out.spot.state === "complete" && out.spot.metrics.join() === "mdd" && out.spot.refused === null'
expect_json 'a capture of another trader cannot attest the row' 'out.wrongTrader.refused === "22023"'
expect_json 'a capture of another timeframe cannot attest the row' \
  'out.wrongTimeframe.state === "complete" && out.wrongTimeframe.refused === "22023"'
expect_json 'an incomplete capture attests nothing and cannot be pointed at' \
  'out.incomplete.state === "processing_failed" && out.incomplete.reason === "stats_block_missing" && out.incomplete.metrics.length === 0 && out.incomplete.refused === "22023"'
expect_json 'the later-stale capture was attested when fresh' \
  'out.stale.state === "complete" && out.stale.refused === null'

STALE_SEQ="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).stale.seq))' "$DRIVER_OUT")"
psql_db -v stale_seq="$STALE_SEQ" <<'SQL'
-- Fixture-only rewrite of the ledger: the capture began 72 hours ago.
SET session_replication_role = replica;
UPDATE arena.profile_acquisition_attempts SET recorded_started_at = now() - interval '72 hours'
WHERE attempt_seq = :stale_seq;
SET session_replication_role = origin;
SQL

# ---------------------------------------------------------------------------
# Reader @3 over both boards.
# ---------------------------------------------------------------------------
psql_db <<'SQL'
DO $proof$
DECLARE
  v_rows jsonb := arena.publication_score_rows_json('90D', 1000, 48);
  v_row jsonb;
  v_expect jsonb := jsonb_build_object(
    -- futures: board headline + profile drawdown and trade count.
    '5076490769406674432', jsonb_build_object('roi_pct', 0.34, 'pnl_usd', 2.1, 'win_rate', 66.67,
      'max_drawdown', 0.06575396, 'trades_count', 3),
    -- spot: profile drawdown; the lifetime win-day ratio is no win rate.
    '4163883351504751104', jsonb_build_object('roi_pct', 57.52, 'pnl_usd', 4351.51,
      'win_rate', NULL, 'max_drawdown', 13.201449, 'trades_count', NULL),
    -- refused: wrong trader, incomplete, wrong timeframe, stale.
    '5000000000000000102', jsonb_build_object('max_drawdown', NULL, 'trades_count', NULL),
    '5000000000000000103', jsonb_build_object('max_drawdown', NULL, 'trades_count', NULL),
    '5000000000000000105', jsonb_build_object('max_drawdown', NULL, 'trades_count', NULL),
    '5000000000000000104', jsonb_build_object('max_drawdown', NULL, 'trades_count', NULL));
  v_key text;
  v_field text;
BEGIN
  IF jsonb_array_length(v_rows) <> 6 THEN
    RAISE EXCEPTION 'expected 6 publication rows, got %', v_rows;
  END IF;
  FOR v_key IN SELECT jsonb_object_keys(v_expect) LOOP
    SELECT r INTO v_row FROM jsonb_array_elements(v_rows) AS r WHERE r->>'trader_key' = v_key;
    FOR v_field IN SELECT jsonb_object_keys(v_expect->v_key) LOOP
      IF (v_row->v_field) IS DISTINCT FROM (v_expect->v_key->v_field)
         AND NOT (jsonb_typeof(v_row->v_field) = 'number'
                  AND (v_row->>v_field)::numeric = (v_expect->v_key->>v_field)::numeric) THEN
        RAISE EXCEPTION '% %: expected %, got %', v_key, v_field, v_expect->v_key->v_field, v_row;
      END IF;
    END LOOP;
    IF v_key IN ('5076490769406674432', '4163883351504751104')
       AND (v_row->'unevidenced_metrics') ?| ARRAY['max_drawdown', 'trades_count'] THEN
      RAISE EXCEPTION '% lists an attested metric as unevidenced: %', v_key, v_row;
    END IF;
    -- The parser stores no window win rate for spot (lifetime_win_rate in
    -- extras), so there is nothing to refuse: null and not listed.
    IF v_key = '4163883351504751104' AND (v_row->'unevidenced_metrics') ? 'win_rate' THEN
      RAISE EXCEPTION 'spot row still carries a window win rate: %', v_row;
    END IF;
    IF v_key LIKE '50000000000000001%' AND NOT (v_row->'unevidenced_metrics') ?& ARRAY['max_drawdown', 'trades_count'] THEN
      RAISE EXCEPTION '% did not refuse its unattested values: %', v_key, v_row;
    END IF;
  END LOOP;
END
$proof$;
SQL

echo "binance-profile-capture.pg17: ok"
