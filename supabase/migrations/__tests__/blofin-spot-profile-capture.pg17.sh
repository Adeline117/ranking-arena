#!/usr/bin/env bash
# PostgreSQL 17 proof for 20261120235710_register_blofin_spot_profile_capture_contract
# and for the blofin_spot detail capture it registers, end to end through the
# production writers and the @3 reader. Owns an isolated cluster on a private
# socket; never connects to application data.
#
# Like Supabase, the cluster superuser is supabase_admin and every fixture
# object and migration runs as a NOSUPERUSER postgres role, so a statement only
# a superuser may run (e.g. a function-level SET of a custom parameter) fails
# here exactly as it does in production.
#
# The capture is REAL: recorded public responses of the spot detail endpoints
# (/sapi/v1/spot_copy/trader/*) replayed through the adapter's own getProfile,
# parsed by parseBlofinProfile and judged by buildProfileAcquisition; the board
# rows are a recorded spot board page parsed by parseBlofinLeaderboardPage.
#
# Proves:
#   order    - the registration refuses to run before the ledger (215328);
#   exact    - the registered row equals the code contract field by field
#              (name, profileCaptureContractSha256, timeframes, sorted metric
#              keys), and start accepts it at 7/30/90 with the code hash;
#   refusal  - a replay, an earlier registration with a drifted hash, an
#              adapter mismatch and a missing source each refuse the whole
#              migration, and nothing lands;
#   positive - board write (exact HEADLINE_STATS_UPSERT_SQL) -> Tier-B write
#              (exact PROFILE_STATS_UPSERT_SQL) of a complete 30D capture ->
#              the reader publishes the win rate and trade count the board
#              lacks, and the drawdown stays evidenced: by the board while the
#              two values agree, by the profile when the profile wrote a value
#              the board no longer holds, by the board again after its next
#              write;
#   zero     - an idle trader's board drawdown "0" is published as 0, not NULL;
#   leftover - a row still holding the profile-only columns of an old profile
#              write (as the futures-route crawl left them) is older than the
#              reader's 48h stats window however fresh the board is, so its
#              drawdown and win rate publish NULL; one spot capture restores it.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATIONS="$ROOT_DIR/supabase/migrations"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
STEP1=20261116204006_publication_score_rows_board_headline_only.sql
STEP2A=20261116205144_trader_stats_score_input_evidence_pointer.sql
STEP2B=20261116210122_publication_score_rows_require_stats_evidence.sql
LEDGER=20261116215328_profile_acquisition_evidence_ledger.sql
READER=20261116215329_publication_score_rows_profile_attested.sql
REGISTER=20261120235710_register_blofin_spot_profile_capture_contract.sql
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

TMP_ROOT="$(mktemp -d /tmp/blofin-spot-profile-capture-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 8000)))}"
mkdir -p "$SOCKET_DIR" "$TMP_ROOT/out"

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

# Every fixture statement and migration runs as the non-superuser postgres.
psql_in() {
  local database="$1"
  shift
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U postgres \
    -d "$database" "$@"
}
psql_db() { psql_in postgres "$@"; }
psql_admin() {
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -U supabase_admin \
    -d postgres "$@"
}

expect_failure_in() {
  local database="$1" label="$2" pattern="$3" sql="$4"
  local output
  if output="$(psql_in "$database" -c "$sql" 2>&1)"; then
    echo "$label: expected failure, succeeded" >&2
    exit 1
  fi
  if ! grep -q -- "$pattern" <<<"$output"; then
    echo "$label: expected '$pattern', got: $output" >&2
    exit 1
  fi
}

registered_count() {
  psql_in "$1" -tA -c 'SELECT count(*) FROM arena.profile_capture_contracts'
}

"$PG_BIN/initdb" -D "$DATA_DIR" -A trust -U supabase_admin --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" \
  -o "-k $SOCKET_DIR -p $PORT -F -c listen_addresses=''" \
  -l "$LOG_FILE" -w start >/dev/null

psql_admin <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER;
CREATE ROLE service_role NOLOGIN NOSUPERUSER;
GRANT anon, authenticated, service_role TO postgres;
GRANT CREATE ON DATABASE postgres TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL
if [[ "$(psql_db -Atc "SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user")" != "f" ]]; then
  echo "migrations must run as a non-superuser postgres role" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Fixture: the relations the bundle, the readers and the ledger read.
# ---------------------------------------------------------------------------
psql_db <<'SQL'
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

-- Proof helper: one failed expectation aborts the script.
CREATE FUNCTION public.proof_assert(p_ok boolean, p_message text)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'proof failed: %', p_message;
  END IF;
END
$$;

INSERT INTO arena.sources (id, slug, adapter_slug, status, serving_mode, product_type) VALUES
  (1, 'blofin_spot', 'blofin', 'active', 'serving', 'spot');
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

# ---------------------------------------------------------------------------
# order: the registration needs the registry of the ledger migration.
# ---------------------------------------------------------------------------
expect_failure_in postgres 'the registration refuses to run before the ledger' \
  'blofin_spot profile capture contract registration requires 20261116215328' \
  "\\i $MIGRATIONS/$REGISTER"

psql_db -f "$MIGRATIONS/$LEDGER"
psql_db -f "$MIGRATIONS/$READER"
if [[ "$(registered_count postgres)" != 0 ]]; then
  echo 'the ledger must start with an empty registry' >&2
  exit 1
fi

# Snapshot the pre-registration state for the refusal cases.
psql_admin -c 'CREATE DATABASE pre_registration TEMPLATE postgres OWNER postgres'

psql_db -f "$MIGRATIONS/$REGISTER"

# ---------------------------------------------------------------------------
# TypeScript driver: the worker's real contract, request builder, parsers,
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
const {
  getProfileCaptureContract,
  profileCaptureContractSha256,
  profileContractMetrics,
} = require(lib('profile-capture/contract'))
const { buildProfileAcquisition } = require(lib('profile-capture/capture'))
const { runProfileContractFixture } = require(lib('profile-capture/test-helper'))
const { validateLeaderboardRows } = require(lib('staging/validate'))
const { PROFILE_STATS_UPSERT_SQL, PROFILE_PUBLICATION_EPOCH_KEY } = require(
  lib('serving/profile-stats-sql')
)
const { HEADLINE_STATS_UPSERT_SQL } = require(lib('serving/headline-stats-sql'))

// The contract the worker resolves for the source (the code registry).
const contract = getProfileCaptureContract('blofin_spot')
if (!contract) throw new Error('blofin_spot declares no profile capture contract')
const fixtures = join(root, 'lib/ingest/adapters/blofin/__tests__/fixtures')
const recorded = JSON.parse(
  readFileSync(join(fixtures, 'profile-capture-spot-4187422152.json'), 'utf8')
)
const board = JSON.parse(readFileSync(join(fixtures, 'board-spot-30-20261120.json'), 'utf8'))
const sha: string = profileCaptureContractSha256(contract)
const metrics: string[] = profileContractMetrics(contract)
const q = (value: unknown) =>
  value === null || value === undefined ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`
const arr = (values: readonly string[]) => q(`{${values.join(',')}}`)

const SPOT_PREFIX = 'https://blofin.com/sapi/v1/spot_copy/'
async function pages(uid: string, timeframe: number) {
  const api = {
    post: async (url: string, options: { data: Record<string, unknown> }) => {
      // Only the spot route holds the spot account.
      if (!url.startsWith(SPOT_PREFIX)) return { status: () => 404, json: async () => null }
      const key = `${url.slice(SPOT_PREFIX.length)}|${String(options.data.stat_period ?? '')}`
      return { status: () => 200, json: async () => recorded.responses[key] }
    },
  }
  const session = { sourceSlug: 'blofin_spot', api: async () => api, paced: (fn: () => unknown) => fn() }
  return (await blofinAdapter.getProfile(session, { meta: { boardKey: 'spot' } }, uid, timeframe)).pages
}

interface Capture {
  name: string
  traderId: number
  uid: string
  attemptId: string
  raw: number
}

async function main() {
  const now = new Date().toISOString()
  const lines: string[] = []
  writeFileSync(
    join(out, 'prepare.sql'),
    `PREPARE headline(smallint, timestamptz, text, jsonb, smallint, bigint, text) AS ${HEADLINE_STATS_UPSERT_SQL};
PREPARE profile(bigint, smallint, timestamptz, text, numeric, numeric, numeric, numeric,
  numeric, integer, integer, numeric, integer, numeric, numeric, numeric, numeric, jsonb, jsonb,
  boolean, bigint, text[]) AS ${PROFILE_STATS_UPSERT_SQL};\n`
  )
  writeFileSync(
    join(out, 'registry.json'),
    JSON.stringify({
      capture_contract: contract.captureContract,
      contract_sha256: sha,
      timeframes: [...contract.timeframes],
      attestable_metrics: metrics,
    })
  )

  // The recorded spot board page through the parser and the staging bounds:
  // row 0 is the active trader of the recorded capture, row 1 an idle trader
  // whose every board value is the literal "0".
  const { valid } = validateLeaderboardRows(
    parseBlofinLeaderboardPage(board, { sourceSlug: 'blofin_spot', meta: {} }).rows
  )
  const [active, idle] = valid
  if (active.exchangeTraderId !== recorded.uid || idle.headlineMdd !== 0) {
    throw new Error('board fixture drifted')
  }
  const boardRow = (uid: string, row: typeof active, mdd: number | null) => ({
    exchange_trader_id: uid,
    roi: row.headlineRoi,
    pnl: row.headlinePnl,
    win_rate: row.headlineWinRate,
    mdd,
    sharpe: row.headlineSharpe,
    aum: row.headlineAum,
    copier_count: row.headlineCopierCount,
    copier_pnl: null,
    volume: null,
    win_positions: null,
    total_positions: null,
    holding_hours: null,
    extras: null,
  })
  // A later board on which the active drawdown has moved by one point (the
  // board and the profile are fetched at different times).
  const movedMdd = active.headlineMdd + 1
  writeFileSync(
    join(out, 'board.json'),
    JSON.stringify([
      boardRow(recorded.uid, active, active.headlineMdd),
      boardRow(idle.exchangeTraderId, idle, idle.headlineMdd),
      boardRow('1003', active, active.headlineMdd),
    ])
  )
  writeFileSync(
    join(out, 'board-moved.json'),
    JSON.stringify([
      boardRow(recorded.uid, active, movedMdd),
      boardRow(idle.exchangeTraderId, idle, idle.headlineMdd),
      boardRow('1003', active, movedMdd),
    ])
  )

  for (const timeframe of contract.timeframes) {
    if (timeframe === 30) continue
    lines.push(`SELECT arena.start_profile_acquisition_attempt(gen_random_uuid(), 1, 401, ${timeframe},
      ${q(contract.captureContract)}, ${q(sha)}, NULL);`)
  }

  const captures: Capture[] = [
    { name: 'fresh', traderId: 401, uid: recorded.uid, attemptId: '00000000-0000-4000-8000-0000000004a1', raw: 7401 },
    { name: 'healed', traderId: 403, uid: '1003', attemptId: '00000000-0000-4000-8000-0000000004a3', raw: 7403 },
  ]
  let expected: Record<string, unknown> = {}
  for (const capture of captures) {
    const captured = await pages(capture.uid, 30)
    const fixture = runProfileContractFixture({
      contract,
      timeframe: 30,
      pages: captured,
      parseProfile: parseBlofinProfile,
      exchangeTraderId: capture.uid,
      ctx: { sourceSlug: 'blofin_spot', scrapedAt: now },
    })
    const result = buildProfileAcquisition({
      contract,
      contractSha256: sha,
      attemptId: capture.attemptId,
      exchangeTraderId: capture.uid,
      timeframe: 30,
      pages: captured,
      parsed: fixture.parsed,
      stored: fixture.stored,
    })
    if (result.terminalState !== 'complete') {
      throw new Error(`${capture.name}: ${result.terminalState}/${result.reasonCode}`)
    }
    lines.push(`SELECT attempt_seq AS seq_${capture.name} FROM arena.start_profile_acquisition_attempt(
      ${q(capture.attemptId)}, 1, ${capture.traderId}, 30, ${q(contract.captureContract)}, ${q(sha)}, NULL) \\gset`)
    lines.push(`INSERT INTO arena.raw_objects VALUES (${capture.raw}, 1, 'tier_b', ${capture.traderId}, 30,
      clock_timestamp(), 'raw/${capture.raw}', 1, repeat('e', 64), false, jsonb_build_object('profile_capture',
      jsonb_build_object('attempt_id', ${q(capture.attemptId)}, 'capture_contract', ${q(contract.captureContract)})));`)
    lines.push(`SELECT terminal_state FROM arena.finish_profile_acquisition_attempt(:seq_${capture.name},
      ${q(capture.attemptId)}, ${q(result.terminalState)}, ${q(result.reasonCode)}, ${capture.raw},
      ${q(result.sourceRunId)}, ${q(JSON.stringify(result.manifest))}::jsonb);`)
    const s = fixture.stored
    expected = {
      winRate: s.winRate,
      trades: s.totalPositions,
      mdd: s.mdd,
      movedMdd,
      boardMdd: active.headlineMdd,
      metrics: result.attestedMetrics,
    }
    // publishProfile's exact parameter mapping (lib/ingest/serving/publish.ts).
    const params = [
      capture.traderId, s.timeframe, q(s.asOf), "'USDT'", q(s.roi), q(s.pnl), q(s.sharpe), q(s.mdd),
      q(s.winRate), q(s.winPositions), q(s.totalPositions), q(s.copierPnl), q(s.copierCount),
      q(s.aum), q(s.volume), q(s.profitShareRate),
      q(s.holdingDurationAvgHours === null ? null : s.holdingDurationAvgHours * 3600),
      q(s.tradingPreferences ? JSON.stringify(s.tradingPreferences) : null),
      q(JSON.stringify({ ...s.extras, [PROFILE_PUBLICATION_EPOCH_KEY]: Date.parse(s.asOf) })),
      s.extras.fills_metrics_complete === false, `:seq_${capture.name}`, arr(result.attestedMetrics),
    ].join(', ')
    writeFileSync(join(out, `profile-${capture.name}.sql`), `EXECUTE profile(${params});\n`)
  }
  writeFileSync(join(out, 'setup.sql'), lines.join('\n') + '\n')
  writeFileSync(join(out, 'expected.json'), JSON.stringify(expected))
}
main().catch((error) => {
  console.error(error)
  process.exit(1)
})
TS
(cd "$ROOT_DIR" && npx --no-install tsx "$TMP_ROOT/driver.ts" "$ROOT_DIR" "$TMP_ROOT/out")
EXPECTED="$(cat "$TMP_ROOT/out/expected.json")"
REGISTRY_JSON="$(cat "$TMP_ROOT/out/registry.json")"
BOARD_ROWS="$(cat "$TMP_ROOT/out/board.json")"
BOARD_MOVED_ROWS="$(cat "$TMP_ROOT/out/board-moved.json")"
expected_field() {
  node -e 'process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]]))' "$EXPECTED" "$1"
}
node -e '
const e = JSON.parse(process.argv[1])
const ok = e.winRate === 35.29 && e.trades === 17 && e.mdd === e.boardMdd && e.mdd > 14 && e.mdd < 15 &&
  JSON.stringify(e.metrics) === JSON.stringify(["mdd", "total_positions", "win_rate"])
if (!ok) { console.error("driver capture drifted: " + process.argv[1]); process.exit(1) }
' "$EXPECTED"
WIN_RATE="$(expected_field winRate)"
TRADES="$(expected_field trades)"
PROFILE_MDD="$(expected_field mdd)"
MOVED_MDD="$(expected_field movedMdd)"

# ---------------------------------------------------------------------------
# exact: the registered row is the code contract, field by field, and nothing
# else is registered.
# ---------------------------------------------------------------------------
psql_db -v registry="$REGISTRY_JSON" >/dev/null <<'SQL'
SELECT public.proof_assert(
  (SELECT count(*) FROM arena.profile_capture_contracts) = 1
  AND EXISTS (
    SELECT 1
    FROM arena.profile_capture_contracts AS contract
    JOIN arena.sources AS source ON source.id = contract.source_id
    WHERE source.slug = 'blofin_spot'
      AND contract.capture_contract = :'registry'::jsonb->>'capture_contract'
      AND contract.contract_sha256 = :'registry'::jsonb->>'contract_sha256'
      AND contract.timeframes = ARRAY(
        SELECT value::smallint
        FROM jsonb_array_elements_text(:'registry'::jsonb->'timeframes') WITH ORDINALITY AS t(value, ord)
        ORDER BY ord
      )
      AND contract.attestable_metrics = ARRAY(
        SELECT value
        FROM jsonb_array_elements_text(:'registry'::jsonb->'attestable_metrics') WITH ORDINALITY AS m(value, ord)
        ORDER BY ord
      )
  ),
  'the registered row differs from the code contract'
);
SQL

expect_failure_in postgres 'a drifted contract hash cannot start an attempt' \
  'is not registered for source' \
  "SELECT arena.start_profile_acquisition_attempt(gen_random_uuid(), 1, 401, 30,
     'blofin_spot-profile-capture@1', repeat('0', 64), NULL)"

# ---------------------------------------------------------------------------
# refusal: replay, drifted earlier registration, adapter mismatch, missing
# source. Each refuses the whole migration; nothing lands.
# ---------------------------------------------------------------------------
expect_failure_in postgres 'a replay is refused' \
  'source blofin_spot already has a registered profile capture contract' \
  "\\i $MIGRATIONS/$REGISTER"
if [[ "$(registered_count postgres)" != 1 ]]; then
  echo 'a refused replay changed the registry' >&2
  exit 1
fi

clone() {
  psql_admin -c "CREATE DATABASE $1 TEMPLATE pre_registration OWNER postgres"
}

clone drifted
psql_in drifted -c "INSERT INTO arena.profile_capture_contracts
  (source_id, capture_contract, contract_sha256, timeframes, attestable_metrics)
  VALUES (1, 'blofin_spot-profile-capture@1', repeat('b', 64), '{7,30,90}', '{win_rate}')"
expect_failure_in drifted 'an earlier registration with a drifted hash is refused' \
  'source blofin_spot already has a registered profile capture contract' \
  "\\i $MIGRATIONS/$REGISTER"
if [[ "$(registered_count drifted)" != 1 ]]; then
  echo 'a refused registration landed rows next to a drifted one' >&2
  exit 1
fi

clone wrong_adapter
psql_in wrong_adapter -c "UPDATE arena.sources SET adapter_slug = 'blofin_v2' WHERE slug = 'blofin_spot'"
expect_failure_in wrong_adapter 'an adapter mismatch is refused' \
  'profile capture contract source blofin_spot uses adapter blofin_v2, reviewed blofin' \
  "\\i $MIGRATIONS/$REGISTER"

clone missing_source
psql_in missing_source -c "UPDATE arena.sources SET slug = 'blofin_spot_retired' WHERE slug = 'blofin_spot'"
expect_failure_in missing_source 'a missing source is refused' \
  'profile capture contract source blofin_spot does not exist' \
  "\\i $MIGRATIONS/$REGISTER"
for database in wrong_adapter missing_source; do
  if [[ "$(registered_count "$database")" != 0 ]]; then
    echo "a refused registration landed rows in $database" >&2
    exit 1
  fi
done

echo "blofin-spot-profile-capture.pg17: registration ok"

# ---------------------------------------------------------------------------
# Data: blofin_spot with a passed 30D board (attempt-bound run c..., RAW 5011).
#   401  the active trader of the recorded capture
#   402  an idle trader: every board value is the literal "0"
#   403  a row still holding what the futures-route profile crawl left three
#        days ago: trade counts (profile-only columns) and no drawdown
# ---------------------------------------------------------------------------
psql_db -v board_rows="$BOARD_ROWS" >/dev/null <<SQL
INSERT INTO arena.traders (id, source_id, exchange_trader_id, nickname)
SELECT 400 + r.ord, 1, r.item->>'exchange_trader_id', 'trader-' || r.ord
FROM jsonb_array_elements(:'board_rows'::jsonb) WITH ORDINALITY AS r(item, ord);
INSERT INTO arena.leaderboard_snapshots VALUES (11, 1, 30, now() - interval '1 hour', 3, true, 5011);
INSERT INTO arena.leaderboard_acquisition_attempts VALUES (1, 1, 30);
INSERT INTO arena.leaderboard_acquisition_outcomes VALUES (1, repeat('c', 64), 5011);
INSERT INTO arena.leaderboard_entries
  (scraped_at, snapshot_id, trader_id, timeframe, rank, headline_roi, headline_pnl, headline_win_rate)
SELECT s.scraped_at, 11, t.id, 30, t.id - 400, r.roi, r.pnl, r.win_rate
FROM jsonb_to_recordset(:'board_rows'::jsonb) AS r(exchange_trader_id text, roi numeric, pnl numeric, win_rate numeric)
JOIN arena.traders AS t ON t.exchange_trader_id = r.exchange_trader_id
CROSS JOIN arena.leaderboard_snapshots AS s WHERE s.id = 11;
INSERT INTO arena.trader_stats
  (trader_id, timeframe, as_of, roi, pnl, win_rate, mdd, win_positions, total_positions)
VALUES (403, 30, now() - interval '72 hours', 0, 0, NULL, NULL, 0, 0);

\\i $TMP_ROOT/out/prepare.sql
\\i $TMP_ROOT/out/setup.sql
SELECT scraped_at AS board_at FROM arena.leaderboard_snapshots WHERE id = 11 \\gset
EXECUTE headline(30, :'board_at', 'USDT', :'board_rows', 1, 5011, repeat('c', 64));
\\i $TMP_ROOT/out/profile-fresh.sql
SQL

# ---------------------------------------------------------------------------
# Reader @3 after the board write and the Tier-B write of trader 401.
# ---------------------------------------------------------------------------
psql_db -v win_rate="$WIN_RATE" -v trades="$TRADES" -v profile_mdd="$PROFILE_MDD" >/dev/null <<'SQL'
CREATE TEMPORARY TABLE score AS
SELECT r->>'trader_key' AS trader_key, r AS score_row
FROM jsonb_array_elements(arena.publication_score_rows_json('30D', 1000, 48)) AS r;
SELECT public.proof_assert((SELECT count(*) FROM score) = 3, 'expected 3 score rows');

-- 401: the profile supplies the win rate and trade count the board lacks; the
-- drawdown the profile wrote equals the board's, so both attest it.
SELECT public.proof_assert(
  count(*) = 1 AND COALESCE(bool_and(
    (score_row->>'win_rate')::numeric = :'win_rate'::numeric
    AND (score_row->>'trades_count')::int = :'trades'::int
    AND (score_row->>'max_drawdown')::numeric = :'profile_mdd'::numeric
    AND score_row->'roi_pct' <> 'null'::jsonb
    AND score_row->'pnl_usd' <> 'null'::jsonb
    AND NOT score_row->'unevidenced_metrics' ?| ARRAY['win_rate', 'trades_count', 'max_drawdown']
  ), false),
  'profile-attested blofin_spot row drifted: ' || COALESCE(string_agg(score_row::text, ' | '), 'no row')
) FROM score WHERE trader_key = '4187422152';
SELECT public.proof_assert(
  count(*) = 1 AND COALESCE(bool_and(
    profile_evidence_metrics = '{mdd,total_positions,win_rate}' AND 'mdd' = ANY (evidence_metrics)
  ), false),
  'trader 401 attestations drifted: '
    || COALESCE(string_agg(profile_evidence_metrics::text || ' / ' || evidence_metrics::text, ' | '), 'no row')
) FROM arena.trader_stats WHERE trader_id = 401 AND timeframe = 30;

-- 402: the idle trader's board drawdown "0" is published as 0, not NULL. No
-- profile was captured, so there is no win rate.
SELECT public.proof_assert(
  count(*) = 1 AND COALESCE(bool_and(
    score_row->'max_drawdown' <> 'null'::jsonb
    AND (score_row->>'max_drawdown')::numeric = 0
    AND score_row->'win_rate' = 'null'::jsonb
  ), false),
  'idle blofin_spot row drifted: ' || COALESCE(string_agg(score_row::text, ' | '), 'no row')
) FROM score WHERE trader_key <> '4187422152' AND trader_key <> '1003';

-- 403: the board just wrote and attested its drawdown, but the row keeps the
-- old profile-only columns, so its as_of stays three days old and the reader
-- ignores the whole stats row: drawdown and win rate are both NULL.
SELECT public.proof_assert(
  count(*) = 1 AND COALESCE(bool_and(
    mdd IS NOT NULL AND 'mdd' = ANY (evidence_metrics) AND as_of < now() - interval '48 hours'
  ), false),
  'trader 403 fixture drifted'
) FROM arena.trader_stats WHERE trader_id = 403 AND timeframe = 30;
SELECT public.proof_assert(
  count(*) = 1 AND COALESCE(bool_and(
    score_row->'max_drawdown' = 'null'::jsonb AND score_row->'win_rate' = 'null'::jsonb
  ), false),
  'a stats row older than 48h was published: ' || COALESCE(string_agg(score_row::text, ' | '), 'no row')
) FROM score WHERE trader_key = '1003';
SQL

echo "blofin-spot-profile-capture.pg17: reader ok"

# ---------------------------------------------------------------------------
# The next attempt-bound board write (RAW 5012, run d...) on which the active
# drawdown moved: the board re-attests its own value, the profile attestation
# of the replaced drawdown is dropped, win rate and trade count stay attested.
# Then trader 403 gets its first spot capture, written AFTER that board: the
# profile's drawdown replaces the board's, and the profile attests it.
# ---------------------------------------------------------------------------
SEQ_HEALED="$(psql_db -At -c "SELECT attempt_seq FROM arena.profile_acquisition_attempts
  WHERE attempt_id = '00000000-0000-4000-8000-0000000004a3'")"
psql_db -v board_rows="$BOARD_MOVED_ROWS" -v seq_healed="$SEQ_HEALED" >/dev/null <<SQL
INSERT INTO arena.leaderboard_snapshots VALUES (12, 1, 30, now() - interval '5 minutes', 3, true, 5012);
INSERT INTO arena.leaderboard_acquisition_attempts VALUES (2, 1, 30);
INSERT INTO arena.leaderboard_acquisition_outcomes VALUES (2, repeat('d', 64), 5012);
INSERT INTO arena.leaderboard_entries
  (scraped_at, snapshot_id, trader_id, timeframe, rank, headline_roi, headline_pnl, headline_win_rate)
SELECT s.scraped_at, 12, e.trader_id, 30, e.rank, e.headline_roi, e.headline_pnl, e.headline_win_rate
FROM arena.leaderboard_entries AS e CROSS JOIN arena.leaderboard_snapshots AS s
WHERE e.snapshot_id = 11 AND s.id = 12;
\\i $TMP_ROOT/out/prepare.sql
SELECT scraped_at AS board_at FROM arena.leaderboard_snapshots WHERE id = 12 \\gset
EXECUTE headline(30, :'board_at', 'USDT', :'board_rows', 1, 5012, repeat('d', 64));
\\i $TMP_ROOT/out/profile-healed.sql
SQL

psql_db -v win_rate="$WIN_RATE" -v trades="$TRADES" -v profile_mdd="$PROFILE_MDD" \
  -v moved_mdd="$MOVED_MDD" >/dev/null <<'SQL'
CREATE TEMPORARY TABLE score AS
SELECT r->>'trader_key' AS trader_key, r AS score_row
FROM jsonb_array_elements(arena.publication_score_rows_json('30D', 1000, 48)) AS r;

-- 401: drawdown now from the board (the moved value); the four required
-- inputs are all evidenced.
SELECT public.proof_assert(
  count(*) = 1 AND COALESCE(bool_and(
    (score_row->>'win_rate')::numeric = :'win_rate'::numeric
    AND (score_row->>'trades_count')::int = :'trades'::int
    AND (score_row->>'max_drawdown')::numeric = :'moved_mdd'::numeric
    AND score_row->'roi_pct' <> 'null'::jsonb
    AND score_row->'pnl_usd' <> 'null'::jsonb
    AND NOT score_row->'unevidenced_metrics' ?| ARRAY['win_rate', 'trades_count', 'max_drawdown']
  ), false),
  'board-after-profile blofin_spot row drifted: ' || COALESCE(string_agg(score_row::text, ' | '), 'no row')
) FROM score WHERE trader_key = '4187422152';
SELECT public.proof_assert(
  count(*) = 1 AND COALESCE(bool_and(
    profile_evidence_metrics = '{total_positions,win_rate}' AND 'mdd' = ANY (evidence_metrics)
  ), false),
  'trader 401 attestations after the moved board drifted: ' || COALESCE(string_agg(profile_evidence_metrics::text, ' | '), 'no row')
) FROM arena.trader_stats WHERE trader_id = 401 AND timeframe = 30;

-- 403: one spot capture makes the row fresh and complete. Its drawdown is the
-- profile's (the board holds another value), attested by the profile alone:
-- without `mdd` in the contract this drawdown would be unevidenced.
SELECT public.proof_assert(
  count(*) = 1 AND COALESCE(bool_and(
    (score_row->>'win_rate')::numeric = :'win_rate'::numeric
    AND (score_row->>'trades_count')::int = :'trades'::int
    AND (score_row->>'max_drawdown')::numeric = :'profile_mdd'::numeric
    AND score_row->'roi_pct' <> 'null'::jsonb
    AND score_row->'pnl_usd' <> 'null'::jsonb
    AND NOT score_row->'unevidenced_metrics' ?| ARRAY['win_rate', 'trades_count', 'max_drawdown']
  ), false),
  'profile-after-board blofin_spot row drifted: ' || COALESCE(string_agg(score_row::text, ' | '), 'no row')
) FROM score WHERE trader_key = '1003';
SELECT public.proof_assert(
  count(*) = 1 AND COALESCE(bool_and(
    profile_evidence_metrics = '{mdd,total_positions,win_rate}'
    AND NOT ('mdd' = ANY (COALESCE(evidence_metrics, '{}')))
    AND as_of > now() - interval '1 hour'
  ), false),
  'trader 403 attestations drifted: ' || COALESCE(string_agg(profile_evidence_metrics::text, ' | '), 'no row')
) FROM arena.trader_stats WHERE trader_id = 403 AND timeframe = 30;

-- 402: still an evidenced zero.
SELECT public.proof_assert(
  count(*) = 1 AND COALESCE(bool_and(
    (score_row->>'max_drawdown')::numeric = 0
  ), false),
  'idle blofin_spot row drifted: ' || COALESCE(string_agg(score_row::text, ' | '), 'no row')
) FROM score WHERE trader_key <> '4187422152' AND trader_key <> '1003';
SQL

echo "blofin-spot-profile-capture.pg17: board/profile ordering ok"
echo 'blofin_spot profile capture PG17 proof passed'
