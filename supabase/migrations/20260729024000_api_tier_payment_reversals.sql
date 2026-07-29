-- Persist exact API-tier invoice ownership and make every successful refund or
-- dispute a sticky revocation boundary. This ledger is intentionally separate
-- from B2C Pro entitlement payments and survives profile/Auth hard deletion.

BEGIN;

SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.api_tier_checkout_reservations') IS NULL
    OR pg_catalog.to_regclass('public.api_tier_stripe_event_ledger') IS NULL
    OR pg_catalog.to_regclass('public.api_tier_subscription_blocks') IS NULL
    OR pg_catalog.to_regclass('public.stripe_payment_ownerships') IS NULL
    OR pg_catalog.to_regclass('public.stripe_charge_refund_tombstones') IS NULL
    OR pg_catalog.to_regclass('public.stripe_charge_refund_tombstone_events') IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.api_keys') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.record_charge_refund_tombstone_atomic(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.record_charge_refund_tombstone_financial_legacy_v2(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.record_stripe_manual_review_atomic(text,text,uuid,text,text,jsonb)'
    ) IS NULL
  THEN
    RAISE EXCEPTION
      'API tier payment reversal prerequisites are missing';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.stripe_api_tier_payments (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  livemode boolean NOT NULL,
  stripe_customer_id text NOT NULL,
  checkout_reservation_id uuid NOT NULL
    REFERENCES public.api_tier_checkout_reservations(id) ON DELETE RESTRICT,
  stripe_subscription_id text NOT NULL,
  stripe_invoice_id text NOT NULL,
  stripe_invoice_payment_id text NOT NULL,
  stripe_payment_intent_id text,
  stripe_charge_id text NOT NULL,
  stripe_price_id text NOT NULL,
  api_plan text NOT NULL,
  amount_paid bigint NOT NULL,
  currency text NOT NULL,
  period_start bigint NOT NULL,
  period_end bigint NOT NULL,
  invoice_created bigint NOT NULL,
  paid_at bigint NOT NULL,
  recorded_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_api_tier_payments_customer_check
    CHECK (
      stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_customer_id) <= 255
    ),
  CONSTRAINT stripe_api_tier_payments_subscription_check
    CHECK (
      stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_subscription_id) <= 255
    ),
  CONSTRAINT stripe_api_tier_payments_invoice_check
    CHECK (
      stripe_invoice_id ~ '^in_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_invoice_id) <= 255
    ),
  CONSTRAINT stripe_api_tier_payments_invoice_payment_check
    CHECK (
      stripe_invoice_payment_id ~ '^inpay_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_invoice_payment_id) <= 255
    ),
  CONSTRAINT stripe_api_tier_payments_pi_check
    CHECK (
      stripe_payment_intent_id IS NULL
      OR (
        stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
        AND pg_catalog.length(stripe_payment_intent_id) <= 255
      )
    ),
  CONSTRAINT stripe_api_tier_payments_charge_check
    CHECK (
      stripe_charge_id ~ '^ch_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_charge_id) <= 255
    ),
  CONSTRAINT stripe_api_tier_payments_price_check
    CHECK (
      stripe_price_id ~ '^price_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_price_id) <= 255
    ),
  CONSTRAINT stripe_api_tier_payments_product_check
    CHECK (
      currency = 'usd'
      AND (
        (api_plan = 'starter' AND amount_paid = 4900)
        OR (api_plan = 'pro' AND amount_paid = 19900)
      )
    ),
  CONSTRAINT stripe_api_tier_payments_period_check
    CHECK (
      period_start > 0
      AND period_end > period_start
      AND period_end <= 253402300799
      AND invoice_created > 0
      AND invoice_created <= paid_at
      AND paid_at <= 253402300799
    ),
  CONSTRAINT stripe_api_tier_payments_invoice_key
    UNIQUE (livemode, stripe_invoice_id),
  CONSTRAINT stripe_api_tier_payments_invoice_payment_key
    UNIQUE (livemode, stripe_invoice_payment_id),
  CONSTRAINT stripe_api_tier_payments_pi_key
    UNIQUE (livemode, stripe_payment_intent_id),
  CONSTRAINT stripe_api_tier_payments_charge_key
    UNIQUE (livemode, stripe_charge_id),
  CONSTRAINT stripe_api_tier_payments_period_key
    UNIQUE (
      livemode,
      stripe_subscription_id,
      period_start,
      period_end
    )
);

CREATE INDEX IF NOT EXISTS stripe_api_tier_payments_user_subscription_idx
  ON public.stripe_api_tier_payments (
    user_id,
    livemode,
    stripe_subscription_id,
    period_end DESC
  );

ALTER TABLE public.stripe_api_tier_payments OWNER TO postgres;
ALTER TABLE public.stripe_api_tier_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_payments NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_api_tier_payments
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TABLE IF NOT EXISTS public.stripe_api_tier_payment_events (
  livemode boolean NOT NULL,
  observation_id text NOT NULL,
  api_tier_payment_id uuid NOT NULL
    REFERENCES public.stripe_api_tier_payments(id) ON DELETE RESTRICT,
  observation_type text NOT NULL,
  observation_created bigint NOT NULL,
  observed_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_api_tier_payment_events_pkey
    PRIMARY KEY (livemode, observation_id),
  CONSTRAINT stripe_api_tier_payment_events_observation_id_check
    CHECK (
      (
        observation_type IN (
          'invoice.paid',
          'invoice.payment_succeeded'
        )
        AND observation_id ~ '^evt_[A-Za-z0-9_]+$'
      )
      OR (
        observation_type = 'historical_backfill'
        AND observation_id ~ '^backfill:(true|false):in_[A-Za-z0-9_]+$'
      )
    ),
  CONSTRAINT stripe_api_tier_payment_events_type_check
    CHECK (
      observation_type IN (
        'invoice.paid',
        'invoice.payment_succeeded',
        'historical_backfill'
      )
    ),
  CONSTRAINT stripe_api_tier_payment_events_created_check
    CHECK (
      observation_created > 0
      AND observation_created <= 253402300799
    )
);

ALTER TABLE public.stripe_api_tier_payment_events OWNER TO postgres;
ALTER TABLE public.stripe_api_tier_payment_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_payment_events NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_api_tier_payment_events
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TABLE IF NOT EXISTS public.stripe_charge_refund_observation_modes (
  livemode boolean NOT NULL,
  stripe_event_id text NOT NULL,
  stripe_charge_id text NOT NULL,
  stripe_event_created bigint NOT NULL,
  recorded_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_charge_refund_observation_modes_pkey
    PRIMARY KEY (livemode, stripe_event_id),
  CONSTRAINT stripe_charge_refund_observation_modes_event_check
    CHECK (
      stripe_event_id ~ '^evt_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_event_id) <= 255
    ),
  CONSTRAINT stripe_charge_refund_observation_modes_charge_check
    CHECK (
      stripe_charge_id ~ '^ch_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_charge_id) <= 255
    ),
  CONSTRAINT stripe_charge_refund_observation_modes_created_check
    CHECK (
      stripe_event_created > 0
      AND stripe_event_created <= 253402300799
    )
);

CREATE INDEX IF NOT EXISTS stripe_charge_refund_observation_modes_charge_idx
  ON public.stripe_charge_refund_observation_modes (
    livemode,
    stripe_charge_id,
    stripe_event_created
  );

ALTER TABLE public.stripe_charge_refund_observation_modes OWNER TO postgres;
ALTER TABLE public.stripe_charge_refund_observation_modes
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_charge_refund_observation_modes
  NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_charge_refund_observation_modes
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TABLE IF NOT EXISTS public.stripe_api_tier_reversal_events (
  livemode boolean NOT NULL,
  stripe_event_id text NOT NULL,
  ownership_id uuid NOT NULL
    REFERENCES public.stripe_payment_ownerships(id) ON DELETE RESTRICT,
  reversal_kind text NOT NULL,
  stripe_charge_id text NOT NULL,
  stripe_dispute_id text,
  refund_state text,
  refund_succeeded_amount bigint,
  dispute_status text,
  dispute_reason text,
  dispute_amount bigint,
  currency text NOT NULL,
  stripe_event_created bigint NOT NULL,
  recorded_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_api_tier_reversal_events_pkey
    PRIMARY KEY (livemode, stripe_event_id),
  CONSTRAINT stripe_api_tier_reversal_events_event_id_check
    CHECK (
      stripe_event_id ~ '^evt_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_event_id) <= 255
    ),
  CONSTRAINT stripe_api_tier_reversal_events_charge_check
    CHECK (
      stripe_charge_id ~ '^ch_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_charge_id) <= 255
    ),
  CONSTRAINT stripe_api_tier_reversal_events_dispute_check
    CHECK (
      stripe_dispute_id IS NULL
      OR (
        stripe_dispute_id ~ '^dp_[A-Za-z0-9_]+$'
        AND pg_catalog.length(stripe_dispute_id) <= 255
      )
    ),
  CONSTRAINT stripe_api_tier_reversal_events_currency_check
    CHECK (currency ~ '^[a-z]{3}$'),
  CONSTRAINT stripe_api_tier_reversal_events_created_check
    CHECK (
      stripe_event_created > 0
      AND stripe_event_created <= 253402300799
    ),
  CONSTRAINT stripe_api_tier_reversal_events_shape_check
    CHECK (
      (
        reversal_kind = 'refund'
        AND stripe_dispute_id IS NULL
        AND refund_state IN (
          'pending',
          'requires_action',
          'succeeded',
          'failed',
          'canceled'
        )
        AND refund_succeeded_amount IS NOT NULL
        AND refund_succeeded_amount >= 0
        AND dispute_status IS NULL
        AND dispute_reason IS NULL
        AND dispute_amount IS NULL
      )
      OR (
        reversal_kind = 'dispute'
        AND stripe_dispute_id IS NOT NULL
        AND refund_state IS NULL
        AND refund_succeeded_amount IS NULL
        AND dispute_status IS NOT NULL
        AND pg_catalog.length(dispute_status) BETWEEN 1 AND 100
        AND dispute_reason IS NOT NULL
        AND pg_catalog.length(dispute_reason) BETWEEN 1 AND 100
        AND dispute_amount IS NOT NULL
        AND dispute_amount > 0
      )
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS stripe_api_tier_reversal_dispute_key
  ON public.stripe_api_tier_reversal_events (livemode, stripe_dispute_id)
  WHERE stripe_dispute_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS stripe_api_tier_reversal_ownership_idx
  ON public.stripe_api_tier_reversal_events (
    ownership_id,
    stripe_event_created DESC
  );

ALTER TABLE public.stripe_api_tier_reversal_events OWNER TO postgres;
ALTER TABLE public.stripe_api_tier_reversal_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_reversal_events NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_api_tier_reversal_events
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TABLE IF NOT EXISTS public.api_tier_reversal_actions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  ownership_id uuid NOT NULL
    REFERENCES public.stripe_payment_ownerships(id) ON DELETE RESTRICT,
  livemode boolean NOT NULL,
  user_id uuid NOT NULL,
  stripe_customer_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  action_kind text NOT NULL DEFAULT 'cancel_subscription',
  state text NOT NULL DEFAULT 'pending',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  lease_token uuid,
  lease_expires_at timestamp with time zone,
  completed_disposition text,
  completed_at timestamp with time zone,
  last_error text,
  created_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT api_tier_reversal_actions_identity_key
    UNIQUE (livemode, ownership_id, action_kind),
  CONSTRAINT api_tier_reversal_actions_subscription_key
    UNIQUE (livemode, stripe_subscription_id, action_kind),
  CONSTRAINT api_tier_reversal_actions_customer_check
    CHECK (
      stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_customer_id) <= 255
    ),
  CONSTRAINT api_tier_reversal_actions_subscription_check
    CHECK (
      stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_subscription_id) <= 255
    ),
  CONSTRAINT api_tier_reversal_actions_kind_check
    CHECK (action_kind = 'cancel_subscription'),
  CONSTRAINT api_tier_reversal_actions_attempts_check
    CHECK (attempts >= 0),
  CONSTRAINT api_tier_reversal_actions_state_check
    CHECK (
      (
        state = 'pending'
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
        AND completed_disposition IS NULL
        AND completed_at IS NULL
      )
      OR (
        state = 'leased'
        AND lease_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND completed_disposition IS NULL
        AND completed_at IS NULL
      )
      OR (
        state = 'completed'
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
        AND completed_disposition IN (
          'canceled',
          'already_canceled',
          'resource_missing'
        )
        AND completed_at IS NOT NULL
      )
    ),
  CONSTRAINT api_tier_reversal_actions_error_check
    CHECK (
      last_error IS NULL
      OR pg_catalog.length(last_error) BETWEEN 1 AND 2000
    )
);

CREATE INDEX IF NOT EXISTS api_tier_reversal_actions_due_idx
  ON public.api_tier_reversal_actions (next_attempt_at, created_at, id)
  WHERE state IN ('pending', 'leased');

ALTER TABLE public.api_tier_reversal_actions OWNER TO postgres;
ALTER TABLE public.api_tier_reversal_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_tier_reversal_actions NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.api_tier_reversal_actions
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TABLE IF NOT EXISTS public.api_tier_payment_backfill_targets (
  livemode boolean NOT NULL,
  stripe_subscription_id text NOT NULL,
  user_id uuid NOT NULL,
  stripe_customer_id text NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  scanned_invoice_count bigint NOT NULL DEFAULT 0,
  last_invoice_id text,
  lease_token uuid,
  lease_expires_at timestamp with time zone,
  completed_at timestamp with time zone,
  last_error text,
  created_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT api_tier_payment_backfill_targets_pkey
    PRIMARY KEY (livemode, stripe_subscription_id),
  CONSTRAINT api_tier_payment_backfill_targets_subscription_check
    CHECK (
      stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_subscription_id) <= 255
    ),
  CONSTRAINT api_tier_payment_backfill_targets_customer_check
    CHECK (
      stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_customer_id) <= 255
    ),
  CONSTRAINT api_tier_payment_backfill_targets_count_check
    CHECK (scanned_invoice_count >= 0),
  CONSTRAINT api_tier_payment_backfill_targets_invoice_check
    CHECK (
      last_invoice_id IS NULL
      OR (
        last_invoice_id ~ '^in_[A-Za-z0-9_]+$'
        AND pg_catalog.length(last_invoice_id) <= 255
      )
    ),
  CONSTRAINT api_tier_payment_backfill_targets_state_check
    CHECK (
      (
        state = 'pending'
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
        AND completed_at IS NULL
      )
      OR (
        state = 'leased'
        AND lease_token IS NOT NULL
        AND lease_expires_at IS NOT NULL
        AND completed_at IS NULL
      )
      OR (
        state = 'complete'
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
        AND completed_at IS NOT NULL
        AND last_error IS NULL
      )
      OR (
        state = 'attention'
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
        AND completed_at IS NULL
        AND last_error IS NOT NULL
      )
    )
);

ALTER TABLE public.api_tier_payment_backfill_targets OWNER TO postgres;
ALTER TABLE public.api_tier_payment_backfill_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_tier_payment_backfill_targets NO FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.api_tier_payment_backfill_targets
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- Freeze the exact historical population at migration time. New subscriptions
-- are covered by the invoice webhook writer and do not join this cutover set.
INSERT INTO public.api_tier_payment_backfill_targets (
  livemode,
  stripe_subscription_id,
  user_id,
  stripe_customer_id
)
SELECT DISTINCT ON (
  ledger.livemode,
  ledger.stripe_subscription_id
)
  ledger.livemode,
  ledger.stripe_subscription_id,
  ledger.user_id,
  ledger.stripe_customer_id
FROM public.api_tier_stripe_event_ledger AS ledger
WHERE ledger.api_tier IN ('starter', 'pro')
ORDER BY
  ledger.livemode,
  ledger.stripe_subscription_id,
  ledger.stripe_event_created DESC,
  ledger.stripe_event_id DESC
ON CONFLICT (livemode, stripe_subscription_id) DO NOTHING;

ALTER TABLE public.stripe_payment_ownerships
  DROP CONSTRAINT stripe_payment_ownerships_product_kind_check,
  ADD CONSTRAINT stripe_payment_ownerships_product_kind_check
    CHECK (
      product_kind IN (
        'pro_entitlement',
        'tip',
        'group_pass',
        'api_tier'
      )
    );

ALTER TABLE public.stripe_charge_refund_tombstones
  DROP CONSTRAINT stripe_charge_refund_tombstones_resolution_check,
  ADD CONSTRAINT stripe_charge_refund_tombstones_resolution_check
    CHECK (
      (
        resolution_kind = 'unclassified'
        AND merged_payment_id IS NULL
        AND resolution_ownership_id IS NULL
        AND resolution_reference IS NULL
      )
      OR (
        resolution_kind = 'entitlement_payment'
        AND merged_payment_id IS NOT NULL
        AND resolution_ownership_id IS NOT NULL
        AND resolution_reference =
          'ownership:' || resolution_ownership_id::text
      )
      OR (
        resolution_kind IN (
          'non_entitlement_payment',
          'api_tier_payment'
        )
        AND merged_payment_id IS NULL
        AND resolution_ownership_id IS NOT NULL
        AND resolution_reference =
          'ownership:' || resolution_ownership_id::text
      )
    );

CREATE OR REPLACE FUNCTION public.prevent_api_tier_financial_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'API tier financial ledgers are immutable'
    USING ERRCODE = '23514';
END
$function$;

ALTER FUNCTION public.prevent_api_tier_financial_ledger_mutation()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prevent_api_tier_financial_ledger_mutation()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

DROP TRIGGER IF EXISTS trg_stripe_api_tier_payments_immutable
  ON public.stripe_api_tier_payments;
CREATE TRIGGER trg_stripe_api_tier_payments_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_api_tier_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_api_tier_financial_ledger_mutation();

DROP TRIGGER IF EXISTS trg_stripe_api_tier_payment_events_immutable
  ON public.stripe_api_tier_payment_events;
CREATE TRIGGER trg_stripe_api_tier_payment_events_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_api_tier_payment_events
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_api_tier_financial_ledger_mutation();

DROP TRIGGER IF EXISTS trg_stripe_charge_refund_observation_modes_immutable
  ON public.stripe_charge_refund_observation_modes;
CREATE TRIGGER trg_stripe_charge_refund_observation_modes_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_charge_refund_observation_modes
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_api_tier_financial_ledger_mutation();

DROP TRIGGER IF EXISTS trg_stripe_api_tier_reversal_events_immutable
  ON public.stripe_api_tier_reversal_events;
CREATE TRIGGER trg_stripe_api_tier_reversal_events_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_api_tier_reversal_events
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_api_tier_financial_ledger_mutation();

CREATE OR REPLACE FUNCTION public.stripe_payment_ownership_is_exact_v2(
  p_ownership_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_ownership_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.stripe_payment_ownerships AS ownership
      WHERE ownership.id = p_ownership_id
        AND (
          (
            ownership.product_kind = 'pro_entitlement'
            AND EXISTS (
              SELECT 1
              FROM public.stripe_entitlement_payments AS payment
              WHERE payment.id = ownership.ledger_id
                AND payment.payment_status IN ('paid', 'succeeded')
                AND payment.user_id
                  IS NOT DISTINCT FROM ownership.owner_user_id
                AND payment.stripe_customer_id =
                  ownership.stripe_customer_id
                AND payment.stripe_payment_intent_id
                  IS NOT DISTINCT FROM
                    ownership.stripe_payment_intent_id
                AND payment.stripe_charge_id =
                  ownership.stripe_charge_id
                AND payment.checkout_session_id
                  IS NOT DISTINCT FROM ownership.checkout_session_id
                AND payment.amount_paid = ownership.amount_paid
                AND payment.currency = ownership.currency
            )
          )
          OR (
            ownership.product_kind = 'tip'
            AND EXISTS (
              SELECT 1
              FROM public.tips AS tip
              WHERE tip.id = ownership.ledger_id
                AND tip.status IN ('completed', 'refunded')
                AND tip.from_user_id = ownership.owner_user_id
                AND tip.stripe_customer_id =
                  ownership.stripe_customer_id
                AND tip.stripe_payment_intent_id =
                  ownership.stripe_payment_intent_id
                AND tip.stripe_charge_id =
                  ownership.stripe_charge_id
                AND tip.stripe_checkout_session_id =
                  ownership.checkout_session_id
                AND tip.amount_cents::bigint = ownership.amount_paid
                AND tip.currency = ownership.currency
            )
          )
          OR (
            ownership.product_kind = 'group_pass'
            AND EXISTS (
              SELECT 1
              FROM public.group_payment_consumptions AS consumption
              WHERE consumption.id = ownership.ledger_id
                AND consumption.provider = 'stripe'
                AND consumption.user_id = ownership.owner_user_id
                AND consumption.stripe_customer_id =
                  ownership.stripe_customer_id
                AND consumption.payment_intent_id =
                  ownership.stripe_payment_intent_id
                AND consumption.stripe_charge_id =
                  ownership.stripe_charge_id
                AND consumption.checkout_session_id
                  IS NOT DISTINCT FROM ownership.checkout_session_id
                AND ownership.checkout_session_id IS NOT NULL
                AND consumption.amount_cents = ownership.amount_paid
                AND consumption.currency = ownership.currency
                AND consumption.outcome IN (
                  'activated',
                  'renewed',
                  'refund_blocked'
                )
                AND consumption.result ->> 'subscription_id' =
                  consumption.subscription_id::text
                AND (
                  (
                    consumption.outcome IN ('activated', 'renewed')
                    AND consumption.result ->> 'status' IN (
                      'subscribed',
                      'renewed'
                    )
                    AND (
                      (
                        consumption.result ->> 'membership_status' =
                          'joined'
                        AND consumption.payment_member_joined_at
                          IS NOT NULL
                      )
                      OR (
                        consumption.result ->> 'membership_status' =
                          'already_member'
                        AND consumption.payment_member_joined_at IS NULL
                      )
                    )
                  )
                  OR (
                    consumption.outcome = 'refund_blocked'
                    AND consumption.result ->> 'status' =
                      'refund_observed'
                    AND consumption.payment_member_joined_at IS NULL
                  )
                )
            )
          )
          OR (
            ownership.product_kind = 'api_tier'
            AND ownership.owner_user_id IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM public.stripe_api_tier_payments AS payment
              JOIN public.api_tier_checkout_reservations AS reservation
                ON reservation.id = payment.checkout_reservation_id
              WHERE payment.id = ownership.ledger_id
                AND payment.user_id = ownership.owner_user_id
                AND payment.stripe_customer_id =
                  ownership.stripe_customer_id
                AND payment.stripe_payment_intent_id
                  IS NOT DISTINCT FROM
                    ownership.stripe_payment_intent_id
                AND payment.stripe_charge_id =
                  ownership.stripe_charge_id
                AND reservation.checkout_session_id =
                  ownership.checkout_session_id
                AND payment.amount_paid = ownership.amount_paid
                AND payment.currency = ownership.currency
            )
          )
        )
    )
$function$;

ALTER FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.project_api_tier_financial_reversal_atomic(
  p_ownership_id uuid,
  p_should_revoke boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_payment public.stripe_api_tier_payments%ROWTYPE;
  v_profile_subscription text;
  v_profile_exists boolean := false;
  v_was_blocked boolean := false;
  v_projection_status text;
  v_desired_subscription_id text;
  v_desired_tier text := 'free';
  v_desired_daily_limit integer := 100;
  v_best_active_created bigint;
  v_best_active_count integer := 0;
BEGIN
  IF p_ownership_id IS NULL OR p_should_revoke IS NULL THEN
    RAISE EXCEPTION 'API tier financial reversal projection input is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = p_ownership_id
    AND ownership.product_kind = 'api_tier';

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  SELECT payment.*
  INTO v_payment
  FROM public.stripe_api_tier_payments AS payment
  WHERE payment.id = v_ownership.ledger_id;
  IF NOT FOUND
    OR NOT public.stripe_payment_ownership_is_exact_v2(p_ownership_id)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || v_payment.user_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-customer-owner:' || v_payment.stripe_customer_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'api-tier-stripe-subscription:'
        || v_payment.livemode::text
        || ':'
        || v_payment.stripe_subscription_id,
      0
    )
  );

  SELECT profile.api_stripe_subscription_id
  INTO v_profile_subscription
  FROM public.user_profiles AS profile
  WHERE profile.id = v_payment.user_id
  FOR UPDATE;
  v_profile_exists := FOUND;

  IF NOT p_should_revoke THEN
    v_projection_status := 'audit_only';
  ELSE
    SELECT EXISTS (
      SELECT 1
      FROM public.api_tier_subscription_blocks AS block
      WHERE block.livemode = v_payment.livemode
        AND block.stripe_subscription_id =
          v_payment.stripe_subscription_id
        AND block.block_kind = 'financial_reversal'
    )
    INTO v_was_blocked;

    INSERT INTO public.api_tier_subscription_blocks (
      livemode,
      stripe_subscription_id,
      block_kind,
      user_id,
      stripe_customer_id
    ) VALUES (
      v_payment.livemode,
      v_payment.stripe_subscription_id,
      'financial_reversal',
      v_payment.user_id,
      v_payment.stripe_customer_id
    )
    ON CONFLICT (livemode, stripe_subscription_id, block_kind)
      DO NOTHING;

    IF EXISTS (
      SELECT 1
      FROM public.api_tier_subscription_blocks AS block
      WHERE block.livemode = v_payment.livemode
        AND block.stripe_subscription_id =
          v_payment.stripe_subscription_id
        AND block.block_kind = 'financial_reversal'
        AND (
          block.user_id <> v_payment.user_id
          OR block.stripe_customer_id IS DISTINCT FROM
            v_payment.stripe_customer_id
        )
    ) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    INSERT INTO public.api_tier_reversal_actions (
      ownership_id,
      livemode,
      user_id,
      stripe_customer_id,
      stripe_subscription_id
    ) VALUES (
      v_ownership.id,
      v_payment.livemode,
      v_payment.user_id,
      v_payment.stripe_customer_id,
      v_payment.stripe_subscription_id
    )
    -- Every paid period on one subscription shares a single cancellation.
    ON CONFLICT DO NOTHING;

    IF EXISTS (
      SELECT 1
      FROM public.api_tier_reversal_actions AS action
      WHERE action.livemode = v_payment.livemode
        AND action.stripe_subscription_id =
          v_payment.stripe_subscription_id
        AND action.action_kind = 'cancel_subscription'
        AND (
          action.user_id <> v_payment.user_id
          OR action.stripe_customer_id <> v_payment.stripe_customer_id
        )
    ) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    IF NOT v_profile_exists THEN
      v_projection_status := CASE
        WHEN v_was_blocked THEN 'already_subject_deleted'
        ELSE 'subject_deleted'
      END;
    ELSIF v_profile_subscription IS DISTINCT FROM
      v_payment.stripe_subscription_id
    THEN
      v_projection_status := CASE
        WHEN v_was_blocked THEN 'already_not_current'
        ELSE 'not_current'
      END;
    ELSE
      WITH subscription_state AS (
        SELECT DISTINCT ON (ledger.stripe_subscription_id)
          ledger.stripe_subscription_id,
          ledger.subscription_created,
          ledger.api_tier,
          ledger.daily_limit,
          ledger.is_active,
          ledger.is_terminal
        FROM public.api_tier_stripe_event_ledger AS ledger
        WHERE ledger.user_id = v_payment.user_id
          AND ledger.livemode = v_payment.livemode
          AND NOT EXISTS (
            SELECT 1
            FROM public.api_tier_subscription_blocks AS block
            WHERE block.user_id = ledger.user_id
              AND block.livemode = ledger.livemode
              AND block.stripe_subscription_id =
                ledger.stripe_subscription_id
          )
        ORDER BY
          ledger.stripe_subscription_id,
          ledger.is_terminal DESC,
          ledger.stripe_event_created DESC,
          ledger.is_active ASC,
          ledger.stripe_event_id DESC
      )
      SELECT pg_catalog.max(state.subscription_created)
      INTO v_best_active_created
      FROM subscription_state AS state
      WHERE state.is_active
        AND NOT state.is_terminal;

      IF v_best_active_created IS NOT NULL THEN
        WITH subscription_state AS (
          SELECT DISTINCT ON (ledger.stripe_subscription_id)
            ledger.stripe_subscription_id,
            ledger.subscription_created,
            ledger.api_tier,
            ledger.daily_limit,
            ledger.is_active,
            ledger.is_terminal
          FROM public.api_tier_stripe_event_ledger AS ledger
          WHERE ledger.user_id = v_payment.user_id
            AND ledger.livemode = v_payment.livemode
            AND NOT EXISTS (
              SELECT 1
              FROM public.api_tier_subscription_blocks AS block
              WHERE block.user_id = ledger.user_id
                AND block.livemode = ledger.livemode
                AND block.stripe_subscription_id =
                  ledger.stripe_subscription_id
            )
          ORDER BY
            ledger.stripe_subscription_id,
            ledger.is_terminal DESC,
            ledger.stripe_event_created DESC,
            ledger.is_active ASC,
            ledger.stripe_event_id DESC
        )
        SELECT
          pg_catalog.count(*)::integer,
          pg_catalog.min(state.stripe_subscription_id),
          pg_catalog.min(state.api_tier),
          pg_catalog.min(state.daily_limit)
        INTO
          v_best_active_count,
          v_desired_subscription_id,
          v_desired_tier,
          v_desired_daily_limit
        FROM subscription_state AS state
        WHERE state.is_active
          AND NOT state.is_terminal
          AND state.subscription_created = v_best_active_created;

        IF v_best_active_count <> 1 THEN
          RAISE EXCEPTION
            'equally-created active API subscriptions are ambiguous'
            USING ERRCODE = '40001';
        END IF;
      END IF;

      UPDATE public.user_profiles AS profile
      SET
        api_tier = v_desired_tier,
        api_stripe_subscription_id = v_desired_subscription_id,
        updated_at = pg_catalog.clock_timestamp()
      WHERE profile.id = v_payment.user_id
        AND profile.api_stripe_subscription_id =
          v_payment.stripe_subscription_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'API tier reversal profile changed concurrently'
          USING ERRCODE = '40001';
      END IF;

      UPDATE public.api_keys AS api_key
      SET
        active = CASE
          WHEN v_desired_subscription_id IS NULL THEN false
          ELSE api_key.active
        END,
        tier = v_desired_tier,
        daily_limit = v_desired_daily_limit,
        revoked_at = CASE
          WHEN v_desired_subscription_id IS NULL THEN
            COALESCE(
              api_key.revoked_at,
              pg_catalog.clock_timestamp()
            )
          ELSE api_key.revoked_at
        END
      WHERE api_key.user_id = v_payment.user_id
        AND api_key.active;

      v_projection_status := CASE
        WHEN v_desired_subscription_id IS NOT NULL
          AND v_was_blocked
          THEN 'already_reprojected'
        WHEN v_desired_subscription_id IS NOT NULL
          THEN 'reprojected'
        WHEN v_was_blocked THEN 'already_revoked'
        ELSE 'revoked'
      END;
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_projection_status,
    'user_id', v_payment.user_id,
    'stripe_customer_id', v_payment.stripe_customer_id,
    'stripe_subscription_id', v_payment.stripe_subscription_id,
    'livemode', v_payment.livemode,
    'should_cancel', p_should_revoke
  );
END
$function$;

ALTER FUNCTION public.project_api_tier_financial_reversal_atomic(uuid, boolean)
  OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.project_api_tier_financial_reversal_atomic(uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.stripe_resolve_api_tier_refund_tombstone_atomic(
    p_ownership_id uuid
  )
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_payment public.stripe_api_tier_payments%ROWTYPE;
  v_tombstone public.stripe_charge_refund_tombstones%ROWTYPE;
  v_projection jsonb;
  v_was_resolved boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_ownership_id IS NULL THEN
    RAISE EXCEPTION 'API tier Stripe ownership id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = p_ownership_id
    AND ownership.product_kind = 'api_tier';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'API tier Stripe ownership is missing'
      USING ERRCODE = 'P0002';
  END IF;
  SELECT payment.*
  INTO v_payment
  FROM public.stripe_api_tier_payments AS payment
  WHERE payment.id = v_ownership.ledger_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'API tier Stripe payment is missing'
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || v_ownership.stripe_charge_id,
      0
    )
  );
  IF v_ownership.stripe_payment_intent_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-payment-identity:'
          || v_ownership.stripe_payment_intent_id,
        0
      )
    );
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = p_ownership_id
    AND ownership.product_kind = 'api_tier'
  FOR UPDATE OF ownership;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;
  SELECT payment.*
  INTO v_payment
  FROM public.stripe_api_tier_payments AS payment
  WHERE payment.id = v_ownership.ledger_id;
  IF NOT FOUND
    OR NOT public.stripe_payment_ownership_is_exact_v2(p_ownership_id)
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_identity',
      v_ownership.stripe_charge_id,
      NULL,
      'api_tier_payment_ownership_drift',
      'API tier payment ownership no longer matches its immutable ledger.',
      pg_catalog.jsonb_build_object('ownership_id', p_ownership_id)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  SELECT tombstone.*
  INTO v_tombstone
  FROM public.stripe_charge_refund_tombstones AS tombstone
  WHERE tombstone.stripe_charge_id = v_ownership.stripe_charge_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'no_tombstone',
      'user_id', v_payment.user_id,
      'stripe_customer_id', v_payment.stripe_customer_id,
      'stripe_subscription_id', v_payment.stripe_subscription_id,
      'livemode', v_payment.livemode,
      'should_cancel', false
    );
  END IF;

  IF v_tombstone.stripe_customer_id IS DISTINCT FROM
      v_ownership.stripe_customer_id
    OR v_tombstone.stripe_payment_intent_id IS DISTINCT FROM
      v_ownership.stripe_payment_intent_id
    OR v_tombstone.amount_paid IS DISTINCT FROM v_ownership.amount_paid
    OR v_tombstone.currency IS DISTINCT FROM v_ownership.currency
    OR NOT v_tombstone.captured
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_ownership.stripe_charge_id,
      NULL,
      'api_tier_refund_tombstone_identity_conflict',
      'API tier ownership conflicts with the immutable Charge refund aggregate.',
      pg_catalog.jsonb_build_object('ownership_id', v_ownership.id)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  v_was_resolved :=
    v_tombstone.resolution_kind = 'api_tier_payment'
    AND v_tombstone.resolution_ownership_id = v_ownership.id
    AND v_tombstone.merged_payment_id IS NULL;

  IF NOT v_was_resolved
    AND (
      v_tombstone.resolution_kind IS DISTINCT FROM 'unclassified'
      OR v_tombstone.resolution_ownership_id IS NOT NULL
      OR v_tombstone.merged_payment_id IS NOT NULL
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_ownership.stripe_charge_id,
      NULL,
      'cross_product_tombstone_resolution_conflict',
      'A Charge tombstone is already classified to another product payment.',
      pg_catalog.jsonb_build_object('ownership_id', v_ownership.id)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF NOT v_was_resolved THEN
    UPDATE public.stripe_charge_refund_tombstones
    SET
      resolution_kind = 'api_tier_payment',
      resolution_ownership_id = v_ownership.id,
      resolution_reference = 'ownership:' || v_ownership.id::text,
      updated_at = pg_catalog.clock_timestamp()
    WHERE stripe_charge_id = v_ownership.stripe_charge_id
      AND resolution_kind = 'unclassified';
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
    WHERE tombstone_event.stripe_charge_id =
        v_ownership.stripe_charge_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.stripe_charge_refund_observation_modes AS observation_mode
        WHERE observation_mode.livemode = v_payment.livemode
          AND observation_mode.stripe_event_id =
            tombstone_event.event_id
          AND observation_mode.stripe_charge_id =
            tombstone_event.stripe_charge_id
          AND observation_mode.stripe_event_created =
            EXTRACT(
              epoch FROM tombstone_event.event_created_at
            )::bigint
      )
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_ownership.stripe_charge_id,
      NULL,
      'api_tier_refund_mode_unverified',
      'A refund observation has no exact Stripe livemode binding.',
      pg_catalog.jsonb_build_object(
        'ownership_id', v_ownership.id,
        'livemode', v_payment.livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  INSERT INTO public.stripe_api_tier_reversal_events (
    livemode,
    stripe_event_id,
    ownership_id,
    reversal_kind,
    stripe_charge_id,
    refund_state,
    refund_succeeded_amount,
    currency,
    stripe_event_created
  )
  SELECT
    v_payment.livemode,
    tombstone_event.event_id,
    v_ownership.id,
    'refund',
    v_ownership.stripe_charge_id,
    tombstone_event.refund_state,
    tombstone_event.refund_succeeded_amount,
    v_ownership.currency,
    EXTRACT(
      epoch FROM tombstone_event.event_created_at
    )::bigint
  FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
  WHERE tombstone_event.stripe_charge_id =
    v_ownership.stripe_charge_id
  ON CONFLICT (livemode, stripe_event_id) DO NOTHING;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
    WHERE tombstone_event.stripe_charge_id =
        v_ownership.stripe_charge_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.stripe_api_tier_reversal_events AS reversal
        WHERE reversal.livemode = v_payment.livemode
          AND reversal.stripe_event_id = tombstone_event.event_id
          AND reversal.ownership_id = v_ownership.id
          AND reversal.reversal_kind = 'refund'
          AND reversal.stripe_charge_id =
            v_ownership.stripe_charge_id
          AND reversal.refund_state =
            tombstone_event.refund_state
          AND reversal.refund_succeeded_amount =
            tombstone_event.refund_succeeded_amount
          AND reversal.currency = v_ownership.currency
          AND reversal.stripe_event_created =
            EXTRACT(
              epoch FROM tombstone_event.event_created_at
            )::bigint
      )
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_ownership.stripe_charge_id,
      NULL,
      'api_tier_refund_event_identity_conflict',
      'A refund event id already belongs to different API tier financial identity.',
      pg_catalog.jsonb_build_object('ownership_id', v_ownership.id)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  v_projection :=
    public.project_api_tier_financial_reversal_atomic(
      v_ownership.id,
      v_tombstone.refund_succeeded_amount > 0
    );
  IF COALESCE(v_projection ->> 'status', '') IN (
    'identity_conflict',
    'manual_review'
  ) THEN
    RETURN v_projection;
  END IF;

  RETURN v_projection || pg_catalog.jsonb_build_object(
    'status', v_projection ->> 'status',
    'refund_succeeded_amount', v_tombstone.refund_succeeded_amount
  );
END
$function$;

ALTER FUNCTION
  public.stripe_resolve_api_tier_refund_tombstone_atomic(uuid)
OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.stripe_resolve_api_tier_refund_tombstone_atomic(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.claim_api_tier_payment_ownership_atomic(
  p_api_tier_payment_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_payment public.stripe_api_tier_payments%ROWTYPE;
  v_session_id text;
  v_candidate_count integer;
  v_product_kinds text[];
  v_ledger_ids uuid[];
  v_owner_user_ids uuid[];
  v_customer_ids text[];
  v_payment_intent_ids text[];
  v_charge_ids text[];
  v_session_ids text[];
  v_amounts bigint[];
  v_currencies text[];
  v_ownership_count integer;
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_inserted_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_api_tier_payment_id IS NULL THEN
    RAISE EXCEPTION 'API tier payment id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT payment.*
  INTO v_payment
  FROM public.stripe_api_tier_payments AS payment
  WHERE payment.id = p_api_tier_payment_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  SELECT reservation.checkout_session_id
  INTO v_session_id
  FROM public.api_tier_checkout_reservations AS reservation
  WHERE reservation.id = v_payment.checkout_reservation_id;
  IF NOT FOUND
    OR v_session_id IS NULL
    OR v_session_id !~ '^cs_[A-Za-z0-9_]+$'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || v_payment.stripe_charge_id,
      0
    )
  );
  IF v_payment.stripe_payment_intent_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-payment-identity:'
          || v_payment.stripe_payment_intent_id,
        0
      )
    );
  END IF;

  -- Round one establishes that Charge/PaymentIntent identify exactly one
  -- product ledger before deriving and locking its Checkout Session.
  WITH candidates AS (
    SELECT
      'pro_entitlement'::text AS product_kind,
      payment.id AS ledger_id,
      payment.user_id AS owner_user_id,
      payment.stripe_customer_id,
      payment.stripe_payment_intent_id,
      payment.stripe_charge_id,
      payment.checkout_session_id,
      payment.amount_paid,
      payment.currency
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.stripe_charge_id = v_payment.stripe_charge_id
      OR (
        v_payment.stripe_payment_intent_id IS NOT NULL
        AND payment.stripe_payment_intent_id =
          v_payment.stripe_payment_intent_id
      )
    UNION ALL
    SELECT
      'tip',
      tip.id,
      tip.from_user_id,
      tip.stripe_customer_id,
      tip.stripe_payment_intent_id,
      tip.stripe_charge_id,
      tip.stripe_checkout_session_id,
      tip.amount_cents::bigint,
      tip.currency
    FROM public.tips AS tip
    WHERE tip.stripe_charge_id = v_payment.stripe_charge_id
      OR (
        v_payment.stripe_payment_intent_id IS NOT NULL
        AND tip.stripe_payment_intent_id =
          v_payment.stripe_payment_intent_id
      )
    UNION ALL
    SELECT
      'group_pass',
      consumption.id,
      consumption.user_id,
      consumption.stripe_customer_id,
      consumption.payment_intent_id,
      consumption.stripe_charge_id,
      consumption.checkout_session_id,
      consumption.amount_cents,
      consumption.currency
    FROM public.group_payment_consumptions AS consumption
    WHERE consumption.provider = 'stripe'
      AND (
        consumption.stripe_charge_id = v_payment.stripe_charge_id
        OR (
          v_payment.stripe_payment_intent_id IS NOT NULL
          AND consumption.payment_intent_id =
            v_payment.stripe_payment_intent_id
        )
      )
    UNION ALL
    SELECT
      'api_tier',
      candidate.id,
      candidate.user_id,
      candidate.stripe_customer_id,
      candidate.stripe_payment_intent_id,
      candidate.stripe_charge_id,
      reservation.checkout_session_id,
      candidate.amount_paid,
      candidate.currency
    FROM public.stripe_api_tier_payments AS candidate
    JOIN public.api_tier_checkout_reservations AS reservation
      ON reservation.id = candidate.checkout_reservation_id
    WHERE candidate.stripe_charge_id = v_payment.stripe_charge_id
      OR (
        v_payment.stripe_payment_intent_id IS NOT NULL
        AND candidate.stripe_payment_intent_id =
          v_payment.stripe_payment_intent_id
      )
  )
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.array_agg(candidate.product_kind ORDER BY candidate.product_kind),
    pg_catalog.array_agg(candidate.ledger_id ORDER BY candidate.product_kind),
    pg_catalog.array_agg(
      candidate.owner_user_id ORDER BY candidate.product_kind
    ),
    pg_catalog.array_agg(
      candidate.stripe_customer_id ORDER BY candidate.product_kind
    ),
    pg_catalog.array_agg(
      candidate.stripe_payment_intent_id ORDER BY candidate.product_kind
    ),
    pg_catalog.array_agg(
      candidate.stripe_charge_id ORDER BY candidate.product_kind
    ),
    pg_catalog.array_agg(
      candidate.checkout_session_id ORDER BY candidate.product_kind
    ),
    pg_catalog.array_agg(candidate.amount_paid ORDER BY candidate.product_kind),
    pg_catalog.array_agg(candidate.currency ORDER BY candidate.product_kind)
  INTO
    v_candidate_count,
    v_product_kinds,
    v_ledger_ids,
    v_owner_user_ids,
    v_customer_ids,
    v_payment_intent_ids,
    v_charge_ids,
    v_session_ids,
    v_amounts,
    v_currencies
  FROM candidates AS candidate;

  IF v_candidate_count IS DISTINCT FROM 1
    OR v_product_kinds[1] IS DISTINCT FROM 'api_tier'
    OR v_ledger_ids[1] IS DISTINCT FROM v_payment.id
    OR v_owner_user_ids[1] IS DISTINCT FROM v_payment.user_id
    OR v_customer_ids[1] IS DISTINCT FROM v_payment.stripe_customer_id
    OR v_payment_intent_ids[1] IS DISTINCT FROM
      v_payment.stripe_payment_intent_id
    OR v_charge_ids[1] IS DISTINCT FROM v_payment.stripe_charge_id
    OR v_session_ids[1] IS DISTINCT FROM v_session_id
    OR v_amounts[1] IS DISTINCT FROM v_payment.amount_paid
    OR v_currencies[1] IS DISTINCT FROM v_payment.currency
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict',
      'candidate_count', v_candidate_count,
      'product_kinds',
        COALESCE(pg_catalog.to_jsonb(v_product_kinds), '[]'::jsonb)
    );
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-checkout-session:' || v_session_id,
      0
    )
  );

  -- Round two repeats the complete candidate search under all three Stripe
  -- identity locks and includes Session-only product rows.
  WITH candidates AS (
    SELECT
      'pro_entitlement'::text AS product_kind,
      payment.id AS ledger_id
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.stripe_charge_id = v_payment.stripe_charge_id
      OR (
        v_payment.stripe_payment_intent_id IS NOT NULL
        AND payment.stripe_payment_intent_id =
          v_payment.stripe_payment_intent_id
      )
      OR payment.checkout_session_id = v_session_id
    UNION ALL
    SELECT 'tip', tip.id
    FROM public.tips AS tip
    WHERE tip.stripe_charge_id = v_payment.stripe_charge_id
      OR (
        v_payment.stripe_payment_intent_id IS NOT NULL
        AND tip.stripe_payment_intent_id =
          v_payment.stripe_payment_intent_id
      )
      OR tip.stripe_checkout_session_id = v_session_id
    UNION ALL
    SELECT 'group_pass', consumption.id
    FROM public.group_payment_consumptions AS consumption
    WHERE consumption.provider = 'stripe'
      AND (
        consumption.stripe_charge_id = v_payment.stripe_charge_id
        OR (
          v_payment.stripe_payment_intent_id IS NOT NULL
          AND consumption.payment_intent_id =
            v_payment.stripe_payment_intent_id
        )
        OR consumption.checkout_session_id = v_session_id
      )
    UNION ALL
    SELECT 'api_tier', candidate.id
    FROM public.stripe_api_tier_payments AS candidate
    JOIN public.api_tier_checkout_reservations AS reservation
      ON reservation.id = candidate.checkout_reservation_id
    WHERE candidate.stripe_charge_id = v_payment.stripe_charge_id
      OR (
        v_payment.stripe_payment_intent_id IS NOT NULL
        AND candidate.stripe_payment_intent_id =
          v_payment.stripe_payment_intent_id
      )
      OR reservation.checkout_session_id = v_session_id
  )
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.array_agg(candidate.product_kind ORDER BY candidate.product_kind),
    pg_catalog.array_agg(candidate.ledger_id ORDER BY candidate.product_kind)
  INTO v_candidate_count, v_product_kinds, v_ledger_ids
  FROM candidates AS candidate;

  IF v_candidate_count IS DISTINCT FROM 1
    OR v_product_kinds[1] IS DISTINCT FROM 'api_tier'
    OR v_ledger_ids[1] IS DISTINCT FROM v_payment.id
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict',
      'candidate_count', v_candidate_count,
      'product_kinds',
        COALESCE(pg_catalog.to_jsonb(v_product_kinds), '[]'::jsonb)
    );
  END IF;

  INSERT INTO public.stripe_payment_ownerships (
    product_kind,
    ledger_id,
    owner_user_id,
    stripe_customer_id,
    stripe_payment_intent_id,
    stripe_charge_id,
    checkout_session_id,
    amount_paid,
    currency
  ) VALUES (
    'api_tier',
    v_payment.id,
    v_payment.user_id,
    v_payment.stripe_customer_id,
    v_payment.stripe_payment_intent_id,
    v_payment.stripe_charge_id,
    v_session_id,
    v_payment.amount_paid,
    v_payment.currency
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_inserted_id;

  SELECT
    pg_catalog.count(*)::integer,
    (pg_catalog.array_agg(ownership.id ORDER BY ownership.id))[1]
  INTO v_ownership_count, v_ownership.id
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.stripe_charge_id = v_payment.stripe_charge_id
    OR (
      v_payment.stripe_payment_intent_id IS NOT NULL
      AND ownership.stripe_payment_intent_id =
        v_payment.stripe_payment_intent_id
    )
    OR ownership.checkout_session_id = v_session_id
    OR (
      ownership.product_kind = 'api_tier'
      AND ownership.ledger_id = v_payment.id
    );

  IF v_ownership_count IS DISTINCT FROM 1 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = v_ownership.id
  FOR UPDATE;

  IF NOT public.stripe_payment_ownership_is_exact_v2(v_ownership.id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status',
      CASE WHEN v_inserted_id IS NULL
        THEN 'already_claimed'
        ELSE 'claimed'
      END,
    'ownership_id', v_ownership.id
  );
END
$function$;

ALTER FUNCTION public.claim_api_tier_payment_ownership_atomic(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.claim_api_tier_payment_ownership_atomic(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.record_api_tier_payment_atomic(
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_checkout_reservation_id uuid,
  p_stripe_subscription_id text,
  p_stripe_invoice_id text,
  p_stripe_invoice_payment_id text,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_stripe_price_id text,
  p_api_plan text,
  p_amount_paid bigint,
  p_currency text,
  p_period_start bigint,
  p_period_end bigint,
  p_invoice_created bigint,
  p_paid_at bigint,
  p_observation_id text,
  p_observation_created bigint,
  p_observation_type text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_reservation public.api_tier_checkout_reservations%ROWTYPE;
  v_payment public.stripe_api_tier_payments%ROWTYPE;
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_projection jsonb;
  v_claim jsonb;
  v_payment_count integer := 0;
  v_ownership_count integer := 0;
  v_inserted boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_checkout_reservation_id IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_stripe_invoice_id IS NULL
    OR p_stripe_invoice_id !~ '^in_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_invoice_id) > 255
    OR p_stripe_invoice_payment_id IS NULL
    OR p_stripe_invoice_payment_id !~ '^inpay_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_invoice_payment_id) > 255
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND (
        p_stripe_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_stripe_payment_intent_id) > 255
      )
    )
    OR p_stripe_charge_id IS NULL
    OR p_stripe_charge_id !~ '^ch_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_charge_id) > 255
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_currency IS DISTINCT FROM 'usd'
    OR p_api_plan IS NULL
    OR p_amount_paid IS NULL
    OR (
      p_api_plan = 'starter'
      AND p_amount_paid IS DISTINCT FROM 4900
    )
    OR (
      p_api_plan = 'pro'
      AND p_amount_paid IS DISTINCT FROM 19900
    )
    OR p_api_plan NOT IN ('starter', 'pro')
    OR p_period_start IS NULL
    OR p_period_start <= 0
    OR p_period_end IS NULL
    OR p_period_end <= p_period_start
    OR p_period_end > 253402300799
    OR p_invoice_created IS NULL
    OR p_invoice_created <= 0
    OR p_paid_at IS NULL
    OR p_paid_at < p_invoice_created
    OR p_paid_at > 253402300799
    OR p_observation_created IS NULL
    OR p_observation_created < p_paid_at
    OR p_observation_created > 253402300799
    OR p_observation_id IS NULL
    OR p_observation_type IS NULL
    OR (
      p_observation_type IN (
        'invoice.paid',
        'invoice.payment_succeeded'
      )
      AND (
        p_observation_id !~ '^evt_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_observation_id) > 255
      )
    )
    OR (
      p_observation_type = 'historical_backfill'
      AND p_observation_id IS DISTINCT FROM
        'backfill:'
          || p_livemode::text
          || ':'
          || p_stripe_invoice_id
    )
    OR p_observation_type NOT IN (
      'invoice.paid',
      'invoice.payment_succeeded',
      'historical_backfill'
    )
  THEN
    RAISE EXCEPTION 'API tier payment identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || p_stripe_charge_id,
      0
    )
  );
  IF p_stripe_payment_intent_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-payment-identity:' || p_stripe_payment_intent_id,
        0
      )
    );
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'api-tier-invoice:'
        || p_livemode::text
        || ':'
        || p_stripe_invoice_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_user_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-customer-owner:' || p_stripe_customer_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'api-tier-stripe-subscription:'
        || p_livemode::text
        || ':'
        || p_stripe_subscription_id,
      0
    )
  );

  SELECT reservation.*
  INTO v_reservation
  FROM public.api_tier_checkout_reservations AS reservation
  WHERE reservation.id = p_checkout_reservation_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_reservation.user_id <> p_user_id
    OR v_reservation.livemode IS DISTINCT FROM p_livemode
    OR v_reservation.stripe_customer_id <> p_stripe_customer_id
    OR v_reservation.api_plan <> p_api_plan
    OR v_reservation.stripe_price_id <> p_stripe_price_id
    OR v_reservation.status <> 'converted'
    OR v_reservation.stripe_subscription_id <>
      p_stripe_subscription_id
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'invoice',
      p_stripe_invoice_id,
      NULL,
      'api_tier_invoice_reservation_identity_conflict',
      'A paid API tier invoice does not match its converted Checkout reservation.',
      pg_catalog.jsonb_build_object(
        'reservation_id', p_checkout_reservation_id,
        'subscription_id', p_stripe_subscription_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.api_tier_stripe_event_ledger AS ledger
    WHERE ledger.user_id = p_user_id
      AND ledger.livemode = p_livemode
      AND ledger.stripe_customer_id = p_stripe_customer_id
      AND ledger.checkout_reservation_id = p_checkout_reservation_id
      AND ledger.stripe_subscription_id = p_stripe_subscription_id
      AND ledger.stripe_price_id = p_stripe_price_id
      AND ledger.api_tier = p_api_plan
  ) THEN
    RAISE EXCEPTION
      'API tier payment arrived before sealed subscription authority'
      USING ERRCODE = '40001';
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    (pg_catalog.array_agg(payment.id ORDER BY payment.id))[1]
  INTO v_payment_count, v_payment.id
  FROM public.stripe_api_tier_payments AS payment
  WHERE (
      payment.livemode = p_livemode
      AND (
        payment.stripe_invoice_id = p_stripe_invoice_id
        OR payment.stripe_invoice_payment_id =
          p_stripe_invoice_payment_id
        OR payment.stripe_charge_id = p_stripe_charge_id
        OR (
          p_stripe_payment_intent_id IS NOT NULL
          AND payment.stripe_payment_intent_id =
            p_stripe_payment_intent_id
        )
        OR (
          payment.stripe_subscription_id =
            p_stripe_subscription_id
          AND payment.period_start = p_period_start
          AND payment.period_end = p_period_end
        )
      )
    );

  IF v_payment_count > 1 THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'invoice',
      p_stripe_invoice_id,
      NULL,
      'api_tier_payment_candidate_conflict',
      'API tier invoice identifiers resolve to multiple immutable payments.',
      pg_catalog.jsonb_build_object(
        'charge_id', p_stripe_charge_id,
        'payment_intent_id', p_stripe_payment_intent_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF v_payment_count = 1 THEN
    SELECT payment.*
    INTO v_payment
    FROM public.stripe_api_tier_payments AS payment
    WHERE payment.id = v_payment.id;

    IF v_payment.user_id <> p_user_id
      OR v_payment.livemode IS DISTINCT FROM p_livemode
      OR v_payment.stripe_customer_id <> p_stripe_customer_id
      OR v_payment.checkout_reservation_id <>
        p_checkout_reservation_id
      OR v_payment.stripe_subscription_id <>
        p_stripe_subscription_id
      OR v_payment.stripe_invoice_id <> p_stripe_invoice_id
      OR v_payment.stripe_invoice_payment_id <>
        p_stripe_invoice_payment_id
      OR v_payment.stripe_payment_intent_id IS DISTINCT FROM
        p_stripe_payment_intent_id
      OR v_payment.stripe_charge_id <> p_stripe_charge_id
      OR v_payment.stripe_price_id <> p_stripe_price_id
      OR v_payment.api_plan <> p_api_plan
      OR v_payment.amount_paid <> p_amount_paid
      OR v_payment.currency <> p_currency
      OR v_payment.period_start <> p_period_start
      OR v_payment.period_end <> p_period_end
      OR v_payment.invoice_created <> p_invoice_created
      OR v_payment.paid_at <> p_paid_at
    THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'invoice',
        p_stripe_invoice_id,
        NULL,
        'api_tier_payment_replay_identity_conflict',
        'An API tier payment replay changed immutable invoice identity.',
        pg_catalog.jsonb_build_object('payment_id', v_payment.id)
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
  ELSE
    SELECT pg_catalog.count(*)::integer
    INTO v_ownership_count
    FROM public.stripe_payment_ownerships AS ownership
    WHERE ownership.stripe_charge_id = p_stripe_charge_id
      OR (
        p_stripe_payment_intent_id IS NOT NULL
        AND ownership.stripe_payment_intent_id =
          p_stripe_payment_intent_id
      )
      OR ownership.checkout_session_id =
        v_reservation.checkout_session_id;
    IF v_ownership_count <> 0 THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'payment_identity',
        p_stripe_charge_id,
        NULL,
        'cross_product_api_tier_payment_identity_conflict',
        'API tier invoice identifiers are owned by another product ledger.',
        pg_catalog.jsonb_build_object(
          'invoice_id', p_stripe_invoice_id,
          'payment_intent_id', p_stripe_payment_intent_id
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    BEGIN
      INSERT INTO public.stripe_api_tier_payments (
      user_id,
      livemode,
      stripe_customer_id,
      checkout_reservation_id,
      stripe_subscription_id,
      stripe_invoice_id,
      stripe_invoice_payment_id,
      stripe_payment_intent_id,
      stripe_charge_id,
      stripe_price_id,
      api_plan,
      amount_paid,
      currency,
      period_start,
      period_end,
      invoice_created,
      paid_at
      ) VALUES (
      p_user_id,
      p_livemode,
      p_stripe_customer_id,
      p_checkout_reservation_id,
      p_stripe_subscription_id,
      p_stripe_invoice_id,
      p_stripe_invoice_payment_id,
      p_stripe_payment_intent_id,
      p_stripe_charge_id,
      p_stripe_price_id,
      p_api_plan,
      p_amount_paid,
      p_currency,
      p_period_start,
      p_period_end,
      p_invoice_created,
      p_paid_at
      )
      RETURNING * INTO v_payment;

      v_claim :=
        public.claim_api_tier_payment_ownership_atomic(v_payment.id);
      IF COALESCE(v_claim ->> 'status', '') NOT IN (
        'claimed',
        'already_claimed'
      ) THEN
        RAISE EXCEPTION 'API tier ownership candidate conflict'
          USING ERRCODE = '23514';
      END IF;
      v_inserted := true;
    EXCEPTION
      WHEN unique_violation OR check_violation THEN
        PERFORM public.record_stripe_manual_review_atomic(
          'payment_identity',
          p_stripe_charge_id,
          NULL,
          'api_tier_payment_atomic_ownership_conflict',
          'API tier payment and central ownership could not be inserted atomically.',
          pg_catalog.jsonb_build_object(
            'invoice_id', p_stripe_invoice_id,
            'payment_intent_id', p_stripe_payment_intent_id
          )
        );
        RETURN pg_catalog.jsonb_build_object(
          'status', 'identity_conflict'
        );
    END;
  END IF;

  IF NOT v_inserted THEN
    v_claim :=
      public.claim_api_tier_payment_ownership_atomic(v_payment.id);
    IF COALESCE(v_claim ->> 'status', '') NOT IN (
      'claimed',
      'already_claimed'
    ) THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'payment_identity',
        p_stripe_charge_id,
        NULL,
        'api_tier_payment_replay_ownership_conflict',
        'An existing API tier payment no longer has exact central ownership.',
        pg_catalog.jsonb_build_object('payment_id', v_payment.id)
      );
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    (pg_catalog.array_agg(ownership.id ORDER BY ownership.id))[1]
  INTO v_ownership_count, v_ownership.id
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.stripe_charge_id = p_stripe_charge_id
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND ownership.stripe_payment_intent_id =
        p_stripe_payment_intent_id
    )
    OR (
      ownership.product_kind = 'api_tier'
      AND ownership.ledger_id = v_payment.id
    )
    OR ownership.checkout_session_id =
      v_reservation.checkout_session_id;

  IF v_ownership_count <> 1 THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_identity',
      p_stripe_charge_id,
      NULL,
      'central_api_tier_payment_ownership_conflict',
      'Global Stripe identifiers map to incompatible central ownership rows.',
      pg_catalog.jsonb_build_object('payment_id', v_payment.id)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = v_ownership.id
  FOR UPDATE;
  IF v_ownership.product_kind <> 'api_tier'
    OR v_ownership.ledger_id <> v_payment.id
    OR NOT public.stripe_payment_ownership_is_exact_v2(v_ownership.id)
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_identity',
      p_stripe_charge_id,
      NULL,
      'central_api_tier_payment_ownership_identity_conflict',
      'Central API tier ownership changed immutable ledger identity.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'ownership_id', v_ownership.id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  INSERT INTO public.stripe_api_tier_payment_events (
    livemode,
    observation_id,
    api_tier_payment_id,
    observation_type,
    observation_created
  ) VALUES (
    p_livemode,
    p_observation_id,
    v_payment.id,
    p_observation_type,
    p_observation_created
  )
  ON CONFLICT (livemode, observation_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.stripe_api_tier_payment_events AS observation
    WHERE observation.livemode = p_livemode
      AND observation.observation_id = p_observation_id
      AND observation.api_tier_payment_id = v_payment.id
      AND observation.observation_type = p_observation_type
      AND observation.observation_created = p_observation_created
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'invoice',
      p_stripe_invoice_id,
      NULL,
      'api_tier_payment_observation_identity_conflict',
      'An invoice observation id belongs to different API tier payment identity.',
      pg_catalog.jsonb_build_object('payment_id', v_payment.id)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  -- A payment-first webhook writes the mode directly. During historical
  -- backfill this also binds any older refund-first tombstone to the freshly
  -- verified Invoice/Charge mode before the tombstone is projected.
  INSERT INTO public.stripe_charge_refund_observation_modes (
    livemode,
    stripe_event_id,
    stripe_charge_id,
    stripe_event_created
  )
  SELECT
    p_livemode,
    tombstone_event.event_id,
    tombstone_event.stripe_charge_id,
    EXTRACT(
      epoch FROM tombstone_event.event_created_at
    )::bigint
  FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
  WHERE tombstone_event.stripe_charge_id = p_stripe_charge_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_observation_modes AS existing_mode
      WHERE existing_mode.stripe_event_id = tombstone_event.event_id
    )
  ON CONFLICT (livemode, stripe_event_id) DO NOTHING;

  v_projection :=
    public.stripe_resolve_api_tier_refund_tombstone_atomic(v_ownership.id);
  IF COALESCE(v_projection ->> 'status', '') IN (
    'identity_conflict',
    'manual_review'
  ) THEN
    RETURN v_projection;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_inserted THEN 'recorded' ELSE 'already_recorded' END,
    'payment_id', v_payment.id,
    'ownership_id', v_ownership.id,
    'projection_status', v_projection ->> 'status',
    'user_id', v_payment.user_id,
    'stripe_customer_id', v_payment.stripe_customer_id,
    'stripe_subscription_id', v_payment.stripe_subscription_id,
    'livemode', v_payment.livemode,
    'should_cancel',
      COALESCE((v_projection ->> 'should_cancel')::boolean, false)
  );
END
$function$;

ALTER FUNCTION public.record_api_tier_payment_atomic(
  uuid, boolean, text, uuid, text, text, text, text, text, text, text,
  bigint, text, bigint, bigint, bigint, bigint, text, bigint, text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_api_tier_payment_atomic(
  uuid, boolean, text, uuid, text, text, text, text, text, text, text,
  bigint, text, bigint, bigint, bigint, bigint, text, bigint, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.record_api_tier_payment_atomic(
  uuid, boolean, text, uuid, text, text, text, text, text, text, text,
  bigint, text, bigint, bigint, bigint, bigint, text, bigint, text
) TO service_role;

CREATE OR REPLACE FUNCTION public.record_api_tier_dispute_reversal_atomic(
  p_livemode boolean,
  p_stripe_event_id text,
  p_stripe_event_created bigint,
  p_stripe_dispute_id text,
  p_dispute_status text,
  p_dispute_reason text,
  p_dispute_amount bigint,
  p_currency text,
  p_stripe_customer_id text,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_captured_amount bigint
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_payment public.stripe_api_tier_payments%ROWTYPE;
  v_projection jsonb;
  v_ownership_count integer := 0;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL
    OR p_stripe_event_id IS NULL
    OR p_stripe_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_event_id) > 255
    OR p_stripe_event_created IS NULL
    OR p_stripe_event_created <= 0
    OR p_stripe_event_created > 253402300799
    OR p_stripe_dispute_id IS NULL
    OR p_stripe_dispute_id !~ '^dp_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_dispute_id) > 255
    OR p_dispute_status IS NULL
    OR pg_catalog.length(p_dispute_status) NOT BETWEEN 1 AND 100
    OR p_dispute_reason IS NULL
    OR pg_catalog.length(p_dispute_reason) NOT BETWEEN 1 AND 100
    OR p_dispute_amount IS NULL
    OR p_dispute_amount <= 0
    OR p_currency IS NULL
    OR p_currency !~ '^[a-z]{3}$'
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND p_stripe_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
    )
    OR p_stripe_charge_id IS NULL
    OR p_stripe_charge_id !~ '^ch_[A-Za-z0-9_]+$'
    OR p_captured_amount IS NULL
    OR p_captured_amount <= 0
    OR p_dispute_amount > p_captured_amount
  THEN
    RAISE EXCEPTION 'API tier dispute identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || p_stripe_charge_id,
      0
    )
  );
  IF p_stripe_payment_intent_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-payment-identity:' || p_stripe_payment_intent_id,
        0
      )
    );
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    (pg_catalog.array_agg(ownership.id ORDER BY ownership.id))[1]
  INTO v_ownership_count, v_ownership.id
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.stripe_charge_id = p_stripe_charge_id
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND ownership.stripe_payment_intent_id =
        p_stripe_payment_intent_id
    );

  IF v_ownership_count = 0 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_api');
  END IF;
  IF v_ownership_count <> 1 THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_identity',
      p_stripe_charge_id,
      NULL,
      'api_tier_dispute_ownership_conflict',
      'A disputed Charge maps to multiple central Stripe ownership rows.',
      pg_catalog.jsonb_build_object(
        'dispute_id', p_stripe_dispute_id,
        'payment_intent_id', p_stripe_payment_intent_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = v_ownership.id
  FOR UPDATE;
  IF v_ownership.product_kind <> 'api_tier' THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_api');
  END IF;

  SELECT payment.*
  INTO v_payment
  FROM public.stripe_api_tier_payments AS payment
  WHERE payment.id = v_ownership.ledger_id;
  IF NOT FOUND
    OR NOT public.stripe_payment_ownership_is_exact_v2(v_ownership.id)
    OR v_payment.livemode IS DISTINCT FROM p_livemode
    OR v_payment.stripe_customer_id <>
      p_stripe_customer_id
    OR v_payment.stripe_payment_intent_id IS DISTINCT FROM
      p_stripe_payment_intent_id
    OR v_payment.stripe_charge_id <> p_stripe_charge_id
    OR v_payment.amount_paid <> p_captured_amount
    OR v_payment.currency <> p_currency
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      p_stripe_charge_id,
      NULL,
      'api_tier_dispute_payment_identity_conflict',
      'A disputed Charge conflicts with immutable API tier payment ownership.',
      pg_catalog.jsonb_build_object(
        'ownership_id', v_ownership.id,
        'dispute_id', p_stripe_dispute_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  INSERT INTO public.stripe_api_tier_reversal_events (
    livemode,
    stripe_event_id,
    ownership_id,
    reversal_kind,
    stripe_charge_id,
    stripe_dispute_id,
    dispute_status,
    dispute_reason,
    dispute_amount,
    currency,
    stripe_event_created
  ) VALUES (
    p_livemode,
    p_stripe_event_id,
    v_ownership.id,
    'dispute',
    p_stripe_charge_id,
    p_stripe_dispute_id,
    p_dispute_status,
    p_dispute_reason,
    p_dispute_amount,
    p_currency,
    p_stripe_event_created
  )
  ON CONFLICT (livemode, stripe_event_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.stripe_api_tier_reversal_events AS reversal
    WHERE reversal.livemode = p_livemode
      AND reversal.stripe_event_id = p_stripe_event_id
      AND reversal.ownership_id = v_ownership.id
      AND reversal.reversal_kind = 'dispute'
      AND reversal.stripe_charge_id = p_stripe_charge_id
      AND reversal.stripe_dispute_id = p_stripe_dispute_id
      AND reversal.dispute_status = p_dispute_status
      AND reversal.dispute_reason = p_dispute_reason
      AND reversal.dispute_amount = p_dispute_amount
      AND reversal.currency = p_currency
      AND reversal.stripe_event_created = p_stripe_event_created
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      p_stripe_charge_id,
      NULL,
      'api_tier_dispute_event_identity_conflict',
      'A dispute event id belongs to different API tier reversal identity.',
      pg_catalog.jsonb_build_object(
        'ownership_id', v_ownership.id,
        'dispute_id', p_stripe_dispute_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  v_projection :=
    public.project_api_tier_financial_reversal_atomic(
      v_ownership.id,
      true
    );
  IF COALESCE(v_projection ->> 'status', '') IN (
    'identity_conflict',
    'manual_review'
  ) THEN
    RETURN v_projection;
  END IF;

  RETURN v_projection || pg_catalog.jsonb_build_object(
    'status', 'api_tier',
    'projection_status', v_projection ->> 'status',
    'ownership_id', v_ownership.id
  );
END
$function$;

ALTER FUNCTION public.record_api_tier_dispute_reversal_atomic(
  boolean, text, bigint, text, text, text, bigint, text, text, text,
  text, bigint
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_api_tier_dispute_reversal_atomic(
  boolean, text, bigint, text, text, text, bigint, text, text, text,
  text, bigint
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.record_api_tier_dispute_reversal_atomic(
  boolean, text, bigint, text, text, text, bigint, text, text, text,
  text, bigint
) TO service_role;

CREATE OR REPLACE FUNCTION public.record_charge_refund_tombstone_atomic(
  p_user_id uuid,
  p_stripe_customer_id text,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_captured boolean,
  p_amount_paid bigint,
  p_currency text,
  p_refund_succeeded_amount bigint,
  p_refund_state text,
  p_refund_event_id text,
  p_refund_event_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_record jsonb;
  v_ownership_count integer;
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_claim jsonb;
  v_projection jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  v_record :=
    public.record_charge_refund_tombstone_financial_legacy_v2(
      NULL,
      p_stripe_customer_id,
      p_stripe_payment_intent_id,
      p_stripe_charge_id,
      p_captured,
      p_amount_paid,
      p_currency,
      p_refund_succeeded_amount,
      p_refund_state,
      p_refund_event_id,
      p_refund_event_created_at
    );

  IF COALESCE(v_record ->> 'status', '') IN (
    'identity_conflict',
    'manual_review'
  ) THEN
    RETURN v_record;
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    (pg_catalog.array_agg(ownership.id ORDER BY ownership.id))[1]
  INTO v_ownership_count, v_ownership.id
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.stripe_charge_id = p_stripe_charge_id
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND ownership.stripe_payment_intent_id =
        p_stripe_payment_intent_id
    );

  IF v_ownership_count = 0 THEN
    RETURN v_record || pg_catalog.jsonb_build_object(
      'ownership_status', 'unclassified'
    );
  END IF;

  IF v_ownership_count = 1 THEN
    SELECT ownership.*
    INTO v_ownership
    FROM public.stripe_payment_ownerships AS ownership
    WHERE ownership.id = v_ownership.id;

    IF v_ownership.product_kind = 'api_tier' THEN
      v_projection :=
        public.stripe_resolve_api_tier_refund_tombstone_atomic(
          v_ownership.id
        );
      IF COALESCE(v_projection ->> 'status', '') IN (
        'identity_conflict',
        'manual_review'
      ) THEN
        RETURN v_projection || pg_catalog.jsonb_build_object(
          'record_status', v_record ->> 'status'
        );
      END IF;

      RETURN v_record || pg_catalog.jsonb_build_object(
        'ownership_status', 'already_claimed',
        'ownership_id', v_ownership.id,
        'product_kind', 'api_tier',
        'projection_status', v_projection ->> 'status',
        'api_tier_user_id', v_projection ->> 'user_id',
        'api_tier_customer_id',
          v_projection ->> 'stripe_customer_id',
        'api_tier_subscription_id',
          v_projection ->> 'stripe_subscription_id',
        'api_tier_livemode',
          (v_projection ->> 'livemode')::boolean,
        'api_tier_should_cancel',
          (v_projection ->> 'should_cancel')::boolean
      );
    END IF;
  END IF;

  v_claim := public.claim_stripe_payment_ownership_atomic(
    p_stripe_charge_id,
    p_stripe_payment_intent_id
  );
  IF COALESCE(v_claim ->> 'status', '') IN (
    'identity_conflict',
    'manual_review'
  ) THEN
    RETURN v_claim || pg_catalog.jsonb_build_object(
      'record_status', v_record ->> 'status'
    );
  END IF;

  RETURN v_record || pg_catalog.jsonb_build_object(
    'ownership_status', v_claim ->> 'status',
    'ownership_id', v_claim ->> 'ownership_id',
    'product_kind', v_claim ->> 'product_kind',
    'projection_status', v_claim ->> 'tombstone_status'
  );
END
$function$;

ALTER FUNCTION public.record_charge_refund_tombstone_atomic(
  uuid, text, text, text, boolean, bigint, text, bigint, text, text,
  timestamptz
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION
  public.record_charge_refund_tombstone_with_mode_atomic(
    p_livemode boolean,
    p_user_id uuid,
    p_stripe_customer_id text,
    p_stripe_payment_intent_id text,
    p_stripe_charge_id text,
    p_captured boolean,
    p_amount_paid bigint,
    p_currency text,
    p_refund_succeeded_amount bigint,
    p_refund_state text,
    p_refund_event_id text,
    p_refund_event_created_at timestamptz
  )
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_result jsonb;
  v_event_created bigint;
  v_group_subscription_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  v_event_created :=
    EXTRACT(epoch FROM p_refund_event_created_at)::bigint;
  IF p_livemode IS NULL
    OR p_refund_event_id IS NULL
    OR p_refund_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR p_stripe_charge_id IS NULL
    OR p_stripe_charge_id !~ '^ch_[A-Za-z0-9_]+$'
    OR p_refund_event_created_at IS NULL
    OR v_event_created <= 0
    OR v_event_created > 253402300799
  THEN
    RAISE EXCEPTION 'mode-aware refund observation is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_charge_refund_observation_modes AS observation
    WHERE observation.stripe_event_id = p_refund_event_id
      AND (
        observation.livemode IS DISTINCT FROM p_livemode
        OR observation.stripe_charge_id <> p_stripe_charge_id
        OR observation.stripe_event_created <> v_event_created
      )
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      p_stripe_charge_id,
      p_user_id,
      'stripe_refund_livemode_identity_conflict',
      'A refund event replay changed its Stripe mode or Charge identity.',
      pg_catalog.jsonb_build_object(
        'event_id', p_refund_event_id,
        'livemode', p_livemode
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  INSERT INTO public.stripe_charge_refund_observation_modes (
    livemode,
    stripe_event_id,
    stripe_charge_id,
    stripe_event_created
  ) VALUES (
    p_livemode,
    p_refund_event_id,
    p_stripe_charge_id,
    v_event_created
  )
  ON CONFLICT (livemode, stripe_event_id) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1
    FROM public.stripe_charge_refund_observation_modes AS observation
    WHERE observation.livemode = p_livemode
      AND observation.stripe_event_id = p_refund_event_id
      AND observation.stripe_charge_id = p_stripe_charge_id
      AND observation.stripe_event_created = v_event_created
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  v_result := public.record_charge_refund_tombstone_atomic(
    p_user_id,
    p_stripe_customer_id,
    p_stripe_payment_intent_id,
    p_stripe_charge_id,
    p_captured,
    p_amount_paid,
    p_currency,
    p_refund_succeeded_amount,
    p_refund_state,
    p_refund_event_id,
    p_refund_event_created_at
  );

  -- The legacy resolver deliberately opens a durable review before revoking a
  -- paid group pass. Return the immutable subscription identity to the
  -- webhook so it can invoke the existing exact revocation RPC. Never make
  -- the application infer this UUID from mutable membership or subscription
  -- rows.
  IF COALESCE(v_result ->> 'status', '') = 'manual_review'
    AND COALESCE(v_result ->> 'product_kind', '') = 'group_pass'
    AND COALESCE(v_result ->> 'reason_key', '') =
      'group_pass_full_refund_revocation_required'
  THEN
    SELECT consumption.subscription_id
    INTO v_group_subscription_id
    FROM public.stripe_payment_ownerships AS ownership
    JOIN public.group_payment_consumptions AS consumption
      ON consumption.id = ownership.ledger_id
    WHERE ownership.id::text = v_result ->> 'ownership_id'
      AND ownership.product_kind = 'group_pass'
      AND ownership.stripe_charge_id = p_stripe_charge_id
      AND ownership.stripe_customer_id = p_stripe_customer_id
      AND ownership.stripe_payment_intent_id
        IS NOT DISTINCT FROM p_stripe_payment_intent_id
      AND ownership.amount_paid = p_amount_paid
      AND ownership.currency = pg_catalog.lower(p_currency)
      AND consumption.stripe_charge_id = p_stripe_charge_id
      AND consumption.stripe_customer_id = p_stripe_customer_id
      AND consumption.outcome IN ('activated', 'renewed');

    IF v_group_subscription_id IS NULL THEN
      RAISE EXCEPTION
        'group pass full refund has no exact immutable subscription identity'
        USING ERRCODE = '23514';
    END IF;

    v_result := v_result || pg_catalog.jsonb_build_object(
      'group_pass_subscription_id', v_group_subscription_id
    );
  END IF;

  IF COALESCE(v_result ->> 'product_kind', '') = 'api_tier'
    AND COALESCE((v_result ->> 'api_tier_livemode')::boolean, NOT p_livemode)
      IS DISTINCT FROM p_livemode
  THEN
    RAISE EXCEPTION 'API tier refund Stripe mode mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN v_result;
END
$function$;

ALTER FUNCTION
  public.record_charge_refund_tombstone_with_mode_atomic(
    boolean, uuid, text, text, text, boolean, bigint, text, bigint,
    text, text, timestamptz
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.record_charge_refund_tombstone_with_mode_atomic(
    boolean, uuid, text, text, text, boolean, bigint, text, bigint,
    text, text, timestamptz
  )
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.record_charge_refund_tombstone_with_mode_atomic(
    boolean, uuid, text, text, text, boolean, bigint, text, bigint,
    text, text, timestamptz
  )
  TO service_role;

CREATE OR REPLACE FUNCTION public.claim_api_tier_reversal_actions_atomic(
  p_worker_token uuid,
  p_limit integer,
  p_lease_seconds integer,
  p_livemode boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_worker_token IS NULL
    OR p_limit IS NULL
    OR p_limit NOT BETWEEN 1 AND 100
    OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 30 AND 900
    OR p_livemode IS NULL
  THEN
    RAISE EXCEPTION 'API tier reversal action claim input is invalid'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT action.id
    FROM public.api_tier_reversal_actions AS action
    WHERE action.livemode = p_livemode
      AND (
        (
          action.state = 'pending'
          AND action.next_attempt_at <= pg_catalog.clock_timestamp()
        )
        OR (
          action.state = 'leased'
          AND action.lease_expires_at <= pg_catalog.clock_timestamp()
        )
      )
    ORDER BY action.next_attempt_at, action.created_at, action.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ),
  claimed AS (
    UPDATE public.api_tier_reversal_actions AS action
    SET
      state = 'leased',
      attempts = action.attempts + 1,
      lease_token = p_worker_token,
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      last_error = CASE
        WHEN action.state = 'leased'
          THEN COALESCE(action.last_error, 'expired lease reclaimed')
        ELSE action.last_error
      END,
      updated_at = pg_catalog.clock_timestamp()
    FROM candidates
    WHERE action.id = candidates.id
    RETURNING
      action.id,
      action.ownership_id,
      action.livemode,
      action.user_id,
      action.stripe_customer_id,
      action.stripe_subscription_id,
      action.attempts,
      action.lease_token,
      action.lease_expires_at
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'id', claimed.id,
        'ownership_id', claimed.ownership_id,
        'livemode', claimed.livemode,
        'user_id', claimed.user_id,
        'stripe_customer_id', claimed.stripe_customer_id,
        'stripe_subscription_id',
          claimed.stripe_subscription_id,
        'attempts', claimed.attempts,
        'lease_token', claimed.lease_token,
        'lease_expires_at', claimed.lease_expires_at
      )
      ORDER BY claimed.id
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM claimed;

  RETURN v_result;
END
$function$;

ALTER FUNCTION public.claim_api_tier_reversal_actions_atomic(
  uuid, integer, integer, boolean
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.claim_api_tier_reversal_actions_atomic(
  uuid, integer, integer, boolean
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.claim_api_tier_reversal_actions_atomic(
  uuid, integer, integer, boolean
) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_api_tier_reversal_action_atomic(
  p_action_id uuid,
  p_lease_token uuid,
  p_succeeded boolean,
  p_disposition text,
  p_error text,
  p_retry_after_seconds integer
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_action public.api_tier_reversal_actions%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_action_id IS NULL
    OR p_lease_token IS NULL
    OR p_succeeded IS NULL
    OR (
      p_succeeded
      AND (
        p_disposition NOT IN (
          'canceled',
          'already_canceled',
          'resource_missing'
        )
        OR p_error IS NOT NULL
      )
    )
    OR (
      NOT p_succeeded
      AND (
        p_disposition IS NOT NULL
        OR p_error IS NULL
        OR pg_catalog.length(p_error) NOT BETWEEN 1 AND 2000
        OR p_retry_after_seconds IS NULL
        OR p_retry_after_seconds NOT BETWEEN 5 AND 86400
      )
    )
  THEN
    RAISE EXCEPTION 'API tier reversal action finish input is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT action.*
  INTO v_action
  FROM public.api_tier_reversal_actions AS action
  WHERE action.id = p_action_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_action.state = 'completed' THEN
    IF p_succeeded
      AND v_action.completed_disposition = p_disposition
    THEN
      RETURN 'already_completed';
    END IF;
    RETURN 'lease_lost';
  END IF;
  IF v_action.state <> 'leased'
    OR v_action.lease_token <> p_lease_token
  THEN
    RETURN 'lease_lost';
  END IF;

  IF p_succeeded THEN
    UPDATE public.api_tier_reversal_actions
    SET
      state = 'completed',
      lease_token = NULL,
      lease_expires_at = NULL,
      completed_disposition = p_disposition,
      completed_at = pg_catalog.clock_timestamp(),
      last_error = NULL,
      updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_action_id;
    RETURN 'completed';
  END IF;

  UPDATE public.api_tier_reversal_actions
  SET
    state = 'pending',
    next_attempt_at = pg_catalog.clock_timestamp()
      + pg_catalog.make_interval(secs => p_retry_after_seconds),
    lease_token = NULL,
    lease_expires_at = NULL,
    last_error = pg_catalog.left(p_error, 2000),
    updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_action_id;
  RETURN 'retry_scheduled';
END
$function$;

ALTER FUNCTION public.finish_api_tier_reversal_action_atomic(
  uuid, uuid, boolean, text, text, integer
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.finish_api_tier_reversal_action_atomic(
  uuid, uuid, boolean, text, text, integer
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.finish_api_tier_reversal_action_atomic(
  uuid, uuid, boolean, text, text, integer
) TO service_role;

CREATE OR REPLACE FUNCTION
  public.claim_api_tier_payment_backfill_targets_atomic(
    p_worker_token uuid,
    p_limit integer,
    p_lease_seconds integer,
    p_livemode boolean
  )
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_worker_token IS NULL
    OR p_limit IS NULL
    OR p_limit NOT BETWEEN 1 AND 25
    OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 60 AND 900
    OR p_livemode IS NULL
  THEN
    RAISE EXCEPTION 'API tier payment backfill claim input is invalid'
      USING ERRCODE = '22023';
  END IF;

  WITH candidates AS (
    SELECT target.livemode, target.stripe_subscription_id
    FROM public.api_tier_payment_backfill_targets AS target
    WHERE target.livemode = p_livemode
      AND (
        target.state = 'pending'
        OR (
          target.state = 'leased'
          AND target.lease_expires_at <= pg_catalog.clock_timestamp()
        )
      )
    ORDER BY target.created_at, target.stripe_subscription_id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ),
  claimed AS (
    UPDATE public.api_tier_payment_backfill_targets AS target
    SET
      state = 'leased',
      lease_token = p_worker_token,
      lease_expires_at = pg_catalog.clock_timestamp()
        + pg_catalog.make_interval(secs => p_lease_seconds),
      last_error = CASE
        WHEN target.state = 'leased'
          THEN COALESCE(target.last_error, 'expired lease reclaimed')
        ELSE target.last_error
      END,
      updated_at = pg_catalog.clock_timestamp()
    FROM candidates
    WHERE target.livemode = candidates.livemode
      AND target.stripe_subscription_id =
        candidates.stripe_subscription_id
    RETURNING
      target.livemode,
      target.stripe_subscription_id,
      target.user_id,
      target.stripe_customer_id,
      target.scanned_invoice_count,
      target.last_invoice_id,
      target.lease_token,
      target.lease_expires_at
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object(
        'livemode', claimed.livemode,
        'stripe_subscription_id', claimed.stripe_subscription_id,
        'user_id', claimed.user_id,
        'stripe_customer_id', claimed.stripe_customer_id,
        'scanned_invoice_count', claimed.scanned_invoice_count,
        'last_invoice_id', claimed.last_invoice_id,
        'lease_token', claimed.lease_token,
        'lease_expires_at', claimed.lease_expires_at
      )
      ORDER BY claimed.stripe_subscription_id
    ),
    '[]'::jsonb
  )
  INTO v_result
  FROM claimed;

  RETURN v_result;
END
$function$;

ALTER FUNCTION
  public.claim_api_tier_payment_backfill_targets_atomic(
    uuid, integer, integer, boolean
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.claim_api_tier_payment_backfill_targets_atomic(
    uuid, integer, integer, boolean
  )
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.claim_api_tier_payment_backfill_targets_atomic(
    uuid, integer, integer, boolean
  )
  TO service_role;

CREATE OR REPLACE FUNCTION
  public.checkpoint_api_tier_payment_backfill_target_atomic(
    p_livemode boolean,
    p_stripe_subscription_id text,
    p_lease_token uuid,
    p_last_invoice_id text,
    p_scanned_delta integer,
    p_lease_seconds integer
  )
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_target public.api_tier_payment_backfill_targets%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR p_lease_token IS NULL
    OR p_last_invoice_id IS NULL
    OR p_last_invoice_id !~ '^in_[A-Za-z0-9_]+$'
    OR p_scanned_delta IS NULL
    OR p_scanned_delta NOT BETWEEN 1 AND 100
    OR p_lease_seconds IS NULL
    OR p_lease_seconds NOT BETWEEN 60 AND 900
  THEN
    RAISE EXCEPTION 'API tier payment backfill checkpoint input is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT target.*
  INTO v_target
  FROM public.api_tier_payment_backfill_targets AS target
  WHERE target.livemode = p_livemode
    AND target.stripe_subscription_id = p_stripe_subscription_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_target.state <> 'leased'
    OR v_target.lease_token <> p_lease_token
    OR v_target.lease_expires_at <= pg_catalog.clock_timestamp()
  THEN
    RETURN 'lease_lost';
  END IF;

  UPDATE public.api_tier_payment_backfill_targets
  SET
    scanned_invoice_count =
      scanned_invoice_count + p_scanned_delta,
    last_invoice_id = p_last_invoice_id,
    lease_expires_at = pg_catalog.clock_timestamp()
      + pg_catalog.make_interval(secs => p_lease_seconds),
    last_error = NULL,
    updated_at = pg_catalog.clock_timestamp()
  WHERE livemode = p_livemode
    AND stripe_subscription_id = p_stripe_subscription_id;
  RETURN 'checkpointed';
END
$function$;

ALTER FUNCTION
  public.checkpoint_api_tier_payment_backfill_target_atomic(
    boolean, text, uuid, text, integer, integer
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.checkpoint_api_tier_payment_backfill_target_atomic(
    boolean, text, uuid, text, integer, integer
  )
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.checkpoint_api_tier_payment_backfill_target_atomic(
    boolean, text, uuid, text, integer, integer
  )
  TO service_role;

CREATE OR REPLACE FUNCTION
  public.finish_api_tier_payment_backfill_target_atomic(
    p_livemode boolean,
    p_stripe_subscription_id text,
    p_lease_token uuid,
    p_succeeded boolean,
    p_requires_attention boolean,
    p_error text
  )
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_target public.api_tier_payment_backfill_targets%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_livemode IS NULL
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR p_lease_token IS NULL
    OR p_succeeded IS NULL
    OR p_requires_attention IS NULL
    OR (
      p_succeeded
      AND (p_requires_attention OR p_error IS NOT NULL)
    )
    OR (
      NOT p_succeeded
      AND (
        p_error IS NULL
        OR pg_catalog.length(p_error) NOT BETWEEN 1 AND 2000
      )
    )
  THEN
    RAISE EXCEPTION 'API tier payment backfill finish input is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT target.*
  INTO v_target
  FROM public.api_tier_payment_backfill_targets AS target
  WHERE target.livemode = p_livemode
    AND target.stripe_subscription_id = p_stripe_subscription_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF v_target.state = 'complete' AND p_succeeded THEN
    RETURN 'already_completed';
  END IF;
  IF v_target.state <> 'leased'
    OR v_target.lease_token <> p_lease_token
  THEN
    RETURN 'lease_lost';
  END IF;

  IF p_succeeded THEN
    UPDATE public.api_tier_payment_backfill_targets
    SET
      state = 'complete',
      lease_token = NULL,
      lease_expires_at = NULL,
      completed_at = pg_catalog.clock_timestamp(),
      last_error = NULL,
      updated_at = pg_catalog.clock_timestamp()
    WHERE livemode = p_livemode
      AND stripe_subscription_id = p_stripe_subscription_id;
    RETURN 'completed';
  END IF;

  UPDATE public.api_tier_payment_backfill_targets
  SET
    state = CASE
      WHEN p_requires_attention THEN 'attention'
      ELSE 'pending'
    END,
    lease_token = NULL,
    lease_expires_at = NULL,
    completed_at = NULL,
    last_error = pg_catalog.left(p_error, 2000),
    updated_at = pg_catalog.clock_timestamp()
  WHERE livemode = p_livemode
    AND stripe_subscription_id = p_stripe_subscription_id;
  RETURN CASE
    WHEN p_requires_attention THEN 'attention'
    ELSE 'retry_scheduled'
  END;
END
$function$;

ALTER FUNCTION
  public.finish_api_tier_payment_backfill_target_atomic(
    boolean, text, uuid, boolean, boolean, text
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.finish_api_tier_payment_backfill_target_atomic(
    boolean, text, uuid, boolean, boolean, text
  )
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.finish_api_tier_payment_backfill_target_atomic(
    boolean, text, uuid, boolean, boolean, text
  )
  TO service_role;

CREATE OR REPLACE FUNCTION public.stripe_refund_tombstone_is_resolved_v2(
  p_stripe_charge_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_stripe_charge_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstones AS tombstone
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.id = tombstone.resolution_ownership_id
      WHERE tombstone.stripe_charge_id = p_stripe_charge_id
        AND ownership.stripe_charge_id = tombstone.stripe_charge_id
        AND ownership.stripe_customer_id = tombstone.stripe_customer_id
        AND ownership.stripe_payment_intent_id
          IS NOT DISTINCT FROM tombstone.stripe_payment_intent_id
        AND ownership.amount_paid = tombstone.amount_paid
        AND ownership.currency = tombstone.currency
        AND tombstone.captured
        AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
        AND EXISTS (
          SELECT 1
          FROM public.stripe_charge_refund_tombstone_events AS snapshot_event
          WHERE snapshot_event.event_id =
              tombstone.refund_snapshot_event_id
            AND snapshot_event.stripe_charge_id =
              tombstone.stripe_charge_id
            AND snapshot_event.event_created_at =
              tombstone.refund_snapshot_event_created_at
            AND snapshot_event.observations @>
              pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                  'refund_state', tombstone.refund_state,
                  'refund_succeeded_amount',
                    tombstone.refund_succeeded_amount
                )
              )
        )
        AND EXISTS (
          SELECT 1
          FROM public.stripe_charge_refund_tombstone_events AS latest_event
          WHERE latest_event.event_id = tombstone.latest_refund_event_id
            AND latest_event.stripe_charge_id =
              tombstone.stripe_charge_id
            AND latest_event.event_created_at =
              tombstone.latest_refund_event_created_at
        )
        AND (
          (
            tombstone.resolution_kind = 'entitlement_payment'
            AND ownership.product_kind = 'pro_entitlement'
            AND tombstone.merged_payment_id = ownership.ledger_id
            AND NOT EXISTS (
              SELECT 1
              FROM public.stripe_charge_refund_tombstone_events
                AS tombstone_event
              WHERE tombstone_event.stripe_charge_id =
                  tombstone.stripe_charge_id
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.stripe_entitlement_refund_events
                    AS refund_event
                  WHERE refund_event.event_id =
                      tombstone_event.event_id
                    AND refund_event.entitlement_payment_id =
                      ownership.ledger_id
                    AND refund_event.event_created_at =
                      tombstone_event.event_created_at
                    AND refund_event.observations @>
                      tombstone_event.observations
                )
            )
          )
          OR (
            tombstone.resolution_kind = 'non_entitlement_payment'
            AND ownership.product_kind IN ('tip', 'group_pass')
            AND tombstone.merged_payment_id IS NULL
            AND (
              NOT (
                tombstone.refund_state = 'succeeded'
                AND tombstone.refund_succeeded_amount >=
                  tombstone.amount_paid
              )
              OR (
                ownership.product_kind = 'tip'
                AND EXISTS (
                  SELECT 1
                  FROM public.tips AS tip
                  WHERE tip.id = ownership.ledger_id
                    AND tip.status = 'refunded'
                )
              )
              OR (
                ownership.product_kind = 'group_pass'
                AND (
                  EXISTS (
                    SELECT 1
                    FROM public.group_payment_consumptions AS consumption
                    WHERE consumption.id = ownership.ledger_id
                      AND consumption.outcome = 'refund_blocked'
                      AND consumption.result ->> 'status' =
                        'refund_observed'
                  )
                  OR public.group_pass_full_refund_revocation_is_effective_v2(
                    ownership.id
                  )
                )
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.stripe_charge_refund_tombstone_events
                AS tombstone_event
              JOIN public.stripe_entitlement_refund_events AS refund_event
                ON refund_event.event_id = tombstone_event.event_id
              WHERE tombstone_event.stripe_charge_id =
                  tombstone.stripe_charge_id
            )
          )
          OR (
            tombstone.resolution_kind = 'api_tier_payment'
            AND ownership.product_kind = 'api_tier'
            AND tombstone.merged_payment_id IS NULL
            AND EXISTS (
              SELECT 1
              FROM public.stripe_api_tier_payments AS payment
              WHERE payment.id = ownership.ledger_id
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.stripe_charge_refund_tombstone_events
                    AS tombstone_event
                  WHERE tombstone_event.stripe_charge_id =
                      tombstone.stripe_charge_id
                    AND NOT EXISTS (
                      SELECT 1
                      FROM public.stripe_api_tier_reversal_events
                        AS reversal
                      WHERE reversal.livemode = payment.livemode
                        AND reversal.stripe_event_id =
                          tombstone_event.event_id
                        AND reversal.ownership_id = ownership.id
                        AND reversal.reversal_kind = 'refund'
                        AND reversal.stripe_charge_id =
                          tombstone.stripe_charge_id
                        AND reversal.refund_state =
                          tombstone_event.refund_state
                        AND reversal.refund_succeeded_amount =
                          tombstone_event.refund_succeeded_amount
                        AND reversal.currency = tombstone.currency
                        AND reversal.stripe_event_created =
                          EXTRACT(
                            epoch FROM tombstone_event.event_created_at
                          )::bigint
                    )
                )
                AND (
                  tombstone.refund_succeeded_amount = 0
                  OR (
                    EXISTS (
                      SELECT 1
                      FROM public.api_tier_subscription_blocks AS block
                      WHERE block.livemode = payment.livemode
                        AND block.stripe_subscription_id =
                          payment.stripe_subscription_id
                        AND block.block_kind = 'financial_reversal'
                        AND block.user_id = payment.user_id
                        AND block.stripe_customer_id =
                          payment.stripe_customer_id
                    )
                    AND EXISTS (
                      SELECT 1
                      FROM public.api_tier_reversal_actions AS action
                      WHERE action.livemode = payment.livemode
                        AND action.stripe_subscription_id =
                          payment.stripe_subscription_id
                        AND action.user_id = payment.user_id
                        AND action.stripe_customer_id =
                          payment.stripe_customer_id
                        AND action.state = 'completed'
                    )
                  )
                )
            )
          )
        )
    )
$function$;

ALTER FUNCTION public.stripe_refund_tombstone_is_resolved_v2(text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_refund_tombstone_is_resolved_v2(text)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- Every legacy Stripe-subscription synchronizer must converge through this
-- one atomic projection writer. A still-active Stripe Subscription is not
-- financial authority after its current bound/latest paid period was fully
-- refunded. A later, unrefunded payment can become current only through the
-- paid-Invoice activation RPC, which replaces entitlement_payment_id first.
CREATE OR REPLACE FUNCTION
  public.sync_recurring_pro_subscription_projection_atomic(
    p_user_id uuid,
    p_status text,
    p_stripe_subscription_id text,
    p_stripe_customer_id text,
    p_plan text,
    p_period_start timestamptz,
    p_period_end timestamptz,
    p_cancel_at_period_end boolean
  )
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_profile public.user_profiles%ROWTYPE;
  v_subscription public.subscriptions%ROWTYPE;
  v_bound_payment public.stripe_entitlement_payments%ROWTYPE;
  v_latest_payment public.stripe_entitlement_payments%ROWTYPE;
  v_blocking_payment public.stripe_entitlement_payments%ROWTYPE;
  v_stored_status text;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_status IS NULL
    OR p_status NOT IN (
      'active',
      'trialing',
      'past_due',
      'canceled',
      'expired',
      'incomplete',
      'incomplete_expired',
      'paused',
      'unpaid'
    )
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_plan IS NULL
    OR p_plan NOT IN ('monthly', 'yearly')
    OR p_period_start IS NULL
    OR (
      p_period_end IS NOT NULL
      AND p_period_end <= p_period_start
    )
    OR p_cancel_at_period_end IS NULL
  THEN
    RAISE EXCEPTION 'recurring Pro subscription projection input is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND OR v_profile.deleted_at IS NOT NULL THEN
    RETURN 'subject_deleted';
  END IF;
  IF v_profile.stripe_customer_id IS NOT NULL
    AND v_profile.stripe_customer_id <> p_stripe_customer_id
  THEN
    RAISE EXCEPTION 'recurring Pro customer ownership changed'
      USING ERRCODE = '23514';
  END IF;

  SELECT subscription.*
  INTO v_subscription
  FROM public.subscriptions AS subscription
  WHERE subscription.user_id = p_user_id
  FOR UPDATE;

  IF v_subscription.id IS NOT NULL
    AND v_subscription.stripe_subscription_id IS DISTINCT FROM
      p_stripe_subscription_id
    AND v_subscription.status IN ('active', 'trialing')
  THEN
    RETURN 'stale_current_subscription';
  END IF;

  IF v_subscription.id IS NOT NULL
    AND v_subscription.stripe_subscription_id =
      p_stripe_subscription_id
    AND v_subscription.entitlement_payment_id IS NOT NULL
  THEN
    SELECT payment.*
    INTO v_bound_payment
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.id = v_subscription.entitlement_payment_id
    FOR SHARE;
    IF NOT FOUND
      OR v_bound_payment.payment_kind <> 'recurring'
      OR v_bound_payment.user_id IS DISTINCT FROM p_user_id
      OR v_bound_payment.stripe_customer_id <>
        p_stripe_customer_id
      OR v_bound_payment.stripe_subscription_id <>
        p_stripe_subscription_id
    THEN
      RAISE EXCEPTION 'bound recurring Pro payment identity drifted'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT payment.*
  INTO v_latest_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.payment_kind = 'recurring'
    AND payment.user_id = p_user_id
    AND payment.stripe_customer_id = p_stripe_customer_id
    AND payment.stripe_subscription_id =
      p_stripe_subscription_id
    AND payment.payment_status = 'paid'
  ORDER BY
    payment.period_start DESC,
    payment.created_at DESC,
    payment.id DESC
  LIMIT 1
  FOR SHARE;

  IF p_status IN ('active', 'trialing') THEN
    IF v_bound_payment.id IS NOT NULL
      AND v_bound_payment.refund_state = 'succeeded'
      AND v_bound_payment.refund_succeeded_amount >=
        v_bound_payment.amount_paid
    THEN
      v_blocking_payment := v_bound_payment;
    ELSIF v_bound_payment.id IS NULL
      AND v_latest_payment.id IS NOT NULL
      AND v_latest_payment.refund_state = 'succeeded'
      AND v_latest_payment.refund_succeeded_amount >=
        v_latest_payment.amount_paid
    THEN
      v_blocking_payment := v_latest_payment;
    END IF;
  END IF;

  IF v_blocking_payment.id IS NOT NULL THEN
    IF v_subscription.id IS NULL THEN
      INSERT INTO public.subscriptions (
        user_id,
        stripe_subscription_id,
        stripe_customer_id,
        status,
        tier,
        plan,
        current_period_start,
        current_period_end,
        cancel_at_period_end,
        canceled_at,
        entitlement_payment_id,
        updated_at
      ) VALUES (
        p_user_id,
        p_stripe_subscription_id,
        p_stripe_customer_id,
        'canceled',
        'pro',
        p_plan,
        p_period_start,
        p_period_end,
        false,
        v_now,
        v_blocking_payment.id,
        v_now
      );
    ELSIF v_subscription.stripe_subscription_id =
      p_stripe_subscription_id
    THEN
      UPDATE public.subscriptions
      SET
        status = 'canceled',
        cancel_at_period_end = false,
        canceled_at = COALESCE(canceled_at, v_now),
        entitlement_payment_id = v_blocking_payment.id,
        entitlement_trial_id = NULL,
        entitlement_trial_verified_at = NULL,
        updated_at = v_now
      WHERE id = v_subscription.id;
    END IF;

    UPDATE public.user_profiles
    SET
      stripe_customer_id = p_stripe_customer_id,
      updated_at = v_now
    WHERE id = p_user_id;
    PERFORM public.sync_current_pro_projection_atomic(p_user_id);
    RETURN 'blocked_full_refund';
  END IF;

  v_stored_status := CASE
    WHEN p_status IN (
      'active',
      'trialing',
      'past_due',
      'canceled',
      'expired'
    )
    THEN p_status
    WHEN p_status = 'incomplete_expired' THEN 'expired'
    ELSE 'past_due'
  END;

  INSERT INTO public.subscriptions (
    user_id,
    stripe_subscription_id,
    stripe_customer_id,
    status,
    tier,
    plan,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    canceled_at,
    entitlement_payment_id,
    updated_at
  ) VALUES (
    p_user_id,
    p_stripe_subscription_id,
    p_stripe_customer_id,
    v_stored_status,
    'pro',
    p_plan,
    p_period_start,
    p_period_end,
    p_cancel_at_period_end,
    CASE
      WHEN v_stored_status IN ('active', 'trialing') THEN NULL
      ELSE v_now
    END,
    CASE
      WHEN v_subscription.stripe_subscription_id =
        p_stripe_subscription_id
      THEN v_subscription.entitlement_payment_id
      ELSE NULL
    END,
    v_now
  )
  ON CONFLICT (user_id) DO UPDATE SET
    stripe_subscription_id =
      EXCLUDED.stripe_subscription_id,
    stripe_customer_id = EXCLUDED.stripe_customer_id,
    status = EXCLUDED.status,
    tier = EXCLUDED.tier,
    plan = EXCLUDED.plan,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end = EXCLUDED.current_period_end,
    cancel_at_period_end =
      EXCLUDED.cancel_at_period_end,
    canceled_at = EXCLUDED.canceled_at,
    entitlement_payment_id =
      EXCLUDED.entitlement_payment_id,
    updated_at = v_now;

  UPDATE public.user_profiles
  SET
    stripe_customer_id = p_stripe_customer_id,
    updated_at = v_now
  WHERE id = p_user_id;
  PERFORM public.sync_current_pro_projection_atomic(p_user_id);
  RETURN 'updated';
END
$function$;

ALTER FUNCTION
  public.sync_recurring_pro_subscription_projection_atomic(
    uuid, text, text, text, text, timestamptz, timestamptz, boolean
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.sync_recurring_pro_subscription_projection_atomic(
    uuid, text, text, text, text, timestamptz, timestamptz, boolean
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.sync_recurring_pro_subscription_projection_atomic(
    uuid, text, text, text, text, timestamptz, timestamptz, boolean
  )
TO service_role;

DO $rename_readiness$
BEGIN
  IF pg_catalog.to_regprocedure(
      'public.stripe_paid_launch_readiness_pre_api_tier_v2()'
    ) IS NULL
  THEN
    ALTER FUNCTION public.stripe_paid_launch_readiness_v2()
      RENAME TO stripe_paid_launch_readiness_pre_api_tier_v2;
  END IF;
END
$rename_readiness$;

REVOKE ALL ON FUNCTION
  public.stripe_paid_launch_readiness_pre_api_tier_v2()
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.stripe_paid_launch_readiness_v2()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_base jsonb;
  v_api_payment_ownership_anomalies integer;
  v_api_backfill_incomplete integer;
  v_api_reversal_actions_incomplete integer;
  v_authority_drift integer;
  v_ready boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  v_base :=
    public.stripe_paid_launch_readiness_pre_api_tier_v2();

  SELECT pg_catalog.count(*)::integer
  INTO v_api_payment_ownership_anomalies
  FROM public.stripe_api_tier_payments AS payment
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.stripe_payment_ownerships AS ownership
    WHERE ownership.product_kind = 'api_tier'
      AND ownership.ledger_id = payment.id
      AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
  );

  SELECT pg_catalog.count(*)::integer
  INTO v_api_backfill_incomplete
  FROM public.api_tier_payment_backfill_targets AS target
  WHERE target.state <> 'complete';

  SELECT pg_catalog.count(*)::integer
  INTO v_api_reversal_actions_incomplete
  FROM public.api_tier_reversal_actions AS action
  WHERE action.state <> 'completed';

  v_authority_drift :=
    COALESCE((v_base ->> 'authority_drift')::integer, -1)
      + v_api_payment_ownership_anomalies;

  v_ready :=
    COALESCE(v_base ->> 'status', '') = 'ready'
    AND v_api_payment_ownership_anomalies = 0
    AND v_api_backfill_incomplete = 0
    AND v_api_reversal_actions_incomplete = 0;

  RETURN v_base || pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_ready THEN 'ready' ELSE 'blocked' END,
    'authority_drift', v_authority_drift,
    'api_tier_payment_ownership_anomalies',
      v_api_payment_ownership_anomalies,
    'api_tier_payment_backfill_incomplete',
      v_api_backfill_incomplete,
    'api_tier_reversal_actions_incomplete',
      v_api_reversal_actions_incomplete
  );
END
$function$;

ALTER FUNCTION public.stripe_paid_launch_readiness_v2()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_paid_launch_readiness_v2()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION public.stripe_paid_launch_readiness_v2()
  TO service_role;

DO $postflight$
DECLARE
  v_postgres oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.stripe_api_tier_payments',
      'public.stripe_api_tier_payment_events',
      'public.stripe_charge_refund_observation_modes',
      'public.stripe_api_tier_reversal_events',
      'public.api_tier_reversal_actions',
      'public.api_tier_payment_backfill_targets'
    ]::text[]) AS required_table(relation_name)
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.oid =
        pg_catalog.to_regclass(required_table.relation_name)
    WHERE relation.oid IS NULL
      OR relation.relkind <> 'r'
      OR relation.relowner <> v_postgres
      OR NOT relation.relrowsecurity
      OR relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION
      'API tier payment reversal relation postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'public.stripe_api_tier_payments'::pg_catalog.regclass,
      'public.stripe_api_tier_payment_events'::pg_catalog.regclass,
      'public.stripe_charge_refund_observation_modes'::pg_catalog.regclass,
      'public.stripe_api_tier_reversal_events'::pg_catalog.regclass,
      'public.api_tier_reversal_actions'::pg_catalog.regclass,
      'public.api_tier_payment_backfill_targets'::pg_catalog.regclass
    )
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid IN (
        pg_catalog.to_regclass('auth.users'),
        'public.user_profiles'::pg_catalog.regclass
      )
  ) THEN
    RAISE EXCEPTION
      'financial history must not depend on deletable subject rows';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.record_api_tier_payment_atomic(uuid,boolean,text,uuid,text,text,text,text,text,text,text,bigint,text,bigint,bigint,bigint,bigint,text,bigint,text)',
      'public.record_api_tier_dispute_reversal_atomic(boolean,text,bigint,text,text,text,bigint,text,text,text,text,bigint)',
      'public.record_charge_refund_tombstone_with_mode_atomic(boolean,uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)',
      'public.claim_api_tier_reversal_actions_atomic(uuid,integer,integer,boolean)',
      'public.finish_api_tier_reversal_action_atomic(uuid,uuid,boolean,text,text,integer)',
      'public.claim_api_tier_payment_backfill_targets_atomic(uuid,integer,integer,boolean)',
      'public.checkpoint_api_tier_payment_backfill_target_atomic(boolean,text,uuid,text,integer,integer)',
      'public.finish_api_tier_payment_backfill_target_atomic(boolean,text,uuid,boolean,boolean,text)',
      'public.sync_recurring_pro_subscription_projection_atomic(uuid,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean)',
      'public.stripe_paid_launch_readiness_v2()'
    ]::text[]) AS required_routine(signature)
    LEFT JOIN pg_catalog.pg_proc AS routine
      ON routine.oid =
        pg_catalog.to_regprocedure(required_routine.signature)
    WHERE routine.oid IS NULL
      OR routine.proowner <> v_postgres
      OR NOT routine.prosecdef
  ) THEN
    RAISE EXCEPTION
      'API tier payment reversal routine postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.stripe_api_tier_payments',
      'public.stripe_api_tier_payment_events',
      'public.stripe_charge_refund_observation_modes',
      'public.stripe_api_tier_reversal_events',
      'public.api_tier_reversal_actions',
      'public.api_tier_payment_backfill_targets'
    ]::text[]) AS protected_table(relation_name)
    CROSS JOIN pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator']::text[]
    ) AS blocked_role(role_name)
    WHERE pg_catalog.has_table_privilege(
      blocked_role.role_name,
      protected_table.relation_name,
      'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
  ) THEN
    RAISE EXCEPTION
      'API tier financial tables expose an unreviewed ACL';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.stripe_api_tier_payments',
      'public.stripe_api_tier_payment_events',
      'public.stripe_charge_refund_observation_modes',
      'public.stripe_api_tier_reversal_events',
      'public.api_tier_reversal_actions',
      'public.api_tier_payment_backfill_targets'
    ]::text[]) AS protected_table(relation_name)
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid =
        protected_table.relation_name::pg_catalog.regclass
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS privilege
    WHERE privilege.grantee = 0
  ) THEN
    RAISE EXCEPTION
      'API tier financial tables expose PUBLIC privileges';
  END IF;
END
$postflight$;

COMMIT;
