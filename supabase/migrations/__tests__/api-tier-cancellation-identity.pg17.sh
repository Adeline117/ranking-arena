#!/usr/bin/env bash

# Isolated PostgreSQL 17 proof for the API-tier Stripe event ledger, ordering,
# replay, role graph, ACL convergence, and FORCE-RLS atomic rollback.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729020000_api_tier_cancellation_identity.sql"
CLEANUP_MIGRATION="$ROOT_DIR/supabase/migrations/20260729021000_disable_legacy_api_tier_writer.sql"
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

TMP_ROOT="$(mktemp -d /tmp/api-tier-event-ledger-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55530
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((exit_code != 0)); then
    [[ -f "$LOG_FILE" ]] && tail -240 "$LOG_FILE" >&2 || true
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

expect_migration_failure() {
  local label="$1"
  if psql_cmd -f "$MIGRATION" >/dev/null 2>&1; then
    echo "Expected migration failure: $label" >&2
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
CREATE ROLE hostile_role NOLOGIN;

GRANT service_role TO authenticator
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;

GRANT USAGE ON SCHEMA public
  TO anon, authenticated, service_role, authenticator, hostile_role;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY,
  api_tier text NOT NULL DEFAULT 'free'
    CHECK (api_tier IN ('free', 'starter', 'pro')),
  api_stripe_subscription_id text,
  stripe_customer_id text,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  updated_at timestamptz
);
ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.api_keys (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  key text NOT NULL UNIQUE DEFAULT (
    'arena_sk_' || pg_catalog.replace(
      pg_catalog.gen_random_uuid()::text,
      '-',
      ''
    )
  ),
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

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.user_profiles, public.api_keys
  TO service_role;
CREATE POLICY service_role_manages_user_profiles
  ON public.user_profiles
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
CREATE POLICY service_role_manages_api_keys
  ON public.api_keys
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

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
  UPDATE public.user_profiles
  SET
    api_tier = p_api_tier,
    api_stripe_subscription_id = p_stripe_subscription_id,
    updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_user_id;

  UPDATE public.api_keys
  SET
    tier = p_api_tier,
    daily_limit = p_daily_limit
  WHERE user_id = p_user_id
    AND active;
END
$function$;
ALTER FUNCTION public.update_user_api_tier(uuid, text, text, integer)
  OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.update_user_api_tier(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.update_user_api_tier(uuid, text, text, integer)
  TO service_role;

CREATE FUNCTION public.schedule_account_deletion(
  p_user_id uuid,
  p_reason text,
  p_scheduled_at timestamptz,
  p_recovery_token_hash text
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_deleted_at timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF p_scheduled_at <= v_deleted_at
    OR p_recovery_token_hash IS NULL
    OR p_reason IS NULL
  THEN
    RAISE EXCEPTION 'invalid test account deletion input';
  END IF;

  UPDATE public.user_profiles
  SET
    deleted_at = v_deleted_at,
    updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_user_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'test account deletion profile unavailable';
  END IF;
  RETURN v_deleted_at;
END
$function$;
ALTER FUNCTION public.schedule_account_deletion(uuid, text, timestamptz, text)
  OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.schedule_account_deletion(uuid, text, timestamptz, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
  ON FUNCTION public.schedule_account_deletion(uuid, text, timestamptz, text)
  TO service_role;

INSERT INTO public.user_profiles (
  id,
  api_tier,
  api_stripe_subscription_id,
  stripe_customer_id
) VALUES
  (
    '10000000-0000-4000-8000-000000000001',
    'starter',
    'sub_base',
    'cus_1'
  ),
  (
    '10000000-0000-4000-8000-000000000002',
    'free',
    NULL,
    'cus_2'
  ),
  (
    '10000000-0000-4000-8000-000000000003',
    'pro',
    'sub_historical',
    'cus_3'
  ),
  (
    '10000000-0000-4000-8000-000000000004',
    'free',
    NULL,
    'cus_4'
  ),
  (
    '10000000-0000-4000-8000-000000000005',
    'free',
    NULL,
    'cus_5'
  ),
  (
    '10000000-0000-4000-8000-000000000006',
    'free',
    NULL,
    'cus_6'
  ),
  (
    '10000000-0000-4000-8000-000000000007',
    'free',
    NULL,
    'cus_7'
  ),
  (
    '10000000-0000-4000-8000-000000000008',
    'free',
    NULL,
    'cus_8'
  ),
  (
    '10000000-0000-4000-8000-000000000009',
    'pro',
    'sub_persisted_legacy_9',
    'cus_9'
  ),
  (
    '10000000-0000-4000-8000-000000000010',
    'free',
    NULL,
    'cus_10'
  ),
  (
    '10000000-0000-4000-8000-000000000011',
    'free',
    NULL,
    'cus_11'
  ),
  (
    '10000000-0000-4000-8000-000000000012',
    'starter',
    'sub_persisted_suspend_12',
    'cus_12'
  ),
  (
    '10000000-0000-4000-8000-000000000013',
    'free',
    NULL,
    'cus_13'
  ),
  (
    '10000000-0000-4000-8000-000000000014',
    'starter',
    'sub_legacy_deleted_14',
    NULL
  );

INSERT INTO public.api_keys (id, user_id, active, tier, daily_limit)
VALUES
  (
    '20000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000001',
    true,
    'starter',
    10000
  ),
  (
    '20000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001',
    false,
    'pro',
    0
  ),
  (
    '20000000-0000-4000-8000-000000000003',
    '10000000-0000-4000-8000-000000000002',
    true,
    'free',
    100
  ),
  (
    '20000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000003',
    true,
    'pro',
    0
  ),
  (
    '20000000-0000-4000-8000-000000000005',
    '10000000-0000-4000-8000-000000000004',
    true,
    'free',
    100
  ),
  (
    '20000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000005',
    true,
    'free',
    100
  ),
  (
    '20000000-0000-4000-8000-000000000013',
    '10000000-0000-4000-8000-000000000013',
    true,
    'free',
    100
  );
SQL

psql_cmd -f "$MIGRATION"

# Preserve the original ordering test vocabulary while exercising the new
# nineteen-argument authority. This test-only SECURITY DEFINER helper creates
# the already-converted checkout identity that each synthetic new subscription
# would have obtained from reserve/bind in production.
psql_cmd <<'SQL'
CREATE FUNCTION public.test_apply_user_api_tier_stripe_event(
  p_user_id uuid,
  p_api_tier text,
  p_daily_limit integer,
  p_stripe_subscription_id text,
  p_subscription_created bigint,
  p_stripe_event_id text,
  p_event_created bigint,
  p_is_active boolean,
  p_is_terminal boolean,
  p_livemode boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_customer_id text;
  v_current_subscription_id text;
  v_reservation_id uuid;
  v_seen_subscription boolean := false;
  v_checkout_session_id text;
  v_price_id text := CASE p_api_tier
    WHEN 'pro' THEN 'price_api_pro'
    ELSE 'price_api_starter'
  END;
  v_plan text := CASE p_api_tier
    WHEN 'pro' THEN 'pro'
    ELSE 'starter'
  END;
  v_checkout_expires_at bigint := pg_catalog.floor(
    extract(
      epoch FROM pg_catalog.clock_timestamp() + interval '45 minutes'
    )
  )::bigint;
BEGIN
  SELECT
    profile.stripe_customer_id,
    profile.api_stripe_subscription_id
  INTO v_customer_id, v_current_subscription_id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id;

  SELECT
    true,
    ledger.checkout_reservation_id
  INTO v_seen_subscription, v_reservation_id
  FROM public.api_tier_stripe_event_ledger AS ledger
  WHERE ledger.user_id = p_user_id
    AND ledger.livemode = p_livemode
    AND ledger.stripe_subscription_id = p_stripe_subscription_id
  LIMIT 1;

  IF v_reservation_id IS NOT NULL THEN
    SELECT
      reservation.api_plan,
      reservation.stripe_price_id,
      reservation.checkout_session_id
    INTO v_plan, v_price_id, v_checkout_session_id
    FROM public.api_tier_checkout_reservations AS reservation
    WHERE reservation.id = v_reservation_id;
  END IF;

  IF NOT COALESCE(v_seen_subscription, false)
    AND v_current_subscription_id IS DISTINCT FROM
      p_stripe_subscription_id
  THEN
    SELECT
      reservation.id,
      reservation.api_plan,
      reservation.stripe_price_id,
      reservation.checkout_session_id
    INTO
      v_reservation_id,
      v_plan,
      v_price_id,
      v_checkout_session_id
    FROM public.api_tier_checkout_reservations AS reservation
    WHERE reservation.livemode = p_livemode
      AND reservation.stripe_subscription_id =
        p_stripe_subscription_id;

    IF NOT FOUND THEN
      v_price_id := CASE p_api_tier
        WHEN 'pro' THEN 'price_api_pro'
        ELSE 'price_api_starter'
      END;
      v_plan := CASE p_api_tier
        WHEN 'pro' THEN 'pro'
        ELSE 'starter'
      END;
      v_checkout_session_id :=
        'cs_test_' || p_stripe_subscription_id;
      INSERT INTO public.api_tier_checkout_reservations (
        user_id,
        livemode,
        stripe_customer_id,
        api_plan,
        stripe_price_id,
        status,
        checkout_expires_at,
        lease_expires_at,
        checkout_session_id,
        stripe_subscription_id
      ) VALUES (
        p_user_id,
        p_livemode,
        v_customer_id,
        v_plan,
        v_price_id,
        'converted',
        v_checkout_expires_at,
        pg_catalog.clock_timestamp() + interval '15 minutes',
        v_checkout_session_id,
        p_stripe_subscription_id
      )
      RETURNING id INTO v_reservation_id;
    END IF;
  END IF;

  RETURN public.apply_user_api_tier_stripe_event(
    p_user_id => p_user_id,
    p_metadata_user_id => p_user_id,
    p_metadata_supabase_user_id => p_user_id,
    p_stripe_customer_id => v_customer_id,
    p_checkout_reservation_id => v_reservation_id,
    p_stripe_price_id => v_price_id,
    p_api_tier => p_api_tier,
    p_daily_limit => p_daily_limit,
    p_stripe_subscription_id => p_stripe_subscription_id,
    p_subscription_created => p_subscription_created,
    p_stripe_event_id => p_stripe_event_id,
    p_event_created => p_event_created,
    p_is_active => p_is_active,
    p_is_terminal => p_is_terminal,
    p_livemode => p_livemode,
    p_checkout_session_id => CASE
      WHEN v_reservation_id IS NULL THEN NULL
      ELSE v_checkout_session_id
    END,
    p_checkout_api_plan => CASE
      WHEN v_reservation_id IS NULL THEN NULL
      ELSE v_plan
    END,
    p_checkout_price_id => CASE
      WHEN v_reservation_id IS NULL THEN NULL
      ELSE v_price_id
    END,
    p_identity_source => 'signed_metadata'
  );
END
$function$;
ALTER FUNCTION public.test_apply_user_api_tier_stripe_event(
  uuid,
  text,
  integer,
  text,
  bigint,
  text,
  bigint,
  boolean,
  boolean,
  boolean
) OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.test_apply_user_api_tier_stripe_event(
    uuid,
    text,
    integer,
    text,
    bigint,
    text,
    bigint,
    boolean,
    boolean,
    boolean
  )
  FROM PUBLIC, anon, authenticated, hostile_role;
GRANT EXECUTE
  ON FUNCTION public.test_apply_user_api_tier_stripe_event(
    uuid,
    text,
    integer,
    text,
    bigint,
    text,
    bigint,
    boolean,
    boolean,
    boolean
  )
  TO service_role;
SQL

# A copied API key must stop at the database boundary as soon as deletion is
# scheduled. Late signed billing events remain durable but cannot recreate
# quota, and Auth/profile hard deletion must not erase their identity ledger.
psql_cmd <<'SQL'
INSERT INTO public.api_tier_checkout_reservations (
  id,
  user_id,
  livemode,
  stripe_customer_id,
  api_plan,
  stripe_price_id,
  status,
  checkout_expires_at,
  lease_expires_at
) VALUES (
  '70000000-0000-4000-8000-000000000013',
  '10000000-0000-4000-8000-000000000013',
  false,
  'cus_13',
  'starter',
  'price_api_starter',
  'reserved',
  2000000000,
  pg_catalog.clock_timestamp() + interval '15 minutes'
);

SET ROLE service_role;
DO $soft_deleted_api_key_proof$
DECLARE
  v_status text;
  v_schedule jsonb;
  v_new_key jsonb;
  v_key text;
  v_allowed boolean;
  v_remaining integer;
  v_limit integer;
BEGIN
  v_status := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000013',
    'pro',
    0,
    'sub_deleted_subject',
    1300,
    'evt_deleted_subject_active',
    1300,
    true,
    false,
    true
  );
  IF v_status <> 'applied' THEN
    RAISE EXCEPTION 'deleted-subject paid seed failed: %', v_status;
  END IF;

  SELECT api_key.key
  INTO v_key
  FROM public.api_keys AS api_key
  WHERE api_key.id = '20000000-0000-4000-8000-000000000013';

  SELECT usage.allowed, usage.remaining, usage.daily_limit
  INTO v_allowed, v_remaining, v_limit
  FROM public.increment_api_key_usage(v_key) AS usage;
  IF NOT v_allowed OR v_remaining <> -1 OR v_limit <> 0 THEN
    RAISE EXCEPTION 'active paid API key was unexpectedly denied';
  END IF;

  v_schedule :=
    public.schedule_account_deletion_with_billing_blocks(
      '10000000-0000-4000-8000-000000000013',
      'test deletion',
      pg_catalog.clock_timestamp() + interval '30 days',
      pg_catalog.repeat('a', 64),
      'cus_13',
      ARRAY['sub_deleted_subject']::text[]
    );

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.jsonb_object_keys(v_schedule)
  ) <> 6
    OR v_schedule->>'status' <> 'scheduled'
    OR v_schedule->>'user_id' <>
      '10000000-0000-4000-8000-000000000013'
    OR v_schedule->>'stripe_customer_id' <> 'cus_13'
    OR v_schedule->'stripe_subscription_ids' <>
      '["sub_deleted_subject"]'::jsonb
  THEN
    RAISE EXCEPTION
      'account deletion billing-block acknowledgement drifted: %',
      v_schedule;
  END IF;

  SELECT usage.allowed, usage.remaining, usage.daily_limit
  INTO v_allowed, v_remaining, v_limit
  FROM public.increment_api_key_usage(v_key) AS usage;

  IF v_allowed OR v_remaining <> 0 OR v_limit <> 0
    OR NOT EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.id = '10000000-0000-4000-8000-000000000013'
        AND profile.deleted_at IS NOT NULL
        AND profile.api_tier = 'free'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.api_keys AS api_key
      WHERE api_key.id = '20000000-0000-4000-8000-000000000013'
        AND NOT api_key.active
        AND api_key.tier = 'free'
        AND api_key.daily_limit = 100
        AND api_key.revoked_at IS NOT NULL
        AND api_key.request_count_today = 1
    )
  THEN
    RAISE EXCEPTION 'soft-deleted account retained a usable API key';
  END IF;

  v_status := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000013',
    'pro',
    0,
    'sub_deleted_subject',
    1300,
    'evt_deleted_subject_late_active',
    1301,
    true,
    false,
    true
  );
  IF v_status <> 'blocked'
    OR NOT EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.id = '10000000-0000-4000-8000-000000000013'
        AND profile.api_tier = 'free'
        AND profile.api_stripe_subscription_id IS NULL
    )
  THEN
    RAISE EXCEPTION 'late active event recreated deleted-account quota';
  END IF;

  UPDATE public.user_profiles
  SET deleted_at = NULL
  WHERE id = '10000000-0000-4000-8000-000000000013';

  v_status := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000013',
    'pro',
    0,
    'sub_deleted_subject',
    1300,
    'evt_deleted_subject_after_restore',
    1302,
    true,
    false,
    true
  );
  IF v_status <> 'blocked'
    OR NOT EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.id = '10000000-0000-4000-8000-000000000013'
        AND profile.deleted_at IS NULL
        AND profile.api_tier = 'free'
        AND profile.api_stripe_subscription_id IS NULL
    )
  THEN
    RAISE EXCEPTION
      'restored account accepted its permanently blocked old subscription';
  END IF;

  v_status := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000013',
    'starter',
    10000,
    'sub_restored_fresh',
    1400,
    'evt_restored_fresh_active',
    1400,
    true,
    false,
    true
  );
  v_new_key := public.create_user_api_key_with_current_entitlement(
    '10000000-0000-4000-8000-000000000013',
    'arena_sk_14141414141414141414141414141414',
    'Recovered'
  );
  IF v_status <> 'applied'
    OR v_new_key->>'tier' <> 'starter'
    OR (v_new_key->>'daily_limit')::integer <> 10000
    OR NOT EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.id = '10000000-0000-4000-8000-000000000013'
        AND profile.api_tier = 'starter'
        AND profile.api_stripe_subscription_id =
          'sub_restored_fresh'
    )
  THEN
    RAISE EXCEPTION
      'restored account could not grant a distinct fresh subscription';
  END IF;

  UPDATE public.user_profiles
  SET deleted_at = pg_catalog.clock_timestamp()
  WHERE id = '10000000-0000-4000-8000-000000000013';
END
$soft_deleted_api_key_proof$;
RESET ROLE;
SQL

if [[ "$(
  psql_cmd -Atqc \
    "SELECT pg_catalog.count(*) FROM public.api_tier_subscription_blocks WHERE user_id = '10000000-0000-4000-8000-000000000013' AND stripe_subscription_id = 'sub_deleted_subject' AND block_kind = 'account_deletion'"
)" != "2" ]]; then
  echo "account deletion did not persist both-mode subscription blocks" >&2
  exit 1
fi

# A pre-ledger legacy subscription may have neither a checkout reservation nor
# a local customer. The exact Stripe-derived customer is backfilled under the
# same locks, and its deletion block must let delayed signed events converge
# durably instead of failing before the block lookup.
psql_cmd <<'SQL'
SET ROLE service_role;
DO $legacy_deletion_block_proof$
DECLARE
  v_schedule jsonb;
  v_status text;
BEGIN
  v_schedule :=
    public.schedule_account_deletion_with_billing_blocks(
      '10000000-0000-4000-8000-000000000014',
      'legacy deletion',
      pg_catalog.clock_timestamp() + interval '30 days',
      pg_catalog.repeat('b', 64),
      'cus_14',
      ARRAY['sub_legacy_deleted_14']::text[]
    );

  IF v_schedule->>'status' <> 'scheduled'
    OR v_schedule->>'stripe_customer_id' <> 'cus_14'
    OR NOT EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.id = '10000000-0000-4000-8000-000000000014'
        AND profile.stripe_customer_id = 'cus_14'
        AND profile.deleted_at IS NOT NULL
        AND profile.api_tier = 'free'
        AND profile.api_stripe_subscription_id IS NULL
    )
  THEN
    RAISE EXCEPTION
      'null profile customer was not backfilled under deletion locks';
  END IF;

  UPDATE public.user_profiles
  SET deleted_at = NULL
  WHERE id = '10000000-0000-4000-8000-000000000014';

  v_status := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000014',
    '10000000-0000-4000-8000-000000000014',
    '10000000-0000-4000-8000-000000000014',
    'cus_14',
    NULL,
    'price_api_legacy_starter',
    'starter',
    10000,
    'sub_legacy_deleted_14',
    1500,
    'evt_legacy_deleted_14_active',
    1500,
    true,
    false,
    true,
    NULL,
    NULL,
    NULL,
    'signed_metadata'
  );

  IF v_status <> 'blocked'
    OR NOT EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.id = '10000000-0000-4000-8000-000000000014'
        AND profile.deleted_at IS NULL
        AND profile.api_tier = 'free'
        AND profile.api_stripe_subscription_id IS NULL
    )
  THEN
    RAISE EXCEPTION
      'legacy blocked subscription without reservation was rejected';
  END IF;
END
$legacy_deletion_block_proof$;
RESET ROLE;
SQL

if [[ "$(
  psql_cmd -Atqc \
    "SELECT pg_catalog.count(*) FROM public.api_tier_subscription_blocks WHERE user_id = '10000000-0000-4000-8000-000000000014' AND stripe_subscription_id = 'sub_legacy_deleted_14' AND block_kind = 'account_deletion'"
)" != "2" ]]; then
  echo "legacy deletion block did not survive recovery" >&2
  exit 1
fi

expect_failure \
  "SET ROLE service_role; SELECT public.reserve_api_tier_checkout_atomic('10000000-0000-4000-8000-000000000013', true, 'cus_13', 'starter', 'price_api_starter')" \
  "soft-deleted account created another API checkout"
expect_failure \
  "SET ROLE service_role; SELECT public.create_user_api_key_with_current_entitlement('10000000-0000-4000-8000-000000000013', 'arena_sk_13131313131313131313131313131313', 'Deleted')" \
  "soft-deleted account created another API key"
expect_failure \
  "SET ROLE service_role; SELECT public.bind_api_tier_checkout_session_atomic('70000000-0000-4000-8000-000000000013', '10000000-0000-4000-8000-000000000013', false, 'cus_13', 'starter', 'price_api_starter', 'cs_deleted_race', 2000000000)" \
  "soft-deleted account bound a newly created Checkout Session"

psql_cmd <<'SQL'
DO $hard_deleted_billing_identity_proof$
DECLARE
  v_reservation public.api_tier_checkout_reservations%ROWTYPE;
  v_status text;
  v_key text;
  v_allowed boolean;
BEGIN
  SELECT reservation.*
  INTO STRICT v_reservation
  FROM public.api_tier_checkout_reservations AS reservation
  WHERE reservation.user_id =
      '10000000-0000-4000-8000-000000000013'
    AND reservation.stripe_subscription_id =
      'sub_deleted_subject';

  SELECT api_key.key
  INTO STRICT v_key
  FROM public.api_keys AS api_key
  WHERE api_key.id = '20000000-0000-4000-8000-000000000013';

  DELETE FROM public.user_profiles
  WHERE id = '10000000-0000-4000-8000-000000000013';

  v_status := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000013',
    '10000000-0000-4000-8000-000000000013',
    '10000000-0000-4000-8000-000000000013',
    'cus_13',
    v_reservation.id,
    v_reservation.stripe_price_id,
    'free',
    100,
    'sub_deleted_subject',
    1300,
    'evt_hard_deleted_terminal',
    1302,
    false,
    true,
    true,
    v_reservation.checkout_session_id,
    v_reservation.api_plan,
    v_reservation.stripe_price_id,
    'signed_metadata'
  );

  SELECT usage.allowed
  INTO v_allowed
  FROM public.increment_api_key_usage(v_key) AS usage;

  IF v_status <> 'subject_deleted'
    OR v_allowed
    OR EXISTS (
      SELECT 1
      FROM public.user_profiles
      WHERE id = '10000000-0000-4000-8000-000000000013'
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM public.api_tier_stripe_event_ledger
      WHERE user_id = '10000000-0000-4000-8000-000000000013'
    ) <> 5
    OR NOT EXISTS (
      SELECT 1
      FROM public.api_tier_stripe_event_ledger
      WHERE stripe_event_id = 'evt_hard_deleted_terminal'
        AND is_terminal
    )
  THEN
    RAISE EXCEPTION
      'hard-deleted account erased durable API billing identity';
  END IF;
END
$hard_deleted_billing_identity_proof$;
SQL

# The event authority and its owner-only ledgers must not be reachable by a
# browser or arbitrary role. During the additive rollout only service_role
# retains the reviewed legacy updater until the postdeploy cutover.
for role in anon authenticated hostile_role; do
  expect_failure \
    "SET ROLE $role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'cus_1', NULL, 'price_api_starter', 'starter', 10000, 'sub_base', 100, 'evt_denied_$role', 100, true, false, true, NULL, NULL, NULL, 'signed_metadata')" \
    "$role could execute the service-only Stripe event authority"
  expect_failure \
    "SET ROLE $role; SELECT public.create_user_api_key_with_current_entitlement('10000000-0000-4000-8000-000000000001', 'arena_sk_00000000000000000000000000000000', 'Denied')" \
    "$role could execute the service-only API key entitlement authority"
  expect_failure \
    "SET ROLE $role; SELECT * FROM public.api_tier_stripe_event_ledger" \
    "$role could read the owner-only Stripe event ledger"
  expect_failure \
    "SET ROLE $role; SELECT * FROM public.api_tier_checkout_reservations" \
    "$role could read owner-only API checkout reservations"
  expect_failure \
    "SET ROLE $role; SELECT public.reserve_api_tier_checkout_atomic('10000000-0000-4000-8000-000000000007', true, 'cus_7', 'starter', 'price_api_starter')" \
    "$role could reserve an API checkout"
  expect_failure \
    "SET ROLE $role; SELECT public.bind_api_tier_checkout_session_atomic('70000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000007', true, 'cus_7', 'starter', 'price_api_starter', 'cs_denied', 2000000000)" \
    "$role could bind an API checkout Session"
  expect_failure \
    "SET ROLE $role; SELECT public.release_api_tier_checkout_reservation_atomic('70000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000007', true, 'cus_7', 'cs_denied', 'evt_denied_release', 2000000000)" \
    "$role could release an API checkout reservation"
done
if [[ "$(
  psql_cmd -Atqc \
    "SELECT pg_catalog.has_function_privilege('service_role', 'public.update_user_api_tier(uuid,text,text,integer)', 'EXECUTE')"
)" != "t" ]]; then
  echo "legacy compatibility updater was unavailable during additive rollout" >&2
  exit 1
fi

# One user/mode can hold exactly one checkout. A second tab or a different
# plan must receive the same durable reservation. An exact signed Stripe
# expiration can release it before the scheduled expires_at too, because the
# application deliberately expires unsafe/unpublishable Sessions.
psql_cmd <<'SQL'
DO $reservation_lifecycle_proof$
DECLARE
  v_first jsonb;
  v_second jsonb;
  v_bound jsonb;
  v_replayed_bind jsonb;
  v_released jsonb;
  v_replayed_release jsonb;
  v_next jsonb;
  v_reservation_id uuid;
  v_checkout_expires_at bigint;
  v_event_created bigint;
BEGIN
  v_first := public.reserve_api_tier_checkout_atomic(
    '10000000-0000-4000-8000-000000000007',
    true,
    'cus_7',
    'starter',
    'price_api_starter'
  );
  v_reservation_id := (v_first->>'reservation_id')::uuid;
  v_checkout_expires_at :=
    (v_first->>'checkout_expires_at')::bigint;

  v_second := public.reserve_api_tier_checkout_atomic(
    '10000000-0000-4000-8000-000000000007',
    true,
    'cus_7',
    'pro',
    'price_api_pro'
  );
  IF v_first->>'status' <> 'reserved'
    OR v_second->>'status' <> 'existing'
    OR (v_second->>'reservation_id')::uuid <> v_reservation_id
    OR v_second->>'api_plan' <> 'starter'
    OR v_second->>'stripe_price_id' <> 'price_api_starter'
    OR (
      SELECT pg_catalog.count(*)
      FROM public.api_tier_checkout_reservations
      WHERE user_id =
        '10000000-0000-4000-8000-000000000007'
        AND livemode
        AND status IN ('reserved', 'bound')
    ) <> 1
  THEN
    RAISE EXCEPTION
      'double checkout did not converge to one reservation: %, %',
      v_first,
      v_second;
  END IF;

  UPDATE public.user_profiles
  SET stripe_customer_id = 'cus_7_changed'
  WHERE id = '10000000-0000-4000-8000-000000000007';
  BEGIN
    PERFORM public.reserve_api_tier_checkout_atomic(
      '10000000-0000-4000-8000-000000000007',
      true,
      'cus_7_changed',
      'starter',
      'price_api_starter'
    );
    RAISE EXCEPTION
      'existing reservation accepted a changed Stripe customer';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;
  UPDATE public.user_profiles
  SET stripe_customer_id = 'cus_7'
  WHERE id = '10000000-0000-4000-8000-000000000007';

  v_event_created := pg_catalog.floor(
    extract(epoch FROM pg_catalog.clock_timestamp())
  )::bigint;
  BEGIN
    PERFORM public.apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000007',
      '10000000-0000-4000-8000-000000000007',
      '10000000-0000-4000-8000-000000000007',
      'cus_7',
      v_reservation_id,
      'price_api_starter',
      'starter',
      10000,
      'sub_unbound_7',
      v_event_created - 1,
      'evt_unbound_7',
      v_event_created,
      true,
      false,
      true,
      'cs_unbound_7',
      'starter',
      'price_api_starter',
      'signed_metadata'
    );
    RAISE EXCEPTION
      'unbound reservation granted an API subscription';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.bind_api_tier_checkout_session_atomic(
      v_reservation_id,
      '10000000-0000-4000-8000-000000000007',
      true,
      'cus_7',
      'pro',
      'price_api_pro',
      'cs_reservation_7',
      v_checkout_expires_at
    );
    RAISE EXCEPTION 'cross-plan Session binding was accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  v_bound := public.bind_api_tier_checkout_session_atomic(
    v_reservation_id,
    '10000000-0000-4000-8000-000000000007',
    true,
    'cus_7',
    'starter',
    'price_api_starter',
    'cs_reservation_7',
    v_checkout_expires_at
  );
  v_replayed_bind :=
    public.bind_api_tier_checkout_session_atomic(
      v_reservation_id,
      '10000000-0000-4000-8000-000000000007',
      true,
      'cus_7',
      'starter',
      'price_api_starter',
      'cs_reservation_7',
      v_checkout_expires_at
    );
  IF v_bound->>'status' <> 'bound'
    OR v_replayed_bind->>'status' <> 'already_bound'
  THEN
    RAISE EXCEPTION
      'Session binding was not idempotent: %, %',
      v_bound,
      v_replayed_bind;
  END IF;

  -- PostgreSQL casts float epoch to bigint by rounding. Fix the row at N+.9
  -- and prove that Stripe's second-precision event N is accepted, while N-1
  -- remains too old to own this reservation.
  UPDATE public.api_tier_checkout_reservations
  SET created_at = pg_catalog.to_timestamp(v_event_created + 0.9)
  WHERE id = v_reservation_id;
  BEGIN
    PERFORM public.release_api_tier_checkout_reservation_atomic(
      v_reservation_id,
      '10000000-0000-4000-8000-000000000007',
      true,
      'cus_7',
      'cs_reservation_7',
      'evt_reservation_before_creation',
      v_event_created - 1
    );
    RAISE EXCEPTION
      'pre-creation checkout expiration was accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  v_released :=
    public.release_api_tier_checkout_reservation_atomic(
      v_reservation_id,
      '10000000-0000-4000-8000-000000000007',
      true,
      'cus_7',
      'cs_reservation_7',
      'evt_reservation_early',
      v_event_created
    );
  v_replayed_release :=
    public.release_api_tier_checkout_reservation_atomic(
      v_reservation_id,
      '10000000-0000-4000-8000-000000000007',
      true,
      'cus_7',
      'cs_reservation_7',
      'evt_reservation_early',
      v_event_created
    );
  IF v_released->>'status' <> 'released'
    OR v_replayed_release->>'status' <> 'already_released'
  THEN
    RAISE EXCEPTION
      'exact early checkout expiration was not idempotent: %, %',
      v_released,
      v_replayed_release;
  END IF;

  v_next := public.reserve_api_tier_checkout_atomic(
    '10000000-0000-4000-8000-000000000007',
    true,
    'cus_7',
    'pro',
    'price_api_pro'
  );
  IF v_next->>'status' <> 'reserved'
    OR (v_next->>'reservation_id')::uuid = v_reservation_id
  THEN
    RAISE EXCEPTION
      'released checkout did not permit a fresh reservation: %',
      v_next;
  END IF;
END
$reservation_lifecycle_proof$;
SQL

# Subscription authority is anchored to both metadata UUID aliases, the
# customer owner, reservation, exact paid Checkout Session, current price, and
# subscription. Reservation conversion and quota projection are one statement:
# a later ledger failure must roll conversion back, and an exact retry must
# convert and grant once.
psql_cmd <<'SQL'
DO $reservation_identity_and_portal_proof$
DECLARE
  v_reserved jsonb;
  v_bound jsonb;
  v_after_failed_apply jsonb;
  v_reservation_id uuid;
  v_checkout_expires_at bigint;
  v_result text;
  v_replay_result text;
BEGIN
  v_reserved := public.reserve_api_tier_checkout_atomic(
    '10000000-0000-4000-8000-000000000008',
    true,
    'cus_8',
    'pro',
    'price_api_pro_v1'
  );
  v_reservation_id := (v_reserved->>'reservation_id')::uuid;
  v_checkout_expires_at :=
    (v_reserved->>'checkout_expires_at')::bigint;
  v_bound := public.bind_api_tier_checkout_session_atomic(
    v_reservation_id,
    '10000000-0000-4000-8000-000000000008',
    true,
    'cus_8',
    'pro',
    'price_api_pro_v1',
    'cs_identity_8',
    v_checkout_expires_at
  );
  IF v_bound->>'status' <> 'bound' THEN
    RAISE EXCEPTION 'identity checkout did not bind: %', v_bound;
  END IF;

  BEGIN
    PERFORM public.apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000008',
      'cus_8',
      v_reservation_id,
      'price_api_pro_v1',
      'pro',
      0,
      'sub_identity_8',
      1000,
      'evt_identity_wrong_session',
      1000,
      true,
      false,
      true,
      'cs_identity_wrong',
      'pro',
      'price_api_pro_v1',
      'signed_metadata'
    );
    RAISE EXCEPTION
      'reservation accepted another Checkout Session';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000008',
      'cus_8',
      v_reservation_id,
      'price_api_pro_v1',
      'pro',
      0,
      'sub_identity_8',
      1000,
      'evt_identity_wrong_price',
      1000,
      true,
      false,
      true,
      'cs_identity_8',
      'pro',
      'price_api_pro_wrong',
      'signed_metadata'
    );
    RAISE EXCEPTION 'reserved checkout accepted another price';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  INSERT INTO public.api_tier_stripe_event_ledger (
    livemode,
    stripe_event_id,
    user_id,
    metadata_user_id,
    metadata_supabase_user_id,
    stripe_customer_id,
    checkout_reservation_id,
    stripe_price_id,
    stripe_subscription_id,
    subscription_created,
    stripe_event_created,
    api_tier,
    daily_limit,
    is_active,
    is_terminal,
    identity_source
  ) VALUES (
    true,
    'evt_identity_forced_failure',
    '10000000-0000-4000-8000-000000000008',
    '10000000-0000-4000-8000-000000000008',
    '10000000-0000-4000-8000-000000000008',
    'cus_8',
    v_reservation_id,
    'price_api_pro_v1',
    'sub_identity_8',
    1000,
    1000,
    'free',
    100,
    false,
    false,
    'signed_metadata'
  );

  BEGIN
    PERFORM public.apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000008',
      'cus_8',
      v_reservation_id,
      'price_api_pro_v1',
      'pro',
      0,
      'sub_identity_8',
      1000,
      'evt_identity_forced_failure',
      1000,
      true,
      false,
      true,
      'cs_identity_8',
      'pro',
      'price_api_pro_v1',
      'signed_metadata'
    );
    RAISE EXCEPTION
      'conflicting event did not force a post-conversion failure';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  IF NOT EXISTS (
    SELECT 1
    FROM public.api_tier_checkout_reservations
    WHERE id = v_reservation_id
      AND status = 'bound'
      AND checkout_session_id = 'cs_identity_8'
      AND stripe_subscription_id IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000008'
      AND (
        api_tier <> 'free'
        OR api_stripe_subscription_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'post-conversion failure did not roll back reservation and quota';
  END IF;

  v_after_failed_apply := public.reserve_api_tier_checkout_atomic(
    '10000000-0000-4000-8000-000000000008',
    true,
    'cus_8',
    'starter',
    'price_api_starter'
  );
  IF v_after_failed_apply->>'status' <> 'existing'
    OR (v_after_failed_apply->>'reservation_id')::uuid <>
      v_reservation_id
    OR v_after_failed_apply->>'checkout_session_id' <>
      'cs_identity_8'
  THEN
    RAISE EXCEPTION
      'failed atomic apply did not preserve the reusable bound Session: %',
      v_after_failed_apply;
  END IF;

  BEGIN
    PERFORM public.apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000007',
      '10000000-0000-4000-8000-000000000008',
      'cus_8',
      v_reservation_id,
      'price_api_pro_v1',
      'pro',
      0,
      'sub_identity_8',
      1000,
      'evt_identity_alias_mismatch',
      1000,
      true,
      false,
      true,
      'cs_identity_8',
      'pro',
      'price_api_pro_v1',
      'signed_metadata'
    );
    RAISE EXCEPTION 'mismatched metadata UUID aliases were accepted';
  EXCEPTION
    WHEN invalid_parameter_value THEN NULL;
  END;

  BEGIN
    PERFORM public.apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000008',
      'cus_wrong',
      v_reservation_id,
      'price_api_pro_v1',
      'pro',
      0,
      'sub_identity_8',
      1000,
      'evt_identity_customer_mismatch',
      1000,
      true,
      false,
      true,
      'cs_identity_8',
      'pro',
      'price_api_pro_v1',
      'signed_metadata'
    );
    RAISE EXCEPTION 'mismatched Stripe customer was accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000008',
      'cus_8',
      NULL,
      'price_api_pro_v1',
      'pro',
      0,
      'sub_unreserved_8',
      1000,
      'evt_identity_missing_reservation',
      1000,
      true,
      false,
      true,
      NULL,
      NULL,
      NULL,
      'signed_metadata'
    );
    RAISE EXCEPTION 'new subscription without reservation was accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000008',
    '10000000-0000-4000-8000-000000000008',
    '10000000-0000-4000-8000-000000000008',
    'cus_8',
    v_reservation_id,
    'price_api_pro_v1',
    'pro',
    0,
    'sub_identity_8',
    1000,
    'evt_identity_active',
    1001,
    true,
    false,
    true,
    'cs_identity_8',
    'pro',
    'price_api_pro_v1',
    'signed_metadata'
  );
  IF v_result <> 'applied' OR NOT EXISTS (
    SELECT 1
    FROM public.api_tier_checkout_reservations
    WHERE id = v_reservation_id
      AND status = 'converted'
      AND stripe_subscription_id = 'sub_identity_8'
  ) THEN
    RAISE EXCEPTION
      'confirmed reservation did not grant atomically: %',
      v_result;
  END IF;

  v_replay_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000008',
    '10000000-0000-4000-8000-000000000008',
    '10000000-0000-4000-8000-000000000008',
    'cus_8',
    v_reservation_id,
    'price_api_pro_v1',
    'pro',
    0,
    'sub_identity_8',
    1000,
    'evt_identity_active',
    1001,
    true,
    false,
    true,
    'cs_identity_8',
    'pro',
    'price_api_pro_v1',
    'signed_metadata'
  );
  IF v_replay_result <> 'idempotent' THEN
    RAISE EXCEPTION
      'atomic Checkout grant replay was not idempotent: %',
      v_replay_result;
  END IF;

  BEGIN
    PERFORM public.apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000008',
      '10000000-0000-4000-8000-000000000008',
      'cus_8',
      v_reservation_id,
      'price_api_pro_v2',
      'pro',
      0,
      'sub_identity_8',
      1000,
      'evt_identity_portal_price',
      1100,
      true,
      false,
      true,
      'cs_identity_8',
      'pro',
      'price_api_pro_v1',
      'signed_metadata'
    );
    RAISE EXCEPTION
      'unpaid Billing Portal price change was accepted';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;
  IF EXISTS (
    SELECT 1
    FROM public.api_tier_stripe_event_ledger
    WHERE stripe_event_id = 'evt_identity_portal_price'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000008'
      AND api_tier = 'pro'
      AND api_stripe_subscription_id = 'sub_identity_8'
  ) THEN
    RAISE EXCEPTION
      'rejected Billing Portal price change mutated entitlement state';
  END IF;

  v_result := public.apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000008',
    '10000000-0000-4000-8000-000000000008',
    '10000000-0000-4000-8000-000000000008',
    'cus_8',
    v_reservation_id,
    'price_api_pro_v2',
    'free',
    100,
    'sub_identity_8',
    1000,
    'evt_identity_current_cancel',
    1200,
    false,
    true,
    true,
    'cs_identity_8',
    'pro',
    'price_api_pro_v1',
    'signed_metadata'
  );
  IF v_result <> 'applied' OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000008'
      AND api_tier = 'free'
      AND api_stripe_subscription_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'current subscription cancellation did not revoke quota: %',
      v_result;
  END IF;
END
$reservation_identity_and_portal_proof$;
SQL

# Metadata can be damaged or erased after a valid purchase. Non-grant events
# may resolve only an exact persisted subscription identity; they must never
# invent a user, grant quota, or let an older cancellation replace a newer
# active subscription.
psql_cmd <<'SQL'
DO $persisted_non_grant_proof$
DECLARE
  v_legacy_terminal text;
  v_legacy_replay text;
  v_impossible_reactivation text;
  v_old_active text;
  v_new_active text;
  v_old_terminal text;
  v_old_replay text;
  v_not_api text;
  v_suspended text;
  v_resumed text;
BEGIN
  v_legacy_terminal :=
    public.apply_user_api_tier_persisted_non_grant_event(
      'cus_9',
      'price_api_legacy_pro',
      'sub_persisted_legacy_9',
      1300,
      'evt_persisted_legacy_terminal',
      1400,
      true,
      true
    );
  IF v_legacy_terminal <> 'applied' OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000009'
      AND api_tier = 'free'
      AND api_stripe_subscription_id IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_tier_stripe_event_ledger
    WHERE livemode
      AND stripe_event_id = 'evt_persisted_legacy_terminal'
      AND identity_source = 'persisted_subscription'
      AND is_terminal
      AND NOT is_active
  ) THEN
    RAISE EXCEPTION
      'current-profile persisted terminal did not revoke exactly: %',
      v_legacy_terminal;
  END IF;

  v_legacy_replay :=
    public.apply_user_api_tier_persisted_non_grant_event(
      'cus_9',
      'price_api_legacy_pro',
      'sub_persisted_legacy_9',
      1300,
      'evt_persisted_legacy_terminal',
      1400,
      true,
      true
    );
  IF v_legacy_replay <> 'idempotent' THEN
    RAISE EXCEPTION
      'persisted terminal replay was not idempotent: %',
      v_legacy_replay;
  END IF;

  v_impossible_reactivation :=
    public.test_apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000009',
      'pro',
      0,
      'sub_persisted_legacy_9',
      1300,
      'evt_persisted_impossible_reactivation',
      1500,
      true,
      false,
      true
    );
  IF v_impossible_reactivation <> 'stale' OR EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000009'
      AND (
        api_tier <> 'free'
        OR api_stripe_subscription_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'persisted terminal identity was resurrected: %',
      v_impossible_reactivation;
  END IF;

  BEGIN
    PERFORM public.apply_user_api_tier_persisted_non_grant_event(
      'cus_wrong_9',
      'price_api_legacy_pro',
      'sub_persisted_legacy_9',
      1300,
      'evt_persisted_wrong_customer',
      1600,
      true,
      true
    );
    RAISE EXCEPTION 'persisted identity accepted another customer';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.apply_user_api_tier_persisted_non_grant_event(
      'cus_9',
      'price_api_legacy_pro',
      'sub_persisted_legacy_9',
      1301,
      'evt_persisted_wrong_created',
      1600,
      true,
      true
    );
    RAISE EXCEPTION 'persisted identity accepted another creation time';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.apply_user_api_tier_persisted_non_grant_event(
      'cus_9',
      'price_api_conflicting_replay',
      'sub_persisted_legacy_9',
      1300,
      'evt_persisted_legacy_terminal',
      1400,
      true,
      true
    );
    RAISE EXCEPTION 'persisted event replay accepted another price';
  EXCEPTION
    WHEN serialization_failure THEN NULL;
  END;

  v_old_active := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000010',
    'starter',
    10000,
    'sub_persisted_old_10',
    2000,
    'evt_persisted_old_active',
    2000,
    true,
    false,
    true
  );
  v_new_active := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000010',
    'pro',
    0,
    'sub_persisted_new_10',
    3000,
    'evt_persisted_new_active',
    3000,
    true,
    false,
    true
  );
  v_old_terminal :=
    public.apply_user_api_tier_persisted_non_grant_event(
      'cus_10',
      'price_api_starter',
      'sub_persisted_old_10',
      2000,
      'evt_persisted_old_terminal',
      4000,
      true,
      true
    );
  IF v_old_active <> 'applied'
    OR v_new_active <> 'applied'
    OR v_old_terminal NOT IN ('stale', 'not_current')
    OR NOT EXISTS (
      SELECT 1
      FROM public.user_profiles
      WHERE id = '10000000-0000-4000-8000-000000000010'
        AND api_tier = 'pro'
        AND api_stripe_subscription_id = 'sub_persisted_new_10'
    )
  THEN
    RAISE EXCEPTION
      'persisted old terminal changed the newer subscription: %, %, %',
      v_old_active,
      v_new_active,
      v_old_terminal;
  END IF;

  v_old_replay :=
    public.apply_user_api_tier_persisted_non_grant_event(
      'cus_10',
      'price_api_starter',
      'sub_persisted_old_10',
      2000,
      'evt_persisted_old_terminal',
      4000,
      true,
      true
    );
  IF v_old_replay <> 'idempotent' THEN
    RAISE EXCEPTION
      'persisted old terminal replay was not idempotent: %',
      v_old_replay;
  END IF;

  v_not_api :=
    public.apply_user_api_tier_persisted_non_grant_event(
      'cus_11',
      'price_pro_monthly',
      'sub_ordinary_11',
      5000,
      'evt_ordinary_not_api',
      5000,
      true,
      true
    );
  IF v_not_api <> 'not_api' OR EXISTS (
    SELECT 1
    FROM public.api_tier_stripe_event_ledger
    WHERE stripe_event_id = 'evt_ordinary_not_api'
  ) THEN
    RAISE EXCEPTION
      'ordinary subscription did not remain outside API authority: %',
      v_not_api;
  END IF;

  v_suspended :=
    public.apply_user_api_tier_persisted_non_grant_event(
      'cus_12',
      'price_api_starter',
      'sub_persisted_suspend_12',
      6000,
      'evt_persisted_suspended',
      6100,
      false,
      true
    );
  v_resumed := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000012',
    'starter',
    10000,
    'sub_persisted_suspend_12',
    6000,
    'evt_persisted_resumed',
    6200,
    true,
    false,
    true
  );
  IF v_suspended <> 'applied'
    OR v_resumed <> 'applied'
    OR NOT EXISTS (
      SELECT 1
      FROM public.user_profiles
      WHERE id = '10000000-0000-4000-8000-000000000012'
        AND api_tier = 'starter'
        AND api_stripe_subscription_id =
          'sub_persisted_suspend_12'
    )
  THEN
    RAISE EXCEPTION
      'persisted suspension did not recover on a later active event: %, %',
      v_suspended,
      v_resumed;
  END IF;
END
$persisted_non_grant_proof$;
SQL

expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'free', 100, 'sub_base', 100, 'evt_bad_active', 100, true, false, true)" \
  "an active event accepted the free tier"
expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'pro', 0, 'sub_base', 100, 'evt_bad_terminal', 100, false, true, true)" \
  "a terminal event accepted a paid tier"
expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'starter', 9999, 'sub_base', 100, 'evt_bad_starter_limit', 100, true, false, true)" \
  "starter accepted a noncanonical daily limit"
expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'pro', 100, 'sub_base', 100, 'evt_bad_pro_limit', 100, true, false, true)" \
  "pro accepted a finite daily limit"
expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'free', 0, 'sub_base', 100, 'evt_bad_free_limit', 100, false, true, true)" \
  "free accepted a noncanonical daily limit"
expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'starter', 10000, 'sub_base', 100, 'evt_active_terminal', 100, true, true, true)" \
  "an event was both active and terminal"
expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'starter', 10000, 'sub_base', 101, 'evt_before_subscription', 100, true, false, true)" \
  "an event timestamp predating its subscription was accepted"
expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'starter', 10000, 'sub_base', 100, 'evt_future_subscription', 253402300800, true, false, true)" \
  "an event timestamp beyond PostgreSQL range was accepted"
expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'starter', 10000, 'sub_base', 253402300800, 'evt_future_created', 253402300800, true, false, true)" \
  "a subscription timestamp beyond PostgreSQL range was accepted"

# A user can buy before creating any key. Key creation must read the current
# paid projection while holding the same profile lock as the event authority.
psql_cmd <<'SQL'
SET ROLE service_role;
DO $paid_then_create_key_proof$
DECLARE
  v_event_result text;
  v_key_result jsonb;
BEGIN
  v_event_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000006',
    'pro',
    0,
    'sub_keyless_paid',
    250,
    'evt_keyless_paid',
    250,
    true,
    false,
    true
  );
  IF v_event_result <> 'applied' THEN
    RAISE EXCEPTION 'keyless paid event result: %', v_event_result;
  END IF;

  v_key_result := public.create_user_api_key_with_current_entitlement(
    '10000000-0000-4000-8000-000000000006',
    'arena_sk_66666666666666666666666666666666',
    'Paid after purchase'
  );

  IF v_key_result->>'tier' <> 'pro'
    OR (v_key_result->>'daily_limit')::integer <> 0
    OR v_key_result->>'key' <>
      'arena_sk_66666666666666666666666666666666'
    OR NOT EXISTS (
      SELECT 1
      FROM public.api_keys
      WHERE user_id = '10000000-0000-4000-8000-000000000006'
        AND key = 'arena_sk_66666666666666666666666666666666'
        AND active
        AND tier = 'pro'
        AND daily_limit = 0
    )
  THEN
    RAISE EXCEPTION
      'paid user API key did not inherit the locked current entitlement: %',
      v_key_result;
  END IF;
END
$paid_then_create_key_proof$;
RESET ROLE;
SQL

# A historical projection may only be seeded by its exact current subscription.
expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000003', 'pro', 0, 'sub_replacement', 400, 'evt_historical_wrong', 400, true, false, true)" \
  "an unseeded historical subscription accepted a different ID"

historical_seed="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.test_apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000003',
      'pro',
      0,
      'sub_historical',
      300,
      'evt_historical_seed',
      300,
      true,
      false,
      true
    );
  "
)"
if [[ "$historical_seed" != "applied" ]]; then
  echo "Historical same-ID seed was not applied: $historical_seed" >&2
  exit 1
fi

# Seed the legacy current subscription, then activate successively newer
# subscriptions. The newest subscription.created is authoritative.
psql_cmd <<'SQL'
SET ROLE service_role;
DO $ordered_activation_proof$
DECLARE
  v_result text;
BEGIN
  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'starter',
    10000,
    'sub_base',
    100,
    'evt_base_active',
    100,
    true,
    false,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'legacy base seed result: %', v_result;
  END IF;

  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'starter',
    10000,
    'sub_middle',
    200,
    'evt_middle_active',
    200,
    true,
    false,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'middle activation result: %', v_result;
  END IF;

  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'pro',
    0,
    'sub_newest',
    300,
    'evt_newest_active',
    300,
    true,
    false,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'newest activation result: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND api_tier = 'pro'
      AND api_stripe_subscription_id = 'sub_newest'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000001'
      AND tier = 'pro'
      AND daily_limit = 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000002'
      AND tier = 'pro'
      AND daily_limit = 0
  ) THEN
    RAISE EXCEPTION 'newest active subscription projection is wrong';
  END IF;
END
$ordered_activation_proof$;
RESET ROLE;
SQL

# An older subscription can receive a newer event without replacing the newer
# subscription. Terminating that non-current subscription also preserves it.
psql_cmd <<'SQL'
SET ROLE service_role;
DO $cross_subscription_order_proof$
DECLARE
  v_result text;
BEGIN
  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'starter',
    10000,
    'sub_base',
    100,
    'evt_base_late_update',
    350,
    true,
    false,
    true
  );
  IF v_result <> 'not_current' THEN
    RAISE EXCEPTION 'older active update result: %', v_result;
  END IF;

  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'free',
    100,
    'sub_middle',
    200,
    'evt_middle_terminal',
    360,
    false,
    true,
    true
  );
  IF v_result <> 'not_current' THEN
    RAISE EXCEPTION 'older terminal result: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND api_tier = 'pro'
      AND api_stripe_subscription_id = 'sub_newest'
  ) THEN
    RAISE EXCEPTION 'late old-subscription event replaced the newest one';
  END IF;
END
$cross_subscription_order_proof$;
RESET ROLE;
SQL

# Terminating the current subscription falls back atomically to the newest
# older subscription whose terminal-sticky state is still active.
psql_cmd <<'SQL'
SET ROLE service_role;
DO $fallback_and_terminal_sticky_proof$
DECLARE
  v_result text;
BEGIN
  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'free',
    100,
    'sub_newest',
    300,
    'evt_newest_terminal',
    400,
    false,
    true,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'current terminal result: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND api_tier = 'starter'
      AND api_stripe_subscription_id = 'sub_base'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000001'
      AND tier = 'starter'
      AND daily_limit = 10000
  ) THEN
    RAISE EXCEPTION 'current terminal did not fall back to older active state';
  END IF;

  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'free',
    100,
    'sub_base',
    100,
    'evt_base_terminal',
    410,
    false,
    true,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'base terminal result: %', v_result;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND api_tier = 'free'
      AND api_stripe_subscription_id IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000001'
      AND tier = 'free'
      AND daily_limit = 100
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000002'
      AND tier = 'pro'
      AND daily_limit = 0
  ) THEN
    RAISE EXCEPTION 'last terminal did not atomically project free entitlement';
  END IF;

  -- Even an active event carrying a later event.created cannot resurrect a
  -- subscription after a reviewed terminal event.
  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000001',
    'pro',
    0,
    'sub_newest',
    300,
    'evt_newest_impossible_reactivation',
    999,
    true,
    false,
    true
  );
  IF v_result <> 'stale' OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000001'
      AND api_tier = 'free'
      AND api_stripe_subscription_id IS NULL
  ) THEN
    RAISE EXCEPTION 'terminal subscription was resurrected: %', v_result;
  END IF;
END
$fallback_and_terminal_sticky_proof$;
RESET ROLE;
SQL

# Exact replay is acknowledged without a duplicate ledger row. Reusing the
# event ID with any conflicting payload fails.
replay_result="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.test_apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000001',
      'free',
      100,
      'sub_base',
      100,
      'evt_base_terminal',
      410,
      false,
      true,
      true
    );
  "
)"
if [[ "$replay_result" != "idempotent" ]]; then
  echo "Exact Stripe event replay was not idempotent: $replay_result" >&2
  exit 1
fi
expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', 'free', 101, 'sub_base', 100, 'evt_base_terminal', 410, false, true, true)" \
  "conflicting event-ID replay was accepted"

psql_cmd <<'SQL'
DO $replay_count_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.api_tier_stripe_event_ledger
    WHERE livemode
      AND stripe_event_id = 'evt_base_terminal'
  ) <> 1 THEN
    RAISE EXCEPTION 'exact replay duplicated the immutable event ledger';
  END IF;
END
$replay_count_proof$;
SQL

# A recoverable paused/incomplete state revokes quota immediately, ignores an
# older active delivery, and can later resume. A terminal state still cannot.
psql_cmd <<'SQL'
SET ROLE service_role;
DO $recoverable_suspension_proof$
DECLARE
  v_result text;
BEGIN
  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000005',
    'starter',
    10000,
    'sub_recoverable',
    450,
    'evt_recoverable_active',
    450,
    true,
    false,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'recoverable baseline result: %', v_result;
  END IF;

  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000005',
    'free',
    100,
    'sub_recoverable',
    450,
    'evt_recoverable_paused',
    460,
    false,
    false,
    true
  );
  IF v_result <> 'applied' OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000005'
      AND api_tier = 'free'
      AND api_stripe_subscription_id = 'sub_recoverable'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000006'
      AND tier = 'free'
      AND daily_limit = 100
  ) THEN
    RAISE EXCEPTION 'recoverable suspension did not revoke quota: %', v_result;
  END IF;

  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000005',
    'starter',
    10000,
    'sub_recoverable',
    450,
    'evt_recoverable_stale_active',
    455,
    true,
    false,
    true
  );
  IF v_result <> 'stale' THEN
    RAISE EXCEPTION 'pre-suspension active event was not stale: %', v_result;
  END IF;

  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000005',
    'starter',
    10000,
    'sub_recoverable',
    450,
    'evt_recoverable_resumed',
    470,
    true,
    false,
    true
  );
  IF v_result <> 'applied' OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000005'
      AND api_tier = 'starter'
      AND api_stripe_subscription_id = 'sub_recoverable'
  ) THEN
    RAISE EXCEPTION 'recoverable subscription did not resume: %', v_result;
  END IF;

  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000005',
    'free',
    100,
    'sub_recoverable',
    450,
    'evt_recoverable_terminal',
    480,
    false,
    true,
    true
  );
  IF v_result <> 'applied' THEN
    RAISE EXCEPTION 'recoverable terminal result: %', v_result;
  END IF;

  v_result := public.test_apply_user_api_tier_stripe_event(
    '10000000-0000-4000-8000-000000000005',
    'starter',
    10000,
    'sub_recoverable',
    450,
    'evt_recoverable_after_terminal',
    490,
    true,
    false,
    true
  );
  IF v_result <> 'stale' OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000005'
      AND api_tier = 'free'
      AND api_stripe_subscription_id IS NULL
  ) THEN
    RAISE EXCEPTION 'terminal state was recoverable: %', v_result;
  END IF;
END
$recoverable_suspension_proof$;
RESET ROLE;
SQL

# Two active subscriptions with the same subscription.created cannot be
# selected deterministically. The second call and its ledger insert roll back.
tie_first="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.test_apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000002',
      'starter',
      10000,
      'sub_tie_a',
      500,
      'evt_tie_a',
      500,
      true,
      false,
      true
    );
  "
)"
if [[ "$tie_first" != "applied" ]]; then
  echo "First same-second subscription was not applied: $tie_first" >&2
  exit 1
fi
expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000002', 'pro', 0, 'sub_tie_b', 500, 'evt_tie_b', 501, true, false, true)" \
  "equally-created active subscriptions were not rejected"

# Same-subscription, same-second active payload disagreement also fails closed.
expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000002', 'pro', 0, 'sub_tie_a', 500, 'evt_tie_a_conflict', 500, true, false, true)" \
  "same-second same-subscription payload disagreement was accepted"

psql_cmd <<'SQL'
DO $tie_rollback_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.api_tier_stripe_event_ledger
    WHERE stripe_event_id IN ('evt_tie_b', 'evt_tie_a_conflict')
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000002'
      AND api_tier = 'starter'
      AND api_stripe_subscription_id = 'sub_tie_a'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000003'
      AND tier = 'starter'
      AND daily_limit = 10000
  ) THEN
    RAISE EXCEPTION 'ambiguity failure left a partial ledger or projection';
  END IF;
END
$tie_rollback_proof$;
SQL

# Stripe timestamps are second-granular. A terminal delivery in the same
# second as an active delivery must be durably recorded and revoke quota,
# never roll back and leave the paid projection active.
same_second_terminal="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.test_apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000002',
      'free',
      100,
      'sub_tie_a',
      500,
      'evt_tie_a_terminal_same_second',
      500,
      false,
      true,
      true
    );
  "
)"
if [[ "$same_second_terminal" != "applied" ]]; then
  echo "Same-second terminal event was not applied: $same_second_terminal" >&2
  exit 1
fi
psql_cmd <<'SQL'
DO $same_second_terminal_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.api_tier_stripe_event_ledger
    WHERE stripe_event_id IN ('evt_tie_a', 'evt_tie_a_terminal_same_second')
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000002'
      AND api_tier = 'free'
      AND api_stripe_subscription_id IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000003'
      AND tier = 'free'
      AND daily_limit = 100
  ) THEN
    RAISE EXCEPTION 'same-second terminal did not durably revoke paid quota';
  END IF;
END
$same_second_terminal_proof$;
SQL

# A forced projection table under a NOSUPERUSER/NOBYPASSRLS function owner
# must error at the protected write and roll back its earlier ledger/profile
# writes from the same function statement.
baseline_force="$(
  psql_cmd -Atqc "
    SET ROLE service_role;
    SELECT public.test_apply_user_api_tier_stripe_event(
      '10000000-0000-4000-8000-000000000004',
      'starter',
      10000,
      'sub_force_base',
      600,
      'evt_force_base',
      600,
      true,
      false,
      true
    );
  "
)"
if [[ "$baseline_force" != "applied" ]]; then
  echo "FORCE-RLS baseline was not applied: $baseline_force" >&2
  exit 1
fi

psql_cmd <<'SQL'
ALTER TABLE public.api_keys FORCE ROW LEVEL SECURITY;
ALTER ROLE postgres NOSUPERUSER NOBYPASSRLS;
SQL
expect_failure \
  "SET ROLE service_role; SELECT public.test_apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000004', 'pro', 0, 'sub_force_new', 700, 'evt_force_should_rollback', 700, true, false, true)" \
  "FORCE RLS did not abort the atomic projection"
psql_cmd <<'SQL'
ALTER ROLE postgres SUPERUSER;
ALTER TABLE public.api_keys NO FORCE ROW LEVEL SECURITY;

DO $force_rls_rollback_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.api_tier_stripe_event_ledger
    WHERE stripe_event_id = 'evt_force_should_rollback'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '10000000-0000-4000-8000-000000000004'
      AND api_tier = 'starter'
      AND api_stripe_subscription_id = 'sub_force_base'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.api_keys
    WHERE id = '20000000-0000-4000-8000-000000000005'
      AND tier = 'starter'
      AND daily_limit = 10000
  ) THEN
    RAISE EXCEPTION 'FORCE-RLS failure committed a partial event projection';
  END IF;
END
$force_rls_rollback_proof$;
SQL

# Migration preflight itself rejects FORCE RLS instead of silently weakening it.
psql_cmd -c \
  "ALTER TABLE public.user_profiles FORCE ROW LEVEL SECURITY" >/dev/null
expect_migration_failure "FORCE RLS projection table was accepted"
psql_cmd -c \
  "ALTER TABLE public.user_profiles NO FORCE ROW LEVEL SECURITY" >/dev/null

# The exact PG17 role graph rejects an unknown inherited service member.
psql_cmd -c \
  "GRANT service_role TO hostile_role WITH INHERIT TRUE, SET FALSE" >/dev/null
expect_migration_failure "hostile inherited service_role authority was accepted"
psql_cmd -c "REVOKE service_role FROM hostile_role" >/dev/null

# A SET chain through the otherwise legitimate authenticator role is equally
# dangerous and must be rejected at both preflight and postflight.
psql_cmd -c \
  "GRANT authenticator TO hostile_role WITH INHERIT FALSE, SET TRUE" >/dev/null
indirect_service_authority="$(
  psql_cmd -Atqc \
    "SELECT pg_catalog.pg_has_role('hostile_role', 'service_role', 'SET')"
)"
if [[ "$indirect_service_authority" != "t" ]]; then
  echo "PG17 did not expose the hostile authenticator → service_role SET chain" >&2
  exit 1
fi
actual_indirect_role="$(
  psql_cmd -Atqc \
    "SET SESSION AUTHORIZATION hostile_role; SET ROLE service_role; SELECT current_user"
)"
if [[ "$actual_indirect_role" != "service_role" ]]; then
  echo "PG17 did not realize the hostile indirect SET ROLE chain" >&2
  exit 1
fi
expect_migration_failure "hostile SET chain through authenticator was accepted"
psql_cmd -c "REVOKE authenticator FROM hostile_role" >/dev/null

# ADMIN OPTION is latent authority: a role that cannot currently INHERIT or
# SET authenticator can grant a SET-capable membership to a role it controls,
# which in turn reaches service_role. The role-graph proof must reject that
# edge before the authority can be minted.
psql_cmd <<'SQL'
CREATE ROLE hostile_delegate NOLOGIN NOINHERIT;
GRANT hostile_role TO hostile_delegate
  WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
GRANT authenticator TO hostile_role
  WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
SQL
expect_migration_failure "hostile ADMIN-only chain through authenticator was accepted"
admin_only_chain_realized="$(
  psql_cmd -Atqc "
    SET SESSION AUTHORIZATION hostile_delegate;
    SET ROLE hostile_role;
    GRANT authenticator TO hostile_delegate
      WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
    RESET ROLE;
    SET ROLE service_role;
    SELECT current_user;
  "
)"
if [[ "$admin_only_chain_realized" != "service_role" ]]; then
  echo "PG17 did not realize the hostile ADMIN-only authority chain" >&2
  exit 1
fi
psql_cmd <<'SQL'
SET ROLE hostile_role;
REVOKE authenticator FROM hostile_delegate;
RESET ROLE;
REVOKE authenticator FROM hostile_role;
REVOKE hostile_role FROM hostile_delegate;
DROP ROLE hostile_delegate;
SQL

# It also rejects a browser SET ROLE path, not merely INHERIT paths.
psql_cmd -c \
  "GRANT service_role TO authenticated WITH INHERIT FALSE, SET TRUE" >/dev/null
expect_migration_failure "authenticated SET ROLE service_role path was accepted"
psql_cmd -c "REVOKE service_role FROM authenticated" >/dev/null

# CREATE IF NOT EXISTS must never accept a lookalike ledger on migration
# replay. Every catalog drift below is restored only after replay fails.
psql_cmd <<'SQL'
ALTER TABLE public.api_tier_stripe_event_ledger
  DROP CONSTRAINT api_tier_stripe_event_ledger_daily_limit_check;
ALTER TABLE public.api_tier_stripe_event_ledger
  ADD CONSTRAINT api_tier_stripe_event_ledger_daily_limit_check
  CHECK (daily_limit >= 0);
SQL
expect_migration_failure "same-name wrong daily-limit CHECK survived replay"
psql_cmd <<'SQL'
ALTER TABLE public.api_tier_stripe_event_ledger
  DROP CONSTRAINT api_tier_stripe_event_ledger_daily_limit_check;
ALTER TABLE public.api_tier_stripe_event_ledger
  ADD CONSTRAINT api_tier_stripe_event_ledger_daily_limit_check
  CHECK (
    (api_tier = 'free' AND daily_limit = 100)
    OR (api_tier = 'starter' AND daily_limit = 10000)
    OR (api_tier = 'pro' AND daily_limit = 0)
  );

ALTER TABLE public.api_tier_stripe_event_ledger
  ADD CONSTRAINT injected_ledger_user_check
  CHECK (user_id = metadata_user_id);
SQL
expect_migration_failure "unexpected ledger constraint survived replay"
psql_cmd <<'SQL'
ALTER TABLE public.api_tier_stripe_event_ledger
  DROP CONSTRAINT injected_ledger_user_check;

ALTER TABLE public.api_tier_stripe_event_ledger
  ALTER COLUMN recorded_at SET DEFAULT pg_catalog.statement_timestamp();
SQL
expect_migration_failure "wrong ledger recorded_at default survived replay"
psql_cmd <<'SQL'
ALTER TABLE public.api_tier_stripe_event_ledger
  ALTER COLUMN recorded_at SET DEFAULT pg_catalog.clock_timestamp();
ALTER TABLE public.api_tier_stripe_event_ledger
  ADD COLUMN injected_payload text;
SQL
expect_migration_failure "extra ledger column survived replay"
psql_cmd <<'SQL'
ALTER TABLE public.api_tier_stripe_event_ledger
  DROP COLUMN injected_payload;

CREATE FUNCTION public.hostile_api_tier_ledger_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.daily_limit := 0;
  RETURN NEW;
END
$function$;
CREATE TRIGGER hostile_api_tier_ledger_insert
BEFORE INSERT ON public.api_tier_stripe_event_ledger
FOR EACH ROW
EXECUTE FUNCTION public.hostile_api_tier_ledger_insert();
SQL
expect_migration_failure "ledger write trigger survived replay"
psql_cmd <<'SQL'
DROP TRIGGER hostile_api_tier_ledger_insert
  ON public.api_tier_stripe_event_ledger;
DROP FUNCTION public.hostile_api_tier_ledger_insert();

DROP INDEX public.api_tier_stripe_event_ledger_user_subscription_idx;
CREATE INDEX api_tier_stripe_event_ledger_user_subscription_idx
  ON public.api_tier_stripe_event_ledger (stripe_event_created);
SQL
expect_migration_failure "same-name wrong ledger index survived replay"
psql_cmd <<'SQL'
DROP INDEX public.api_tier_stripe_event_ledger_user_subscription_idx;
CREATE INDEX api_tier_stripe_event_ledger_user_subscription_idx
  ON public.api_tier_stripe_event_ledger (
    user_id,
    livemode,
    stripe_subscription_id,
    stripe_event_created DESC
  );
SQL

# Existing checkout authorities are replaced only when their exact signatures
# remain postgres-owned; an overload cannot hide adjacent callable behavior.
psql_cmd <<'SQL'
CREATE FUNCTION public.reserve_api_tier_checkout_atomic(p_unreviewed text)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT '{}'::jsonb
$function$;
SQL
expect_migration_failure "reservation authority overload was accepted"
psql_cmd -c \
  "DROP FUNCTION public.reserve_api_tier_checkout_atomic(text)" \
  >/dev/null

psql_cmd -c \
  "ALTER FUNCTION public.reserve_api_tier_checkout_atomic(uuid,boolean,text,text,text) OWNER TO hostile_role" \
  >/dev/null
expect_migration_failure "hostile reservation authority owner was accepted"
psql_cmd -c \
  "ALTER FUNCTION public.reserve_api_tier_checkout_atomic(uuid,boolean,text,text,text) OWNER TO postgres" \
  >/dev/null

# Reservation replay is fail-closed across relation ownership, RLS policies,
# exact constraints/defaults/columns, write hooks, and partial unique indexes.
psql_cmd -c \
  "ALTER TABLE public.api_tier_checkout_reservations OWNER TO hostile_role" \
  >/dev/null
expect_migration_failure "hostile reservation relation owner was accepted"
psql_cmd -c \
  "ALTER TABLE public.api_tier_checkout_reservations OWNER TO postgres" \
  >/dev/null

psql_cmd <<'SQL'
ALTER TABLE public.api_tier_checkout_reservations
  DROP CONSTRAINT api_tier_checkout_reservations_plan_check;
ALTER TABLE public.api_tier_checkout_reservations
  ADD CONSTRAINT api_tier_checkout_reservations_plan_check
  CHECK (api_plan IN ('free', 'starter', 'pro'));
SQL
expect_migration_failure "same-name wrong reservation plan CHECK survived replay"
psql_cmd <<'SQL'
ALTER TABLE public.api_tier_checkout_reservations
  DROP CONSTRAINT api_tier_checkout_reservations_plan_check;
ALTER TABLE public.api_tier_checkout_reservations
  ADD CONSTRAINT api_tier_checkout_reservations_plan_check
  CHECK (api_plan IN ('starter', 'pro'));
SQL

psql_cmd -c \
  "ALTER TABLE public.api_tier_checkout_reservations ALTER COLUMN updated_at SET DEFAULT pg_catalog.now()" \
  >/dev/null
expect_migration_failure "wrong reservation updated_at default survived replay"
psql_cmd -c \
  "ALTER TABLE public.api_tier_checkout_reservations ALTER COLUMN updated_at SET DEFAULT pg_catalog.clock_timestamp()" \
  >/dev/null

psql_cmd -c \
  "ALTER TABLE public.api_tier_checkout_reservations ADD COLUMN hostile_extra text" \
  >/dev/null
expect_migration_failure "extra reservation column survived replay"
psql_cmd -c \
  "ALTER TABLE public.api_tier_checkout_reservations DROP COLUMN hostile_extra" \
  >/dev/null

psql_cmd <<'SQL'
CREATE FUNCTION public.hostile_api_tier_reservation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  NEW.api_plan := 'starter';
  RETURN NEW;
END
$function$;
CREATE TRIGGER hostile_api_tier_reservation_update
BEFORE UPDATE ON public.api_tier_checkout_reservations
FOR EACH ROW
EXECUTE FUNCTION public.hostile_api_tier_reservation_update();
SQL
expect_migration_failure "reservation write trigger survived replay"
psql_cmd <<'SQL'
DROP TRIGGER hostile_api_tier_reservation_update
  ON public.api_tier_checkout_reservations;
DROP FUNCTION public.hostile_api_tier_reservation_update();
SQL

psql_cmd -c \
  "CREATE POLICY hostile_reservation_read ON public.api_tier_checkout_reservations FOR SELECT TO hostile_role USING (true)" \
  >/dev/null
expect_migration_failure "reservation RLS policy survived replay"
psql_cmd -c \
  "DROP POLICY hostile_reservation_read ON public.api_tier_checkout_reservations" \
  >/dev/null

psql_cmd -c \
  "CREATE RULE hostile_reservation_delete AS ON DELETE TO public.api_tier_checkout_reservations DO ALSO NOTHING" \
  >/dev/null
expect_migration_failure "reservation write rule survived replay"
psql_cmd -c \
  "DROP RULE hostile_reservation_delete ON public.api_tier_checkout_reservations" \
  >/dev/null

psql_cmd <<'SQL'
DROP INDEX public.api_tier_checkout_reservations_active_user_mode_idx;
CREATE UNIQUE INDEX api_tier_checkout_reservations_active_user_mode_idx
  ON public.api_tier_checkout_reservations (
    stripe_customer_id,
    livemode
  )
  WHERE status IN ('reserved', 'bound');
SQL
expect_migration_failure "same-name wrong reservation partial index survived replay"
psql_cmd <<'SQL'
DROP INDEX public.api_tier_checkout_reservations_active_user_mode_idx;
CREATE UNIQUE INDEX api_tier_checkout_reservations_active_user_mode_idx
  ON public.api_tier_checkout_reservations (user_id, livemode)
  WHERE status IN ('reserved', 'bound');
SQL

# Replay must converge hostile routine/table/column ACLs while preserving data.
ledger_count_before="$(
  psql_cmd -Atqc \
    "SELECT pg_catalog.count(*) FROM public.api_tier_stripe_event_ledger"
)"
psql_cmd <<'SQL'
GRANT EXECUTE
  ON FUNCTION public.apply_user_api_tier_stripe_event(
    uuid,
    uuid,
    uuid,
    text,
    uuid,
    text,
    text,
    integer,
    text,
    bigint,
    text,
    bigint,
    boolean,
    boolean,
    boolean,
    text,
    text,
    text,
    text
  )
  TO PUBLIC;
GRANT EXECUTE
  ON FUNCTION public.apply_user_api_tier_stripe_event(
    uuid,
    uuid,
    uuid,
    text,
    uuid,
    text,
    text,
    integer,
    text,
    bigint,
    text,
    bigint,
    boolean,
    boolean,
    boolean,
    text,
    text,
    text,
    text
  )
  TO hostile_role WITH GRANT OPTION;
GRANT EXECUTE
  ON FUNCTION public.create_user_api_key_with_current_entitlement(
    uuid,
    text,
    text
  )
  TO PUBLIC;
GRANT EXECUTE
  ON FUNCTION public.create_user_api_key_with_current_entitlement(
    uuid,
    text,
    text
  )
  TO hostile_role WITH GRANT OPTION;
GRANT EXECUTE
  ON FUNCTION public.reserve_api_tier_checkout_atomic(
    uuid,
    boolean,
    text,
    text,
    text
  )
  TO PUBLIC;
GRANT EXECUTE
  ON FUNCTION public.bind_api_tier_checkout_session_atomic(
    uuid,
    uuid,
    boolean,
    text,
    text,
    text,
    text,
    bigint
  )
  TO hostile_role WITH GRANT OPTION;
GRANT EXECUTE
  ON FUNCTION public.release_api_tier_checkout_reservation_atomic(
    uuid,
    uuid,
    boolean,
    text,
    text,
    text,
    bigint
  )
  TO authenticated;
GRANT EXECUTE
  ON FUNCTION public.update_user_api_tier(uuid, text, text, integer)
  TO service_role, hostile_role;
GRANT SELECT
  ON TABLE public.api_tier_stripe_event_ledger
  TO hostile_role WITH GRANT OPTION;
GRANT SELECT (api_tier)
  ON TABLE public.api_tier_stripe_event_ledger
  TO authenticated;
GRANT SELECT
  ON TABLE public.api_tier_checkout_reservations
  TO hostile_role WITH GRANT OPTION;
GRANT SELECT (api_plan)
  ON TABLE public.api_tier_checkout_reservations
  TO authenticated;
SQL

psql_cmd -f "$MIGRATION"

expect_failure \
  "SET ROLE anon; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'cus_1', NULL, 'price_api_starter', 'free', 100, 'sub_base', 100, 'evt_acl_denied', 1000, false, true, true, NULL, NULL, NULL, 'signed_metadata')" \
  "PUBLIC EXECUTE survived migration replay"
expect_failure \
  "SET ROLE hostile_role; SELECT public.apply_user_api_tier_stripe_event('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'cus_1', NULL, 'price_api_starter', 'free', 100, 'sub_base', 100, 'evt_acl_hostile', 1000, false, true, true, NULL, NULL, NULL, 'signed_metadata')" \
  "hostile function grant option survived migration replay"
expect_failure \
  "SET ROLE hostile_role; SELECT public.create_user_api_key_with_current_entitlement('10000000-0000-4000-8000-000000000001', 'arena_sk_11111111111111111111111111111111', 'Hostile')" \
  "hostile API key entitlement grant survived migration replay"
expect_failure \
  "SET ROLE hostile_role; SELECT * FROM public.api_tier_stripe_event_ledger" \
  "hostile ledger table grant survived migration replay"
expect_failure \
  "SET ROLE authenticated; SELECT api_tier FROM public.api_tier_stripe_event_ledger" \
  "authenticated ledger column grant survived migration replay"
expect_failure \
  "SET ROLE hostile_role; SELECT * FROM public.api_tier_checkout_reservations" \
  "hostile reservation table grant survived migration replay"
expect_failure \
  "SET ROLE authenticated; SELECT api_plan FROM public.api_tier_checkout_reservations" \
  "authenticated reservation column grant survived migration replay"
expect_failure \
  "SET ROLE anon; SELECT public.reserve_api_tier_checkout_atomic('10000000-0000-4000-8000-000000000007', true, 'cus_7', 'starter', 'price_api_starter')" \
  "PUBLIC reservation authority EXECUTE survived migration replay"
expect_failure \
  "SET ROLE hostile_role; SELECT public.bind_api_tier_checkout_session_atomic('70000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000007', true, 'cus_7', 'starter', 'price_api_starter', 'cs_hostile', 2000000000)" \
  "hostile reservation bind grant option survived migration replay"
expect_failure \
  "SET ROLE authenticated; SELECT public.release_api_tier_checkout_reservation_atomic('70000000-0000-4000-8000-000000000007', '10000000-0000-4000-8000-000000000007', true, 'cus_7', 'cs_hostile', 'evt_hostile', 2000000000)" \
  "authenticated reservation release grant survived migration replay"
if [[ "$(
  psql_cmd -Atqc \
    "SELECT pg_catalog.has_function_privilege('service_role', 'public.update_user_api_tier(uuid,text,text,integer)', 'EXECUTE')"
)" != "t" ]]; then
  echo "legacy compatibility updater was unavailable during additive rollout replay" >&2
  exit 1
fi

ledger_count_after="$(
  psql_cmd -Atqc \
    "SELECT pg_catalog.count(*) FROM public.api_tier_stripe_event_ledger"
)"
if [[ "$ledger_count_before" != "$ledger_count_after" ]]; then
  echo "Migration replay changed immutable ledger rows" >&2
  exit 1
fi

# Only after the additive migration and replacement callers are proven live
# does the separate postdeploy migration remove the compatibility writer.
psql_cmd -f "$CLEANUP_MIGRATION"
expect_failure \
  "SET ROLE service_role; SELECT public.update_user_api_tier('10000000-0000-4000-8000-000000000001', 'pro', 'sub_acl_forged', 0)" \
  "legacy updater remained executable after postdeploy cutover"

# Exact replay stays owner-only, and a later direct hostile grant is converged
# away without damaging either replacement authority.
psql_cmd -f "$CLEANUP_MIGRATION"
psql_cmd -c \
  "GRANT EXECUTE ON FUNCTION public.update_user_api_tier(uuid,text,text,integer) TO hostile_role WITH GRANT OPTION"
psql_cmd -f "$CLEANUP_MIGRATION"
expect_failure \
  "SET ROLE hostile_role; SELECT public.update_user_api_tier('10000000-0000-4000-8000-000000000001', 'pro', 'sub_hostile_cutover', 0)" \
  "hostile legacy updater grant survived cleanup replay"

psql_cmd <<'SQL'
DO $final_catalog_proof$
DECLARE
  v_rpc pg_catalog.regprocedure :=
    'public.apply_user_api_tier_stripe_event(uuid,uuid,uuid,text,uuid,text,text,integer,text,bigint,text,bigint,boolean,boolean,boolean,text,text,text,text)'::pg_catalog.regprocedure;
  v_key_rpc pg_catalog.regprocedure :=
    'public.create_user_api_key_with_current_entitlement(uuid,text,text)'::pg_catalog.regprocedure;
  v_old_rpc pg_catalog.regprocedure :=
    'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure;
  v_ledger pg_catalog.regclass :=
    'public.api_tier_stripe_event_ledger'::pg_catalog.regclass;
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service oid := pg_catalog.to_regrole('service_role');
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS acl_entry
    WHERE routine.oid = v_rpc
      AND acl_entry.grantee NOT IN (v_postgres, v_service)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS acl_entry
    WHERE routine.oid = v_key_rpc
      AND acl_entry.grantee NOT IN (v_postgres, v_service)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS acl_entry
    WHERE routine.oid = v_old_rpc
      AND acl_entry.grantee <> v_postgres
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = v_ledger
      AND acl_entry.grantee <> v_postgres
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_ledger
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres
  ) THEN
    RAISE EXCEPTION 'final replay ACL seal is incomplete';
  END IF;
END
$final_catalog_proof$;
SQL

echo "API tier Stripe event ledger PG17 proof passed"
