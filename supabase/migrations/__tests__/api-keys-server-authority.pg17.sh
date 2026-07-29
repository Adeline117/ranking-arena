#!/usr/bin/env bash

# Isolated PostgreSQL 17 exploit/replay proof for the API-key server boundary.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729010000_api_keys_server_authority.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"

for executable in initdb pg_ctl psql; do
  if [[ ! -x "$PG_BIN/$executable" ]]; then
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  fi
done
if [[ "$($PG_BIN/psql --version)" != psql\ \(PostgreSQL\)\ 17.* ]]; then
  echo "This integration proof requires PostgreSQL 17" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d /tmp/api-keys-authority-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55529
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$exit_code"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

expect_failure() {
  local sql="$1"
  local label="$2"
  if psql_cmd -Atqc "$sql" >/dev/null 2>&1; then
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
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE hostile_role NOLOGIN;

GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role, hostile_role;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  api_tier text NOT NULL DEFAULT 'free'
    CHECK (api_tier IN ('free', 'starter', 'pro')),
  api_stripe_subscription_id text,
  updated_at timestamptz
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.api_keys (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  key text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT 'Default',
  active boolean NOT NULL DEFAULT true,
  tier text NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free', 'starter', 'pro')),
  daily_limit integer NOT NULL DEFAULT 100,
  request_count_today integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  revoked_at timestamptz
);
ALTER TABLE public.api_keys OWNER TO postgres;
ALTER TABLE public.api_keys ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.api_key_usage_daily (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  api_key_id uuid NOT NULL
    REFERENCES public.api_keys(id) ON DELETE CASCADE,
  date date NOT NULL,
  request_count integer NOT NULL DEFAULT 0,
  UNIQUE (api_key_id, date)
);
ALTER TABLE public.api_key_usage_daily OWNER TO postgres;
ALTER TABLE public.api_key_usage_daily ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION public.reset_api_key_daily_counts()
RETURNS void
LANGUAGE sql
SET search_path = public
AS $function$
  UPDATE api_keys SET request_count_today = 0
  WHERE request_count_today > 0;
$function$;
ALTER FUNCTION public.reset_api_key_daily_counts() OWNER TO postgres;

CREATE FUNCTION public.increment_api_key_usage(p_key text)
RETURNS TABLE(allowed boolean, remaining integer, daily_limit integer)
LANGUAGE plpgsql
SET search_path = public
AS $function$
DECLARE
  v_daily_limit integer;
  v_new_count integer;
BEGIN
  UPDATE api_keys
  SET request_count_today = request_count_today + 1,
      last_used_at = pg_catalog.clock_timestamp()
  WHERE key = p_key AND active
  RETURNING api_keys.daily_limit, request_count_today
  INTO v_daily_limit, v_new_count;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, 0;
    RETURN;
  END IF;

  RETURN QUERY SELECT
    v_daily_limit = 0 OR v_new_count <= v_daily_limit,
    CASE
      WHEN v_daily_limit = 0 THEN -1
      ELSE greatest(v_daily_limit - v_new_count, 0)
    END,
    v_daily_limit;
END
$function$;
ALTER FUNCTION public.increment_api_key_usage(text) OWNER TO postgres;

CREATE FUNCTION public.rollup_api_key_usage()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  INSERT INTO api_key_usage_daily (api_key_id, date, request_count)
  SELECT id, CURRENT_DATE, request_count_today
  FROM api_keys
  WHERE request_count_today > 0
  ON CONFLICT (api_key_id, date)
  DO UPDATE SET request_count = EXCLUDED.request_count;

  UPDATE api_keys SET request_count_today = 0
  WHERE request_count_today > 0;
END
$function$;
ALTER FUNCTION public.rollup_api_key_usage() OWNER TO postgres;

CREATE FUNCTION public.update_user_api_tier(
  p_user_id uuid,
  p_api_tier text,
  p_stripe_subscription_id text,
  p_daily_limit integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  UPDATE user_profiles
  SET api_tier = p_api_tier,
      api_stripe_subscription_id = p_stripe_subscription_id,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_user_id;

  UPDATE api_keys
  SET tier = p_api_tier,
      daily_limit = p_daily_limit
  WHERE user_id = p_user_id
    AND active;
END
$function$;
ALTER FUNCTION public.update_user_api_tier(uuid, text, text, integer)
  OWNER TO postgres;
-- Reproduce the historical ineffective fix: direct role revokes leave the
-- PostgreSQL default PUBLIC EXECUTE path intact.
REVOKE EXECUTE
  ON FUNCTION public.update_user_api_tier(uuid, text, text, integer)
  FROM anon, authenticated;

-- Reproduce the vulnerable historical browser ACL and permissive owner rules.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.api_keys, public.api_key_usage_daily
  TO authenticated;
GRANT SELECT (key, tier, daily_limit),
      INSERT (user_id, key, name, active, tier, daily_limit),
      UPDATE (key, tier, daily_limit)
  ON TABLE public.api_keys
  TO authenticated, hostile_role;
GRANT SELECT (api_key_id, date, request_count)
  ON TABLE public.api_key_usage_daily
  TO authenticated, hostile_role;

CREATE POLICY legacy_authenticated_api_keys
  ON public.api_keys
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
CREATE POLICY legacy_authenticated_usage
  ON public.api_key_usage_daily
  FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
CREATE POLICY unknown_dashboard_key_reader
  ON public.api_keys
  FOR SELECT TO hostile_role
  USING (true);

INSERT INTO public.user_profiles (id) VALUES
  ('20000000-0000-4000-8000-000000000002'),
  ('60000000-0000-4000-8000-000000000006');

INSERT INTO public.api_keys (
  id,
  user_id,
  key,
  name,
  request_count_today
) VALUES (
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'arena_sk_existing_full_plaintext_secret',
  'Existing',
  3
);
SQL

# Prove the release-blocking behavior existed before the migration.
psql_cmd <<'SQL'
SET ROLE anon;
SELECT public.update_user_api_tier(
  '20000000-0000-4000-8000-000000000002',
  'pro',
  'sub_anon_forged',
  0
);
RESET ROLE;

DO $public_definer_exploit$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '20000000-0000-4000-8000-000000000002'
      AND api_tier = 'pro'
      AND api_stripe_subscription_id = 'sub_anon_forged'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND tier = 'pro'
      AND daily_limit = 0
  ) THEN
    RAISE EXCEPTION
      'anon can forge API tier through PUBLIC definer execute: browser pre-boundary privilege proof failed';
  END IF;
END
$public_definer_exploit$;
SQL

psql_cmd <<'SQL'
SET ROLE authenticated;

DO $browser_pre_boundary$
DECLARE
  v_key text;
BEGIN
  SELECT key INTO v_key
  FROM public.api_keys
  WHERE id = '10000000-0000-4000-8000-000000000001';

  IF v_key <> 'arena_sk_existing_full_plaintext_secret' THEN
    RAISE EXCEPTION
      'authenticated can read the full API key: browser pre-boundary privilege proof failed';
  END IF;

  UPDATE public.api_keys
  SET tier = 'pro', daily_limit = 0
  WHERE id = '10000000-0000-4000-8000-000000000001';

  IF NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND tier = 'pro'
      AND daily_limit = 0
  ) THEN
    RAISE EXCEPTION
      'authenticated can manufacture pro unlimited: browser pre-boundary privilege proof failed';
  END IF;

  INSERT INTO public.api_keys (
    user_id,
    key,
    name,
    tier,
    daily_limit
  ) VALUES (
    '30000000-0000-4000-8000-000000000003',
    'arena_sk_browser_manufactured',
    'Browser forged',
    'pro',
    0
  );

  IF NOT pg_catalog.has_function_privilege(
    'authenticated',
    'public.increment_api_key_usage(text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'PUBLIC default RPC execute was not reproduced: browser pre-boundary privilege proof failed';
  END IF;
END
$browser_pre_boundary$;

SELECT * FROM public.increment_api_key_usage(
  'arena_sk_existing_full_plaintext_secret'
);
RESET ROLE;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

for statement in \
  "SELECT key FROM public.api_keys" \
  "INSERT INTO public.api_keys (user_id, key, name, tier, daily_limit) VALUES ('40000000-0000-4000-8000-000000000004', 'arena_sk_denied', 'Denied', 'pro', 0)" \
  "UPDATE public.api_keys SET tier = 'pro', daily_limit = 0" \
  "DELETE FROM public.api_keys" \
  "SELECT * FROM public.api_key_usage_daily"; do
  expect_failure \
    "SET ROLE authenticated; $statement" \
    "authenticated direct table access remained"
done

for statement in \
  "SELECT * FROM public.increment_api_key_usage('arena_sk_existing_full_plaintext_secret')" \
  "SELECT public.reset_api_key_daily_counts()" \
  "SELECT public.rollup_api_key_usage()" \
  "SELECT public.update_user_api_tier('20000000-0000-4000-8000-000000000002', 'pro', 'sub_denied', 0)"; do
  expect_failure \
    "SET ROLE authenticated; $statement" \
    "authenticated API key RPC execute remained"
done

expect_failure \
  "SET ROLE anon; SELECT public.update_user_api_tier('20000000-0000-4000-8000-000000000002', 'pro', 'sub_denied', 0)" \
  "anon API tier definer execute remained"

psql_cmd <<'SQL'
SET ROLE service_role;

INSERT INTO public.api_keys (
  id,
  user_id,
  key,
  name
) VALUES (
  '50000000-0000-4000-8000-000000000005',
  '60000000-0000-4000-8000-000000000006',
  'arena_sk_service_created',
  'Service'
);

DO $service_role_proof$
DECLARE
  v_allowed boolean;
BEGIN
  SELECT allowed INTO v_allowed
  FROM public.increment_api_key_usage('arena_sk_service_created');

  IF NOT v_allowed
    OR NOT EXISTS (
      SELECT 1
      FROM public.api_keys
      WHERE id = '50000000-0000-4000-8000-000000000005'
        AND request_count_today = 1
    )
  THEN
    RAISE EXCEPTION 'service_role NOBYPASSRLS route proof failed';
  END IF;
END
$service_role_proof$;

SELECT public.update_user_api_tier(
  '60000000-0000-4000-8000-000000000006',
  'starter',
  'sub_service_valid',
  1000
);
RESET ROLE;

DO $service_tier_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '60000000-0000-4000-8000-000000000006'
      AND api_tier = 'starter'
      AND api_stripe_subscription_id = 'sub_service_valid'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '50000000-0000-4000-8000-000000000005'
      AND tier = 'starter'
      AND daily_limit = 1000
  ) THEN
    RAISE EXCEPTION 'service_role NOBYPASSRLS route proof failed for API tier update';
  END IF;
END
$service_tier_proof$;

SET ROLE service_role;
SELECT public.rollup_api_key_usage();
SELECT public.reset_api_key_daily_counts();
RESET ROLE;
SQL

# Reintroduce table, column, policy, and function ACL drift, then prove replay
# removes it without changing credentials or usage rows.
psql_cmd <<'SQL'
GRANT ALL PRIVILEGES
  ON TABLE public.api_keys, public.api_key_usage_daily
  TO PUBLIC, authenticated, hostile_role;
GRANT SELECT (key), UPDATE (tier, daily_limit)
  ON TABLE public.api_keys
  TO PUBLIC, authenticated, hostile_role;
GRANT SELECT (request_count)
  ON TABLE public.api_key_usage_daily
  TO PUBLIC, authenticated, hostile_role;

CREATE POLICY replay_hostile_key_reader
  ON public.api_keys
  FOR SELECT TO PUBLIC
  USING (true);
CREATE POLICY replay_hostile_usage_writer
  ON public.api_key_usage_daily
  FOR ALL TO hostile_role
  USING (true) WITH CHECK (true);

GRANT EXECUTE
  ON FUNCTION public.increment_api_key_usage(text)
  TO PUBLIC;
GRANT EXECUTE
  ON FUNCTION public.increment_api_key_usage(text)
  TO authenticated, hostile_role WITH GRANT OPTION;
GRANT EXECUTE
  ON FUNCTION public.reset_api_key_daily_counts()
  TO PUBLIC;
GRANT EXECUTE
  ON FUNCTION public.reset_api_key_daily_counts()
  TO authenticated, hostile_role WITH GRANT OPTION;
GRANT EXECUTE
  ON FUNCTION public.rollup_api_key_usage()
  TO PUBLIC;
GRANT EXECUTE
  ON FUNCTION public.rollup_api_key_usage()
  TO authenticated, hostile_role WITH GRANT OPTION;
GRANT EXECUTE
  ON FUNCTION public.update_user_api_tier(uuid, text, text, integer)
  TO PUBLIC;
GRANT EXECUTE
  ON FUNCTION public.update_user_api_tier(uuid, text, text, integer)
  TO authenticated, hostile_role WITH GRANT OPTION;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
DO $replay_proof$
DECLARE
  v_service_oid oid := (
    SELECT oid
    FROM pg_catalog.pg_roles
    WHERE rolname = 'service_role'
  );
BEGIN
  IF pg_catalog.has_table_privilege(
    'authenticated',
    'public.api_keys',
    'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'hostile_role',
    'public.api_key_usage_daily',
    'UPDATE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.increment_api_key_usage(text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'hostile_role',
    'public.rollup_api_key_usage()',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.update_user_api_tier(uuid,text,text,integer)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'hostile_role',
    'public.update_user_api_tier(uuid,text,text,integer)',
    'EXECUTE'
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'public.api_keys'::pg_catalog.regclass,
      'public.api_key_usage_daily'::pg_catalog.regclass
    )
  ) <> 2 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'public.api_keys'::pg_catalog.regclass,
      'public.api_key_usage_daily'::pg_catalog.regclass
    )
      AND (
        policy.polroles <> ARRAY[v_service_oid]::oid[]
        OR policy.polcmd <> '*'
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM public.api_keys
  ) <> 3 THEN
    RAISE EXCEPTION 'hostile ACL replay did not converge';
  END IF;
END
$replay_proof$;
SQL

expect_failure \
  "SET ROLE authenticated; SELECT key FROM public.api_keys" \
  "authenticated direct table access remained after replay"
expect_failure \
  "SET ROLE authenticated; SELECT public.reset_api_key_daily_counts()" \
  "authenticated API key RPC execute remained after replay"
expect_failure \
  "SET ROLE anon; SELECT public.update_user_api_tier('20000000-0000-4000-8000-000000000002', 'pro', 'sub_replay_denied', 0)" \
  "anon API tier definer execute remained after replay"

psql_cmd <<'SQL'
SET ROLE service_role;
SELECT public.update_user_api_tier(
  '60000000-0000-4000-8000-000000000006',
  'pro',
  'sub_service_replay',
  0
);
DO $service_replay_proof$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM public.api_keys) <> 3
    OR NOT EXISTS (
      SELECT 1
      FROM public.api_key_usage_daily
      WHERE api_key_id = '50000000-0000-4000-8000-000000000005'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.api_keys
      WHERE id = '50000000-0000-4000-8000-000000000005'
        AND tier = 'pro'
        AND daily_limit = 0
    )
  THEN
    RAISE EXCEPTION 'service_role NOBYPASSRLS route proof failed after replay';
  END IF;
END
$service_replay_proof$;
RESET ROLE;
SQL

echo "API keys server authority PG17 proof passed"
