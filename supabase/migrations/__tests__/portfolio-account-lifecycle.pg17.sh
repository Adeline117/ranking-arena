#!/usr/bin/env bash

# PostgreSQL 17 proof for lifecycle-fenced portfolio credentials and syncs.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PUBLICATION_MIGRATION="$ROOT_DIR/supabase/migrations/20260729057000_atomic_portfolio_sync_publication.sql"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729170500_portfolio_account_lifecycle.sql"
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

TMP_ROOT="$(mktemp -d /tmp/portfolio-account-lifecycle-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
SAVE_FIRST_LOG="$TMP_ROOT/save-first.log"
BAN_FIRST_LOG="$TMP_ROOT/ban-first.log"
SAVE_READY="$TMP_ROOT/save-ready"
BAN_READY="$TMP_ROOT/ban-ready"
PORT="$(( 55000 + RANDOM % 5000 ))"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    for diagnostic in "$SAVE_FIRST_LOG" "$BAN_FIRST_LOG" "$LOG_FILE"; do
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

authenticated_query() {
  local sql="$1"
  psql_cmd -qAtc "
    SET ROLE authenticated;
    SET request.jwt.claim.role = 'authenticated';
    SET request.jwt.claim.sub = '$USER_ID';
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

expect_auth_value() {
  local label="$1"
  local expected="$2"
  local sql="$3"
  local actual
  actual="$(authenticated_query "$sql")"
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
    SET request.jwt.claim.sub = '$USER_ID';
    $sql
    RESET ROLE;
  " >"$output" 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
}

wait_for_file() {
  local path="$1"
  local label="$2"
  for _ in $(seq 1 250); do
    [[ -e "$path" ]] && return 0
    sleep 0.02
  done
  echo "Timed out waiting for $label" >&2
  return 1
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
ALTER FUNCTION auth.role() OWNER TO postgres;
ALTER FUNCTION auth.uid() OWNER TO postgres;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION auth.role(), auth.uid()
  TO anon, authenticated, service_role, authenticator;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
ALTER TABLE auth.users OWNER TO postgres;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz
);
ALTER TABLE public.user_profiles OWNER TO postgres;

CREATE TABLE public.user_portfolios (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  exchange text NOT NULL,
  api_key_encrypted text NOT NULL,
  api_secret_encrypted text NOT NULL,
  api_passphrase_encrypted text,
  label text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  UNIQUE (user_id, exchange, label)
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
CREATE POLICY "Users can manage own portfolios"
  ON public.user_portfolios FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can view own positions"
  ON public.user_positions FOR ALL
  USING (
    portfolio_id IN (
      SELECT id FROM public.user_portfolios WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    portfolio_id IN (
      SELECT id FROM public.user_portfolios WHERE user_id = auth.uid()
    )
  );
CREATE POLICY "Users can view own snapshots"
  ON public.user_portfolio_snapshots FOR ALL
  USING (
    portfolio_id IN (
      SELECT id FROM public.user_portfolios WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    portfolio_id IN (
      SELECT id FROM public.user_portfolios WHERE user_id = auth.uid()
    )
  );

GRANT ALL PRIVILEGES ON TABLE
  public.user_portfolios,
  public.user_positions,
  public.user_portfolio_snapshots
  TO authenticated, service_role;

CREATE FUNCTION public.lock_trader_claim_principals_internal(
  p_user_ids uuid[],
  p_require_active boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_user_id uuid;
  v_deleted_at timestamptz;
  v_banned_at timestamptz;
  v_is_banned boolean;
  v_ban_expires_at timestamptz;
BEGIN
  IF p_user_ids IS NULL
     OR pg_catalog.cardinality(p_user_ids) = 0
     OR p_require_active IS NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(p_user_ids) AS supplied(user_id)
       WHERE supplied.user_id IS NULL
     )
  THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'principals required';
  END IF;

  FOR v_user_id IN
    SELECT DISTINCT supplied.user_id
    FROM pg_catalog.unnest(p_user_ids) AS supplied(user_id)
    ORDER BY supplied.user_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'account-recovery-admission:' || v_user_id::text,
        0
      )
    );
  END LOOP;

  FOR v_user_id IN
    SELECT DISTINCT supplied.user_id
    FROM pg_catalog.unnest(p_user_ids) AS supplied(user_id)
    ORDER BY supplied.user_id
  LOOP
    PERFORM 1 FROM auth.users AS auth_user
    WHERE auth_user.id = v_user_id
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'account missing';
    END IF;
  END LOOP;

  FOR v_user_id IN
    SELECT DISTINCT supplied.user_id
    FROM pg_catalog.unnest(p_user_ids) AS supplied(user_id)
    ORDER BY supplied.user_id
  LOOP
    SELECT deleted_at, banned_at, is_banned, ban_expires_at
    INTO v_deleted_at, v_banned_at, v_is_banned, v_ban_expires_at
    FROM public.user_profiles AS profile
    WHERE profile.id = v_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'profile missing';
    END IF;
    IF p_require_active
       AND (
         v_deleted_at IS NOT NULL
         OR v_banned_at IS NOT NULL
         OR (
           COALESCE(v_is_banned, false)
           AND (
             v_ban_expires_at IS NULL
             OR v_ban_expires_at > pg_catalog.clock_timestamp()
           )
         )
       )
    THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'account inactive';
    END IF;
  END LOOP;
END
$function$;
ALTER FUNCTION public.lock_trader_claim_principals_internal(uuid[], boolean)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lock_trader_claim_principals_internal(uuid[], boolean)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

INSERT INTO auth.users(id) VALUES ('10000000-0000-4000-8000-000000000001');
INSERT INTO public.user_profiles(id)
VALUES ('10000000-0000-4000-8000-000000000001');
INSERT INTO public.user_portfolios (
  id,
  user_id,
  exchange,
  api_key_encrypted,
  api_secret_encrypted,
  label
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000001',
  'bybit',
  'legacy-key',
  'legacy-secret',
  'Legacy'
);
SQL

psql_cmd -f "$PUBLICATION_MIGRATION" >/dev/null

psql_cmd <<'SQL'
INSERT INTO public.user_positions (
  portfolio_id,
  symbol,
  side,
  entry_price,
  mark_price,
  size,
  pnl,
  pnl_pct,
  leverage
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  'OLD/USDT',
  'long',
  1,
  1,
  1,
  0,
  0,
  1
);
INSERT INTO public.user_portfolio_snapshots (
  portfolio_id,
  total_equity,
  total_pnl,
  total_pnl_pct
) VALUES (
  '20000000-0000-4000-8000-000000000001',
  10,
  0,
  0
);
SQL

psql_cmd -f "$MIGRATION" >/dev/null

USER_ID="10000000-0000-4000-8000-000000000001"
LEGACY_PORTFOLIO_ID="20000000-0000-4000-8000-000000000001"
CIPHER_ONE='{"version":1,"salt":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","iv":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","tag":"cccccccccccccccccccccccccccccccc","ciphertext":"dd"}'
CIPHER_TWO='{"version":1,"salt":"1111111111111111111111111111111111111111111111111111111111111111","iv":"22222222222222222222222222222222","tag":"33333333333333333333333333333333","ciphertext":"44"}'
CIPHER_THREE='{"version":1,"salt":"5555555555555555555555555555555555555555555555555555555555555555","iv":"66666666666666666666666666666666","tag":"77777777777777777777777777777777","ciphertext":"88"}'
CIPHER_FOUR='{"version":1,"salt":"9999999999999999999999999999999999999999999999999999999999999999","iv":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","tag":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","ciphertext":"cc"}'

expect_value \
  "legacy unproven credential is inactive" \
  "false|1|inactive" \
  "SELECT portfolio.is_active::text || '|' ||
          portfolio.credential_generation::text || '|' ||
          (public.claim_portfolio_sync_generation_atomic(
             '$USER_ID', '$LEGACY_PORTFOLIO_ID'
           ) ->> 'status')
   FROM public.user_portfolios AS portfolio
   WHERE portfolio.id = '$LEGACY_PORTFOLIO_ID';"

expect_auth_value \
  "authenticated retains safe owner-scoped portfolio reads" \
  "$LEGACY_PORTFOLIO_ID" \
  "SELECT id::text FROM public.user_portfolios WHERE id = '$LEGACY_PORTFOLIO_ID';"
expect_failure \
  "authenticated cannot read credential ciphertext" \
  "SELECT api_key_encrypted FROM public.user_portfolios;" \
  authenticated \
  authenticated
expect_failure \
  "authenticated cannot fabricate positions" \
  "INSERT INTO public.user_positions (
     portfolio_id, symbol, side, entry_price, mark_price, size, pnl, pnl_pct, leverage
   ) VALUES ('$LEGACY_PORTFOLIO_ID', 'FAKE', 'long', 1, 1, 1, 0, 0, 1);" \
  authenticated \
  authenticated
expect_failure \
  "service cannot bypass lifecycle publication wrapper" \
  "SELECT public.publish_portfolio_sync_atomic(
    '$USER_ID', '$LEGACY_PORTFOLIO_ID', 1,
    pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()),
    '[]'::jsonb, 0, 0, 0
  );"

expect_value \
  "malformed credential is rejected" \
  "invalid" \
  "SELECT public.save_user_portfolio_for_active_profile_atomic(
    '$USER_ID', 'bybit', 'plaintext', '$CIPHER_ONE', NULL, 'Main',
    '[\"read\"]'::jsonb
  ) ->> 'status';"

expect_value \
  "active save creates a separately proved portfolio without touching legacy data" \
  "saved|1" \
  "SELECT (result ->> 'status') || '|' ||
          (result ->> 'credential_generation')
   FROM (
     SELECT public.save_user_portfolio_for_active_profile_atomic(
       '$USER_ID', 'bybit', '$CIPHER_ONE', '$CIPHER_ONE', NULL, 'Main',
       '[\"read\"]'::jsonb
     ) AS result
   ) AS saved;"

PORTFOLIO_ID="$(service_query "
  SELECT id::text
  FROM public.user_portfolios
  WHERE user_id = '$USER_ID'
    AND exchange = 'bybit'
    AND label = 'Main';
")"
if [[ -z "$PORTFOLIO_ID" || "$PORTFOLIO_ID" == "$LEGACY_PORTFOLIO_ID" ]]; then
  echo "active save did not create a distinct portfolio identity" >&2
  exit 1
fi

expect_value \
  "new proof preserved every legacy financial row" \
  "true|1|1|1|1" \
  "SELECT portfolio.is_active::text || '|' ||
          portfolio.credential_generation::text || '|' ||
          pg_catalog.jsonb_array_length(portfolio.read_only_permissions)::text || '|' ||
          (SELECT pg_catalog.count(*) FROM public.user_positions
            WHERE portfolio_id = '$LEGACY_PORTFOLIO_ID')::text || '|' ||
          (SELECT pg_catalog.count(*) FROM public.user_portfolio_snapshots
            WHERE portfolio_id = '$LEGACY_PORTFOLIO_ID')::text
   FROM public.user_portfolios AS portfolio
   WHERE portfolio.id = '$PORTFOLIO_ID';"

# Replaying after a valid save must not mistake the active row for legacy data.
psql_cmd -f "$MIGRATION" >/dev/null
expect_value \
  "migration replay preserves a valid active credential" \
  "true|1" \
  "SELECT is_active::text || '|' || credential_generation::text
   FROM public.user_portfolios WHERE id = '$PORTFOLIO_ID';"

expect_value \
  "claim returns the exact active credential generation" \
  "claimed|1|1|bybit|true" \
  "SELECT (result ->> 'status') || '|' ||
          (result ->> 'generation') || '|' ||
          (result ->> 'credential_generation') || '|' ||
          (result ->> 'exchange') || '|' ||
          ((result ->> 'api_key_encrypted') = '$CIPHER_ONE')::text
   FROM (
     SELECT public.claim_portfolio_sync_generation_atomic(
       '$USER_ID', '$PORTFOLIO_ID'
     ) AS result
   ) AS claimed;"

psql_cmd -qc "
  UPDATE public.user_portfolios
  SET api_key_encrypted = '$CIPHER_TWO',
      api_secret_encrypted = '$CIPHER_TWO',
      read_only_verified_at = pg_catalog.clock_timestamp()
  WHERE id = '$PORTFOLIO_ID';
"
expect_value \
  "credential replacement bumps the fence" \
  "2" \
  "SELECT credential_generation::text
   FROM public.user_portfolios WHERE id = '$PORTFOLIO_ID';"
expect_value \
  "credential replacement supersedes in-flight publication" \
  "superseded|1|2" \
  "SELECT (result ->> 'status') || '|' ||
          (result ->> 'current_generation') || '|' ||
          (result ->> 'current_credential_generation')
   FROM (
     SELECT public.publish_active_portfolio_sync_atomic(
       '$USER_ID', '$PORTFOLIO_ID', 1, 1,
       pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()),
       '[]'::jsonb, 0, 0, 0
     ) AS result
   ) AS rejected;"

expect_value \
  "replacement credential claims a newer sync generation" \
  "claimed|2|2" \
  "SELECT (result ->> 'status') || '|' ||
          (result ->> 'generation') || '|' ||
          (result ->> 'credential_generation')
   FROM (
     SELECT public.claim_portfolio_sync_generation_atomic(
       '$USER_ID', '$PORTFOLIO_ID'
     ) AS result
   ) AS claimed;"

psql_cmd -qc "
  UPDATE public.user_profiles
  SET is_banned = true,
      banned_at = pg_catalog.clock_timestamp()
  WHERE id = '$USER_ID';
"
expect_value \
  "ban during remote fetch prevents publication" \
  "suspended|false|3|0" \
  "SELECT
     (public.publish_active_portfolio_sync_atomic(
       '$USER_ID', '$PORTFOLIO_ID', 2, 2,
       pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()),
       '[]'::jsonb, 0, 0, 0
     ) ->> 'status') || '|' ||
     portfolio.is_active::text || '|' ||
     portfolio.credential_generation::text || '|' ||
     (SELECT pg_catalog.count(*) FROM public.user_portfolio_snapshots
       WHERE portfolio_id = portfolio.id)::text
   FROM public.user_portfolios AS portfolio
   WHERE portfolio.id = '$PORTFOLIO_ID';"

psql_cmd -qc "
  UPDATE public.user_profiles
  SET is_banned = false,
      banned_at = NULL,
      ban_expires_at = NULL
  WHERE id = '$USER_ID';
"
expect_value \
  "unban does not reactivate old credential" \
  "inactive|false|3" \
  "SELECT
     (public.claim_portfolio_sync_generation_atomic(
       '$USER_ID', '$PORTFOLIO_ID'
     ) ->> 'status') || '|' ||
     is_active::text || '|' || credential_generation::text
   FROM public.user_portfolios WHERE id = '$PORTFOLIO_ID';"

expect_value \
  "fresh proof never overwrites the inactive portfolio implicitly" \
  "already_exists" \
  "SELECT public.save_user_portfolio_for_active_profile_atomic(
    '$USER_ID', 'bybit', '$CIPHER_THREE', '$CIPHER_THREE', NULL, 'Main',
    '[\"read\"]'::jsonb
  ) ->> 'status';"

expect_value \
  "explicit owner removal is required before reconnect" \
  "$PORTFOLIO_ID" \
  "DELETE FROM public.user_portfolios
   WHERE id = '$PORTFOLIO_ID' AND user_id = '$USER_ID'
   RETURNING id::text;"
expect_value \
  "fresh proof after explicit removal creates a new identity" \
  "saved|1" \
  "SELECT (result ->> 'status') || '|' ||
          (result ->> 'credential_generation')
   FROM (
     SELECT public.save_user_portfolio_for_active_profile_atomic(
       '$USER_ID', 'bybit', '$CIPHER_THREE', '$CIPHER_THREE', NULL, 'Main',
       '[\"read\"]'::jsonb
     ) AS result
   ) AS saved;"

PORTFOLIO_ID="$(service_query "
  SELECT id::text
  FROM public.user_portfolios
  WHERE user_id = '$USER_ID'
    AND exchange = 'bybit'
    AND label = 'Main';
")"
expect_value \
  "fresh active claim" \
  "claimed|1|1" \
  "SELECT (result ->> 'status') || '|' ||
          (result ->> 'generation') || '|' ||
          (result ->> 'credential_generation')
   FROM (
     SELECT public.claim_portfolio_sync_generation_atomic(
       '$USER_ID', '$PORTFOLIO_ID'
     ) AS result
   ) AS claimed;"

POSITIONS='[{"symbol":"BTC/USDT:USDT","side":"long","entry_price":100,"mark_price":101,"size":2,"pnl":2,"pnl_pct":1,"leverage":3}]'
expect_value \
  "current active generations publish one exact snapshot" \
  "published|1" \
  "SELECT (result ->> 'status') || '|' || (result ->> 'position_count')
   FROM (
     SELECT public.publish_active_portfolio_sync_atomic(
       '$USER_ID', '$PORTFOLIO_ID', 1, 1,
       pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp()),
       '$POSITIONS'::jsonb, 500, 2, 0.4
     ) AS result
   ) AS published;"

# Save-first race: the save holds the profile lock through commit. The ban then
# wins in serialized order and the quiescence trigger invalidates the new fence.
(
  psql_cmd -qAt <<SQL
BEGIN;
SET ROLE service_role;
SET request.jwt.claim.role = 'service_role';
SELECT public.save_user_portfolio_for_active_profile_atomic(
  '$USER_ID', 'bybit', '$CIPHER_FOUR', '$CIPHER_FOUR', NULL, 'Concurrent',
  '["read"]'::jsonb
) ->> 'status';
\! touch "$SAVE_READY"
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
) >"$SAVE_FIRST_LOG" 2>&1 &
SAVE_FIRST_PID=$!
wait_for_file "$SAVE_READY" "save-first transaction"
psql_cmd -qc "
  UPDATE public.user_profiles
  SET is_banned = true,
      banned_at = pg_catalog.clock_timestamp()
  WHERE id = '$USER_ID';
"
wait "$SAVE_FIRST_PID"
expect_value \
  "save-first concurrent ban converges inactive" \
  "false|2" \
  "SELECT is_active::text || '|' || credential_generation::text
   FROM public.user_portfolios
   WHERE user_id = '$USER_ID' AND label = 'Concurrent';"

# Ban-first race: the save waits for the profile writer, then observes the
# committed inactive state and cannot reactivate or replace the credential.
psql_cmd -qc "
  UPDATE public.user_profiles
  SET is_banned = false,
      banned_at = NULL
  WHERE id = '$USER_ID';
"
(
  psql_cmd -qAt <<SQL
BEGIN;
UPDATE public.user_profiles
SET is_banned = true,
    banned_at = pg_catalog.clock_timestamp()
WHERE id = '$USER_ID';
\! touch "$BAN_READY"
SELECT pg_catalog.pg_sleep(1);
COMMIT;
SQL
) >"$BAN_FIRST_LOG" 2>&1 &
BAN_FIRST_PID=$!
wait_for_file "$BAN_READY" "ban-first transaction"
expect_value \
  "ban-first concurrent save is rejected" \
  "suspended" \
  "SELECT public.save_user_portfolio_for_active_profile_atomic(
    '$USER_ID', 'bybit', '$CIPHER_ONE', '$CIPHER_ONE', NULL, 'BanFirst',
    '[\"read\"]'::jsonb
  ) ->> 'status';"
wait "$BAN_FIRST_PID"
expect_value \
  "ban-first race preserved inactive credential" \
  "false|2|0" \
  "SELECT portfolio.is_active::text || '|' ||
          portfolio.credential_generation::text || '|' ||
          (SELECT pg_catalog.count(*) FROM public.user_portfolios
            WHERE user_id = '$USER_ID' AND label = 'BanFirst')::text
   FROM public.user_portfolios AS portfolio
   WHERE portfolio.id = '$PORTFOLIO_ID';"

echo "portfolio account lifecycle PostgreSQL 17 proof passed"
