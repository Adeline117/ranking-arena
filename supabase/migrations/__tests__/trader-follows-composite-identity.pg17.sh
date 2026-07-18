#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260717120000_trader_follows_composite_identity.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl postgres psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/trader-follow-composite-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55552
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)); then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_status"
}
trap cleanup EXIT

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

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_eq() {
  local actual="$1"
  local expected="$2"
  local label="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

psql_cmd -q <<'SQL'
CREATE SCHEMA arena;

CREATE TABLE public.trader_follows (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  trader_id text NOT NULL,
  source text,
  CONSTRAINT trader_follows_user_id_trader_id_key UNIQUE (user_id, trader_id)
);

CREATE TABLE public.leaderboard_ranks (
  source text NOT NULL,
  source_trader_id text NOT NULL,
  season_id text NOT NULL,
  computed_at timestamptz NOT NULL
);

CREATE TABLE arena.sources (
  id bigint PRIMARY KEY,
  slug text NOT NULL,
  status text NOT NULL,
  serving_mode text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id bigint NOT NULL REFERENCES arena.sources(id),
  exchange_trader_id text NOT NULL
);

INSERT INTO public.trader_follows (id, user_id, trader_id, source) VALUES
  ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001', 'unique-id', NULL),
  ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000002', 'ambiguous-id', NULL),
  ('10000000-0000-4000-8000-000000000003', '20000000-0000-4000-8000-000000000003', 'missing-id', NULL);

INSERT INTO public.leaderboard_ranks VALUES
  ('bybit', 'unique-id', '90D', now()),
  ('bybit', 'ambiguous-id', '90D', now()),
  ('binance_futures', 'ambiguous-id', '90D', now()),
  ('stale-source', 'unique-id', '90D', now() - interval '6 days');

INSERT INTO arena.sources (id, slug, status, serving_mode, meta) VALUES
  (1, 'bybit-source', 'active', 'serving', '{"legacy_platform":"bybit"}'),
  (2, 'inactive-source', 'inactive', 'serving', '{}');
INSERT INTO arena.traders VALUES
  (1, 1, 'unique-id'),
  (2, 2, 'missing-id');
SQL

psql_cmd -q -f "$MIGRATION"

expect_eq \
  "$(psql_cmd -Atqc "SELECT source FROM public.trader_follows WHERE trader_id='unique-id'")" \
  "bybit" \
  "unique current identity backfill"
expect_eq \
  "$(psql_cmd -Atqc "SELECT source IS NULL FROM public.trader_follows WHERE trader_id='ambiguous-id'")" \
  "t" \
  "ambiguous legacy preservation"
expect_eq \
  "$(psql_cmd -Atqc "SELECT source IS NULL FROM public.trader_follows WHERE trader_id='missing-id'")" \
  "t" \
  "unresolved legacy preservation"

# One user can follow the same raw trader id on two exchanges.
psql_cmd -q <<'SQL'
INSERT INTO public.trader_follows (id, user_id, trader_id, source) VALUES
  ('30000000-0000-4000-8000-000000000001', '40000000-0000-4000-8000-000000000001', 'shared-id', 'bybit'),
  ('30000000-0000-4000-8000-000000000002', '40000000-0000-4000-8000-000000000001', 'shared-id', 'binance_futures');
DELETE FROM public.trader_follows
WHERE user_id='40000000-0000-4000-8000-000000000001'
  AND trader_id='shared-id'
  AND source='bybit';
SQL
expect_eq \
  "$(psql_cmd -Atqc "SELECT source FROM public.trader_follows WHERE user_id='40000000-0000-4000-8000-000000000001' AND trader_id='shared-id'")" \
  "binance_futures" \
  "source-scoped delete preserves sibling account"

# Explicit IS NULL deletion removes only a legacy edge, not a sourced sibling.
psql_cmd -q <<'SQL'
INSERT INTO public.trader_follows (id, user_id, trader_id, source) VALUES
  ('50000000-0000-4000-8000-000000000001', '60000000-0000-4000-8000-000000000001', 'legacy-shared', NULL),
  ('50000000-0000-4000-8000-000000000002', '60000000-0000-4000-8000-000000000001', 'legacy-shared', 'bybit');
DELETE FROM public.trader_follows
WHERE user_id='60000000-0000-4000-8000-000000000001'
  AND trader_id='legacy-shared'
  AND source IS NULL;
SQL
expect_eq \
  "$(psql_cmd -Atqc "SELECT source FROM public.trader_follows WHERE user_id='60000000-0000-4000-8000-000000000001' AND trader_id='legacy-shared'")" \
  "bybit" \
  "legacy null delete preserves sourced sibling"

if psql_cmd -qc "
  INSERT INTO public.trader_follows (id, user_id, trader_id, source)
  VALUES (
    '30000000-0000-4000-8000-000000000003',
    '40000000-0000-4000-8000-000000000001',
    'shared-id',
    'binance_futures'
  )
" >/dev/null 2>&1; then
  echo "duplicate composite follow unexpectedly succeeded" >&2
  exit 1
fi

echo "trader follows composite identity PostgreSQL 17 proof passed"
