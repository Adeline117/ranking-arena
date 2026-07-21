#!/usr/bin/env bash

# PostgreSQL 17 integration proof for payment-period Stripe entitlement
# authority. The script owns a temporary local cluster and never connects to a
# developer or remote database.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260718183000_atomic_stripe_entitlement_identity.sql"
EXTRA_SETUP_SQLS="${STRIPE_ENTITLEMENT_EXTRA_SETUP_SQLS:-${STRIPE_ENTITLEMENT_EXTRA_SETUP_SQL:-}}"
EXTRA_MIGRATIONS="${STRIPE_ENTITLEMENT_EXTRA_MIGRATIONS:-${STRIPE_ENTITLEMENT_EXTRA_MIGRATION:-}}"
EXTRA_PROOF_SQLS="${STRIPE_ENTITLEMENT_EXTRA_PROOF_SQLS:-${STRIPE_ENTITLEMENT_EXTRA_PROOF_SQL:-}}"
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

TMP_ROOT="$(mktemp -d /tmp/stripe-entitlement-authority-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55614
mkdir -p "$SOCKET_DIR"

cleanup() {
  local exit_status=$?
  if (( exit_status != 0 )) && [[ -f "$LOG_FILE" ]]; then
    tail -200 "$LOG_FILE" >&2 || true
  fi
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

psql_cmd() {
  "$PG_BIN/psql" \
    -X \
    -v ON_ERROR_STOP=1 \
    -h "$SOCKET_DIR" \
    -p "$PORT" \
    -d postgres \
    "$@"
}

wait_for_sleep() {
  local marker="$1"
  local attempts=0
  local observed
  while (( attempts < 100 )); do
    observed="$(
      psql_cmd -Atc "
        SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_stat_activity
        WHERE query LIKE '%${marker}%'
          AND wait_event = 'PgSleep'
      "
    )"
    if [[ "$observed" == "1" ]]; then
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 0.05
  done
  echo "transaction never reached sleep marker: $marker" >&2
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
CREATE ROLE service_role NOLOGIN NOINHERIT NOBYPASSRLS;
CREATE ROLE authenticator LOGIN NOINHERIT;

ALTER SCHEMA public OWNER TO postgres;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, authenticator;

CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE TABLE auth.users (
  id uuid PRIMARY KEY
);
CREATE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $function$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$function$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, service_role, authenticator;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY
    REFERENCES auth.users(id) ON DELETE CASCADE,
  subscription_tier text,
  pro_plan text,
  pro_expires_at timestamptz,
  is_pro boolean NOT NULL DEFAULT false,
  stripe_customer_id text,
  stripe_subscription_id text,
  deleted_at timestamptz,
  banned_at timestamptz,
  is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.subscriptions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL
    REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  stripe_customer_id text,
  stripe_subscription_id text,
  status text NOT NULL DEFAULT 'inactive',
  tier text NOT NULL DEFAULT 'free',
  plan text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE UNIQUE INDEX idx_subscriptions_user_id
  ON public.subscriptions (user_id);

CREATE TABLE public.payment_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid,
  stripe_invoice_id text,
  stripe_payment_intent_id text,
  amount integer,
  currency text DEFAULT 'usd',
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE UNIQUE INDEX uq_payment_history_invoice
  ON public.payment_history (stripe_invoice_id)
  WHERE stripe_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX uq_payment_history_pi
  ON public.payment_history (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE TABLE public.test_official_members (
  user_id uuid PRIMARY KEY
    REFERENCES public.user_profiles(id) ON DELETE CASCADE
);
CREATE TABLE public.test_results (
  result_key text PRIMARY KEY,
  result_status text NOT NULL
);

-- Canonical legacy authority must remain byte-for-byte callable throughout the
-- additive migration/application deploy window.
CREATE FUNCTION public.has_current_global_pro_entitlement(p_actor_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile_entitlement
    WHERE profile_entitlement.id = p_actor_id
      AND (
        profile_entitlement.subscription_tier = 'pro'
        OR EXISTS (
          SELECT 1
          FROM public.subscriptions AS subscription
          WHERE subscription.user_id = p_actor_id
            AND subscription.status IN ('active', 'trialing')
            AND subscription.tier = 'pro'
        )
      )
  )
$function$;
ALTER FUNCTION public.has_current_global_pro_entitlement(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.has_current_global_pro_entitlement(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE FUNCTION public.leave_pro_official_group_atomic(p_actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_deleted integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.current_setting(
    'refund_test.pause_before_leave_advisory',
    true
  ) = 'on' THEN
    PERFORM pg_catalog.pg_sleep(3);
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_actor_id::text,
      0
    )
  );
  IF pg_catalog.current_setting('refund_test.pause', true) = 'on' THEN
    PERFORM pg_catalog.pg_sleep(3);
  END IF;
  DELETE FROM public.test_official_members WHERE user_id = p_actor_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN pg_catalog.jsonb_build_object(
    'status',
    CASE WHEN v_deleted = 1 THEN 'left' ELSE 'not_member' END
  );
END
$function$;
ALTER FUNCTION public.leave_pro_official_group_atomic(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.leave_pro_official_group_atomic(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.leave_pro_official_group_atomic(uuid)
  TO service_role;

CREATE FUNCTION public.test_join_pro_official_group_atomic(p_actor_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_actor_id::text,
      0
    )
  );
  PERFORM 1
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND OR NOT public.has_current_global_pro_entitlement(p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'pro_required');
  END IF;
  INSERT INTO public.test_official_members(user_id)
  VALUES (p_actor_id)
  ON CONFLICT (user_id) DO NOTHING;
  RETURN pg_catalog.jsonb_build_object('status', 'joined');
END
$function$;
ALTER FUNCTION public.test_join_pro_official_group_atomic(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.test_join_pro_official_group_atomic(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.test_join_pro_official_group_atomic(uuid)
  TO service_role;

-- Historical identity-poor writers remain callable during additive deploy.
CREATE FUNCTION public.activate_lifetime_membership(
  p_user_id uuid,
  p_stripe_customer_id text
)
RETURNS void LANGUAGE sql AS 'SELECT';
ALTER FUNCTION public.activate_lifetime_membership(uuid, text) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.activate_lifetime_membership(uuid, text)
  TO service_role;

CREATE FUNCTION public.update_subscription_and_profile(
  uuid, text, text, text, text, text, timestamptz, timestamptz, boolean
)
RETURNS void LANGUAGE sql AS 'SELECT';
ALTER FUNCTION public.update_subscription_and_profile(
  uuid, text, text, text, text, text, timestamptz, timestamptz, boolean
) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.update_subscription_and_profile(
  uuid, text, text, text, text, text, timestamptz, timestamptz, boolean
) TO service_role;

-- Unsafe draft signatures also survive additive deploy and are deleted only by
-- the explicit post-deploy retirement migration.
CREATE FUNCTION public.revoke_refunded_subscription_entitlement_atomic(
  uuid, text
)
RETURNS jsonb LANGUAGE sql AS
  'SELECT pg_catalog.jsonb_build_object(''status'', ''legacy'')';
ALTER FUNCTION public.revoke_refunded_subscription_entitlement_atomic(
  uuid, text
) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION
  public.revoke_refunded_subscription_entitlement_atomic(uuid, text)
TO service_role;

CREATE FUNCTION public.revoke_refunded_lifetime_entitlement_atomic(uuid, text)
RETURNS jsonb LANGUAGE sql AS
  'SELECT pg_catalog.jsonb_build_object(''status'', ''legacy'')';
ALTER FUNCTION public.revoke_refunded_lifetime_entitlement_atomic(uuid, text)
  OWNER TO postgres;
GRANT EXECUTE ON FUNCTION
  public.revoke_refunded_lifetime_entitlement_atomic(uuid, text)
TO service_role;

CREATE FUNCTION public.activate_lifetime_membership_with_identity_atomic(
  uuid, text, text
)
RETURNS jsonb LANGUAGE sql AS
  'SELECT pg_catalog.jsonb_build_object(''status'', ''legacy'')';
ALTER FUNCTION public.activate_lifetime_membership_with_identity_atomic(
  uuid, text, text
) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION
  public.activate_lifetime_membership_with_identity_atomic(uuid, text, text)
TO service_role;

-- Execute the former profile -> leave-advisory order in the deadlock proof.
CREATE FUNCTION public.test_old_order_refund(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_leave jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.subscriptions
  WHERE user_id = p_user_id
  FOR UPDATE;
  PERFORM 1 FROM public.user_profiles
  WHERE id = p_user_id
  FOR UPDATE;
  UPDATE public.subscriptions SET status = 'canceled'
  WHERE user_id = p_user_id;
  UPDATE public.user_profiles SET subscription_tier = 'free'
  WHERE id = p_user_id;
  v_leave := public.leave_pro_official_group_atomic(p_user_id);
  RETURN pg_catalog.jsonb_build_object('status', 'revoked');
END
$function$;
ALTER FUNCTION public.test_old_order_refund(uuid) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.test_old_order_refund(uuid) TO service_role;
SQL

# The historical partial indexes genuinely fail column-only inference.
psql_cmd <<'SQL'
DO $partial_index_inference_fails$
BEGIN
  BEGIN
    INSERT INTO public.payment_history(stripe_invoice_id, status)
    VALUES ('in_partial_shape', 'succeeded')
    ON CONFLICT (stripe_invoice_id) DO UPDATE
    SET status = EXCLUDED.status;
    RAISE EXCEPTION
      'partial invoice index unexpectedly supported column inference';
  EXCEPTION
    WHEN invalid_column_reference THEN
      IF SQLSTATE <> '42P10' THEN
        RAISE;
      END IF;
  END;

  BEGIN
    INSERT INTO public.payment_history(stripe_payment_intent_id, status)
    VALUES ('pi_partial_shape', 'succeeded')
    ON CONFLICT (stripe_payment_intent_id) DO UPDATE
    SET status = EXCLUDED.status;
    RAISE EXCEPTION
      'partial PaymentIntent index unexpectedly supported column inference';
  EXCEPTION
    WHEN invalid_column_reference THEN
      IF SQLSTATE <> '42P10' THEN
        RAISE;
      END IF;
  END;
END
$partial_index_inference_fails$;
SQL

# An active Stripe-shaped projection with no commercial plan must be
# quarantined without blocking the additive application migration or guessing
# v2 authority. The old canonical projection remains live until remediation.
psql_cmd <<'SQL'
INSERT INTO auth.users(id)
VALUES ('00000000-0000-0000-0000-000000000900');
INSERT INTO public.user_profiles(
  id,
  subscription_tier,
  pro_plan,
  pro_expires_at,
  is_pro,
  stripe_customer_id,
  stripe_subscription_id
) VALUES (
  '00000000-0000-0000-0000-000000000900',
  'pro',
  NULL,
  '2035-01-01Z',
  true,
  'cus_unsupportedprojection',
  'sub_unsupportedprojection'
);
INSERT INTO public.subscriptions(
  user_id,
  stripe_customer_id,
  stripe_subscription_id,
  status,
  tier,
  plan,
  current_period_start,
  current_period_end
) VALUES (
  '00000000-0000-0000-0000-000000000900',
  'cus_unsupportedprojection',
  'sub_unsupportedprojection',
  'active',
  'pro',
  NULL,
  pg_catalog.statement_timestamp(),
  '2035-01-01Z'
);

-- A profile-only historical is_pro marker is not canonical Pro authority, but
-- PREDEPLOY must quarantine it without mutating its six projection fields or
-- evicting an existing official-group membership.
INSERT INTO auth.users(id)
VALUES ('00000000-0000-0000-0000-000000000902');
INSERT INTO public.user_profiles(
  id,
  subscription_tier,
  pro_plan,
  pro_expires_at,
  is_pro,
  stripe_customer_id,
  stripe_subscription_id
) VALUES (
  '00000000-0000-0000-0000-000000000902',
  'free',
  'monthly',
  '2035-02-01Z',
  true,
  'cus_ambiguousprofile',
  'sub_ambiguousprofile'
);
INSERT INTO public.test_official_members(user_id)
VALUES ('00000000-0000-0000-0000-000000000902');
SQL

psql_cmd <<'SQL'
-- A true pre-migration lifetime sale must become one grant and one durable
-- commercial seat claim, without being counted twice.
INSERT INTO auth.users(id)
VALUES ('00000000-0000-0000-0000-000000000901');
INSERT INTO public.user_profiles(
  id,
  subscription_tier,
  pro_plan,
  is_pro,
  stripe_customer_id
) VALUES (
  '00000000-0000-0000-0000-000000000901',
  'pro',
  'lifetime',
  true,
  'cus_prelegacy901'
);
INSERT INTO public.subscriptions(
  user_id,
  stripe_customer_id,
  stripe_subscription_id,
  status,
  tier,
  plan,
  current_period_start,
  current_period_end
) VALUES (
  '00000000-0000-0000-0000-000000000901',
  'cus_prelegacy901',
  'lifetime_prelegacy901',
  'active',
  'pro',
  'lifetime',
  pg_catalog.statement_timestamp() - INTERVAL '1 year',
  NULL
);
SQL

if [[ -n "$EXTRA_SETUP_SQLS" ]]; then
  IFS=':' read -r -a extra_setup_paths <<< "$EXTRA_SETUP_SQLS"
  for extra_setup in "${extra_setup_paths[@]}"; do
    if [[ ! -r "$extra_setup" ]]; then
      echo "Extra Stripe entitlement setup is unreadable: $extra_setup" >&2
      exit 1
    fi
    psql_cmd -f "$extra_setup" >/dev/null
  done
fi

psql_cmd -f "$MIGRATION" >/dev/null
if [[ -n "$EXTRA_MIGRATIONS" ]]; then
  IFS=':' read -r -a extra_migration_paths <<< "$EXTRA_MIGRATIONS"
  for extra_migration in "${extra_migration_paths[@]}"; do
    if [[ ! -r "$extra_migration" ]]; then
      echo "Extra Stripe entitlement migration is unreadable: $extra_migration" >&2
      exit 1
    fi
    psql_cmd -f "$extra_migration" >/dev/null
  done
fi

psql_cmd <<'SQL'
DO $additive_deploy_window$
BEGIN
  PERFORM pg_catalog.set_config(
    'request.jwt.claim.role',
    'service_role',
    true
  );
  IF pg_catalog.pg_get_functiondef(
    'public.has_current_global_pro_entitlement(uuid)'::pg_catalog.regprocedure
  ) NOT LIKE '%profile_entitlement.subscription_tier = ''pro''%'
    OR to_regprocedure(
      'public.stripe_has_current_pro_authority_v2(uuid)'
    ) IS NULL
  THEN
    RAISE EXCEPTION
      'additive migration replaced canonical legacy authority too early';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.activate_lifetime_membership(uuid,text)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.update_subscription_and_profile(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.activate_lifetime_membership_with_identity_atomic(uuid,text,text)',
    'EXECUTE'
	  ) OR NOT pg_catalog.has_function_privilege(
	    'service_role',
	    'public.activate_lifetime_membership_with_identity_atomic(uuid,text,text,uuid,text,text,bigint,text,timestamp with time zone,text)',
	    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.check_lifetime_spots_available(integer)',
    'EXECUTE'
  ) OR public.check_lifetime_spots_available(200)
  THEN
    RAISE EXCEPTION 'old and new Stripe writers did not coexist predeploy';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM public.pro_entitlement_grants AS entitlement_grant
    WHERE entitlement_grant.user_id =
        '00000000-0000-0000-0000-000000000901'
      AND entitlement_grant.source = 'legacy_stripe_snapshot'
      AND entitlement_grant.revoked_at IS NULL
  ) <> 1
    OR (
      SELECT pg_catalog.count(*)
      FROM public.stripe_legacy_lifetime_seat_claims AS legacy_claim
      WHERE legacy_claim.user_id =
          '00000000-0000-0000-0000-000000000901'
        AND legacy_claim.status = 'claimed'
    ) <> 1
    OR public.stripe_lifetime_claimed_seat_count_v2() <> 1
  THEN
    RAISE EXCEPTION
      'pre-migration lifetime sale was not backfilled and deduplicated';
  END IF;

  PERFORM public.sync_current_pro_projection_atomic(
    '00000000-0000-0000-0000-000000000900'
  );
  PERFORM public.sync_current_pro_projection_atomic(
    '00000000-0000-0000-0000-000000000902'
  );
  PERFORM public.reconcile_due_pro_entitlement_projections_atomic(100, NULL);
  IF (
    SELECT pg_catalog.count(*)
    FROM public.stripe_manual_reviews AS review
    JOIN public.subscriptions AS subscription
      ON subscription.id::text = review.object_id
    WHERE subscription.user_id =
        '00000000-0000-0000-0000-000000000900'
      AND review.object_type = 'subscription'
      AND review.reason_key =
        'unsupported_legacy_stripe_projection'
      AND review.state = 'open'
      AND review.metadata ->> 'stripe_customer_id' =
        'cus_unsupportedprojection'
      AND review.metadata ->> 'stripe_subscription_id' =
        'sub_unsupportedprojection'
      AND review.metadata ->> 'status' = 'active'
      AND review.metadata ->> 'tier' = 'pro'
      AND review.metadata ->> 'plan' IS NULL
      AND review.metadata ->> 'profile_subscription_tier' = 'pro'
      AND review.metadata ->> 'profile_is_pro' = 'true'
  ) <> 1
    OR EXISTS (
      SELECT 1
      FROM public.pro_entitlement_grants
      WHERE user_id =
        '00000000-0000-0000-0000-000000000900'
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments
      WHERE user_id =
        '00000000-0000-0000-0000-000000000900'
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_trial_entitlements
      WHERE user_id =
        '00000000-0000-0000-0000-000000000900'
    )
    OR public.stripe_has_current_pro_authority_v2(
      '00000000-0000-0000-0000-000000000900'
    )
    OR NOT public.has_current_global_pro_entitlement(
      '00000000-0000-0000-0000-000000000900'
    )
    OR public.stripe_paid_launch_readiness_v2() ->> 'status' <> 'blocked'
    OR (
      SELECT pg_catalog.jsonb_build_array(
        profile.subscription_tier,
        profile.pro_plan,
        profile.pro_expires_at,
        profile.is_pro,
        profile.stripe_customer_id,
        profile.stripe_subscription_id
      )
      FROM public.user_profiles AS profile
      WHERE profile.id =
        '00000000-0000-0000-0000-000000000900'
    ) IS DISTINCT FROM pg_catalog.jsonb_build_array(
      'pro',
      NULL,
      '2035-01-01Z'::timestamptz,
      true,
      'cus_unsupportedprojection',
      'sub_unsupportedprojection'
    )
  THEN
    RAISE EXCEPTION
      'unsupported Stripe-shaped projection was not durably quarantined';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM public.stripe_manual_reviews AS review
    WHERE review.object_type = 'profile'
      AND review.object_id =
        '00000000-0000-0000-0000-000000000902'
      AND review.user_id =
        '00000000-0000-0000-0000-000000000902'
      AND review.reason_key = 'ambiguous_legacy_pro_projection'
      AND review.state = 'open'
      AND review.metadata ->> 'subscription_tier' = 'free'
      AND review.metadata ->> 'pro_plan' = 'monthly'
      AND review.metadata ->> 'is_pro' = 'true'
  ) <> 1
    OR public.has_current_global_pro_entitlement(
      '00000000-0000-0000-0000-000000000902'
    )
    OR public.stripe_has_current_pro_authority_v2(
      '00000000-0000-0000-0000-000000000902'
    )
    OR (
      SELECT pg_catalog.jsonb_build_array(
        profile.subscription_tier,
        profile.pro_plan,
        profile.pro_expires_at,
        profile.is_pro,
        profile.stripe_customer_id,
        profile.stripe_subscription_id
      )
      FROM public.user_profiles AS profile
      WHERE profile.id =
        '00000000-0000-0000-0000-000000000902'
    ) IS DISTINCT FROM pg_catalog.jsonb_build_array(
      'free',
      'monthly',
      '2035-02-01Z'::timestamptz,
      true,
      'cus_ambiguousprofile',
      'sub_ambiguousprofile'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.test_official_members AS membership
      WHERE membership.user_id =
        '00000000-0000-0000-0000-000000000902'
    )
  THEN
    RAISE EXCEPTION
      'ambiguous profile-only projection was mutated or evicted';
  END IF;
END
$additive_deploy_window$;

DELETE FROM auth.users
WHERE id = '00000000-0000-0000-0000-000000000901';
DO $durable_legacy_claim_survives_hard_delete$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_profiles
    WHERE id = '00000000-0000-0000-0000-000000000901'
  ) OR EXISTS (
    SELECT 1
    FROM public.subscriptions
    WHERE user_id = '00000000-0000-0000-0000-000000000901'
  ) OR EXISTS (
    SELECT 1
    FROM public.pro_entitlement_grants
    WHERE user_id = '00000000-0000-0000-0000-000000000901'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.stripe_legacy_lifetime_seat_claims AS legacy_claim
    WHERE legacy_claim.user_id =
        '00000000-0000-0000-0000-000000000901'
      AND legacy_claim.status = 'claimed'
  ) OR public.stripe_lifetime_claimed_seat_count_v2() <> 1
  THEN
    RAISE EXCEPTION
      'hard deletion erased or double-counted a historical lifetime seat';
  END IF;
END
$durable_legacy_claim_survives_hard_delete$;

-- New payment_history targets infer and still permit multiple NULL identities.
INSERT INTO public.payment_history(stripe_invoice_id, status, amount)
VALUES ('in_inferable', 'succeeded', 1000)
ON CONFLICT (stripe_invoice_id) DO UPDATE
SET status = EXCLUDED.status, amount = EXCLUDED.amount;
INSERT INTO public.payment_history(stripe_invoice_id, status, amount)
VALUES ('in_inferable', 'refunded', -1000)
ON CONFLICT (stripe_invoice_id) DO UPDATE
SET status = EXCLUDED.status, amount = EXCLUDED.amount;
INSERT INTO public.payment_history(stripe_payment_intent_id, status, amount)
VALUES ('pi_inferable', 'succeeded', 2000)
ON CONFLICT (stripe_payment_intent_id) DO UPDATE
SET status = EXCLUDED.status, amount = EXCLUDED.amount;
INSERT INTO public.payment_history(stripe_payment_intent_id, status, amount)
VALUES ('pi_inferable', 'refunded', -2000)
ON CONFLICT (stripe_payment_intent_id) DO UPDATE
SET status = EXCLUDED.status, amount = EXCLUDED.amount;
INSERT INTO public.payment_history(status)
VALUES ('null-identity-1'), ('null-identity-2');

DO $conflict_target_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.payment_history
    WHERE stripe_invoice_id = 'in_inferable'
      AND status = 'refunded'
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM public.payment_history
    WHERE stripe_payment_intent_id = 'pi_inferable'
      AND status = 'refunded'
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM public.payment_history
    WHERE stripe_invoice_id IS NULL
      AND stripe_payment_intent_id IS NULL
  ) <> 2 THEN
    RAISE EXCEPTION
      'payment_history ON CONFLICT column inference did not converge';
  END IF;
END
$conflict_target_proof$;

-- Compact test adapters keep every production RPC call fully specified.
CREATE FUNCTION public.test_activate_recurring(
  p_user_id uuid,
  p_subscription_id text,
  p_token text,
  p_period_start timestamptz,
  p_period_end timestamptz
)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT public.activate_recurring_entitlement_payment_atomic(
    p_user_id,
    'cus_' || pg_catalog.replace(p_user_id::text, '-', ''),
    p_subscription_id,
    'in_' || p_token,
    'pi_' || p_token,
    'ch_' || p_token,
    'monthly',
    1000,
    'usd',
    p_period_start,
    p_period_end,
    'paid',
    'active'
  )
$function$;

CREATE FUNCTION public.test_activate_recurring_direct(
  p_user_id uuid,
  p_subscription_id text,
  p_token text,
  p_period_start timestamptz,
  p_period_end timestamptz
)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT public.activate_recurring_entitlement_payment_atomic(
    p_user_id,
    'cus_' || pg_catalog.replace(p_user_id::text, '-', ''),
    p_subscription_id,
    'in_' || p_token,
    NULL,
    'ch_' || p_token,
    'monthly',
    1000,
    'usd',
    p_period_start,
    p_period_end,
    'paid',
    'active'
  )
$function$;

CREATE FUNCTION public.test_refund_recurring(
  p_user_id uuid,
  p_subscription_id text,
  p_token text,
  p_refund_amount bigint,
  p_refund_state text,
  p_subscription_status text,
  p_event_id text,
  p_event_created_at timestamptz,
  p_period_start timestamptz,
  p_period_end timestamptz
)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT public.reconcile_stripe_entitlement_refund_atomic(
    p_user_id,
    'cus_' || pg_catalog.replace(p_user_id::text, '-', ''),
    'recurring',
    'monthly',
    p_subscription_id,
    'in_' || p_token,
    'pi_' || p_token,
    'ch_' || p_token,
    NULL,
    1000,
    'usd',
    p_period_start,
    p_period_end,
    'paid',
    p_refund_amount,
    p_refund_state,
    p_subscription_status,
    p_event_id,
    p_event_created_at
  )
$function$;

CREATE FUNCTION public.test_refund_recurring_direct(
  p_user_id uuid,
  p_subscription_id text,
  p_token text,
  p_refund_amount bigint,
  p_refund_state text,
  p_subscription_status text,
  p_event_id text,
  p_event_created_at timestamptz,
  p_period_start timestamptz,
  p_period_end timestamptz
)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT public.reconcile_stripe_entitlement_refund_atomic(
    p_user_id,
    'cus_' || pg_catalog.replace(p_user_id::text, '-', ''),
    'recurring',
    'monthly',
    p_subscription_id,
    'in_' || p_token,
    NULL,
    'ch_' || p_token,
    NULL,
    1000,
    'usd',
    p_period_start,
    p_period_end,
    'paid',
    p_refund_amount,
    p_refund_state,
    p_subscription_status,
    p_event_id,
    p_event_created_at
  )
$function$;

CREATE FUNCTION public.test_activate_lifetime(
  p_user_id uuid,
  p_token text,
  p_paid_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
AS $function$
DECLARE
  v_reservation_result jsonb;
  v_reservation_id uuid;
  v_session_expires_at timestamptz;
  v_bind_status text;
BEGIN
  v_reservation_result :=
    public.reserve_lifetime_membership_spot_atomic(
      p_user_id,
      'test:' || p_token,
      1800
    );
  v_reservation_id :=
    (v_reservation_result ->> 'reservation_id')::uuid;

  IF v_reservation_id IS NULL THEN
    INSERT INTO public.stripe_lifetime_seat_reservations (
      user_id,
      request_nonce,
      status,
      checkout_expires_at,
      expires_at,
      checkout_session_id
    ) VALUES (
      p_user_id,
      'test:' || p_token,
      'bound',
      p_paid_at + pg_catalog.make_interval(mins => 30),
      p_paid_at + pg_catalog.make_interval(mins => 45),
      'cs_' || p_token
    )
    RETURNING id, checkout_expires_at
    INTO v_reservation_id, v_session_expires_at;
  ELSE
    UPDATE public.stripe_lifetime_seat_reservations
    SET checkout_expires_at = GREATEST(
          checkout_expires_at,
          p_paid_at + pg_catalog.make_interval(mins => 30)
        ),
        expires_at = GREATEST(
          checkout_expires_at,
          p_paid_at + pg_catalog.make_interval(mins => 30)
        ) + pg_catalog.make_interval(mins => 15)
    WHERE id = v_reservation_id
      AND status = 'reserved'
    RETURNING checkout_expires_at INTO v_session_expires_at;

    IF v_session_expires_at IS NULL THEN
      SELECT reservation.checkout_expires_at
      INTO v_session_expires_at
      FROM public.stripe_lifetime_seat_reservations AS reservation
      WHERE reservation.id = v_reservation_id;
    END IF;

    v_bind_status :=
      public.bind_lifetime_membership_reservation_session_atomic(
        p_user_id,
        v_reservation_id,
        'test:' || p_token,
        'cs_' || p_token,
        v_session_expires_at
      ) ->> 'status';
    IF v_bind_status NOT IN ('bound', 'already_bound', 'already_converted') THEN
      RAISE EXCEPTION 'test reservation binding failed: %', v_bind_status;
    END IF;
  END IF;

  RETURN public.activate_lifetime_membership_with_identity_atomic(
    p_user_id,
    'cus_' || pg_catalog.replace(p_user_id::text, '-', ''),
    'cs_' || p_token,
    v_reservation_id,
    'pi_' || p_token,
    'ch_' || p_token,
    50000,
    'usd',
    p_paid_at,
    'succeeded'
  );
END
$function$;

CREATE FUNCTION public.test_refund_lifetime(
  p_user_id uuid,
  p_token text,
  p_refund_amount bigint,
  p_refund_state text,
  p_event_id text,
  p_event_created_at timestamptz,
  p_paid_at timestamptz
)
RETURNS jsonb
LANGUAGE sql
AS $function$
  SELECT public.reconcile_stripe_entitlement_refund_atomic(
    p_user_id,
    'cus_' || pg_catalog.replace(p_user_id::text, '-', ''),
    'lifetime',
    'lifetime',
    NULL,
    NULL,
    'pi_' || p_token,
    'ch_' || p_token,
    'cs_' || p_token,
    50000,
    'usd',
    p_paid_at,
    NULL,
    'succeeded',
    p_refund_amount,
    p_refund_state,
    NULL,
    p_event_id,
    p_event_created_at
  )
$function$;
SQL

psql_cmd <<'SQL'
INSERT INTO auth.users(id)
SELECT (
  '10000000-0000-0000-0000-'
  || pg_catalog.lpad(sequence_number::text, 12, '0')
)::uuid
FROM pg_catalog.generate_series(1, 30) AS sequence_number;

INSERT INTO public.user_profiles(
  id, subscription_tier, pro_plan, pro_expires_at, is_pro
) VALUES
  ('10000000-0000-0000-0000-000000000001', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000002', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000003', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000004', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000005', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000006', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000007', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000008', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000009', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000010', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000011', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000012', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000013', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000014', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000015', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000016', 'free', NULL, NULL, false),
  ('10000000-0000-0000-0000-000000000017', 'free', NULL, NULL, false);

INSERT INTO public.user_profiles(
  id, subscription_tier, pro_plan, pro_expires_at, is_pro
)
SELECT auth_user.id, 'free', NULL, NULL, false
FROM auth.users AS auth_user
WHERE auth_user.id >
  '10000000-0000-0000-0000-000000000017'::uuid;

INSERT INTO public.test_official_members(user_id)
SELECT id FROM public.user_profiles
ON CONFLICT (user_id) DO NOTHING;

SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

DO $payment_authority_proof$
DECLARE
  v_status text;
  v_user uuid;
BEGIN
  -- Same Stripe subscription, newer invoice wins; old invoice refund persists
  -- but cannot revoke the current payment period.
  v_user := '10000000-0000-0000-0000-000000000001';
  v_status := public.test_activate_recurring(
    v_user, 'sub_period_owner', 'period_one',
    '2030-01-01Z', '2030-02-01Z'
  ) ->> 'status';
  IF v_status <> 'activated' THEN
    RAISE EXCEPTION 'first recurring payment was not activated';
  END IF;
  v_status := public.test_activate_recurring(
    v_user, 'sub_period_owner', 'period_one',
    '2030-01-01Z', '2030-02-01Z'
  ) ->> 'status';
  IF v_status <> 'already_activated'
    OR (
      SELECT pg_catalog.count(*)
      FROM public.stripe_entitlement_effects AS effect
      JOIN public.stripe_entitlement_payments AS payment
        ON payment.id = effect.entitlement_payment_id
      WHERE payment.stripe_invoice_id = 'in_period_one'
    ) <> 2
    OR EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_effects AS effect
      WHERE effect.effect_type LIKE '%nft%'
    )
  THEN
    RAISE EXCEPTION 'recurring activation replay duplicated effects';
  END IF;
  v_status := public.test_activate_recurring(
    v_user, 'sub_period_owner', 'period_two',
    '2030-02-01Z', '2030-03-01Z'
  ) ->> 'status';
  IF v_status <> 'activated' THEN
    RAISE EXCEPTION 'new recurring period was not activated';
  END IF;
  v_status := public.test_refund_recurring(
    v_user, 'sub_period_owner', 'period_one',
    1000, 'succeeded', 'active',
    'evt_old_period_full', '2030-02-10Z',
    '2030-01-01Z', '2030-02-01Z'
  ) ->> 'status';
  IF v_status <> 'not_current'
    OR NOT EXISTS (
      SELECT 1
      FROM public.subscriptions AS subscription
      JOIN public.stripe_entitlement_payments AS payment
        ON payment.id = subscription.entitlement_payment_id
      WHERE subscription.user_id = v_user
        AND subscription.status = 'active'
        AND payment.stripe_invoice_id = 'in_period_two'
    )
    OR NOT public.stripe_has_current_pro_authority_v2(v_user)
  THEN
    RAISE EXCEPTION 'old invoice refund revoked the newer paid period';
  END IF;
  v_status := public.test_refund_recurring(
    v_user, 'sub_period_owner', 'period_one',
    1000, 'succeeded', 'active',
    'evt_old_period_full', '2030-02-10Z',
    '2030-01-01Z', '2030-02-01Z'
  ) ->> 'status';
  IF v_status <> 'already_reconciled'
    OR (
      SELECT pg_catalog.count(*)
      FROM public.stripe_entitlement_refund_events
      WHERE event_id = 'evt_old_period_full'
    ) <> 1
  THEN
    RAISE EXCEPTION 'refund event replay was not append-only idempotent';
  END IF;

  -- Stripe can redeliver the same immutable event id after its parent Charge
  -- aggregate has changed. Keep the first immutable event row plus both
  -- observations, and apply the fresh terminal aggregate.
  v_user := '10000000-0000-0000-0000-000000000014';
  v_status := public.test_refund_lifetime(
    v_user, 'mutable_event', 0, 'pending',
    'evt_mutable_retry', '2030-12-02Z', '2030-12-01Z'
  ) ->> 'status';
  IF v_status <> 'refund_recorded' THEN
    RAISE EXCEPTION 'first mutable refund aggregate was not recorded';
  END IF;
  v_status := public.test_refund_lifetime(
    v_user, 'mutable_event', 50000, 'succeeded',
    'evt_mutable_retry', '2030-12-02Z', '2030-12-01Z'
  ) ->> 'status';
  IF v_status <> 'refund_recorded'
    OR (
      SELECT pg_catalog.jsonb_array_length(observations)
      FROM public.stripe_entitlement_refund_events
      WHERE event_id = 'evt_mutable_retry'
        AND refund_succeeded_amount = 0
        AND refund_state = 'pending'
    ) <> 2
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments
      WHERE checkout_session_id = 'cs_mutable_event'
        AND refund_succeeded_amount = 50000
        AND refund_state = 'succeeded'
    )
  THEN
    RAISE EXCEPTION 'mutable same-event retry did not apply fresh aggregate';
  END IF;

  -- A full lifetime refund received first is a durable tombstone.
  v_user := '10000000-0000-0000-0000-000000000002';
  v_status := public.test_refund_lifetime(
    v_user, 'lifetime_phantom', 50000, 'succeeded',
    'evt_lifetime_phantom', '2030-03-02Z', '2030-03-01Z'
  ) ->> 'status';
  IF v_status <> 'refund_recorded' THEN
    RAISE EXCEPTION 'refund-before-activation tombstone was not recorded';
  END IF;
  v_status := public.test_activate_lifetime(
    v_user, 'lifetime_phantom', '2030-03-01Z'
  ) ->> 'status';
  IF v_status <> 'refunded_payment'
    OR EXISTS (
      SELECT 1 FROM public.subscriptions WHERE user_id = v_user
    )
  THEN
    RAISE EXCEPTION 'refund-before-activation created phantom entitlement';
  END IF;

  -- Lifetime activation replay does not duplicate external-effect intents.
  v_user := '10000000-0000-0000-0000-000000000003';
  v_status := public.test_activate_lifetime(
    v_user, 'lifetime_current', '2030-04-01Z'
  ) ->> 'status';
  IF v_status <> 'activated' THEN
    RAISE EXCEPTION 'lifetime payment was not activated';
  END IF;
  v_status := public.test_activate_lifetime(
    v_user, 'lifetime_current', '2030-04-01Z'
  ) ->> 'status';
  IF v_status <> 'already_activated'
    OR (
      SELECT pg_catalog.count(*)
      FROM public.stripe_entitlement_effects AS effect
      JOIN public.stripe_entitlement_payments AS payment
        ON payment.id = effect.entitlement_payment_id
      WHERE payment.checkout_session_id = 'cs_lifetime_current'
    ) <> 2
  THEN
    RAISE EXCEPTION 'same lifetime payment replay duplicated effects';
  END IF;
  v_status := public.test_refund_lifetime(
    v_user, 'lifetime_current', 50000, 'succeeded',
    'evt_lifetime_full', '2030-04-02Z', '2030-04-01Z'
  ) ->> 'status';
  IF v_status <> 'revoked'
    OR public.stripe_has_current_pro_authority_v2(v_user)
  THEN
    RAISE EXCEPTION 'activation-before-lifetime-refund did not revoke';
  END IF;
  v_status := public.test_refund_lifetime(
    v_user, 'lifetime_current', 0, 'failed',
    'evt_lifetime_failed_later', '2030-04-03Z', '2030-04-01Z'
  ) ->> 'status';
  IF v_status <> 'manual_review'
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_manual_reviews
      WHERE object_type = 'refund'
        AND object_id = 'evt_lifetime_failed_later'
        AND reason_key = 'full_refund_terminal_conflict'
    )
    OR (
      SELECT pg_catalog.count(*)
      FROM public.stripe_entitlement_refund_events AS event
      JOIN public.stripe_entitlement_payments AS payment
        ON payment.id = event.entitlement_payment_id
      WHERE payment.checkout_session_id = 'cs_lifetime_current'
    ) <> 2
  THEN
    RAISE EXCEPTION 'lifetime refund reversal lacked durable review/audit';
  END IF;

  -- A fully succeeded refund is terminal even when a later event carries a
  -- lower aggregate and reports the Stripe subscription active.
  v_user := '10000000-0000-0000-0000-000000000004';
  PERFORM public.test_activate_recurring(
    v_user, 'sub_restore', 'restore_period',
    '2030-05-01Z', '2030-06-01Z'
  );
  v_status := public.test_refund_recurring(
    v_user, 'sub_restore', 'restore_period',
    1000, 'succeeded', 'active',
    'evt_restore_full', '2030-05-02Z',
    '2030-05-01Z', '2030-06-01Z'
  ) ->> 'status';
  IF v_status <> 'revoked' THEN
    RAISE EXCEPTION 'recurring full refund was not revoked';
  END IF;
  v_status := public.test_refund_recurring(
    v_user, 'sub_restore', 'restore_period',
    0, 'failed', 'active',
    'evt_restore_failed', '2030-05-03Z',
    '2030-05-01Z', '2030-06-01Z'
  ) ->> 'status';
  IF v_status <> 'manual_review'
    OR public.stripe_has_current_pro_authority_v2(v_user)
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_manual_reviews
      WHERE object_id = 'evt_restore_failed'
        AND reason_key = 'full_refund_terminal_conflict'
    )
  THEN
    RAISE EXCEPTION 'later recurring aggregate reversed terminal full refund';
  END IF;

  -- Absolute-expiry grants are replay-safe and survive an unrelated Stripe
  -- refund without using user_profiles.is_pro as authority.
  v_user := '10000000-0000-0000-0000-000000000005';
  v_status := public.upsert_pro_entitlement_grant_atomic(
    v_user, 'referral', 'friend:grant-1',
    '2020-01-01Z', '2030-12-01Z',
    '{"campaign":"friend"}'::jsonb
  ) ->> 'status';
  IF v_status <> 'granted' THEN
    RAISE EXCEPTION 'explicit referral grant was not created';
  END IF;
  v_status := public.upsert_pro_entitlement_grant_atomic(
    v_user, 'referral', 'friend:grant-1',
    '2020-01-01Z', '2030-12-01Z',
    '{"campaign":"friend"}'::jsonb
  ) ->> 'status';
  IF v_status <> 'already_granted' THEN
    RAISE EXCEPTION 'grant replay was not idempotent';
  END IF;
  v_status := public.upsert_pro_entitlement_grant_atomic(
    v_user, 'referral', 'friend:grant-1',
    '2020-01-01Z', '2031-01-01Z',
    '{"campaign":"friend","extension":true}'::jsonb
  ) ->> 'status';
  IF v_status <> 'extended' THEN
    RAISE EXCEPTION 'absolute grant extension did not converge';
  END IF;
  v_status := public.upsert_pro_entitlement_grant_atomic(
    v_user, 'referral', 'friend:grant-1',
    '2020-01-01Z', '2030-06-01Z',
    '{"campaign":"friend"}'::jsonb
  ) ->> 'status';
  IF v_status <> 'stale_grant' THEN
    RAISE EXCEPTION 'shorter grant replay was not rejected as stale';
  END IF;
  PERFORM public.test_activate_recurring(
    v_user, 'sub_grant', 'grant_period',
    '2030-06-01Z', '2030-07-01Z'
  );
  v_status := public.test_refund_recurring(
    v_user, 'sub_grant', 'grant_period',
    1000, 'succeeded', 'active',
    'evt_grant_full', '2030-06-02Z',
    '2030-06-01Z', '2030-07-01Z'
  ) ->> 'status';
  IF v_status <> 'grant_protected'
    OR NOT public.stripe_has_current_pro_authority_v2(v_user)
    OR NOT EXISTS (
      SELECT 1 FROM public.user_profiles
      WHERE id = v_user
        AND subscription_tier = 'pro'
        AND is_pro
        AND pro_expires_at = '2031-01-01Z'
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.test_official_members WHERE user_id = v_user
    )
  THEN
    RAISE EXCEPTION
      'explicit grant did not protect refunded projection: status=%, authority=%, profile=%, member=%',
      v_status,
      public.stripe_has_current_pro_authority_v2(v_user),
      (
        SELECT pg_catalog.jsonb_build_object(
          'tier', profile.subscription_tier,
          'is_pro', profile.is_pro,
          'expires', profile.pro_expires_at
        )
        FROM public.user_profiles AS profile
        WHERE profile.id = v_user
      ),
      EXISTS (
        SELECT 1 FROM public.test_official_members WHERE user_id = v_user
      );
  END IF;

  -- Relative-day rewards atomically append after the latest paid recurring
  -- period and finite grant. Stable-key replay is exact; changed identity is
  -- quarantined in a durable review instead of silently extending twice.
  v_user := '10000000-0000-0000-0000-000000000015';
  PERFORM public.test_activate_recurring(
    v_user, 'sub_reward_base', 'reward_base',
    '2030-01-01Z', '2031-01-01Z'
  );
  v_status := public.grant_pro_entitlement_days_atomic(
    v_user,
    'referral',
    'friend:reward-days',
    30,
    '2020-06-01Z',
    '{"campaign":"friend"}'::jsonb
  ) ->> 'status';
  IF v_status <> 'granted'
    OR NOT EXISTS (
      SELECT 1
      FROM public.pro_entitlement_grants
      WHERE user_id = v_user
        AND source = 'referral'
        AND source_key = 'friend:reward-days'
        AND grant_kind = 'days'
        AND granted_days = 30
        AND granted_at = '2020-06-01Z'
        AND starts_at = '2031-01-01Z'
        AND expires_at = '2031-01-31Z'
    )
  THEN
    RAISE EXCEPTION 'relative days grant did not append after paid period';
  END IF;
  v_status := public.grant_pro_entitlement_days_atomic(
    v_user,
    'referral',
    'friend:reward-days',
    30,
    '2020-06-01Z',
    '{"campaign":"friend"}'::jsonb
  ) ->> 'status';
  IF v_status <> 'already_granted' THEN
    RAISE EXCEPTION 'relative days grant replay was not idempotent';
  END IF;
  v_status := public.grant_pro_entitlement_days_atomic(
    v_user,
    'referral',
    'friend:reward-days',
    31,
    '2020-06-01Z',
    '{"campaign":"friend"}'::jsonb
  ) ->> 'status';
  IF v_status <> 'identity_conflict'
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_manual_reviews
      WHERE user_id = v_user
        AND reason_key = 'grant_days_identity_conflict'
    )
  THEN
    RAISE EXCEPTION 'changed days-grant replay lacked durable review';
  END IF;

  BEGIN
    PERFORM public.grant_pro_entitlement_days_atomic(
      v_user,
      'referral',
      'friend:too-many-days',
      3651,
      '2020-06-01Z',
      '{}'::jsonb
    );
    RAISE EXCEPTION 'days-grant upper bound was not enforced';
  EXCEPTION
    WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.grant_pro_entitlement_days_atomic(
      v_user,
      'referral',
      'friend:future-days',
      1,
      pg_catalog.statement_timestamp() + interval '6 minutes',
      '{}'::jsonb
    );
    RAISE EXCEPTION 'future grant timestamp was not rejected';
  EXCEPTION
    WHEN invalid_parameter_value THEN NULL;
  END;

  -- Permanent authority never converts a relative reward to infinity: the
  -- earned finite grant remains independently auditable.
  v_user := '10000000-0000-0000-0000-000000000016';
  PERFORM public.test_activate_lifetime(
    v_user, 'lifetime_reward_base', '2030-01-01Z'
  );
  v_status := public.grant_pro_entitlement_days_atomic(
    v_user,
    'referral',
    'friend:lifetime-days',
    7,
    '2020-02-01Z',
    '{"campaign":"friend"}'::jsonb
  ) ->> 'status';
  IF v_status <> 'granted'
    OR NOT EXISTS (
      SELECT 1
      FROM public.pro_entitlement_grants
      WHERE user_id = v_user
        AND source_key = 'friend:lifetime-days'
        AND grant_kind = 'days'
        AND granted_at = '2020-02-01Z'
        AND starts_at = pg_catalog.statement_timestamp()
        AND expires_at = starts_at + interval '7 days'
    )
  THEN
    RAISE EXCEPTION 'lifetime authority swallowed a finite earned grant';
  END IF;

  -- Recurring purchase under lifetime is never lost: ledger + durable review
  -- + outbox survive while lifetime remains current.
  v_user := '10000000-0000-0000-0000-000000000006';
  PERFORM public.test_activate_lifetime(
    v_user, 'protected_lifetime', '2030-07-01Z'
  );
  v_status := public.test_activate_recurring(
    v_user, 'sub_conflict', 'paid_under_lifetime',
    '2030-08-01Z', '2030-09-01Z'
  ) ->> 'status';
  IF v_status <> 'current_entitlement_protected'
    OR NOT EXISTS (
      SELECT 1 FROM public.stripe_entitlement_payments
      WHERE stripe_invoice_id = 'in_paid_under_lifetime'
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.stripe_manual_reviews
      WHERE object_id = 'ch_paid_under_lifetime'
        AND reason_key = 'recurring_purchase_conflicts_with_lifetime'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_effects AS effect
      JOIN public.stripe_entitlement_payments AS payment
        ON payment.id = effect.entitlement_payment_id
      WHERE payment.stripe_invoice_id = 'in_paid_under_lifetime'
        AND effect.effect_type = 'payment_manual_review'
    )
  THEN
    RAISE EXCEPTION 'protected recurring purchase was silently lost';
  END IF;

  -- Lifetime purchase always upgrades a recurring authority.
  v_user := '10000000-0000-0000-0000-000000000007';
  PERFORM public.test_activate_recurring(
    v_user, 'sub_before_lifetime', 'before_lifetime',
    '2030-09-01Z', '2030-10-01Z'
  );
  v_status := public.test_activate_lifetime(
    v_user, 'lifetime_upgrade', '2030-09-15Z'
  ) ->> 'status';
  IF v_status <> 'activated'
    OR NOT EXISTS (
      SELECT 1
      FROM public.subscriptions AS subscription
      JOIN public.stripe_entitlement_payments AS payment
        ON payment.id = subscription.entitlement_payment_id
      WHERE subscription.user_id = v_user
        AND subscription.plan = 'lifetime'
        AND payment.checkout_session_id = 'cs_lifetime_upgrade'
    )
  THEN
    RAISE EXCEPTION 'paid lifetime purchase was swallowed by recurring state';
  END IF;

  -- Trial is an explicit, non-payment authority and paid activation replaces it.
  v_user := '10000000-0000-0000-0000-000000000008';
  v_status := public.activate_recurring_trial_entitlement_atomic(
    v_user,
    'cus_trial',
    'sub_trial',
    'monthly',
    '2030-10-01Z',
    '2030-10-15Z',
    'trialing'
  ) ->> 'status';
  IF v_status <> 'activated'
    OR NOT public.stripe_has_current_pro_authority_v2(v_user)
    OR EXISTS (
      SELECT 1 FROM public.stripe_entitlement_payments WHERE user_id = v_user
    )
  THEN
    RAISE EXCEPTION 'verified trial fabricated or lacked authority';
  END IF;
  v_status := public.activate_recurring_trial_entitlement_atomic(
    v_user,
    'cus_trial',
    'sub_trial',
    'monthly',
    '2030-10-01Z',
    '2030-10-15Z',
    'trialing'
  ) ->> 'status';
  IF v_status <> 'already_activated' THEN
    RAISE EXCEPTION 'trial replay was not idempotent';
  END IF;

  -- Immutable payment identity conflicts create durable review evidence.
  v_user := '10000000-0000-0000-0000-000000000009';
  PERFORM public.test_activate_recurring(
    v_user, 'sub_identity', 'identity_one',
    '2030-11-01Z', '2030-12-01Z'
  );
  v_status := public.activate_recurring_entitlement_payment_atomic(
    v_user,
    'cus_' || pg_catalog.replace(v_user::text, '-', ''),
    'sub_identity',
    'in_identity_one',
    'pi_identity_one',
    'ch_identity_changed',
    'monthly',
    1000,
    'usd',
    '2030-11-01Z',
    '2030-12-01Z',
    'paid',
    'active'
  ) ->> 'status';
  IF v_status <> 'identity_conflict'
    OR NOT EXISTS (
      SELECT 1 FROM public.stripe_manual_reviews
      WHERE object_id = 'pi_identity_one'
        AND reason_key = 'payment_identity_conflict'
    )
  THEN
    RAISE EXCEPTION 'payment identity conflict lacked durable review';
  END IF;

  -- Generic review keys accept dispute:<id> and hyphenated reasons; replay is
  -- a strict one-key acknowledgement.
  v_status := public.record_stripe_manual_review_atomic(
    'dispute',
    'dp_123',
    NULL,
    'dispute:dp_123-review',
    'Dispute requires operator review.',
    '{"source":"test"}'::jsonb
  ) ->> 'status';
  IF v_status <> 'recorded' THEN
    RAISE EXCEPTION 'generic durable review was not recorded';
  END IF;
  v_status := public.record_stripe_manual_review_atomic(
    'dispute',
    'dp_123',
    NULL,
    'dispute:dp_123-review',
    'Dispute requires operator review.',
    '{"source":"test"}'::jsonb
  ) ->> 'status';
  IF v_status <> 'already_recorded' THEN
    RAISE EXCEPTION 'generic durable review replay was not idempotent';
  END IF;
END
$payment_authority_proof$;
SQL

psql_cmd <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);

DO $direct_charge_tombstone_proof$
DECLARE
  v_status text;
  v_payment_id uuid;
  v_reservation_id uuid;
  v_before_count integer;
BEGIN
  -- A direct captured Charge with no PaymentIntent is ownerless financial
  -- evidence. A user id is only an audit hint and is never stored on the
  -- tombstone parent.
  v_status := public.record_charge_refund_tombstone_atomic(
    NULL,
    'cus_ownerless_direct',
    NULL,
    'ch_ownerless_direct',
    true,
    1000,
    'usd',
    0,
    'pending',
    'evt_ownerless_direct',
    '2032-01-01Z'
  ) ->> 'status';
  IF v_status <> 'recorded'
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstones AS tombstone
      WHERE tombstone.stripe_charge_id = 'ch_ownerless_direct'
        AND tombstone.stripe_payment_intent_id IS NULL
        AND tombstone.resolution_kind = 'unclassified'
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
          'public.stripe_charge_refund_tombstones'::pg_catalog.regclass
        AND attribute.attname = 'user_id'
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  THEN
    RAISE EXCEPTION
      'ownerless PI-null direct Charge tombstone was not preserved';
  END IF;

  -- One Stripe event id can have only one Charge parent. Prove both naming
  -- orders and ensure a rejected second parent is never created.
  v_status := public.record_charge_refund_tombstone_atomic(
    NULL, 'cus_event_left', NULL, 'ch_event_left', true, 1000, 'usd',
    0, 'pending', 'evt_cross_charge_left_first', '2032-01-02Z'
  ) ->> 'status';
  IF v_status <> 'recorded' THEN
    RAISE EXCEPTION 'left-first Charge event setup failed';
  END IF;
  v_status := public.record_charge_refund_tombstone_atomic(
    NULL, 'cus_event_right', NULL, 'ch_event_right', true, 1000, 'usd',
    0, 'pending', 'evt_cross_charge_left_first', '2032-01-02Z'
  ) ->> 'status';
  IF v_status <> 'identity_conflict'
    OR EXISTS (
      SELECT 1 FROM public.stripe_charge_refund_tombstones
      WHERE stripe_charge_id = 'ch_event_right'
    )
  THEN
    RAISE EXCEPTION
      'same refund event created a second Charge parent left-first';
  END IF;

  v_status := public.record_charge_refund_tombstone_atomic(
    NULL, 'cus_event_right_two', NULL, 'ch_event_right_two',
    true, 1000, 'usd', 0, 'pending',
    'evt_cross_charge_right_first', '2032-01-03Z'
  ) ->> 'status';
  IF v_status <> 'recorded' THEN
    RAISE EXCEPTION 'right-first Charge event setup failed';
  END IF;
  v_status := public.record_charge_refund_tombstone_atomic(
    NULL, 'cus_event_left_two', NULL, 'ch_event_left_two',
    true, 1000, 'usd', 0, 'pending',
    'evt_cross_charge_right_first', '2032-01-03Z'
  ) ->> 'status';
  IF v_status <> 'identity_conflict'
    OR EXISTS (
      SELECT 1 FROM public.stripe_charge_refund_tombstones
      WHERE stripe_charge_id = 'ch_event_left_two'
    )
  THEN
    RAISE EXCEPTION
      'same refund event created a second Charge parent right-first';
  END IF;

  -- Ledger first: refund classification must route to the exact payment and
  -- must not create a tombstone parent.
  v_status := public.test_activate_recurring_direct(
    '10000000-0000-0000-0000-000000000018',
    'sub_direct_ledger_first',
    'direct_ledger_first',
    '2032-02-01Z',
    '2032-03-01Z'
  ) ->> 'status';
  IF v_status <> 'activated' THEN
    RAISE EXCEPTION 'direct Charge ledger-first activation failed';
  END IF;
  v_status := public.record_charge_refund_tombstone_atomic(
    '10000000-0000-0000-0000-000000000018',
    'cus_10000000000000000000000000000018',
    NULL,
    'ch_direct_ledger_first',
    true,
    1000,
    'usd',
    0,
    'pending',
    'evt_direct_ledger_first',
    '2032-02-02Z'
  ) ->> 'status';
  IF v_status <> 'payment_reconciliation_required'
    OR EXISTS (
      SELECT 1 FROM public.stripe_charge_refund_tombstones
      WHERE stripe_charge_id = 'ch_direct_ledger_first'
    )
  THEN
    RAISE EXCEPTION
      'ledger-first direct Charge created an orphan tombstone parent';
  END IF;

  -- Tombstone first: activation merges under the same Charge lock and then
  -- creates current authority only for a non-terminal aggregate.
  v_status := public.record_charge_refund_tombstone_atomic(
    '10000000-0000-0000-0000-000000000019',
    'cus_10000000000000000000000000000019',
    NULL,
    'ch_direct_tombstone_first',
    true,
    1000,
    'usd',
    0,
    'pending',
    'evt_direct_tombstone_first',
    '2032-03-01Z'
  ) ->> 'status';
  IF v_status <> 'recorded' THEN
    RAISE EXCEPTION 'direct Charge tombstone-first setup failed';
  END IF;
  v_status := public.test_activate_recurring_direct(
    '10000000-0000-0000-0000-000000000019',
    'sub_direct_tombstone_first',
    'direct_tombstone_first',
    '2032-03-01Z',
    '2032-04-01Z'
  ) ->> 'status';
  SELECT payment.id
  INTO v_payment_id
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.stripe_charge_id = 'ch_direct_tombstone_first';
  IF v_status <> 'activated'
    OR v_payment_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstones AS tombstone
      WHERE tombstone.stripe_charge_id = 'ch_direct_tombstone_first'
        AND tombstone.resolution_kind = 'entitlement_payment'
        AND tombstone.merged_payment_id = v_payment_id
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_refund_events AS refund_event
      WHERE refund_event.event_id = 'evt_direct_tombstone_first'
        AND refund_event.entitlement_payment_id = v_payment_id
    )
  THEN
    RAISE EXCEPTION
      'tombstone-first direct Charge did not merge before activation';
  END IF;

  -- A succeeded full aggregate is terminal. A later lower/nonterminal fresh
  -- observation advances only the max-seen event watermark.
  v_status := public.record_charge_refund_tombstone_atomic(
    NULL, 'cus_terminal_direct', NULL, 'ch_terminal_direct',
    true, 1000, 'usd', 1000, 'succeeded',
    'evt_terminal_direct_full', '2032-04-01Z'
  ) ->> 'status';
  IF v_status <> 'recorded' THEN
    RAISE EXCEPTION 'full direct Charge tombstone setup failed';
  END IF;
  v_status := public.record_charge_refund_tombstone_atomic(
    NULL, 'cus_terminal_direct', NULL, 'ch_terminal_direct',
    true, 1000, 'usd', 100, 'failed',
    'evt_terminal_direct_lower', '2032-04-02Z'
  ) ->> 'status';
  IF v_status <> 'full_refund_terminal'
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstones AS tombstone
      WHERE tombstone.stripe_charge_id = 'ch_terminal_direct'
        AND tombstone.refund_state = 'succeeded'
        AND tombstone.refund_succeeded_amount = 1000
        AND tombstone.refund_snapshot_event_id =
          'evt_terminal_direct_full'
        AND tombstone.latest_refund_event_id =
          'evt_terminal_direct_lower'
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.stripe_manual_reviews
      WHERE object_id = 'evt_terminal_direct_lower'
        AND reason_key = 'full_refund_terminal_conflict'
    )
  THEN
    RAISE EXCEPTION
      'direct Charge full refund terminal aggregate was reversed';
  END IF;

  -- A full tombstone must be merged before lifetime activation creates any
  -- grant/subscription/effect, and the exact bound seat must be released.
  INSERT INTO public.stripe_lifetime_seat_reservations (
    user_id,
    request_nonce,
    status,
    checkout_expires_at,
    expires_at,
    checkout_session_id
  ) VALUES (
    '10000000-0000-0000-0000-000000000023',
    'test:tombstone_lifetime',
    'bound',
    '2035-01-01Z',
    '2035-01-01 00:15:00Z',
    'cs_tombstone_lifetime'
  )
  RETURNING id INTO v_reservation_id;
  v_before_count := public.stripe_lifetime_claimed_seat_count_v2();
  v_status := public.record_charge_refund_tombstone_atomic(
    '10000000-0000-0000-0000-000000000023',
    'cus_10000000000000000000000000000023',
    'pi_tombstone_lifetime',
    'ch_tombstone_lifetime',
    true,
    50000,
    'usd',
    50000,
    'succeeded',
    'evt_tombstone_lifetime',
    '2032-05-01Z'
  ) ->> 'status';
  IF v_status <> 'recorded' THEN
    RAISE EXCEPTION 'lifetime full tombstone setup failed';
  END IF;
  v_status := public.activate_lifetime_membership_with_identity_atomic(
    '10000000-0000-0000-0000-000000000023',
    'cus_10000000000000000000000000000023',
    'cs_tombstone_lifetime',
    v_reservation_id,
    'pi_tombstone_lifetime',
    'ch_tombstone_lifetime',
    50000,
    'usd',
    '2032-05-01Z',
    'succeeded'
  ) ->> 'status';
  IF v_status <> 'refunded_payment'
    OR public.stripe_lifetime_claimed_seat_count_v2()
      IS DISTINCT FROM v_before_count - 1
    OR NOT EXISTS (
      SELECT 1 FROM public.stripe_lifetime_seat_reservations
      WHERE id = v_reservation_id
        AND status = 'released'
        AND release_reason = 'payment_refunded_before_activation'
    )
    OR EXISTS (
      SELECT 1 FROM public.pro_entitlement_grants
      WHERE user_id = '10000000-0000-0000-0000-000000000023'
    )
    OR EXISTS (
      SELECT 1 FROM public.subscriptions
      WHERE user_id = '10000000-0000-0000-0000-000000000023'
    )
    OR EXISTS (
      SELECT 1 FROM public.stripe_entitlement_effects
      WHERE user_id = '10000000-0000-0000-0000-000000000023'
    )
  THEN
    RAISE EXCEPTION
      'activation merge did not absorb full refund and release bound seat';
  END IF;

  -- After a merge, a newer classified refund can advance the payment. A replay
  -- must remain idempotently refunded rather than comparing against stale
  -- tombstone aggregate state.
  v_status := public.record_charge_refund_tombstone_atomic(
    '10000000-0000-0000-0000-000000000024',
    'cus_10000000000000000000000000000024',
    NULL,
    'ch_direct_merged_replay',
    true,
    1000,
    'usd',
    0,
    'pending',
    'evt_direct_merged_initial',
    '2032-06-01Z'
  ) ->> 'status';
  IF v_status <> 'recorded' THEN
    RAISE EXCEPTION 'merged replay tombstone setup failed';
  END IF;
  v_status := public.test_activate_recurring_direct(
    '10000000-0000-0000-0000-000000000024',
    'sub_direct_merged_replay',
    'direct_merged_replay',
    '2032-06-01Z',
    '2032-07-01Z'
  ) ->> 'status';
  IF v_status <> 'activated' THEN
    RAISE EXCEPTION 'merged replay activation failed';
  END IF;
  v_status := public.test_refund_recurring_direct(
    '10000000-0000-0000-0000-000000000024',
    'sub_direct_merged_replay',
    'direct_merged_replay',
    1000,
    'succeeded',
    'active',
    'evt_direct_merged_full',
    '2032-06-02Z',
    '2032-06-01Z',
    '2032-07-01Z'
  ) ->> 'status';
  IF v_status <> 'revoked' THEN
    RAISE EXCEPTION 'newer classified direct Charge refund failed';
  END IF;
  v_status := public.test_activate_recurring_direct(
    '10000000-0000-0000-0000-000000000024',
    'sub_direct_merged_replay',
    'direct_merged_replay',
    '2032-06-01Z',
    '2032-07-01Z'
  ) ->> 'status';
  IF v_status <> 'refunded_payment' THEN
    RAISE EXCEPTION
      'merged replay after newer payment refund was not idempotent';
  END IF;

  -- Full amount plus a non-succeeded state is invalid in both classification
  -- entry points.
  BEGIN
    PERFORM public.record_charge_refund_tombstone_atomic(
      NULL, 'cus_invalid_full', NULL, 'ch_invalid_full',
      true, 1000, 'usd', 1000, 'pending',
      'evt_invalid_full_tombstone', '2032-07-01Z'
    );
    RAISE EXCEPTION
      'full amount with non-succeeded state reached tombstone ledger';
  EXCEPTION
    WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.reconcile_stripe_entitlement_refund_atomic(
      '10000000-0000-0000-0000-000000000025',
      'cus_10000000000000000000000000000025',
      'recurring',
      'monthly',
      'sub_invalid_full',
      'in_invalid_full',
      NULL,
      'ch_invalid_full_rpc',
      NULL,
      1000,
      'usd',
      '2032-07-01Z',
      '2032-08-01Z',
      'paid',
      1000,
      'pending',
      'active',
      'evt_invalid_full_rpc',
      '2032-07-02Z'
    );
    RAISE EXCEPTION
      'full amount with non-succeeded state reached payment ledger';
  EXCEPTION
    WHEN invalid_parameter_value THEN NULL;
  END;

  -- A full cursor sweep converges drift that an expiry/is_pro-only candidate
  -- predicate would miss.
  UPDATE public.user_profiles
  SET subscription_tier = 'pro',
      pro_plan = 'yearly',
      pro_expires_at = NULL,
      is_pro = true,
      stripe_customer_id = 'cus_projection_drift',
      stripe_subscription_id = 'sub_projection_drift'
  WHERE id = '10000000-0000-0000-0000-000000000022';
  PERFORM public.reconcile_due_pro_entitlement_projections_atomic(500, NULL);
  IF EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.id = '10000000-0000-0000-0000-000000000022'
        AND (
          profile.subscription_tier IS DISTINCT FROM 'free'
          OR profile.pro_plan IS NOT NULL
          OR profile.pro_expires_at IS NOT NULL
          OR COALESCE(profile.is_pro, false)
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.test_official_members
      WHERE user_id = '10000000-0000-0000-0000-000000000022'
    )
  THEN
    RAISE EXCEPTION
      'full projection sweep did not converge non-expiry drift';
  END IF;

  IF (
    SELECT pg_catalog.array_agg(key ORDER BY key)
    FROM pg_catalog.jsonb_object_keys(
      public.stripe_paid_launch_readiness_v2()
    ) AS readiness(key)
  ) IS DISTINCT FROM ARRAY[
    'authority_drift',
    'completed_effects_without_external_ref',
    'open_manual_reviews',
    'paid_unbound_payments',
    'projection_drift',
    'reservation_anomalies',
    'status',
    'unfinished_effects',
    'unresolved_refund_tombstones'
  ]::text[]
  THEN
    RAISE EXCEPTION 'readiness JSON keys drifted';
  END IF;
END
$direct_charge_tombstone_proof$;
SQL

# Two distinct day rewards for one user serialize under the same entitlement
# advisory lock and append without a lost update.
psql_cmd >"$TMP_ROOT/grant-days-first.log" 2>&1 <<'SQL' &
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
BEGIN;
INSERT INTO public.test_results(result_key, result_status)
SELECT
  'grant-days-first',
  public.grant_pro_entitlement_days_atomic(
    '10000000-0000-0000-0000-000000000017',
    'referral',
    'concurrent:first',
    10,
    '2020-01-01Z',
    '{"lane":"first"}'::jsonb
  ) ->> 'status';
SELECT pg_catalog.pg_sleep(2) /* grant_days_concurrency */;
COMMIT;
SQL
grant_days_first_pid=$!

wait_for_sleep grant_days_concurrency

psql_cmd >"$TMP_ROOT/grant-days-second.log" 2>&1 <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
INSERT INTO public.test_results(result_key, result_status)
SELECT
  'grant-days-second',
  public.grant_pro_entitlement_days_atomic(
    '10000000-0000-0000-0000-000000000017',
    'referral',
    'concurrent:second',
    20,
    '2020-01-01Z',
    '{"lane":"second"}'::jsonb
  ) ->> 'status';
SQL
wait "$grant_days_first_pid"

psql_cmd <<'SQL'
DO $grant_days_concurrency_proof$
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM public.test_results
    WHERE result_key IN ('grant-days-first', 'grant-days-second')
      AND result_status = 'granted'
  ) <> 2
    OR (
      SELECT pg_catalog.sum(granted_days)
      FROM public.pro_entitlement_grants
      WHERE user_id = '10000000-0000-0000-0000-000000000017'
        AND grant_kind = 'days'
    ) <> 30
    OR (
      SELECT pg_catalog.max(expires_at) - pg_catalog.min(starts_at)
      FROM public.pro_entitlement_grants
      WHERE user_id = '10000000-0000-0000-0000-000000000017'
        AND grant_kind = 'days'
    ) <> interval '30 days'
  THEN
    RAISE EXCEPTION 'concurrent relative grants lost earned days';
  END IF;
END
$grant_days_concurrency_proof$;
SQL

# Historical inverse order must produce a real PostgreSQL deadlock.
psql_cmd <<'SQL'
INSERT INTO public.subscriptions(
  user_id, stripe_customer_id, stripe_subscription_id,
  status, tier, plan, current_period_start, current_period_end
) VALUES (
  '10000000-0000-0000-0000-000000000010',
  'cus_old_order',
  'sub_old_order',
  'active',
  'pro',
  'monthly',
  '2030-01-01Z',
  '2030-02-01Z'
);
SQL

psql_cmd >"$TMP_ROOT/old-order-refund.log" 2>&1 <<'SQL' &
BEGIN;
SET deadlock_timeout = '100ms';
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.set_config(
  'refund_test.pause_before_leave_advisory',
  'on',
  false
);
SELECT public.test_old_order_refund(
  '10000000-0000-0000-0000-000000000010'
) /* old_order_deadlock */;
COMMIT;
SQL
old_order_refund_pid=$!

wait_for_sleep old_order_deadlock

psql_cmd >"$TMP_ROOT/old-order-join.log" 2>&1 <<'SQL' &
SET deadlock_timeout = '100ms';
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.test_join_pro_official_group_atomic(
  '10000000-0000-0000-0000-000000000010'
);
SQL
old_order_join_pid=$!

old_order_refund_status=0
old_order_join_status=0
wait "$old_order_refund_pid" || old_order_refund_status=$?
wait "$old_order_join_pid" || old_order_join_status=$?
if (( old_order_refund_status == 0 && old_order_join_status == 0 )); then
  echo "old inverse lock order unexpectedly completed without deadlock" >&2
  exit 1
fi
if (( old_order_refund_status != 0 && old_order_join_status != 0 )); then
  echo "old inverse lock order aborted both transactions" >&2
  exit 1
fi
if ! grep -q "deadlock detected" \
  "$TMP_ROOT/old-order-refund.log" \
  "$TMP_ROOT/old-order-join.log"; then
  echo "old inverse lock order lacked PostgreSQL deadlock evidence" >&2
  exit 1
fi
echo "historical inverse lock order produced PostgreSQL deadlock as expected"

# Fixed refund owns assignment/user advisory locks before ledger/sub/profile.
# Join waits at advisory rather than forming the inverse cycle.
psql_cmd <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.test_activate_recurring(
  '10000000-0000-0000-0000-000000000011',
  'sub_join_refund',
  'join_refund',
  '2031-01-01Z',
  '2031-02-01Z'
);
SQL

psql_cmd >"$TMP_ROOT/fixed-join-refund.log" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.set_config(
  'refund_test.pause_before_leave_advisory',
  'on',
  false
);
INSERT INTO public.test_results(result_key, result_status)
SELECT
  'fixed-join-refund',
  public.test_refund_recurring(
    '10000000-0000-0000-0000-000000000011',
    'sub_join_refund',
    'join_refund',
    1000,
    'succeeded',
    'active',
    'evt_fixed_join_refund',
    '2031-01-02Z',
    '2031-01-01Z',
    '2031-02-01Z'
  ) ->> 'status';
COMMIT;
SQL
fixed_refund_pid=$!

wait_for_sleep evt_fixed_join_refund

psql_cmd >"$TMP_ROOT/fixed-join.log" 2>&1 <<'SQL' &
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
INSERT INTO public.test_results(result_key, result_status)
SELECT
  'fixed-join',
  public.test_join_pro_official_group_atomic(
    '10000000-0000-0000-0000-000000000011'
  ) ->> 'status';
SQL
fixed_join_pid=$!
wait "$fixed_refund_pid"
wait "$fixed_join_pid"

psql_cmd <<'SQL'
DO $fixed_join_refund_proof$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.test_results
    WHERE result_key = 'fixed-join-refund'
      AND result_status = 'revoked'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.test_results
    WHERE result_key = 'fixed-join'
      AND result_status = 'pro_required'
  ) OR EXISTS (
    SELECT 1 FROM public.test_official_members
    WHERE user_id = '10000000-0000-0000-0000-000000000011'
  ) THEN
    RAISE EXCEPTION 'join/refund advisory-first lock order did not converge';
  END IF;
END
$fixed_join_refund_proof$;
SQL

# Refund first: revoke commits, then a newer paid period activates.
psql_cmd <<'SQL'
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT public.test_activate_recurring(
  '10000000-0000-0000-0000-000000000012',
  'sub_race',
  'race_old',
  '2031-02-01Z',
  '2031-03-01Z'
);
SQL

psql_cmd >"$TMP_ROOT/race-refund-first.log" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
SELECT pg_catalog.set_config('refund_test.pause', 'on', false);
INSERT INTO public.test_results(result_key, result_status)
SELECT
  'race-refund-first',
  public.test_refund_recurring(
    '10000000-0000-0000-0000-000000000012',
    'sub_race',
    'race_old',
    1000,
    'succeeded',
    'active',
    'evt_race_refund_first',
    '2031-02-02Z',
    '2031-02-01Z',
    '2031-03-01Z'
  ) ->> 'status';
COMMIT;
SQL
race_refund_pid=$!

wait_for_sleep evt_race_refund_first

psql_cmd >"$TMP_ROOT/race-activation-after.log" 2>&1 <<'SQL' &
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
INSERT INTO public.test_results(result_key, result_status)
SELECT
  'race-activation-after',
  public.test_activate_recurring(
    '10000000-0000-0000-0000-000000000012',
    'sub_race',
    'race_new',
    '2031-03-01Z',
    '2031-04-01Z'
  ) ->> 'status';
SQL
race_activation_pid=$!
wait "$race_refund_pid"
wait "$race_activation_pid"

# Activation first: old refund waits, then records its old ledger tombstone and
# returns not_current without changing the newer binding.
psql_cmd >"$TMP_ROOT/race-activation-first.log" 2>&1 <<'SQL' &
BEGIN;
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
INSERT INTO public.test_results(result_key, result_status)
SELECT
  'race-activation-first',
  public.test_activate_recurring(
    '10000000-0000-0000-0000-000000000012',
    'sub_race',
    'race_newest',
    '2031-04-01Z',
    '2031-05-01Z'
  ) ->> 'status';
SELECT pg_catalog.pg_sleep(1) /* race_activation_first_pause */;
COMMIT;
SQL
race_activation_first_pid=$!

wait_for_sleep race_activation_first_pause

psql_cmd >"$TMP_ROOT/race-old-refund-after.log" 2>&1 <<'SQL' &
SELECT pg_catalog.set_config('request.jwt.claim.role', 'service_role', false);
INSERT INTO public.test_results(result_key, result_status)
SELECT
  'race-old-refund-after',
  public.test_refund_recurring(
    '10000000-0000-0000-0000-000000000012',
    'sub_race',
    'race_new',
    1000,
    'succeeded',
    'active',
    'evt_race_old_after',
    '2031-04-02Z',
    '2031-03-01Z',
    '2031-04-01Z'
  ) ->> 'status';
SQL
race_old_refund_pid=$!
wait "$race_activation_first_pid"
wait "$race_old_refund_pid"

psql_cmd <<'SQL'
DO $predeploy_concurrency_and_acl_proof$
DECLARE
  v_postgres oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
  v_service oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.test_results
    WHERE result_key = 'race-refund-first'
      AND result_status = 'revoked'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.test_results
    WHERE result_key = 'race-activation-after'
      AND result_status = 'activated'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.test_results
    WHERE result_key = 'race-activation-first'
      AND result_status = 'activated'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.test_results
    WHERE result_key = 'race-old-refund-after'
      AND result_status = 'not_current'
  ) OR NOT EXISTS (
    SELECT 1
    FROM public.subscriptions AS subscription
    JOIN public.stripe_entitlement_payments AS payment
      ON payment.id = subscription.entitlement_payment_id
    WHERE subscription.user_id =
        '10000000-0000-0000-0000-000000000012'
      AND subscription.status = 'active'
      AND payment.stripe_invoice_id = 'in_race_newest'
  ) THEN
    RAISE EXCEPTION
      'activation/refund two-order concurrency did not converge';
  END IF;

  IF pg_catalog.has_function_privilege(
    'authenticated',
    'public.record_charge_refund_tombstone_atomic(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.record_charge_refund_tombstone_atomic(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    'public.stripe_merge_charge_refund_tombstone_v2(uuid)',
    'EXECUTE'
  ) OR pg_catalog.has_table_privilege(
    'authenticated',
    'public.stripe_charge_refund_tombstones',
    'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'service_role',
    'public.stripe_charge_refund_tombstones',
    'INSERT,UPDATE,DELETE'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role',
    'public.stripe_charge_refund_tombstones',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'direct Charge tombstone ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation_row.relacl,
        pg_catalog.acldefault('r', relation_row.relowner)
      )
    ) AS acl_row
    WHERE relation_row.oid IN (
      'public.stripe_charge_refund_tombstones'::pg_catalog.regclass,
      'public.stripe_charge_refund_tombstone_events'::pg_catalog.regclass
    )
      AND acl_row.grantee NOT IN (v_postgres, v_service)
  ) THEN
    RAISE EXCEPTION 'tombstone relation has an unknown ACL grantee';
  END IF;
END
$predeploy_concurrency_and_acl_proof$;
SQL

if [[ -n "$EXTRA_PROOF_SQLS" ]]; then
  IFS=':' read -r -a extra_proof_paths <<< "$EXTRA_PROOF_SQLS"
  for extra_proof in "${extra_proof_paths[@]}"; do
    if [[ ! -r "$extra_proof" ]]; then
      echo "Extra Stripe entitlement proof is unreadable: $extra_proof" >&2
      exit 1
    fi
    psql_cmd -f "$extra_proof"
  done
fi

echo "atomic Stripe payment-period authority PREDEPLOY PostgreSQL 17 proof passed"
