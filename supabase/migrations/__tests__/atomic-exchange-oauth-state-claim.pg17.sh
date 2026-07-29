#!/usr/bin/env bash

# PostgreSQL 17 proof for single-owner, retryable exchange OAuth state claims.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729075100_atomic_exchange_oauth_state_claim.sql"
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

TMP_ROOT="$(mktemp -d /tmp/exchange-oauth-state-pg17.XXXXXX)"
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
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOINHERIT;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, authenticator;
CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT pg_catalog.current_setting('request.jwt.claim.role', true)
$function$;
ALTER FUNCTION auth.role() OWNER TO postgres;
GRANT USAGE ON SCHEMA auth TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role() TO authenticated, service_role;

CREATE TABLE public.oauth_states (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  exchange text NOT NULL,
  state text NOT NULL,
  code_verifier text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public.oauth_states OWNER TO postgres;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.oauth_states TO service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

service_query "
  INSERT INTO public.oauth_states (user_id, exchange, state, expires_at)
  VALUES (
    '10000000-0000-4000-8000-000000000001', 'binance', 'unique-state',
    pg_catalog.clock_timestamp() + interval '10 minutes'
  );
" >/dev/null
if service_query "
  INSERT INTO public.oauth_states (user_id, exchange, state, expires_at)
  VALUES (
    '10000000-0000-4000-8000-000000000001', 'binance', 'unique-state',
    pg_catalog.clock_timestamp() + interval '10 minutes'
  );
" >"$TMP_ROOT/duplicate-state.out" 2>&1; then
  echo "duplicate callback state identity was accepted" >&2
  exit 1
fi

if psql_cmd -qAtc "
  SET ROLE authenticated;
  SET request.jwt.claim.role = 'authenticated';
  SELECT public.claim_exchange_oauth_state_atomic(
    '10000000-0000-4000-8000-000000000001', 'binance', 'closed', 120
  );
" >"$TMP_ROOT/authenticated.out" 2>&1; then
  echo "authenticated caller executed service-only OAuth claim" >&2
  exit 1
fi

service_query "
  INSERT INTO public.oauth_states (user_id, exchange, state, code_verifier, expires_at)
  VALUES (
    '10000000-0000-4000-8000-000000000001',
    'binance',
    'lease-retry',
    'pkce-secret',
    pg_catalog.clock_timestamp() + interval '10 minutes'
  );
" >/dev/null

claim_a="$(service_query "
  SELECT public.claim_exchange_oauth_state_atomic(
    '10000000-0000-4000-8000-000000000001', 'binance', 'lease-retry', 120
  )->>'claim_token';
")"
if [[ ! "$claim_a" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "first claim did not return a UUID lease token" >&2
  exit 1
fi

expect_value \
  "active lease excludes a second worker" \
  "invalid_or_claimed" \
  "SELECT public.claim_exchange_oauth_state_atomic(
    '10000000-0000-4000-8000-000000000001', 'binance', 'lease-retry', 120
  )->>'status';"

service_query "
  UPDATE public.oauth_states
  SET claim_expires_at = pg_catalog.clock_timestamp() - interval '1 second'
  WHERE state = 'lease-retry';
" >/dev/null
claim_b="$(service_query "
  SELECT public.claim_exchange_oauth_state_atomic(
    '10000000-0000-4000-8000-000000000001', 'binance', 'lease-retry', 120
  )->>'claim_token';
")"
if [[ "$claim_b" == "$claim_a" || ! "$claim_b" =~ ^[0-9a-f-]{36}$ ]]; then
  echo "expired lease was not reclaimed with a fresh fence" >&2
  exit 1
fi

expect_value \
  "stale worker cannot consume the reclaimed state" \
  "stale_claim" \
  "SELECT public.finish_exchange_oauth_state_claim_atomic(
    '10000000-0000-4000-8000-000000000001', 'binance', 'lease-retry',
    '$claim_a', true
  )->>'status';"
expect_value \
  "current worker can release a retryable failure" \
  "released" \
  "SELECT public.finish_exchange_oauth_state_claim_atomic(
    '10000000-0000-4000-8000-000000000001', 'binance', 'lease-retry',
    '$claim_b', false
  )->>'status';"

claim_c="$(service_query "
  SELECT public.claim_exchange_oauth_state_atomic(
    '10000000-0000-4000-8000-000000000001', 'binance', 'lease-retry', 120
  )->>'claim_token';
")"
expect_value \
  "successful owner consumes the state" \
  "consumed" \
  "SELECT public.finish_exchange_oauth_state_claim_atomic(
    '10000000-0000-4000-8000-000000000001', 'binance', 'lease-retry',
    '$claim_c', true
  )->>'status';"
expect_value \
  "consumed state is absent" \
  "0" \
  "SELECT pg_catalog.count(*) FROM public.oauth_states WHERE state = 'lease-retry';"

service_query "
  INSERT INTO public.oauth_states (user_id, exchange, state, expires_at)
  VALUES
    ('10000000-0000-4000-8000-000000000001', 'binance', 'expired',
      pg_catalog.clock_timestamp() - interval '1 second'),
    ('10000000-0000-4000-8000-000000000001', 'binance', 'legacy',
      pg_catalog.clock_timestamp() + interval '10 minutes');
" >/dev/null
expect_value \
  "expired state stays invalid" \
  "invalid_or_claimed" \
  "SELECT public.claim_exchange_oauth_state_atomic(
    '10000000-0000-4000-8000-000000000001', 'binance', 'expired', 120
  )->>'status';"
expect_value \
  "state remains bound to its exact viewer" \
  "invalid_or_claimed" \
  "SELECT public.claim_exchange_oauth_state_atomic(
    '10000000-0000-4000-8000-000000000002', 'binance', 'legacy', 120
  )->>'status';"
expect_value \
  "legacy direct deletion remains rolling-compatible" \
  "1" \
  "WITH deleted AS (
    DELETE FROM public.oauth_states WHERE state = 'legacy' RETURNING id
  ) SELECT pg_catalog.count(*) FROM deleted;"

# Hold the winning UPDATE long enough for a second real backend to encounter
# the row lock. SKIP LOCKED must let exactly one worker own the state.
service_query "
  INSERT INTO public.oauth_states (user_id, exchange, state, expires_at)
  VALUES (
    '10000000-0000-4000-8000-000000000001', 'bybit', 'concurrent',
    pg_catalog.clock_timestamp() + interval '10 minutes'
  );
" >/dev/null
psql_cmd <<'SQL'
CREATE FUNCTION public.delay_oauth_claim_for_test()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.claim_token IS NULL AND NEW.claim_token IS NOT NULL THEN
    PERFORM pg_catalog.pg_sleep(1);
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER delay_oauth_claim_for_test
BEFORE UPDATE ON public.oauth_states
FOR EACH ROW EXECUTE FUNCTION public.delay_oauth_claim_for_test();
SQL

service_query "
  SELECT public.claim_exchange_oauth_state_atomic(
    '10000000-0000-4000-8000-000000000001', 'bybit', 'concurrent', 120
  )->>'status';
" >"$CLAIM_A_LOG" &
pid_a=$!
service_query "
  SELECT public.claim_exchange_oauth_state_atomic(
    '10000000-0000-4000-8000-000000000001', 'bybit', 'concurrent', 120
  )->>'status';
" >"$CLAIM_B_LOG" &
pid_b=$!
wait "$pid_a"
wait "$pid_b"

concurrent_results="$(sort "$CLAIM_A_LOG" "$CLAIM_B_LOG" | paste -sd ',' -)"
if [[ "$concurrent_results" != "claimed,invalid_or_claimed" ]]; then
  echo "concurrent ownership drifted: $concurrent_results" >&2
  exit 1
fi

echo "Atomic exchange OAuth state claim PostgreSQL 17 proof passed"
