#!/usr/bin/env bash

# PostgreSQL 17 proof for 20261114104438: get_data_gap_summary judges gaps on
# sealed public publication, not leaderboard_ranks.computed_at. A trader with a
# freshly computed but never sealed/served rank row was gap-free before and is
# a gap now; a served trader whose source seal is old is a gap; a served trader
# with a fresh seal is not; dead platforms stay excluded.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
ORIGINAL="$ROOT_DIR/supabase/migrations/20260507125805_gap_detection_rpc.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20261114104438_sealed_publication_data_gap_summary.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done

TMP_ROOT="$(mktemp -d /tmp/sealed-gap-summary-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT="${PGPORT_OVERRIDE:-$((58000 + ($$ % 7000)))}"
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
  "$PG_BIN/psql" -X -q -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

psql_db <<'SQL'
CREATE TABLE public.trader_sources (source text NOT NULL, source_trader_id text NOT NULL);
CREATE TABLE public.leaderboard_ranks (
  season_id text NOT NULL, source text NOT NULL, source_trader_id text NOT NULL,
  computed_at timestamptz NOT NULL
);
CREATE TABLE public.leaderboard_source_freshness (
  season_id text NOT NULL, source text NOT NULL, recorded_at timestamptz NOT NULL,
  PRIMARY KEY (season_id, source)
);
-- Stand-in for the sealed public view: only rows it serves are sealed.
CREATE TABLE public.public_ranked_leaderboard (
  season_id text NOT NULL, source text NOT NULL, source_trader_id text NOT NULL
);

INSERT INTO public.trader_sources VALUES
  ('bybit', 'fresh-sealed'), ('bybit', 'unsealed'), ('okx', 'old-seal'), ('lbank', 'dead');
-- Every trader has a fresh computed_at: the old function sees no gap at all.
INSERT INTO public.leaderboard_ranks
  SELECT '90D', source, source_trader_id, now() FROM public.trader_sources;
INSERT INTO public.leaderboard_source_freshness VALUES
  ('90D', 'bybit', now() - interval '1 hour'),
  ('90D', 'okx', now() - interval '72 hours');
INSERT INTO public.public_ranked_leaderboard VALUES
  ('90D', 'bybit', 'fresh-sealed'), ('90D', 'okx', 'old-seal');
SQL

psql_db -f "$ORIGINAL"

assert_eq() {
  if [[ "$1" != "$2" ]]; then
    echo "assertion failed: $3 (expected '$2', got '$1')" >&2
    exit 1
  fi
}

summary() {
  psql_db -At -c "SELECT string_agg(source || '=' || gap_count, ',' ORDER BY source)
                    FROM public.get_data_gap_summary(48)"
}

assert_eq "$(summary)" "" "computed_at-based summary is blind to unsealed rows"

psql_db -f "$MIGRATION"
psql_db -f "$MIGRATION" # idempotent

assert_eq "$(summary)" "bybit=1,okx=1" "sealed summary reports unsealed and old-seal traders"
assert_eq "$(psql_db -At -c "SELECT max_gap_hours >= 72 FROM public.get_data_gap_summary(48) WHERE source = 'okx'")" \
  "t" "old seal age is reported"
assert_eq "$(psql_db -At -c "SELECT prosecdef FROM pg_proc WHERE oid = 'public.get_data_gap_summary(integer)'::regprocedure")" \
  "t" "function stays SECURITY DEFINER"

echo "sealed-publication-data-gap-summary pg17: OK"
