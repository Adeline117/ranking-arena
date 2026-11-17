#!/usr/bin/env bash

# PostgreSQL 17 proof for the bybit_copytrade Tier-B profile capture contract
# (lib/ingest/adapters/bybit-copytrade/profile-capture-contract.ts). It owns an
# isolated cluster on a private socket and never connects to application data.
#
# Same chain as profile-acquisition-evidence.pg17.sh (#489 + 20261116215328 +
# 20261116215329). The contract row is registered by this proof only; the real
# registration migration is written at integration.
#
# Everything on the TypeScript side is the production code path: the adapter's
# getProfile (over recorded 2026-06-11 responses), parseBybitCopytradeProfile,
# lastStatsBlock + validateStats, buildProfileAcquisition, the registered
# contract hash, and the exact publishProfile upsert statement.
#
# Proves:
#   - a complete 7/30/90 capture closes its attempt and the writer's stamp
#     survives the trigger's exact stored-value check for pnl, roi, win_rate,
#     mdd, sharpe and sortino (E8 / E4 fixed-point values, no float drift);
#   - publication: the board lacks PnL, the fresh profile capture supplies it,
#     and nothing the capture attests is listed as unevidenced;
#   - refused: a capture of another trader, of another timeframe, an
#     incomplete outcome (trigger and writer), a manifest of another trader on
#     an attempt (ledger), and a stale capture (reader).

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

TMP_ROOT="$(mktemp -d /tmp/profile-capture-bybit-copytrade-pg17.XXXXXX)"
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
psql_db -f "$MIGRATIONS/$READER"

# ---------------------------------------------------------------------------
# TypeScript side: the production capture path over recorded responses.
#   gen.ts <attempt_id> <exchange_trader_id> <timeframe> <complete|empty>
# prints the contract hash, the outcome, the manifest and the exact
# publishProfile parameters ($2..$20) of the stored block.
# ---------------------------------------------------------------------------
GEN="$TMP_ROOT/gen.ts"
cat >"$GEN" <<TS
import { readFileSync } from 'fs'
import { join } from 'path'
import { bybitCopytradeAdapter } from '$ROOT_DIR/lib/ingest/adapters/bybit-copytrade/index'
import { parseBybitCopytradeProfile } from '$ROOT_DIR/lib/ingest/adapters/bybit-copytrade/parsers'
import { buildProfileAcquisition, lastStatsBlock } from '$ROOT_DIR/lib/ingest/profile-capture/capture'
import {
  getProfileCaptureContract,
  profileCaptureContractSha256,
} from '$ROOT_DIR/lib/ingest/profile-capture/contract'
import { validateStats } from '$ROOT_DIR/lib/ingest/staging/validate'
import { PROFILE_PUBLICATION_EPOCH_KEY } from '$ROOT_DIR/lib/ingest/serving/profile-stats-sql'

const FIXTURES = '$ROOT_DIR/lib/ingest/adapters/bybit-copytrade/__tests__/fixtures'
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const [attemptId, mark, tfText, mode] = process.argv.slice(2)
const timeframe = Number(tfText) as 7 | 30 | 90
const contract = getProfileCaptureContract('bybit_copytrade')
if (!contract) throw new Error('bybit_copytrade has no registered profile capture contract')

const respond = (url: string): unknown => {
  if (url.includes('/pub-leader/info')) return fixture('pub-leader-info.json')
  if (url.includes('/leader-income')) return fixture('leader-income.json')
  const tf = url.includes('SEVEN') ? 7 : url.includes('THIRTY') ? 30 : 90
  return fixture('yield-trend-' + tf + '.json')
}
const page = { goto: async () => null, waitForLoadState: async () => undefined }
const session = {
  sourceSlug: 'bybit_copytrade',
  page: async () => page,
  api: async () => { throw new Error('not used') },
  pageFetch: async (template: { url: string }) => ({ status: 200, json: respond(template.url) }),
  capture: async () => { throw new Error('not used') },
  paced: (fn: () => unknown) => fn(),
  saveState: async () => undefined,
  close: async () => undefined,
}
const src = { slug: 'bybit_copytrade', meta: {}, leaderboard_url: null, currency: 'USDT' }

async function main() {
  const pages =
    mode === 'empty'
      ? []
      : (await bybitCopytradeAdapter.getProfile!(session as never, src as never, mark, timeframe)).pages
  const ctx = { sourceSlug: 'bybit_copytrade', currency: 'USDT', tfLabelMap: {},
    scrapedAt: new Date(Date.now() - 60_000).toISOString(), meta: {} }
  const profiles = pages.map((p) => parseBybitCopytradeProfile(p.payload, ctx as never))
  const parsed = lastStatsBlock(profiles, timeframe)?.block ?? null
  const stored = parsed === null ? null : (validateStats([parsed], []).valid[0] ?? null)
  const sha = profileCaptureContractSha256(contract!)
  const result = buildProfileAcquisition({ contract: contract!, contractSha256: sha, attemptId,
    exchangeTraderId: mark, timeframe, pages, parsed, stored })
  const lit = (v: unknown): string =>
    v === null || v === undefined ? 'NULL'
      : typeof v === 'number' || typeof v === 'boolean' ? String(v)
      : "'" + String(v).split("'").join("''") + "'"
  const s = stored ?? parsed
  const params = s === null ? null : [
    s.timeframe, s.asOf, 'USDT', s.roi, s.pnl, s.sharpe, s.mdd, s.winRate, s.winPositions,
    s.totalPositions, s.copierPnl, s.copierCount, s.aum, s.volume, s.profitShareRate,
    s.holdingDurationAvgHours === null ? null : s.holdingDurationAvgHours * 3600,
    s.tradingPreferences ? JSON.stringify(s.tradingPreferences) : null,
    JSON.stringify({ ...s.extras, [PROFILE_PUBLICATION_EPOCH_KEY]: Date.parse(s.asOf) }),
    s.extras.fills_metrics_complete === false,
  ].map(lit).join(', ')
  process.stdout.write(JSON.stringify({
    sha, terminal: result.terminalState, reason: result.reasonCode ?? null,
    run: result.sourceRunId ?? null, manifest: result.manifest ?? null,
    metrics: '{' + (result.attestedMetrics ?? []).join(',') + '}', params,
  }))
}
main().catch((error) => { console.error(error); process.exit(1) })
TS

gen() { (cd "$ROOT_DIR" && npx --no-install tsx "$GEN" "$@"); }
field() { node -e 'const v = JSON.parse(process.argv[1])[process.argv[2]]; process.stdout.write(v === null ? "" : typeof v === "string" ? v : JSON.stringify(v))' "$1" "$2"; }

MARK='S9LoGlRC6qFD5thjUyzWrQ=='
REGISTERED_SHA="$(field "$(gen 00000000-0000-4000-8000-000000000000 "$MARK" 90 complete)" sha)"
UPSERT_SQL="$(node -e '
const s = require("fs").readFileSync(process.argv[1], "utf8")
const key = s.match(/PROFILE_PUBLICATION_EPOCH_KEY = \x27([^\x27]+)\x27/)
const m = s.match(/PROFILE_STATS_UPSERT_SQL = `([\s\S]*?)`/)
if (!key || !m) { console.error("profile stats SQL not found"); process.exit(1) }
process.stdout.write(m[1].split("${PROFILE_PUBLICATION_EPOCH_KEY}").join(key[1]))
' "$WRITER_MODULE")"
PREPARE="PREPARE profile_upsert(bigint, smallint, timestamptz, text, numeric, numeric, numeric,
  numeric, numeric, integer, integer, numeric, integer, numeric, numeric, numeric, numeric, jsonb,
  jsonb, boolean, bigint, text[]) AS $UPSERT_SQL;"

# ---------------------------------------------------------------------------
# Data: bybit_copytrade 90D board without a PnL column (headline_pnl NULL).
# ---------------------------------------------------------------------------
psql_db -v sha="$REGISTERED_SHA" -v mark="$MARK" <<'SQL'
INSERT INTO arena.sources (id, slug, adapter_slug, status, serving_mode, timeframes_native) VALUES
  (3, 'bybit_copytrade', 'bybit_copytrade', 'active', 'serving', '{7,30,90}');
INSERT INTO arena.traders (id, source_id, exchange_trader_id, nickname) VALUES
  (301, 3, :'mark', 'Own'),
  (302, 3, 'stale-mark', 'Stale'),
  (303, 3, 'wrong-tf-mark', 'WrongTf'),
  (304, 3, 'incomplete-mark', 'Incomplete'),
  (305, 3, 'other-mark', 'OtherTrader');
INSERT INTO arena.leaderboard_snapshots VALUES
  (31, 3, 90, now() - interval '1 hour', 5, true, 6011);
INSERT INTO arena.leaderboard_entries
  (scraped_at, snapshot_id, trader_id, timeframe, rank, headline_roi, headline_pnl, headline_win_rate)
SELECT s.scraped_at, 31, t.id, 90, t.id - 300, -28.62, NULL, 14.04
FROM arena.traders AS t CROSS JOIN arena.leaderboard_snapshots AS s
WHERE t.source_id = 3 AND s.id = 31;
INSERT INTO arena.leaderboard_acquisition_attempts VALUES (31, 3, 90);
INSERT INTO arena.leaderboard_acquisition_outcomes VALUES (31, repeat('d', 64), 6011);

-- What the integration migration registers, with the code's contract hash.
INSERT INTO arena.profile_capture_contracts
  (source_id, capture_contract, contract_sha256, timeframes, attestable_metrics)
VALUES (3, 'bybit_copytrade-profile-capture@1', :'sha', '{7,30,90}',
        '{roi,pnl,win_rate,mdd,sharpe,sortino}');
CREATE TABLE public.seqs (name text PRIMARY KEY, seq bigint NOT NULL);
CREATE SEQUENCE public.raw_ids START 8001;
SQL

# capture <name> <trader_id> <exchange_trader_id> <timeframe> <complete|empty> [manifest_trader]
# Runs one worker attempt through the RPCs; prints the generator JSON.
capture() {
  local name="$1" trader="$2" ext="$3" tf="$4" mode="$5" manifest_ext="${6:-$3}"
  local attempt_id json seq RAW_ID
  attempt_id="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
  RAW_ID="$(psql_db -At -c "SELECT nextval('public.raw_ids')")"
  seq="$(psql_db -At -v sha="$REGISTERED_SHA" -v id="$attempt_id" <<SQL
SELECT attempt_seq FROM arena.start_profile_acquisition_attempt(
  :'id', 3, $trader, $tf, 'bybit_copytrade-profile-capture@1', :'sha', NULL);
SQL
)"
  json="$(gen "$attempt_id" "$manifest_ext" "$tf" "$mode")"
  psql_db -v id="$attempt_id" >/dev/null <<SQL
INSERT INTO arena.raw_objects VALUES ($RAW_ID, 3, 'tier_b', $trader, $tf, clock_timestamp(),
  'raw/$RAW_ID', 1, repeat('e', 64), false, jsonb_build_object('profile_capture',
  jsonb_build_object('attempt_id', :'id', 'capture_contract', 'bybit_copytrade-profile-capture@1')));
INSERT INTO public.seqs VALUES ('$name', $seq);
SQL
  if [[ "$(field "$json" terminal)" == complete ]]; then
    psql_db -v id="$attempt_id" -v run="$(field "$json" run)" -v manifest="$(field "$json" manifest)" >/dev/null <<SQL
SELECT arena.finish_profile_acquisition_attempt($seq, :'id', 'complete', NULL, $RAW_ID,
  :'run', :'manifest'::jsonb);
SQL
    # (errexit is off when a caller tests this function; fail explicitly)
    [[ $? -eq 0 ]] || return 1
  else
    psql_db -v id="$attempt_id" -v state="$(field "$json" terminal)" -v reason="$(field "$json" reason)" >/dev/null <<SQL
SELECT arena.finish_profile_acquisition_attempt($seq, :'id', :'state', :'reason', $RAW_ID, NULL, NULL);
SQL
  fi
  printf '%s' "$json"
}

# publish <trader_id> <generator json> <seq|NULL> <metrics|NULL>: the exact
# publishProfile statement with the stored block's parameters.
publish() {
  psql_db -c "$PREPARE" -c "EXECUTE profile_upsert($1, $(field "$2" params), $3, $4)" >/dev/null
}

# ---------------------------------------------------------------------------
# Positive: every contracted window attests the five exchange values.
# ---------------------------------------------------------------------------
for tf in 7 30 90; do
  json="$(capture "own-$tf" 301 "$MARK" "$tf" complete)"
  if [[ "$(field "$json" metrics)" != '{mdd,pnl,roi,sharpe,sortino,win_rate}' ]]; then
    echo "own $tf: capture attested $(field "$json" metrics)" >&2
    exit 1
  fi
  seq="$(psql_db -At -c "SELECT seq FROM public.seqs WHERE name = 'own-$tf'")"
  publish 301 "$json" "$seq" "'$(field "$json" metrics)'"
  got="$(psql_db -At -c "SELECT profile_evidence_metrics FROM arena.trader_stats
    WHERE trader_id = 301 AND timeframe = $tf")"
  if [[ "$got" != '{mdd,pnl,roi,sharpe,sortino,win_rate}' ]]; then
    echo "own $tf: the trigger kept $got of the attested values" >&2
    exit 1
  fi
done
OWN_JSON="$json"
echo "profile-capture-bybit-copytrade.pg17: complete captures attest pnl, roi, win_rate, mdd, sharpe, sortino"

# ---------------------------------------------------------------------------
# Negative.
# ---------------------------------------------------------------------------
# Ledger: a manifest of another trader cannot close this trader's attempt.
if capture mixed 305 other-mark 90 complete "$MARK" >/dev/null 2>&1; then
  echo 'a manifest of another trader closed the attempt' >&2
  exit 1
fi

# Wrong trader: trader 305 cannot carry trader 301's capture.
OTHER_JSON="$(capture other 305 other-mark 90 complete)"
OWN90="$(psql_db -At -c "SELECT seq FROM public.seqs WHERE name = 'own-90'")"
publish 305 "$OTHER_JSON" NULL NULL
expect_failure 'a capture of another trader is refused' 'is not a complete capture' \
  "$PREPARE EXECUTE profile_upsert(305, $(field "$OTHER_JSON" params), $OWN90, '{pnl}')"

# Wrong timeframe: a complete 30D capture cannot attest the 90D row.
WRONG_TF_30="$(capture wrong-tf-30 303 wrong-tf-mark 30 complete)"
WRONG_TF_90="$(gen 00000000-0000-4000-8000-000000000000 wrong-tf-mark 90 complete)"
publish 303 "$WRONG_TF_90" NULL NULL
WRONG_TF_SEQ="$(psql_db -At -c "SELECT seq FROM public.seqs WHERE name = 'wrong-tf-30'")"
expect_failure 'a capture of another timeframe is refused' 'is not a complete capture' \
  "$PREPARE EXECUTE profile_upsert(303, $(field "$WRONG_TF_90" params), $WRONG_TF_SEQ, '{pnl}')"

# Incomplete: no profile page means partial/endpoint_missing, no manifest.
INCOMPLETE="$(capture incomplete 304 incomplete-mark 90 empty)"
if [[ "$(field "$INCOMPLETE" terminal)/$(field "$INCOMPLETE" reason)" != partial/endpoint_missing ]]; then
  echo "an empty capture ended $(field "$INCOMPLETE" terminal)/$(field "$INCOMPLETE" reason)" >&2
  exit 1
fi
INCOMPLETE_SEQ="$(psql_db -At -c "SELECT seq FROM public.seqs WHERE name = 'incomplete'")"
publish 304 "$WRONG_TF_90" NULL NULL
expect_failure 'an incomplete capture is refused' 'is not a complete capture' \
  "$PREPARE EXECUTE profile_upsert(304, $(field "$WRONG_TF_90" params), $INCOMPLETE_SEQ, '{pnl}')"

# Stale: a valid capture whose attempt began 3 days ago (fixture-only
# rewrite of the database-owned start time).
STALE_JSON="$(capture stale 302 stale-mark 90 complete)"
STALE_SEQ="$(psql_db -At -c "SELECT seq FROM public.seqs WHERE name = 'stale'")"
publish 302 "$STALE_JSON" "$STALE_SEQ" "'$(field "$STALE_JSON" metrics)'"
psql_db <<'SQL'
SET session_replication_role = replica;
UPDATE arena.profile_acquisition_attempts SET recorded_started_at = now() - interval '72 hours'
WHERE attempt_seq = (SELECT seq FROM public.seqs WHERE name = 'stale');
SET session_replication_role = origin;
SQL
echo "profile-capture-bybit-copytrade.pg17: ledger and trigger refusals ok"

# ---------------------------------------------------------------------------
# Publication (@3).
# ---------------------------------------------------------------------------
psql_db <<'SQL'
DO $proof$
DECLARE
  v_rows jsonb := arena.publication_score_rows_json('90D', 1000, 48);
  v_row jsonb;
BEGIN
  IF jsonb_array_length(v_rows) <> 5 THEN
    RAISE EXCEPTION 'unexpected rows: %', v_rows;
  END IF;

  -- The board has no PnL; the fresh capture supplies it and every value it
  -- attested. Unevidenced stay the parser's win+loss sum and the
  -- (unattested, info-or-income) copier count.
  SELECT r INTO STRICT v_row FROM jsonb_array_elements(v_rows) AS r
  WHERE r->>'trader_key' = 'S9LoGlRC6qFD5thjUyzWrQ==';
  IF (v_row->>'pnl_usd')::numeric <> -356.53843916
     OR (v_row->>'roi_pct')::numeric <> -28.62
     OR (v_row->>'win_rate')::numeric <> 14.04
     OR (v_row->>'max_drawdown')::numeric <> 59.37
     OR (v_row->>'sharpe_ratio')::numeric <> -0.4258
     OR (v_row->>'sortino_ratio')::numeric <> -0.6647
     OR v_row->'unevidenced_metrics' <> '["copiers", "trades_count"]'::jsonb
     OR (v_row->>'as_of')::timestamptz >
        (SELECT recorded_started_at FROM arena.profile_acquisition_attempts
         WHERE attempt_seq = (SELECT seq FROM public.seqs WHERE name = 'own-90')) THEN
    RAISE EXCEPTION 'the attested bybit row drifted: %', v_row;
  END IF;

  -- Stale capture, wrong-timeframe capture, incomplete capture and the other
  -- trader's unattested write: no PnL, no drawdown, both named.
  FOR v_row IN
    SELECT r FROM jsonb_array_elements(v_rows) AS r
    WHERE r->>'trader_key' IN ('stale-mark', 'wrong-tf-mark', 'incomplete-mark', 'other-mark')
  LOOP
    IF v_row->'pnl_usd' <> 'null'::jsonb OR v_row->'max_drawdown' <> 'null'::jsonb
       OR NOT (v_row->'unevidenced_metrics' @> '["pnl_usd", "max_drawdown"]'::jsonb) THEN
      RAISE EXCEPTION 'a refused capture was published: %', v_row;
    END IF;
  END LOOP;
END
$proof$;
SQL

echo "profile-capture-bybit-copytrade.pg17: publication ok"
