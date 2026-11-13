#!/usr/bin/env bash

# Executable PostgreSQL 17 proof that the trader-follow hard cap holds under direct and concurrent inserts
# (BEFORE INSERT trigger + per-user advisory lock).

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20261113104533_trader_follows_hard_cap_lock.sql"
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

TMP_ROOT="$(mktemp -d /tmp/follow-cap-pg17.XXXXXX)"
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
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
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
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.trader_follows (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  trader_id text NOT NULL,
  source text,
  CONSTRAINT trader_follows_user_id_trader_id_source_key UNIQUE (user_id, trader_id, source)
);

-- A legacy user already above the cap must keep existing rows (insert-only guard).
INSERT INTO public.trader_follows (user_id, trader_id, source)
SELECT '20000000-0000-4000-8000-000000000002', 'legacy-' || g, 'bybit'
FROM generate_series(1, 120) AS g;
SQL

psql_cmd -q -f "$MIGRATION"

U1='10000000-0000-4000-8000-000000000001'

# 1. Up to the cap succeeds.
psql_cmd -q -c "
  INSERT INTO public.trader_follows (user_id, trader_id, source)
  SELECT '$U1', 't-' || g, 'binance' FROM generate_series(1, 100) AS g;
"
COUNT="$(psql_cmd -Atqc "SELECT count(*) FROM public.trader_follows WHERE user_id = '$U1'")"
[[ "$COUNT" == "100" ]] || { echo "expected 100 follows below cap, got $COUNT" >&2; exit 1; }

# 2. The 101st follow is rejected with check_violation.
STATE="$(psql_cmd -Atq -v VERBOSITY=verbose -c "
  DO \$\$ BEGIN
    INSERT INTO public.trader_follows (user_id, trader_id, source) VALUES ('$U1', 'over', 'binance');
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'CAP_HIT';
  END \$\$;
" 2>&1)"
[[ "$STATE" == *CAP_HIT* ]] || { echo "101st follow not rejected: $STATE" >&2; exit 1; }

# 3. A duplicate at the cap still surfaces as unique_violation (route: "already following").
STATE="$(psql_cmd -Atq -c "
  DO \$\$ BEGIN
    INSERT INTO public.trader_follows (user_id, trader_id, source) VALUES ('$U1', 't-1', 'binance');
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'DUPLICATE';
  END \$\$;
" 2>&1)"
[[ "$STATE" == *DUPLICATE* ]] || { echo "duplicate at cap did not raise 23505: $STATE" >&2; exit 1; }

# 4. Legacy rows above the cap are untouched; new inserts for that user are blocked.
LEGACY="$(psql_cmd -Atqc "SELECT count(*) FROM public.trader_follows WHERE user_id = '20000000-0000-4000-8000-000000000002'")"
[[ "$LEGACY" == "120" ]] || { echo "legacy rows changed: $LEGACY" >&2; exit 1; }

# 5. Two concurrent inserts at 99 follows: exactly one wins.
U3='30000000-0000-4000-8000-000000000003'
psql_cmd -q -c "
  INSERT INTO public.trader_follows (user_id, trader_id, source)
  SELECT '$U3', 'c-' || g, 'okx' FROM generate_series(1, 99) AS g;
"
race_insert() {
  psql_cmd -q -c "
    BEGIN;
    INSERT INTO public.trader_follows (user_id, trader_id, source) VALUES ('$U3', '$1', 'okx');
    SELECT pg_sleep(1.5);
    COMMIT;
  " >/dev/null 2>&1 && echo ok || echo rejected
}
race_insert race-a >"$TMP_ROOT/a" &
PID_A=$!
sleep 0.3
race_insert race-b >"$TMP_ROOT/b" &
PID_B=$!
wait "$PID_A" "$PID_B" || true
RACE="$(cat "$TMP_ROOT/a" "$TMP_ROOT/b" | sort | tr '\n' ',')"
FINAL="$(psql_cmd -Atqc "SELECT count(*) FROM public.trader_follows WHERE user_id = '$U3'")"
if [[ "$RACE" != "ok,rejected," || "$FINAL" != "100" ]]; then
  echo "concurrent follows exceeded cap: race=$RACE final=$FINAL" >&2
  exit 1
fi

echo "trader-follow hard cap PostgreSQL 17 proof passed"
