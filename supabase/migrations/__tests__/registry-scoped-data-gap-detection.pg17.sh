#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260730020000_registry_scoped_data_gap_detection.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/registry-scoped-data-gaps-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((57000 + ($$ % 8000)))}"
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

psql_cmd -q <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE ROLE postgres SUPERUSER NOLOGIN;

CREATE TABLE public.trader_sources (
  source text NOT NULL,
  source_trader_id text NOT NULL,
  PRIMARY KEY (source, source_trader_id)
);
CREATE TABLE public.leaderboard_ranks (
  source text NOT NULL,
  source_trader_id text NOT NULL,
  computed_at timestamptz NOT NULL
);

CREATE FUNCTION public.arena_freshness_expected_sources()
RETURNS TABLE(registry_slug text, filter_source text, exchange_name text, season_id text)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  VALUES
    ('lbank_futures', 'lbank', 'LBank', '7D'),
    ('lbank_futures', 'lbank', 'LBank', '30D'),
    ('bitget_spot', 'bitget_spot', 'Bitget Spot', '7D'),
    ('binance_futures', 'binance_futures', 'Binance', '7D')
$$;

INSERT INTO public.trader_sources (source, source_trader_id) VALUES
  ('lbank', 'lbank-stale'),
  ('bitget_spot', 'bitget-stale'),
  ('binance_futures', 'binance-fresh'),
  ('drift', 'blocked-source');
INSERT INTO public.leaderboard_ranks (source, source_trader_id, computed_at) VALUES
  ('bitget_spot', 'bitget-stale', pg_catalog.now() - interval '72 hours'),
  ('binance_futures', 'binance-fresh', pg_catalog.now() - interval '1 hour');
SQL

psql_cmd -q -f "$MIGRATION"

DETAILS="$(psql_cmd -Atqc "
  SELECT pg_catalog.string_agg(source || ':' || source_trader_id, ',' ORDER BY source)
  FROM public.find_data_gaps(48, 500);
")"
if [[ "$DETAILS" != "bitget_spot:bitget-stale,lbank:lbank-stale" ]]; then
  echo "registry-scoped detail membership drifted: $DETAILS" >&2
  exit 1
fi

SUMMARY="$(psql_cmd -Atqc "
  SELECT pg_catalog.string_agg(source || ':' || gap_count::text, ',' ORDER BY source)
  FROM public.get_data_gap_summary(48);
")"
if [[ "$SUMMARY" != "bitget_spot:1,lbank:1" ]]; then
  echo "registry-scoped summary membership drifted: $SUMMARY" >&2
  exit 1
fi

PRIVILEGES="$(psql_cmd -Atqc "
  SELECT
    has_function_privilege('service_role', 'public.find_data_gaps(integer,integer)', 'EXECUTE') || '|' ||
    has_function_privilege('anon', 'public.find_data_gaps(integer,integer)', 'EXECUTE') || '|' ||
    has_function_privilege('authenticated', 'public.get_data_gap_summary(integer)', 'EXECUTE');
")"
if [[ "$PRIVILEGES" != "true|false|false" ]]; then
  echo "registry-scoped data-gap privileges drifted: $PRIVILEGES" >&2
  exit 1
fi

echo "registry-scoped data gap detection PostgreSQL 17 proof passed"
