#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the OKX futures/spot copier-depth correction.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260804054500_correct_okx_copier_depth_contract.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$("$PG_BIN/psql" --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo 'This integration proof requires PostgreSQL 17' >&2
  exit 1
fi
if [[ ! -f "$MIGRATION" ]]; then
  echo "Required migration not found: $MIGRATION" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/okx-copier-depth-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((62000 + ($$ % 2000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

assert_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "$label changed: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

reset_fixture() {
  psql_cmd -q <<'SQL'
TRUNCATE arena.sources RESTART IDENTITY;
INSERT INTO arena.sources (
  slug, adapter_slug, product_type, currency, copier_table_depth, meta
) VALUES
  (
    'okx_futures', 'okx', 'futures', 'USDT', 'full',
    '{"inst_type":"SWAP","endpoints":{"base":"https://www.okx.com/api/v5/copytrading"}}'
  ),
  (
    'okx_spot', 'okx', 'spot', 'USDT', 'full',
    '{"inst_type":"SPOT"}'
  ),
  (
    'binance_futures', 'binance', 'futures', 'USDT', 'full', '{}'
  );
SQL
}

expect_migration_failure() {
  local label="$1"
  local needle="$2"
  local failure_log="$TMP_ROOT/${label//[^a-zA-Z0-9_-]/_}.log"
  if psql_cmd -q -f "$MIGRATION" >"$failure_log" 2>&1; then
    echo "$label succeeded unexpectedly" >&2
    exit 1
  fi
  if ! grep -Fq "$needle" "$failure_log"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,160p' "$failure_log" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --username=postgres \
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
CREATE SCHEMA arena AUTHORIZATION postgres;
CREATE TABLE arena.sources (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug text NOT NULL,
  adapter_slug text NOT NULL,
  product_type text NOT NULL,
  currency text NOT NULL,
  copier_table_depth text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
SQL

reset_fixture
psql_cmd -q -c "DELETE FROM arena.sources WHERE slug='okx_spot'"
expect_migration_failure \
  'missing canonical OKX source was accepted' \
  'requires exactly one futures and one spot source'

reset_fixture
psql_cmd -q -c "INSERT INTO arena.sources (slug,adapter_slug,product_type,currency,copier_table_depth,meta) VALUES ('okx_futures','okx','futures','USDT','full','{}')"
expect_migration_failure \
  'duplicate canonical OKX source was accepted' \
  'requires exactly one futures and one spot source'

reset_fixture
psql_cmd -q -c "UPDATE arena.sources SET adapter_slug='foreign' WHERE slug='okx_futures'"
expect_migration_failure \
  'adapter drift was accepted' \
  'okx_futures identity, currency, or copier depth pre-state drifted'

reset_fixture
psql_cmd -q -c "UPDATE arena.sources SET product_type='futures' WHERE slug='okx_spot'"
expect_migration_failure \
  'product drift was accepted' \
  'okx_spot identity, currency, or copier depth pre-state drifted'

reset_fixture
psql_cmd -q -c "UPDATE arena.sources SET currency='USDC' WHERE slug='okx_futures'"
expect_migration_failure \
  'currency drift was accepted' \
  'okx_futures identity, currency, or copier depth pre-state drifted'

reset_fixture
psql_cmd -q -c "UPDATE arena.sources SET copier_table_depth='none' WHERE slug='okx_futures'"
expect_migration_failure \
  'unexpected futures depth pre-state was accepted' \
  'okx_futures identity, currency, or copier depth pre-state drifted'

reset_fixture
psql_cmd -q -c "UPDATE arena.sources SET copier_table_depth='top10' WHERE slug='okx_spot'"
expect_migration_failure \
  'unexpected spot depth pre-state was accepted' \
  'okx_spot identity, currency, or copier depth pre-state drifted'

reset_fixture
psql_cmd -q -c "UPDATE arena.sources SET meta=pg_catalog.jsonb_set(meta,'{inst_type}','\"SPOT\"'::jsonb) WHERE slug='okx_futures'"
expect_migration_failure \
  'inst_type drift was accepted' \
  'inst_type metadata conflicts with the canonical product'

reset_fixture
psql_cmd -q -c "UPDATE arena.sources SET meta=pg_catalog.jsonb_set(meta,'{endpoints,base}','\"https://example.invalid/copytrading\"'::jsonb) WHERE slug='okx_futures'"
expect_migration_failure \
  'custom OKX copier base was accepted' \
  'custom copier endpoint drifted from the reviewed public-copy-traders route'

reset_fixture
psql_cmd -q -c "UPDATE arena.sources SET meta=meta || '{\"copier_endpoint\":\"https://example.invalid/copiers\"}'::jsonb WHERE slug='okx_spot'"
expect_migration_failure \
  'custom OKX copier endpoint was accepted' \
  'custom copier endpoint drifted from the reviewed public-copy-traders route'

reset_fixture
psql_cmd -q -f "$MIGRATION"
assert_equal \
  'canonical OKX depth correction drifted' \
  'okx_futures|top10
okx_spot|none' \
  "$(psql_cmd -Atqc "SELECT slug || '|' || copier_table_depth FROM arena.sources WHERE slug IN ('okx_futures','okx_spot') ORDER BY slug")"
assert_equal \
  'OKX correction mutated another source' \
  'binance|futures|USDT|full|{}' \
  "$(psql_cmd -Atqc "SELECT adapter_slug || '|' || product_type || '|' || currency || '|' || copier_table_depth || '|' || meta::text FROM arena.sources WHERE slug='binance_futures'")"

# Both rows now start in the allowed target state. Exact replay must remain a
# no-op and preserve every source contract.
psql_cmd -q -f "$MIGRATION"
assert_equal \
  'OKX depth correction replay drifted' \
  'okx_futures|top10
okx_spot|none
binance_futures|full' \
  "$(psql_cmd -Atqc "SELECT slug || '|' || copier_table_depth FROM arena.sources ORDER BY CASE slug WHEN 'okx_futures' THEN 1 WHEN 'okx_spot' THEN 2 ELSE 3 END")"

echo 'OKX copier depth contract 054500 PostgreSQL 17 proof passed'
