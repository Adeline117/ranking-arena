#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729061000_source_legacy_platform_alias_contract.sql"
SEED_MIGRATION="$ROOT_DIR/supabase/migrations/20260610223356_arena_schema_and_dimensions.sql"
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

TMP_ROOT="$(mktemp -d /tmp/source-alias-contract-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="${PGPORT_OVERRIDE:-$((57500 + ($$ % 7000)))}"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -160 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

psql_seed_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d seed_replay "$@"
}

expect_sql_failure() {
  local label="$1"
  local expected="$2"
  local sql="$3"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
    echo "$label failed for the wrong reason; expected: $expected" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
}

expect_migration_failure() {
  local label="$1"
  local expected="$2"
  if psql_cmd -q -f "$MIGRATION" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if [[ "$(<"$ERROR_FILE")" != *"$expected"* ]]; then
    echo "$label failed for the wrong reason; expected: $expected" >&2
    cat "$ERROR_FILE" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
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
CREATE SCHEMA arena;

CREATE TABLE arena.exchanges (
  id smallint PRIMARY KEY,
  slug text NOT NULL UNIQUE
);

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  exchange_id smallint NOT NULL REFERENCES arena.exchanges(id),
  product_type text NOT NULL,
  trader_kind_scope text NOT NULL,
  adapter_slug text NOT NULL,
  serving_mode text NOT NULL CHECK (serving_mode IN ('legacy', 'shadow', 'serving')),
  status text NOT NULL CHECK (status IN ('active', 'inactive', 'blocked_pending_vps', 'dropped')),
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO arena.exchanges (id, slug) VALUES
  (1, 'mexc'),
  (2, 'gate'),
  (3, 'bingx'),
  (4, 'bybit'),
  (5, 'binance_web3'),
  (6, 'kucoin'),
  (7, 'bitunix'),
  (8, 'phemex'),
  (9, 'btcc'),
  (10, 'lbank'),
  (11, 'blofin'),
  (12, 'xt'),
  (13, 'coinex'),
  (14, 'htx');

INSERT INTO arena.sources (
  id, slug, exchange_id, product_type, trader_kind_scope, adapter_slug,
  serving_mode, status, meta
) VALUES
  (1, 'mexc_futures', 1, 'futures', 'mixed', 'mexc',
   'serving', 'active', '{"fixture_owner":"keep","legacy_platform":"mexc"}'),
  (2, 'gate_futures', 2, 'futures', 'human', 'gate',
   'serving', 'active', '{"fixture_owner":"keep"}'),
  (3, 'bingx_futures', 3, 'futures', 'human', 'bingx',
   'serving', 'active', '{"fixture_owner":"keep"}'),
  (4, 'bybit_copytrade', 4, 'futures', 'mixed', 'bybit_copytrade',
   'serving', 'active', '{"fixture_owner":"keep"}'),
  (5, 'binance_web3_bsc', 5, 'onchain', 'human', 'binance_web3',
   'serving', 'active', '{"fixture_owner":"keep"}'),
  (6, 'kucoin_futures', 6, 'futures', 'mixed', 'kucoin',
   'serving', 'active', '{"fixture_owner":"keep"}'),
  (7, 'bitunix_futures', 7, 'futures', 'human', 'bitunix',
   'serving', 'active', '{"fixture_owner":"keep"}'),
  (8, 'phemex_futures', 8, 'futures', 'mixed', 'phemex',
   'serving', 'active', '{"fixture_owner":"keep"}'),
  (9, 'btcc_futures', 9, 'futures', 'human', 'btcc',
   'shadow', 'inactive', '{"fixture_owner":"keep"}'),
  (10, 'lbank_futures', 10, 'futures', 'human', 'lbank',
   'serving', 'active', '{"fixture_owner":"keep"}'),
  (11, 'blofin_futures', 11, 'futures', 'mixed', 'blofin',
   'serving', 'active', '{"fixture_owner":"keep"}'),
  (12, 'xt_futures', 12, 'futures', 'human', 'xt',
   'serving', 'active', '{"fixture_owner":"keep"}'),
  (13, 'coinex_futures', 13, 'futures', 'human', 'coinex',
   'shadow', 'inactive', '{"fixture_owner":"keep"}'),
  (14, 'htx_futures', 14, 'futures', 'human', 'htx',
   'serving', 'active', '{"fixture_owner":"unrelated"}');

CREATE TABLE public.expected_serving_state AS
SELECT id, status, serving_mode
FROM arena.sources;
SQL

psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
DO $assert$
DECLARE
  v_exact integer;
  v_state_drift integer;
  v_meta_drift integer;
  v_constraint integer;
BEGIN
  SELECT pg_catalog.count(*)::integer
  INTO v_exact
  FROM (
    VALUES
      ('mexc_futures'::text, 'mexc'::text),
      ('gate_futures', 'gateio'),
      ('bingx_futures', 'bingx'),
      ('bybit_copytrade', 'bybit'),
      ('binance_web3_bsc', 'binance_web3'),
      ('kucoin_futures', 'kucoin'),
      ('bitunix_futures', 'bitunix'),
      ('phemex_futures', 'phemex'),
      ('btcc_futures', 'btcc'),
      ('lbank_futures', 'lbank'),
      ('blofin_futures', 'blofin'),
      ('xt_futures', 'xt'),
      ('coinex_futures', 'coinex')
  ) AS expected(slug, legacy_platform)
  JOIN arena.sources AS source
    ON source.slug = expected.slug
   AND source.meta->>'legacy_platform' = expected.legacy_platform;

  SELECT pg_catalog.count(*)::integer
  INTO v_state_drift
  FROM arena.sources AS source
  JOIN public.expected_serving_state AS expected USING (id)
  WHERE source.status IS DISTINCT FROM expected.status
     OR source.serving_mode IS DISTINCT FROM expected.serving_mode;

  SELECT pg_catalog.count(*)::integer
  INTO v_meta_drift
  FROM arena.sources AS source
  WHERE source.meta->>'fixture_owner' IS DISTINCT FROM
    CASE WHEN source.slug = 'htx_futures' THEN 'unrelated' ELSE 'keep' END;

  SELECT pg_catalog.count(*)::integer
  INTO v_constraint
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'arena.sources'::pg_catalog.regclass
    AND constraint_row.conname = 'sources_active_legacy_platform_alias_contract'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;

  IF v_exact <> 13 THEN
    RAISE EXCEPTION 'canonical alias contract count drifted: %', v_exact;
  END IF;
  IF v_state_drift <> 0 THEN
    RAISE EXCEPTION 'successful migration changed source serving state';
  END IF;
  IF v_meta_drift <> 0 THEN
    RAISE EXCEPTION 'successful migration overwrote unrelated source metadata';
  END IF;
  IF v_constraint <> 1 THEN
    RAISE EXCEPTION 'alias contract constraint is missing or unvalidated';
  END IF;
END
$assert$;
SQL

CANONICAL_DIGEST="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.md5(
      pg_catalog.string_agg(
        pg_catalog.concat_ws(
          '|',
          id::text,
          slug,
          exchange_id::text,
          product_type,
          trader_kind_scope,
          adapter_slug,
          serving_mode,
          status,
          meta::text
        ),
        E'\\n' ORDER BY id
      )
    )
    FROM arena.sources;
  "
)"
psql_cmd -q -f "$MIGRATION"
REPLAY_DIGEST="$(
  psql_cmd -Atqc "
    SELECT pg_catalog.md5(
      pg_catalog.string_agg(
        pg_catalog.concat_ws(
          '|',
          id::text,
          slug,
          exchange_id::text,
          product_type,
          trader_kind_scope,
          adapter_slug,
          serving_mode,
          status,
          meta::text
        ),
        E'\\n' ORDER BY id
      )
    )
    FROM arena.sources;
  "
)"
if [[ "$CANONICAL_DIGEST" != "$REPLAY_DIGEST" ]]; then
  echo "replayed migration changed the canonical alias contract" >&2
  exit 1
fi

expect_sql_failure \
  'active alias removal' \
  'sources_active_legacy_platform_alias_contract' \
  "UPDATE arena.sources SET meta = meta - 'legacy_platform' WHERE slug = 'gate_futures';"

psql_cmd -q -c "
  UPDATE arena.sources
  SET status = 'inactive',
      meta = meta - 'legacy_platform'
  WHERE slug = 'gate_futures';
"
expect_sql_failure \
  'reactivating drifted inactive alias' \
  'sources_active_legacy_platform_alias_contract' \
  "UPDATE arena.sources SET status = 'active' WHERE slug = 'gate_futures';"
psql_cmd -q -f "$MIGRATION"
psql_cmd -q -c "
  UPDATE arena.sources
  SET status = 'active'
  WHERE slug = 'gate_futures';
"

# A present conflicting value must abort before another absent alias is repaired.
psql_cmd -q -c "
  UPDATE arena.sources
  SET meta = pg_catalog.jsonb_set(meta, '{legacy_platform}', '\"coinex_drift\"'::jsonb)
  WHERE slug = 'coinex_futures';
  UPDATE arena.sources
  SET meta = meta - 'legacy_platform'
  WHERE slug = 'btcc_futures';
"
expect_migration_failure \
  'existing alias conflict' \
  'existing legacy_platform conflicts with the reviewed alias for coinex_futures'
if [[ "$(psql_cmd -Atqc "SELECT meta ? 'legacy_platform' FROM arena.sources WHERE slug='btcc_futures'")" != 'f' ]]; then
  echo "conflicting migration partially repaired another source" >&2
  exit 1
fi
psql_cmd -q -c "
  UPDATE arena.sources
  SET meta = pg_catalog.jsonb_set(meta, '{legacy_platform}', '\"coinex\"'::jsonb)
  WHERE slug = 'coinex_futures';
"
psql_cmd -q -f "$MIGRATION"

psql_cmd -q -c "
  INSERT INTO arena.sources (
    id, slug, exchange_id, product_type, trader_kind_scope, adapter_slug,
    serving_mode, status, meta
  ) VALUES (
    15, 'rogue_alias_owner', 14, 'futures', 'human', 'htx',
    'legacy', 'inactive', '{\"legacy_platform\":\"mexc\"}'::jsonb
  );
"
expect_migration_failure \
  'protected alias collision' \
  'protected legacy-platform namespace conflict for mexc_futures'
psql_cmd -q -c "DELETE FROM arena.sources WHERE id = 15;"

psql_cmd -q -c "
  INSERT INTO arena.sources (
    id, slug, exchange_id, product_type, trader_kind_scope, adapter_slug,
    serving_mode, status, meta
  ) VALUES (
    16, 'rogue_canonical_owner', 14, 'futures', 'human', 'htx',
    'legacy', 'inactive', '{\"legacy_platform\":\"mexc_futures\"}'::jsonb
  );
"
expect_migration_failure \
  'protected canonical slug collision' \
  'protected legacy-platform namespace conflict for mexc_futures'
psql_cmd -q -c "DELETE FROM arena.sources WHERE id = 16;"

psql_cmd -q -c "
  UPDATE arena.sources
  SET adapter_slug = 'coinex_drift'
  WHERE slug = 'coinex_futures';
"
expect_migration_failure \
  'legacy-platform source identity drifted' \
  'legacy-platform source identity drifted for coinex_futures'
psql_cmd -q -c "
  UPDATE arena.sources
  SET adapter_slug = 'coinex'
  WHERE slug = 'coinex_futures';
"

# Replay the actual historical registry seed, not only the focused fixture.
# This is the deployment mode that was broken: every alias key begins absent.
psql_cmd -q -c "CREATE ROLE anon;"
psql_cmd -q -c "CREATE ROLE authenticated;"
psql_cmd -q -c "CREATE ROLE service_role;"
psql_cmd -q -c "CREATE DATABASE seed_replay;"
psql_seed_cmd -q -f "$SEED_MIGRATION"
psql_seed_cmd -q -c "
  CREATE TABLE public.seed_meta_before AS
  SELECT slug, meta
  FROM arena.sources;
"
psql_seed_cmd -q -f "$MIGRATION"
if [[ "$(psql_seed_cmd -Atqc "SELECT count(*) FROM arena.sources WHERE meta ? 'legacy_platform';")" != '13' ]]; then
  echo "fresh seed alias replay did not produce thirteen exact mappings" >&2
  exit 1
fi
if [[ "$(psql_seed_cmd -Atqc "
  SELECT count(*)
  FROM arena.sources AS source
  JOIN public.seed_meta_before AS before USING (slug)
  WHERE source.meta - 'legacy_platform' IS DISTINCT FROM before.meta;
")" != '0' ]]; then
  echo "fresh seed alias replay overwrote seeded source metadata" >&2
  exit 1
fi

echo "fresh seed alias replay passed"
echo "source legacy-platform alias contract PostgreSQL 17 proof passed"
