#!/usr/bin/env bash

# PostgreSQL 17 proof for generation-ordered, rollback-safe portfolio syncs.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729057000_atomic_portfolio_sync_publication.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-portfolio-sync-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
CLAIM_A_LOG="$TMP_ROOT/claim-a.log"
CLAIM_B_LOG="$TMP_ROOT/claim-b.log"
PORT="$(( 55000 + RANDOM % 5000 ))"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    for diagnostic in "$CLAIM_A_LOG" "$CLAIM_B_LOG" "$LOG_FILE"; do
      [[ -f "$diagnostic" ]] && tail -240 "$diagnostic" >&2 || true
    done
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

service_query() {
  local sql="$1"
  psql_cmd -qAtc "
    SET ROLE service_role;
    SET request.jwt.claim.role = 'service_role';
    $sql
    RESET ROLE;
  "
}

expect_value() {
  local label="$1"
  local expected="$2"
  local sql="$3"
  local actual
  actual="$(service_query "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label drifted: expected '$expected', got '$actual'" >&2
    return 1
  fi
}

expect_failure() {
  local label="$1"
  local sql="$2"
  local role="${3:-service_role}"
  local claim="${4:-service_role}"
  local output="$TMP_ROOT/expected-failure.out"
  if psql_cmd -qAtc "
    SET ROLE $role;
    SET request.jwt.claim.role = '$claim';
    $sql
    RESET ROLE;
  " >"$output" 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
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

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOINHERIT;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT pg_catalog.current_setting('request.jwt.claim.role', true)
$function$;
ALTER FUNCTION auth.role() OWNER TO postgres;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role, authenticator;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.user_portfolios (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  exchange text NOT NULL,
  api_key_encrypted text NOT NULL,
  api_secret_encrypted text NOT NULL,
  api_passphrase_encrypted text,
  label text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.user_positions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.user_portfolios(id) ON DELETE CASCADE,
  symbol text NOT NULL,
  side text NOT NULL,
  entry_price numeric NOT NULL DEFAULT 0,
  mark_price numeric NOT NULL DEFAULT 0,
  size numeric NOT NULL DEFAULT 0,
  pnl numeric NOT NULL DEFAULT 0,
  pnl_pct numeric NOT NULL DEFAULT 0,
  leverage numeric NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (portfolio_id, symbol, side)
);
CREATE TABLE public.user_portfolio_snapshots (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  portfolio_id uuid NOT NULL REFERENCES public.user_portfolios(id) ON DELETE CASCADE,
  total_equity numeric NOT NULL DEFAULT 0,
  total_pnl numeric NOT NULL DEFAULT 0,
  total_pnl_pct numeric NOT NULL DEFAULT 0,
  snapshot_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.user_portfolios OWNER TO postgres;
ALTER TABLE public.user_positions OWNER TO postgres;
ALTER TABLE public.user_portfolio_snapshots OWNER TO postgres;

ALTER TABLE public.user_portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_portfolio_snapshots ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE
  public.user_portfolios,
  public.user_positions,
  public.user_portfolio_snapshots
  TO service_role;

INSERT INTO public.user_portfolios (
  id,
  user_id,
  exchange,
  api_key_encrypted,
  api_secret_encrypted
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'bybit',
  'encrypted-key',
  'encrypted-secret'
);
SQL

psql_cmd -f "$MIGRATION" >/dev/null
psql_cmd -f "$MIGRATION" >/dev/null

ACTOR_ID="10000000-0000-4000-8000-000000000001"
OTHER_ID="10000000-0000-4000-8000-000000000002"
PORTFOLIO_ID="20000000-0000-4000-8000-000000000001"
SYNC_ONE="2026-07-29T08:34:56.789Z"
SYNC_TWO="2026-07-29T08:35:56.789Z"
SYNC_THREE="2026-07-29T08:36:56.789Z"
SYNC_FOUR="2026-07-29T08:37:56.789Z"

expect_value \
  "service-only claim ACL" \
  "f" \
  "SELECT pg_catalog.has_function_privilege(
    'authenticated',
    'public.claim_portfolio_sync_generation_atomic(uuid,uuid)',
    'EXECUTE'
  );"
expect_value \
  "service-only publication ACL" \
  "f" \
  "SELECT pg_catalog.has_function_privilege(
    'authenticated',
    'public.publish_portfolio_sync_atomic(uuid,uuid,bigint,timestamptz,jsonb,numeric,numeric,numeric)',
    'EXECUTE'
  );"
expect_failure \
  "authenticated caller cannot publish financial data" \
  "SELECT public.publish_portfolio_sync_atomic(
    '$ACTOR_ID',
    '$PORTFOLIO_ID',
    1,
    '$SYNC_ONE',
    '[]'::jsonb,
    0,
    0,
    0
  );" \
  authenticated \
  authenticated

expect_value \
  "missing owner row is a zero-row not-found result" \
  "not_found" \
  "SELECT public.claim_portfolio_sync_generation_atomic(
    '$OTHER_ID',
    '$PORTFOLIO_ID'
  ) ->> 'status';"
expect_value \
  "first generation claim" \
  "claimed|1" \
  "SELECT (result ->> 'status') || '|' || (result ->> 'generation')
   FROM (
     SELECT public.claim_portfolio_sync_generation_atomic(
       '$ACTOR_ID',
       '$PORTFOLIO_ID'
     ) AS result
   ) AS claimed;"

POSITIONS_ONE='[
  {
    "symbol": "BTC/USDT:USDT",
    "side": "long",
    "entry_price": 100,
    "mark_price": 101,
    "size": 2,
    "pnl": 2,
    "pnl_pct": 1,
    "leverage": 3
  }
]'
POSITIONS_TWO='[
  {
    "symbol": "ETH/USDT:USDT",
    "side": "short",
    "entry_price": 50,
    "mark_price": 45,
    "size": 4,
    "pnl": 20,
    "pnl_pct": 10,
    "leverage": 2
  }
]'

expect_value \
  "first atomic financial publication" \
  "published|1|1" \
  "SELECT (result ->> 'status') || '|' ||
          (result ->> 'generation') || '|' ||
          (result ->> 'position_count')
   FROM (
     SELECT public.publish_portfolio_sync_atomic(
       '$ACTOR_ID',
       '$PORTFOLIO_ID',
       1,
       '$SYNC_ONE',
       \$json\$$POSITIONS_ONE\$json\$::jsonb,
       500,
       2,
       0.4
     ) AS result
   ) AS published;"
expect_value \
  "initial publication committed all projections" \
  "1|1|1|500|1" \
  "SELECT
     portfolio.sync_generation::text || '|' ||
     portfolio.published_sync_generation::text || '|' ||
     (SELECT pg_catalog.count(*) FROM public.user_positions
       WHERE portfolio_id = portfolio.id)::text || '|' ||
     (SELECT total_equity::text FROM public.user_portfolio_snapshots
       WHERE portfolio_id = portfolio.id ORDER BY snapshot_at DESC LIMIT 1) || '|' ||
     (SELECT pg_catalog.count(*) FROM public.user_portfolio_snapshots
       WHERE portfolio_id = portfolio.id)::text
   FROM public.user_portfolios AS portfolio
   WHERE portfolio.id = '$PORTFOLIO_ID';"

# Concurrent claims serialize on the portfolio row and allocate distinct
# generations. Which caller gets 2 or 3 is irrelevant; no generation is lost.
(
  service_query "
    SELECT public.claim_portfolio_sync_generation_atomic(
      '$ACTOR_ID',
      '$PORTFOLIO_ID'
    ) ->> 'generation';
  "
) >"$CLAIM_A_LOG" 2>&1 &
CLAIM_A_PID=$!
(
  service_query "
    SELECT public.claim_portfolio_sync_generation_atomic(
      '$ACTOR_ID',
      '$PORTFOLIO_ID'
    ) ->> 'generation';
  "
) >"$CLAIM_B_LOG" 2>&1 &
CLAIM_B_PID=$!
wait "$CLAIM_A_PID"
wait "$CLAIM_B_PID"

CLAIMED_GENERATIONS="$(
  { cat "$CLAIM_A_LOG"; cat "$CLAIM_B_LOG"; } |
    sed '/^[[:space:]]*$/d' |
    sort -n |
    paste -sd, -
)"
if [[ "$CLAIMED_GENERATIONS" != "2,3" ]]; then
  echo "concurrent generation claims were not serialized: $CLAIMED_GENERATIONS" >&2
  exit 1
fi

expect_value \
  "older overlapping request cannot publish after a newer claim" \
  "superseded|2|3" \
  "SELECT (result ->> 'status') || '|' ||
          (result ->> 'generation') || '|' ||
          (result ->> 'current_generation')
   FROM (
     SELECT public.publish_portfolio_sync_atomic(
       '$ACTOR_ID',
       '$PORTFOLIO_ID',
       2,
       '$SYNC_TWO',
       \$json\$$POSITIONS_TWO\$json\$::jsonb,
       700,
       20,
       2.85
     ) AS result
   ) AS published;"
expect_value \
  "superseded request preserved last-good financial data" \
  "BTC/USDT:USDT|500|1" \
  "SELECT
     (SELECT symbol FROM public.user_positions
       WHERE portfolio_id = '$PORTFOLIO_ID') || '|' ||
     (SELECT total_equity::text FROM public.user_portfolio_snapshots
       WHERE portfolio_id = '$PORTFOLIO_ID' ORDER BY snapshot_at DESC LIMIT 1) || '|' ||
     (SELECT published_sync_generation::text FROM public.user_portfolios
       WHERE id = '$PORTFOLIO_ID');"

psql_cmd <<'SQL'
CREATE FUNCTION public.reject_portfolio_snapshot_for_test()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'injected snapshot failure';
END
$function$;
CREATE TRIGGER reject_portfolio_snapshot_for_test
BEFORE INSERT ON public.user_portfolio_snapshots
FOR EACH ROW EXECUTE FUNCTION public.reject_portfolio_snapshot_for_test();
SQL

expect_failure \
  "snapshot failure rolls back position replacement and generation watermark" \
  "SELECT public.publish_portfolio_sync_atomic(
    '$ACTOR_ID',
    '$PORTFOLIO_ID',
    3,
    '$SYNC_THREE',
    \$json\$$POSITIONS_TWO\$json\$::jsonb,
    700,
    20,
    2.85
  );"
expect_value \
  "failed publication restored every last-good projection" \
  "BTC/USDT:USDT|1|1|500" \
  "SELECT
     (SELECT symbol FROM public.user_positions
       WHERE portfolio_id = '$PORTFOLIO_ID') || '|' ||
     (SELECT published_sync_generation::text FROM public.user_portfolios
       WHERE id = '$PORTFOLIO_ID') || '|' ||
     (SELECT pg_catalog.count(*)::text FROM public.user_portfolio_snapshots
       WHERE portfolio_id = '$PORTFOLIO_ID') || '|' ||
     (SELECT total_equity::text FROM public.user_portfolio_snapshots
       WHERE portfolio_id = '$PORTFOLIO_ID' ORDER BY snapshot_at DESC LIMIT 1);"

psql_cmd -qc "
  DROP TRIGGER reject_portfolio_snapshot_for_test
    ON public.user_portfolio_snapshots;
  DROP FUNCTION public.reject_portfolio_snapshot_for_test();
"

expect_value \
  "retry publishes the exact current generation" \
  "published|3|1|1" \
  "SELECT (result ->> 'status') || '|' ||
          (result ->> 'generation') || '|' ||
          (result ->> 'position_count') || '|' ||
          (result ->> 'pruned_count')
   FROM (
     SELECT public.publish_portfolio_sync_atomic(
       '$ACTOR_ID',
       '$PORTFOLIO_ID',
       3,
       '$SYNC_THREE',
       \$json\$$POSITIONS_TWO\$json\$::jsonb,
       700,
       20,
       2.85
     ) AS result
   ) AS published;"
expect_value \
  "retry replaced the old position without a mixed generation" \
  "ETH/USDT:USDT|3|700|2" \
  "SELECT
     (SELECT symbol FROM public.user_positions
       WHERE portfolio_id = '$PORTFOLIO_ID') || '|' ||
     (SELECT published_sync_generation::text FROM public.user_portfolios
       WHERE id = '$PORTFOLIO_ID') || '|' ||
     (SELECT total_equity::text FROM public.user_portfolio_snapshots
       WHERE portfolio_id = '$PORTFOLIO_ID' ORDER BY snapshot_at DESC LIMIT 1) || '|' ||
     (SELECT pg_catalog.count(*)::text FROM public.user_portfolio_snapshots
       WHERE portfolio_id = '$PORTFOLIO_ID');"

expect_value \
  "fourth generation claim" \
  "4" \
  "SELECT public.claim_portfolio_sync_generation_atomic(
    '$ACTOR_ID',
    '$PORTFOLIO_ID'
  ) ->> 'generation';"
expect_value \
  "authoritative empty snapshot publishes zero rows" \
  "published|0|1" \
  "SELECT (result ->> 'status') || '|' ||
          (result ->> 'position_count') || '|' ||
          (result ->> 'pruned_count')
   FROM (
     SELECT public.publish_portfolio_sync_atomic(
       '$ACTOR_ID',
       '$PORTFOLIO_ID',
       4,
       '$SYNC_FOUR',
       '[]'::jsonb,
       0,
       0,
       0
     ) AS result
   ) AS published;"
expect_value \
  "zero-position publication commits one exact financial generation" \
  "0|4|0|3" \
  "SELECT
     (SELECT pg_catalog.count(*)::text FROM public.user_positions
       WHERE portfolio_id = '$PORTFOLIO_ID') || '|' ||
     portfolio.published_sync_generation::text || '|' ||
     (SELECT total_equity::text FROM public.user_portfolio_snapshots
       WHERE portfolio_id = portfolio.id ORDER BY snapshot_at DESC LIMIT 1) || '|' ||
     (SELECT pg_catalog.count(*)::text FROM public.user_portfolio_snapshots
       WHERE portfolio_id = portfolio.id)
   FROM public.user_portfolios AS portfolio
   WHERE portfolio.id = '$PORTFOLIO_ID';"

expect_value \
  "future unclaimed generation is rejected" \
  "invalid_generation" \
  "SELECT public.publish_portfolio_sync_atomic(
    '$ACTOR_ID',
    '$PORTFOLIO_ID',
    5,
    '$SYNC_FOUR',
    '[]'::jsonb,
    0,
    0,
    0
  ) ->> 'status';"
expect_value \
  "malformed active position is rejected without mutation" \
  "invalid_positions" \
  "SELECT public.publish_portfolio_sync_atomic(
    '$ACTOR_ID',
    '$PORTFOLIO_ID',
    4,
    '$SYNC_FOUR',
    '[{\"symbol\":\"BTC\",\"side\":\"flat\"}]'::jsonb,
    0,
    0,
    0
  ) ->> 'status';"
expect_value \
  "invalid and future calls preserved the published zero snapshot" \
  "0|4|3" \
  "SELECT
     (SELECT pg_catalog.count(*)::text FROM public.user_positions
       WHERE portfolio_id = portfolio.id) || '|' ||
     portfolio.published_sync_generation::text || '|' ||
     (SELECT pg_catalog.count(*)::text FROM public.user_portfolio_snapshots
       WHERE portfolio_id = portfolio.id)
   FROM public.user_portfolios AS portfolio
   WHERE portfolio.id = '$PORTFOLIO_ID';"

echo "atomic portfolio sync publication PostgreSQL 17 proof passed"
