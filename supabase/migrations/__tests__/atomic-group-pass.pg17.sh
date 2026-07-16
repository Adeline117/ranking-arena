#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for atomic paid-group pass activation.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260716176000_atomic_group_pass.sql"
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

TMP_ROOT="$(mktemp -d /tmp/atomic-group-pass-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55576
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
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

expect_migration_failure() {
  local label="$1"
  local slug="$2"
  local error_file="$TMP_ROOT/$slug.err"

  if psql_cmd -f "$MIGRATION" >"$LOG_DIR/$slug.log" 2>"$error_file"; then
    echo "Migration unexpectedly accepted: $label" >&2
    return 1
  fi
  if ! grep -q 'atomic group pass service-role authority graph is unsafe' \
    "$error_file"; then
    echo "Migration failed for an unexpected reason: $label" >&2
    cat "$error_file" >&2
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
  -l "$LOG_DIR/postgres.log" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" \
  -w start >/dev/null

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE anon NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE service_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS;
CREATE ROLE hostile_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE shadow_role NOLOGIN NOSUPERUSER NOBYPASSRLS;
GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

CREATE SCHEMA auth;
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;
GRANT USAGE ON SCHEMA auth TO PUBLIC;
GRANT EXECUTE ON FUNCTION auth.role() TO PUBLIC;
GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role, hostile_role, shadow_role;

CREATE TYPE public.member_role AS ENUM ('owner', 'admin', 'member');

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz,
  reputation_score integer NOT NULL DEFAULT 0,
  is_verified_trader boolean NOT NULL DEFAULT false
);
ALTER TABLE public.user_profiles OWNER TO postgres;

CREATE TABLE public.groups (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_by uuid NOT NULL,
  dissolved_at timestamptz,
  is_premium_only boolean NOT NULL DEFAULT false,
  subscription_price_monthly numeric,
  subscription_price_yearly numeric,
  original_price_monthly numeric,
  original_price_yearly numeric,
  allow_trial boolean NOT NULL DEFAULT false,
  trial_days integer,
  min_arena_score integer,
  is_verified_only boolean,
  member_count integer NOT NULL DEFAULT 0
);
ALTER TABLE public.groups OWNER TO postgres;

CREATE TABLE public.group_members (
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role public.member_role NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
ALTER TABLE public.group_members OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.test_sync_group_member_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE public.groups SET member_count = member_count + 1 WHERE id = NEW.group_id;
    RETURN NEW;
  END IF;
  UPDATE public.groups SET member_count = member_count - 1 WHERE id = OLD.group_id;
  RETURN OLD;
END
$function$;
ALTER FUNCTION public.test_sync_group_member_count() OWNER TO postgres;
CREATE TRIGGER trg_test_sync_group_member_count
  AFTER INSERT OR DELETE ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.test_sync_group_member_count();

CREATE TABLE public.group_bans (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
ALTER TABLE public.group_bans OWNER TO postgres;

CREATE TABLE public.pro_official_groups (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  group_id uuid NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true
);
ALTER TABLE public.pro_official_groups OWNER TO postgres;

CREATE TABLE public.group_subscriptions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  tier text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  price_paid numeric,
  starts_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  expires_at timestamptz NOT NULL,
  cancelled_at timestamptz,
  payment_provider text,
  payment_reference text,
  created_at timestamptz DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz
);
ALTER TABLE public.group_subscriptions OWNER TO postgres;
ALTER TABLE public.group_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_subscriptions NO FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.group_subscriptions TO service_role;
CREATE POLICY service_role_manages_group_subscriptions
  ON public.group_subscriptions FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.expire_group_subscriptions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RETURN 0;
END
$function$;
ALTER FUNCTION public.expire_group_subscriptions() OWNER TO postgres;

INSERT INTO public.user_profiles (
  id, reputation_score, is_verified_trader
) VALUES
  ('10000000-0000-4000-8000-000000000001', 100, true),
  ('20000000-0000-4000-8000-000000000002', 100, true),
  ('30000000-0000-4000-8000-000000000003', 100, true),
  ('40000000-0000-4000-8000-000000000004', 100, true);

INSERT INTO public.groups (
  id, name, created_by, is_premium_only,
  subscription_price_monthly, subscription_price_yearly,
  original_price_monthly, original_price_yearly,
  allow_trial, trial_days
) VALUES
  (
    '50000000-0000-4000-8000-000000000005', 'Paid A',
    '40000000-0000-4000-8000-000000000004', true,
    9.90, 99.90, 12.90, 129.90, true, 7
  ),
  (
    '60000000-0000-4000-8000-000000000006', 'Paid B',
    '40000000-0000-4000-8000-000000000004', true,
    19.90, 199.90, 22.90, 229.90, true, 14
  ),
  (
    '70000000-0000-4000-8000-000000000007', 'Rollback',
    '40000000-0000-4000-8000-000000000004', true,
    29.90, 299.90, 32.90, 329.90, false, 7
  );
SQL

# The gateway's canonical SET-only edge is the only non-owner path to
# service_role. Prove direct, inherited, upstream, downstream-recursive, and
# browser-recursive authority drift all fail before the migration mutates data.
psql_cmd -c \
  'GRANT service_role TO hostile_role WITH INHERIT FALSE, SET TRUE' >/dev/null
expect_migration_failure 'direct custom service_role member' 'unsafe-direct-member'
psql_cmd -c 'REVOKE service_role FROM hostile_role' >/dev/null

psql_cmd -c \
  'GRANT service_role TO authenticator WITH INHERIT TRUE, SET TRUE' >/dev/null
expect_migration_failure 'inherited authenticator gateway edge' 'unsafe-authenticator'
psql_cmd -c \
  'GRANT service_role TO authenticator WITH INHERIT FALSE, SET TRUE' >/dev/null

psql_cmd -c \
  'GRANT hostile_role TO service_role WITH INHERIT FALSE, SET TRUE' >/dev/null
expect_migration_failure 'service_role upstream authority' 'unsafe-service-upstream'
psql_cmd -c 'REVOKE hostile_role FROM service_role' >/dev/null

psql_cmd -c \
  'GRANT service_role TO postgres WITH INHERIT TRUE, SET TRUE' >/dev/null
psql_cmd -c \
  'GRANT postgres TO shadow_role WITH INHERIT TRUE, SET TRUE' >/dev/null
expect_migration_failure 'recursive custom service inheritor' 'unsafe-service-downstream'
psql_cmd -c 'REVOKE postgres FROM shadow_role' >/dev/null
psql_cmd -c 'REVOKE service_role FROM postgres' >/dev/null

psql_cmd -c \
  'GRANT postgres TO hostile_role WITH INHERIT FALSE, SET TRUE' >/dev/null
psql_cmd -c \
  'GRANT hostile_role TO authenticated WITH INHERIT FALSE, SET TRUE' >/dev/null
expect_migration_failure 'recursive browser owner authority' 'unsafe-browser-chain'
psql_cmd -c 'REVOKE hostile_role FROM authenticated' >/dev/null
psql_cmd -c 'REVOKE postgres FROM hostile_role' >/dev/null

psql_cmd -f "$MIGRATION" >"$LOG_DIR/first-application.log"

expect_failure \
  "SET ROLE anon; SELECT public.activate_group_subscription_atomic('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000005','trial',NULL,NULL,NULL,0,NULL)" \
  'anonymous activation RPC'
expect_failure \
  "SET ROLE authenticated; SELECT id FROM public.group_payment_consumptions" \
  'browser payment ledger read'

# Two independent transactions race the same trial. The actor/group advisory
# lock and immutable trial ledger must create exactly one subscription/slot.
CONNINFO="host=$SOCKET_DIR port=$PORT dbname=postgres"
psql_cmd -v conninfo="$CONNINFO" <<'SQL'
CREATE EXTENSION dblink;
SELECT dblink_connect('trial_a', :'conninfo');
SELECT dblink_connect('trial_b', :'conninfo');
SELECT dblink_exec('trial_a', 'SET ROLE service_role');
SELECT dblink_exec('trial_b', 'SET ROLE service_role');
SELECT dblink_send_query(
  'trial_a',
  $query$
    WITH configured AS (
      SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false)
    )
    SELECT public.activate_group_subscription_atomic(
      '20000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000005',
      'trial', NULL, NULL, NULL, 0, NULL
    )
    FROM configured
  $query$
);
SELECT dblink_send_query(
  'trial_b',
  $query$
    WITH configured AS (
      SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false)
    )
    SELECT public.activate_group_subscription_atomic(
      '20000000-0000-4000-8000-000000000002',
      '50000000-0000-4000-8000-000000000005',
      'trial', NULL, NULL, NULL, 0, NULL
    )
    FROM configured
  $query$
);
CREATE TEMP TABLE trial_race_results (result jsonb);
INSERT INTO trial_race_results
SELECT result FROM dblink_get_result('trial_a') AS response(result jsonb);
INSERT INTO trial_race_results
SELECT result FROM dblink_get_result('trial_b') AS response(result jsonb);
DO $trial_race_contract$
BEGIN
  IF (SELECT pg_catalog.count(*) FROM trial_race_results) <> 2
    OR (SELECT pg_catalog.count(*) FROM trial_race_results
        WHERE result ->> 'status' = 'subscribed') <> 1
    OR (SELECT pg_catalog.count(*) FROM trial_race_results
        WHERE result ->> 'status' = 'already_active') <> 1
    OR (
      SELECT pg_catalog.count(*)
      FROM public.group_subscriptions
      WHERE group_id = '50000000-0000-4000-8000-000000000005'
        AND user_id = '20000000-0000-4000-8000-000000000002'
        AND tier = 'trial'
    ) <> 1
    OR (
      SELECT pg_catalog.count(*)
      FROM public.group_trial_consumptions
      WHERE group_id = '50000000-0000-4000-8000-000000000005'
        AND user_id = '20000000-0000-4000-8000-000000000002'
    ) <> 1
  THEN
    RAISE EXCEPTION 'concurrent trial was not consumed exactly once';
  END IF;
END
$trial_race_contract$;
SELECT dblink_disconnect('trial_a');
SELECT dblink_disconnect('trial_b');
SQL

psql_cmd <<'SQL'
-- An expired historical trial cannot be restarted.
UPDATE public.group_subscriptions
SET expires_at = pg_catalog.clock_timestamp() - interval '1 day'
WHERE group_id = '50000000-0000-4000-8000-000000000005'
  AND user_id = '20000000-0000-4000-8000-000000000002';

SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $trial_once_contract$
DECLARE
  result jsonb;
BEGIN
  result := public.activate_group_subscription_atomic(
    '20000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000005',
    'trial', NULL, NULL, NULL, 0, NULL
  );
  IF result ->> 'status' <> 'trial_already_used' THEN
    RAISE EXCEPTION 'expired trial restarted: %', result;
  END IF;
END
$trial_once_contract$;
RESET ROLE;
SQL

psql_cmd <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $payment_replay_and_renewal_contract$
DECLARE
  first_result jsonb;
  replay_result jsonb;
  cross_actor jsonb;
  cross_group jsonb;
  cross_tier jsonb;
  cross_amount jsonb;
  renewal_result jsonb;
  cancel_result jsonb;
  read_result jsonb;
  renewal_after_cancel jsonb;
  subscription_id uuid;
  initial_expiry timestamptz;
  renewed_expiry timestamptz;
BEGIN
  first_result := public.activate_group_subscription_atomic(
    '10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000005',
    'monthly', 'stripe', 'pi_atomic_one', NULL, 990, 'usd'
  );
  IF first_result ->> 'status' <> 'subscribed'
    OR first_result ->> 'membership_status' <> 'joined'
    OR (first_result ->> 'idempotent_replay')::boolean
  THEN
    RAISE EXCEPTION 'initial paid activation failed: %', first_result;
  END IF;
  subscription_id := (first_result ->> 'subscription_id')::uuid;
  initial_expiry := (first_result ->> 'expires_at')::timestamptz;

  replay_result := public.activate_group_subscription_atomic(
    '10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000005',
    'monthly', 'stripe', 'pi_atomic_one', NULL, 990, 'usd'
  );
  IF replay_result ->> 'status' <> 'subscribed'
    OR NOT (replay_result ->> 'idempotent_replay')::boolean
    OR (replay_result ->> 'expires_at')::timestamptz <> initial_expiry
  THEN
    RAISE EXCEPTION 'same payment was not idempotent: %', replay_result;
  END IF;

  cross_actor := public.activate_group_subscription_atomic(
    '20000000-0000-4000-8000-000000000002',
    '50000000-0000-4000-8000-000000000005',
    'monthly', 'stripe', 'pi_atomic_one', NULL, 990, 'usd'
  );
  cross_group := public.activate_group_subscription_atomic(
    '10000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000006',
    'monthly', 'stripe', 'pi_atomic_one', NULL, 990, 'usd'
  );
  cross_tier := public.activate_group_subscription_atomic(
    '10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000005',
    'yearly', 'stripe', 'pi_atomic_one', NULL, 9990, 'usd'
  );
  cross_amount := public.activate_group_subscription_atomic(
    '10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000005',
    'monthly', 'stripe', 'pi_atomic_one', NULL, 991, 'usd'
  );
  IF cross_actor ->> 'status' <> 'payment_replayed'
    OR cross_group ->> 'status' <> 'payment_replayed'
    OR cross_tier ->> 'status' <> 'payment_replayed'
    OR cross_amount ->> 'status' <> 'payment_replayed'
  THEN
    RAISE EXCEPTION 'cross-subject payment replay was accepted';
  END IF;

  renewal_result := public.activate_group_subscription_atomic(
    '10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000005',
    'yearly', 'stripe', 'pi_atomic_two', 'cs_atomic_two', 9990, 'usd'
  );
  renewed_expiry := (renewal_result ->> 'expires_at')::timestamptz;
  IF renewal_result ->> 'status' <> 'renewed'
    OR renewed_expiry <> initial_expiry + interval '365 days'
  THEN
    RAISE EXCEPTION 'distinct payment did not extend exactly once: %', renewal_result;
  END IF;

  cancel_result := public.cancel_group_subscription_atomic(
    '10000000-0000-4000-8000-000000000001', subscription_id
  );
  IF cancel_result ->> 'status' <> 'cancellation_scheduled' THEN
    RAISE EXCEPTION 'period-end cancellation failed: %', cancel_result;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.group_subscriptions
    WHERE id = subscription_id
      AND status = 'active'
      AND cancel_at_period_end
      AND expires_at = renewed_expiry
  ) THEN
    RAISE EXCEPTION 'cancellation removed prepaid access early';
  END IF;

  read_result := public.read_group_subscription_atomic(
    '10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000005'
  );
  IF read_result ->> 'status' <> 'ok'
    OR NOT (read_result ->> 'is_subscribed')::boolean
    OR NOT (read_result #>> '{subscription,cancel_at_period_end}')::boolean
  THEN
    RAISE EXCEPTION 'scheduled pass was not readable through period end: %', read_result;
  END IF;

  renewal_after_cancel := public.activate_group_subscription_atomic(
    '10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000005',
    'monthly', 'stripe', 'pi_atomic_three', NULL, 990, 'usd'
  );
  IF renewal_after_cancel ->> 'status' <> 'renewed'
    OR EXISTS (
      SELECT 1
      FROM public.group_subscriptions
      WHERE id = subscription_id
        AND cancel_at_period_end
    )
  THEN
    RAISE EXCEPTION 'renewal did not clear period-end cancellation';
  END IF;
END
$payment_replay_and_renewal_contract$;
RESET ROLE;

DO $ledger_cardinality$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.group_payment_consumptions
    WHERE user_id = '10000000-0000-4000-8000-000000000001'
      AND group_id = '50000000-0000-4000-8000-000000000005'
  ) <> 3 THEN
    RAISE EXCEPTION 'payment ledger cardinality drifted';
  END IF;
END
$ledger_cardinality$;
SQL

# A membership failure must roll back the subscription and payment ledger too.
psql_cmd <<'SQL'
CREATE OR REPLACE FUNCTION public.test_fail_group_pass_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.user_id = '30000000-0000-4000-8000-000000000003' THEN
    RAISE EXCEPTION 'injected membership failure';
  END IF;
  RETURN NEW;
END
$function$;
CREATE TRIGGER trg_test_fail_group_pass_membership
  BEFORE INSERT ON public.group_members
  FOR EACH ROW EXECUTE FUNCTION public.test_fail_group_pass_membership();
SQL
expect_failure \
  "SET ROLE service_role; SELECT set_config('request.jwt.claim.role','service_role',false); SELECT public.activate_group_subscription_atomic('30000000-0000-4000-8000-000000000003','70000000-0000-4000-8000-000000000007','monthly','stripe','pi_rollback_one',NULL,2990,'usd')" \
  'injected membership rollback'
psql_cmd <<'SQL'
DO $rollback_contract$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.group_subscriptions
    WHERE user_id = '30000000-0000-4000-8000-000000000003'
      AND group_id = '70000000-0000-4000-8000-000000000007'
  ) OR EXISTS (
    SELECT 1 FROM public.group_payment_consumptions
    WHERE payment_intent_id = 'pi_rollback_one'
  ) OR EXISTS (
    SELECT 1 FROM public.group_members
    WHERE user_id = '30000000-0000-4000-8000-000000000003'
      AND group_id = '70000000-0000-4000-8000-000000000007'
  ) THEN
    RAISE EXCEPTION 'failed membership left partial paid-pass state';
  END IF;
END
$rollback_contract$;
SQL

# Reintroduce unknown ACL, column, policy, function and RLS drift. A replay must
# remove all of it while retaining NO FORCE owner compatibility.
psql_cmd <<'SQL'
ALTER TABLE public.group_payment_consumptions ADD COLUMN processor_payload jsonb;
ALTER TABLE public.group_payment_consumptions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_payment_consumptions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.group_trial_consumptions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_subscriptions DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_subscriptions FORCE ROW LEVEL SECURITY;

GRANT SELECT ON public.group_payment_consumptions
  TO hostile_role WITH GRANT OPTION;
SET ROLE hostile_role;
GRANT SELECT ON public.group_payment_consumptions TO shadow_role;
RESET ROLE;
GRANT SELECT (processor_payload), UPDATE (processor_payload)
  ON public.group_payment_consumptions TO authenticated, hostile_role;
GRANT ALL ON public.group_trial_consumptions TO authenticated, hostile_role;
GRANT SELECT (payment_reference) ON public.group_subscriptions TO authenticated;
CREATE POLICY hostile_payment_ledger_policy
  ON public.group_payment_consumptions FOR ALL TO hostile_role
  USING (true) WITH CHECK (true);
CREATE POLICY hostile_subscription_policy
  ON public.group_subscriptions FOR ALL TO authenticated
  USING (true) WITH CHECK (true);
GRANT EXECUTE ON FUNCTION public.activate_group_subscription_atomic(
  uuid, uuid, text, text, text, text, bigint, text
) TO authenticated, hostile_role;
SQL

psql_cmd -f "$MIGRATION" >"$LOG_DIR/replay-application.log"

psql_cmd <<'SQL'
DO $replay_authority_contract$
DECLARE
  postgres_oid oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
BEGIN
  IF pg_catalog.has_table_privilege(
    'hostile_role', 'public.group_payment_consumptions', 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'shadow_role', 'public.group_payment_consumptions', 'SELECT'
  ) OR pg_catalog.has_column_privilege(
    'authenticated',
    'public.group_payment_consumptions',
    'processor_payload',
    'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'public.group_trial_consumptions', 'SELECT'
  ) OR pg_catalog.has_column_privilege(
    'authenticated',
    'public.group_subscriptions',
    'payment_reference',
    'SELECT'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.activate_group_subscription_atomic(uuid,uuid,text,text,text,text,bigint,text)',
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'public.group_payment_consumptions'::pg_catalog.regclass,
      'public.group_trial_consumptions'::pg_catalog.regclass
    )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_subscriptions'::pg_catalog.regclass
      AND relation.relowner = postgres_oid
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_payment_consumptions'::pg_catalog.regclass
      AND relation.relowner = postgres_oid
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'group pass authority replay did not converge';
  END IF;
END
$replay_authority_contract$;
SQL

# The postgres-owned expiry function remains effective under NO FORCE RLS and
# only invalidates access at the actual period end.
psql_cmd <<'SQL'
UPDATE public.group_subscriptions
SET expires_at = pg_catalog.clock_timestamp() - interval '1 second'
WHERE group_id = '50000000-0000-4000-8000-000000000005'
  AND user_id = '10000000-0000-4000-8000-000000000001';

SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
DO $expiry_contract$
DECLARE
  affected integer;
  result jsonb;
BEGIN
  affected := public.expire_group_subscriptions();
  IF affected < 1 THEN
    RAISE EXCEPTION 'scheduled expiry did not update an elapsed pass';
  END IF;
  result := public.read_group_subscription_atomic(
    '10000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000005'
  );
  IF (result ->> 'is_subscribed')::boolean THEN
    RAISE EXCEPTION 'elapsed pass remained active after scheduled expiry';
  END IF;
END
$expiry_contract$;
RESET ROLE;
SQL

# Parent deletion keeps its validated cascade, while the immutable consumption
# ledger remains as replay evidence.
psql_cmd <<'SQL'
SET ROLE service_role;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.activate_group_subscription_atomic(
  '10000000-0000-4000-8000-000000000001',
  '60000000-0000-4000-8000-000000000006',
  'monthly', 'stripe', 'pi_cascade_one', NULL, 1990, 'usd'
);
RESET ROLE;
DELETE FROM public.groups
WHERE id = '60000000-0000-4000-8000-000000000006';
DO $cascade_contract$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.group_subscriptions
    WHERE group_id = '60000000-0000-4000-8000-000000000006'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.group_payment_consumptions
    WHERE payment_intent_id = 'pi_cascade_one'
  ) THEN
    RAISE EXCEPTION 'parent cascade or immutable replay evidence failed';
  END IF;
END
$cascade_contract$;
SQL

echo "atomic group pass PG17 proof passed"
