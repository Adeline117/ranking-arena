-- Give API-tier paid Invoices an immutable money authority.  Subscription
-- snapshots and paid Invoice events are independently delivered by Stripe;
-- this migration makes either order converge while account recovery wins the
-- admission race.  A blocked payment is recorded and centrally owned, but it
-- can only create refund/cancellation outbox work -- never quota.

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL idle_in_transaction_session_timeout = '30s';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.api-tier-recovery-payment-authority:v1',
    0
  )
);

DO $preflight$
DECLARE
  v_postgres oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
  v_service oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
  v_effect_source_constraint text;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
    OR v_postgres IS NULL
    OR v_service IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(
        ARRAY['anon', 'authenticated', 'authenticator']::name[]
      ) AS required_role(role_name)
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.rolname = required_role.role_name
      WHERE role_row.oid IS NULL
    )
  THEN
    RAISE EXCEPTION
      'API-tier recovery payment authority requires PostgreSQL 17 and standard Supabase roles';
  END IF;

  IF pg_catalog.to_regprocedure(
      'public.apply_user_api_tier_stripe_event(uuid,uuid,uuid,text,uuid,text,text,integer,text,bigint,text,bigint,boolean,boolean,boolean,text,text,text,text)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.classify_recurring_invoice_product_authority_atomic(boolean,text,text,text,text,text)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.classify_recurring_subscription_product_authority_atomic(boolean,text,text,text,text)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.locate_account_recovery_payment_lifecycle_v2(uuid,timestamp with time zone,timestamp with time zone)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.stripe_payment_ownership_is_exact_v2(uuid)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.stripe_entitlement_effect_is_current_v2(uuid)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.claim_stripe_subscription_cancel_dispatch_atomic(uuid,uuid,boolean)'
    ) IS NULL
  THEN
    RAISE EXCEPTION
      'API-tier recovery payment authority prerequisites are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY[
        'public.user_profiles',
        'public.api_keys',
        'public.account_recovery_admissions',
        'public.api_tier_checkout_reservations',
        'public.api_tier_stripe_event_ledger',
        'public.api_tier_subscription_blocks',
        'public.stripe_entitlement_payments',
        'public.tips',
        'public.group_payment_consumptions',
        'public.stripe_payment_ownerships',
        'public.stripe_entitlement_effects',
        'public.stripe_charge_refund_tombstones'
      ]::text[]
    ) AS required_relation(relation_name)
    WHERE pg_catalog.to_regclass(required_relation.relation_name) IS NULL
  ) THEN
    RAISE EXCEPTION
      'API-tier recovery payment authority relations are missing';
  END IF;

  SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
  INTO v_effect_source_constraint
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
      'public.stripe_entitlement_effects'::pg_catalog.regclass
    AND constraint_row.conname = 'stripe_entitlement_effects_source_check';

  IF v_effect_source_constraint IS NULL
    OR pg_catalog.strpos(v_effect_source_constraint, 'api_payment') = 0
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
          'public.stripe_entitlement_effects'::pg_catalog.regclass
        AND attribute.attname = 'dispatch_committed_at'
        AND attribute.atttypid = 'timestamp with time zone'::pg_catalog.regtype
        AND NOT attribute.attisdropped
    )
  THEN
    RAISE EXCEPTION
      '074 API payment outbox extension contract is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname IN (
        'apply_api_tier_paid_invoice_event_atomic',
        'locate_api_tier_invoice_authority_atomic',
        'claim_api_tier_recovery_payment_refund_dispatch_atomic',
        'claim_api_tier_subscription_cancel_dispatch_atomic',
        'api_tier_recovery_effect_is_current_v2'
      )
  ) THEN
    RAISE EXCEPTION
      'API-tier recovery payment authority has an unexpected predecessor overload';
  END IF;
END
$preflight$;

LOCK TABLE
  public.api_tier_checkout_reservations,
  public.api_tier_stripe_event_ledger,
  public.api_tier_subscription_blocks,
  public.stripe_payment_ownerships,
  public.stripe_entitlement_effects
IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.api_tier_subscription_blocks
  DROP CONSTRAINT api_tier_subscription_blocks_kind_check,
  ADD CONSTRAINT api_tier_subscription_blocks_kind_check CHECK (
    block_kind IN (
      'account_deletion',
      'financial_reversal',
      'account_recovery'
    )
  );

-- A Checkout Session is the durable side of the recovery boundary.  Keep its
-- original bind time even after later locator/payment transitions update the
-- reservation row; a webhook first delivered after recovery completion must
-- still be able to prove that the Session predates that recovery.
ALTER TABLE public.api_tier_checkout_reservations
  ADD COLUMN bound_at timestamptz;

UPDATE public.api_tier_checkout_reservations
SET bound_at = updated_at
WHERE checkout_session_id IS NOT NULL;

ALTER TABLE public.api_tier_checkout_reservations
  ADD CONSTRAINT api_tier_checkout_reservations_bound_time_check CHECK (
    (checkout_session_id IS NULL AND bound_at IS NULL)
    OR (checkout_session_id IS NOT NULL AND bound_at IS NOT NULL)
  );

ALTER TABLE public.api_tier_checkout_reservations
  DROP CONSTRAINT api_tier_checkout_reservations_state_check,
  ADD CONSTRAINT api_tier_checkout_reservations_state_check CHECK (
    (
      status = 'reserved'
      AND checkout_session_id IS NULL
      AND stripe_subscription_id IS NULL
      AND release_reason IS NULL
      AND release_event_id IS NULL
      AND release_event_created IS NULL
      AND released_at IS NULL
    )
    OR (
      status = 'bound'
      AND checkout_session_id IS NOT NULL
      AND stripe_subscription_id IS NULL
      AND release_reason IS NULL
      AND release_event_id IS NULL
      AND release_event_created IS NULL
      AND released_at IS NULL
    )
    OR (
      status = 'converted'
      AND checkout_session_id IS NOT NULL
      AND stripe_subscription_id IS NOT NULL
      AND release_reason IS NULL
      AND release_event_id IS NULL
      AND release_event_created IS NULL
      AND released_at IS NULL
    )
    OR (
      status = 'account_recovery_billing_blocked'
      AND checkout_session_id IS NOT NULL
      AND stripe_subscription_id IS NOT NULL
      AND release_reason = 'account_recovery_billing_blocked'
      AND release_event_id IS NOT NULL
      AND release_event_created IS NOT NULL
      AND released_at IS NOT NULL
    )
    OR (
      status = 'released'
      AND checkout_session_id IS NOT NULL
      AND stripe_subscription_id IS NULL
      AND release_reason = 'checkout_session_expired'
      AND release_event_id IS NOT NULL
      AND release_event_created IS NOT NULL
      AND released_at IS NOT NULL
    )
    OR (
      status = 'expired'
      AND checkout_session_id IS NULL
      AND stripe_subscription_id IS NULL
      AND release_reason = 'lease_expired'
      AND release_event_id IS NULL
      AND release_event_created IS NULL
      AND released_at IS NOT NULL
    )
  );

ALTER TABLE public.stripe_payment_ownerships
  DROP CONSTRAINT stripe_payment_ownerships_product_kind_check,
  ADD CONSTRAINT stripe_payment_ownerships_product_kind_check CHECK (
    product_kind IN (
      'pro_entitlement',
      'tip',
      'group_pass',
      'api_tier'
    )
  );

CREATE TABLE public.stripe_api_tier_invoice_locators (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  metadata_user_id uuid NOT NULL,
  metadata_supabase_user_id uuid NOT NULL,
  livemode boolean NOT NULL,
  stripe_customer_id text NOT NULL,
  checkout_reservation_id uuid NOT NULL
    REFERENCES public.api_tier_checkout_reservations(id) ON DELETE RESTRICT,
  checkout_session_id text NOT NULL,
  session_created_at timestamptz NOT NULL,
  stripe_subscription_id text NOT NULL,
  stripe_price_id text NOT NULL,
  api_plan text NOT NULL,
  first_invoice_id text NOT NULL,
  first_event_id text NOT NULL,
  located_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_api_tier_invoice_locators_subject_check CHECK (
    metadata_user_id = user_id
    AND metadata_supabase_user_id = user_id
  ),
  CONSTRAINT stripe_api_tier_invoice_locators_customer_check CHECK (
    stripe_customer_id = pg_catalog.btrim(stripe_customer_id)
    AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_customer_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_invoice_locators_session_check CHECK (
    checkout_session_id = pg_catalog.btrim(checkout_session_id)
    AND checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'
    AND pg_catalog.length(checkout_session_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_invoice_locators_session_time_check CHECK (
    session_created_at = pg_catalog.date_trunc('second', session_created_at)
  ),
  CONSTRAINT stripe_api_tier_invoice_locators_subscription_check CHECK (
    stripe_subscription_id = pg_catalog.btrim(stripe_subscription_id)
    AND stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_subscription_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_invoice_locators_price_check CHECK (
    stripe_price_id = pg_catalog.btrim(stripe_price_id)
    AND stripe_price_id ~ '^price_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_price_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_invoice_locators_plan_check CHECK (
    api_plan IN ('starter', 'pro')
  ),
  CONSTRAINT stripe_api_tier_invoice_locators_invoice_check CHECK (
    first_invoice_id = pg_catalog.btrim(first_invoice_id)
    AND first_invoice_id ~ '^in_[A-Za-z0-9_]+$'
    AND pg_catalog.length(first_invoice_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_invoice_locators_event_check CHECK (
    first_event_id = pg_catalog.btrim(first_event_id)
    AND first_event_id ~ '^evt_[A-Za-z0-9_]+$'
    AND pg_catalog.length(first_event_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_invoice_locators_subscription_key
    UNIQUE (livemode, stripe_subscription_id),
  CONSTRAINT stripe_api_tier_invoice_locators_reservation_key
    UNIQUE (checkout_reservation_id),
  CONSTRAINT stripe_api_tier_invoice_locators_session_key
    UNIQUE (livemode, checkout_session_id)
);

CREATE TABLE public.stripe_api_tier_invoice_payments (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  metadata_user_id uuid NOT NULL,
  metadata_supabase_user_id uuid NOT NULL,
  livemode boolean NOT NULL,
  stripe_customer_id text NOT NULL,
  checkout_reservation_id uuid NOT NULL
    REFERENCES public.api_tier_checkout_reservations(id) ON DELETE RESTRICT,
  checkout_session_id text NOT NULL,
  session_created_at timestamptz NOT NULL,
  stripe_subscription_id text NOT NULL,
  subscription_created bigint NOT NULL,
  subscription_status text NOT NULL,
  invoice_created_at timestamptz NOT NULL,
  paid_at timestamptz NOT NULL,
  stripe_invoice_id text NOT NULL,
  stripe_invoice_payment_id text NOT NULL,
  stripe_payment_intent_id text,
  stripe_charge_id text NOT NULL,
  stripe_price_id text NOT NULL,
  api_plan text NOT NULL,
  amount_paid bigint NOT NULL,
  currency text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  payment_status text NOT NULL,
  authority_outcome text NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_api_tier_invoice_payments_subject_check CHECK (
    metadata_user_id = user_id
    AND metadata_supabase_user_id = user_id
  ),
  CONSTRAINT stripe_api_tier_invoice_payments_customer_check CHECK (
    stripe_customer_id = pg_catalog.btrim(stripe_customer_id)
    AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_customer_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_invoice_payments_reservation_check CHECK (
    (checkout_reservation_id IS NULL) = (checkout_session_id IS NULL)
  ),
  CONSTRAINT stripe_api_tier_invoice_payments_session_check CHECK (
    checkout_session_id = pg_catalog.btrim(checkout_session_id)
    AND checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'
    AND pg_catalog.length(checkout_session_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_invoice_payments_session_time_check CHECK (
    session_created_at = pg_catalog.date_trunc('second', session_created_at)
    AND session_created_at <= invoice_created_at
  ),
  CONSTRAINT stripe_api_tier_invoice_payments_subscription_check CHECK (
    stripe_subscription_id = pg_catalog.btrim(stripe_subscription_id)
    AND stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_subscription_id) <= 255
    AND subscription_created > 0
    AND subscription_created <= 253402300799
    -- API-tier Checkout has no trial product. Only a fresh active
    -- Subscription snapshot can become paid entitlement authority.
    AND subscription_status = 'active'
  ),
  CONSTRAINT stripe_api_tier_invoice_payments_invoice_check CHECK (
    stripe_invoice_id = pg_catalog.btrim(stripe_invoice_id)
    AND stripe_invoice_id ~ '^in_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_invoice_id) <= 255
    AND stripe_invoice_payment_id =
      pg_catalog.btrim(stripe_invoice_payment_id)
    AND stripe_invoice_payment_id ~ '^inpay_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_invoice_payment_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_invoice_payments_payment_check CHECK (
    stripe_payment_intent_id IS NULL
    OR (
      stripe_payment_intent_id =
        pg_catalog.btrim(stripe_payment_intent_id)
      AND stripe_payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_payment_intent_id) <= 255
    )
  ),
  CONSTRAINT stripe_api_tier_invoice_payments_charge_check CHECK (
    stripe_charge_id = pg_catalog.btrim(stripe_charge_id)
    AND stripe_charge_id ~ '^ch_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_charge_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_invoice_payments_price_check CHECK (
    stripe_price_id = pg_catalog.btrim(stripe_price_id)
    AND stripe_price_id ~ '^price_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_price_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_invoice_payments_product_check CHECK (
    currency = 'usd'
    AND payment_status = 'succeeded'
    AND period_end > period_start
    AND (
      (api_plan = 'starter' AND amount_paid = 4900)
      OR (api_plan = 'pro' AND amount_paid = 19900)
    )
  ),
  CONSTRAINT stripe_api_tier_invoice_payments_time_chain_check CHECK (
    invoice_created_at = pg_catalog.date_trunc('second', invoice_created_at)
    AND paid_at = pg_catalog.date_trunc('second', paid_at)
    AND pg_catalog.to_timestamp(subscription_created) <= invoice_created_at
    AND invoice_created_at <= paid_at
    AND period_start <= paid_at
    AND paid_at < period_end
  ),
  CONSTRAINT stripe_api_tier_invoice_payments_outcome_check CHECK (
    authority_outcome IN ('granted', 'account_recovery_billing_blocked')
  ),
  CONSTRAINT stripe_api_tier_invoice_payments_invoice_key
    UNIQUE (livemode, stripe_invoice_id),
  CONSTRAINT stripe_api_tier_invoice_payments_invoice_payment_key
    UNIQUE (livemode, stripe_invoice_payment_id),
  CONSTRAINT stripe_api_tier_invoice_payments_charge_key
    UNIQUE (livemode, stripe_charge_id),
  CONSTRAINT stripe_api_tier_invoice_payments_period_key
    UNIQUE (
      livemode,
      stripe_subscription_id,
      period_start,
      period_end
    )
);

CREATE UNIQUE INDEX stripe_api_tier_invoice_payments_pi_key
  ON public.stripe_api_tier_invoice_payments (
    livemode,
    stripe_payment_intent_id
  )
  WHERE stripe_payment_intent_id IS NOT NULL;

CREATE INDEX stripe_api_tier_invoice_payments_subscription_idx
  ON public.stripe_api_tier_invoice_payments (
    user_id,
    livemode,
    stripe_subscription_id,
    observed_at,
    id
  );

CREATE TABLE public.stripe_api_tier_invoice_events (
  livemode boolean NOT NULL,
  event_id text NOT NULL,
  event_created_at timestamptz NOT NULL,
  event_type text NOT NULL,
  payment_id uuid NOT NULL
    REFERENCES public.stripe_api_tier_invoice_payments(id)
    ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (livemode, event_id),
  CONSTRAINT stripe_api_tier_invoice_events_id_check CHECK (
    event_id = pg_catalog.btrim(event_id)
    AND event_id ~ '^evt_[A-Za-z0-9_]+$'
    AND pg_catalog.length(event_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_invoice_events_time_check CHECK (
    event_created_at = pg_catalog.date_trunc('second', event_created_at)
  ),
  CONSTRAINT stripe_api_tier_invoice_events_type_check CHECK (
    event_type IN ('invoice.paid', 'invoice.payment_succeeded')
  )
);

CREATE TABLE public.stripe_api_tier_pending_subscription_events (
  livemode boolean NOT NULL,
  stripe_event_id text NOT NULL,
  user_id uuid NOT NULL,
  metadata_user_id uuid NOT NULL,
  metadata_supabase_user_id uuid NOT NULL,
  stripe_customer_id text NOT NULL,
  checkout_reservation_id uuid NOT NULL
    REFERENCES public.api_tier_checkout_reservations(id) ON DELETE RESTRICT,
  stripe_price_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  subscription_created bigint NOT NULL,
  stripe_event_created bigint NOT NULL,
  api_tier text NOT NULL,
  daily_limit integer NOT NULL,
  recovery_operation_id uuid,
  outcome text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (livemode, stripe_event_id),
  CONSTRAINT stripe_api_tier_pending_subscription_identity_check CHECK (
    metadata_user_id = user_id
    AND metadata_supabase_user_id = user_id
    AND api_tier IN ('starter', 'pro')
    AND (
      (api_tier = 'starter' AND daily_limit = 10000)
      OR (api_tier = 'pro' AND daily_limit = 0)
    )
  ),
  CONSTRAINT stripe_api_tier_pending_subscription_outcome_check CHECK (
    (outcome = 'payment_pending' AND recovery_operation_id IS NULL)
    OR (
      outcome = 'account_recovery_billing_blocked'
      AND recovery_operation_id IS NOT NULL
    )
  ),
  CONSTRAINT stripe_api_tier_pending_subscription_stripe_check CHECK (
    stripe_event_id ~ '^evt_[A-Za-z0-9_]+$'
    AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
    AND stripe_price_id ~ '^price_[A-Za-z0-9_]+$'
    AND stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
    AND subscription_created > 0
    AND subscription_created <= stripe_event_created
  )
);

CREATE TABLE public.stripe_api_tier_recovery_subscription_blocks (
  livemode boolean NOT NULL,
  stripe_subscription_id text NOT NULL,
  user_id uuid NOT NULL,
  stripe_customer_id text NOT NULL,
  recovery_operation_id uuid NOT NULL,
  recovery_claimed_at timestamptz NOT NULL,
  source_event_id text NOT NULL,
  blocked_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (livemode, stripe_subscription_id),
  CONSTRAINT stripe_api_tier_recovery_subscription_blocks_subscription_check
    CHECK (
      stripe_subscription_id = pg_catalog.btrim(stripe_subscription_id)
      AND stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_subscription_id) <= 255
    ),
  CONSTRAINT stripe_api_tier_recovery_subscription_blocks_customer_check
    CHECK (
      stripe_customer_id = pg_catalog.btrim(stripe_customer_id)
      AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_customer_id) <= 255
    ),
  CONSTRAINT stripe_api_tier_recovery_subscription_blocks_event_check CHECK (
    source_event_id = pg_catalog.btrim(source_event_id)
    AND source_event_id ~ '^evt_[A-Za-z0-9_]+$'
    AND pg_catalog.length(source_event_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_recovery_subscription_blocks_time_check CHECK (
    blocked_at >= recovery_claimed_at
  )
);

CREATE TABLE public.stripe_api_tier_recovery_payment_blocks (
  payment_id uuid PRIMARY KEY
    REFERENCES public.stripe_api_tier_invoice_payments(id)
    ON DELETE RESTRICT,
  recovery_operation_id uuid NOT NULL,
  recovery_claimed_at timestamptz NOT NULL,
  source_kind text NOT NULL,
  source_event_id text NOT NULL,
  blocked_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_api_tier_recovery_payment_blocks_source_check CHECK (
    source_kind IN ('invoice', 'subscription')
    AND source_event_id = pg_catalog.btrim(source_event_id)
    AND source_event_id ~ '^evt_[A-Za-z0-9_]+$'
    AND pg_catalog.length(source_event_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_recovery_payment_blocks_time_check CHECK (
    blocked_at >= recovery_claimed_at
  )
);

CREATE TABLE public.stripe_api_tier_recovery_cancellations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  livemode boolean NOT NULL,
  stripe_subscription_id text NOT NULL,
  user_id uuid NOT NULL,
  stripe_customer_id text NOT NULL,
  authority_payment_id uuid NOT NULL UNIQUE
    REFERENCES public.stripe_api_tier_invoice_payments(id)
    ON DELETE RESTRICT,
  recovery_operation_id uuid NOT NULL,
  recovery_claimed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_api_tier_recovery_cancellations_subscription_key
    UNIQUE (livemode, stripe_subscription_id),
  CONSTRAINT stripe_api_tier_recovery_cancellations_subscription_check CHECK (
    stripe_subscription_id = pg_catalog.btrim(stripe_subscription_id)
    AND stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_subscription_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_recovery_cancellations_customer_check CHECK (
    stripe_customer_id = pg_catalog.btrim(stripe_customer_id)
    AND stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
    AND pg_catalog.length(stripe_customer_id) <= 255
  ),
  CONSTRAINT stripe_api_tier_recovery_cancellations_time_check CHECK (
    created_at >= recovery_claimed_at
  )
);

CREATE TABLE public.stripe_api_tier_refund_revocations (
  payment_id uuid PRIMARY KEY
    REFERENCES public.stripe_api_tier_invoice_payments(id) ON DELETE RESTRICT,
  ownership_id uuid NOT NULL UNIQUE
    REFERENCES public.stripe_payment_ownerships(id) ON DELETE RESTRICT,
  refund_event_id text NOT NULL,
  refund_event_created_at timestamptz NOT NULL,
  refund_succeeded_amount bigint NOT NULL,
  amount_paid bigint NOT NULL,
  projection_event_id text NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_api_tier_refund_revocations_event_check CHECK (
    refund_event_id = pg_catalog.btrim(refund_event_id)
    AND refund_event_id ~ '^evt_[A-Za-z0-9_]+$'
    AND projection_event_id = refund_event_id
  ),
  CONSTRAINT stripe_api_tier_refund_revocations_amount_check CHECK (
    amount_paid > 0 AND refund_succeeded_amount >= amount_paid
  ),
  CONSTRAINT stripe_api_tier_refund_revocations_time_check CHECK (
    refund_event_created_at =
      pg_catalog.date_trunc('second', refund_event_created_at)
    AND revoked_at >= refund_event_created_at
  )
);

ALTER TABLE public.stripe_api_tier_invoice_locators OWNER TO postgres;
ALTER TABLE public.stripe_api_tier_invoice_payments OWNER TO postgres;
ALTER TABLE public.stripe_api_tier_invoice_events OWNER TO postgres;
ALTER TABLE public.stripe_api_tier_pending_subscription_events OWNER TO postgres;
ALTER TABLE public.stripe_api_tier_recovery_subscription_blocks OWNER TO postgres;
ALTER TABLE public.stripe_api_tier_recovery_payment_blocks OWNER TO postgres;
ALTER TABLE public.stripe_api_tier_recovery_cancellations OWNER TO postgres;
ALTER TABLE public.stripe_api_tier_refund_revocations OWNER TO postgres;

ALTER TABLE public.stripe_api_tier_invoice_locators ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_invoice_locators FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_invoice_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_invoice_payments FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_invoice_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_invoice_events FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_pending_subscription_events
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_pending_subscription_events
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_recovery_subscription_blocks
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_recovery_subscription_blocks
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_recovery_payment_blocks
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_recovery_payment_blocks
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_recovery_cancellations
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_recovery_cancellations
  FORCE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_refund_revocations
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_api_tier_refund_revocations
  FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
  public.stripe_api_tier_invoice_locators,
  public.stripe_api_tier_invoice_payments,
  public.stripe_api_tier_invoice_events,
  public.stripe_api_tier_pending_subscription_events,
  public.stripe_api_tier_recovery_subscription_blocks,
  public.stripe_api_tier_recovery_payment_blocks,
  public.stripe_api_tier_recovery_cancellations,
  public.stripe_api_tier_refund_revocations
FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE OR REPLACE FUNCTION public.prevent_api_tier_payment_authority_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'API-tier payment authority ledgers are immutable'
    USING ERRCODE = '23514';
END
$function$;

ALTER FUNCTION public.prevent_api_tier_payment_authority_mutation()
  OWNER TO postgres;

CREATE TRIGGER trg_stripe_api_tier_invoice_locators_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_api_tier_invoice_locators
  FOR EACH ROW EXECUTE FUNCTION
    public.prevent_api_tier_payment_authority_mutation();
CREATE TRIGGER trg_stripe_api_tier_invoice_payments_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_api_tier_invoice_payments
  FOR EACH ROW EXECUTE FUNCTION
    public.prevent_api_tier_payment_authority_mutation();
CREATE TRIGGER trg_stripe_api_tier_invoice_events_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_api_tier_invoice_events
  FOR EACH ROW EXECUTE FUNCTION
    public.prevent_api_tier_payment_authority_mutation();
CREATE TRIGGER trg_stripe_api_tier_pending_subscription_events_immutable
  BEFORE UPDATE OR DELETE
  ON public.stripe_api_tier_pending_subscription_events
  FOR EACH ROW EXECUTE FUNCTION
    public.prevent_api_tier_payment_authority_mutation();
CREATE TRIGGER trg_stripe_api_tier_recovery_subscription_blocks_immutable
  BEFORE UPDATE OR DELETE
  ON public.stripe_api_tier_recovery_subscription_blocks
  FOR EACH ROW EXECUTE FUNCTION
    public.prevent_api_tier_payment_authority_mutation();
CREATE TRIGGER trg_stripe_api_tier_recovery_payment_blocks_immutable
  BEFORE UPDATE OR DELETE
  ON public.stripe_api_tier_recovery_payment_blocks
  FOR EACH ROW EXECUTE FUNCTION
    public.prevent_api_tier_payment_authority_mutation();
CREATE TRIGGER trg_stripe_api_tier_recovery_cancellations_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_api_tier_recovery_cancellations
  FOR EACH ROW EXECUTE FUNCTION
    public.prevent_api_tier_payment_authority_mutation();
CREATE TRIGGER trg_stripe_api_tier_refund_revocations_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_api_tier_refund_revocations
  FOR EACH ROW EXECUTE FUNCTION
    public.prevent_api_tier_payment_authority_mutation();

CREATE OR REPLACE FUNCTION public.bind_api_tier_checkout_time_once()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF OLD.bound_at IS NOT NULL
    AND NEW.bound_at IS DISTINCT FROM OLD.bound_at
  THEN
    RAISE EXCEPTION 'API Checkout bind time is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.checkout_session_id IS NULL
    AND NEW.checkout_session_id IS NOT NULL
  THEN
    NEW.bound_at := pg_catalog.clock_timestamp();
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.bind_api_tier_checkout_time_once() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bind_api_tier_checkout_time_once()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TRIGGER trg_api_tier_checkout_bind_time_once
  BEFORE UPDATE OF checkout_session_id, bound_at
  ON public.api_tier_checkout_reservations
  FOR EACH ROW EXECUTE FUNCTION public.bind_api_tier_checkout_time_once();

CREATE OR REPLACE FUNCTION public.locate_api_tier_invoice_authority_atomic(
  p_event_id text,
  p_event_created_at timestamptz,
  p_livemode boolean,
  p_invoice_id text,
  p_user_id uuid,
  p_metadata_user_id uuid,
  p_metadata_supabase_user_id uuid,
  p_stripe_customer_id text,
  p_checkout_reservation_id uuid,
  p_checkout_session_id text,
  p_session_created_at timestamptz,
  p_stripe_subscription_id text,
  p_stripe_price_id text,
  p_api_plan text,
  p_subscription_created bigint,
  p_invoice_created_at timestamptz,
  p_paid_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_reservation public.api_tier_checkout_reservations%ROWTYPE;
  v_locator public.stripe_api_tier_invoice_locators%ROWTYPE;
  v_recovery record;
  v_status text;
  v_event_created bigint;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL
    OR p_metadata_user_id IS DISTINCT FROM p_user_id
    OR p_metadata_supabase_user_id IS DISTINCT FROM p_user_id
    OR p_livemode IS NULL
    OR p_event_id IS NULL
    OR p_event_id IS DISTINCT FROM pg_catalog.btrim(p_event_id)
    OR p_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR p_invoice_id IS NULL
    OR p_invoice_id IS DISTINCT FROM pg_catalog.btrim(p_invoice_id)
    OR p_invoice_id !~ '^in_[A-Za-z0-9_]+$'
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_customer_id)
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR p_checkout_reservation_id IS NULL
    OR p_checkout_session_id IS NULL
    OR p_checkout_session_id IS DISTINCT FROM pg_catalog.btrim(p_checkout_session_id)
    OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR p_session_created_at IS NULL
    OR p_session_created_at IS DISTINCT FROM
      pg_catalog.date_trunc('second', p_session_created_at)
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_subscription_id)
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id IS DISTINCT FROM pg_catalog.btrim(p_stripe_price_id)
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR p_api_plan NOT IN ('starter', 'pro')
    OR p_subscription_created IS NULL
    OR p_subscription_created <= 0
    OR p_event_created_at IS NULL
    OR p_event_created_at IS DISTINCT FROM
      pg_catalog.date_trunc('second', p_event_created_at)
    OR p_invoice_created_at IS NULL
    OR p_invoice_created_at IS DISTINCT FROM
      pg_catalog.date_trunc('second', p_invoice_created_at)
    OR p_paid_at IS NULL
    OR p_paid_at IS DISTINCT FROM pg_catalog.date_trunc('second', p_paid_at)
    OR pg_catalog.to_timestamp(p_subscription_created) > p_invoice_created_at
    OR p_session_created_at > p_invoice_created_at
    OR p_invoice_created_at > p_paid_at
    OR p_paid_at > p_event_created_at
    OR GREATEST(
      pg_catalog.length(p_event_id),
      pg_catalog.length(p_invoice_id),
      pg_catalog.length(p_stripe_customer_id),
      pg_catalog.length(p_checkout_session_id),
      pg_catalog.length(p_stripe_subscription_id),
      pg_catalog.length(p_stripe_price_id)
    ) > 255
  THEN
    RAISE EXCEPTION 'API Invoice locator identity is invalid'
      USING ERRCODE = '22023';
  END IF;
  v_event_created := pg_catalog.floor(
    extract(epoch FROM p_event_created_at)
  )::bigint;

  -- Recovery is the first lock for every path which can turn a pre-recovery
  -- Checkout identity into durable Subscription authority.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text, 0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-customer-owner:' || p_stripe_customer_id, 0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'api-tier-stripe-subscription:' || p_livemode::text || ':' ||
        p_stripe_subscription_id, 0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-checkout-session:' || p_checkout_session_id, 0
    )
  );

  SELECT reservation.* INTO v_reservation
  FROM public.api_tier_checkout_reservations AS reservation
  WHERE reservation.id = p_checkout_reservation_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_reservation.user_id IS DISTINCT FROM p_user_id
    OR v_reservation.livemode IS DISTINCT FROM p_livemode
    OR v_reservation.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
    OR v_reservation.checkout_session_id IS DISTINCT FROM p_checkout_session_id
    OR v_reservation.api_plan IS DISTINCT FROM p_api_plan
    OR v_reservation.stripe_price_id IS DISTINCT FROM p_stripe_price_id
    OR v_reservation.bound_at IS NULL
    OR v_reservation.created_at > p_session_created_at
    OR p_session_created_at > v_reservation.bound_at
    OR v_reservation.bound_at > p_event_created_at
    OR v_reservation.status NOT IN (
      'bound', 'converted', 'account_recovery_billing_blocked'
    )
    OR (
      v_reservation.stripe_subscription_id IS NOT NULL
      AND v_reservation.stripe_subscription_id IS DISTINCT FROM
        p_stripe_subscription_id
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT
    lifecycle.operation_id,
    lifecycle.recovery_claimed_at AS claimed_at
  INTO v_recovery
  FROM public.locate_account_recovery_payment_lifecycle_v2(
    p_user_id,
    LEAST(v_reservation.created_at, p_session_created_at),
    p_paid_at
  ) AS lifecycle;

  v_status := CASE
    WHEN v_recovery.operation_id IS NULL THEN 'located'
    ELSE 'account_recovery_billing_blocked'
  END;

  IF v_recovery.operation_id IS NULL THEN
    IF v_reservation.status = 'account_recovery_billing_blocked' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    UPDATE public.api_tier_checkout_reservations
    SET status = 'converted',
        stripe_subscription_id = p_stripe_subscription_id,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_checkout_reservation_id
      AND status IN ('bound', 'converted');
  ELSE
    UPDATE public.api_tier_checkout_reservations
    SET status = 'account_recovery_billing_blocked',
        stripe_subscription_id = p_stripe_subscription_id,
        release_reason = 'account_recovery_billing_blocked',
        release_event_id = p_event_id,
        release_event_created = v_event_created,
        released_at = COALESCE(released_at, pg_catalog.clock_timestamp()),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_checkout_reservation_id
      AND status IN ('bound', 'converted')
    ;

    INSERT INTO public.stripe_api_tier_recovery_subscription_blocks (
      livemode, stripe_subscription_id, user_id, stripe_customer_id,
      recovery_operation_id, recovery_claimed_at, source_event_id
    ) VALUES (
      p_livemode, p_stripe_subscription_id, p_user_id,
      p_stripe_customer_id, v_recovery.operation_id,
      v_recovery.claimed_at, p_event_id
    )
    ON CONFLICT (livemode, stripe_subscription_id) DO NOTHING;

    INSERT INTO public.api_tier_subscription_blocks (
      livemode, stripe_subscription_id, block_kind, user_id,
      stripe_customer_id
    ) VALUES (
      p_livemode, p_stripe_subscription_id, 'account_recovery',
      p_user_id, p_stripe_customer_id
    ) ON CONFLICT (livemode, stripe_subscription_id, block_kind)
      DO NOTHING;
  END IF;

  INSERT INTO public.stripe_api_tier_invoice_locators (
    user_id, metadata_user_id, metadata_supabase_user_id, livemode,
    stripe_customer_id, checkout_reservation_id, checkout_session_id,
    session_created_at,
    stripe_subscription_id, stripe_price_id, api_plan, first_invoice_id,
    first_event_id
  ) VALUES (
    p_user_id, p_metadata_user_id, p_metadata_supabase_user_id, p_livemode,
    p_stripe_customer_id, p_checkout_reservation_id, p_checkout_session_id,
    p_session_created_at,
    p_stripe_subscription_id, p_stripe_price_id, p_api_plan, p_invoice_id,
    p_event_id
  ) ON CONFLICT (livemode, stripe_subscription_id) DO NOTHING;

  SELECT locator.* INTO v_locator
  FROM public.stripe_api_tier_invoice_locators AS locator
  WHERE locator.livemode = p_livemode
    AND locator.stripe_subscription_id = p_stripe_subscription_id;
  IF NOT FOUND
    OR v_locator.user_id IS DISTINCT FROM p_user_id
    OR v_locator.metadata_user_id IS DISTINCT FROM p_metadata_user_id
    OR v_locator.metadata_supabase_user_id IS DISTINCT FROM
      p_metadata_supabase_user_id
    OR v_locator.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
    OR v_locator.checkout_reservation_id IS DISTINCT FROM
      p_checkout_reservation_id
    OR v_locator.checkout_session_id IS DISTINCT FROM p_checkout_session_id
    OR v_locator.session_created_at IS DISTINCT FROM p_session_created_at
    OR v_locator.stripe_price_id IS DISTINCT FROM p_stripe_price_id
    OR v_locator.api_plan IS DISTINCT FROM p_api_plan
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_status,
    'reservation_id', p_checkout_reservation_id,
    'checkout_session_id', p_checkout_session_id,
    'stripe_subscription_id', p_stripe_subscription_id,
    'api_plan', p_api_plan,
    'stripe_price_id', p_stripe_price_id,
    'recovery_operation_id', v_recovery.operation_id
  );
END
$function$;

ALTER FUNCTION public.locate_api_tier_invoice_authority_atomic(
  text, timestamptz, boolean, text, uuid, uuid, uuid, text, uuid, text,
  timestamptz, text, text, text, bigint, timestamptz, timestamptz
) OWNER TO postgres;

ALTER FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
  RENAME TO stripe_payment_ownership_is_exact_pre_api_v2;
REVOKE ALL ON FUNCTION
  public.stripe_payment_ownership_is_exact_pre_api_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.stripe_payment_ownership_is_exact_v2(
  p_ownership_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT public.stripe_payment_ownership_is_exact_pre_api_v2(p_ownership_id)
    OR EXISTS (
      SELECT 1
      FROM public.stripe_payment_ownerships AS ownership
      JOIN public.stripe_api_tier_invoice_payments AS payment
        ON payment.id = ownership.ledger_id
      WHERE ownership.id = p_ownership_id
        AND ownership.product_kind = 'api_tier'
        AND ownership.owner_user_id = payment.user_id
        AND ownership.stripe_customer_id = payment.stripe_customer_id
        AND ownership.stripe_payment_intent_id IS NOT DISTINCT FROM
          payment.stripe_payment_intent_id
        AND ownership.stripe_charge_id = payment.stripe_charge_id
        AND ownership.checkout_session_id = payment.checkout_session_id
        AND ownership.amount_paid = payment.amount_paid
        AND ownership.currency = payment.currency
    )
$function$;

ALTER FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.apply_api_tier_paid_invoice_event_atomic(
  p_event_id text,
  p_event_created_at timestamptz,
  p_event_type text,
  p_livemode boolean,
  p_user_id uuid,
  p_metadata_user_id uuid,
  p_metadata_supabase_user_id uuid,
  p_stripe_customer_id text,
  p_checkout_reservation_id uuid,
  p_checkout_session_id text,
  p_session_created_at timestamptz,
  p_stripe_subscription_id text,
  p_subscription_created bigint,
  p_subscription_status text,
  p_stripe_invoice_id text,
  p_stripe_invoice_payment_id text,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_stripe_price_id text,
  p_api_plan text,
  p_amount_paid bigint,
  p_currency text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_invoice_created_at timestamptz,
  p_paid_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_locator jsonb;
  v_payment public.stripe_api_tier_invoice_payments%ROWTYPE;
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_recovery record;
  v_subscription_ack text;
  v_refund_effect_id uuid;
  v_cancel_effect_id uuid;
  v_inserted boolean := false;
  v_event_created bigint;
  v_daily_limit integer;
  v_outcome text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_event_type NOT IN ('invoice.paid', 'invoice.payment_succeeded')
    OR p_event_id IS NULL OR p_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR p_livemode IS NULL
    OR p_user_id IS NULL
    OR p_metadata_user_id IS DISTINCT FROM p_user_id
    OR p_metadata_supabase_user_id IS DISTINCT FROM p_user_id
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR p_checkout_reservation_id IS NULL
    OR p_checkout_session_id IS NULL
    OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR p_session_created_at IS NULL
    OR p_session_created_at IS DISTINCT FROM
      pg_catalog.date_trunc('second', p_session_created_at)
    OR p_stripe_subscription_id IS NULL
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR p_subscription_created IS NULL OR p_subscription_created <= 0
    OR p_subscription_status IS DISTINCT FROM 'active'
    OR p_stripe_invoice_id IS NULL
    OR p_stripe_invoice_id !~ '^in_[A-Za-z0-9_]+$'
    OR p_stripe_invoice_payment_id IS NULL
    OR p_stripe_invoice_payment_id !~ '^inpay_[A-Za-z0-9_]+$'
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND p_stripe_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
    )
    OR p_stripe_charge_id IS NULL
    OR p_stripe_charge_id !~ '^ch_[A-Za-z0-9_]+$'
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR p_api_plan NOT IN ('starter', 'pro')
    OR p_amount_paid IS DISTINCT FROM (CASE p_api_plan
      WHEN 'starter' THEN 4900::bigint
      WHEN 'pro' THEN 19900::bigint
    END)
    OR p_currency IS DISTINCT FROM 'usd'
    OR p_event_created_at IS NULL
    OR p_event_created_at IS DISTINCT FROM
      pg_catalog.date_trunc('second', p_event_created_at)
    OR p_invoice_created_at IS NULL
    OR p_invoice_created_at IS DISTINCT FROM
      pg_catalog.date_trunc('second', p_invoice_created_at)
    OR p_paid_at IS NULL
    OR p_paid_at IS DISTINCT FROM pg_catalog.date_trunc('second', p_paid_at)
    OR p_period_start IS NULL OR p_period_end IS NULL
    OR p_period_start IS DISTINCT FROM
      pg_catalog.date_trunc('second', p_period_start)
    OR p_period_end IS DISTINCT FROM
      pg_catalog.date_trunc('second', p_period_end)
    OR pg_catalog.to_timestamp(p_subscription_created) > p_invoice_created_at
    OR p_session_created_at > p_invoice_created_at
    OR p_invoice_created_at > p_paid_at
    OR p_paid_at > p_event_created_at
    OR p_period_start > p_paid_at
    OR p_paid_at >= p_period_end
    OR GREATEST(
      pg_catalog.length(p_event_id), pg_catalog.length(p_stripe_customer_id),
      pg_catalog.length(p_checkout_session_id),
      pg_catalog.length(p_stripe_subscription_id),
      pg_catalog.length(p_stripe_invoice_id),
      pg_catalog.length(p_stripe_invoice_payment_id),
      pg_catalog.length(COALESCE(p_stripe_payment_intent_id, '')),
      pg_catalog.length(p_stripe_charge_id),
      pg_catalog.length(p_stripe_price_id)
    ) > 255
  THEN
    RAISE EXCEPTION 'API paid Invoice authority input is invalid'
      USING ERRCODE = '22023';
  END IF;
  v_event_created := pg_catalog.floor(
    extract(epoch FROM p_event_created_at)
  )::bigint;
  v_daily_limit := CASE p_api_plan
    WHEN 'starter' THEN 10000 ELSE 0
  END;

  -- The locator acquires the recovery lock before every Stripe/product lock,
  -- validates the fresh Subscription/Session chain, and freezes a historical
  -- recovery crossing even if webhook delivery occurs after finalization.
  v_locator := public.locate_api_tier_invoice_authority_atomic(
    p_event_id, p_event_created_at, p_livemode, p_stripe_invoice_id,
    p_user_id, p_metadata_user_id, p_metadata_supabase_user_id,
    p_stripe_customer_id, p_checkout_reservation_id, p_checkout_session_id,
    p_session_created_at, p_stripe_subscription_id, p_stripe_price_id, p_api_plan,
    p_subscription_created, p_invoice_created_at, p_paid_at
  );
  IF COALESCE(v_locator ->> 'status', '') NOT IN (
    'located', 'account_recovery_billing_blocked'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  v_outcome := CASE v_locator ->> 'status'
    WHEN 'located' THEN 'granted'
    ELSE 'account_recovery_billing_blocked'
  END;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || p_stripe_charge_id, 0
    )
  );
  IF p_stripe_payment_intent_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-payment-identity:' || p_stripe_payment_intent_id, 0
      )
    );
  END IF;

  -- A globally claimed Charge, PI, or Session cannot be reinterpreted as API
  -- money.  Conversely, once this ledger claims them all future products fail
  -- the same central unique indexes.
  IF EXISTS (
    SELECT 1 FROM public.stripe_payment_ownerships AS ownership
    WHERE ownership.stripe_charge_id = p_stripe_charge_id
      OR (
        p_stripe_payment_intent_id IS NOT NULL
        AND ownership.stripe_payment_intent_id = p_stripe_payment_intent_id
      )
      OR ownership.checkout_session_id = p_checkout_session_id
  ) AND NOT EXISTS (
    SELECT 1 FROM public.stripe_payment_ownerships AS ownership
    JOIN public.stripe_api_tier_invoice_payments AS payment
      ON payment.id = ownership.ledger_id
    WHERE ownership.product_kind = 'api_tier'
      AND payment.livemode = p_livemode
      AND payment.stripe_invoice_id = p_stripe_invoice_id
      AND ownership.stripe_charge_id = p_stripe_charge_id
      AND ownership.stripe_payment_intent_id IS NOT DISTINCT FROM
        p_stripe_payment_intent_id
      AND ownership.checkout_session_id = p_checkout_session_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  INSERT INTO public.stripe_api_tier_invoice_payments (
    user_id, metadata_user_id, metadata_supabase_user_id, livemode,
    stripe_customer_id, checkout_reservation_id, checkout_session_id,
    session_created_at,
    stripe_subscription_id, subscription_created, subscription_status,
    invoice_created_at, paid_at, stripe_invoice_id, stripe_invoice_payment_id,
    stripe_payment_intent_id, stripe_charge_id, stripe_price_id, api_plan,
    amount_paid, currency, period_start, period_end, payment_status,
    authority_outcome
  ) VALUES (
    p_user_id, p_metadata_user_id, p_metadata_supabase_user_id, p_livemode,
    p_stripe_customer_id, p_checkout_reservation_id, p_checkout_session_id,
    p_session_created_at,
    p_stripe_subscription_id, p_subscription_created, p_subscription_status,
    p_invoice_created_at, p_paid_at, p_stripe_invoice_id,
    p_stripe_invoice_payment_id,
    p_stripe_payment_intent_id, p_stripe_charge_id, p_stripe_price_id,
    p_api_plan, p_amount_paid, p_currency, p_period_start, p_period_end,
    'succeeded', v_outcome
  ) ON CONFLICT DO NOTHING
  RETURNING * INTO v_payment;
  v_inserted := FOUND;

  IF NOT v_inserted THEN
    SELECT payment.* INTO v_payment
    FROM public.stripe_api_tier_invoice_payments AS payment
    WHERE payment.livemode = p_livemode
      AND payment.stripe_invoice_id = p_stripe_invoice_id;
  END IF;
  IF NOT FOUND
    OR v_payment.user_id IS DISTINCT FROM p_user_id
    OR v_payment.metadata_user_id IS DISTINCT FROM p_metadata_user_id
    OR v_payment.metadata_supabase_user_id IS DISTINCT FROM
      p_metadata_supabase_user_id
    OR v_payment.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
    OR v_payment.checkout_reservation_id IS DISTINCT FROM
      p_checkout_reservation_id
    OR v_payment.checkout_session_id IS DISTINCT FROM p_checkout_session_id
    OR v_payment.session_created_at IS DISTINCT FROM p_session_created_at
    OR v_payment.stripe_subscription_id IS DISTINCT FROM
      p_stripe_subscription_id
    OR v_payment.subscription_created IS DISTINCT FROM p_subscription_created
    OR v_payment.subscription_status IS DISTINCT FROM p_subscription_status
    OR v_payment.invoice_created_at IS DISTINCT FROM p_invoice_created_at
    OR v_payment.paid_at IS DISTINCT FROM p_paid_at
    OR v_payment.stripe_invoice_payment_id IS DISTINCT FROM
      p_stripe_invoice_payment_id
    OR v_payment.stripe_payment_intent_id IS DISTINCT FROM
      p_stripe_payment_intent_id
    OR v_payment.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
    OR v_payment.stripe_price_id IS DISTINCT FROM p_stripe_price_id
    OR v_payment.api_plan IS DISTINCT FROM p_api_plan
    OR v_payment.amount_paid IS DISTINCT FROM p_amount_paid
    OR v_payment.currency IS DISTINCT FROM p_currency
    OR v_payment.period_start IS DISTINCT FROM p_period_start
    OR v_payment.period_end IS DISTINCT FROM p_period_end
    OR v_payment.authority_outcome IS DISTINCT FROM v_outcome
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  INSERT INTO public.stripe_api_tier_invoice_events (
    livemode, event_id, event_created_at, event_type, payment_id
  ) VALUES (
    p_livemode, p_event_id, p_event_created_at, p_event_type, v_payment.id
  ) ON CONFLICT (livemode, event_id) DO NOTHING;
  IF NOT EXISTS (
    SELECT 1 FROM public.stripe_api_tier_invoice_events AS event_row
    WHERE event_row.livemode = p_livemode
      AND event_row.event_id = p_event_id
      AND event_row.event_created_at = p_event_created_at
      AND event_row.event_type = p_event_type
      AND event_row.payment_id = v_payment.id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  INSERT INTO public.stripe_payment_ownerships (
    product_kind, ledger_id, owner_user_id, stripe_customer_id,
    stripe_payment_intent_id, stripe_charge_id, checkout_session_id,
    amount_paid, currency
  ) VALUES (
    'api_tier', v_payment.id, p_user_id, p_stripe_customer_id,
    p_stripe_payment_intent_id, p_stripe_charge_id, p_checkout_session_id,
    p_amount_paid, p_currency
  ) ON CONFLICT DO NOTHING;

  SELECT ownership.* INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.product_kind = 'api_tier'
    AND ownership.ledger_id = v_payment.id;
  IF NOT FOUND
    OR NOT public.stripe_payment_ownership_is_exact_v2(v_ownership.id)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF v_outcome = 'account_recovery_billing_blocked' THEN
    SELECT block.recovery_operation_id, block.recovery_claimed_at
    INTO v_recovery
    FROM public.stripe_api_tier_recovery_subscription_blocks AS block
    WHERE block.livemode = p_livemode
      AND block.stripe_subscription_id = p_stripe_subscription_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;

    INSERT INTO public.stripe_api_tier_recovery_payment_blocks (
      payment_id, recovery_operation_id, recovery_claimed_at, source_kind,
      source_event_id
    ) VALUES (
      v_payment.id, v_recovery.recovery_operation_id,
      v_recovery.recovery_claimed_at, 'invoice', p_event_id
    ) ON CONFLICT (payment_id) DO NOTHING;

    INSERT INTO public.stripe_api_tier_recovery_cancellations (
      livemode, stripe_subscription_id, user_id, stripe_customer_id,
      authority_payment_id, recovery_operation_id, recovery_claimed_at
    ) VALUES (
      p_livemode, p_stripe_subscription_id, p_user_id,
      p_stripe_customer_id, v_payment.id, v_recovery.recovery_operation_id,
      v_recovery.recovery_claimed_at
    ) ON CONFLICT (livemode, stripe_subscription_id) DO NOTHING;

    INSERT INTO public.stripe_entitlement_effects (
      entitlement_payment_id, user_id, source_kind, source_key,
      operation_key, effect_type, payload
    ) VALUES (
      NULL, p_user_id, 'api_payment', v_payment.id::text,
      'refund:account_recovery_billing_blocked',
      'recovery_payment_auto_refund',
      pg_catalog.jsonb_build_object(
        'reason_key', 'account_recovery_billing_blocked',
        'protocol_version', 'dispatch_commit_v1'
      )
    ) ON CONFLICT (
      source_kind, source_key, effect_type, operation_key
    ) DO NOTHING;

    INSERT INTO public.stripe_entitlement_effects (
      entitlement_payment_id, user_id, source_kind, source_key,
      operation_key, effect_type, payload
    ) VALUES (
      NULL, p_user_id, 'api_payment', v_payment.id::text,
      'cancel:subscription:' || p_stripe_subscription_id,
      'stripe_subscription_cancel',
      pg_catalog.jsonb_build_object(
        'stripe_subscription_id', p_stripe_subscription_id,
        'stripe_customer_id', p_stripe_customer_id,
        'reason', 'account_recovery_billing_blocked',
        'protocol_version', 'dispatch_commit_v1'
      )
    ) ON CONFLICT (
      source_kind, source_key, effect_type, operation_key
    ) DO NOTHING;

    SELECT effect.id INTO v_refund_effect_id
    FROM public.stripe_entitlement_effects AS effect
    WHERE effect.source_kind = 'api_payment'
      AND effect.source_key = v_payment.id::text
      AND effect.effect_type = 'recovery_payment_auto_refund'
      AND effect.operation_key = 'refund:account_recovery_billing_blocked';
    SELECT effect.id INTO v_cancel_effect_id
    FROM public.stripe_entitlement_effects AS effect
    WHERE effect.source_kind = 'api_payment'
      AND effect.source_key = v_payment.id::text
      AND effect.effect_type = 'stripe_subscription_cancel'
      AND effect.operation_key =
        'cancel:subscription:' || p_stripe_subscription_id;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'account_recovery_billing_blocked',
      'payment_id', v_payment.id,
      'ownership_id', v_ownership.id,
      'recovery_operation_id', v_recovery.recovery_operation_id,
      'refund_effect_id', v_refund_effect_id,
      'cancellation_effect_id', v_cancel_effect_id,
      'stripe_subscription_id', p_stripe_subscription_id,
      'idempotent_replay', NOT v_inserted
    );
  END IF;

  v_subscription_ack := public.apply_user_api_tier_stripe_event(
    p_user_id, p_metadata_user_id, p_metadata_supabase_user_id,
    p_stripe_customer_id, p_checkout_reservation_id, p_stripe_price_id,
    p_api_plan, v_daily_limit, p_stripe_subscription_id,
    p_subscription_created, p_event_id, v_event_created, true, false,
    p_livemode, p_checkout_session_id, p_api_plan, p_stripe_price_id,
    'signed_metadata'
  );
  IF v_subscription_ack NOT IN ('applied', 'idempotent', 'stale') THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'applied',
    'payment_id', v_payment.id,
    'ownership_id', v_ownership.id,
    'subscription_status', v_subscription_ack,
    'idempotent_replay', NOT v_inserted
  );
END
$function$;

ALTER FUNCTION public.apply_api_tier_paid_invoice_event_atomic(
  text, timestamptz, text, boolean, uuid, uuid, uuid, text, uuid, text,
  timestamptz, text, bigint, text, text, text, text, text, text, text, bigint,
  text, timestamptz, timestamptz, timestamptz, timestamptz
) OWNER TO postgres;

ALTER FUNCTION public.apply_user_api_tier_stripe_event(
  uuid, uuid, uuid, text, uuid, text, text, integer, text, bigint, text,
  bigint, boolean, boolean, boolean, text, text, text, text
) RENAME TO apply_user_api_tier_stripe_event_pre_payment_v2;
REVOKE ALL ON FUNCTION public.apply_user_api_tier_stripe_event_pre_payment_v2(
  uuid, uuid, uuid, text, uuid, text, text, integer, text, bigint, text,
  bigint, boolean, boolean, boolean, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.apply_user_api_tier_stripe_event(
  p_user_id uuid,
  p_metadata_user_id uuid,
  p_metadata_supabase_user_id uuid,
  p_stripe_customer_id text,
  p_checkout_reservation_id uuid,
  p_stripe_price_id text,
  p_api_tier text,
  p_daily_limit integer,
  p_stripe_subscription_id text,
  p_subscription_created bigint,
  p_stripe_event_id text,
  p_event_created bigint,
  p_is_active boolean,
  p_is_terminal boolean,
  p_livemode boolean,
  p_checkout_session_id text,
  p_checkout_api_plan text,
  p_checkout_price_id text,
  p_identity_source text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_reservation public.api_tier_checkout_reservations%ROWTYPE;
  v_recovery record;
  v_pending public.stripe_api_tier_pending_subscription_events%ROWTYPE;
  v_authority_payment public.stripe_api_tier_invoice_payments%ROWTYPE;
  v_lifecycle_checkout_at timestamptz;
  v_lifecycle_paid_at timestamptz;
  v_outcome text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'API tier event owner is invalid'
      USING ERRCODE = '22023';
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || p_user_id::text, 0
    )
  );

  -- Non-grant lifecycle events must always remain able to revoke an existing
  -- API projection. The historical writer already makes terminal state sticky.
  IF NOT COALESCE(p_is_active, false) THEN
    RETURN public.apply_user_api_tier_stripe_event_pre_payment_v2(
      p_user_id, p_metadata_user_id, p_metadata_supabase_user_id,
      p_stripe_customer_id, p_checkout_reservation_id, p_stripe_price_id,
      p_api_tier, p_daily_limit, p_stripe_subscription_id,
      p_subscription_created, p_stripe_event_id, p_event_created,
      p_is_active, p_is_terminal, p_livemode, p_checkout_session_id,
      p_checkout_api_plan, p_checkout_price_id, p_identity_source
    );
  END IF;

  IF p_metadata_user_id IS DISTINCT FROM p_user_id
    OR p_metadata_supabase_user_id IS DISTINCT FROM p_user_id
    OR p_checkout_reservation_id IS NULL
    OR p_checkout_session_id IS NULL
    OR p_identity_source IS DISTINCT FROM 'signed_metadata'
    OR p_checkout_api_plan IS DISTINCT FROM p_api_tier
    OR p_checkout_price_id IS DISTINCT FROM p_stripe_price_id
    OR p_api_tier NOT IN ('starter', 'pro')
    OR p_daily_limit IS DISTINCT FROM (CASE p_api_tier
      WHEN 'starter' THEN 10000 ELSE 0
    END)
    OR p_stripe_event_id IS NULL
    OR p_stripe_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR p_event_created IS NULL OR p_event_created <= 0
    OR p_livemode IS NULL
  THEN
    RAISE EXCEPTION 'active API tier event identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT reservation.* INTO v_reservation
  FROM public.api_tier_checkout_reservations AS reservation
  WHERE reservation.id = p_checkout_reservation_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_reservation.user_id IS DISTINCT FROM p_user_id
    OR v_reservation.livemode IS DISTINCT FROM p_livemode
    OR v_reservation.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
    OR v_reservation.checkout_session_id IS DISTINCT FROM p_checkout_session_id
    OR v_reservation.api_plan IS DISTINCT FROM p_api_tier
    OR v_reservation.stripe_price_id IS DISTINCT FROM p_stripe_price_id
    OR v_reservation.bound_at IS NULL
    OR v_reservation.status NOT IN (
      'bound', 'converted', 'account_recovery_billing_blocked'
    )
    OR (
      v_reservation.stripe_subscription_id IS NOT NULL
      AND v_reservation.stripe_subscription_id IS DISTINCT FROM
        p_stripe_subscription_id
    )
  THEN
    RETURN 'identity_conflict';
  END IF;

  SELECT payment.* INTO v_authority_payment
  FROM public.stripe_api_tier_invoice_payments AS payment
  WHERE payment.user_id = p_user_id
    AND payment.livemode = p_livemode
    AND payment.checkout_reservation_id = p_checkout_reservation_id
    AND payment.checkout_session_id = p_checkout_session_id
    AND payment.stripe_customer_id = p_stripe_customer_id
    AND payment.stripe_subscription_id = p_stripe_subscription_id
    AND payment.stripe_price_id = p_stripe_price_id
    AND payment.api_plan = p_api_tier
  ORDER BY payment.paid_at DESC, payment.id DESC
  LIMIT 1;
  v_lifecycle_checkout_at := LEAST(
    v_reservation.created_at,
    COALESCE(v_authority_payment.session_created_at, v_reservation.created_at)
  );
  v_lifecycle_paid_at := COALESCE(
    v_authority_payment.paid_at,
    pg_catalog.to_timestamp(p_event_created)
  );
  SELECT lifecycle.operation_id, lifecycle.recovery_claimed_at AS claimed_at
  INTO v_recovery
  FROM public.locate_account_recovery_payment_lifecycle_v2(
    p_user_id, v_lifecycle_checkout_at, v_lifecycle_paid_at
  ) AS lifecycle;
  v_outcome := CASE WHEN v_recovery.operation_id IS NULL
    THEN 'payment_pending'
    ELSE 'account_recovery_billing_blocked'
  END;

  IF v_recovery.operation_id IS NULL
    AND v_authority_payment.id IS NOT NULL
    AND v_authority_payment.authority_outcome = 'granted'
    AND NOT EXISTS (
      SELECT 1
      FROM public.stripe_api_tier_refund_revocations AS revocation
      WHERE revocation.payment_id = v_authority_payment.id
    )
  THEN
    RETURN public.apply_user_api_tier_stripe_event_pre_payment_v2(
      p_user_id, p_metadata_user_id, p_metadata_supabase_user_id,
      p_stripe_customer_id, p_checkout_reservation_id, p_stripe_price_id,
      p_api_tier, p_daily_limit, p_stripe_subscription_id,
      p_subscription_created, p_stripe_event_id, p_event_created,
      p_is_active, p_is_terminal, p_livemode, p_checkout_session_id,
      p_checkout_api_plan, p_checkout_price_id, p_identity_source
    );
  END IF;

  IF v_recovery.operation_id IS NOT NULL THEN
    UPDATE public.api_tier_checkout_reservations
    SET status = 'account_recovery_billing_blocked',
        stripe_subscription_id = p_stripe_subscription_id,
        release_reason = 'account_recovery_billing_blocked',
        release_event_id = p_stripe_event_id,
        release_event_created = p_event_created,
        released_at = COALESCE(released_at, pg_catalog.clock_timestamp()),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_checkout_reservation_id
      AND status IN ('bound', 'converted');
    INSERT INTO public.stripe_api_tier_recovery_subscription_blocks (
      livemode, stripe_subscription_id, user_id, stripe_customer_id,
      recovery_operation_id, recovery_claimed_at, source_event_id
    ) VALUES (
      p_livemode, p_stripe_subscription_id, p_user_id,
      p_stripe_customer_id, v_recovery.operation_id,
      v_recovery.claimed_at, p_stripe_event_id
    ) ON CONFLICT (livemode, stripe_subscription_id) DO NOTHING;
    INSERT INTO public.api_tier_subscription_blocks (
      livemode, stripe_subscription_id, block_kind, user_id,
      stripe_customer_id
    ) VALUES (
      p_livemode, p_stripe_subscription_id, 'account_recovery',
      p_user_id, p_stripe_customer_id
    ) ON CONFLICT (livemode, stripe_subscription_id, block_kind)
      DO NOTHING;
  END IF;

  INSERT INTO public.stripe_api_tier_pending_subscription_events (
    livemode, stripe_event_id, user_id, metadata_user_id,
    metadata_supabase_user_id, stripe_customer_id,
    checkout_reservation_id, stripe_price_id, stripe_subscription_id,
    subscription_created, stripe_event_created, api_tier, daily_limit,
    recovery_operation_id, outcome
  ) VALUES (
    p_livemode, p_stripe_event_id, p_user_id, p_metadata_user_id,
    p_metadata_supabase_user_id, p_stripe_customer_id,
    p_checkout_reservation_id, p_stripe_price_id,
    p_stripe_subscription_id, p_subscription_created, p_event_created,
    p_api_tier, p_daily_limit, v_recovery.operation_id, v_outcome
  ) ON CONFLICT (livemode, stripe_event_id) DO NOTHING;

  SELECT pending.* INTO v_pending
  FROM public.stripe_api_tier_pending_subscription_events AS pending
  WHERE pending.livemode = p_livemode
    AND pending.stripe_event_id = p_stripe_event_id;
  IF NOT FOUND
    OR v_pending.user_id IS DISTINCT FROM p_user_id
    OR v_pending.metadata_user_id IS DISTINCT FROM p_metadata_user_id
    OR v_pending.metadata_supabase_user_id IS DISTINCT FROM
      p_metadata_supabase_user_id
    OR v_pending.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
    OR v_pending.checkout_reservation_id IS DISTINCT FROM
      p_checkout_reservation_id
    OR v_pending.stripe_price_id IS DISTINCT FROM p_stripe_price_id
    OR v_pending.stripe_subscription_id IS DISTINCT FROM
      p_stripe_subscription_id
    OR v_pending.subscription_created IS DISTINCT FROM p_subscription_created
    OR v_pending.stripe_event_created IS DISTINCT FROM p_event_created
    OR v_pending.api_tier IS DISTINCT FROM p_api_tier
    OR v_pending.daily_limit IS DISTINCT FROM p_daily_limit
    OR v_pending.recovery_operation_id IS DISTINCT FROM
      v_recovery.operation_id
    OR v_pending.outcome IS DISTINCT FROM v_outcome
  THEN
    RETURN 'identity_conflict';
  END IF;
  RETURN v_outcome;
END
$function$;

ALTER FUNCTION public.apply_user_api_tier_stripe_event(
  uuid, uuid, uuid, text, uuid, text, text, integer, text, bigint, text,
  bigint, boolean, boolean, boolean, text, text, text, text
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.api_tier_recovery_effect_is_current_v2(
  p_effect_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT p_effect_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_effects AS effect
      JOIN public.stripe_api_tier_invoice_payments AS payment
        ON payment.id::text = effect.source_key
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.product_kind = 'api_tier'
       AND ownership.ledger_id = payment.id
      WHERE effect.id = p_effect_id
        AND effect.source_kind = 'api_payment'
        AND effect.entitlement_payment_id IS NULL
        AND effect.user_id = payment.user_id
        AND payment.authority_outcome =
          'account_recovery_billing_blocked'
        AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
        AND EXISTS (
          SELECT 1
          FROM public.stripe_api_tier_recovery_payment_blocks AS block
          WHERE block.payment_id = payment.id
        )
        AND (
          (
            effect.effect_type = 'recovery_payment_auto_refund'
            AND effect.operation_key =
              'refund:account_recovery_billing_blocked'
            AND effect.payload = pg_catalog.jsonb_build_object(
              'reason_key', 'account_recovery_billing_blocked',
              'protocol_version', 'dispatch_commit_v1'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM public.stripe_api_tier_refund_revocations AS revocation
              WHERE revocation.payment_id = payment.id
            )
          )
          OR (
            effect.effect_type = 'stripe_subscription_cancel'
            AND effect.operation_key =
              'cancel:subscription:' || payment.stripe_subscription_id
            AND effect.payload = pg_catalog.jsonb_build_object(
              'stripe_subscription_id', payment.stripe_subscription_id,
              'stripe_customer_id', payment.stripe_customer_id,
              'reason', 'account_recovery_billing_blocked',
              'protocol_version', 'dispatch_commit_v1'
            )
            AND EXISTS (
              SELECT 1
              FROM public.stripe_api_tier_recovery_cancellations
                AS cancellation
              WHERE cancellation.authority_payment_id = payment.id
                AND cancellation.livemode = payment.livemode
                AND cancellation.stripe_subscription_id =
                  payment.stripe_subscription_id
                AND cancellation.user_id = payment.user_id
                AND cancellation.stripe_customer_id =
                  payment.stripe_customer_id
            )
          )
        )
    )
$function$;

ALTER FUNCTION public.api_tier_recovery_effect_is_current_v2(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.api_tier_recovery_effect_is_current_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

ALTER FUNCTION public.stripe_entitlement_effect_is_current_v2(uuid)
  RENAME TO stripe_entitlement_effect_is_current_b2c_v2;
REVOKE ALL ON FUNCTION
  public.stripe_entitlement_effect_is_current_b2c_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.stripe_entitlement_effect_is_current_v2(
  p_effect_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.stripe_entitlement_effects AS effect
      WHERE effect.id = p_effect_id
        AND effect.source_kind = 'api_payment'
        AND effect.effect_type IN (
          'recovery_payment_auto_refund', 'stripe_subscription_cancel'
        )
    ) THEN public.api_tier_recovery_effect_is_current_v2(p_effect_id)
    ELSE public.stripe_entitlement_effect_is_current_b2c_v2(p_effect_id)
  END
$function$;

ALTER FUNCTION public.stripe_entitlement_effect_is_current_v2(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_entitlement_effect_is_current_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.claim_api_tier_recovery_payment_refund_dispatch_atomic(
    p_effect_id uuid,
    p_lease_token uuid,
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
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_effect public.stripe_entitlement_effects%ROWTYPE;
  v_payment public.stripe_api_tier_invoice_payments%ROWTYPE;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_effect_id IS NULL OR p_lease_token IS NULL OR p_livemode IS NULL THEN
    RAISE EXCEPTION 'API refund dispatch claim identity is invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT payment.* INTO v_payment
  FROM public.stripe_entitlement_effects AS effect
  JOIN public.stripe_api_tier_invoice_payments AS payment
    ON payment.id::text = effect.source_key
  WHERE effect.id = p_effect_id
    AND effect.source_kind = 'api_payment'
    AND effect.effect_type = 'recovery_payment_auto_refund';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_payment.user_id::text, 0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || v_payment.stripe_charge_id, 0
    )
  );
  IF v_payment.stripe_payment_intent_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-payment-identity:' || v_payment.stripe_payment_intent_id, 0
      )
    );
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-checkout-session:' || v_payment.checkout_session_id, 0
    )
  );
  SELECT payment.* INTO v_payment
  FROM public.stripe_api_tier_invoice_payments AS payment
  WHERE payment.id::text = (
    SELECT effect.source_key
    FROM public.stripe_entitlement_effects AS effect
    WHERE effect.id = p_effect_id
  ) FOR UPDATE;
  SELECT effect.* INTO v_effect
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.id = p_effect_id FOR UPDATE;
  IF NOT FOUND
    OR v_payment.livemode IS DISTINCT FROM p_livemode
    OR v_effect.status IS DISTINCT FROM 'processing'
    OR v_effect.lease_token IS DISTINCT FROM p_lease_token
    OR v_effect.lease_expires_at IS NULL
    OR v_effect.lease_expires_at <= v_now
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'lease_lost');
  END IF;
  IF v_effect.dispatch_committed_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_dispatch_committed',
      'product_kind', 'api_tier',
      'user_id', v_payment.user_id,
      'livemode', v_payment.livemode,
      'stripe_customer_id', v_payment.stripe_customer_id,
      'stripe_payment_intent_id', v_payment.stripe_payment_intent_id,
      'stripe_charge_id', v_payment.stripe_charge_id,
      'amount', v_payment.amount_paid,
      'currency', v_payment.currency
    );
  END IF;
  IF NOT public.api_tier_recovery_effect_is_current_v2(p_effect_id) THEN
    UPDATE public.stripe_entitlement_effects
    SET status = 'superseded', lease_token = NULL, lease_expires_at = NULL,
        last_error = 'authority_superseded_before_refund_dispatch',
        completed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_effect_id;
    RETURN pg_catalog.jsonb_build_object('status', 'authority_superseded');
  END IF;
  UPDATE public.stripe_entitlement_effects
  SET dispatch_committed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_effect_id AND dispatch_committed_at IS NULL;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'dispatch_committed',
    'product_kind', 'api_tier',
    'user_id', v_payment.user_id,
    'livemode', v_payment.livemode,
    'stripe_customer_id', v_payment.stripe_customer_id,
    'stripe_payment_intent_id', v_payment.stripe_payment_intent_id,
    'stripe_charge_id', v_payment.stripe_charge_id,
    'amount', v_payment.amount_paid,
    'currency', v_payment.currency
  );
END
$function$;

ALTER FUNCTION
  public.claim_api_tier_recovery_payment_refund_dispatch_atomic(
    uuid, uuid, boolean
  ) OWNER TO postgres;

CREATE OR REPLACE FUNCTION
  public.claim_api_tier_subscription_cancel_dispatch_atomic(
    p_effect_id uuid,
    p_lease_token uuid,
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
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_effect public.stripe_entitlement_effects%ROWTYPE;
  v_payment public.stripe_api_tier_invoice_payments%ROWTYPE;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_effect_id IS NULL OR p_lease_token IS NULL OR p_livemode IS NULL THEN
    RAISE EXCEPTION 'API cancellation dispatch claim identity is invalid'
      USING ERRCODE = '22023';
  END IF;
  SELECT payment.* INTO v_payment
  FROM public.stripe_entitlement_effects AS effect
  JOIN public.stripe_api_tier_invoice_payments AS payment
    ON payment.id::text = effect.source_key
  WHERE effect.id = p_effect_id
    AND effect.source_kind = 'api_payment'
    AND effect.effect_type = 'stripe_subscription_cancel';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_payment.user_id::text, 0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'api-tier-stripe-subscription:' || p_livemode::text || ':' ||
        v_payment.stripe_subscription_id, 0
    )
  );
  SELECT payment.* INTO v_payment
  FROM public.stripe_api_tier_invoice_payments AS payment
  WHERE payment.id::text = (
    SELECT effect.source_key FROM public.stripe_entitlement_effects AS effect
    WHERE effect.id = p_effect_id
  ) FOR UPDATE;
  SELECT effect.* INTO v_effect
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.id = p_effect_id FOR UPDATE;
  IF NOT FOUND
    OR v_payment.livemode IS DISTINCT FROM p_livemode
    OR v_effect.status IS DISTINCT FROM 'processing'
    OR v_effect.lease_token IS DISTINCT FROM p_lease_token
    OR v_effect.lease_expires_at IS NULL
    OR v_effect.lease_expires_at <= v_now
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'lease_lost');
  END IF;
  IF v_effect.dispatch_committed_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_dispatch_committed',
      'product_kind', 'api_tier',
      'user_id', v_payment.user_id,
      'livemode', v_payment.livemode,
      'stripe_customer_id', v_payment.stripe_customer_id,
      'stripe_subscription_id', v_payment.stripe_subscription_id
    );
  END IF;
  IF NOT public.api_tier_recovery_effect_is_current_v2(p_effect_id) THEN
    UPDATE public.stripe_entitlement_effects
    SET status = 'superseded', lease_token = NULL, lease_expires_at = NULL,
        last_error = 'authority_superseded_before_cancel_dispatch',
        completed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_effect_id;
    RETURN pg_catalog.jsonb_build_object('status', 'authority_superseded');
  END IF;
  UPDATE public.stripe_entitlement_effects
  SET dispatch_committed_at = pg_catalog.clock_timestamp(),
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = p_effect_id AND dispatch_committed_at IS NULL;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'dispatch_committed',
    'product_kind', 'api_tier',
    'user_id', v_payment.user_id,
    'livemode', v_payment.livemode,
    'stripe_customer_id', v_payment.stripe_customer_id,
    'stripe_subscription_id', v_payment.stripe_subscription_id
  );
END
$function$;

ALTER FUNCTION public.claim_api_tier_subscription_cancel_dispatch_atomic(
  uuid, uuid, boolean
) OWNER TO postgres;

ALTER FUNCTION public.claim_stripe_subscription_cancel_dispatch_atomic(
  uuid, uuid, boolean
) RENAME TO claim_stripe_subscription_cancel_dispatch_pre_api_v2;
REVOKE ALL ON FUNCTION
  public.claim_stripe_subscription_cancel_dispatch_pre_api_v2(
    uuid, uuid, boolean
  ) FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.claim_stripe_subscription_cancel_dispatch_atomic(
    p_effect_id uuid,
    p_lease_token uuid,
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
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_source_kind text;
  v_effect_type text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  SELECT effect.source_kind, effect.effect_type
  INTO v_source_kind, v_effect_type
  FROM public.stripe_entitlement_effects AS effect
  WHERE effect.id = p_effect_id;
  IF v_source_kind = 'api_payment'
    AND v_effect_type = 'stripe_subscription_cancel'
  THEN
    RETURN public.claim_api_tier_subscription_cancel_dispatch_atomic(
      p_effect_id, p_lease_token, p_livemode
    );
  END IF;
  RETURN public.claim_stripe_subscription_cancel_dispatch_pre_api_v2(
    p_effect_id, p_lease_token, p_livemode
  );
END
$function$;

ALTER FUNCTION public.claim_stripe_subscription_cancel_dispatch_atomic(
  uuid, uuid, boolean
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION
  public.resolve_api_tier_refund_tombstone_atomic(p_ownership_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_payment public.stripe_api_tier_invoice_payments%ROWTYPE;
  v_tombstone public.stripe_charge_refund_tombstones%ROWTYPE;
  v_revocation public.stripe_api_tier_refund_revocations%ROWTYPE;
  v_projection_ack text;
  v_event_created bigint;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_ownership_id IS NULL THEN
    RAISE EXCEPTION 'API refund ownership is required'
      USING ERRCODE = '22023';
  END IF;
  SELECT ownership.* INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = p_ownership_id
    AND ownership.product_kind = 'api_tier';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT payment.* INTO v_payment
  FROM public.stripe_api_tier_invoice_payments AS payment
  WHERE payment.id = v_ownership.ledger_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_payment.user_id::text, 0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || v_payment.stripe_charge_id, 0
    )
  );
  IF v_payment.stripe_payment_intent_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-payment-identity:' || v_payment.stripe_payment_intent_id, 0
      )
    );
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'api-tier-stripe-subscription:' || v_payment.livemode::text || ':' ||
        v_payment.stripe_subscription_id, 0
    )
  );
  SELECT ownership.* INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = p_ownership_id FOR UPDATE;
  SELECT payment.* INTO v_payment
  FROM public.stripe_api_tier_invoice_payments AS payment
  WHERE payment.id = v_ownership.ledger_id FOR UPDATE;
  SELECT tombstone.* INTO v_tombstone
  FROM public.stripe_charge_refund_tombstones AS tombstone
  WHERE tombstone.stripe_charge_id = v_payment.stripe_charge_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'no_tombstone');
  END IF;
  IF NOT public.stripe_payment_ownership_is_exact_v2(v_ownership.id)
    OR v_tombstone.stripe_customer_id IS DISTINCT FROM
      v_payment.stripe_customer_id
    OR v_tombstone.stripe_payment_intent_id IS DISTINCT FROM
      v_payment.stripe_payment_intent_id
    OR v_tombstone.amount_paid IS DISTINCT FROM v_payment.amount_paid
    OR v_tombstone.currency IS DISTINCT FROM v_payment.currency
    OR v_tombstone.captured IS DISTINCT FROM true
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstone_events AS event_row
      WHERE event_row.event_id = v_tombstone.refund_snapshot_event_id
        AND event_row.stripe_charge_id = v_tombstone.stripe_charge_id
        AND event_row.event_created_at =
          v_tombstone.refund_snapshot_event_created_at
        AND event_row.observations @> pg_catalog.jsonb_build_array(
          pg_catalog.jsonb_build_object(
            'refund_state', v_tombstone.refund_state,
            'refund_succeeded_amount',
              v_tombstone.refund_succeeded_amount
          )
        )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  IF v_tombstone.resolution_kind = 'unclassified' THEN
    UPDATE public.stripe_charge_refund_tombstones
    SET resolution_kind = 'non_entitlement_payment',
        resolution_ownership_id = v_ownership.id,
        resolution_reference = 'ownership:' || v_ownership.id::text,
        updated_at = pg_catalog.clock_timestamp()
    WHERE stripe_charge_id = v_tombstone.stripe_charge_id
      AND resolution_kind = 'unclassified';
  ELSIF v_tombstone.resolution_kind IS DISTINCT FROM
      'non_entitlement_payment'
    OR v_tombstone.resolution_ownership_id IS DISTINCT FROM v_ownership.id
    OR v_tombstone.merged_payment_id IS NOT NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF v_tombstone.refund_state IS DISTINCT FROM 'succeeded'
    OR v_tombstone.refund_succeeded_amount < v_tombstone.amount_paid
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'api_tier_refund_recorded',
      'payment_id', v_payment.id,
      'ownership_id', v_ownership.id,
      'stripe_subscription_id', v_payment.stripe_subscription_id
    );
  END IF;

  SELECT revocation.* INTO v_revocation
  FROM public.stripe_api_tier_refund_revocations AS revocation
  WHERE revocation.payment_id = v_payment.id;
  IF FOUND THEN
    IF v_revocation.ownership_id IS DISTINCT FROM v_ownership.id
      OR v_revocation.refund_event_id IS DISTINCT FROM
        v_tombstone.refund_snapshot_event_id
      OR v_revocation.refund_event_created_at IS DISTINCT FROM
        v_tombstone.refund_snapshot_event_created_at
      OR v_revocation.refund_succeeded_amount IS DISTINCT FROM
        v_tombstone.refund_succeeded_amount
      OR v_revocation.amount_paid IS DISTINCT FROM v_tombstone.amount_paid
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'api_tier_full_refund_already_revoked',
      'payment_id', v_payment.id,
      'ownership_id', v_ownership.id,
      'stripe_subscription_id', v_payment.stripe_subscription_id
    );
  END IF;

  INSERT INTO public.api_tier_subscription_blocks (
    livemode, stripe_subscription_id, block_kind, user_id,
    stripe_customer_id
  ) VALUES (
    v_payment.livemode, v_payment.stripe_subscription_id,
    'financial_reversal', v_payment.user_id, v_payment.stripe_customer_id
  ) ON CONFLICT (livemode, stripe_subscription_id, block_kind)
    DO NOTHING;
  v_event_created := pg_catalog.floor(extract(
    epoch FROM v_tombstone.refund_snapshot_event_created_at
  ))::bigint;
  v_projection_ack := public.apply_user_api_tier_stripe_event_pre_payment_v2(
    v_payment.user_id, v_payment.metadata_user_id,
    v_payment.metadata_supabase_user_id, v_payment.stripe_customer_id,
    NULL, v_payment.stripe_price_id, 'free', 100,
    v_payment.stripe_subscription_id, v_payment.subscription_created,
    v_tombstone.refund_snapshot_event_id, v_event_created, false, true,
    v_payment.livemode, NULL, NULL, NULL, 'persisted_subscription'
  );
  IF v_projection_ack NOT IN (
    'applied', 'idempotent', 'stale', 'not_current', 'blocked',
    'subject_deleted'
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  INSERT INTO public.stripe_api_tier_refund_revocations (
    payment_id, ownership_id, refund_event_id,
    refund_event_created_at, refund_succeeded_amount, amount_paid,
    projection_event_id
  ) VALUES (
    v_payment.id, v_ownership.id, v_tombstone.refund_snapshot_event_id,
    v_tombstone.refund_snapshot_event_created_at,
    v_tombstone.refund_succeeded_amount, v_tombstone.amount_paid,
    v_tombstone.refund_snapshot_event_id
  ) RETURNING * INTO v_revocation;
  RETURN pg_catalog.jsonb_build_object(
    'status', 'api_tier_full_refund_revoked',
    'payment_id', v_payment.id,
    'ownership_id', v_ownership.id,
    'stripe_subscription_id', v_payment.stripe_subscription_id
  );
END
$function$;

ALTER FUNCTION public.resolve_api_tier_refund_tombstone_atomic(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_api_tier_refund_tombstone_atomic(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

ALTER FUNCTION public.record_charge_refund_tombstone_atomic(
  uuid, text, text, text, boolean, bigint, text, bigint, text, text,
  timestamptz
) RENAME TO record_charge_refund_tombstone_pre_api_v2;
REVOKE ALL ON FUNCTION public.record_charge_refund_tombstone_pre_api_v2(
  uuid, text, text, text, boolean, bigint, text, bigint, text, text,
  timestamptz
) FROM PUBLIC, anon, authenticated, service_role, authenticator;

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
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
SET idle_in_transaction_session_timeout = '30s'
AS $function$
DECLARE
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_record jsonb;
  v_projection jsonb;
  v_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  SELECT pg_catalog.count(*)::integer
  INTO v_count
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.product_kind = 'api_tier'
    AND (
      ownership.stripe_charge_id = p_stripe_charge_id
      OR (
        p_stripe_payment_intent_id IS NOT NULL
        AND ownership.stripe_payment_intent_id = p_stripe_payment_intent_id
      )
    );
  IF v_count = 0 THEN
    RETURN public.record_charge_refund_tombstone_pre_api_v2(
      p_user_id, p_stripe_customer_id, p_stripe_payment_intent_id,
      p_stripe_charge_id, p_captured, p_amount_paid, p_currency,
      p_refund_succeeded_amount, p_refund_state, p_refund_event_id,
      p_refund_event_created_at
    );
  END IF;
  IF v_count <> 1 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  SELECT ownership.* INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.product_kind = 'api_tier'
    AND (
      ownership.stripe_charge_id = p_stripe_charge_id
      OR (
        p_stripe_payment_intent_id IS NOT NULL
        AND ownership.stripe_payment_intent_id = p_stripe_payment_intent_id
      )
    );
  IF NOT public.stripe_payment_ownership_is_exact_v2(v_ownership.id)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;
  v_record := public.record_charge_refund_tombstone_financial_legacy_v2(
    NULL, p_stripe_customer_id, p_stripe_payment_intent_id,
    p_stripe_charge_id, p_captured, p_amount_paid, p_currency,
    p_refund_succeeded_amount, p_refund_state, p_refund_event_id,
    p_refund_event_created_at
  );
  IF COALESCE(v_record ->> 'status', '') IN (
    'identity_conflict', 'manual_review'
  ) THEN
    RETURN v_record;
  END IF;
  v_projection := public.resolve_api_tier_refund_tombstone_atomic(
    v_ownership.id
  );
  IF COALESCE(v_projection ->> 'status', '') IN (
    'identity_conflict', 'manual_review'
  ) THEN
    RETURN v_projection || pg_catalog.jsonb_build_object(
      'record_status', v_record ->> 'status'
    );
  END IF;
  RETURN v_record || pg_catalog.jsonb_build_object(
    'ownership_status', 'already_claimed',
    'ownership_id', v_ownership.id,
    'product_kind', 'api_tier',
    'projection_status', v_projection ->> 'status'
  );
END
$function$;

ALTER FUNCTION public.record_charge_refund_tombstone_atomic(
  uuid, text, text, text, boolean, bigint, text, bigint, text, text,
  timestamptz
) OWNER TO postgres;

ALTER FUNCTION public.stripe_refund_tombstone_is_resolved_v2(text)
  RENAME TO stripe_refund_tombstone_is_resolved_pre_api_v2;
REVOKE ALL ON FUNCTION
  public.stripe_refund_tombstone_is_resolved_pre_api_v2(text)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION public.stripe_refund_tombstone_is_resolved_v2(
  p_stripe_charge_id text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
  SELECT public.stripe_refund_tombstone_is_resolved_pre_api_v2(
      p_stripe_charge_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstones AS tombstone
      JOIN public.stripe_payment_ownerships AS ownership
        ON ownership.id = tombstone.resolution_ownership_id
      JOIN public.stripe_api_tier_invoice_payments AS payment
        ON payment.id = ownership.ledger_id
      WHERE tombstone.stripe_charge_id = p_stripe_charge_id
        AND tombstone.resolution_kind = 'non_entitlement_payment'
        AND tombstone.merged_payment_id IS NULL
        AND ownership.product_kind = 'api_tier'
        AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
        AND tombstone.stripe_customer_id = payment.stripe_customer_id
        AND tombstone.stripe_payment_intent_id IS NOT DISTINCT FROM
          payment.stripe_payment_intent_id
        AND tombstone.amount_paid = payment.amount_paid
        AND tombstone.currency = payment.currency
        AND tombstone.captured
        AND EXISTS (
          SELECT 1
          FROM public.stripe_charge_refund_tombstone_events AS event_row
          WHERE event_row.event_id = tombstone.refund_snapshot_event_id
            AND event_row.stripe_charge_id = tombstone.stripe_charge_id
            AND event_row.event_created_at =
              tombstone.refund_snapshot_event_created_at
            AND event_row.observations @> pg_catalog.jsonb_build_array(
              pg_catalog.jsonb_build_object(
                'refund_state', tombstone.refund_state,
                'refund_succeeded_amount',
                  tombstone.refund_succeeded_amount
              )
            )
        )
        AND (
          NOT (
            tombstone.refund_state = 'succeeded'
            AND tombstone.refund_succeeded_amount >= tombstone.amount_paid
          )
          OR EXISTS (
            SELECT 1
            FROM public.stripe_api_tier_refund_revocations AS revocation
            WHERE revocation.payment_id = payment.id
              AND revocation.ownership_id = ownership.id
              AND revocation.refund_event_id =
                tombstone.refund_snapshot_event_id
              AND revocation.refund_event_created_at =
                tombstone.refund_snapshot_event_created_at
              AND revocation.refund_succeeded_amount =
                tombstone.refund_succeeded_amount
              AND revocation.amount_paid = tombstone.amount_paid
              AND EXISTS (
                SELECT 1
                FROM public.api_tier_subscription_blocks AS block
                WHERE block.livemode = payment.livemode
                  AND block.stripe_subscription_id =
                    payment.stripe_subscription_id
                  AND block.block_kind = 'financial_reversal'
                  AND block.user_id = payment.user_id
                  AND block.stripe_customer_id = payment.stripe_customer_id
              )
          )
        )
    )
$function$;

ALTER FUNCTION public.stripe_refund_tombstone_is_resolved_v2(text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_refund_tombstone_is_resolved_v2(text)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

REVOKE ALL ON FUNCTION
  public.locate_api_tier_invoice_authority_atomic(
    text, timestamptz, boolean, text, uuid, uuid, uuid, text, uuid, text,
    timestamptz, text, text, text, bigint, timestamptz, timestamptz
  ),
  public.apply_api_tier_paid_invoice_event_atomic(
    text, timestamptz, text, boolean, uuid, uuid, uuid, text, uuid, text,
    timestamptz, text, bigint, text, text, text, text, text, text, text, bigint,
    text, timestamptz, timestamptz, timestamptz, timestamptz
  ),
  public.apply_user_api_tier_stripe_event(
    uuid, uuid, uuid, text, uuid, text, text, integer, text, bigint, text,
    bigint, boolean, boolean, boolean, text, text, text, text
  ),
  public.claim_api_tier_recovery_payment_refund_dispatch_atomic(
    uuid, uuid, boolean
  ),
  public.claim_api_tier_subscription_cancel_dispatch_atomic(
    uuid, uuid, boolean
  ),
  public.claim_stripe_subscription_cancel_dispatch_atomic(
    uuid, uuid, boolean
  ),
  public.record_charge_refund_tombstone_atomic(
    uuid, text, text, text, boolean, bigint, text, bigint, text, text,
    timestamptz
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

GRANT EXECUTE ON FUNCTION
  public.locate_api_tier_invoice_authority_atomic(
    text, timestamptz, boolean, text, uuid, uuid, uuid, text, uuid, text,
    timestamptz, text, text, text, bigint, timestamptz, timestamptz
  ),
  public.apply_api_tier_paid_invoice_event_atomic(
    text, timestamptz, text, boolean, uuid, uuid, uuid, text, uuid, text,
    timestamptz, text, bigint, text, text, text, text, text, text, text, bigint,
    text, timestamptz, timestamptz, timestamptz, timestamptz
  ),
  public.apply_user_api_tier_stripe_event(
    uuid, uuid, uuid, text, uuid, text, text, integer, text, bigint, text,
    bigint, boolean, boolean, boolean, text, text, text, text
  ),
  public.claim_api_tier_recovery_payment_refund_dispatch_atomic(
    uuid, uuid, boolean
  ),
  public.claim_api_tier_subscription_cancel_dispatch_atomic(
    uuid, uuid, boolean
  ),
  public.claim_stripe_subscription_cancel_dispatch_atomic(
    uuid, uuid, boolean
  ),
  public.record_charge_refund_tombstone_atomic(
    uuid, text, text, text, boolean, bigint, text, bigint, text, text,
    timestamptz
  )
TO service_role;

DO $postflight$
DECLARE
  v_postgres oid := 'postgres'::pg_catalog.regrole;
  v_service oid := 'service_role'::pg_catalog.regrole;
  v_external pg_catalog.regprocedure[] := ARRAY[
    'public.locate_api_tier_invoice_authority_atomic(text,timestamp with time zone,boolean,text,uuid,uuid,uuid,text,uuid,text,timestamp with time zone,text,text,text,bigint,timestamp with time zone,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.apply_api_tier_paid_invoice_event_atomic(text,timestamp with time zone,text,boolean,uuid,uuid,uuid,text,uuid,text,timestamp with time zone,text,bigint,text,text,text,text,text,text,text,bigint,text,timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.apply_user_api_tier_stripe_event(uuid,uuid,uuid,text,uuid,text,text,integer,text,bigint,text,bigint,boolean,boolean,boolean,text,text,text,text)'::pg_catalog.regprocedure,
    'public.claim_api_tier_recovery_payment_refund_dispatch_atomic(uuid,uuid,boolean)'::pg_catalog.regprocedure,
    'public.claim_api_tier_subscription_cancel_dispatch_atomic(uuid,uuid,boolean)'::pg_catalog.regprocedure,
    'public.claim_stripe_subscription_cancel_dispatch_atomic(uuid,uuid,boolean)'::pg_catalog.regprocedure,
    'public.record_charge_refund_tombstone_atomic(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)'::pg_catalog.regprocedure
  ];
  v_internal pg_catalog.regprocedure[] := ARRAY[
    'public.api_tier_recovery_effect_is_current_v2(uuid)'::pg_catalog.regprocedure,
    'public.resolve_api_tier_refund_tombstone_atomic(uuid)'::pg_catalog.regprocedure,
    'public.stripe_payment_ownership_is_exact_v2(uuid)'::pg_catalog.regprocedure,
    'public.stripe_refund_tombstone_is_resolved_v2(text)'::pg_catalog.regprocedure
  ];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname IN (
        'locate_api_tier_invoice_authority_atomic',
        'apply_api_tier_paid_invoice_event_atomic',
        'claim_api_tier_recovery_payment_refund_dispatch_atomic',
        'claim_api_tier_subscription_cancel_dispatch_atomic',
        'api_tier_recovery_effect_is_current_v2'
      )
    GROUP BY routine.proname
    HAVING pg_catalog.count(*) <> 1
  ) THEN
    RAISE EXCEPTION 'API tier recovery payment overload inventory drifted';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_external) AS required(function_oid)
    JOIN pg_catalog.pg_proc AS routine ON routine.oid = required.function_oid
    WHERE routine.proowner <> v_postgres
      OR NOT routine.prosecdef
      OR routine.provolatile <> 'v'
      OR NOT pg_catalog.has_function_privilege(
        v_service, routine.oid, 'EXECUTE'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_internal) AS required(function_oid)
    JOIN pg_catalog.pg_proc AS routine ON routine.oid = required.function_oid
    WHERE routine.proowner <> v_postgres
      OR NOT routine.prosecdef
      OR pg_catalog.has_function_privilege(
        v_service, routine.oid, 'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION 'API tier recovery payment function ACL drifted';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY[
      'public.stripe_api_tier_invoice_locators'::pg_catalog.regclass,
      'public.stripe_api_tier_invoice_payments'::pg_catalog.regclass,
      'public.stripe_api_tier_invoice_events'::pg_catalog.regclass,
      'public.stripe_api_tier_pending_subscription_events'::pg_catalog.regclass,
      'public.stripe_api_tier_recovery_subscription_blocks'::pg_catalog.regclass,
      'public.stripe_api_tier_recovery_payment_blocks'::pg_catalog.regclass,
      'public.stripe_api_tier_recovery_cancellations'::pg_catalog.regclass,
      'public.stripe_api_tier_refund_revocations'::pg_catalog.regclass
    ]) AS required(relation_oid)
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = required.relation_oid
    WHERE relation.relowner <> v_postgres
      OR NOT relation.relrowsecurity
      OR NOT relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'API tier recovery payment relation security drifted';
  END IF;
END
$postflight$;

COMMENT ON TABLE public.stripe_api_tier_invoice_payments IS
  'Immutable exact API-tier Invoice money ledger; grants and recovery-blocked refund/cancel outcomes share one signed Stripe identity.';
COMMENT ON FUNCTION public.locate_api_tier_invoice_authority_atomic(
  text, timestamptz, boolean, text, uuid, uuid, uuid, text, uuid, text,
  timestamptz, text, text, text, bigint, timestamptz, timestamptz
) IS
  'Locates historical API Price identity only through a fresh exact Subscription and its unique signed Checkout Session reservation; never through current environment Price guesses.';

COMMIT;
