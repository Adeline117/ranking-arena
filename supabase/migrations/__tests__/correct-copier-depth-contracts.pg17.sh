#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for reviewed copier-depth corrections.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260804054600_correct_copier_depth_contracts.sql"
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

TMP_ROOT="$(mktemp -d /tmp/reviewed-copier-depth-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((60000 + ($$ % 4000)))}"
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
  slug, adapter_slug, product_type, trader_kind_scope, currency,
  copier_table_depth, meta
) VALUES
  ('gate_futures','gate','futures','human','USDT','top10','{"boardKey":"futures"}'),
  ('gate_cfd','gate','cfd','human','USDx','top10','{"boardKey":"cfd"}'),
  ('bybit_copytrade','bybit_copytrade','futures','mixed','USDT','full','{}'),
  ('bingx_futures','bingx','futures','human','USDT','full','{}'),
  ('bingx_spot','bingx','spot','human','USDT','full','{}'),
  ('blofin_futures','blofin','futures','mixed','USDT','full','{}'),
  ('blofin_spot','blofin','spot','human','USDT','full','{}'),
  ('htx_futures','htx','futures','human','USDT','full','{}'),
  ('htx_spot','htx','spot','human','USDT','full','{}'),
  ('phemex_futures','phemex','futures','mixed','USDT','full','{}'),
  ('bitmart_futures','bitmart','futures','mixed','USDT','full','{}'),
  ('lbank_futures','lbank','futures','human','USDT','top3_preview','{"capped_public_followers":100}'),
  ('binance_futures','binance','futures','human','USDT','full','{"untouched":true}');
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
  trader_kind_scope text NOT NULL,
  currency text NOT NULL,
  copier_table_depth text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
SQL

reset_fixture
psql_cmd -q -c "DELETE FROM arena.sources WHERE slug='bingx_spot'"
expect_migration_failure \
  'missing canonical source was accepted' \
  'requires exactly one canonical source per slug'

reset_fixture
psql_cmd -q -c "INSERT INTO arena.sources (slug,adapter_slug,product_type,trader_kind_scope,currency,copier_table_depth,meta) VALUES ('gate_futures','gate','futures','human','USDT','top10','{\"boardKey\":\"futures\"}')"
expect_migration_failure \
  'duplicate canonical source was accepted' \
  'requires exactly one canonical source per slug'

reset_fixture
psql_cmd -q -c "UPDATE arena.sources SET adapter_slug='foreign' WHERE slug='blofin_spot'"
expect_migration_failure \
  'adapter drift was accepted' \
  'source identity, currency, metadata, or depth pre-state drifted'

reset_fixture
psql_cmd -q -c "UPDATE arena.sources SET trader_kind_scope='human' WHERE slug='bybit_copytrade'"
expect_migration_failure \
  'scope drift was accepted' \
  'source identity, currency, metadata, or depth pre-state drifted'

reset_fixture
psql_cmd -q -c "UPDATE arena.sources SET copier_table_depth='top3_preview' WHERE slug='bingx_futures'"
expect_migration_failure \
  'depth drift was accepted' \
  'source identity, currency, metadata, or depth pre-state drifted'

reset_fixture
psql_cmd -q <<'SQL'
UPDATE arena.sources
SET meta = '{"boardKey":"cfd"}'::jsonb
WHERE slug = 'gate_futures';
SQL
expect_migration_failure \
  'Gate board drift was accepted' \
  'gate_futures reviewed board or copier endpoint drifted'

reset_fixture
psql_cmd -q <<'SQL'
UPDATE arena.sources
SET meta = '{"boardKey":"futures","endpoints":{"copiers":"https://example.invalid/copiers"}}'::jsonb
WHERE slug = 'gate_futures';
SQL
expect_migration_failure \
  'Gate endpoint drift was accepted' \
  'gate_futures reviewed board or copier endpoint drifted'

reset_fixture
psql_cmd -q -f "$MIGRATION"
assert_equal \
  'reviewed copier depth correction drifted' \
  'gate_futures|full
gate_cfd|none
bybit_copytrade|none
bingx_futures|none
bingx_spot|none
blofin_futures|none
blofin_spot|none
htx_futures|none
htx_spot|none
phemex_futures|none
bitmart_futures|none' \
  "$(psql_cmd -Atqc "SELECT slug || '|' || copier_table_depth FROM arena.sources WHERE slug NOT IN ('binance_futures','lbank_futures') ORDER BY id")"
assert_equal \
  'depth correction mutated an excluded source' \
  'lbank_futures|lbank|futures|human|USDT|top3_preview|{"capped_public_followers": 100}
binance_futures|binance|futures|human|USDT|full|{"untouched": true}' \
  "$(psql_cmd -Atqc "SELECT slug || '|' || adapter_slug || '|' || product_type || '|' || trader_kind_scope || '|' || currency || '|' || copier_table_depth || '|' || meta::text FROM arena.sources WHERE slug IN ('lbank_futures','binance_futures') ORDER BY id")"

psql_cmd -q -f "$MIGRATION"
assert_equal \
  'reviewed copier depth replay drifted' \
  '11' \
  "$(psql_cmd -Atqc "SELECT count(*) FROM arena.sources WHERE (slug='gate_futures' AND copier_table_depth='full') OR (slug <> 'gate_futures' AND slug <> 'binance_futures' AND copier_table_depth='none')")"

echo 'reviewed copier depth contracts 054600 PostgreSQL 17 proof passed'
