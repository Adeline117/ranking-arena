#!/usr/bin/env bash

# PostgreSQL 17 proof for the serialized trader-follow limit and postdeploy
# direct-write closure.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
AUTHORITY_MIGRATION="$ROOT_DIR/supabase/migrations/20260729062000_atomic_trader_follow_limit.sql"
CUTOVER_MIGRATION="$ROOT_DIR/supabase/migrations/20260729063000_close_trader_follow_direct_writes.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-trader-follow-limit-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
FOLLOW_A_LOG="$TMP_ROOT/follow-a.log"
FOLLOW_B_LOG="$TMP_ROOT/follow-b.log"
ERROR_FILE="$TMP_ROOT/expected-error.log"
PORT="$(( 55500 + RANDOM % 4000 ))"
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    for diagnostic in "$FOLLOW_A_LOG" "$FOLLOW_B_LOG" "$ERROR_FILE" "$LOG_FILE"; do
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
  local role="$2"
  local claim="$3"
  local sql="$4"
  if psql_cmd -qAtc "
    SET ROLE $role;
    SET request.jwt.claim.role = '$claim';
    SET request.jwt.claim.sub = '10000000-0000-4000-8000-000000000001';
    $sql
    RESET ROLE;
  " >"$ERROR_FILE" 2>&1; then
    echo "Expected failure: $label" >&2
    return 1
  fi
}

follow_call() {
  local actor_id="$1"
  local trader_id="$2"
  local source="$3"
  local promo="${4:-false}"
  local free_limit="${5:-1}"
  local pro_limit="${6:-2}"
  printf '%s' "public.mutate_trader_follow_atomic(
    '$actor_id',
    '$trader_id',
    '$source',
    'follow',
    $promo,
    $free_limit,
    $pro_limit
  )"
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

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  deleted_at timestamptz,
  is_pro boolean NOT NULL DEFAULT false
);
CREATE TABLE public.trader_follows (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  trader_id text NOT NULL,
  source text,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT trader_follows_user_id_trader_id_source_key
    UNIQUE NULLS NOT DISTINCT (user_id, trader_id, source)
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.trader_follows OWNER TO postgres;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trader_follows ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON TABLE public.user_profiles, public.trader_follows
  TO anon, authenticated, service_role;
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.trader_follows
  TO PUBLIC, anon, authenticated, service_role, authenticator;

CREATE POLICY "Service manage trader_follows"
  ON public.trader_follows
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY "Users can follow traders"
  ON public.trader_follows
  FOR INSERT
  TO public
  WITH CHECK ((SELECT auth.uid()) = user_id);
CREATE POLICY "Users can unfollow traders"
  ON public.trader_follows
  FOR DELETE
  TO public
  USING ((SELECT auth.uid()) = user_id);

CREATE FUNCTION public.has_current_global_pro_entitlement(p_actor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT COALESCE((
    SELECT profile.is_pro
    FROM public.user_profiles AS profile
    WHERE profile.id = p_actor_id
      AND profile.deleted_at IS NULL
  ), false)
$function$;
ALTER FUNCTION public.has_current_global_pro_entitlement(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.has_current_global_pro_entitlement(uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
SQL

psql_cmd -f "$AUTHORITY_MIGRATION" >/dev/null
psql_cmd -f "$AUTHORITY_MIGRATION" >/dev/null

FREE_USER="10000000-0000-4000-8000-000000000001"
PRO_USER="10000000-0000-4000-8000-000000000002"
PROMO_USER="10000000-0000-4000-8000-000000000003"
CONCURRENT_USER="10000000-0000-4000-8000-000000000004"
LEGACY_USER="10000000-0000-4000-8000-000000000005"
INACTIVE_USER="10000000-0000-4000-8000-000000000006"
ERROR_USER="10000000-0000-4000-8000-000000000007"
OLD_CLIENT_USER="10000000-0000-4000-8000-000000000008"

psql_cmd -q <<SQL
INSERT INTO public.user_profiles (id, is_pro, deleted_at) VALUES
  ('$FREE_USER', false, NULL),
  ('$PRO_USER', true, NULL),
  ('$PROMO_USER', false, NULL),
  ('$CONCURRENT_USER', false, NULL),
  ('$LEGACY_USER', false, NULL),
  ('$INACTIVE_USER', false, pg_catalog.statement_timestamp()),
  ('$ERROR_USER', false, NULL),
  ('$OLD_CLIENT_USER', false, NULL);
SQL

# ACL: only the trusted service boundary can execute the authority.
expect_failure \
  "authenticated atomic follow execution is closed" \
  authenticated authenticated \
  "SELECT $(follow_call "$FREE_USER" "acl" "bybit");"
expect_failure \
  "anonymous atomic follow execution is closed" \
  anon anon \
  "SELECT $(follow_call "$FREE_USER" "acl" "bybit");"

expect_value \
  "invalid follow input" \
  "invalid" \
  "SELECT public.mutate_trader_follow_atomic(
    '$FREE_USER', 'bad', NULL, 'follow', false, 1, 2
  )->>'status';"
expect_value \
  "inactive account is not writable" \
  "account_inactive" \
  "SELECT $(follow_call "$INACTIVE_USER" "inactive" "bybit")->>'status';"

# Free exact limit, duplicate ACK and no count-error-as-zero fallback.
expect_value \
  "first free follow" \
  "followed|true|1|1" \
  "SELECT concat_ws(
    '|',
    result->>'status',
    result->>'following',
    result->>'current_count',
    result->>'limit'
  )
  FROM (SELECT $(follow_call "$FREE_USER" "free-one" "bybit") AS result) AS call;"
expect_value \
  "free follow replay" \
  "already_following|1" \
  "SELECT concat_ws('|', result->>'status', result->>'current_count')
  FROM (SELECT $(follow_call "$FREE_USER" "free-one" "bybit") AS result) AS call;"
expect_value \
  "free limit reached" \
  "limit_reached|false|1|1" \
  "SELECT concat_ws(
    '|',
    result->>'status',
    result->>'following',
    result->>'current_count',
    result->>'limit'
  )
  FROM (SELECT $(follow_call "$FREE_USER" "free-two" "bybit") AS result) AS call;"

# Durable Pro authority and the explicit promotion flag both choose the server
# supplied Pro policy without trusting a tier read in the application.
expect_value \
  "Pro first follow" \
  "followed" \
  "SELECT $(follow_call "$PRO_USER" "pro-one" "bybit")->>'status';"
expect_value \
  "Pro second follow" \
  "followed" \
  "SELECT $(follow_call "$PRO_USER" "pro-two" "bybit")->>'status';"
expect_value \
  "Pro limit reached" \
  "limit_reached|2" \
  "SELECT concat_ws('|', result->>'status', result->>'limit')
  FROM (SELECT $(follow_call "$PRO_USER" "pro-three" "bybit") AS result) AS call;"
expect_value \
  "promo first follow" \
  "followed" \
  "SELECT $(follow_call "$PROMO_USER" "promo-one" "bybit" true)->>'status';"
expect_value \
  "promo second follow" \
  "followed" \
  "SELECT $(follow_call "$PROMO_USER" "promo-two" "bybit" true)->>'status';"

# Follow/unfollow ACKs preserve the exact composite identity, including a
# legacy NULL source that only unfollow is allowed to mutate.
psql_cmd -q <<SQL
INSERT INTO public.trader_follows (user_id, trader_id, source)
VALUES ('$LEGACY_USER', 'legacy-null', NULL);
SQL
expect_value \
  "legacy null-source unfollow" \
  "unfollowed||false" \
  "SELECT concat_ws(
    '|',
    result->>'status',
    COALESCE(result->>'source', ''),
    result->>'following'
  )
  FROM (
    SELECT public.mutate_trader_follow_atomic(
      '$LEGACY_USER', 'legacy-null', NULL, 'unfollow', false, 1, 2
    ) AS result
  ) AS call;"
expect_value \
  "unfollow replay" \
  "not_following|false" \
  "SELECT concat_ws('|', result->>'status', result->>'following')
  FROM (
    SELECT public.mutate_trader_follow_atomic(
      '$LEGACY_USER', 'legacy-null', NULL, 'unfollow', false, 1, 2
    ) AS result
  ) AS call;"

# Two requests at the last Free slot must serialize: exactly one edge commits
# and the other receives the authoritative limit ACK.
(service_query \
  "SELECT $(follow_call "$CONCURRENT_USER" "race-a" "bybit")->>'status';" \
  >"$FOLLOW_A_LOG") &
FOLLOW_A_PID=$!
(service_query \
  "SELECT $(follow_call "$CONCURRENT_USER" "race-b" "bybit")->>'status';" \
  >"$FOLLOW_B_LOG") &
FOLLOW_B_PID=$!
wait "$FOLLOW_A_PID"
wait "$FOLLOW_B_PID"
CONCURRENT_STATUSES="$(
  sort "$FOLLOW_A_LOG" "$FOLLOW_B_LOG" | paste -sd '|' -
)"
if [[ "$CONCURRENT_STATUSES" != "followed|limit_reached" ]]; then
  echo "concurrent follow did not serialize: $CONCURRENT_STATUSES" >&2
  exit 1
fi
expect_value \
  "concurrent limit leaves one edge" \
  "1" \
  "SELECT pg_catalog.count(*) FROM public.trader_follows
   WHERE user_id = '$CONCURRENT_USER';"

# A failed count/table read must abort instead of becoming a confident zero.
psql_cmd -q <<SQL
ALTER TABLE public.trader_follows RENAME TO trader_follows_unavailable;
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
DO \$count_error\$
BEGIN
  BEGIN
    PERFORM public.mutate_trader_follow_atomic(
      '$ERROR_USER', 'count-error', 'bybit', 'follow', false, 1, 2
    );
    RAISE EXCEPTION 'count error was treated as zero';
  EXCEPTION
    WHEN undefined_table THEN
      NULL;
  END;
END
\$count_error\$;
RESET ROLE;
ALTER TABLE public.trader_follows_unavailable RENAME TO trader_follows;
SQL
expect_value \
  "count error inserts no edge" \
  "0" \
  "SELECT pg_catalog.count(*) FROM public.trader_follows
   WHERE user_id = '$ERROR_USER';"

# Before the postdeploy boundary, reproduce the old browser-authorized writer.
psql_cmd -q <<SQL
SET ROLE authenticated;
SET request.jwt.claim.role = 'authenticated';
SET request.jwt.claim.sub = '$OLD_CLIENT_USER';
INSERT INTO public.trader_follows (user_id, trader_id, source)
VALUES ('$OLD_CLIENT_USER', 'old-client', 'bybit');
RESET ROLE;
SQL

psql_cmd -f "$CUTOVER_MIGRATION" >/dev/null
psql_cmd -f "$CUTOVER_MIGRATION" >/dev/null

# Postdeploy: old clients and direct service writers are rejected, while the
# SECURITY DEFINER RPC still follows/unfollows and returns exact ACKs.
expect_failure \
  "old authenticated insert is rejected" \
  authenticated authenticated \
  "INSERT INTO public.trader_follows (user_id, trader_id, source)
   VALUES ('$OLD_CLIENT_USER', 'bypass-insert', 'bybit');"
expect_failure \
  "old authenticated delete is rejected" \
  authenticated authenticated \
  "DELETE FROM public.trader_follows
   WHERE user_id = '$OLD_CLIENT_USER';"
expect_failure \
  "old authenticated update is rejected" \
  authenticated authenticated \
  "UPDATE public.trader_follows SET source = 'okx'
   WHERE user_id = '$OLD_CLIENT_USER';"
expect_failure \
  "direct service insert is rejected" \
  service_role service_role \
  "INSERT INTO public.trader_follows (user_id, trader_id, source)
   VALUES ('$ERROR_USER', 'service-bypass', 'bybit');"

expect_value \
  "service authority survives direct-write closure" \
  "followed|$ERROR_USER|authority-after-cutover|bybit|true" \
  "SELECT concat_ws(
    '|',
    result->>'status',
    result->>'user_id',
    result->>'trader_id',
    result->>'source',
    result->>'following'
  )
  FROM (
    SELECT $(follow_call "$ERROR_USER" "authority-after-cutover" "bybit") AS result
  ) AS call;"
expect_value \
  "exact source unfollow after cutover" \
  "unfollowed|false" \
  "SELECT concat_ws('|', result->>'status', result->>'following')
  FROM (
    SELECT public.mutate_trader_follow_atomic(
      '$ERROR_USER',
      'authority-after-cutover',
      'bybit',
      'unfollow',
      false,
      1,
      2
    ) AS result
  ) AS call;"

echo "atomic trader follow limit PostgreSQL 17 proof passed"
