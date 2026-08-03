#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MIGRATION="$ROOT_DIR/supabase/migrations/20260729080000_api_tier_recovery_payment_authority.sql"
PG_BIN="${PG17_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
for executable in initdb pg_ctl psql; do
  [[ -x "$PG_BIN/$executable" ]] || {
    echo "PostgreSQL 17 executable not found: $PG_BIN/$executable" >&2
    exit 1
  }
done

TMP_ROOT="$(mktemp -d /tmp/api-tier-recovery-payment-pg17.XXXXXX)"
DATA_DIR="$TMP_ROOT/data"
SOCKET_DIR="$TMP_ROOT/socket"
LOG_FILE="$TMP_ROOT/postgres.log"
PORT=55580
mkdir -p "$SOCKET_DIR"
cleanup() {
  local code=$?
  if [[ -s "$DATA_DIR/postmaster.pid" ]]; then
    "$PG_BIN/pg_ctl" -D "$DATA_DIR" -m immediate -w stop >/dev/null 2>&1 || true
  fi
  if ((code != 0)); then
    [[ -f "$LOG_FILE" ]] && tail -240 "$LOG_FILE" >&2 || true
  fi
  rm -rf "$TMP_ROOT"
  exit "$code"
}
trap cleanup EXIT
psql_cmd() {
  "$PG_BIN/psql" -X -v ON_ERROR_STOP=1 -h "$SOCKET_DIR" -p "$PORT" -d postgres "$@"
}
expect_failure() {
  if psql_cmd -Atqc "$1" >/dev/null 2>&1; then
    echo "Expected failure: $2" >&2
    return 1
  fi
}

"$PG_BIN/initdb" -D "$DATA_DIR" --auth-local=trust --auth-host=trust \
  --encoding=UTF8 --no-locale >/dev/null
"$PG_BIN/pg_ctl" -D "$DATA_DIR" -l "$LOG_FILE" \
  -o "-F -p $PORT -k $SOCKET_DIR -c listen_addresses=" -w start >/dev/null

psql_cmd <<'SQL'
CREATE ROLE postgres NOLOGIN SUPERUSER;
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN NOBYPASSRLS;
CREATE ROLE authenticator NOLOGIN NOINHERIT;
CREATE ROLE hostile_role NOLOGIN;
CREATE SCHEMA auth AUTHORIZATION postgres;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.role', true), '')
$$;

CREATE TABLE public.user_profiles (
  id uuid PRIMARY KEY, api_tier text NOT NULL DEFAULT 'free',
  api_stripe_subscription_id text, stripe_customer_id text,
  deleted_at timestamptz, deletion_scheduled_at timestamptz,
  banned_at timestamptz, is_banned boolean NOT NULL DEFAULT false,
  ban_expires_at timestamptz, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  tier text NOT NULL DEFAULT 'free', daily_limit integer NOT NULL DEFAULT 100,
  active boolean NOT NULL DEFAULT true, revoked_at timestamptz
);
CREATE TABLE public.account_recovery_admissions (
  operation_id uuid PRIMARY KEY, user_id uuid NOT NULL, state text NOT NULL,
  claimed_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  auth_finalization_state text, auth_finalized_at timestamptz,
  recovery_billing_v2_result jsonb,
  recovery_billing_completed_at timestamptz
);
CREATE TABLE public.api_tier_checkout_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
  livemode boolean NOT NULL, stripe_customer_id text NOT NULL,
  api_plan text NOT NULL, stripe_price_id text NOT NULL, status text NOT NULL,
  checkout_expires_at bigint NOT NULL, lease_expires_at timestamptz NOT NULL,
  checkout_session_id text, stripe_subscription_id text, release_reason text,
  release_event_id text, release_event_created bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), released_at timestamptz,
  CONSTRAINT api_tier_checkout_reservations_state_check CHECK (
    (status='reserved' AND checkout_session_id IS NULL AND stripe_subscription_id IS NULL
      AND release_reason IS NULL AND release_event_id IS NULL
      AND release_event_created IS NULL AND released_at IS NULL)
    OR (status='bound' AND checkout_session_id IS NOT NULL AND stripe_subscription_id IS NULL
      AND release_reason IS NULL AND release_event_id IS NULL
      AND release_event_created IS NULL AND released_at IS NULL)
    OR (status='converted' AND checkout_session_id IS NOT NULL
      AND stripe_subscription_id IS NOT NULL AND release_reason IS NULL
      AND release_event_id IS NULL AND release_event_created IS NULL
      AND released_at IS NULL)
    OR (status='released' AND checkout_session_id IS NOT NULL
      AND stripe_subscription_id IS NULL AND release_reason='checkout_session_expired'
      AND release_event_id IS NOT NULL AND release_event_created IS NOT NULL
      AND released_at IS NOT NULL)
    OR (status='expired' AND checkout_session_id IS NULL
      AND stripe_subscription_id IS NULL AND release_reason='lease_expired'
      AND release_event_id IS NULL AND release_event_created IS NULL
      AND released_at IS NOT NULL)
  )
);
CREATE TABLE public.api_tier_stripe_event_ledger (
  livemode boolean NOT NULL, stripe_event_id text NOT NULL, user_id uuid NOT NULL,
  metadata_user_id uuid NOT NULL, metadata_supabase_user_id uuid NOT NULL,
  stripe_customer_id text NOT NULL, checkout_reservation_id uuid,
  stripe_price_id text NOT NULL, stripe_subscription_id text NOT NULL,
  subscription_created bigint NOT NULL, stripe_event_created bigint NOT NULL,
  api_tier text NOT NULL, daily_limit integer NOT NULL, is_active boolean NOT NULL,
  is_terminal boolean NOT NULL, identity_source text NOT NULL,
  PRIMARY KEY(livemode,stripe_event_id)
);
CREATE TABLE public.api_tier_subscription_blocks (
  livemode boolean NOT NULL, stripe_subscription_id text NOT NULL,
  block_kind text NOT NULL, user_id uuid NOT NULL, stripe_customer_id text,
  blocked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(livemode,stripe_subscription_id,block_kind),
  CONSTRAINT api_tier_subscription_blocks_kind_check CHECK (
    block_kind IN ('account_deletion','financial_reversal')
  )
);
CREATE TABLE public.stripe_entitlement_payments(id uuid PRIMARY KEY);
CREATE TABLE public.tips(id uuid PRIMARY KEY);
CREATE TABLE public.group_payment_consumptions(id uuid PRIMARY KEY);
CREATE TABLE public.stripe_payment_ownerships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_kind text NOT NULL,
  ledger_id uuid NOT NULL, owner_user_id uuid, stripe_customer_id text NOT NULL,
  stripe_payment_intent_id text, stripe_charge_id text NOT NULL,
  checkout_session_id text, amount_paid bigint NOT NULL, currency text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT stripe_payment_ownerships_product_kind_check CHECK (
    product_kind IN ('pro_entitlement','tip','group_pass')
  ),
  UNIQUE(product_kind,ledger_id), UNIQUE(stripe_charge_id)
);
CREATE UNIQUE INDEX stripe_payment_ownerships_pi_key
  ON public.stripe_payment_ownerships(stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX stripe_payment_ownerships_session_key
  ON public.stripe_payment_ownerships(checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;
CREATE TABLE public.stripe_entitlement_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entitlement_payment_id uuid,
  user_id uuid, source_kind text NOT NULL, source_key text NOT NULL,
  operation_key text NOT NULL, effect_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending', attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT clock_timestamp(), lease_token uuid,
  lease_expires_at timestamptz, external_ref text, payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
  dispatch_committed_at timestamptz,
  CONSTRAINT stripe_entitlement_effects_source_check CHECK (
    source_kind IN ('payment','trial','projection','tip_payment','group_payment','api_payment')
  ),
  UNIQUE(source_kind,source_key,effect_type,operation_key)
);
CREATE TABLE public.stripe_charge_refund_tombstones (
  stripe_charge_id text PRIMARY KEY, stripe_customer_id text NOT NULL,
  stripe_payment_intent_id text, captured boolean NOT NULL, amount_paid bigint NOT NULL,
  currency text NOT NULL, refund_succeeded_amount bigint NOT NULL,
  refund_state text NOT NULL, latest_refund_event_id text NOT NULL,
  latest_refund_event_created_at timestamptz NOT NULL,
  refund_snapshot_event_id text NOT NULL,
  refund_snapshot_event_created_at timestamptz NOT NULL,
  merged_payment_id uuid, resolution_kind text NOT NULL DEFAULT 'unclassified',
  resolution_reference text, resolution_ownership_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.stripe_charge_refund_tombstone_events (
  event_id text PRIMARY KEY, stripe_charge_id text NOT NULL,
  refund_state text NOT NULL, refund_succeeded_amount bigint NOT NULL,
  event_created_at timestamptz NOT NULL, observations jsonb NOT NULL
);

CREATE FUNCTION public.classify_recurring_invoice_product_authority_atomic(
  boolean,text,text,text,text,text
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT '{"status":"not_found"}'::jsonb $$;
CREATE FUNCTION public.classify_recurring_subscription_product_authority_atomic(
  boolean,text,text,text,text
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT '{"status":"not_found"}'::jsonb $$;
CREATE FUNCTION public.account_recovery_billing_surface_is_blocked_v2(uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.account_recovery_admissions a
    WHERE a.user_id=$1 AND a.state IN ('claimed','finished')
      AND COALESCE(a.auth_finalization_state NOT IN ('completed','superseded'),true)
  )
$$;
CREATE FUNCTION public.locate_account_recovery_payment_lifecycle_v2(
  uuid,timestamptz,timestamptz
) RETURNS TABLE(
  operation_id uuid,lifecycle_kind text,recovery_claimed_at timestamptz,
  recovery_billing_completed_at timestamptz
) LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT a.operation_id,
    CASE
      WHEN a.recovery_billing_completed_at IS NOT NULL THEN 'completed_window'
      WHEN a.state='finished' AND a.auth_finalization_state='expired_manual'
        THEN 'legacy_manual'
      ELSE 'active'
    END,
    a.claimed_at,a.recovery_billing_completed_at
  FROM public.account_recovery_admissions a
  WHERE a.user_id=$1 AND a.state IN ('claimed','finished') AND (
    COALESCE(a.auth_finalization_state NOT IN ('completed','superseded'),true)
    OR (
      a.recovery_billing_completed_at IS NOT NULL
      AND a.claimed_at<=$3 AND $2<=a.recovery_billing_completed_at
    )
    OR (
      a.recovery_billing_completed_at IS NULL
      AND a.auth_finalization_state IS DISTINCT FROM 'superseded'
      AND a.claimed_at<=$3 AND $2<=a.updated_at
    )
  )
  ORDER BY CASE
    WHEN a.state='claimed' THEN 0
    WHEN a.recovery_billing_completed_at IS NOT NULL THEN 1
    ELSE 2
  END,a.recovery_billing_completed_at DESC NULLS LAST,
  a.claimed_at DESC,a.operation_id DESC
  LIMIT 1
$$;
CREATE FUNCTION public.account_recovery_payment_lifecycle_is_blocked_v2(
  uuid,timestamptz,timestamptz
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR $3<$2 OR EXISTS (
    SELECT 1 FROM public.locate_account_recovery_payment_lifecycle_v2($1,$2,$3)
  )
$$;
CREATE FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT false $$;
CREATE FUNCTION public.stripe_entitlement_effect_is_current_v2(uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT true $$;
CREATE FUNCTION public.claim_stripe_subscription_cancel_dispatch_atomic(
  uuid,uuid,boolean
) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER AS $$
  SELECT '{"status":"not_found"}'::jsonb
$$;
CREATE FUNCTION public.stripe_refund_tombstone_is_resolved_v2(text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT false $$;
CREATE FUNCTION public.apply_user_api_tier_stripe_event(
  uuid,uuid,uuid,text,uuid,text,text,integer,text,bigint,text,bigint,
  boolean,boolean,boolean,text,text,text,text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF $13 THEN
    UPDATE public.user_profiles SET api_tier=$7,
      api_stripe_subscription_id=$9,updated_at=clock_timestamp() WHERE id=$1;
    UPDATE public.api_keys SET tier=$7,daily_limit=$8 WHERE user_id=$1 AND active;
  ELSE
    UPDATE public.user_profiles SET api_tier='free',
      api_stripe_subscription_id=NULL,updated_at=clock_timestamp() WHERE id=$1;
    UPDATE public.api_keys SET tier='free',daily_limit=100 WHERE user_id=$1 AND active;
  END IF;
  RETURN 'applied';
END $$;
CREATE FUNCTION public.record_charge_refund_tombstone_atomic(
  uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamptz
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER AS $$ SELECT '{"status":"recorded"}'::jsonb $$;
CREATE FUNCTION public.record_charge_refund_tombstone_financial_legacy_v2(
  p_user uuid,p_customer text,p_pi text,p_charge text,p_captured boolean,
  p_amount bigint,p_currency text,p_refunded bigint,p_state text,p_event text,
  p_created timestamptz
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.stripe_charge_refund_tombstones(
    stripe_charge_id,stripe_customer_id,stripe_payment_intent_id,captured,
    amount_paid,currency,refund_succeeded_amount,refund_state,
    latest_refund_event_id,latest_refund_event_created_at,
    refund_snapshot_event_id,refund_snapshot_event_created_at
  ) VALUES (p_charge,p_customer,p_pi,p_captured,p_amount,p_currency,p_refunded,
    p_state,p_event,p_created,p_event,p_created)
  ON CONFLICT(stripe_charge_id) DO UPDATE SET
    refund_succeeded_amount=excluded.refund_succeeded_amount,
    refund_state=excluded.refund_state,latest_refund_event_id=excluded.latest_refund_event_id,
    latest_refund_event_created_at=excluded.latest_refund_event_created_at,
    refund_snapshot_event_id=excluded.refund_snapshot_event_id,
    refund_snapshot_event_created_at=excluded.refund_snapshot_event_created_at;
  INSERT INTO public.stripe_charge_refund_tombstone_events VALUES(
    p_event,p_charge,p_state,p_refunded,p_created,
    jsonb_build_array(jsonb_build_object('refund_state',p_state,
      'refund_succeeded_amount',p_refunded))) ON CONFLICT(event_id) DO NOTHING;
  RETURN jsonb_build_object('status','recorded');
END $$;

ALTER TABLE public.user_profiles OWNER TO postgres;
ALTER TABLE public.api_keys OWNER TO postgres;
ALTER TABLE public.account_recovery_admissions OWNER TO postgres;
ALTER TABLE public.api_tier_checkout_reservations OWNER TO postgres;
ALTER TABLE public.api_tier_stripe_event_ledger OWNER TO postgres;
ALTER TABLE public.api_tier_subscription_blocks OWNER TO postgres;
ALTER TABLE public.stripe_entitlement_payments OWNER TO postgres;
ALTER TABLE public.tips OWNER TO postgres;
ALTER TABLE public.group_payment_consumptions OWNER TO postgres;
ALTER TABLE public.stripe_payment_ownerships OWNER TO postgres;
ALTER TABLE public.stripe_entitlement_effects OWNER TO postgres;
ALTER TABLE public.stripe_charge_refund_tombstones OWNER TO postgres;
ALTER TABLE public.stripe_charge_refund_tombstone_events OWNER TO postgres;
SQL

psql_cmd -f "$MIGRATION" >/dev/null

psql_cmd <<'SQL'
SELECT set_config('request.jwt.claim.role','service_role',false);

-- before/before: Checkout and payment both precede recovery, so late delivery
-- must not be blocked merely because its webhook arrives after completion.
INSERT INTO public.user_profiles(id,stripe_customer_id) VALUES
  ('00000000-0000-4000-8000-000000000001','cus_before');
INSERT INTO public.api_keys(user_id) VALUES ('00000000-0000-4000-8000-000000000001');
INSERT INTO public.api_tier_checkout_reservations(
  id,user_id,livemode,stripe_customer_id,api_plan,stripe_price_id,status,
  checkout_expires_at,lease_expires_at,checkout_session_id,created_at,updated_at,bound_at
) VALUES (
  '10000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',
  false,'cus_before','starter','price_rotated_old','bound',2000000000,
  '2026-01-01 00:30:00+00','cs_before','2026-01-01 00:00:00+00',
  '2026-01-01 00:01:00+00','2026-01-01 00:01:00+00'
);
INSERT INTO public.account_recovery_admissions VALUES(
  '20000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',
  'finished','2026-01-01 00:10:00+00','2026-01-01 00:20:00+00','completed',
  '2026-01-01 00:15:00+00','{"status":"completed_manual"}',
  '2026-01-01 00:20:00+00'
);
DO $$
DECLARE v jsonb;
BEGIN
  v:=public.apply_api_tier_paid_invoice_event_atomic(
    'evt_before','2026-01-01 00:25:00+00','invoice.paid',false,
    '00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000001','cus_before',
    '10000000-0000-4000-8000-000000000001','cs_before','2026-01-01 00:00:30+00',
    'sub_before',1767225600,'active','in_before','inpay_before','pi_before','ch_before',
    'price_rotated_old','starter',4900,'usd','2026-01-01 00:00:00+00',
    '2026-02-01 00:00:00+00','2026-01-01 00:00:40+00',
    '2026-01-01 00:05:00+00');
  IF v->>'status'<>'applied' THEN
    RAISE EXCEPTION 'rotated historical Price was not located from its signed Session: %',v;
  END IF;
END $$;

-- before/during and late-first after completed must remain terminal blocked.
INSERT INTO public.user_profiles(id,stripe_customer_id) VALUES
  ('00000000-0000-4000-8000-000000000002','cus_blocked');
INSERT INTO public.api_keys(user_id) VALUES ('00000000-0000-4000-8000-000000000002');
INSERT INTO public.api_tier_checkout_reservations(
  id,user_id,livemode,stripe_customer_id,api_plan,stripe_price_id,status,
  checkout_expires_at,lease_expires_at,checkout_session_id,created_at,updated_at,bound_at
) VALUES (
  '10000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002',
  false,'cus_blocked','pro','price_old_pro','bound',2000000000,
  '2026-01-01 01:30:00+00','cs_blocked','2026-01-01 01:00:00+00',
  '2026-01-01 01:01:00+00','2026-01-01 01:01:00+00'
);
INSERT INTO public.account_recovery_admissions VALUES(
  '20000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002',
  'finished','2026-01-01 01:10:00+00','2026-01-01 01:20:00+00','completed',
  '2026-01-01 01:15:00+00','{"status":"completed_manual"}',
  '2026-01-01 01:20:00+00'
);
DO $$
DECLARE v text;
BEGIN
  v:=public.apply_user_api_tier_stripe_event(
    '00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000002','cus_blocked',
    '10000000-0000-4000-8000-000000000002','price_old_pro','pro',0,
    'sub_blocked',1767229200,'evt_sub_during',1767229920,true,false,false,
    'cs_blocked','pro','price_old_pro','signed_metadata');
  IF v<>'account_recovery_billing_blocked' THEN
    RAISE EXCEPTION 'late recovery-period active event was not durably blocked: %',v;
  END IF;
  IF public.apply_user_api_tier_stripe_event(
    '00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000002','cus_blocked',
    '10000000-0000-4000-8000-000000000002','price_old_pro','pro',0,
    'sub_blocked',1767229200,'evt_sub_during',1767229920,true,false,false,
    'cs_blocked','pro','price_old_pro','signed_metadata')<>v THEN
    RAISE EXCEPTION 'recovery-period active event replay diverged';
  END IF;
END $$;
DO $$
DECLARE v jsonb;
BEGIN
  v:=public.apply_api_tier_paid_invoice_event_atomic(
    'evt_blocked','2026-01-01 01:30:00+00','invoice.paid',false,
    '00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000002','cus_blocked',
    '10000000-0000-4000-8000-000000000002','cs_blocked','2026-01-01 01:00:30+00',
    'sub_blocked',1767229200,'active','in_blocked','inpay_blocked','pi_blocked','ch_blocked',
    'price_old_pro','pro',19900,'usd','2026-01-01 01:00:00+00',
    '2026-02-01 01:00:00+00','2026-01-01 01:05:00+00',
    '2026-01-01 01:12:00+00');
  IF v->>'status'<>'account_recovery_billing_blocked' THEN
    RAISE EXCEPTION 'completed recovery was bypassed by a late first paid delivery: %',v;
  END IF;
  IF (SELECT count(*) FROM public.stripe_entitlement_effects
      WHERE source_key=v->>'payment_id')<>2 THEN
    RAISE EXCEPTION 'blocked payment did not queue exactly two effects';
  END IF;
END $$;

DO $$
DECLARE
  v_effect uuid;
  v_lease uuid := '30000000-0000-4000-8000-000000000002';
  v jsonb;
BEGIN
  SELECT effect.id INTO v_effect
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.source_kind='api_payment'
    AND effect.effect_type='stripe_subscription_cancel';
  UPDATE public.stripe_entitlement_effects
  SET status='processing',lease_token=v_lease,
      lease_expires_at=clock_timestamp()+interval '5 minutes'
  WHERE id=v_effect;
  v:=public.claim_stripe_subscription_cancel_dispatch_atomic(
    v_effect,v_lease,true
  );
  IF v->>'status'<>'lease_lost' OR EXISTS(
    SELECT 1 FROM public.stripe_entitlement_effects
    WHERE id=v_effect AND dispatch_committed_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'wrong-mode API cancellation claim crossed dispatch fence: %',v;
  END IF;
  v:=public.claim_stripe_subscription_cancel_dispatch_atomic(
    v_effect,v_lease,false
  );
  IF v IS DISTINCT FROM jsonb_build_object(
    'status','dispatch_committed','product_kind','api_tier',
    'user_id','00000000-0000-4000-8000-000000000002'::uuid,
    'livemode',false,'stripe_customer_id','cus_blocked',
    'stripe_subscription_id','sub_blocked'
  ) THEN
    RAISE EXCEPTION 'generic API cancellation hook returned a non-exact ACK: %',v;
  END IF;
  v:=public.claim_stripe_subscription_cancel_dispatch_atomic(
    v_effect,v_lease,false
  );
  IF v->>'status'<>'already_dispatch_committed' THEN
    RAISE EXCEPTION 'API cancellation dispatch replay diverged: %',v;
  END IF;
END $$;

DO $$
BEGIN
  IF public.account_recovery_payment_lifecycle_is_blocked_v2(
    '00000000-0000-4000-8000-000000000002',
    '2026-01-01 01:11:00+00','2026-01-01 01:12:00+00'
  ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'during/during lifecycle did not block';
  END IF;
  IF public.account_recovery_payment_lifecycle_is_blocked_v2(
    '00000000-0000-4000-8000-000000000002',
    '2026-01-01 01:21:00+00','2026-01-01 01:22:00+00'
  ) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'after-completed lifecycle was incorrectly blocked';
  END IF;
  IF public.account_recovery_payment_lifecycle_is_blocked_v2(
    '00000000-0000-4000-8000-000000000002',
    '2026-01-01 01:20:00+00','2026-01-01 01:20:00+00'
  ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'same-second recovery boundary did not fail closed';
  END IF;
END $$;

-- A later deletion preparation may supersede/release current recovery state,
-- but it cannot erase the immutable completed lifecycle window. An old-window
-- payment first delivered afterwards must retain the exact recovery operation.
INSERT INTO public.user_profiles(id,stripe_customer_id) VALUES
  ('00000000-0000-4000-8000-000000000005','cus_superseded');
INSERT INTO public.api_keys(user_id) VALUES ('00000000-0000-4000-8000-000000000005');
INSERT INTO public.api_tier_checkout_reservations(
  id,user_id,livemode,stripe_customer_id,api_plan,stripe_price_id,status,
  checkout_expires_at,lease_expires_at,checkout_session_id,created_at,updated_at,bound_at
) VALUES (
  '10000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000005',
  false,'cus_superseded','starter','price_superseded','bound',2000000000,
  '2026-05-01 00:30:00+00','cs_superseded','2026-05-01 00:00:00+00',
  '2026-05-01 00:01:00+00','2026-05-01 00:01:00+00'
);
INSERT INTO public.account_recovery_admissions VALUES(
  '20000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000005',
  'finished','2026-05-01 00:10:00+00','2026-05-01 00:20:00+00','completed',
  '2026-05-01 00:15:00+00','{"status":"completed_manual"}',
  '2026-05-01 00:20:00+00'
);
UPDATE public.account_recovery_admissions
SET auth_finalization_state='superseded',updated_at='2026-05-01 00:40:00+00'
WHERE operation_id='20000000-0000-4000-8000-000000000005';
DO $$
DECLARE
  v jsonb;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.locate_account_recovery_payment_lifecycle_v2(
      '00000000-0000-4000-8000-000000000005',
      '2026-05-01 00:00:00+00','2026-05-01 00:12:00+00'
    ) AS lifecycle
    WHERE lifecycle.operation_id='20000000-0000-4000-8000-000000000005'
      AND lifecycle.lifecycle_kind='completed_window'
  ) THEN
    RAISE EXCEPTION 'superseded recovery lost its immutable lifecycle locator';
  END IF;
  v:=public.apply_api_tier_paid_invoice_event_atomic(
    'evt_superseded_late','2026-05-01 00:50:00+00','invoice.paid',false,
    '00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000005',
    '00000000-0000-4000-8000-000000000005','cus_superseded',
    '10000000-0000-4000-8000-000000000005','cs_superseded','2026-05-01 00:00:30+00',
    'sub_superseded',1777593600,'active','in_superseded','inpay_superseded',
    'pi_superseded','ch_superseded','price_superseded','starter',4900,'usd',
    '2026-05-01 00:00:00+00','2026-06-01 00:00:00+00',
    '2026-05-01 00:05:00+00','2026-05-01 00:12:00+00');
  IF v->>'status'<>'account_recovery_billing_blocked'
    OR v->>'recovery_operation_id'<>'20000000-0000-4000-8000-000000000005'
    OR (SELECT count(*) FROM public.stripe_entitlement_effects
        WHERE source_key=v->>'payment_id')<>2 THEN
    RAISE EXCEPTION 'superseded recovery late-first payment escaped: %',v;
  END IF;
END $$;

-- after/completed: a genuinely new Checkout and payment created after recovery
-- must be allowed, and the public active path must still require that exact paid
-- authority before it grants quota.
INSERT INTO public.user_profiles(id,stripe_customer_id) VALUES
  ('00000000-0000-4000-8000-000000000004','cus_after');
INSERT INTO public.api_keys(user_id) VALUES ('00000000-0000-4000-8000-000000000004');
INSERT INTO public.account_recovery_admissions VALUES(
  '20000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000004',
  'finished','2026-04-01 00:10:00+00','2026-04-01 00:20:00+00','completed',
  '2026-04-01 00:15:00+00','{"status":"completed_manual"}',
  '2026-04-01 00:20:00+00'
);
INSERT INTO public.api_tier_checkout_reservations(
  id,user_id,livemode,stripe_customer_id,api_plan,stripe_price_id,status,
  checkout_expires_at,lease_expires_at,checkout_session_id,created_at,updated_at,bound_at
) VALUES (
  '10000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000004',
  false,'cus_after','starter','price_after','bound',2000000000,
  '2026-04-01 00:50:00+00','cs_after','2026-04-01 00:21:00+00',
  '2026-04-01 00:22:00+00','2026-04-01 00:22:00+00'
);
DO $$
DECLARE
  v_status text;
BEGIN
  FOREACH v_status IN ARRAY ARRAY['past_due', ' ACTIVE '] LOOP
    BEGIN
      PERFORM public.apply_api_tier_paid_invoice_event_atomic(
        'evt_after_invalid','2026-04-01 00:24:00+00','invoice.paid',false,
        '00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000004',
        '00000000-0000-4000-8000-000000000004','cus_after',
        '10000000-0000-4000-8000-000000000004','cs_after','2026-04-01 00:21:30+00',
        'sub_after',1775002920,v_status,'in_after_invalid','inpay_after_invalid',
        'pi_after_invalid','ch_after_invalid','price_after','starter',4900,'usd',
        '2026-04-01 00:22:00+00','2026-05-01 00:22:00+00',
        '2026-04-01 00:22:30+00','2026-04-01 00:23:00+00');
      RAISE EXCEPTION 'non-active Subscription status was accepted: %',v_status;
    EXCEPTION WHEN SQLSTATE '22023' THEN
      NULL;
    END;
  END LOOP;
  IF EXISTS (
    SELECT 1 FROM public.stripe_api_tier_invoice_payments
    WHERE checkout_reservation_id='10000000-0000-4000-8000-000000000004'
  ) OR EXISTS (
    SELECT 1 FROM public.user_profiles
    WHERE id='00000000-0000-4000-8000-000000000004' AND api_tier<>'free'
  ) THEN
    RAISE EXCEPTION 'rejected Subscription status mutated paid authority';
  END IF;
END $$;
DO $$
DECLARE
  v_paid jsonb;
  v_active text;
BEGIN
  v_paid:=public.apply_api_tier_paid_invoice_event_atomic(
    'evt_after_paid','2026-04-01 00:24:00+00','invoice.paid',false,
    '00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000004','cus_after',
    '10000000-0000-4000-8000-000000000004','cs_after','2026-04-01 00:21:30+00',
    'sub_after',1775002920,'active','in_after','inpay_after','pi_after','ch_after',
    'price_after','starter',4900,'usd','2026-04-01 00:22:00+00',
    '2026-05-01 00:22:00+00','2026-04-01 00:22:30+00',
    '2026-04-01 00:23:00+00');
  IF v_paid->>'status'<>'applied' THEN
    RAISE EXCEPTION 'post-recovery payment was incorrectly blocked: %',v_paid;
  END IF;
  v_active:=public.apply_user_api_tier_stripe_event(
    '00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000004',
    '00000000-0000-4000-8000-000000000004','cus_after',
    '10000000-0000-4000-8000-000000000004','price_after','starter',10000,
    'sub_after',1775002920,'evt_after_active',1775003100,true,false,false,
    'cs_after','starter','price_after','signed_metadata');
  IF v_active<>'applied' OR (SELECT api_tier FROM public.user_profiles
    WHERE id='00000000-0000-4000-8000-000000000004')<>'starter' THEN
    RAISE EXCEPTION 'post-recovery exact paid authority did not grant: %',v_active;
  END IF;
END $$;

-- A Subscription event is durable but cannot grant until the paid authority.
INSERT INTO public.user_profiles(id,stripe_customer_id) VALUES
  ('00000000-0000-4000-8000-000000000003','cus_pending');
INSERT INTO public.api_keys(user_id) VALUES ('00000000-0000-4000-8000-000000000003');
INSERT INTO public.api_tier_checkout_reservations(
  id,user_id,livemode,stripe_customer_id,api_plan,stripe_price_id,status,
  checkout_expires_at,lease_expires_at,checkout_session_id,created_at,updated_at,bound_at
) VALUES (
  '10000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000003',
  false,'cus_pending','starter','price_pending','bound',2000000000,
  '2026-03-01 00:30:00+00','cs_pending','2026-03-01 00:00:00+00',
  '2026-03-01 00:01:00+00','2026-03-01 00:01:00+00'
);
DO $$
DECLARE v text;
BEGIN
  v:=public.apply_user_api_tier_stripe_event(
    '00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000003',
    '00000000-0000-4000-8000-000000000003','cus_pending',
    '10000000-0000-4000-8000-000000000003','price_pending','starter',10000,
    'sub_pending',1772323200,'evt_sub_pending',1772323260,true,false,false,
    'cs_pending','starter','price_pending','signed_metadata');
  IF v<>'payment_pending' OR (SELECT api_tier FROM public.user_profiles
    WHERE id='00000000-0000-4000-8000-000000000003')<>'free' THEN
    RAISE EXCEPTION 'subscription-first event granted before payment authority';
  END IF;
END $$;

-- A finished admission whose billing finalization is still pending remains an
-- active surface block and must resolve to its exact operation, not merely a
-- boolean gate.
INSERT INTO public.user_profiles(id,stripe_customer_id) VALUES
  ('00000000-0000-4000-8000-000000000006','cus_active_recovery');
INSERT INTO public.api_keys(user_id) VALUES ('00000000-0000-4000-8000-000000000006');
INSERT INTO public.account_recovery_admissions VALUES(
  '20000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000006',
  'finished','2026-06-01 00:10:00+00','2026-06-01 00:11:00+00','billing_pending',
  '2026-06-01 00:11:00+00',NULL,NULL
);
INSERT INTO public.api_tier_checkout_reservations(
  id,user_id,livemode,stripe_customer_id,api_plan,stripe_price_id,status,
  checkout_expires_at,lease_expires_at,checkout_session_id,created_at,updated_at,bound_at
) VALUES (
  '10000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000006',
  false,'cus_active_recovery','starter','price_active_recovery','bound',2000000000,
  '2026-06-01 00:30:00+00','cs_active_recovery','2026-06-01 00:00:00+00',
  '2026-06-01 00:01:00+00','2026-06-01 00:01:00+00'
);
DO $$
DECLARE v text;
BEGIN
  v:=public.apply_user_api_tier_stripe_event(
    '00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000006',
    '00000000-0000-4000-8000-000000000006','cus_active_recovery',
    '10000000-0000-4000-8000-000000000006','price_active_recovery','starter',10000,
    'sub_active_recovery',1780272000,'evt_active_recovery',1780272720,
    true,false,false,'cs_active_recovery','starter','price_active_recovery',
    'signed_metadata');
  IF v<>'account_recovery_billing_blocked' OR NOT EXISTS (
    SELECT 1 FROM public.stripe_api_tier_pending_subscription_events
    WHERE livemode=false AND stripe_event_id='evt_active_recovery'
      AND recovery_operation_id='20000000-0000-4000-8000-000000000006'
  ) THEN
    RAISE EXCEPTION 'current recovery surface lost its exact admission: %',v;
  END IF;
END $$;

-- Full refund routes through API ownership, blocks the exact Subscription,
-- and produces the strict application acknowledgement.
DO $$
DECLARE v jsonb;
BEGIN
  v:=public.record_charge_refund_tombstone_atomic(
    NULL,'cus_blocked','pi_blocked','ch_blocked',true,19900,'usd',19900,
    'succeeded','evt_refund_blocked','2026-01-01 01:40:00+00');
  IF v->>'product_kind'<>'api_tier'
    OR v->>'projection_status'<>'api_tier_full_refund_revoked' THEN
    RAISE EXCEPTION 'API full refund did not produce its strict revocation ACK: %',v;
  END IF;
END $$;
SQL

expect_failure "SET ROLE hostile_role; SELECT public.apply_api_tier_paid_invoice_event_atomic(NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);" \
  "hostile role executed an API payment authority RPC"

echo "API tier recovery payment authority PostgreSQL 17 proof passed"
