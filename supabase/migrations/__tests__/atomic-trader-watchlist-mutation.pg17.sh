#!/usr/bin/env bash

# Executable PostgreSQL 17 proof for the private watchlist authority.  It owns
# an isolated temporary cluster and never connects to a developer or remote DB.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729171500_atomic_trader_watchlist_mutation.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl postgres psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/postgres --version)" != postgres\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/atomic-watchlist-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
ADD_ONE_LOG="$TMP_ROOT/add-one.log"
ADD_TWO_LOG="$TMP_ROOT/add-two.log"
PORT="$(( 55000 + RANDOM % 5000 ))"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    for diagnostic in "$ADD_ONE_LOG" "$ADD_TWO_LOG" "$LOG_FILE"; do
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

authenticated_query() {
  local actor_id="$1"
  local sql="$2"
  psql_cmd -qAtc "
    SET ROLE authenticated;
    SET request.jwt.claim.role = 'authenticated';
    SET request.jwt.claim.sub = '$actor_id';
    $sql
    RESET ROLE;
  "
}

expect_value() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "$label drifted: expected '$expected', got '$actual'" >&2
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
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOINHERIT;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE SCHEMA arena AUTHORIZATION postgres;

CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(
    pg_catalog.current_setting('request.jwt.claim.sub', true),
    ''
  )::uuid
$function$;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT pg_catalog.current_setting('request.jwt.claim.role', true)
$function$;
ALTER FUNCTION auth.uid() OWNER TO postgres;
ALTER FUNCTION auth.role() OWNER TO postgres;
GRANT USAGE ON SCHEMA auth, arena, public
  TO anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role()
  TO anon, authenticated, service_role, authenticator;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz
);
CREATE TABLE arena.sources (
  id smallint PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  status text NOT NULL,
  serving_mode text NOT NULL,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE arena.traders (
  id bigint PRIMARY KEY,
  source_id smallint NOT NULL REFERENCES arena.sources(id) ON DELETE CASCADE,
  exchange_trader_id text NOT NULL,
  UNIQUE (source_id, exchange_trader_id)
);

ALTER TABLE auth.users OWNER TO postgres;
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE arena.sources OWNER TO postgres;
ALTER TABLE arena.traders OWNER TO postgres;

INSERT INTO auth.users (id) VALUES
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222'),
  ('33333333-3333-4333-8333-333333333333');
INSERT INTO public.user_profiles (id, deleted_at) VALUES
  ('11111111-1111-4111-8111-111111111111', NULL),
  ('22222222-2222-4222-8222-222222222222', NULL),
  ('33333333-3333-4333-8333-333333333333', pg_catalog.now());

INSERT INTO arena.sources (id, slug, status, serving_mode, meta) VALUES
  (1, 'bybit_futures', 'active', 'serving', '{"legacy_platform":"bybit"}'),
  (2, 'retired_board', 'inactive', 'legacy', '{}');
INSERT INTO arena.traders (id, source_id, exchange_trader_id) VALUES
  (1, 1, 'leader-a'),
  (2, 1, 'leader-b'),
  (3, 1, 'race-one'),
  (4, 1, 'race-two'),
  (5, 2, 'retired-leader');
SQL

# trader_watchlist is intentionally absent: the migration must restore it.
psql_cmd -q -f "$MIGRATION"

psql_cmd -q <<'SQL'
DO $proof$
BEGIN
  IF pg_catalog.to_regclass('public.trader_watchlist') IS NULL
    OR NOT pg_catalog.has_table_privilege(
      'authenticated',
      'public.trader_watchlist',
      'SELECT'
    )
    OR pg_catalog.has_table_privilege(
      'authenticated',
      'public.trader_watchlist',
      'INSERT,UPDATE,DELETE'
    )
    OR pg_catalog.has_table_privilege(
      'service_role',
      'public.trader_watchlist',
      'INSERT,UPDATE,DELETE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'authenticated',
      'public.mutate_trader_watchlist_atomic(text,text,text,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'anon',
      'public.mutate_trader_watchlist_atomic(text,text,text,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.mutate_trader_watchlist_atomic(text,text,text,text)',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'watchlist privilege boundary failed';
  END IF;
END
$proof$;

SET ROLE authenticated;
SET request.jwt.claim.role = 'authenticated';
SET request.jwt.claim.sub = '11111111-1111-4111-8111-111111111111';
DO $proof$
BEGIN
  BEGIN
    INSERT INTO public.trader_watchlist (
      user_id,
      source,
      source_trader_id
    ) VALUES (
      auth.uid(),
      'bybit',
      'direct-bypass'
    );
    RAISE EXCEPTION 'direct watchlist insert unexpectedly succeeded';
  EXCEPTION
    WHEN insufficient_privilege THEN NULL;
  END;
END
$proof$;
RESET ROLE;
SQL

ACTOR_ONE='11111111-1111-4111-8111-111111111111'
ACTOR_TWO='22222222-2222-4222-8222-222222222222'
INACTIVE_ACTOR='33333333-3333-4333-8333-333333333333'

expect_value \
  'exact add' \
  'added|1|1|Alpha' \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT
      (result->>'status') || '|' ||
      (result->>'current_count') || '|' ||
      pg_catalog.jsonb_array_length(result->'watchlist')::text || '|' ||
      (result->'watchlist'->0->>'handle')
    FROM (
      SELECT public.mutate_trader_watchlist_atomic(
        'bybit', 'leader-a', 'Alpha', 'add'
      ) AS result
    ) AS mutation;
  ")"

expect_value \
  'idempotent add and handle refresh' \
  'already_present|1|Alpha Renamed' \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT
      (result->>'status') || '|' ||
      (result->>'current_count') || '|' ||
      (result->'watchlist'->0->>'handle')
    FROM (
      SELECT public.mutate_trader_watchlist_atomic(
        'bybit', 'leader-a', 'Alpha Renamed', 'add'
      ) AS result
    ) AS mutation;
  ")"

expect_value \
  'noncanonical source rejection' \
  'invalid' \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT public.mutate_trader_watchlist_atomic(
      'ByBit', 'leader-a', NULL, 'add'
    )->>'status';
  ")"

expect_value \
  'ghost composite rejection' \
  'identity_unavailable' \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT public.mutate_trader_watchlist_atomic(
      'bybit', 'missing-leader', NULL, 'add'
    )->>'status';
  ")"

expect_value \
  'inactive account rejection' \
  'account_inactive' \
  "$(authenticated_query "$INACTIVE_ACTOR" "
    SELECT public.mutate_trader_watchlist_atomic(
      'bybit', 'leader-a', NULL, 'add'
    )->>'status';
  ")"

# A saved identity remains removable after its source leaves serving.
psql_cmd -q <<'SQL'
INSERT INTO public.trader_watchlist (
  user_id,
  source,
  source_trader_id,
  handle
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'retired_board',
  'retired-leader',
  'Retired'
);
SQL
expect_value \
  'retired identity removal' \
  'removed|1' \
  "$(authenticated_query "$ACTOR_ONE" "
    SELECT
      (result->>'status') || '|' || (result->>'current_count')
    FROM (
      SELECT public.mutate_trader_watchlist_atomic(
        'retired_board', 'retired-leader', NULL, 'remove'
      ) AS result
    ) AS mutation;
  ")"

# Fill one account to 199 using the migration owner, then race two distinct
# valid adds.  Exactly one may commit and the table may never exceed 200.
psql_cmd -q <<'SQL'
INSERT INTO public.trader_watchlist (
  user_id,
  source,
  source_trader_id,
  handle,
  created_at
)
SELECT
  '22222222-2222-4222-8222-222222222222'::uuid,
  'bybit',
  'seed-' || seed.ordinality::text,
  NULL,
  pg_catalog.now() - (seed.ordinality::text || ' seconds')::interval
FROM pg_catalog.generate_series(1, 199) WITH ORDINALITY AS seed(value, ordinality);
SQL

(
  authenticated_query "$ACTOR_TWO" "
    SELECT public.mutate_trader_watchlist_atomic(
      'bybit', 'race-one', NULL, 'add'
    )->>'status';
  "
) >"$ADD_ONE_LOG" 2>&1 &
pid_one=$!
(
  authenticated_query "$ACTOR_TWO" "
    SELECT public.mutate_trader_watchlist_atomic(
      'bybit', 'race-two', NULL, 'add'
    )->>'status';
  "
) >"$ADD_TWO_LOG" 2>&1 &
pid_two=$!

wait "$pid_one"
wait "$pid_two"

expect_value \
  'concurrent capacity outcomes' \
  $'added\nlimit_reached' \
  "$(sort "$ADD_ONE_LOG" "$ADD_TWO_LOG")"
expect_value \
  'hard capacity after race' \
  '200' \
  "$(psql_cmd -qAtc "
    SELECT pg_catalog.count(*)
    FROM public.trader_watchlist
    WHERE user_id = '$ACTOR_TWO';
  ")"

echo 'atomic trader watchlist PostgreSQL 17 proof passed'
