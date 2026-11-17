#!/usr/bin/env bash
# PostgreSQL 17 proof that a REAL blofin_futures profile capture (recorded
# public responses replayed through the adapter's own getProfile, parsed by
# parseBlofinProfile, judged by buildProfileAcquisition) is publication
# evidence, end to end through the production writers and the @3 reader.
# Owns an isolated cluster on a private socket; never connects to
# application data. The fixture and migration chain below are the ones of
# profile-acquisition-evidence.pg17.sh.
#
# Registers the TypeScript contract's own sha256 (no registration migration:
# that is written once at integration) and proves:
#   positive - board write (exact HEADLINE_STATS_UPSERT_SQL) -> Tier-B write
#              (exact PROFILE_STATS_UPSERT_SQL) of a complete 30D capture ->
#              the reader publishes the profile win rate and trade count the
#              board lacks; a later board write keeps that attestation and
#              restores the board's own, so the row is fully evidenced;
#   negative - a stale capture, a capture of another timeframe, an
#              incomplete capture and a capture of another trader are refused
#              by the trigger and, with a forged pointer, by the reader.
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

TMP_ROOT="$(mktemp -d /tmp/blofin-profile-capture-pg17.XXXXXX)"
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
# TypeScript driver: the worker's real contract, request builder, parser,
# capture judgement and both production upserts emit the SQL that drives the
# ledger and the writers. Values are never retyped by hand.
# ---------------------------------------------------------------------------
cat >"$TMP_ROOT/driver.ts" <<'TS'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
const root = process.argv[2]
const out = process.argv[3]
const lib = (path: string) => join(root, 'lib/ingest', path)
const { blofinAdapter } = require(lib('adapters/blofin/index'))
const { parseBlofinLeaderboardPage, parseBlofinProfile } = require(lib('adapters/blofin/parsers'))
const { BLOFIN_FUTURES_PROFILE_CAPTURE: contract } = require(
  lib('adapters/blofin/profile-capture-contract')
)
const { profileCaptureContractSha256, profileContractMetrics } = require(
  lib('profile-capture/contract')
)
const { buildProfileAcquisition } = require(lib('profile-capture/capture'))
const { runProfileContractFixture } = require(lib('profile-capture/test-helper'))
const { PROFILE_STATS_UPSERT_SQL, PROFILE_PUBLICATION_EPOCH_KEY } = require(
  lib('serving/profile-stats-sql')
)
const { HEADLINE_STATS_UPSERT_SQL } = require(lib('serving/headline-stats-sql'))

const fixtures = join(root, 'lib/ingest/adapters/blofin/__tests__/fixtures')
const recorded = JSON.parse(readFileSync(join(fixtures, 'profile-capture-27374913988.json'), 'utf8'))
const board = JSON.parse(readFileSync(join(fixtures, 'board-fut-30.json'), 'utf8'))
const sha: string = profileCaptureContractSha256(contract)
const metrics: string[] = profileContractMetrics(contract)
const q = (value: unknown) =>
  value === null || value === undefined ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`
const arr = (values: readonly string[]) => q(`{${values.join(',')}}`)

async function pages(uid: string, timeframe: number, failing: string[] = []) {
  const api = {
    post: async (url: string, options: { data: Record<string, unknown> }) => {
      const path = url.replace('https://blofin.com/uapi/v1/copy/', '')
      if (failing.includes(path)) return { status: () => 503, json: async () => null }
      const key = `${path}|${String(options.data.stat_period ?? '')}`
      return { status: () => 200, json: async () => recorded.responses[key] }
    },
  }
  const session = { sourceSlug: 'blofin_futures', api: async () => api, paced: (fn: () => unknown) => fn() }
  return (await blofinAdapter.getProfile(session, { meta: {} }, uid, timeframe)).pages
}

interface Capture {
  name: string
  traderId: number
  uid: string
  timeframe: number
  attemptId: string
  raw: number
  failing?: string[]
}

async function main() {
  const now = new Date().toISOString()
  const lines: string[] = []
  lines.push(`PREPARE headline(smallint, timestamptz, text, jsonb, smallint, bigint, text) AS ${HEADLINE_STATS_UPSERT_SQL};`)
  lines.push(`PREPARE profile(bigint, smallint, timestamptz, text, numeric, numeric, numeric, numeric,
    numeric, integer, integer, numeric, integer, numeric, numeric, numeric, numeric, jsonb, jsonb,
    boolean, bigint, text[]) AS ${PROFILE_STATS_UPSERT_SQL};`)
  lines.push(`INSERT INTO arena.profile_capture_contracts
    (source_id, capture_contract, contract_sha256, timeframes, attestable_metrics)
    VALUES (1, ${q(contract.captureContract)}, ${q(sha)}, ${arr(contract.timeframes.map(String))}, ${arr(metrics)});`)

  // The board row of the recorded board page, published for each trader.
  const row = parseBlofinLeaderboardPage(board, { sourceSlug: 'blofin_futures', meta: {} }).rows.find(
    (candidate: { exchangeTraderId: string }) => candidate.exchangeTraderId === recorded.uid
  )
  const boardRows = (uids: string[]) =>
    JSON.stringify(
      uids.map((uid) => ({
        exchange_trader_id: uid,
        roi: row.headlineRoi,
        pnl: row.headlinePnl,
        win_rate: row.headlineWinRate,
        mdd: row.headlineMdd,
        sharpe: row.headlineSharpe,
        aum: row.headlineAum,
        copier_count: row.headlineCopierCount,
        copier_pnl: null,
        volume: null,
        win_positions: null,
        total_positions: null,
        holding_hours: null,
        extras: null,
      }))
    )
  const uids = ['27374913988', '1002', '1003', '1004', '1005']
  writeFileSync(join(out, 'board.json'), boardRows(uids))
  writeFileSync(join(out, 'board-roi.txt'), String(row.headlineRoi))

  const captures: Capture[] = [
    { name: 'fresh', traderId: 301, uid: '27374913988', timeframe: 30, attemptId: '00000000-0000-4000-8000-0000000003a1', raw: 7301 },
    { name: 'stale', traderId: 302, uid: '1002', timeframe: 30, attemptId: '00000000-0000-4000-8000-0000000003a2', raw: 7302 },
    { name: 'wrong_tf', traderId: 303, uid: '1003', timeframe: 90, attemptId: '00000000-0000-4000-8000-0000000003a3', raw: 7303 },
    { name: 'incomplete', traderId: 304, uid: '1004', timeframe: 30, attemptId: '00000000-0000-4000-8000-0000000003a4', raw: 7304, failing: ['trader/stat/indicators'] },
  ]
  const expected: Record<string, unknown> = {}
  for (const capture of captures) {
    const captured = await pages(capture.uid, capture.timeframe, capture.failing)
    const fixture = runProfileContractFixture({
      contract,
      timeframe: capture.timeframe,
      pages: captured,
      parseProfile: parseBlofinProfile,
      exchangeTraderId: capture.uid,
      ctx: { sourceSlug: 'blofin_futures', scrapedAt: now },
    })
    const result = buildProfileAcquisition({
      contract,
      contractSha256: sha,
      attemptId: capture.attemptId,
      exchangeTraderId: capture.uid,
      timeframe: capture.timeframe,
      pages: captured,
      parsed: fixture.parsed,
      stored: fixture.stored,
    })
    if ((capture.failing ? 'processing_failed' : 'complete') !== result.terminalState) {
      throw new Error(`${capture.name}: ${result.terminalState}/${result.reasonCode}`)
    }
    lines.push(`SELECT attempt_seq AS seq_${capture.name} FROM arena.start_profile_acquisition_attempt(
      ${q(capture.attemptId)}, 1, ${capture.traderId}, ${capture.timeframe}, ${q(contract.captureContract)}, ${q(sha)}, NULL) \\gset`)
    lines.push(`INSERT INTO arena.raw_objects VALUES (${capture.raw}, 1, 'tier_b', ${capture.traderId}, ${capture.timeframe},
      clock_timestamp(), 'raw/${capture.raw}', 1, repeat('e', 64), false, jsonb_build_object('profile_capture',
      jsonb_build_object('attempt_id', ${q(capture.attemptId)}, 'capture_contract', ${q(contract.captureContract)})));`)
    lines.push(`SELECT terminal_state FROM arena.finish_profile_acquisition_attempt(:seq_${capture.name},
      ${q(capture.attemptId)}, ${q(result.terminalState)}, ${q(result.reasonCode)}, ${capture.raw},
      ${q(result.sourceRunId)}, ${result.manifest ? `${q(JSON.stringify(result.manifest))}::jsonb` : 'NULL'});`)
    const s = fixture.stored
    expected[capture.name] = s ? { winRate: s.winRate, trades: s.totalPositions, metrics: result.attestedMetrics } : null
    if (!s) continue
    // publishProfile's exact parameter mapping (lib/ingest/serving/publish.ts).
    const params = (seq: string, attested: readonly string[] | null) =>
      [
        capture.traderId, s.timeframe, q(s.asOf), "'USDT'", q(s.roi), q(s.pnl), q(s.sharpe), q(s.mdd),
        q(s.winRate), q(s.winPositions), q(s.totalPositions), q(s.copierPnl), q(s.copierCount),
        q(s.aum), q(s.volume), q(s.profitShareRate),
        q(s.holdingDurationAvgHours === null ? null : s.holdingDurationAvgHours * 3600),
        q(s.tradingPreferences ? JSON.stringify(s.tradingPreferences) : null),
        q(JSON.stringify({ ...s.extras, [PROFILE_PUBLICATION_EPOCH_KEY]: Date.parse(s.asOf) })),
        s.extras.fills_metrics_complete === false, seq, attested ? arr(attested) : 'NULL',
      ].join(', ')
    writeFileSync(
      join(out, `profile-${capture.name}.sql`),
      `EXECUTE profile(${params(`:seq_${capture.name}`, result.attestedMetrics)});\n`
    )
    // The same capture written onto the 30D row of another trader / period.
    writeFileSync(
      join(out, `profile-${capture.name}-as.sql`),
      `EXECUTE profile(${params(`:seq_${capture.name}`, result.attestedMetrics)
        .replace(/^\d+, \d+/, ':target_trader, 30')});\n`
    )
  }
  writeFileSync(join(out, 'setup.sql'), lines.join('\n') + '\n')
  writeFileSync(join(out, 'expected.json'), JSON.stringify(expected))
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
TS
mkdir -p "$TMP_ROOT/out"
(cd "$ROOT_DIR" && npx --no-install tsx "$TMP_ROOT/driver.ts" "$ROOT_DIR" "$TMP_ROOT/out")
EXPECTED="$(cat "$TMP_ROOT/out/expected.json")"
BOARD_ROWS="$(cat "$TMP_ROOT/out/board.json")"
node -e '
const e = JSON.parse(process.argv[1])
const ok = e.fresh.winRate === 100 && e.fresh.trades === 9 &&
  JSON.stringify(e.fresh.metrics) === JSON.stringify(["total_positions", "win_rate"]) &&
  e.wrong_tf.trades === 11 && e.incomplete === null
if (!ok) { console.error("driver captures drifted: " + process.argv[1]); process.exit(1) }
' "$EXPECTED"

# ---------------------------------------------------------------------------
# Data: blofin_futures with a passed 30D board (attempt-bound run c..., RAW
# 5011). The board carries ROI/PnL/drawdown/Sharpe/copiers, no win rate.
# ---------------------------------------------------------------------------
psql_db -v board_rows="$BOARD_ROWS" <<'SQL'
INSERT INTO arena.sources (id, slug, adapter_slug, status, serving_mode) VALUES
  (1, 'blofin_futures', 'blofin', 'active', 'serving');
INSERT INTO arena.traders (id, source_id, exchange_trader_id, nickname) VALUES
  (301, 1, '27374913988', 'lee88 trade'), (302, 1, '1002', 'Stale'),
  (303, 1, '1003', 'WrongTf'), (304, 1, '1004', 'Incomplete'), (305, 1, '1005', 'WrongTrader');
INSERT INTO arena.leaderboard_snapshots VALUES (11, 1, 30, now() - interval '1 hour', 5, true, 5011);
INSERT INTO arena.leaderboard_acquisition_attempts VALUES (1, 1, 30);
INSERT INTO arena.leaderboard_acquisition_outcomes VALUES (1, repeat('c', 64), 5011);
INSERT INTO arena.leaderboard_entries
  (scraped_at, snapshot_id, trader_id, timeframe, rank, headline_roi, headline_pnl, headline_win_rate)
SELECT s.scraped_at, 11, t.id, 30, t.id - 300, r.roi, r.pnl, r.win_rate
FROM jsonb_to_recordset(:'board_rows'::jsonb) AS r(exchange_trader_id text, roi numeric, pnl numeric, win_rate numeric)
JOIN arena.traders AS t ON t.exchange_trader_id = r.exchange_trader_id
CROSS JOIN arena.leaderboard_snapshots AS s WHERE s.id = 11;
SQL
psql_db -v board_rows="$BOARD_ROWS" <<SQL
\\i $TMP_ROOT/out/setup.sql
SELECT scraped_at AS board_at FROM arena.leaderboard_snapshots WHERE id = 11 \\gset
EXECUTE headline(30, :'board_at', 'USDT', :'board_rows', 1, 5011, repeat('c', 64));
\\i $TMP_ROOT/out/profile-fresh.sql
\\i $TMP_ROOT/out/profile-stale.sql
SQL

# ---------------------------------------------------------------------------
# Trigger: only a complete capture of the same trader and period attests.
# ---------------------------------------------------------------------------
psql_seq() { psql_db -At -c "SELECT attempt_seq FROM arena.profile_acquisition_attempts WHERE attempt_id = '$1'"; }
SEQ_WRONG_TF="$(psql_seq 00000000-0000-4000-8000-0000000003a3)"
SEQ_INCOMPLETE="$(psql_seq 00000000-0000-4000-8000-0000000003a4)"
SEQ_FRESH="$(psql_seq 00000000-0000-4000-8000-0000000003a1)"
attempt_as() {
  local label="$1" file="$2" seq="$3" trader="$4"
  expect_failure "$label" 'is not a complete capture' \
    "$(printf 'PREPARE profile(bigint, smallint, timestamptz, text, numeric, numeric, numeric, numeric, numeric, integer, integer, numeric, integer, numeric, numeric, numeric, numeric, jsonb, jsonb, boolean, bigint, text[]) AS %s;\n%s' \
      "$(cd "$ROOT_DIR" && npx --no-install tsx -e 'process.stdout.write(require("./lib/ingest/serving/profile-stats-sql").PROFILE_STATS_UPSERT_SQL)')" \
      "$(sed -e "s/:seq_[a-z_]*/$seq/" -e "s/:target_trader/$trader/" "$TMP_ROOT/out/$file")")"
}
attempt_as 'a 90D capture cannot attest the 30D row' profile-wrong_tf-as.sql "$SEQ_WRONG_TF" 303
attempt_as 'a capture of another trader cannot attest this trader' profile-fresh-as.sql "$SEQ_FRESH" 305
expect_failure 'an incomplete capture cannot attest' 'is not a complete capture' \
  "UPDATE arena.trader_stats SET profile_evidence_attempt_seq = $SEQ_INCOMPLETE,
     profile_evidence_metrics = '{total_positions}' WHERE trader_id = 304 AND timeframe = 30"

# The refused cases still hold profile-shaped values (as an unattested
# publish would leave them), and forged pointers bypass the trigger, so the
# reader alone must refuse them. The stale capture began 3 days ago.
psql_db <<SQL
SET session_replication_role = replica;
UPDATE arena.trader_stats AS s SET win_rate = f.win_rate, total_positions = f.total_positions
FROM arena.trader_stats AS f WHERE f.trader_id = 301 AND f.timeframe = 30
  AND s.trader_id IN (303, 304, 305) AND s.timeframe = 30;
UPDATE arena.trader_stats SET profile_evidence_attempt_seq = $SEQ_WRONG_TF,
  profile_evidence_metrics = '{total_positions,win_rate}' WHERE trader_id = 303 AND timeframe = 30;
UPDATE arena.trader_stats SET profile_evidence_attempt_seq = $SEQ_INCOMPLETE,
  profile_evidence_metrics = '{total_positions,win_rate}' WHERE trader_id = 304 AND timeframe = 30;
UPDATE arena.trader_stats SET profile_evidence_attempt_seq = $SEQ_FRESH,
  profile_evidence_metrics = '{total_positions,win_rate}' WHERE trader_id = 305 AND timeframe = 30;
UPDATE arena.profile_acquisition_attempts SET recorded_started_at = now() - interval '72 hours'
WHERE attempt_id = '00000000-0000-4000-8000-0000000003a2';
SET session_replication_role = origin;
SQL

echo "blofin-profile-capture.pg17: trigger ok"

# ---------------------------------------------------------------------------
# Reader @3 after the Tier-B write, then after the next board write.
# ---------------------------------------------------------------------------
psql_db <<'SQL'
DO $proof$
DECLARE
  v_rows jsonb := arena.publication_score_rows_json('30D', 1000, 48);
  v_row jsonb;
BEGIN
  IF jsonb_array_length(v_rows) <> 5 THEN
    RAISE EXCEPTION 'expected 5 rows: %', v_rows;
  END IF;
  -- The profile supplies the win rate and trade count the board lacks.
  SELECT r INTO STRICT v_row FROM jsonb_array_elements(v_rows) AS r WHERE r->>'trader_key' = '27374913988';
  IF (v_row->>'win_rate')::numeric <> 100 OR (v_row->>'trades_count')::int <> 9
     OR v_row->'roi_pct' = 'null'::jsonb OR v_row->'pnl_usd' = 'null'::jsonb
     OR v_row->'unevidenced_metrics' @> '["win_rate"]'::jsonb
     OR v_row->'unevidenced_metrics' @> '["trades_count"]'::jsonb THEN
    RAISE EXCEPTION 'profile-attested blofin row drifted: %', v_row;
  END IF;
  -- Stale, other period, incomplete, other trader: refused and named.
  FOR v_row IN
    SELECT r FROM jsonb_array_elements(v_rows) AS r WHERE r->>'trader_key' IN ('1002', '1003', '1004', '1005')
  LOOP
    IF v_row->'win_rate' <> 'null'::jsonb OR v_row->'trades_count' <> 'null'::jsonb
       OR NOT v_row->'unevidenced_metrics' @> '["win_rate", "trades_count"]'::jsonb THEN
      RAISE EXCEPTION 'a refused blofin capture was published: %', v_row;
    END IF;
  END LOOP;
END
$proof$;
SQL

# The next attempt-bound board write (new RAW 5012, run d...) re-attests the
# board's own values and leaves the profile win rate and trade count attested.
psql_db -v board_rows="$BOARD_ROWS" <<SQL
INSERT INTO arena.leaderboard_snapshots VALUES (12, 1, 30, now() - interval '5 minutes', 5, true, 5012);
INSERT INTO arena.leaderboard_acquisition_attempts VALUES (2, 1, 30);
INSERT INTO arena.leaderboard_acquisition_outcomes VALUES (2, repeat('d', 64), 5012);
INSERT INTO arena.leaderboard_entries
  (scraped_at, snapshot_id, trader_id, timeframe, rank, headline_roi, headline_pnl, headline_win_rate)
SELECT s.scraped_at, 12, e.trader_id, 30, e.rank, e.headline_roi, e.headline_pnl, e.headline_win_rate
FROM arena.leaderboard_entries AS e CROSS JOIN arena.leaderboard_snapshots AS s
WHERE e.snapshot_id = 11 AND s.id = 12;
SELECT scraped_at AS board_at FROM arena.leaderboard_snapshots WHERE id = 12 \\gset
PREPARE headline(smallint, timestamptz, text, jsonb, smallint, bigint, text) AS
  $(cd "$ROOT_DIR" && npx --no-install tsx -e 'process.stdout.write(require("./lib/ingest/serving/headline-stats-sql").HEADLINE_STATS_UPSERT_SQL)');
EXECUTE headline(30, :'board_at', 'USDT', :'board_rows', 1, 5012, repeat('d', 64));
SQL

psql_db <<'SQL'
DO $proof$
DECLARE
  v_rows jsonb := arena.publication_score_rows_json('30D', 1000, 48);
  v_row jsonb;
  v_stats arena.trader_stats%ROWTYPE;
BEGIN
  SELECT * INTO STRICT v_stats FROM arena.trader_stats WHERE trader_id = 301 AND timeframe = 30;
  IF v_stats.profile_evidence_metrics IS DISTINCT FROM '{total_positions,win_rate}' THEN
    RAISE EXCEPTION 'the board write voided the profile attestation: %', v_stats.profile_evidence_metrics;
  END IF;
  SELECT r INTO STRICT v_row FROM jsonb_array_elements(v_rows) AS r WHERE r->>'trader_key' = '27374913988';
  -- Every score input is evidenced; only the profile's own risk ratios
  -- (extras, outside this contract) stay unattested.
  IF (v_row->>'win_rate')::numeric <> 100 OR (v_row->>'trades_count')::int <> 9
     OR v_row->'max_drawdown' = 'null'::jsonb OR v_row->'roi_pct' = 'null'::jsonb
     OR v_row->'pnl_usd' = 'null'::jsonb OR v_row->'sharpe_ratio' = 'null'::jsonb
     OR v_row->'unevidenced_metrics'
        <> '["sortino_ratio", "calmar_ratio", "volatility_pct"]'::jsonb THEN
    RAISE EXCEPTION 'board + profile blofin row drifted: %', v_row;
  END IF;
END
$proof$;
SQL

echo "blofin-profile-capture.pg17: reader ok"
