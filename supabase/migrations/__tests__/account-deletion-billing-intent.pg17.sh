#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729075700_account_deletion_billing_intent.sql"
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

TMP_ROOT="$(mktemp -d /tmp/account-deletion-billing-intent-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_DIR="$TMP_ROOT/logs"
PORT=55631
mkdir -p "$SOCKET_DIR" "$LOG_DIR"

cleanup() {
  local exit_status=$?
  if ((exit_status != 0)) && [[ -f "$LOG_DIR/postgres.log" ]]; then
    tail -200 "$LOG_DIR/postgres.log" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

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

psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE authenticator NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $function$
  SELECT pg_catalog.current_setting('request.jwt.claim.role', true)
$function$;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  deleted_at timestamptz,
  deletion_scheduled_at timestamptz
);
CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  stripe_subscription_id text,
  status text NOT NULL,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.api_tier_subscription_blocks (
  livemode boolean NOT NULL,
  stripe_subscription_id text NOT NULL,
  block_kind text NOT NULL,
  user_id uuid NOT NULL,
  stripe_customer_id text,
  blocked_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (livemode, stripe_subscription_id, block_kind)
);
CREATE TABLE public.account_recovery_admissions (
  operation_id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  state text NOT NULL,
  lease_expires_at timestamptz NOT NULL
);

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.subscriptions OWNER TO postgres;
ALTER TABLE public.api_tier_subscription_blocks OWNER TO postgres;
ALTER TABLE public.account_recovery_admissions OWNER TO postgres;

CREATE FUNCTION public.schedule_account_deletion_with_billing_blocks(
  p_user_id uuid,
  p_reason text,
  p_scheduled_at timestamptz,
  p_recovery_token_hash text,
  p_stripe_customer_id text,
  p_stripe_subscription_ids text[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_deleted_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  UPDATE public.user_profiles
  SET deleted_at = v_deleted_at,
      deletion_scheduled_at = p_scheduled_at
  WHERE id = p_user_id
    AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'profile unavailable';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'scheduled',
    'user_id', p_user_id,
    'deleted_at', v_deleted_at,
    'deletion_scheduled_at', p_scheduled_at,
    'stripe_customer_id', p_stripe_customer_id,
    'stripe_subscription_ids', p_stripe_subscription_ids
  );
END
$function$;

CREATE FUNCTION public.claim_account_recovery_admission_atomic_locked_impl(
  p_user_id uuid,
  p_recovery_token_hash text,
  p_operation_id uuid
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT 'claimed'::text
$function$;

CREATE FUNCTION public.claim_account_recovery_admission_atomic(
  p_user_id uuid,
  p_recovery_token_hash text,
  p_operation_id uuid
)
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT public.claim_account_recovery_admission_atomic_locked_impl(
    p_user_id,
    p_recovery_token_hash,
    p_operation_id
  )
$function$;

CREATE FUNCTION public.admit_expired_account_hard_delete_atomic(p_user_id uuid)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT pg_catalog.jsonb_build_object('status', 'ready', 'user_id', p_user_id)
$function$;

ALTER FUNCTION public.schedule_account_deletion_with_billing_blocks(
  uuid, text, timestamptz, text, text, text[]
) OWNER TO postgres;
ALTER FUNCTION public.claim_account_recovery_admission_atomic_locked_impl(uuid, text, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.claim_account_recovery_admission_atomic(uuid, text, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.admit_expired_account_hard_delete_atomic(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_account_recovery_admission_atomic_locked_impl(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.claim_account_recovery_admission_atomic(uuid, text, uuid)
  FROM PUBLIC, anon, authenticated, authenticator;
REVOKE ALL ON FUNCTION public.admit_expired_account_hard_delete_atomic(uuid)
  FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION public.claim_account_recovery_admission_atomic(uuid, text, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.admit_expired_account_hard_delete_atomic(uuid)
  TO service_role;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

INSERT INTO public.user_profiles (id)
VALUES ('11111111-1111-4111-8111-111111111111');
INSERT INTO public.subscriptions (
  user_id,
  stripe_subscription_id,
  status,
  cancel_at_period_end
) VALUES (
  '11111111-1111-4111-8111-111111111111',
  'sub_initial',
  'active',
  true
);

DO $prepared_blocks_recovery$
DECLARE
  v_result jsonb;
  v_claim text;
  v_hard_delete jsonb;
BEGIN
  v_result := public.prepare_account_deletion_billing_atomic(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'privacy',
    pg_catalog.clock_timestamp() + interval '30 days',
    pg_catalog.repeat('a', 64),
    'cus_owner',
    ARRAY['sub_initial']::text[]
  );
  IF v_result->>'status' IS DISTINCT FROM 'prepared'
    OR NOT EXISTS (
      SELECT 1
      FROM public.user_profiles
      WHERE id = '11111111-1111-4111-8111-111111111111'
        AND deleted_at IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'prepare did not atomically persist its tombstone';
  END IF;

  v_claim := public.claim_account_recovery_admission_atomic(
    '11111111-1111-4111-8111-111111111111',
    pg_catalog.repeat('a', 64),
    'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  );
  IF v_claim IS DISTINCT FROM 'busy' THEN
    RAISE EXCEPTION 'prepared billing did not block recovery: %', v_claim;
  END IF;

  v_hard_delete := public.admit_expired_account_hard_delete_atomic(
    '11111111-1111-4111-8111-111111111111'
  );
  IF v_hard_delete->>'status' IS DISTINCT FROM 'billing_settlement_in_progress' THEN
    RAISE EXCEPTION 'prepared billing did not block hard deletion: %', v_hard_delete;
  END IF;
END
$prepared_blocks_recovery$;

DO $prepared_blocks_hard_delete$
DECLARE
  v_result jsonb;
BEGIN
  v_result := public.finish_account_deletion_billing_atomic(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'cus_owner',
    ARRAY['sub_initial', 'sub_raced']::text[]
  );
  IF v_result->>'status' IS DISTINCT FROM 'settled' THEN
    RAISE EXCEPTION 'finish did not settle: %', v_result;
  END IF;
  IF (
    SELECT pg_catalog.count(*)
    FROM public.api_tier_subscription_blocks
    WHERE user_id = '11111111-1111-4111-8111-111111111111'
      AND stripe_subscription_id IN ('sub_initial', 'sub_raced')
  ) <> 4 THEN
    RAISE EXCEPTION 'finish did not block every mode and subscription';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.subscriptions
    WHERE user_id = '11111111-1111-4111-8111-111111111111'
      AND stripe_subscription_id = 'sub_initial'
      AND status = 'canceled'
      AND cancel_at_period_end = false
  ) THEN
    RAISE EXCEPTION 'finish did not converge the local projection';
  END IF;
END
$prepared_blocks_hard_delete$;

DO $settled_allows_recovery$
DECLARE
  v_claim text;
  v_replay jsonb;
BEGIN
  v_claim := public.claim_account_recovery_admission_atomic(
    '11111111-1111-4111-8111-111111111111',
    pg_catalog.repeat('a', 64),
    'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  );
  IF v_claim IS DISTINCT FROM 'claimed' THEN
    RAISE EXCEPTION 'settled billing did not release recovery: %', v_claim;
  END IF;

  v_replay := public.finish_account_deletion_billing_atomic(
    '11111111-1111-4111-8111-111111111111',
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    'cus_owner',
    ARRAY['sub_initial', 'sub_raced']::text[]
  );
  IF v_replay->>'status' IS DISTINCT FROM 'settled' THEN
    RAISE EXCEPTION 'exact finish replay failed: %', v_replay;
  END IF;
END
$settled_allows_recovery$;

DO $acl_proof$
BEGIN
  IF pg_catalog.has_function_privilege(
    'authenticated',
    'public.prepare_account_deletion_billing_atomic(uuid,uuid,text,timestamp with time zone,text,text,text[])',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.finish_account_deletion_billing_atomic(uuid,uuid,text,text[])',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'billing intent functions leaked to API roles';
  END IF;
END
$acl_proof$;
SQL

psql_cmd <<'SQL'
INSERT INTO public.user_profiles (id)
VALUES ('33333333-3333-4333-8333-333333333333');
SQL

PREPARE_HOLDER_LOG="$LOG_DIR/concurrent-prepare-holder.log"
psql_cmd >"$PREPARE_HOLDER_LOG" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.set_config('application_name', 'billing-prepare-holder', false);
SELECT public.prepare_account_deletion_billing_atomic(
  '33333333-3333-4333-8333-333333333333',
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  'concurrent recovery proof',
  pg_catalog.clock_timestamp() + interval '30 days',
  pg_catalog.repeat('d', 64),
  NULL,
  ARRAY[]::text[]
);
SELECT pg_catalog.pg_sleep(2);
COMMIT;
SQL
prepare_holder_pid=$!

prepare_lock_visible=false
for _attempt in {1..100}; do
  if [[ "$(psql_cmd -Atc "
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_locks AS held_lock
    JOIN pg_catalog.pg_stat_activity AS activity
      ON activity.pid = held_lock.pid
    WHERE activity.application_name = 'billing-prepare-holder'
      AND held_lock.locktype = 'advisory'
      AND held_lock.granted
  ")" != "0" ]]; then
    prepare_lock_visible=true
    break
  fi
  sleep 0.02
done
if [[ "$prepare_lock_visible" != true ]]; then
  wait "$prepare_holder_pid" || true
  cat "$PREPARE_HOLDER_LOG" >&2
  echo "Concurrent prepare never exposed its recovery advisory lock" >&2
  exit 1
fi

concurrent_claim="$({ psql_cmd -At <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.claim_account_recovery_admission_atomic(
  '33333333-3333-4333-8333-333333333333',
  pg_catalog.repeat('d', 64),
  'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
);
SQL
} | tail -n 1)"
wait "$prepare_holder_pid"
if [[ "$concurrent_claim" != "busy" ]]; then
  cat "$PREPARE_HOLDER_LOG" >&2
  echo "Concurrent recovery bypassed prepared deletion: $concurrent_claim" >&2
  exit 1
fi

echo "Account deletion billing intent PostgreSQL 17 proof passed"
