#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the verified position-history authority.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PREREQUISITE_MIGRATION="$ROOT_DIR/supabase/migrations/20260803195000_verified_position_history_raw_prerequisites.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260803200000_verified_position_history_publication_authority.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql createdb; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi
if [[ ! -f "$PREREQUISITE_MIGRATION" || ! -f "$MIGRATION" ]]; then
  echo "Migration pair not found: $PREREQUISITE_MIGRATION / $MIGRATION" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/verified-position-history-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((62000 + ($$ % 1500)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    echo "[verified-position-history] PostgreSQL log tail:" >&2
    tail -160 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

owner_psql() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

admin_psql() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U cluster_admin -d postgres "$@"
}

admin_psql_db() {
  local database="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U cluster_admin -d "$database" "$@"
}

owner_psql_db() {
  local database="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d "$database" "$@"
}

api_psql() {
  local role="$1"
  shift
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U authenticator -d postgres \
    -c "SET ROLE $role; $*"
}

expect_failure_contains() {
  local label="$1"
  local needle="$2"
  local sql="$3"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if owner_psql -v VERBOSITY=verbose -c "$sql" >"$failure_log" 2>&1; then
    echo "[verified-position-history] expected owner failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[verified-position-history] unexpected owner failure: $label" >&2
    sed -n '1,160p' "$failure_log" >&2
    exit 1
  fi
}

expect_api_failure_contains() {
  local label="$1"
  local role="$2"
  local needle="$3"
  local sql="$4"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if api_psql "$role" "$sql" >"$failure_log" 2>&1; then
    echo "[verified-position-history] expected API failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[verified-position-history] unexpected API failure: $label" >&2
    sed -n '1,160p' "$failure_log" >&2
    exit 1
  fi
}

expect_api_failure_sqlstate_contains() {
  local label="$1"
  local role="$2"
  local sqlstate="$3"
  local needle="$4"
  local sql="$5"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -h "$SOCKET_DIR" -p "$PORT" -U authenticator -d postgres \
    -c "SET ROLE $role; $sql" >"$failure_log" 2>&1; then
    echo "[verified-position-history] expected API failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "ERROR:  $sqlstate:" "$failure_log" \
     || ! grep -Fq "$needle" "$failure_log"; then
    echo "[verified-position-history] unexpected API failure: $label" >&2
    sed -n '1,160p' "$failure_log" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth=trust --username=cluster_admin >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -k $SOCKET_DIR -p $PORT" -w start >/dev/null

admin_psql -q <<'SQL'
CREATE ROLE postgres LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
GRANT anon, authenticated, service_role TO authenticator;
ALTER DATABASE postgres OWNER TO postgres;
ALTER SCHEMA public OWNER TO postgres;
SQL

owner_psql -q <<'SQL'
CREATE SCHEMA extensions AUTHORIZATION postgres;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA arena AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA arena TO anon, authenticated, service_role;

CREATE TABLE arena.sources (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  adapter_slug text NOT NULL,
  currency text NOT NULL
);
CREATE TABLE arena.traders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  UNIQUE (source_id, exchange_trader_id)
);
CREATE TABLE arena.raw_objects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  job_type text NOT NULL,
  trader_id bigint,
  timeframe smallint,
  fetched_at timestamptz NOT NULL,
  storage_path text NOT NULL UNIQUE,
  bytes integer NOT NULL,
  content_hash text NOT NULL,
  quarantined boolean NOT NULL DEFAULT false,
  meta jsonb NOT NULL DEFAULT '{}'
);
CREATE TABLE arena.position_history (
  trader_id bigint NOT NULL REFERENCES arena.traders(id),
  opened_at timestamptz,
  closed_at timestamptz,
  symbol text NOT NULL,
  side text,
  leverage numeric,
  size numeric,
  entry_price numeric,
  exit_price numeric,
  realized_pnl numeric,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb
) PARTITION BY RANGE (closed_at);
CREATE UNIQUE INDEX uq_arena_position_history_dedupe
  ON arena.position_history (closed_at, dedupe_hash);
CREATE TABLE arena.position_history_default
  PARTITION OF arena.position_history DEFAULT;
CREATE TABLE arena.positions_current (
  trader_id bigint NOT NULL,
  snapshot_at timestamptz NOT NULL,
  as_of timestamptz NOT NULL,
  symbol text NOT NULL,
  side text,
  leverage numeric,
  size numeric,
  entry_price numeric,
  mark_price numeric,
  unrealized_pnl numeric,
  currency text NOT NULL,
  raw jsonb
);
CREATE TABLE arena.order_records (
  trader_id bigint NOT NULL,
  ts timestamptz NOT NULL,
  kind text,
  symbol text,
  side text,
  price numeric,
  qty numeric,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb
);
CREATE TABLE arena.transfer_history (
  trader_id bigint NOT NULL,
  ts timestamptz NOT NULL,
  direction text,
  asset text,
  amount numeric,
  currency text NOT NULL,
  dedupe_hash text NOT NULL,
  raw jsonb
);

ALTER TABLE arena.position_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read position_history" ON arena.position_history
  FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON arena.position_history TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA arena TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA arena TO service_role;
GRANT SELECT ON arena.sources, arena.traders TO anon, authenticated;

CREATE FUNCTION arena.jnum(value text)
RETURNS numeric LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT CASE WHEN value ~ '^-?[0-9]+(\.[0-9]+)?$' THEN value::numeric END $$;
CREATE FUNCTION arena.jmargin_mode(value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$ SELECT value->>'marginType' $$;

CREATE FUNCTION public.arena_records_page(
  p_source text,
  p_trader text,
  p_kind text,
  p_tf integer DEFAULT NULL,
  p_cursor text DEFAULT NULL,
  p_limit integer DEFAULT 50
) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$ SELECT '{}'::jsonb $$;

CREATE MATERIALIZED VIEW arena.mv_source_capabilities AS
SELECT source_row.slug,
       jsonb_build_object(
         'currency', source_row.currency,
         'surfaces', jsonb_build_object(
           'orders', true,
           'position_history', EXISTS (
             SELECT 1
             FROM arena.traders AS capability_trader
             JOIN arena.position_history AS capability_history
               ON capability_history.trader_id = capability_trader.id
             WHERE capability_trader.source_id = source_row.id
           ),
           'positions', true,
           'transfers', true
         )
       ) AS cap
FROM arena.sources AS source_row;

CREATE FUNCTION public.arena_source_capabilities()
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(jsonb_object_agg(slug, cap), '{}'::jsonb)
  FROM arena.mv_source_capabilities
$$;
GRANT EXECUTE ON FUNCTION public.arena_records_page(
  text, text, text, integer, text, integer
) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.arena_source_capabilities()
  TO anon, authenticated;

INSERT INTO arena.sources (id, slug, adapter_slug, currency)
OVERRIDING SYSTEM VALUE VALUES
  (7, 'bitget_futures', 'bitget', 'USDT'),
  (8, 'binance_futures', 'binance', 'USDT'),
  (9, 'okx_futures', 'okx', 'USDT');
INSERT INTO arena.traders (id, source_id, exchange_trader_id)
OVERRIDING SYSTEM VALUE VALUES
  (41, 7, 'leader-1'),
  (42, 8, 'portfolio-1'),
  (43, 9, 'okx-leader'),
  (44, 7, 'empty-leader'),
  (45, 7, 'clock-rollover-leader'),
  (46, 7, 'leader|pipe');
INSERT INTO arena.position_history (
  trader_id, opened_at, closed_at, symbol, side, leverage, size,
  entry_price, exit_price, realized_pnl, currency, dedupe_hash, raw
) VALUES (
  41, '2026-06-01T00:00:00Z', '2026-06-02T00:00:00Z',
  'LEGACY', 'long', 1, 1, 1, 1, 999, 'USDT',
  '1111111111111111111111111111111111111111',
  '{
    "closingValue":"456.5",
    "legacy":true,
    "marginType":"cross",
    "maxOpenInterest":"12.5",
    "roi":"7.25"
  }'
);
REFRESH MATERIALIZED VIEW arena.mv_source_capabilities;
SQL

# Main installation is impossible without the separately committed RAW
# admission boundary.
"$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -U cluster_admin \
  -T postgres verified_history_missing_prep
MISSING_PREP_LOG="$TMP_ROOT/missing-prep.log"
if owner_psql_db verified_history_missing_prep \
  -f "$MIGRATION" >"$MISSING_PREP_LOG" 2>&1; then
  echo "[verified-position-history] main migration ran without prerequisite" >&2
  exit 1
fi
grep -Fq 'requires PG17, the Arena serving/RAW foundations' "$MISSING_PREP_LOG"

# Cutover preflight remains fail-closed on a drifted SECURITY DEFINER owner.
"$PG_BIN/createdb" -h "$SOCKET_DIR" -p "$PORT" -U cluster_admin \
  -T postgres verified_history_drift
owner_psql_db verified_history_drift -q -f "$PREREQUISITE_MIGRATION"
admin_psql_db verified_history_drift -q \
  -c 'ALTER FUNCTION public.arena_records_page(text,text,text,integer,text,integer) OWNER TO service_role'
DRIFT_LOG="$TMP_ROOT/drift.log"
if owner_psql_db verified_history_drift -f "$MIGRATION" >"$DRIFT_LOG" 2>&1; then
  echo "[verified-position-history] drifted baseline unexpectedly migrated" >&2
  exit 1
fi
grep -Fq 'record or capability RPC owner/security contract drifted' "$DRIFT_LOG"

owner_psql -q -f "$PREREQUISITE_MIGRATION"
owner_psql -q -f "$MIGRATION"

# Non-evidence RAW retains the pre-existing service workflow after installing
# the ALWAYS guards. The same role cannot touch the private admission ledger.
api_psql service_role \
  "INSERT INTO arena.raw_objects (
     id,source_id,job_type,trader_id,timeframe,fetched_at,storage_path,bytes,
     content_hash,quarantined,meta
   ) OVERRIDING SYSTEM VALUE VALUES (
     991,7,'profile',41,NULL,statement_timestamp(),'ordinary.json.gz',1,
     repeat('8',64),false,'{}'
   ); UPDATE arena.raw_objects SET bytes=2 WHERE id=991;
   DELETE FROM arena.raw_objects WHERE id=991;"
expect_api_failure_contains admission_ledger_private service_role \
  'permission denied' \
  'INSERT INTO arena.position_history_raw_admissions(raw_object_id) VALUES (1)'

expect_failure_contains direct_admission_attack \
  'position-history RAW admission requires its guarded INSERT transaction' \
  "INSERT INTO arena.position_history_raw_admissions (
     raw_object_id,source_id,job_type,trader_id,timeframe,fetched_at,
     storage_path,bytes,content_hash,source_run_id,source_slug,
     exchange_trader_id,raw_meta_sha256,raw_snapshot_sha256,
     admitted_transaction_id,admitted_at
   ) VALUES (
     999,7,'history:position_history',41,NULL,statement_timestamp(),
     'forged',1,repeat('f',64),repeat('f',64),'bitget_futures','leader-1',
     repeat('f',64),repeat('e',64),pg_current_xact_id(),statement_timestamp()
   )"

if rg -q 'v_max_evidence_time|v_(observed_at|page_fetched_at|closed_at) > v_now' \
  "$MIGRATION"; then
  echo "[verified-position-history] publisher wall-clock acceptance returned" >&2
  exit 1
fi

FIXTURE_JSON="$TMP_ROOT/fixtures.json"
CONTINUATION_JSON="$TMP_ROOT/continuation.json"
OKX_REGRESSION_JSON="$TMP_ROOT/okx-regression.json"
ROLLOVER_JSON="$TMP_ROOT/clock-rollover.json"
VECTORS_TSV="$TMP_ROOT/canonical-vectors.tsv"
EXPORTER="$TMP_ROOT/export-fixtures.ts"

cat >"$EXPORTER" <<'TS'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

async function main() {
  const root = process.env.REPO_ROOT
  if (!root) throw new Error('REPO_ROOT is required')
  const load = (relative) => import(pathToFileURL(join(root, relative)).href)
  const [
    acquisitionModule,
    reviewedModule,
    verifiedModule,
    canonicalModule,
    binanceContractModule,
    binanceTerminalModule,
    bitgetTerminalModule,
    okxTerminalModule,
  ] = await Promise.all([
    load('lib/ingest/history-acquisition.ts'),
    load('lib/ingest/reviewed-position-history.ts'),
    load('lib/ingest/verified-position-history.ts'),
    load('lib/ingest/strict-canonical-json.ts'),
    load('lib/ingest/adapters/binance/history-contract.ts'),
    load('lib/ingest/adapters/binance/history-terminal.ts'),
    load('lib/ingest/adapters/bitget/history-terminal.ts'),
    load('lib/ingest/adapters/okx/history-terminal.ts'),
  ])

  const { captureHistoryAcquisition, HISTORY_TERMINAL_CLAIM_CONTRACT } =
    acquisitionModule
  const {
    buildReviewedPositionHistoryEvidence,
    positionHistoryPublicationRawMeta,
    REVIEWED_POSITION_HISTORY_CONTRACTS,
  } = reviewedModule
  const {
    prepareVerifiedPositionHistoryPublication,
    prepareVerifiedPositionHistoryRpcCall,
    validateVerifiedPositionHistoryPublicationReceipt,
  } = verifiedModule
  const { strictCanonicalJson } = canonicalModule
  const {
    BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
    BINANCE_POSITION_HISTORY_URL,
  } = binanceContractModule
  const { binancePositionHistoryTerminalVerifier } = binanceTerminalModule
  const {
    BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
    BITGET_POSITION_HISTORY_URL,
    bitgetPositionHistoryTerminalVerifier,
  } = bitgetTerminalModule
  const { okxPositionHistoryTerminalVerifier } = okxTerminalModule

  const sha256 = (text) =>
    createHash('sha256').update(text, 'utf8').digest('hex')
  const attemptStartedAt = '2026-08-03T08:00:00.000Z'

  async function capture(
    source,
    traderId,
    exchangeTraderId,
    cursor,
    pages,
    observations,
    terminalVerifier,
    attempt = attemptStartedAt
  ) {
    async function* stream() {
      for (const page of pages) yield page
      return {
        contract: HISTORY_TERMINAL_CLAIM_CONTRACT,
        observations,
      }
    }
    return captureHistoryAcquisition({
      source,
      traderId,
      exchangeTraderId,
      kind: 'position_history',
      cursor,
      attemptStartedAt: attempt,
      stream: stream(),
      terminalVerifier,
    })
  }

  const preparedByName = new Map()
  function fixture(name, captured, source, rawObjectId, previousPublicationId) {
    const evidence = buildReviewedPositionHistoryEvidence(
      captured.artifact,
      captured.sourceRunId
    )
    const storagePath =
      source.slug +
      '/history_trust/position_history/' +
      captured.sourceRunId +
      '/event_history_' +
      captured.sourceRunId +
      '.json.gz'
    const prepared = prepareVerifiedPositionHistoryPublication({
      acquisition: captured.artifact,
      previousPublicationId,
      rawObject: {
        id: rawObjectId,
        storagePath,
        contentHash: captured.sourceRunId,
      },
      rows: evidence.canonicalRows,
      source,
      sourceRunId: captured.sourceRunId,
    })
    const call = prepareVerifiedPositionHistoryRpcCall(prepared)
    const rawIntegrity = {
      version: 1,
      content_type: 'application/json',
      encoding: 'utf-8',
      compression: 'gzip',
      hash_algorithm: 'sha256',
      hash_scope: 'json_utf8',
      serialization_contract: 'arena.strict-canonical-json@1',
      compressed_bytes: 321,
      uncompressed_bytes: Buffer.byteLength(
        strictCanonicalJson(captured.artifact),
        'utf8'
      ),
    }
    const meta = positionHistoryPublicationRawMeta(evidence, rawIntegrity)
    preparedByName.set(name, prepared)
    return {
      rawObjectId,
      sourceId: source.id,
      traderId: captured.artifact.trader.id,
      sourceSlug: source.slug,
      sourceRunId: captured.sourceRunId,
      observedAt: evidence.observedAt,
      storagePath,
      meta,
      payloadText: call.values[3],
      publicationSha256: prepared.publicationSha256,
      bindingSetSha256: prepared.bindingSetSha256,
      rows: prepared.rows,
    }
  }

  function bitgetRaw(overrides = {}) {
    return {
      orderNo: 'order-1',
      openTime: String(Date.parse('2026-08-03T08:00:00.000Z')),
      closeTime: String(Date.parse('2026-08-03T09:00:00.000Z')),
      symbolDisplayName: 'BTCUSDT',
      position: 1,
      openLevel: '5',
      closeDealCount: '2',
      openAvgPrice: '100',
      closeAvgPrice: '110',
      netProfit: '20',
      returnRate: '-59.55',
      marginMode: 2,
      tokenId: 'USDT',
      ...overrides,
    }
  }

  async function bitgetFixture(
    name,
    rawObjectId,
    traderId,
    exchangeTraderId,
    rows,
    fetchedAt,
    cursor,
    previousPublicationId,
    attempt
  ) {
    const captured = await capture(
      { id: 7, slug: 'bitget_futures' },
      traderId,
      exchangeTraderId,
      cursor,
      [
        {
          pageIndex: 1,
          url: BITGET_POSITION_HISTORY_URL,
          fetchedAt,
          payload: {
            contract: BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
            historyTraderIdentity: exchangeTraderId,
            request: {
              pageNo: 1,
              pageSize: 20,
              traderUid: exchangeTraderId,
            },
            response: {
              code: '00000',
              data: { rows, nextFlag: false },
            },
          },
        },
      ],
      [{ segment_id: 'default', reason: 'reported_end', page_ordinal: 1 }],
      bitgetPositionHistoryTerminalVerifier,
      attempt
    )
    return fixture(
      name,
      captured,
      { id: 7, slug: 'bitget_futures', adapter_slug: 'bitget' },
      rawObjectId,
      previousPublicationId
    )
  }

  const bitget = await bitgetFixture(
    'bitget',
    501,
    41,
    'leader-1',
    [
      bitgetRaw(),
      bitgetRaw({
        orderNo: 'order-2',
        openTime: String(Date.parse('2026-08-03T07:00:00.000Z')),
        closeTime: String(Date.parse('2026-08-03T08:30:00.000Z')),
        symbolDisplayName: null,
        productCode: 'ETHUSDT',
        position: null,
        holdSide: '2',
        openLevel: '1e-7',
        closeDealCount: null,
        openDealCount: '0.000001',
        openAvgPrice: '100000000000000000000',
        closeAvgPrice: '1e21',
        netProfit: '-62084184550925700',
        returnRate: '-1.2345678901234567',
      }),
    ],
    '2026-08-03T10:00:00.000Z',
    null,
    null,
    attemptStartedAt
  )

  const binanceRaw = {
    id: Date.parse('2026-08-03T08:45:00.000Z'),
    type: 'UM',
    symbol: 'ETHUSDT',
    side: 'Long',
    status: 'All Closed',
    opened: Date.parse('2026-08-03T08:45:00.000Z'),
    closed: Date.parse('2026-08-03T09:15:00.000Z'),
    leverage: '5',
    closedVolume: '2',
    avgCost: '100',
    avgClosePrice: '110',
    closingPnl: '20',
    roi: '0.23571614',
    isolated: 'Cross',
    maxOpenInterest: '40',
    closingValue: '220',
  }
  const binancePage = (sort, fetchedAt) => ({
    pageIndex: 1,
    url: BINANCE_POSITION_HISTORY_URL,
    fetchedAt,
    payload: {
      contract: BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
      portfolioId: 'portfolio-1',
      request: {
        pageNumber: 1,
        pageSize: 50,
        portfolioId: 'portfolio-1',
        sort,
      },
      response: {
        code: '000000',
        success: true,
        data: { list: [binanceRaw], total: 1 },
      },
      sort,
    },
  })
  const binanceCaptured = await capture(
    { id: 8, slug: 'binance_futures' },
    42,
    'portfolio-1',
    null,
    [
      binancePage('CLOSING', '2026-08-03T10:01:00.000Z'),
      binancePage('OPENING', '2026-08-03T10:02:00.000Z'),
    ],
    [
      { segment_id: 'closing', reason: 'reported_end', page_ordinal: 1 },
      { segment_id: 'opening', reason: 'reported_end', page_ordinal: 2 },
    ],
    binancePositionHistoryTerminalVerifier
  )
  const binance = fixture(
    'binance',
    binanceCaptured,
    { id: 8, slug: 'binance_futures', adapter_slug: 'binance' },
    502,
    null
  )
  const binanceEmptyPageCaptured = await capture(
    { id: 8, slug: 'binance_futures' },
    42,
    'portfolio-1',
    null,
    [
      binancePage('CLOSING', '2026-08-03T10:20:00.000Z'),
      binancePage('OPENING', '2026-08-03T10:21:00.000Z'),
    ],
    [
      { segment_id: 'closing', reason: 'reported_end', page_ordinal: 1 },
      { segment_id: 'opening', reason: 'reported_end', page_ordinal: 2 },
    ],
    binancePositionHistoryTerminalVerifier
  )
  const binanceEmptyPageAttack = fixture(
    'binanceEmptyPageAttack',
    binanceEmptyPageCaptured,
    { id: 8, slug: 'binance_futures', adapter_slug: 'binance' },
    518,
    null
  )

  const bitgetFullShortAttack = await bitgetFixture(
    'bitgetFullShortAttack',
    519,
    41,
    'leader-1',
    Array.from({ length: 20 }, (_, index) => bitgetRaw({
      orderNo: 'short-full-' + String(index + 1),
      openTime: String(Date.parse('2026-08-03T07:00:00.000Z') - index * 60_000),
      closeTime: String(Date.parse('2026-08-03T09:00:00.000Z') - index * 60_000),
    })),
    '2026-08-03T10:22:00.000Z',
    null,
    null,
    attemptStartedAt
  )

  const okxRaw = {
    uniqueCode: 'okx-leader',
    instType: 'SWAP',
    subPosId: 'sub-position-1',
    instId: 'BTC-USDT-SWAP',
    posSide: 'short',
    openTime: String(Date.parse('2026-08-03T08:30:00.000Z')),
    closeTime: String(Date.parse('2026-08-03T09:20:00.000Z')),
    lever: '5',
    subPos: '2',
    openAvgPx: '100',
    closeAvgPx: '110',
    pnl: '1.231327',
    pnlRatio: '0.02646767',
    mgnMode: 'cross',
    closingValue: '220',
    ccy: 'USDT',
  }
  const okxPartialRaw = {
    ...okxRaw,
    subPosId: 'sub-position-partial',
    openTime: String(Date.parse('2026-08-03T08:45:00.000Z')),
    closeTime: '',
  }
  const okxBase =
    'https://www.okx.com/api/v5/copytrading/public-subpositions-history?' +
    'instType=SWAP&limit=100&uniqueCode=okx-leader'
  const okxCaptured = await capture(
    { id: 9, slug: 'okx_futures' },
    43,
    'okx-leader',
    null,
    [
      {
        pageIndex: 1,
        url: okxBase,
        fetchedAt: '2026-08-03T10:03:00.000Z',
        payload: {
          historyTraderIdentity: 'okx-leader',
          // The reviewed OKX lifecycle deliberately permits currently-open
          // rows only before completed rows in the same immutable scan.
          data: [okxPartialRaw, okxRaw],
        },
      },
      {
        pageIndex: 2,
        url: okxBase + '&after=sub-position-1',
        fetchedAt: '2026-08-03T10:04:00.000Z',
        payload: {
          historyTraderIdentity: 'okx-leader',
          data: [],
        },
      },
    ],
    [{ segment_id: 'default', reason: 'empty_page', page_ordinal: 2 }],
    okxPositionHistoryTerminalVerifier
  )
  const okx = fixture(
    'okx',
    okxCaptured,
    { id: 9, slug: 'okx_futures', adapter_slug: 'okx' },
    503,
    null
  )

  async function okxMixedAttackFixture(name, rawObjectId, suffix, minute) {
    const partial = {
      ...okxPartialRaw,
      subPosId: 'partial-' + suffix,
    }
    const completed = {
      ...okxRaw,
      subPosId: 'completed-' + suffix,
    }
    const firstFetchedAt =
      '2026-08-03T10:' + String(minute).padStart(2, '0') + ':00.000Z'
    const secondFetchedAt =
      '2026-08-03T10:' + String(minute + 1).padStart(2, '0') + ':00.000Z'
    const captured = await capture(
      { id: 9, slug: 'okx_futures' },
      43,
      'okx-leader',
      null,
      [
        {
          pageIndex: 1,
          url: okxBase,
          fetchedAt: firstFetchedAt,
          payload: {
            historyTraderIdentity: 'okx-leader',
            data: [partial, completed],
          },
        },
        {
          pageIndex: 2,
          url: okxBase + '&after=' + completed.subPosId,
          fetchedAt: secondFetchedAt,
          payload: {
            historyTraderIdentity: 'okx-leader',
            data: [],
          },
        },
      ],
      [{ segment_id: 'default', reason: 'empty_page', page_ordinal: 2 }],
      okxPositionHistoryTerminalVerifier
    )
    return fixture(
      name,
      captured,
      { id: 9, slug: 'okx_futures', adapter_slug: 'okx' },
      rawObjectId,
      null
    )
  }

  const okxCompletedThenPartial = await okxMixedAttackFixture(
    'okxCompletedThenPartial', 513, 'order', 12
  )
  const okxDuplicatePartial = await okxMixedAttackFixture(
    'okxDuplicatePartial', 514, 'duplicate', 14
  )
  const okxSharedIdentity = await okxMixedAttackFixture(
    'okxSharedIdentity', 515, 'shared', 16
  )

  const empty = await bitgetFixture(
    'empty',
    504,
    44,
    'empty-leader',
    [],
    '2026-08-03T10:05:00.000Z',
    null,
    null,
    attemptStartedAt
  )

  const rawVersionAttack = await bitgetFixture(
    'rawVersionAttack',
    509,
    41,
    'leader-1',
    [bitgetRaw({ orderNo: 'raw-version-attack' })],
    '2026-08-03T10:06:00.000Z',
    null,
    null,
    attemptStartedAt
  )
  const rawBytesAttack = await bitgetFixture(
    'rawBytesAttack',
    510,
    41,
    'leader-1',
    [bitgetRaw({ orderNo: 'raw-bytes-attack' })],
    '2026-08-03T10:07:00.000Z',
    null,
    null,
    attemptStartedAt
  )
  const duplicateRawAttack = await bitgetFixture(
    'duplicateRawAttack',
    511,
    41,
    'leader-1',
    [bitgetRaw({ orderNo: 'duplicate-raw-attack' })],
    '2026-08-03T10:08:00.000Z',
    null,
    null,
    attemptStartedAt
  )
  const pipeBitget = await bitgetFixture(
    'pipeBitget',
    512,
    46,
    'leader|pipe',
    [bitgetRaw({ orderNo: 'pipe-order' })],
    '2026-08-03T10:09:00.000Z',
    null,
    null,
    attemptStartedAt
  )

  const fixtures = {
    bitget,
    binance,
    okx,
    empty,
    rawVersionAttack,
    rawBytesAttack,
    duplicateRawAttack,
    pipeBitget,
    okxCompletedThenPartial,
    okxDuplicatePartial,
    okxSharedIdentity,
    binanceEmptyPageAttack,
    bitgetFullShortAttack,
  }
  if (process.env.CLOCK_ROLLOVER === '1') {
    const now = Date.now()
    fixtures.clockRollover = await bitgetFixture(
      'clockRollover',
      508,
      45,
      'clock-rollover-leader',
      [
        bitgetRaw({
          orderNo: 'clock-rollover-order',
          openTime: String(now - 40_000),
          closeTime: String(now - 20_000),
        }),
      ],
      new Date(now + 8_000).toISOString(),
      null,
      null,
      new Date(now - 60_000).toISOString()
    )
  }
  const previousPublicationId =
    process.env.PREVIOUS_PUBLICATION_ID === undefined
      ? null
      : Number(process.env.PREVIOUS_PUBLICATION_ID)
  if (previousPublicationId !== null) {
    if (!Number.isSafeInteger(previousPublicationId) || previousPublicationId <= 0) {
      throw new Error('PREVIOUS_PUBLICATION_ID must be a positive safe integer')
    }
    const cursor = '2026-08-03T09:00:00.000Z'
    fixtures.followupConflict = await bitgetFixture(
      'followupConflict',
      505,
      41,
      'leader-1',
      [bitgetRaw({ netProfit: '999' })],
      '2026-08-03T11:00:00.000Z',
      cursor,
      previousPublicationId,
      '2026-08-03T10:30:00.000Z'
    )
    fixtures.followupValid = await bitgetFixture(
      'followupValid',
      506,
      41,
      'leader-1',
      [
        bitgetRaw({
          orderNo: 'order-3',
          openTime: String(Date.parse('2026-08-03T09:05:00.000Z')),
          closeTime: String(Date.parse('2026-08-03T09:30:00.000Z')),
          netProfit: '30',
          returnRate: '3.5',
        }),
      ],
      '2026-08-03T11:01:00.000Z',
      cursor,
      previousPublicationId,
      '2026-08-03T10:31:00.000Z'
    )
    fixtures.followupStale = await bitgetFixture(
      'followupStale',
      507,
      41,
      'leader-1',
      [
        bitgetRaw({
          orderNo: 'order-4',
          openTime: String(Date.parse('2026-08-03T09:10:00.000Z')),
          closeTime: String(Date.parse('2026-08-03T09:40:00.000Z')),
          netProfit: '40',
          returnRate: '4.5',
        }),
      ],
      '2026-08-03T11:02:00.000Z',
      cursor,
      previousPublicationId,
      '2026-08-03T10:32:00.000Z'
    )

    const overlapRows = Array.from({ length: 20 }, (_, index) => bitgetRaw({
      orderNo: 'overlap-' + String(index + 1),
      openTime: String(Date.parse('2026-08-03T08:49:00.000Z') - index * 60_000),
      closeTime: String(Date.parse('2026-08-03T09:19:00.000Z') - index * 60_000),
    }))
    const overlapCaptured = await capture(
      { id: 7, slug: 'bitget_futures' },
      41,
      'leader-1',
      cursor,
      [
        {
          pageIndex: 1,
          url: BITGET_POSITION_HISTORY_URL,
          fetchedAt: '2026-08-03T11:03:00.000Z',
          payload: {
            contract: BITGET_HISTORY_PAGE_ENVELOPE_CONTRACT,
            historyTraderIdentity: 'leader-1',
            request: {
              pageNo: 1,
              pageSize: 20,
              traderUid: 'leader-1',
            },
            response: {
              code: '00000',
              data: { rows: overlapRows, nextFlag: true },
            },
          },
        },
      ],
      [{ segment_id: 'default', reason: 'cursor_overlap', page_ordinal: 1 }],
      bitgetPositionHistoryTerminalVerifier,
      '2026-08-03T10:33:00.000Z'
    )
    fixtures.bitgetOverlapBoundaryAttack = fixture(
      'bitgetOverlapBoundaryAttack',
      overlapCaptured,
      { id: 7, slug: 'bitget_futures', adapter_slug: 'bitget' },
      520,
      previousPublicationId
    )
  }

  const okxPreviousPublicationId =
    process.env.OKX_PREVIOUS_PUBLICATION_ID === undefined
      ? null
      : Number(process.env.OKX_PREVIOUS_PUBLICATION_ID)
  if (okxPreviousPublicationId !== null) {
    if (!Number.isSafeInteger(okxPreviousPublicationId) ||
        okxPreviousPublicationId <= 0) {
      throw new Error('OKX_PREVIOUS_PUBLICATION_ID must be a positive safe integer')
    }
    const completedPartial = {
      ...okxPartialRaw,
      closeTime: String(Date.parse('2026-08-03T09:40:00.000Z')),
      closeAvgPx: '112',
      pnl: '2.5',
      pnlRatio: '0.03',
    }
    const captured = await capture(
      { id: 9, slug: 'okx_futures' },
      43,
      'okx-leader',
      '2026-08-03T09:20:00.000Z',
      [
        {
          pageIndex: 1,
          url: okxBase,
          fetchedAt: '2026-08-03T11:10:00.000Z',
          payload: {
            historyTraderIdentity: 'okx-leader',
            data: [completedPartial],
          },
        },
        {
          pageIndex: 2,
          url: okxBase + '&after=sub-position-partial',
          fetchedAt: '2026-08-03T11:11:00.000Z',
          payload: {
            historyTraderIdentity: 'okx-leader',
            data: [],
          },
        },
      ],
      [{ segment_id: 'default', reason: 'empty_page', page_ordinal: 2 }],
      okxPositionHistoryTerminalVerifier
    )
    fixtures.okxPartialClosed = fixture(
      'okxPartialClosed',
      captured,
      { id: 9, slug: 'okx_futures', adapter_slug: 'okx' },
      516,
      okxPreviousPublicationId
    )
  }

  const okxRegressionPreviousPublicationId =
    process.env.OKX_REGRESSION_PREVIOUS_PUBLICATION_ID === undefined
      ? null
      : Number(process.env.OKX_REGRESSION_PREVIOUS_PUBLICATION_ID)
  if (okxRegressionPreviousPublicationId !== null) {
    if (!Number.isSafeInteger(okxRegressionPreviousPublicationId) ||
        okxRegressionPreviousPublicationId <= 0) {
      throw new Error(
        'OKX_REGRESSION_PREVIOUS_PUBLICATION_ID must be a positive safe integer'
      )
    }
    const captured = await capture(
      { id: 9, slug: 'okx_futures' },
      43,
      'okx-leader',
      '2026-08-03T09:40:00.000Z',
      [
        {
          pageIndex: 1,
          url: okxBase,
          fetchedAt: '2026-08-03T11:12:00.000Z',
          payload: {
            historyTraderIdentity: 'okx-leader',
            data: [okxPartialRaw],
          },
        },
        {
          pageIndex: 2,
          url: okxBase + '&after=sub-position-partial',
          fetchedAt: '2026-08-03T11:13:00.000Z',
          payload: {
            historyTraderIdentity: 'okx-leader',
            data: [],
          },
        },
      ],
      [{ segment_id: 'default', reason: 'empty_page', page_ordinal: 2 }],
      okxPositionHistoryTerminalVerifier
    )
    fixtures.okxClosedRegressesPartial = fixture(
      'okxClosedRegressesPartial',
      captured,
      { id: 9, slug: 'okx_futures', adapter_slug: 'okx' },
      517,
      okxRegressionPreviousPublicationId
    )
  }

  const payloadWithRows = (fixtureValue, rowsText) => {
    const payload = JSON.parse(fixtureValue.payloadText)
    payload.bindings_canonical_json = rowsText
    payload.binding_set_sha256 = sha256(rowsText)
    return strictCanonicalJson(payload)
  }
  const mutateBinding = (fixtureValue, mutate) => {
    const payload = JSON.parse(fixtureValue.payloadText)
    const bindings = JSON.parse(payload.bindings_canonical_json)
    mutate(bindings)
    return payloadWithRows(fixtureValue, strictCanonicalJson(bindings))
  }
  const mutateFact = (fixtureValue, field, value) =>
    mutateBinding(fixtureValue, (bindings) => {
      const binding = bindings.find(
        (candidate) => candidate.classification === 'canonical_materialized'
      )
      if (!binding) throw new Error('missing materialized binding')
      const fact = JSON.parse(binding.fact_canonical_json)
      fact[field] = value
      binding.fact_canonical_json = strictCanonicalJson(fact)
      binding.fact_sha256 = sha256(binding.fact_canonical_json)
    })
  const mutateFactNumberSpelling = (
    fixtureValue,
    field,
    expectedSpelling,
    attackSpelling
  ) => mutateBinding(fixtureValue, (bindings) => {
    const binding = bindings.find(
      (candidate) => candidate.classification === 'canonical_materialized'
    )
    if (!binding) throw new Error('missing materialized binding')
    const needle = '"' + field + '":' + expectedSpelling
    const replacement = '"' + field + '":' + attackSpelling
    if (!binding.fact_canonical_json.includes(needle)) {
      throw new Error('missing numeric spelling for attack: ' + needle)
    }
    binding.fact_canonical_json =
      binding.fact_canonical_json.replace(needle, replacement)
    binding.fact_sha256 = sha256(binding.fact_canonical_json)
  })
  const mutateOuter = (fixtureValue, mutate) => {
    const payload = JSON.parse(fixtureValue.payloadText)
    mutate(payload)
    return strictCanonicalJson(payload)
  }

  const attacks = {
    identity: bitget.payloadText,
    raw_version_identity: rawVersionAttack.payloadText,
    raw_bytes_identity: rawBytesAttack.payloadText,
  }
  if (fixtures.okxClosedRegressesPartial) {
    attacks.okx_closed_regresses_partial =
      fixtures.okxClosedRegressesPartial.payloadText
  }
  const emptyPageWithRowsMeta = structuredClone(binanceEmptyPageAttack.meta)
  emptyPageWithRowsMeta.termination.claim_observations[1].reason = 'empty_page'
  attacks.empty_page_with_rows_meta = emptyPageWithRowsMeta
  attacks.empty_page_with_rows_payload = binanceEmptyPageAttack.payloadText

  const fullShortPageMeta = structuredClone(bitgetFullShortAttack.meta)
  fullShortPageMeta.termination.claim_observations[0].reason = 'short_page'
  attacks.full_short_page_meta = fullShortPageMeta
  attacks.full_short_page_payload = bitgetFullShortAttack.payloadText

  if (fixtures.bitgetOverlapBoundaryAttack) {
    const overlapWrongBoundaryMeta = structuredClone(
      fixtures.bitgetOverlapBoundaryAttack.meta
    )
    overlapWrongBoundaryMeta.termination.overlap_event_at =
      '2026-08-03T08:59:00.000Z'
    attacks.overlap_wrong_boundary_meta = overlapWrongBoundaryMeta
    attacks.overlap_wrong_boundary_payload =
      fixtures.bitgetOverlapBoundaryAttack.payloadText
  }
  const mutateOkxEvidence = (fixtureValue, mutate) => {
    const meta = structuredClone(fixtureValue.meta)
    const payload = JSON.parse(fixtureValue.payloadText)
    const bindings = JSON.parse(payload.bindings_canonical_json)
    mutate(meta, bindings)
    payload.bindings_canonical_json = strictCanonicalJson(bindings)
    payload.binding_set_sha256 = sha256(payload.bindings_canonical_json)
    return { meta, payloadText: strictCanonicalJson(payload) }
  }
  const completedThenPartial = mutateOkxEvidence(
    okxCompletedThenPartial,
    (meta, bindings) => {
      meta.page_manifest[0].source_rows.reverse()
      meta.page_manifest[0].source_rows.forEach((row, index) => {
        row.source_row_ordinal = index + 1
      })
      bindings.reverse()
      bindings.forEach((binding, index) => {
        binding.binding_ordinal = index + 1
        binding.source_row_ordinal = index + 1
      })
    }
  )
  attacks.okx_completed_then_partial_meta = completedThenPartial.meta
  attacks.okx_completed_then_partial_payload = completedThenPartial.payloadText

  const duplicatePartial = mutateOkxEvidence(
    okxDuplicatePartial,
    (meta, bindings) => {
      const manifestPartial = structuredClone(meta.page_manifest[0].source_rows[0])
      const bindingPartial = structuredClone(bindings[0])
      meta.page_manifest[0].source_rows = [
        manifestPartial,
        { ...structuredClone(manifestPartial), source_row_ordinal: 2 },
      ]
      bindings.splice(
        0,
        bindings.length,
        bindingPartial,
        {
          ...structuredClone(bindingPartial),
          binding_ordinal: 2,
          source_row_ordinal: 2,
        }
      )
    }
  )
  attacks.okx_duplicate_partial_meta = duplicatePartial.meta
  attacks.okx_duplicate_partial_payload = duplicatePartial.payloadText

  const sharedIdentity = mutateOkxEvidence(
    okxSharedIdentity,
    (meta, bindings) => {
      const partialRaw = JSON.parse(bindings[0].raw_row_canonical_json)
      const completedRaw = JSON.parse(bindings[1].raw_row_canonical_json)
      partialRaw.subPosId = completedRaw.subPosId
      bindings[0].raw_row_canonical_json = strictCanonicalJson(partialRaw)
      bindings[0].raw_row_sha256 = sha256(bindings[0].raw_row_canonical_json)
      meta.page_manifest[0].source_rows[0].source_row_sha256 =
        bindings[0].raw_row_sha256
    }
  )
  attacks.okx_shared_identity_meta = sharedIdentity.meta
  attacks.okx_shared_identity_payload = sharedIdentity.payloadText
  for (const [sourceName, fixtureValue] of Object.entries({
    bitget,
    binance,
    okx,
  })) {
    const fact = fixtureValue.rows.find(
      (candidate) => candidate && typeof candidate.symbol === 'string'
    )
    if (!fact) throw new Error('missing materialized fixture row')
    attacks[sourceName + '_opened_at'] = mutateFact(
      fixtureValue,
      'opened_at',
      '2026-08-03T07:59:59.000Z'
    )
    attacks[sourceName + '_side'] = mutateFact(
      fixtureValue,
      'side',
      fact.side === 'long' ? 'short' : 'long'
    )
    attacks[sourceName + '_entry_price'] = mutateFact(
      fixtureValue,
      'entry_price',
      Number(fact.entry_price) + 1
    )
    attacks[sourceName + '_realized_pnl'] = mutateFact(
      fixtureValue,
      'realized_pnl',
      Number(fact.realized_pnl) + 1
    )
  }
  attacks.future_closed_at = mutateFact(
    bitget,
    'closed_at',
    '2026-08-03T10:30:00.000Z'
  )
  attacks.partial_lifecycle = mutateFact(
    bitget,
    'limitations',
    ['source_lifecycle_marker_partial']
  )
  attacks.trim_symbol = mutateFact(bitget, 'symbol', '\tBTCUSDT')
  attacks.trim_side = mutateFact(bitget, 'side', '\u00a0long')
  attacks.trim_source_fact_id = mutateFact(
    bitget,
    'source_fact_id',
    '\u2007order-1'
  )
  attacks.trim_lifecycle = mutateFact(
    bitget,
    'source_lifecycle_marker',
    '1785747600000\ufeff'
  )
  attacks.source_row_ordinal = mutateBinding(bitget, (bindings) => {
    bindings[0].source_row_ordinal = 2
  })
  attacks.wrong_source_contract = mutateOuter(bitget, (payload) => {
    payload.source_contract = 'arena.ingest.position-history-source.forged@1'
  })
  attacks.unrelated_raw_pointer = mutateOuter(bitget, (payload) => {
    payload.raw_object_id = 999
  })
  attacks.duplicate_outer =
    '{"adapter_slug":"forged",' + bitget.payloadText.slice(1)
  {
    const payload = JSON.parse(bitget.payloadText)
    const duplicateRows =
      '[{"binding_ordinal":999,' + payload.bindings_canonical_json.slice(2)
    attacks.duplicate_binding = payloadWithRows(bitget, duplicateRows)
  }
  attacks.duplicate_fact = mutateBinding(bitget, (bindings) => {
    bindings[0].fact_canonical_json =
      '{"realized_pnl":999,' + bindings[0].fact_canonical_json.slice(1)
    bindings[0].fact_sha256 = sha256(bindings[0].fact_canonical_json)
  })
  attacks.duplicate_raw = mutateBinding(duplicateRawAttack, (bindings) => {
    bindings[0].raw_row_canonical_json =
      '{"netProfit":"999",' + bindings[0].raw_row_canonical_json.slice(1)
    bindings[0].raw_row_sha256 = sha256(bindings[0].raw_row_canonical_json)
  })
  for (const [field, expectedSpelling, attackSpelling] of [
    ['entry_price', '100', '100.000000000000001'],
    ['exit_price', '110', '110.000000000000001'],
    ['leverage', '5', '5.0000000000000001'],
    ['size', '2', '2.0000000000000001'],
    ['realized_pnl', '20', '20.0000000000000001'],
    ['source_return', '-59.55', '-59.550000000000001'],
  ]) {
    attacks['numeric_precision_' + field] = mutateFactNumberSpelling(
      bitget,
      field,
      expectedSpelling,
      attackSpelling
    )
  }
  attacks.numeric_noncanonical_decimal = mutateFactNumberSpelling(
    bitget, 'leverage', '5', '5.0'
  )
  attacks.numeric_noncanonical_exponent = mutateFactNumberSpelling(
    bitget, 'leverage', '5', '5e+00'
  )
  attacks.numeric_negative_zero = mutateFactNumberSpelling(
    bitget, 'leverage', '5', '-0'
  )

  const validateReceiptJson = process.env.VALIDATE_RECEIPT_JSON
  if (validateReceiptJson !== undefined) {
    const fixtureName = process.env.VALIDATE_FIXTURE || 'bitget'
    const prepared = preparedByName.get(fixtureName)
    if (!prepared) throw new Error('unknown validation fixture: ' + fixtureName)
    validateVerifiedPositionHistoryPublicationReceipt(
      prepared,
      JSON.parse(validateReceiptJson)
    )
    process.stdout.write('receipt-ok\n')
    return
  }

  const vectorFile = process.env.VECTORS_TSV
  let vectorCount = 0
  if (vectorFile) {
    let state = 0x9e3779b9
    const next = () => {
      state = (Math.imul(state ^ (state >>> 16), 2246822507) + 3266489909) >>> 0
      return state
    }
    const values = [
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      1e-7,
      1e-6,
      1e20,
      1e21,
      -62084184550925700,
      -1.2345678901234567,
      333333333.33333329,
    ]
    while (values.length < 3211) {
      const exponent = (next() % 2097) - 1074
      const mantissa = 1 + next() / 4294967296
      const sign = (next() & 1) === 0 ? 1 : -1
      const value = sign * mantissa * Math.pow(2, exponent)
      if (Number.isFinite(value) && !Object.is(value, -0)) values.push(value)
    }
    const canonicalTexts = values.map((value) => strictCanonicalJson(value))
    canonicalTexts.push(
      strictCanonicalJson({
        Z: '\u2028 line separator',
        a: 'quote " slash \\ tab \t newline \n',
        '😀': 'astral',
        '\ue000': 'private-use',
        nested: [true, false, null, 1e-7, 1e21],
      })
    )
    const lines = canonicalTexts.map((canonicalText, index) => {
      const encoded = Buffer.from(canonicalText, 'utf8').toString('base64')
      return String(index + 1) + '\t' + sha256(canonicalText) + '\t' + encoded
    })
    writeFileSync(vectorFile, lines.join('\n') + '\n', 'utf8')
    vectorCount = lines.length
  }

  const reviewedRegistry = Object.values(REVIEWED_POSITION_HISTORY_CONTRACTS)
    .map((contract) => ({
      adapter: contract.adapterSlug,
      currency: contract.expectedCurrency,
      fieldPaths: contract.fieldPaths,
      pageSize: contract.pageSize,
      parser: contract.parserContract,
      returnScale: contract.servingReturnScale,
      slug: contract.sourceSlug,
      source: contract.sourceContract,
      verifier: contract.verifier.contract,
    }))
    .sort((left, right) => left.slug.localeCompare(right.slug))

  process.stdout.write(
    JSON.stringify({ fixtures, attacks, reviewedRegistry, vectorCount })
  )
}

main().catch((error) => {
  process.stderr.write(String(error && error.stack ? error.stack : error) + '\n')
  process.exitCode = 1
})
TS

(
  cd "$ROOT_DIR"
  REPO_ROOT="$ROOT_DIR" VECTORS_TSV="$VECTORS_TSV" npx tsx "$EXPORTER"
) >"$FIXTURE_JSON"

fixture_field() {
  local file="$1"
  local path="$2"
  node -e '
    const value = process.argv[2].split(".").reduce(
      (cursor, key) => cursor[key],
      JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    )
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value))
  ' "$file" "$path"
}

insert_fixture_raw() {
  local file="$1"
  local key="$2"
  local raw_id source_id trader_id source_run observed storage meta
  raw_id="$(fixture_field "$file" "fixtures.$key.rawObjectId")"
  source_id="$(fixture_field "$file" "fixtures.$key.sourceId")"
  trader_id="$(fixture_field "$file" "fixtures.$key.traderId")"
  source_run="$(fixture_field "$file" "fixtures.$key.sourceRunId")"
  observed="$(fixture_field "$file" "fixtures.$key.observedAt")"
  storage="$(fixture_field "$file" "fixtures.$key.storagePath")"
  meta="$(fixture_field "$file" "fixtures.$key.meta")"
  owner_psql -q \
    -v raw_id="$raw_id" \
    -v source_id="$source_id" \
    -v trader_id="$trader_id" \
    -v source_run="$source_run" \
    -v observed="$observed" \
    -v storage="$storage" \
    -v meta="$meta" <<'SQL'
INSERT INTO arena.raw_objects (
  id, source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
  bytes, content_hash, quarantined, meta
) OVERRIDING SYSTEM VALUE VALUES (
  :raw_id, :source_id, 'history:position_history', :trader_id, NULL,
  :'observed'::timestamptz, :'storage', 321, :'source_run', false,
  :'meta'::jsonb
);
SQL
}

insert_fixture_raw_with_meta() {
  local file="$1"
  local key="$2"
  local attack_meta="$3"
  local raw_id source_id trader_id source_run observed storage
  raw_id="$(fixture_field "$file" "fixtures.$key.rawObjectId")"
  source_id="$(fixture_field "$file" "fixtures.$key.sourceId")"
  trader_id="$(fixture_field "$file" "fixtures.$key.traderId")"
  source_run="$(fixture_field "$file" "fixtures.$key.sourceRunId")"
  observed="$(fixture_field "$file" "fixtures.$key.observedAt")"
  storage="$(fixture_field "$file" "fixtures.$key.storagePath")"
  owner_psql -q \
    -v raw_id="$raw_id" \
    -v source_id="$source_id" \
    -v trader_id="$trader_id" \
    -v source_run="$source_run" \
    -v observed="$observed" \
    -v storage="$storage" \
    -v meta="$attack_meta" <<'SQL'
INSERT INTO arena.raw_objects (
  id, source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
  bytes, content_hash, quarantined, meta
) OVERRIDING SYSTEM VALUE VALUES (
  :raw_id, :source_id, 'history:position_history', :trader_id, NULL,
  :'observed'::timestamptz, :'storage', 321, :'source_run', false,
  :'meta'::jsonb
);
SQL
}

expect_fixture_raw_failure() {
  local label="$1"
  local file="$2"
  local key="$3"
  local attack_meta="$4"
  local needle="$5"
  local raw_id source_id trader_id source_run observed storage failure_log
  raw_id="$(fixture_field "$file" "fixtures.$key.rawObjectId")"
  source_id="$(fixture_field "$file" "fixtures.$key.sourceId")"
  trader_id="$(fixture_field "$file" "fixtures.$key.traderId")"
  source_run="$(fixture_field "$file" "fixtures.$key.sourceRunId")"
  observed="$(fixture_field "$file" "fixtures.$key.observedAt")"
  storage="$(fixture_field "$file" "fixtures.$key.storagePath")"
  failure_log="$TMP_ROOT/$label.log"
  if owner_psql -v VERBOSITY=verbose \
    -v raw_id="$raw_id" \
    -v source_id="$source_id" \
    -v trader_id="$trader_id" \
    -v source_run="$source_run" \
    -v observed="$observed" \
    -v storage="$storage" \
    -v meta="$attack_meta" >"$failure_log" 2>&1 <<'SQL'
INSERT INTO arena.raw_objects (
  id, source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
  bytes, content_hash, quarantined, meta
) OVERRIDING SYSTEM VALUE VALUES (
  :raw_id, :source_id, 'history:position_history', :trader_id, NULL,
  :'observed'::timestamptz, :'storage', 321, :'source_run', false,
  :'meta'::jsonb
);
SQL
  then
    echo "[verified-position-history] expected RAW admission failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[verified-position-history] unexpected RAW admission failure: $label" >&2
    sed -n '1,160p' "$failure_log" >&2
    exit 1
  fi
}

expect_fixture_insert_publish_failure() {
  local label="$1"
  local file="$2"
  local key="$3"
  local attack_meta="$4"
  local attack_payload="$5"
  local needle="$6"
  local previous="${7:-}"
  local raw_id source_id trader_id source_run observed storage failure_log
  raw_id="$(fixture_field "$file" "fixtures.$key.rawObjectId")"
  source_id="$(fixture_field "$file" "fixtures.$key.sourceId")"
  trader_id="$(fixture_field "$file" "fixtures.$key.traderId")"
  source_run="$(fixture_field "$file" "fixtures.$key.sourceRunId")"
  observed="$(fixture_field "$file" "fixtures.$key.observedAt")"
  storage="$(fixture_field "$file" "fixtures.$key.storagePath")"
  failure_log="$TMP_ROOT/$label.log"
  if owner_psql -v VERBOSITY=verbose \
    -v raw_id="$raw_id" \
    -v source_id="$source_id" \
    -v trader_id="$trader_id" \
    -v source_run="$source_run" \
    -v observed="$observed" \
    -v storage="$storage" \
    -v meta="$attack_meta" \
    -v payload="$attack_payload" \
    -v previous="$previous" >"$failure_log" 2>&1 <<'SQL'
BEGIN;
INSERT INTO arena.raw_objects (
  id, source_id, job_type, trader_id, timeframe, fetched_at, storage_path,
  bytes, content_hash, quarantined, meta
) OVERRIDING SYSTEM VALUE VALUES (
  :raw_id, :source_id, 'history:position_history', :trader_id, NULL,
  :'observed'::timestamptz, :'storage', 321, :'source_run', false,
  :'meta'::jsonb
);
SELECT arena.publish_verified_position_history(
  :raw_id,
  :'source_run',
  NULLIF(:'previous', '')::bigint,
  :'payload'
);
COMMIT;
SQL
  then
    echo "[verified-position-history] expected transactional publication failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[verified-position-history] unexpected transactional publication failure: $label" >&2
    sed -n '1,160p' "$failure_log" >&2
    exit 1
  fi
}

publish_fixture() {
  local file="$1"
  local key="$2"
  local previous="${3:-}"
  local raw_id source_run payload
  raw_id="$(fixture_field "$file" "fixtures.$key.rawObjectId")"
  source_run="$(fixture_field "$file" "fixtures.$key.sourceRunId")"
  payload="$(fixture_field "$file" "fixtures.$key.payloadText")"
  owner_psql -Atq \
    -v raw_id="$raw_id" \
    -v source_run="$source_run" \
    -v previous="$previous" \
    -v payload="$payload" <<'SQL'
SELECT arena.publish_verified_position_history(
  :raw_id,
  :'source_run',
  NULLIF(:'previous', '')::bigint,
  :'payload'
);
SQL
}

expect_fixture_publish_failure() {
  local label="$1"
  local file="$2"
  local key="$3"
  local attack="$4"
  local needle="$5"
  local previous="${6:-}"
  local raw_id source_run payload failure_log
  raw_id="$(fixture_field "$file" "fixtures.$key.rawObjectId")"
  source_run="$(fixture_field "$file" "fixtures.$key.sourceRunId")"
  payload="$(fixture_field "$file" "attacks.$attack")"
  failure_log="$TMP_ROOT/$label.log"
  if owner_psql -v VERBOSITY=verbose \
    -v raw_id="$raw_id" \
    -v source_run="$source_run" \
    -v previous="$previous" \
    -v payload="$payload" >"$failure_log" 2>&1 <<'SQL'
SELECT arena.publish_verified_position_history(
  :raw_id,
  :'source_run',
  NULLIF(:'previous', '')::bigint,
  :'payload'
);
SQL
  then
    echo "[verified-position-history] expected publication failure: $label" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "[verified-position-history] unexpected publication failure: $label" >&2
    sed -n '1,160p' "$failure_log" >&2
    exit 1
  fi
}

api_query() {
  local role="$1"
  local sql="$2"
  "$PG_BIN/psql" -X -Atq -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U authenticator -d postgres \
    -c "SET ROLE $role; $sql"
}

assert_json() {
  local label="$1"
  local json="$2"
  local source="$3"
  JSON_VALUE="$json" node -e "
    const value = JSON.parse(process.env.JSON_VALUE)
    const assert = (condition, message) => {
      if (!condition) throw new Error('$label: ' + message)
    }
    $source
  "
}

TS_REVIEWED_REGISTRY="$(fixture_field "$FIXTURE_JSON" reviewedRegistry)"
SQL_REVIEWED_REGISTRY="$(owner_psql -Atq <<'SQL'
SELECT COALESCE(
  pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'adapter', contract.adapter_slug,
      'currency', contract.source_currency,
      'fieldPaths', contract.allowed_field_paths,
      'pageSize', contract.page_size,
      'parser', contract.parser_contract,
      'returnScale', contract.serving_return_scale,
      'slug', contract.source_slug,
      'source', contract.source_contract,
      'verifier', contract.terminal_verifier_contract
    ) ORDER BY contract.source_slug
  ),
  '[]'::jsonb
)::text
FROM arena.position_history_source_contracts AS contract;
SQL
)"
TS_REVIEWED_REGISTRY="$TS_REVIEWED_REGISTRY" \
SQL_REVIEWED_REGISTRY="$SQL_REVIEWED_REGISTRY" node -e '
  const assert = require("node:assert/strict")
  assert.deepStrictEqual(
    JSON.parse(process.env.SQL_REVIEWED_REGISTRY),
    JSON.parse(process.env.TS_REVIEWED_REGISTRY),
    "TypeScript and PostgreSQL reviewed source registries drifted"
  )
'

VECTOR_COUNT="$(fixture_field "$FIXTURE_JSON" vectorCount)"
if ((VECTOR_COUNT < 3000)); then
  echo "[verified-position-history] too few TS canonical vectors: $VECTOR_COUNT" >&2
  exit 1
fi
owner_psql -q <<SQL
CREATE TEMP TABLE canonical_text_vectors (
  ordinal integer PRIMARY KEY,
  expected_sha256 text NOT NULL,
  canonical_base64 text NOT NULL
);
\copy canonical_text_vectors FROM '$VECTORS_TSV' WITH (FORMAT text)
DO \$proof\$
DECLARE
  v_number_mismatches text;
BEGIN
  SELECT pg_catalog.string_agg(
    mismatch.canonical_text || '=>' ||
      COALESCE(mismatch.sql_text, '<NULL>'),
    ', ' ORDER BY mismatch.ordinal
  )
  INTO v_number_mismatches
  FROM (
    SELECT
      vector.ordinal,
      decoded.canonical_text,
      arena.position_history_ecmascript_number_text(
        decoded.canonical_text::double precision
      ) AS sql_text
    FROM canonical_text_vectors AS vector
    CROSS JOIN LATERAL (
      SELECT pg_catalog.convert_from(
        pg_catalog.decode(vector.canonical_base64, 'base64'),
        'UTF8'
      ) AS canonical_text
    ) AS decoded
    WHERE decoded.canonical_text ~ '^-?[0-9]'
      AND arena.position_history_ecmascript_number_text(
        decoded.canonical_text::double precision
      ) IS DISTINCT FROM decoded.canonical_text
    ORDER BY vector.ordinal
    LIMIT 12
  ) AS mismatch;

  IF (SELECT pg_catalog.count(*) FROM canonical_text_vectors) < 3000
     OR EXISTS (
       SELECT 1
       FROM canonical_text_vectors AS vector
       WHERE arena.position_history_text_sha256(
         pg_catalog.convert_from(
           pg_catalog.decode(vector.canonical_base64, 'base64'),
           'UTF8'
         )
       ) IS DISTINCT FROM vector.expected_sha256
     ) OR EXISTS (
       SELECT 1
       FROM canonical_text_vectors AS vector
       CROSS JOIN LATERAL (
         SELECT pg_catalog.convert_from(
           pg_catalog.decode(vector.canonical_base64, 'base64'),
           'UTF8'
         ) AS canonical_text
       ) AS decoded
       WHERE decoded.canonical_text ~ '^-?[0-9]'
         AND arena.position_history_ecmascript_number_text(
           decoded.canonical_text::double precision
         ) IS DISTINCT FROM decoded.canonical_text
     ) THEN
    RAISE EXCEPTION
      'TS canonical byte/hash/number differential failed (number mismatches: %)',
      COALESCE(v_number_mismatches, '<none>');
  END IF;
END
\$proof\$;
SQL

owner_psql -q <<'SQL'
SET statement_timeout = '10s';
DO $proof$
DECLARE
  v_rows jsonb;
  v_dedupes bigint;
  v_sources bigint;
BEGIN
  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'fact_canonical_json',
      pg_catalog.jsonb_build_object(
        'dedupe_hash', pg_catalog.lpad(item::text, 40, '0'),
        'source_fact_id', 'fact-' || item::text
      )::text
    )
  )
  INTO v_rows
  FROM pg_catalog.generate_series(1, 10000) AS item;

  SELECT
    pg_catalog.count(DISTINCT parsed.fact->>'dedupe_hash'),
    pg_catalog.count(DISTINCT parsed.fact->>'source_fact_id')
  INTO v_dedupes, v_sources
  FROM pg_catalog.jsonb_array_elements(v_rows) AS binding(value)
  CROSS JOIN LATERAL (
    SELECT (binding.value->>'fact_canonical_json')::jsonb AS fact
  ) AS parsed;
  IF v_dedupes <> 10000 OR v_sources <> 10000 THEN
    RAISE EXCEPTION 'set-based identity proof failed';
  END IF;
END
$proof$;
RESET statement_timeout;

DO $proof$
BEGIN
  IF arena.position_history_js_number('"1.25"'::jsonb)
       IS DISTINCT FROM 1.25::double precision
     OR arena.position_history_js_number('"0x10"'::jsonb) IS NOT NULL
     OR arena.position_history_js_number('"0o20"'::jsonb) IS NOT NULL
     OR arena.position_history_js_number('"0b10000"'::jsonb) IS NOT NULL
     OR arena.position_history_js_number('"1e-324"'::jsonb) IS NOT NULL
     OR arena.position_history_js_number('"2e-324"'::jsonb) IS NOT NULL
     OR arena.position_history_js_number('"1e-9999"'::jsonb) IS NOT NULL
     OR arena.position_history_js_number('"0e-9999"'::jsonb)
       IS DISTINCT FROM 0::double precision
     OR arena.position_history_js_number('"-0"'::jsonb) IS NOT NULL
     OR arena.position_history_js_number('"-0.0"'::jsonb) IS NOT NULL
     OR arena.position_history_js_number('"-0e9999"'::jsonb) IS NOT NULL
     OR arena.position_history_js_number(
          pg_catalog.to_jsonb(pg_catalog.repeat('1', 129))
        ) IS NOT NULL
     OR arena.position_history_js_number('"1e309"'::jsonb) IS NOT NULL
     OR arena.position_history_js_number('"Infinity"'::jsonb) IS NOT NULL
     OR arena.position_history_js_number('"NaN"'::jsonb) IS NOT NULL THEN
    RAISE EXCEPTION 'bounded decimal number boundary drifted';
  END IF;
  IF arena.position_history_numeric_scalar_is_publishable('"0x10"'::jsonb)
     OR arena.position_history_numeric_scalar_is_publishable('"0o20"'::jsonb)
     OR arena.position_history_numeric_scalar_is_publishable('"0b10000"'::jsonb)
     OR arena.position_history_numeric_scalar_is_publishable('"1e-324"'::jsonb)
     OR arena.position_history_numeric_scalar_is_publishable('"2e-324"'::jsonb)
     OR arena.position_history_numeric_scalar_is_publishable('"1e-9999"'::jsonb)
     OR arena.position_history_numeric_scalar_is_publishable('"-0"'::jsonb)
     OR arena.position_history_numeric_scalar_is_publishable('"-0.0"'::jsonb)
     OR arena.position_history_numeric_scalar_is_publishable('"-0e9999"'::jsonb)
     OR arena.position_history_numeric_scalar_is_publishable(
          pg_catalog.to_jsonb(pg_catalog.repeat('1', 129))
        )
     OR NOT arena.position_history_numeric_scalar_is_publishable('"0e-9999"'::jsonb)
     OR NOT arena.position_history_numeric_scalar_is_publishable('"1e309"'::jsonb)
     OR NOT arena.position_history_numeric_scalar_is_publishable('"not-a-number"'::jsonb)
     OR NOT arena.position_history_numeric_scalar_is_publishable('""'::jsonb) THEN
    RAISE EXCEPTION 'numeric scalar publication contract drifted';
  END IF;
  IF arena.position_history_ecmascript_trim(E'\tvalue\n')
       IS DISTINCT FROM 'value'
     OR arena.position_history_ecmascript_trim(U&'\00A0value\00A0')
       IS DISTINCT FROM 'value'
     OR arena.position_history_ecmascript_trim(U&'\2007value\2007')
       IS DISTINCT FROM 'value'
     OR arena.position_history_ecmascript_trim(U&'\FEFFvalue\FEFF')
       IS DISTINCT FROM 'value'
     OR arena.position_history_text_is_canonical(E'\tvalue', 1, 64)
     OR arena.position_history_text_is_canonical(U&'\00A0value', 1, 64)
     OR arena.position_history_text_is_canonical(U&'value\2007', 1, 64)
     OR arena.position_history_text_is_canonical(U&'\FEFFvalue', 1, 64)
     OR NOT arena.position_history_text_is_canonical(
       pg_catalog.repeat(U&'\+01F680', 64), 1, 64
     )
     OR arena.position_history_text_is_canonical(
       pg_catalog.repeat(U&'\+01F680', 65), 1, 64
     )
     OR arena.position_history_numeric_scalar_is_publishable(
       pg_catalog.to_jsonb(E'\t1'::text)
     )
     OR arena.position_history_numeric_scalar_is_publishable(
       pg_catalog.to_jsonb(U&'\00A01'::text)
     )
     OR arena.position_history_numeric_scalar_is_publishable(
       pg_catalog.to_jsonb(U&'1\FEFF'::text)
     )
     OR arena.position_history_source_identity(
       pg_catalog.to_jsonb(U&'\2007source'::text)
     ) IS NOT NULL
     OR arena.position_history_source_identity('9007199254740992'::jsonb)
       IS NOT NULL
     OR arena.position_history_source_identity('-1'::jsonb) IS NOT NULL
     OR arena.position_history_source_identity('9007199254740991'::jsonb)
       IS DISTINCT FROM '9007199254740991' THEN
    RAISE EXCEPTION 'ECMAScript text/source identity boundary drifted';
  END IF;
  IF NOT arena.position_history_scaled_return_is_finite(
       '1.7976931348623157e+308'::jsonb, 1
     )
     OR arena.position_history_scaled_return_is_finite(
       '1.7976931348623157e+308'::jsonb, 100
     )
     OR NOT arena.position_history_scaled_return_is_finite('null'::jsonb, 100)
     OR arena.position_history_scaled_return_is_finite('"1"'::jsonb, 1) THEN
    RAISE EXCEPTION 'serving return scale finite boundary drifted';
  END IF;
  IF arena.position_history_serving_margin_mode(
       'binance_futures', '{"isolated":"Cross"}'::jsonb
     ) IS DISTINCT FROM 'cross'
     OR arena.position_history_serving_margin_mode(
       'okx_futures', '{"mgnMode":"isolated"}'::jsonb
     ) IS DISTINCT FROM 'isolated'
     OR arena.position_history_serving_margin_mode(
       'okx_futures', '{"mgnMode":"ISOLATED"}'::jsonb
     ) IS NOT NULL
     OR arena.position_history_serving_margin_mode(
       'binance_futures', '{"isolated":"İSOLATED"}'::jsonb
     ) IS NOT NULL
     OR arena.position_history_serving_margin_mode(
       'binance_futures', '{"isolated":" garbage "}'::jsonb
     ) IS NOT NULL
     OR arena.position_history_serving_margin_mode(
       'okx_futures', '{"mgnMode":2}'::jsonb
     ) IS NOT NULL
     OR arena.position_history_serving_margin_mode(
       'bitget_futures', '{"marginMode":2}'::jsonb
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'serving margin-mode enum authority drifted';
  END IF;
END
$proof$;
SQL
if rg -q 'v_seen_dedupes|v_seen_source_fact_ids|v_manifest_ordinals|array_append' "$MIGRATION"; then
  echo "[verified-position-history] quadratic publication accumulator returned" >&2
  exit 1
fi

owner_psql -q <<'SQL'
INSERT INTO arena.position_history (
  trader_id, opened_at, closed_at, symbol, side, leverage, size,
  entry_price, exit_price, realized_pnl, currency, dedupe_hash, raw
) VALUES (
  41, '2026-06-03T00:00:00Z', '2026-06-04T00:00:00Z',
  'LEGACY_AFTER', 'short', 2, 3, 4, 5, 6, 'USDT',
  '2222222222222222222222222222222222222222',
  '{"closingValue":"50","marginType":"isolated","maxOpenInterest":"25","roi":"8.5"}'
);
SQL
LEGACY_PAGE="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader-1','position_history',NULL,NULL,20)")"
assert_json legacy_fallback "$LEGACY_PAGE" '
  assert(value.completeness.contract === "arena.position-history-completeness@2", "contract")
  assert(value.completeness.state === "unknown", "state")
  assert(value.completeness.evidenceState === "unknown", "evidence")
  assert(value.completeness.reason === "history_evidence_not_bound", "reason")
  assert(value.completeness.blockerReasons[0] === "history_evidence_not_bound", "blocker")
  assert(value.asOf === null && value.sourceAsOf === null, "unknown clocks")
  assert(value.rows.some((row) => row.symbol === "LEGACY"), "legacy row missing")
  const row = value.rows.find((candidate) => candidate.symbol === "LEGACY")
  assert(Number(row.max_open_interest) === 12.5, "max_open_interest")
  assert(row.margin_mode === "cross", "margin_mode")
  assert(Number(row.roi) === 7.25, "roi")
  assert(Number(row.closing_value) === 456.5, "closing_value")
'
LEGACY_CURSOR_PAGE="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader-1','position_history',NULL,NULL,1)")"
LEGACY_CURSOR="$(JSON_VALUE="$LEGACY_CURSOR_PAGE" node -e \
  'process.stdout.write(JSON.parse(process.env.JSON_VALUE).nextCursor)')"
if [[ ! "$LEGACY_CURSOR" =~ ^[^|]+\|[0-9a-f]{40}$ ]]; then
  echo "[verified-position-history] legacy cursor contract drifted" >&2
  exit 1
fi
expect_api_failure_contains legacy_cursor_trailing anon 'invalid legacy position-history cursor' \
  "SELECT public.arena_records_page('bitget_futures','leader-1','position_history',NULL,'$LEGACY_CURSOR|',1)"
expect_api_failure_contains null_kind anon 'unknown record kind' \
  "SELECT public.arena_records_page('bitget_futures','leader-1',NULL,NULL,NULL,1)"
api_query anon \
  "SELECT public.arena_records_page(repeat('a',128),repeat('t',512),'orders',NULL,repeat('c',200),1)" \
  >/dev/null
api_query anon \
  "SELECT public.arena_records_page('bitget_futures',repeat(U&'\+01F680',512),'orders',NULL,NULL,1)" \
  >/dev/null
expect_api_failure_contains source_too_long anon 'bounded lower_snake_case' \
  "SELECT public.arena_records_page(repeat('a',129),'trader','orders',NULL,NULL,1)"
expect_api_failure_contains source_not_lower_snake anon 'bounded lower_snake_case' \
  "SELECT public.arena_records_page('Bitget_Futures','trader','orders',NULL,NULL,1)"
expect_api_failure_contains trader_too_long anon 'bounded canonical text' \
  "SELECT public.arena_records_page('bitget_futures',repeat('t',513),'orders',NULL,NULL,1)"
expect_api_failure_contains trader_codepoints_too_long anon 'bounded canonical text' \
  "SELECT public.arena_records_page('bitget_futures',repeat(U&'\+01F680',513),'orders',NULL,NULL,1)"
expect_api_failure_contains trader_tab_edge anon 'bounded canonical text' \
  "SELECT public.arena_records_page('bitget_futures',E'\\tleader','orders',NULL,NULL,1)"
expect_api_failure_contains trader_nbsp_edge anon 'bounded canonical text' \
  "SELECT public.arena_records_page('bitget_futures',U&'\00A0leader','orders',NULL,NULL,1)"
expect_api_failure_contains trader_bom_edge anon 'bounded canonical text' \
  "SELECT public.arena_records_page('bitget_futures',U&'leader\FEFF','orders',NULL,NULL,1)"
expect_api_failure_contains cursor_too_long anon '200-byte bound' \
  "SELECT public.arena_records_page('bitget_futures','leader-1','orders',NULL,repeat('c',201),1)"

CAP_BEFORE="$(api_query anon "SELECT public.arena_source_capabilities()")"
assert_json capability_before "$CAP_BEFORE" '
  assert(value.binance_futures.surfaces.position_history === false, "stale MV baseline")
'

RAW_VERSION_BASE_META="$(fixture_field "$FIXTURE_JSON" fixtures.rawVersionAttack.meta)"
RAW_VERSION_META="$(JSON_VALUE="$RAW_VERSION_BASE_META" node -e '
  const meta = JSON.parse(process.env.JSON_VALUE)
  meta.raw_integrity.version = "1"
  process.stdout.write(JSON.stringify(meta))
')"
insert_fixture_raw_with_meta "$FIXTURE_JSON" rawVersionAttack "$RAW_VERSION_META"
expect_fixture_publish_failure raw_version_type "$FIXTURE_JSON" rawVersionAttack \
  raw_version_identity \
  'RAW integrity metadata is not exact'
RAW_BYTES_BASE_META="$(fixture_field "$FIXTURE_JSON" fixtures.rawBytesAttack.meta)"
RAW_BYTES_FRACTION_META="$(JSON_VALUE="$RAW_BYTES_BASE_META" node -e '
  const meta = JSON.parse(process.env.JSON_VALUE)
  meta.raw_integrity.uncompressed_bytes = 1.5
  process.stdout.write(JSON.stringify(meta))
')"
insert_fixture_raw_with_meta "$FIXTURE_JSON" rawBytesAttack "$RAW_BYTES_FRACTION_META"
expect_fixture_publish_failure raw_bytes_fraction "$FIXTURE_JSON" rawBytesAttack \
  raw_bytes_identity \
  'RAW integrity metadata is not exact'

DUPLICATE_RAW_PAYLOAD="$(fixture_field "$FIXTURE_JSON" attacks.duplicate_raw)"
DUPLICATE_RAW_SHA256="$(JSON_VALUE="$DUPLICATE_RAW_PAYLOAD" node -e '
  const payload = JSON.parse(process.env.JSON_VALUE)
  const bindings = JSON.parse(payload.bindings_canonical_json)
  process.stdout.write(bindings[0].raw_row_sha256)
')"
DUPLICATE_RAW_BASE_META="$(fixture_field "$FIXTURE_JSON" fixtures.duplicateRawAttack.meta)"
DUPLICATE_RAW_META="$(JSON_VALUE="$DUPLICATE_RAW_BASE_META" \
  SOURCE_ROW_SHA256="$DUPLICATE_RAW_SHA256" node -e '
  const meta = JSON.parse(process.env.JSON_VALUE)
  meta.page_manifest[0].source_rows[0].source_row_sha256 =
    process.env.SOURCE_ROW_SHA256
  process.stdout.write(JSON.stringify(meta))
')"
insert_fixture_raw_with_meta "$FIXTURE_JSON" duplicateRawAttack "$DUPLICATE_RAW_META"
expect_fixture_publish_failure duplicate_raw "$FIXTURE_JSON" duplicateRawAttack \
  duplicate_raw \
  'RAW row canonical text is not exact duplicate-free JSON'

for okx_attack in \
  completed_then_partial \
  duplicate_partial \
  shared_identity; do
  OKX_ATTACK_META="$(fixture_field \
    "$FIXTURE_JSON" "attacks.okx_${okx_attack}_meta")"
  OKX_ATTACK_PAYLOAD="$(fixture_field \
    "$FIXTURE_JSON" "attacks.okx_${okx_attack}_payload")"
  case "$okx_attack" in
    completed_then_partial)
      OKX_ATTACK_FIXTURE='okxCompletedThenPartial'
      OKX_ATTACK_ERROR='source partial binding is outside exact reviewed OKX omission evidence'
      ;;
    duplicate_partial)
      OKX_ATTACK_FIXTURE='okxDuplicatePartial'
      OKX_ATTACK_ERROR='OKX publication repeats a partial/materialized source identity'
      ;;
    shared_identity)
      OKX_ATTACK_FIXTURE='okxSharedIdentity'
      OKX_ATTACK_ERROR='OKX publication repeats a partial/materialized source identity'
      ;;
  esac
  expect_fixture_insert_publish_failure \
    "okx_$okx_attack" "$FIXTURE_JSON" "$OKX_ATTACK_FIXTURE" \
    "$OKX_ATTACK_META" "$OKX_ATTACK_PAYLOAD" "$OKX_ATTACK_ERROR"
done

for terminal_attack in empty_page_with_rows full_short_page; do
  TERMINAL_ATTACK_META="$(fixture_field \
    "$FIXTURE_JSON" "attacks.${terminal_attack}_meta")"
  TERMINAL_ATTACK_PAYLOAD="$(fixture_field \
    "$FIXTURE_JSON" "attacks.${terminal_attack}_payload")"
  if [[ "$terminal_attack" == 'empty_page_with_rows' ]]; then
    TERMINAL_ATTACK_FIXTURE='binanceEmptyPageAttack'
    TERMINAL_ATTACK_ERROR='empty-page terminal evidence contains source rows'
  else
    TERMINAL_ATTACK_FIXTURE='bitgetFullShortAttack'
    TERMINAL_ATTACK_ERROR='short-page terminal cardinality is not exact'
  fi
  expect_fixture_insert_publish_failure \
    "$terminal_attack" "$FIXTURE_JSON" "$TERMINAL_ATTACK_FIXTURE" \
    "$TERMINAL_ATTACK_META" "$TERMINAL_ATTACK_PAYLOAD" \
    "$TERMINAL_ATTACK_ERROR"
done

for key in bitget binance okx empty pipeBitget; do
  insert_fixture_raw "$FIXTURE_JSON" "$key"
done

expect_api_failure_contains service_publish service_role 'permission denied' \
  "SELECT arena.publish_verified_position_history(501, repeat('a',64), NULL, '{}')"
api_query service_role "SELECT public.arena_source_capabilities()" >/dev/null

for source in bitget binance okx; do
  for field in opened_at side entry_price realized_pnl; do
    expect_fixture_publish_failure \
      "${source}_${field}" "$FIXTURE_JSON" "$source" "${source}_${field}" \
      'canonical fact economic fields do not match'
  done
done
expect_fixture_publish_failure future_clock "$FIXTURE_JSON" bitget \
  future_closed_at 'canonical chronology'
expect_fixture_publish_failure partial_lifecycle "$FIXTURE_JSON" bitget \
  partial_lifecycle 'fact limitations are not exact'
for attack in trim_symbol trim_side trim_source_fact_id trim_lifecycle; do
  expect_fixture_publish_failure "$attack" "$FIXTURE_JSON" bitget "$attack" \
    'canonical fact value types are not exact'
done
expect_fixture_publish_failure source_row_drift "$FIXTURE_JSON" bitget \
  source_row_ordinal 'do not exactly bind'
expect_fixture_publish_failure wrong_contract "$FIXTURE_JSON" bitget \
  wrong_source_contract 'RAW pointer, source, trader'
expect_fixture_publish_failure unrelated_raw "$FIXTURE_JSON" bitget \
  unrelated_raw_pointer 'invalid verified position-history RPC payload'
expect_fixture_publish_failure duplicate_outer "$FIXTURE_JSON" bitget \
  duplicate_outer 'duplicate-free JSON'
expect_fixture_publish_failure duplicate_binding "$FIXTURE_JSON" bitget \
  duplicate_binding 'bindings_canonical_json is not exact duplicate-free JSON'
expect_fixture_publish_failure duplicate_fact "$FIXTURE_JSON" bitget \
  duplicate_fact 'fact canonical text is not exact duplicate-free JSON'
for numeric_field in \
  entry_price exit_price leverage size realized_pnl source_return; do
  expect_fixture_publish_failure \
    "numeric_precision_$numeric_field" "$FIXTURE_JSON" bitget \
    "numeric_precision_$numeric_field" \
    'is not the exact ECMAScript Number spelling'
done
for numeric_attack in \
  numeric_noncanonical_decimal \
  numeric_noncanonical_exponent \
  numeric_negative_zero; do
  expect_fixture_publish_failure "$numeric_attack" "$FIXTURE_JSON" bitget \
    "$numeric_attack" 'is not the exact ECMAScript Number spelling'
done
BITGET_RECEIPT="$(publish_fixture "$FIXTURE_JSON" bitget)"
assert_json bitget_receipt "$BITGET_RECEIPT" '
  assert(Object.keys(value).sort().join(",") ===
    ["cursorAfter","factsAdded","factsReused","observedAt","publicationId",
     "publicationSha256","rawObjectId","replayed","sourceRunId","stateId"].sort().join(","),
    "receipt keys")
  assert(value.factsAdded === 2 && value.factsReused === 0, "fact counts")
  assert(value.replayed === false, "first publication replay flag")
'
BITGET_PUBLICATION_ID="$(JSON_VALUE="$BITGET_RECEIPT" node -e \
  'process.stdout.write(String(JSON.parse(process.env.JSON_VALUE).publicationId))')"
(
  cd "$ROOT_DIR"
  REPO_ROOT="$ROOT_DIR" \
  VALIDATE_FIXTURE=bitget \
  VALIDATE_RECEIPT_JSON="$BITGET_RECEIPT" \
  npx tsx "$EXPORTER"
) | grep -Fq receipt-ok

REPLAY_RECEIPT="$(publish_fixture "$FIXTURE_JSON" bitget)"
assert_json replay_receipt "$REPLAY_RECEIPT" '
  assert(value.replayed === true, "replay flag")
  assert(value.factsAdded === 0 && value.factsReused === 2, "replay counts")
'

BITGET_PAGE_ONE="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader-1','position_history',NULL,NULL,1)")"
assert_json bitget_verified "$BITGET_PAGE_ONE" '
  assert(value.completeness.state === "complete", "complete state")
  assert(value.completeness.evidenceState === "verified", "verified evidence")
  assert(Object.keys(value.completeness).sort().join(",") ===
    ["blockerReasons","contract","evidenceState","publicationId","reason",
     "scanTerminalState","state"].sort().join(","), "completeness keys")
  assert(value.asOf === null && value.sourceAsOf === null, "source clocks unknown")
  assert(value.observedAt !== null && value.publishedAt !== null, "system clocks")
  assert(value.rows.length === 1 && value.rows[0].symbol === "BTCUSDT", "first row")
  assert(Number(value.rows[0].roi) === -59.55, "Bitget percent scale")
  assert(Number(value.rows[0].source_return) === -59.55, "Bitget source return")
  assert(value.rows[0].margin_mode === null, "Bitget unknown margin mode")
  assert(!value.rows.some((row) => row.symbol.startsWith("LEGACY")), "legacy mixing")
  assert(typeof value.nextCursor === "string" && value.nextCursor.length <= 200, "cursor")
  assert(!Object.prototype.hasOwnProperty.call(value, "publicationSha256"), "digest leak")
  assert(!Object.prototype.hasOwnProperty.call(value, "cursorSecret"), "secret leak")
'
VERIFIED_CURSOR="$(JSON_VALUE="$BITGET_PAGE_ONE" node -e \
  'process.stdout.write(JSON.parse(process.env.JSON_VALUE).nextCursor)')"
NONCANONICAL_VERIFIED_CURSOR="$(CURSOR_VALUE="$VERIFIED_CURSOR" node -e '
  const cursor = process.env.CURSOR_VALUE
  const [payload, mac] = cursor.split(".")
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
  const remainder = payload.length % 4
  const unusedBits = remainder === 2 ? 4 : remainder === 3 ? 2 : 0
  if (unusedBits === 0) throw new Error("cursor payload has no unused bits")
  const lastIndex = alphabet.indexOf(payload.at(-1))
  if (lastIndex < 0 || (lastIndex & ((1 << unusedBits) - 1)) !== 0) {
    throw new Error("cursor payload is not canonical base64url")
  }
  const aliasPayload = payload.slice(0, -1) + alphabet[lastIndex | 1]
  if (!Buffer.from(aliasPayload, "base64url").equals(
    Buffer.from(payload, "base64url")
  )) throw new Error("base64url alias changed decoded payload")
  process.stdout.write(aliasPayload + "." + mac)
')"
BITGET_PAGE_TWO="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader-1','position_history',NULL,'$VERIFIED_CURSOR',1)")"
assert_json bitget_second_page "$BITGET_PAGE_TWO" '
  assert(value.rows.length === 1 && value.rows[0].symbol === "ETHUSDT", "second row")
  assert(value.nextCursor === null, "terminal page")
'
TAMPERED_CURSOR="${VERIFIED_CURSOR%?}A"
if [[ "$TAMPERED_CURSOR" == "$VERIFIED_CURSOR" ]]; then
  TAMPERED_CURSOR="${VERIFIED_CURSOR%?}B"
fi
expect_api_failure_contains cursor_tamper anon \
  'invalid verified position-history cursor authentication' \
  "SELECT public.arena_records_page('bitget_futures','leader-1','position_history',NULL,'$TAMPERED_CURSOR',1)"
expect_api_failure_sqlstate_contains cursor_noncanonical_base64url anon 22023 \
  'invalid verified position-history cursor' \
  "SELECT public.arena_records_page('bitget_futures','leader-1','position_history',NULL,'$NONCANONICAL_VERIFIED_CURSOR',1)"

BITGET_PUBLICATION_ID="$(JSON_VALUE="$BITGET_RECEIPT" node -e \
  'process.stdout.write(String(JSON.parse(process.env.JSON_VALUE).publicationId))')"
BITGET_CURSOR_SECRET_HEX="$(owner_psql -Atq \
  -v publication_id="$BITGET_PUBLICATION_ID" <<'SQL'
SELECT pg_catalog.encode(publication.cursor_secret, 'hex')
FROM arena.position_history_publications AS publication
WHERE publication.publication_id = :publication_id;
SQL
)"
read -r OVERFLOW_PUBLICATION_CURSOR OVERFLOW_EPOCH_CURSOR < <(
  CURSOR_SECRET_HEX="$BITGET_CURSOR_SECRET_HEX" \
  PUBLICATION_ID="$BITGET_PUBLICATION_ID" node -e '
    const { createHmac } = require("node:crypto")
    const secret = Buffer.from(process.env.CURSOR_SECRET_HEX, "hex")
    const encode = (payload) => {
      const mac = createHmac("sha256", secret)
        .update(payload, "utf8")
        .digest("base64url")
      return Buffer.from(payload, "utf8").toString("base64url") + "." + mac
    }
    const hash = "6f6a545de247015f9675a6d1f2a5b15439826764"
    process.stdout.write(
      encode("vph3|9223372036854775808|1|" + hash) + " " +
      encode("vph3|" + process.env.PUBLICATION_ID +
        "|9223372036854775808|" + hash) + "\n"
    )
  '
)
expect_api_failure_sqlstate_contains cursor_publication_bigint_overflow anon 22023 \
  'invalid verified position-history cursor' \
  "SELECT public.arena_records_page('bitget_futures','leader-1','position_history',NULL,'$OVERFLOW_PUBLICATION_CURSOR',1)"
expect_api_failure_sqlstate_contains cursor_epoch_bigint_overflow anon 22023 \
  'invalid verified position-history cursor' \
  "SELECT public.arena_records_page('bitget_futures','leader-1','position_history',NULL,'$OVERFLOW_EPOCH_CURSOR',1)"
expect_api_failure_contains legacy_cursor_cutover anon \
  'reset pagination without a cursor' \
  "SELECT public.arena_records_page('bitget_futures','leader-1','position_history',NULL,'$LEGACY_CURSOR',1)"

BINANCE_RECEIPT="$(publish_fixture "$FIXTURE_JSON" binance)"
OKX_RECEIPT="$(publish_fixture "$FIXTURE_JSON" okx)"
EMPTY_RECEIPT="$(publish_fixture "$FIXTURE_JSON" empty)"
PIPE_BITGET_RECEIPT="$(publish_fixture "$FIXTURE_JSON" pipeBitget)"

for receipt_name in BINANCE_RECEIPT OKX_RECEIPT EMPTY_RECEIPT PIPE_BITGET_RECEIPT; do
  receipt_value="${!receipt_name}"
  assert_json "$receipt_name" "$receipt_value" '
    assert(value.replayed === false, "replay flag")
    assert(/^[0-9a-f]{64}$/.test(value.publicationSha256), "publication digest")
  '
done

assert_json okx_mixed_receipt "$OKX_RECEIPT" '
  assert(value.factsAdded === 1, "one completed OKX fact")
  assert(value.factsReused === 0, "no reused OKX fact")
'
OKX_PUBLICATION_ID="$(JSON_VALUE="$OKX_RECEIPT" node -e \
  'process.stdout.write(String(JSON.parse(process.env.JSON_VALUE).publicationId))')"

PIPE_BITGET_PAGE="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader|pipe','position_history',NULL,NULL,10)")"
assert_json bitget_pipe_public "$PIPE_BITGET_PAGE" '
  assert(value.completeness.state === "complete", "complete state")
  assert(value.rows.length === 1 && value.rows[0].symbol === "BTCUSDT", "row")
'

BINANCE_PAGE="$(api_query anon \
  "SELECT public.arena_records_page('binance_futures','portfolio-1','position_history',NULL,NULL,10)")"
assert_json binance_public "$BINANCE_PAGE" '
  assert(value.rows.length === 1, "row count")
  const row = value.rows[0]
  assert(Number(row.source_return) === 0.23571614, "raw source return")
  assert(Number(row.roi) === 23.571614, "serving percent")
  assert(row.side === "long", "BUY normalization")
  assert(row.margin_mode === "cross", "Binance margin mode")
  assert(Number(row.max_open_interest) === 40, "Binance max interest")
  assert(Number(row.closing_value) === 220, "Binance closing value")
'
OKX_PAGE="$(api_query anon \
  "SELECT public.arena_records_page('okx_futures','okx-leader','position_history',NULL,NULL,10)")"
assert_json okx_public "$OKX_PAGE" '
  assert(value.rows.length === 1, "row count")
  const row = value.rows[0]
  assert(Number(row.source_return) === 0.02646767, "raw source return")
  assert(Number(row.roi) === 2.646767, "serving percent")
  assert(row.margin_mode === "cross", "OKX margin mode")
'
EMPTY_PAGE="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','empty-leader','position_history',NULL,NULL,10)")"
assert_json empty_verified "$EMPTY_PAGE" '
  assert(value.completeness.state === "complete", "complete empty")
  assert(value.completeness.evidenceState === "verified", "verified empty")
  assert(value.rows.length === 0 && value.nextCursor === null, "empty rows")
  assert(value.asOf === null && value.sourceAsOf === null, "unknown source clocks")
'

expect_api_failure_contains cursor_cross_identity anon \
  'does not match this identity' \
  "SELECT public.arena_records_page('binance_futures','portfolio-1','position_history',NULL,'$VERIFIED_CURSOR',1)"

CAP_AFTER="$(api_query anon "SELECT public.arena_source_capabilities()")"
assert_json capability_overlay "$CAP_AFTER" '
  assert(value.binance_futures.surfaces.position_history === true, "verified overlay")
'

owner_psql -q <<'SQL'
DO $proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM arena.position_history_publications AS publication
    JOIN arena.sources AS source
      ON source.id = publication.source_id
    WHERE source.slug = 'okx_futures'
      AND publication.parsed_row_count = 1
      AND publication.binding_count = 2
      AND publication.partial_row_count = 1
      AND publication.unique_fact_count = 1
      AND publication.new_fact_count = 1
  ) OR (
    SELECT pg_catalog.count(*)
    FROM arena.position_history_publication_bindings AS binding
    JOIN arena.position_history_publications AS publication
      ON publication.publication_id = binding.publication_id
    JOIN arena.sources AS source
      ON source.id = publication.source_id
    WHERE source.slug = 'okx_futures'
      AND binding.classification = 'source_partial_omitted'
      AND binding.fact_id IS NULL
      AND binding.fact_canonical_json IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'OKX mixed lifecycle accounting drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.verified_position_history_facts AS fact
    JOIN arena.sources AS source ON source.id = fact.source_id
    WHERE (source.slug = 'binance_futures' AND fact.source_return <> 0.23571614)
       OR (source.slug = 'bitget_futures' AND fact.source_return NOT IN (-59.55, -1.2345678901234567))
       OR (source.slug = 'okx_futures' AND fact.source_return <> 0.02646767)
  ) THEN
    RAISE EXCEPTION 'immutable source_return was presentation-normalized';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.verified_position_history_facts AS fact
    JOIN arena.position_history_source_contracts AS contract
      ON contract.source_id = fact.source_id
    JOIN arena.traders AS trader ON trader.id = fact.trader_id
    JOIN arena.position_history_publication_bindings AS binding
      ON binding.publication_id = fact.first_publication_id
     AND binding.fact_id = fact.fact_id
    WHERE NOT arena.position_history_fact_matches_raw(
      contract.source_slug, contract.source_currency,
      trader.exchange_trader_id, binding.page_fetched_at, fact.fact_payload
    )
  ) THEN
    RAISE EXCEPTION 'stored fact no longer matches RAW';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.verified_position_history_facts AS fact
    JOIN arena.position_history_source_contracts AS contract
      ON contract.source_id = fact.source_id
    JOIN arena.traders AS trader ON trader.id = fact.trader_id
    JOIN arena.position_history_publication_bindings AS binding
      ON binding.publication_id = fact.first_publication_id
     AND binding.fact_id = fact.fact_id
    WHERE (
      contract.source_slug = 'binance_futures'
      AND (
        arena.position_history_fact_matches_raw(
          contract.source_slug,
          contract.source_currency,
          trader.exchange_trader_id,
          binding.page_fetched_at,
          pg_catalog.jsonb_set(
            fact.fact_payload,
            '{raw,opened}',
            pg_catalog.to_jsonb(
              (fact.fact_payload #>> '{raw,opened}')::numeric + 0.5
            )
          )
        )
        OR arena.position_history_fact_matches_raw(
          contract.source_slug,
          contract.source_currency,
          trader.exchange_trader_id,
          binding.page_fetched_at,
          pg_catalog.jsonb_set(
            fact.fact_payload, '{raw,id}', '"A|B"'::jsonb
          )
        )
        OR arena.position_history_fact_matches_raw(
          contract.source_slug,
          contract.source_currency,
          trader.exchange_trader_id,
          binding.page_fetched_at,
          pg_catalog.jsonb_set(
            fact.fact_payload,
            '{raw,id}',
            pg_catalog.to_jsonb(
              (fact.fact_payload #>> '{raw,opened}')::numeric + 1
            )
          )
        )
      )
    ) OR (
      contract.source_slug = 'bitget_futures'
      AND arena.position_history_fact_matches_raw(
        contract.source_slug,
        contract.source_currency,
        trader.exchange_trader_id,
        binding.page_fetched_at,
        pg_catalog.jsonb_set(
          fact.fact_payload,
          '{raw,openTime}',
          pg_catalog.to_jsonb(
            (fact.fact_payload #>> '{raw,openTime}') || '.5'
          )
        )
      )
    ) OR (
      contract.source_slug = 'okx_futures'
      AND arena.position_history_fact_matches_raw(
        contract.source_slug,
        contract.source_currency,
        trader.exchange_trader_id,
        binding.page_fetched_at,
        pg_catalog.jsonb_set(
          fact.fact_payload,
          '{raw,openTime}',
          pg_catalog.to_jsonb(
            (fact.fact_payload #>> '{raw,openTime}') || '.5'
          )
        )
      )
    )
  ) THEN
    RAISE EXCEPTION 'fractional epoch or ambiguous Binance id was accepted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM arena.verified_position_history_facts AS fact
    JOIN arena.position_history_source_contracts AS contract
      ON contract.source_id = fact.source_id
    JOIN arena.traders AS trader ON trader.id = fact.trader_id
    JOIN arena.position_history_publication_bindings AS binding
      ON binding.publication_id = fact.first_publication_id
     AND binding.fact_id = fact.fact_id
    WHERE contract.source_slug = 'bitget_futures'
      AND (
        arena.position_history_fact_matches_raw(
          contract.source_slug,
          contract.source_currency,
          trader.exchange_trader_id,
          binding.page_fetched_at,
          pg_catalog.jsonb_set(
            fact.fact_payload, '{raw,tokenId}', '"EUR"'::jsonb
          )
        )
        OR arena.position_history_fact_matches_raw(
          contract.source_slug,
          contract.source_currency,
          trader.exchange_trader_id,
          binding.page_fetched_at,
          fact.fact_payload #- '{raw,tokenId}'::text[]
        )
        OR arena.position_history_fact_matches_raw(
          contract.source_slug,
          contract.source_currency,
          trader.exchange_trader_id,
          binding.page_fetched_at,
          pg_catalog.jsonb_set(
            fact.fact_payload, '{raw,tokenId}', '7'::jsonb
          )
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM arena.verified_position_history_facts AS fact
    JOIN arena.position_history_source_contracts AS contract
      ON contract.source_id = fact.source_id
    JOIN arena.traders AS trader ON trader.id = fact.trader_id
    JOIN arena.position_history_publication_bindings AS binding
      ON binding.publication_id = fact.first_publication_id
     AND binding.fact_id = fact.fact_id
    WHERE contract.source_slug = 'okx_futures'
      AND (
        arena.position_history_fact_matches_raw(
          contract.source_slug,
          contract.source_currency,
          trader.exchange_trader_id,
          binding.page_fetched_at,
          pg_catalog.jsonb_set(
            fact.fact_payload, '{raw,ccy}', '"EUR"'::jsonb
          )
        )
        OR arena.position_history_fact_matches_raw(
          contract.source_slug,
          contract.source_currency,
          trader.exchange_trader_id,
          binding.page_fetched_at,
          fact.fact_payload #- '{raw,ccy}'::text[]
        )
        OR arena.position_history_fact_matches_raw(
          contract.source_slug,
          contract.source_currency,
          trader.exchange_trader_id,
          binding.page_fetched_at,
          pg_catalog.jsonb_set(
            fact.fact_payload, '{raw,ccy}', '7'::jsonb
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'RAW currency drift was accepted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM arena.position_history_publications
    WHERE previous_publication_id IS NULL
  ) <> 5 THEN
    RAISE EXCEPTION 'root publication count drifted';
  END IF;
END
$proof$;
SQL

(
  cd "$ROOT_DIR"
  REPO_ROOT="$ROOT_DIR" CLOCK_ROLLOVER=1 npx tsx "$EXPORTER"
) >"$ROLLOVER_JSON"
insert_fixture_raw "$ROLLOVER_JSON" clockRollover
if [[ "$(owner_psql -Atq -c \
  'SELECT fetched_at > pg_catalog.clock_timestamp() FROM arena.raw_objects WHERE id=508')" \
  != "t" ]]; then
  echo "[verified-position-history] rollover fixture was not future at publication" >&2
  exit 1
fi
ROLLOVER_IMMEDIATE_RECEIPT="$(publish_fixture "$ROLLOVER_JSON" clockRollover)"
owner_psql -q -c \
  "SELECT pg_catalog.pg_sleep(
     GREATEST(
       0,
       EXTRACT(epoch FROM (
         (SELECT fetched_at FROM arena.raw_objects WHERE id=508) -
         pg_catalog.clock_timestamp()
       ))
     ) + 0.2
   )"
ROLLOVER_LATER_RECEIPT="$(publish_fixture "$ROLLOVER_JSON" clockRollover)"
IMMEDIATE_RECEIPT="$ROLLOVER_IMMEDIATE_RECEIPT" \
LATER_RECEIPT="$ROLLOVER_LATER_RECEIPT" node -e '
  const assert = require("node:assert/strict")
  const immediate = JSON.parse(process.env.IMMEDIATE_RECEIPT)
  const later = JSON.parse(process.env.LATER_RECEIPT)
  assert.equal(immediate.replayed, false)
  assert.equal(later.replayed, true)
  assert.equal(later.publicationId, immediate.publicationId)
  assert.equal(later.publicationSha256, immediate.publicationSha256)
  assert.equal(later.observedAt, immediate.observedAt)
'

(
  cd "$ROOT_DIR"
  REPO_ROOT="$ROOT_DIR" \
  PREVIOUS_PUBLICATION_ID="$BITGET_PUBLICATION_ID" \
  OKX_PREVIOUS_PUBLICATION_ID="$OKX_PUBLICATION_ID" \
  npx tsx "$EXPORTER"
) >"$CONTINUATION_JSON"
OVERLAP_WRONG_BOUNDARY_META="$(fixture_field \
  "$CONTINUATION_JSON" attacks.overlap_wrong_boundary_meta)"
OVERLAP_WRONG_BOUNDARY_PAYLOAD="$(fixture_field \
  "$CONTINUATION_JSON" attacks.overlap_wrong_boundary_payload)"
expect_fixture_insert_publish_failure overlap_wrong_boundary \
  "$CONTINUATION_JSON" bitgetOverlapBoundaryAttack \
  "$OVERLAP_WRONG_BOUNDARY_META" "$OVERLAP_WRONG_BOUNDARY_PAYLOAD" \
  'cursor-overlap evidence does not match the exact terminal fact boundary' \
  "$BITGET_PUBLICATION_ID"

for key in followupConflict followupValid followupStale; do
  insert_fixture_raw "$CONTINUATION_JSON" "$key"
done
insert_fixture_raw "$CONTINUATION_JSON" okxPartialClosed

OKX_CLOSED_RECEIPT="$(publish_fixture \
  "$CONTINUATION_JSON" okxPartialClosed "$OKX_PUBLICATION_ID")"
assert_json okx_partial_closed_receipt "$OKX_CLOSED_RECEIPT" '
  assert(value.replayed === false, "new continuation")
  assert(value.factsAdded === 1 && value.factsReused === 0, "closed fact")
'
OKX_CLOSED_PUBLICATION_ID="$(JSON_VALUE="$OKX_CLOSED_RECEIPT" node -e \
  'process.stdout.write(String(JSON.parse(process.env.JSON_VALUE).publicationId))')"
OKX_CLOSED_PAGE="$(api_query anon \
  "SELECT public.arena_records_page('okx_futures','okx-leader','position_history',NULL,NULL,10)")"
assert_json okx_partial_to_closed_public "$OKX_CLOSED_PAGE" "
  assert(value.publicationId === $OKX_CLOSED_PUBLICATION_ID, 'latest publication')
  assert(value.rows.length === 2, 'partial became a second public fact')
  assert(value.rows[0].closed_at === '2026-08-03T09:40:00.000Z', 'closed ordering')
"

(
  cd "$ROOT_DIR"
  REPO_ROOT="$ROOT_DIR" \
  OKX_REGRESSION_PREVIOUS_PUBLICATION_ID="$OKX_CLOSED_PUBLICATION_ID" \
  npx tsx "$EXPORTER"
) >"$OKX_REGRESSION_JSON"
insert_fixture_raw "$OKX_REGRESSION_JSON" okxClosedRegressesPartial
expect_fixture_publish_failure okx_closed_regresses_partial \
  "$OKX_REGRESSION_JSON" okxClosedRegressesPartial \
  okx_closed_regresses_partial \
  'OKX closed fact cannot regress to a source partial omission' \
  "$OKX_CLOSED_PUBLICATION_ID"

CONFLICT_PAYLOAD="$(fixture_field "$CONTINUATION_JSON" fixtures.followupConflict.payloadText)"
CONFLICT_RAW="$(fixture_field "$CONTINUATION_JSON" fixtures.followupConflict.rawObjectId)"
CONFLICT_RUN="$(fixture_field "$CONTINUATION_JSON" fixtures.followupConflict.sourceRunId)"
CONFLICT_LOG="$TMP_ROOT/source-fact-conflict.log"
if owner_psql -v VERBOSITY=verbose \
  -v raw_id="$CONFLICT_RAW" \
  -v source_run="$CONFLICT_RUN" \
  -v previous="$BITGET_PUBLICATION_ID" \
  -v payload="$CONFLICT_PAYLOAD" >"$CONFLICT_LOG" 2>&1 <<'SQL'
SELECT arena.publish_verified_position_history(
  :raw_id, :'source_run', :previous, :'payload'
);
SQL
then
  echo "[verified-position-history] conflicting source fact unexpectedly published" >&2
  exit 1
fi
grep -Fq 'parser dedupe or source fact identity conflicts with exact bytes' "$CONFLICT_LOG"

STALE_RAW="$(fixture_field "$CONTINUATION_JSON" fixtures.followupStale.rawObjectId)"
STALE_RUN="$(fixture_field "$CONTINUATION_JSON" fixtures.followupStale.sourceRunId)"
STALE_PAYLOAD="$(fixture_field "$CONTINUATION_JSON" fixtures.followupStale.payloadText)"
STALE_LOG="$TMP_ROOT/stale-cas.log"
(
  owner_psql -v VERBOSITY=verbose \
    -v raw_id="$STALE_RAW" \
    -v source_run="$STALE_RUN" \
    -v previous="$BITGET_PUBLICATION_ID" \
    -v payload="$STALE_PAYLOAD" <<'SQL'
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_catalog.count(*) FROM arena.position_history_publications;
SELECT pg_catalog.pg_sleep(2);
SELECT arena.publish_verified_position_history(
  :raw_id, :'source_run', :previous, :'payload'
);
COMMIT;
SQL
) >"$STALE_LOG" 2>&1 &
STALE_PID=$!
sleep 1
VALID_RECEIPT="$(publish_fixture \
  "$CONTINUATION_JSON" followupValid "$BITGET_PUBLICATION_ID")"
if wait "$STALE_PID"; then
  echo "[verified-position-history] stale snapshot fork unexpectedly published" >&2
  exit 1
fi
grep -Fq '40001' "$STALE_LOG"
grep -Fq 'compare-and-swap race' "$STALE_LOG"

VALID_PUBLICATION_ID="$(JSON_VALUE="$VALID_RECEIPT" node -e \
  'process.stdout.write(String(JSON.parse(process.env.JSON_VALUE).publicationId))')"
(
  cd "$ROOT_DIR"
  REPO_ROOT="$ROOT_DIR" \
  PREVIOUS_PUBLICATION_ID="$BITGET_PUBLICATION_ID" \
  VALIDATE_FIXTURE=followupValid \
  VALIDATE_RECEIPT_JSON="$VALID_RECEIPT" \
  npx tsx "$EXPORTER"
) | grep -Fq receipt-ok

OLD_ANCHOR_PAGE="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader-1','position_history',NULL,'$VERIFIED_CURSOR',10)")"
assert_json old_anchor "$OLD_ANCHOR_PAGE" "
  assert(value.publicationId === $BITGET_PUBLICATION_ID, 'old anchor id')
  assert(value.rows.length === 1, 'old anchor remainder')
"
NEW_ANCHOR_PAGE="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader-1','position_history',NULL,NULL,10)")"
assert_json new_anchor "$NEW_ANCHOR_PAGE" "
  assert(value.publicationId === $VALID_PUBLICATION_ID, 'new anchor id')
  assert(value.rows.length === 3, 'linear fact history')
  assert(value.rows[0].closed_at === '2026-08-03T09:30:00.000Z', 'new fact order')
"

owner_psql -q <<'SQL'
INSERT INTO arena.positions_current (
  trader_id, snapshot_at, as_of, symbol, side, leverage, size,
  entry_price, mark_price, unrealized_pnl, currency, raw
) VALUES (
  41, '2026-08-03T12:00:00Z', '2026-08-03T11:59:00Z',
  'BTCUSDT', 'long', 5, 2, 100, 110, 5, 'USDT',
  '{"collateral":"25","marginType":"isolated","notionalValue":"250"}'
);
INSERT INTO arena.order_records (
  trader_id, ts, kind, symbol, side, price, qty, currency, dedupe_hash, raw
) VALUES (
  41, '2026-08-03T12:00:00Z', 'market', 'BTCUSDT', 'buy',
  100, 2, 'USDT', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  '{"totalPnl":"3.5","totalAmount":"55"}'
);
INSERT INTO arena.transfer_history (
  trader_id, ts, direction, asset, amount, currency, dedupe_hash, raw
) VALUES (
  41, '2026-08-03T12:00:00Z', 'in', 'USDT', 10, 'USDT',
  'cccccccccccccccccccccccccccccccccccccccc', '{}'
);
SQL
POSITIONS_PAGE="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader-1','positions',NULL,NULL,1)")"
assert_json positions_ui "$POSITIONS_PAGE" '
  const row = value.rows[0]
  assert(Number(row.margin) === 25, "margin")
  assert(row.margin_mode === "isolated", "margin mode")
  assert(Number(row.notional) === 250, "notional")
  assert(Number(row.roe) === 20, "roe")
'
ORDER_ONE="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader-1','orders',NULL,NULL,1)")"
TRANSFER_ONE="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader-1','transfers',NULL,NULL,1)")"
assert_json order_single "$ORDER_ONE" '
  assert(value.rows.length === 1 && value.nextCursor === null, "single pagination")
  assert(Number(value.rows[0].realized_pnl) === 3.5, "realized pnl")
  assert(Number(value.rows[0].notional) === 55, "notional")
  assert(value.asOf === null && value.sourceAsOf === null && value.observedAt === null, "clocks")
'
assert_json transfer_single "$TRANSFER_ONE" '
  assert(value.rows.length === 1 && value.nextCursor === null, "single pagination")
  assert(value.asOf === null && value.sourceAsOf === null && value.observedAt === null, "clocks")
'
owner_psql -q <<'SQL'
INSERT INTO arena.order_records (
  trader_id, ts, kind, symbol, side, price, qty, currency, dedupe_hash, raw
) VALUES (
  41, '2026-08-03T12:01:00Z', 'limit', 'ETHUSDT', 'sell',
  101, 1, 'USDT', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  '{"realizedPnl":"4.5","notionalValue":"65"}'
);
INSERT INTO arena.transfer_history (
  trader_id, ts, direction, asset, amount, currency, dedupe_hash, raw
) VALUES (
  41, '2026-08-03T12:01:00Z', 'out', 'USDT', 2, 'USDT',
  'dddddddddddddddddddddddddddddddddddddddd', '{}'
);
SQL
ORDER_TWO="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader-1','orders',NULL,NULL,1)")"
TRANSFER_TWO="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader-1','transfers',NULL,NULL,1)")"
assert_json order_multi "$ORDER_TWO" '
  assert(value.rows.length === 1 && typeof value.nextCursor === "string", "limit+1")
'
assert_json transfer_multi "$TRANSFER_TWO" '
  assert(value.rows.length === 1 && typeof value.nextCursor === "string", "limit+1")
'
ORDER_EMPTY="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader-1','orders',NULL,'2020-01-01T00:00:00.000Z|0000000000000000000000000000000000000000',1)")"
TRANSFER_EMPTY="$(api_query anon \
  "SELECT public.arena_records_page('bitget_futures','leader-1','transfers',NULL,'2020-01-01T00:00:00.000Z|0000000000000000000000000000000000000000',1)")"
assert_json order_empty "$ORDER_EMPTY" '
  assert(value.rows.length === 0 && value.nextCursor === null, "empty cursor page")
'
assert_json transfer_empty "$TRANSFER_EMPTY" '
  assert(value.rows.length === 0 && value.nextCursor === null, "empty cursor page")
'
expect_api_failure_contains order_cursor_trailing anon 'invalid legacy record cursor' \
  "SELECT public.arena_records_page('bitget_futures','leader-1','orders',NULL,'2020-01-01T00:00:00.000Z|0000000000000000000000000000000000000000|',1)"

for unpublished_raw_id in 505 507 509 510 511 517; do
  expect_failure_contains \
    "raw_gc_unpublished_$unpublished_raw_id" \
    'unpublished position-history RAW evidence cannot be deleted' \
    "DELETE FROM arena.raw_objects WHERE id = $unpublished_raw_id"
done

owner_psql -q <<'SQL'
DO $proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM arena.raw_objects
    WHERE id IN (505, 507, 509, 510, 511, 517)
  ) <> 6 THEN
    RAISE EXCEPTION 'rejected unpublished RAW GC changed evidence rows';
  END IF;
END
$proof$;

DELETE FROM arena.raw_objects
WHERE id IN (501, 502, 503, 504, 506, 508, 512, 516);

DO $proof$
DECLARE
  v_page jsonb;
BEGIN
  IF EXISTS (
       SELECT 1
       FROM arena.raw_objects
       WHERE id IN (501, 502, 503, 504, 506, 508, 512, 516)
     ) OR (
       SELECT pg_catalog.count(*)
       FROM arena.raw_objects
       WHERE id IN (505, 507, 509, 510, 511, 517)
     ) <> 6 THEN
    RAISE EXCEPTION 'published/unpublished RAW GC boundary drifted';
  END IF;
  v_page := public.arena_records_page(
    'bitget_futures', 'leader-1', 'position_history', NULL, NULL, 10
  );
  IF pg_catalog.jsonb_array_length(v_page->'rows') <> 3 THEN
    RAISE EXCEPTION 'RAW GC changed verified serving history';
  END IF;
END
$proof$;
SQL

expect_failure_contains direct_fact_insert \
  'verified position-history inserts require the owner publication boundary' \
  "INSERT INTO arena.verified_position_history_facts (source_run_id) VALUES (repeat('a',64))"
expect_failure_contains fact_update \
  'verified position-history authority is immutable' \
  "UPDATE arena.verified_position_history_facts SET symbol = symbol"
expect_failure_contains fact_truncate \
  'verified position-history authority is immutable' \
  "TRUNCATE arena.verified_position_history_facts CASCADE"

owner_psql -q <<'SQL'
INSERT INTO arena.position_history (
  trader_id, opened_at, closed_at, symbol, side, leverage, size,
  entry_price, exit_price, realized_pnl, currency, dedupe_hash, raw
) VALUES (
  41, '2034-01-01T00:00:00Z', '2035-01-01T00:00:00Z',
  'FUTURE_LEGACY', 'long', 1, 1, 1, 1, 1, 'USDT',
  'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', '{}'
);
SQL

owner_psql -q <<'SQL'
DO $proof$
DECLARE
  v_constraint_definition text;
BEGIN
  SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid)
  INTO v_constraint_definition
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
      'arena.position_history_publications'::pg_catalog.regclass
    AND constraint_row.conname = 'position_history_publication_linear_chain';
  IF v_constraint_definition NOT LIKE 'UNIQUE NULLS NOT DISTINCT%' THEN
    RAISE EXCEPTION 'linear chain constraint is absent';
  END IF;
  IF pg_catalog.has_function_privilege(
       'service_role',
       'arena.publish_verified_position_history(bigint,text,bigint,text)',
       'EXECUTE'
     )
     OR pg_catalog.has_table_privilege(
       'service_role', 'arena.verified_position_history_facts', 'SELECT'
     )
     OR NOT pg_catalog.has_function_privilege(
       'anon',
       'public.arena_records_page(text,text,text,integer,text,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'authority grant topology drifted';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM arena.position_history_publications
    GROUP BY source_id, trader_id, previous_publication_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'publication chain forked';
  END IF;
END
$proof$;
SQL

COUNTS_BEFORE="$(owner_psql -Atq -c \
  "SELECT (SELECT count(*) FROM arena.position_history_publications)::text || ':' ||
          (SELECT count(*) FROM arena.verified_position_history_facts)::text || ':' ||
          (SELECT count(*) FROM arena.position_history)::text")"
REPLAY_LOG="$TMP_ROOT/migration-replay.log"
if owner_psql -f "$MIGRATION" >"$REPLAY_LOG" 2>&1; then
  echo "[verified-position-history] one-shot authority migration replayed" >&2
  exit 1
fi
grep -Fq 'already or partially installed' "$REPLAY_LOG"
COUNTS_AFTER="$(owner_psql -Atq -c \
  "SELECT (SELECT count(*) FROM arena.position_history_publications)::text || ':' ||
          (SELECT count(*) FROM arena.verified_position_history_facts)::text || ':' ||
          (SELECT count(*) FROM arena.position_history)::text")"
if [[ "$COUNTS_BEFORE" != "$COUNTS_AFTER" ]]; then
  echo "[verified-position-history] failed migration replay changed data" >&2
  exit 1
fi

echo "[verified-position-history] PostgreSQL 17 authority proof passed"
