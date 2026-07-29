#!/usr/bin/env bash

# PostgreSQL 17 integration proof for the Bitget bot canonical source contract
# and the public bot-header reader. The proof owns an isolated temporary cluster
# and never touches a developer or production database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
TIMEFRAME_MIGRATION="$ROOT_DIR/supabase/migrations/20260728122000_bitget_bots_canonical_timeframe.sql"
HEADER_MIGRATION="$ROOT_DIR/supabase/migrations/20260728123000_arena_bot_header_canonical_snapshot.sql"
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
for migration in "$TIMEFRAME_MIGRATION" "$HEADER_MIGRATION"; do
  if [[ ! -f "$migration" ]]; then
    echo "Migration not found: $migration" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/bitget-bots-canonical-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
WRITER_FIFO="$TMP_ROOT/registry-writer.sql"
WRITER_LOG="$TMP_ROOT/registry-writer.log"
CONCURRENT_MIGRATION_LOG="$TMP_ROOT/concurrent-migration.log"
PORT="${PGPORT_OVERRIDE:-$((59000 + ($$ % 5000)))}"
WRITER_PID=""
MIGRATION_PID=""
WRITER_FD_OPEN=0
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if ((WRITER_FD_OPEN)); then
    exec 3>&- || true
    WRITER_FD_OPEN=0
  fi
  for child_pid in "$WRITER_PID" "$MIGRATION_PID"; do
    if [[ -n "$child_pid" ]]; then
      kill "$child_pid" >/dev/null 2>&1 || true
    fi
  done
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    for diagnostic in "$WRITER_LOG" "$CONCURRENT_MIGRATION_LOG" "$LOG_FILE"; do
      if [[ -f "$diagnostic" ]]; then
        echo "Diagnostic: $diagnostic" >&2
        tail -200 "$diagnostic" >&2 || true
      fi
    done
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -U postgres -d postgres "$@"
}

expect_failure() {
  local label="$1"
  local sql="$2"
  if psql_cmd -q -c "$sql" >"$ERROR_FILE" 2>&1; then
    echo "$label unexpectedly succeeded" >&2
    exit 1
  fi
  if ! rg -q "sources_active_bitget_bots_canonical_board_contract" "$ERROR_FILE"; then
    echo "$label failed for an unexpected reason" >&2
    sed -n '1,160p' "$ERROR_FILE" >&2
    exit 1
  fi
}

wait_for_query_value() {
  local label="$1"
  local expected="$2"
  local sql="$3"
  local actual=""
  local attempt
  for attempt in {1..200}; do
    actual="$(psql_cmd -Atqc "$sql")"
    if [[ "$actual" == "$expected" ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "$label timed out; expected $expected, got $actual" >&2
  exit 1
}

assert_canonical_sources() {
  local label="$1"
  local result
  result="$(
    psql_cmd -Atqc "
      SELECT
        (
          SELECT pg_catalog.count(*)::text
          FROM arena.sources AS source
          WHERE source.slug IN ('bitget_bots_futures', 'bitget_bots_spot')
            AND source.status = 'active'
            AND source.adapter_slug = 'bitget_bots'
            AND source.trader_kind_scope = 'bot'
            AND source.serving_mode = 'serving'
            AND source.currency = 'USDT'
            AND source.timeframes_native = ARRAY[30]::integer[]
            AND source.timeframes_derived = ARRAY[]::integer[]
            AND source.page_size = 20
            AND source.pagination_kind = 'numeric'
            AND source.meta->'boards' = CASE source.slug
              WHEN 'bitget_bots_futures' THEN
                '[\"futures_grid\", \"futures_martingale\"]'::jsonb
              ELSE '[\"spot_grid\", \"spot_martingale\"]'::jsonb
            END
        )
        || '|' ||
        (
          SELECT pg_catalog.count(*)::text
          FROM pg_catalog.pg_constraint AS constraint_row
          WHERE constraint_row.conrelid = 'arena.sources'::pg_catalog.regclass
            AND constraint_row.conname =
                'sources_active_bitget_bots_canonical_board_contract'
            AND constraint_row.contype = 'c'
            AND constraint_row.convalidated
        );
    "
  )"
  if [[ "$result" != "2|1" ]]; then
    echo "$label did not preserve two exact canonical sources and one validated constraint: $result" >&2
    exit 1
  fi
}

"$PG_BIN/initdb" \
  -D "$DATA_DIR" \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --username=postgres \
  --no-locale >/dev/null
"$PG_BIN/pg_ctl" \
  -D "$DATA_DIR" \
  -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE outsider NOLOGIN NOBYPASSRLS;
CREATE SCHEMA arena;

CREATE TABLE arena.exchanges (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL
);

CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text UNIQUE NOT NULL,
  exchange_id smallint NOT NULL REFERENCES arena.exchanges(id),
  product_type text NOT NULL,
  trader_kind_scope text NOT NULL,
  adapter_slug text NOT NULL,
  status text NOT NULL,
  timeframes_native integer[] NOT NULL,
  timeframes_derived integer[] NOT NULL,
  page_size integer,
  pagination_kind text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  serving_mode text NOT NULL,
  currency text NOT NULL,
  cadence_tier_a interval NOT NULL
);

CREATE TABLE arena.leaderboard_snapshots (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  timeframe smallint NOT NULL,
  scraped_at timestamptz NOT NULL,
  actual_count integer NOT NULL,
  count_check_passed boolean NOT NULL,
  is_derived boolean NOT NULL
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL,
  nickname text,
  trader_kind text NOT NULL,
  bot_strategy text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at timestamptz NOT NULL
);

CREATE TABLE arena.leaderboard_entries (
  snapshot_id bigint NOT NULL REFERENCES arena.leaderboard_snapshots(id),
  scraped_at timestamptz NOT NULL,
  timeframe smallint NOT NULL,
  trader_id bigint NOT NULL REFERENCES arena.traders(id)
);

CREATE TABLE arena.bots (
  source_id smallint NOT NULL REFERENCES arena.sources(id),
  exchange_bot_id text NOT NULL,
  pair text NOT NULL
);

INSERT INTO arena.exchanges (id, slug) VALUES
  (1, 'bitget'),
  (2, 'other');

INSERT INTO arena.sources (
  id,
  slug,
  exchange_id,
  product_type,
  trader_kind_scope,
  adapter_slug,
  status,
  timeframes_native,
  timeframes_derived,
  page_size,
  pagination_kind,
  meta,
  serving_mode,
  currency,
  cadence_tier_a
) VALUES
  (
    1,
    'bitget_bots_futures',
    1,
    'futures',
    'bot',
    'bitget_bots',
    'active',
    ARRAY[7, 30, 90],
    ARRAY[]::integer[],
    NULL,
    'infinite_scroll',
    '{"boards":["futures_grid","futures_martingale"]}',
    'serving',
    'USDT',
    interval '6 hours'
  ),
  (
    2,
    'bitget_bots_spot',
    1,
    'spot',
    'bot',
    'bitget_bots',
    'active',
    ARRAY[7, 30, 90],
    ARRAY[]::integer[],
    NULL,
    'infinite_scroll',
    '{"boards":["spot_grid","spot_martingale"]}',
    'serving',
    'USDT',
    interval '6 hours'
  ),
  (
    3,
    'bitget_futures',
    1,
    'futures',
    'human',
    'bitget',
    'active',
    ARRAY[30],
    ARRAY[]::integer[],
    20,
    'numeric',
    '{"legacy_platform":"bitget"}',
    'serving',
    'USDT',
    interval '6 hours'
  );

INSERT INTO arena.bots (source_id, exchange_bot_id, pair)
VALUES (1, '9001001', 'DECOY');

CREATE FUNCTION public.arena_bot_header(
  p_source text,
  p_trader_key text
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'pair',
    bot.pair,
    'legacy',
    true
  )
  FROM arena.bots AS bot
  JOIN arena.sources AS source
    ON source.id = bot.source_id
  WHERE source.slug = p_source
    AND bot.exchange_bot_id = p_trader_key
  LIMIT 1;
$function$;
SQL

# A concurrent registry writer commits an unexpected active source while the
# migration is starting. The first SHARE lock must wait for it before the
# REPEATABLE READ snapshot, so the migration sees the committed row and fails.
mkfifo "$WRITER_FIFO"
PGAPPNAME=bitget-registry-writer psql_cmd -q \
  <"$WRITER_FIFO" >"$WRITER_LOG" 2>&1 &
WRITER_PID=$!
exec 3>"$WRITER_FIFO"
WRITER_FD_OPEN=1
printf '%s\n' \
  'BEGIN;' \
  "INSERT INTO arena.sources (
     id, slug, exchange_id, product_type, trader_kind_scope, adapter_slug,
     status, timeframes_native, timeframes_derived, page_size, pagination_kind,
     meta, serving_mode, currency, cadence_tier_a
   ) VALUES (
     4, 'bitget_bots_concurrent_probe', 1, 'futures', 'human', 'bitget_bots',
     'active', ARRAY[30], ARRAY[]::integer[], 20, 'numeric',
     '{\"boards\":[\"probe\"]}', 'serving', 'USDT', interval '6 hours'
   );" >&3

wait_for_query_value \
  "concurrent registry writer lock" \
  "1" \
  "SELECT pg_catalog.count(*)
     FROM pg_catalog.pg_locks AS held_lock
     JOIN pg_catalog.pg_stat_activity AS activity
       ON activity.pid = held_lock.pid
    WHERE activity.application_name = 'bitget-registry-writer'
      AND held_lock.relation = 'arena.sources'::pg_catalog.regclass
      AND held_lock.mode = 'RowExclusiveLock'
      AND held_lock.granted;"

set +e
PGAPPNAME=bitget-canonical-migration psql_cmd -q \
  -f "$TIMEFRAME_MIGRATION" >"$CONCURRENT_MIGRATION_LOG" 2>&1 &
MIGRATION_PID=$!
set -e

wait_for_query_value \
  "canonical migration SHARE lock wait" \
  "1" \
  "SELECT pg_catalog.count(*)
     FROM pg_catalog.pg_locks AS waiting_lock
     JOIN pg_catalog.pg_stat_activity AS activity
       ON activity.pid = waiting_lock.pid
    WHERE activity.application_name = 'bitget-canonical-migration'
      AND waiting_lock.relation = 'arena.sources'::pg_catalog.regclass
      AND waiting_lock.mode = 'ShareLock'
      AND NOT waiting_lock.granted;"

printf '%s\n' 'COMMIT;' '\q' >&3
exec 3>&-
WRITER_FD_OPEN=0
if ! wait "$WRITER_PID"; then
  echo "concurrent registry writer failed" >&2
  exit 1
fi
WRITER_PID=""

if wait "$MIGRATION_PID"; then
  echo "migration missed the concurrently committed unexpected source" >&2
  exit 1
fi
MIGRATION_PID=""
if ! rg -q \
  "unexpected active Bitget bot source requires an explicit canonical timeframe review" \
  "$CONCURRENT_MIGRATION_LOG"; then
  echo "concurrent migration failed for an unexpected reason" >&2
  sed -n '1,200p' "$CONCURRENT_MIGRATION_LOG" >&2
  exit 1
fi

psql_cmd -q -c \
  "DELETE FROM arena.sources WHERE slug = 'bitget_bots_concurrent_probe';"

# First application converges the reviewed historical seed; replay must be a
# no-op that leaves the same exact validated contract.
psql_cmd -q -f "$TIMEFRAME_MIGRATION"
assert_canonical_sources "initial timeframe migration"
psql_cmd -q -f "$TIMEFRAME_MIGRATION"
assert_canonical_sources "replayed timeframe migration"

expect_failure \
  "active page_size NULL drift" \
  "UPDATE arena.sources SET page_size = NULL
    WHERE slug = 'bitget_bots_futures';"
expect_failure \
  "active pagination NULL drift" \
  "UPDATE arena.sources SET pagination_kind = NULL
    WHERE slug = 'bitget_bots_futures';"
expect_failure \
  "active boards deletion drift" \
  "UPDATE arena.sources SET meta = meta - 'boards'
    WHERE slug = 'bitget_bots_futures';"
expect_failure \
  "active native timeframe drift" \
  "UPDATE arena.sources SET timeframes_native = ARRAY[7, 30, 90]::integer[]
    WHERE slug = 'bitget_bots_futures';"
expect_failure \
  "active serving-mode drift" \
  "UPDATE arena.sources SET serving_mode = 'shadow'
    WHERE slug = 'bitget_bots_futures';"
expect_failure \
  "active currency drift" \
  "UPDATE arena.sources SET currency = 'USD'
    WHERE slug = 'bitget_bots_futures';"
expect_failure \
  "active target adapter drift" \
  "UPDATE arena.sources SET adapter_slug = 'bitget_bots_v2'
    WHERE slug = 'bitget_bots_futures';"
expect_failure \
  "active unexpected bitget_bots human scope" \
  "INSERT INTO arena.sources (
     id, slug, exchange_id, product_type, trader_kind_scope, adapter_slug,
     status, timeframes_native, timeframes_derived, page_size, pagination_kind,
     meta, serving_mode, currency, cadence_tier_a
   ) VALUES (
     4, 'bitget_bots_human_probe', 1, 'futures', 'human', 'bitget_bots',
     'active', ARRAY[30], ARRAY[]::integer[], 20, 'numeric',
     '{\"boards\":[\"probe\"]}', 'serving', 'USDT', interval '6 hours'
   );"

# Operators can deactivate a source before maintenance. While inactive, the
# canonical fields may be repaired without disabling or dropping the fence.
psql_cmd -q <<'SQL'
UPDATE arena.sources
SET status = 'inactive',
    timeframes_native = ARRAY[7, 30, 90]::integer[],
    page_size = NULL,
    pagination_kind = NULL,
    meta = meta - 'boards',
    serving_mode = 'shadow',
    currency = 'USD'
WHERE slug = 'bitget_bots_futures';

DO $assert_inactive$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM arena.sources
    WHERE slug = 'bitget_bots_futures'
      AND status = 'inactive'
      AND page_size IS NULL
      AND pagination_kind IS NULL
      AND NOT (meta ? 'boards')
  ) THEN
    RAISE EXCEPTION 'canonical source could not be deactivated for maintenance';
  END IF;
END
$assert_inactive$;

UPDATE arena.sources
SET timeframes_native = ARRAY[30]::integer[],
    page_size = 20,
    pagination_kind = 'numeric',
    meta = jsonb_set(
      meta,
      '{boards}',
      '["futures_grid","futures_martingale"]'::jsonb,
      true
    ),
    serving_mode = 'serving',
    currency = 'USDT'
WHERE slug = 'bitget_bots_futures';

UPDATE arena.sources
SET status = 'active'
WHERE slug = 'bitget_bots_futures';
SQL
assert_canonical_sources "deactivate-repair-reactivate cycle"

psql_cmd -q <<'SQL'
CREATE FUNCTION public.test_bot_document(
  p_exchange_bot_id text,
  p_owner_account_id text,
  p_owner_name text,
  p_pair text,
  p_product_type text,
  p_strategy text
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT pg_catalog.jsonb_build_object(
    'exchange_bot_id', p_exchange_bot_id,
    'product_id', '701',
    'owner_account_id', p_owner_account_id,
    'owner_name', p_owner_name,
    'pair', p_pair,
    'product_type', p_product_type,
    'strategy', p_strategy,
    'direction', 'long',
    'created_at_origin', '2026-07-01T00:00:00.000Z',
    'runtime_days', 27,
    'profit_share_rate', 12.5,
    'status', 'running'
  );
$function$;

INSERT INTO arena.traders (
  id,
  source_id,
  exchange_trader_id,
  nickname,
  trader_kind,
  bot_strategy,
  meta,
  last_seen_at
) VALUES
  (
    1001,
    1,
    '9001001',
    NULL,
    'bot',
    'grid',
    pg_catalog.jsonb_build_object(
      'bot',
      public.test_bot_document(
        '9001001', 'owner-42', 'Payload Owner', 'BTCUSDT', 'futures', 'grid'
      )
    ),
    pg_catalog.clock_timestamp()
  ),
  (
    1002,
    1,
    '9001002',
    NULL,
    'bot',
    'martingale',
    pg_catalog.jsonb_build_object(
      'bot',
      public.test_bot_document(
        '9001002', 'missing-owner', 'Captured Owner', 'ETHUSDT', 'futures', 'martingale'
      )
    ),
    pg_catalog.clock_timestamp()
  ),
  (
    1003,
    1,
    '9001003',
    NULL,
    'bot',
    'grid',
    pg_catalog.jsonb_build_object(
      'bot',
      public.test_bot_document(
        '9001003', NULL, 'Malformed Owner', 'XRPUSDT', 'spot', 'grid'
      )
    ),
    pg_catalog.clock_timestamp()
  ),
  (
    1004,
    1,
    '9001004',
    NULL,
    'bot',
    'grid',
    pg_catalog.jsonb_build_object(
      'bot',
      public.test_bot_document(
        '9001004', NULL, 'Poison Owner', 'SOLUSDT', 'futures', 'grid'
      ) || '{"unexpected":"poison"}'::jsonb
    ),
    pg_catalog.clock_timestamp()
  ),
  (
    1005,
    1,
    '9001005',
    NULL,
    'bot',
    'grid',
    pg_catalog.jsonb_build_object(
      'bot',
      public.test_bot_document(
        '9001005', NULL, 'Retired Owner', 'ADAUSDT', 'futures', 'grid'
      )
    ),
    pg_catalog.clock_timestamp()
  ),
  (
    1006,
    1,
    '9001006',
    NULL,
    'bot',
    'grid',
    pg_catalog.jsonb_build_object(
      'bot',
      public.test_bot_document(
        '9001006', NULL, 'Failed Owner', 'DOGEUSDT', 'futures', 'grid'
      )
    ),
    pg_catalog.clock_timestamp()
  ),
  (
    1007,
    1,
    '9001007',
    NULL,
    'bot',
    'grid',
    pg_catalog.jsonb_build_object(
      'bot',
      public.test_bot_document(
        '9001007', NULL, 'Derived Owner', 'BNBUSDT', 'futures', 'grid'
      )
    ),
    pg_catalog.clock_timestamp()
  ),
  (
    2001,
    2,
    '9100001',
    NULL,
    'bot',
    'martingale',
    pg_catalog.jsonb_build_object(
      'bot',
      public.test_bot_document(
        '9100001', NULL, 'Spot Owner', 'BTCUSDT', 'spot', 'martingale'
      )
    ),
    pg_catalog.clock_timestamp()
  ),
  (
    3001,
    3,
    'owner-42',
    'Verified Owner',
    'human',
    NULL,
    '{}'::jsonb,
    pg_catalog.clock_timestamp()
  );

DROP FUNCTION public.test_bot_document(text, text, text, text, text, text);

INSERT INTO arena.leaderboard_snapshots (
  id,
  source_id,
  timeframe,
  scraped_at,
  actual_count,
  count_check_passed,
  is_derived
) VALUES
  (101, 1, 30, pg_catalog.clock_timestamp() - interval '4 hours', 1, true, false),
  (102, 1, 30, pg_catalog.clock_timestamp() - interval '3 hours', 4, true, false),
  (103, 1, 30, pg_catalog.clock_timestamp() - interval '2 hours', 1, false, false),
  (104, 1, 30, pg_catalog.clock_timestamp() - interval '1 hour', 1, true, true),
  (201, 2, 30, pg_catalog.clock_timestamp() - interval '2 hours', 1, true, false);

INSERT INTO arena.leaderboard_entries (
  snapshot_id,
  scraped_at,
  timeframe,
  trader_id
)
SELECT
  snapshot.id,
  snapshot.scraped_at,
  snapshot.timeframe,
  membership.trader_id
FROM arena.leaderboard_snapshots AS snapshot
JOIN (
  VALUES
    (101::bigint, 1005::bigint),
    (102::bigint, 1001::bigint),
    (102::bigint, 1002::bigint),
    (102::bigint, 1003::bigint),
    (102::bigint, 1004::bigint),
    (103::bigint, 1006::bigint),
    (104::bigint, 1007::bigint),
    (201::bigint, 2001::bigint)
) AS membership(snapshot_id, trader_id)
  ON membership.snapshot_id = snapshot.id;
SQL

LEGACY_RESULT="$(
  psql_cmd -Atqc "
    SELECT public.arena_bot_header(
      'bitget_bots_futures',
      '9001001'
    )->>'pair';
  "
)"
if [[ "$LEGACY_RESULT" != "DECOY" ]]; then
  echo "legacy arena_bot_header fixture did not read arena.bots: $LEGACY_RESULT" >&2
  exit 1
fi

psql_cmd -q -f "$HEADER_MIGRATION"
psql_cmd -q -f "$HEADER_MIGRATION"

# A non-CASCADE drop proves the replaced function has no retained relation
# dependency. All following successful calls prove it also performs no runtime
# read from the retired projection.
psql_cmd -q -c "DROP TABLE arena.bots;"

psql_cmd -q <<'SQL'
DO $assert_header$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.arena_bot_header('bitget_bots_futures', '9001001');
  IF v_result IS NULL
     OR v_result->>'bot_id' <> '9001001'
     OR v_result->>'pair' <> 'BTCUSDT'
     OR v_result->>'product_type' <> 'futures'
     OR v_result->>'bot_strategy' <> 'grid'
     OR v_result->>'owner_nickname' <> 'Verified Owner'
     OR v_result->>'owner_trader_key' <> 'owner-42'
     OR v_result->>'owner_platform' <> 'bitget'
     OR v_result->>'canonical_timeframe' <> '30'
     OR v_result->>'is_current' <> 'true'
     OR v_result->>'is_fresh' <> 'true'
     OR v_result->>'freshness' <> 'fresh'
     OR v_result->>'snapshot_as_of' IS NULL
     OR v_result->>'fresh_until' IS NULL THEN
    RAISE EXCEPTION 'canonical current bot header mismatch: %', v_result;
  END IF;

  v_result := public.arena_bot_header('bitget_bots_futures', '9001002');
  IF v_result IS NULL
     OR v_result->>'pair' <> 'ETHUSDT'
     OR v_result->>'owner_nickname' <> 'Captured Owner'
     OR v_result->'owner_trader_key' IS DISTINCT FROM 'null'::jsonb THEN
    RAISE EXCEPTION 'captured owner fallback mismatch: %', v_result;
  END IF;

  IF public.arena_bot_header('bitget_bots_futures', '9001005') IS NOT NULL THEN
    RAISE EXCEPTION 'retired old-snapshot membership remained current';
  END IF;
  IF public.arena_bot_header('bitget_bots_futures', '9001006') IS NOT NULL THEN
    RAISE EXCEPTION 'failed-snapshot membership became current';
  END IF;
  IF public.arena_bot_header('bitget_bots_futures', '9001007') IS NOT NULL THEN
    RAISE EXCEPTION 'derived-snapshot membership became current';
  END IF;
  IF public.arena_bot_header('bitget_bots_futures', '9001003') IS NOT NULL THEN
    RAISE EXCEPTION 'product-mismatched bot metadata did not fail closed';
  END IF;
  IF public.arena_bot_header('bitget_bots_futures', '9001004') IS NOT NULL THEN
    RAISE EXCEPTION 'extra bot metadata did not fail closed';
  END IF;

  v_result := public.arena_bot_header('bitget_bots_spot', '9100001');
  IF v_result IS NULL
     OR v_result->>'product_type' <> 'spot'
     OR v_result->>'bot_strategy' <> 'martingale'
     OR v_result->>'owner_nickname' <> 'Spot Owner' THEN
    RAISE EXCEPTION 'spot bot header mismatch: %', v_result;
  END IF;

  IF public.arena_bot_header('bitget_bots', '9001001') IS NOT NULL
     OR public.arena_bot_header('bitget_bots_futures', 'missing') IS NOT NULL
     OR public.arena_bot_header('bitget_bots_futures ', '9001001') IS NOT NULL THEN
    RAISE EXCEPTION 'invalid or unknown identity did not fail closed';
  END IF;
END
$assert_header$;
SQL

ACL_RESULT="$(
  psql_cmd -Atqc "
    SELECT
      pg_catalog.has_function_privilege(
        'anon',
        'public.arena_bot_header(text,text)',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'authenticated',
        'public.arena_bot_header(text,text)',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'service_role',
        'public.arena_bot_header(text,text)',
        'EXECUTE'
      ) || '|' ||
      pg_catalog.has_function_privilege(
        'outsider',
        'public.arena_bot_header(text,text)',
        'EXECUTE'
      );
  "
)"
if [[ "$ACL_RESULT" != "true|true|true|false" ]]; then
  echo "arena_bot_header ACL boundary mismatch: $ACL_RESULT" >&2
  exit 1
fi

ANON_RESULT="$(
  psql_cmd -Atqc "
    SET ROLE anon;
    SELECT public.arena_bot_header(
      'bitget_bots_futures',
      '9001001'
    )->>'pair';
  "
)"
if [[ "$ANON_RESULT" != "BTCUSDT" ]]; then
  echo "anon could not execute the security-definer canonical reader: $ANON_RESULT" >&2
  exit 1
fi

# The newest passed non-derived snapshot is authoritative even when its
# population is corrupt. It must fail closed instead of falling back to an
# older exact snapshot.
psql_cmd -q <<'SQL'
INSERT INTO arena.leaderboard_snapshots (
  id,
  source_id,
  timeframe,
  scraped_at,
  actual_count,
  count_check_passed,
  is_derived
) VALUES (
  105,
  1,
  30,
  pg_catalog.clock_timestamp() - interval '10 minutes',
  2,
  true,
  false
);

INSERT INTO arena.leaderboard_entries (
  snapshot_id,
  scraped_at,
  timeframe,
  trader_id
)
SELECT id, scraped_at, timeframe, 1001
FROM arena.leaderboard_snapshots
WHERE id = 105;

DO $assert_population_mismatch$
BEGIN
  IF public.arena_bot_header('bitget_bots_futures', '9001001') IS NOT NULL THEN
    RAISE EXCEPTION 'reader fell back past a corrupt latest passed snapshot';
  END IF;
END
$assert_population_mismatch$;

DELETE FROM arena.leaderboard_entries WHERE snapshot_id = 105;
DELETE FROM arena.leaderboard_snapshots WHERE id = 105;

DO $assert_population_recovery$
BEGIN
  IF public.arena_bot_header('bitget_bots_futures', '9001001')->>'pair'
     IS DISTINCT FROM 'BTCUSDT' THEN
    RAISE EXCEPTION 'reader did not recover after removing corrupt snapshot';
  END IF;
END
$assert_population_recovery$;
SQL

echo "Bitget bot canonical source and snapshot reader PostgreSQL 17 proof passed"
