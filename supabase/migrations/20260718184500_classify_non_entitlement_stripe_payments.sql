-- Classify exact Stripe payment ownership across Pro entitlements, post tips,
-- and paid group passes. A refund can arrive before the product writer, so a
-- Charge tombstone remains the append-only financial event chain while the
-- later product ledger atomically claims the globally unique PaymentIntent and
-- Charge and resolves that tombstone without pretending it was a Pro payment.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';

-- Acquire the cutover fence before the first catalog or business-table read.
-- Under REPEATABLE READ, even a prerequisite query establishes the reusable
-- snapshot; locking later could therefore backfill from a snapshot that
-- predates a concurrently committed Pro payment.
LOCK TABLE
  public.tips,
  public.group_subscriptions,
  public.group_members,
  public.group_payment_consumptions,
  public.group_trial_consumptions,
  public.stripe_entitlement_payments,
  public.stripe_charge_refund_tombstones,
  public.stripe_charge_refund_tombstone_events
IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_required_relation text;
  v_required_function text;
BEGIN
  FOREACH v_required_relation IN ARRAY ARRAY[
    'public.tips',
    'public.group_subscriptions',
    'public.group_members',
    'public.group_payment_consumptions',
    'public.group_trial_consumptions',
    'public.stripe_entitlement_payments',
    'public.stripe_charge_refund_tombstones',
    'public.stripe_charge_refund_tombstone_events',
    'public.stripe_entitlement_refund_events',
    'public.stripe_manual_reviews'
  ]
  LOOP
    IF pg_catalog.to_regclass(v_required_relation) IS NULL THEN
      RAISE EXCEPTION
        'non-entitlement Stripe ownership prerequisite is missing: %',
        v_required_relation;
    END IF;
  END LOOP;

  FOREACH v_required_function IN ARRAY ARRAY[
    'public.record_stripe_manual_review_atomic(text,text,uuid,text,text,jsonb)',
    'public.record_charge_refund_tombstone_atomic(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)',
    'public.stripe_merge_charge_refund_tombstone_v2(uuid)',
    'public.stripe_paid_launch_readiness_v2()',
    'public.activate_group_subscription_atomic(uuid,uuid,text,text,text,text,bigint,text)'
  ]
  LOOP
    IF pg_catalog.to_regprocedure(v_required_function) IS NULL THEN
      RAISE EXCEPTION
        'non-entitlement Stripe ownership function is missing: %',
        v_required_function;
    END IF;
  END LOOP;

  IF pg_catalog.to_regrole('postgres') IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
  THEN
    RAISE EXCEPTION 'non-entitlement Stripe ownership roles are missing';
  END IF;

  IF pg_catalog.to_regprocedure(
      'public.stripe_paid_launch_readiness_entitlement_only_legacy_v2()'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.record_charge_refund_tombstone_financial_legacy_v2(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)'
    ) IS NOT NULL
    OR pg_catalog.to_regclass('public.stripe_payment_ownerships') IS NOT NULL
  THEN
    RAISE EXCEPTION
      'non-entitlement Stripe ownership migration was partially applied';
  END IF;

  IF EXISTS (
    SELECT tip.stripe_payment_intent_id
    FROM public.tips AS tip
    WHERE tip.stripe_payment_intent_id IS NOT NULL
    GROUP BY tip.stripe_payment_intent_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'duplicate tip PaymentIntent identities require explicit review';
  END IF;

  IF EXISTS (
    SELECT tip.stripe_checkout_session_id
    FROM public.tips AS tip
    WHERE tip.stripe_checkout_session_id IS NOT NULL
    GROUP BY tip.stripe_checkout_session_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'duplicate tip Checkout Session identities require explicit review';
  END IF;
END
$preflight$;

-- Preserve the proven append-only financial aggregate writer behind a private
-- ACL. The public same-signature wrapper created below invokes it and then
-- projects the newest aggregate through exact central product ownership in the
-- same transaction.
ALTER FUNCTION public.record_charge_refund_tombstone_atomic(
  uuid, text, text, text, boolean, bigint, text, bigint, text, text,
  timestamptz
)
RENAME TO record_charge_refund_tombstone_financial_legacy_v2;
REVOKE ALL ON FUNCTION
  public.record_charge_refund_tombstone_financial_legacy_v2(
    uuid, text, text, text, boolean, bigint, text, bigint, text, text,
    timestamptz
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

ALTER TABLE public.tips
  ADD COLUMN stripe_charge_id text,
  ADD COLUMN stripe_customer_id text,
  ADD COLUMN currency text;

ALTER TABLE public.tips
  ADD CONSTRAINT tips_stripe_payment_intent_shape
    CHECK (
      stripe_payment_intent_id IS NULL
      OR pg_catalog.left(stripe_payment_intent_id, 3) = 'pi_'
    ),
  ADD CONSTRAINT tips_stripe_checkout_session_shape
    CHECK (
      stripe_checkout_session_id IS NULL
      OR pg_catalog.left(stripe_checkout_session_id, 3) = 'cs_'
    ),
  ADD CONSTRAINT tips_stripe_charge_shape
    CHECK (
      stripe_charge_id IS NULL
      OR pg_catalog.left(stripe_charge_id, 3) = 'ch_'
    ),
  ADD CONSTRAINT tips_stripe_customer_shape
    CHECK (
      stripe_customer_id IS NULL
      OR pg_catalog.left(stripe_customer_id, 4) = 'cus_'
    ),
  ADD CONSTRAINT tips_stripe_currency_shape
    CHECK (currency IS NULL OR currency ~ '^[a-z]{3}$'),
  ADD CONSTRAINT tips_exact_stripe_identity_shape
    CHECK (
      (
        stripe_charge_id IS NULL
        AND stripe_customer_id IS NULL
        AND currency IS NULL
      )
      OR (
        stripe_charge_id IS NOT NULL
        AND stripe_customer_id IS NOT NULL
        AND currency IS NOT NULL
        AND stripe_payment_intent_id IS NOT NULL
        AND stripe_checkout_session_id IS NOT NULL
      )
    );

CREATE UNIQUE INDEX tips_stripe_payment_intent_unique
  ON public.tips (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX tips_stripe_checkout_session_unique
  ON public.tips (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX tips_stripe_charge_unique
  ON public.tips (stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;

-- The existing "own tips" RLS policy permits both the tipper and recipient to
-- read a row. A table-level SELECT would therefore expose the payer's new
-- Customer and Charge identities to the recipient. Preserve the existing
-- browser-safe surface as explicit columns and keep the two new financial
-- identifiers service-only.
REVOKE SELECT ON TABLE public.tips
  FROM PUBLIC, anon, authenticated, authenticator;
GRANT SELECT (
  id,
  post_id,
  from_user_id,
  to_user_id,
  amount_cents,
  message,
  status,
  stripe_checkout_session_id,
  stripe_payment_intent_id,
  completed_at,
  created_at,
  updated_at,
  currency
) ON TABLE public.tips TO authenticated;

ALTER TABLE public.group_payment_consumptions
  ADD COLUMN stripe_charge_id text,
  ADD COLUMN stripe_customer_id text,
  ADD COLUMN payment_member_joined_at timestamptz,
  ADD CONSTRAINT group_payment_consumptions_charge_shape
    CHECK (
      stripe_charge_id IS NULL
      OR pg_catalog.left(stripe_charge_id, 3) = 'ch_'
    ),
  ADD CONSTRAINT group_payment_consumptions_customer_shape
    CHECK (
      stripe_customer_id IS NULL
      OR pg_catalog.left(stripe_customer_id, 4) = 'cus_'
    ),
  ADD CONSTRAINT group_payment_consumptions_exact_identity_shape
    CHECK (
      (stripe_charge_id IS NULL) = (stripe_customer_id IS NULL)
    ),
  ADD CONSTRAINT group_payment_consumptions_member_provenance_shape
    CHECK (
      payment_member_joined_at IS NULL
      OR (
        outcome IN ('activated', 'renewed')
        AND result ->> 'membership_status' = 'joined'
      )
    );

ALTER TABLE public.group_payment_consumptions
  DROP CONSTRAINT group_payment_consumptions_outcome_valid,
  DROP CONSTRAINT group_payment_consumptions_result_valid,
  ADD CONSTRAINT group_payment_consumptions_outcome_valid
    CHECK (
      outcome IN ('activated', 'renewed', 'refund_blocked')
    ),
  ADD CONSTRAINT group_payment_consumptions_result_valid
    CHECK (
      pg_catalog.jsonb_typeof(result) = 'object'
      AND result ? 'status'
      AND result ? 'subscription_id'
      AND result ->> 'subscription_id' = subscription_id::text
      AND (
        (
          outcome IN ('activated', 'renewed')
          AND result ->> 'status' IN ('subscribed', 'renewed')
          AND result ? 'membership_status'
          AND result ->> 'membership_status' IN (
            'joined',
            'already_member'
          )
        )
        OR (
          outcome = 'refund_blocked'
          AND result ->> 'status' = 'refund_observed'
        )
      )
    );

CREATE UNIQUE INDEX group_payment_consumptions_charge_unique
  ON public.group_payment_consumptions (stripe_charge_id)
  WHERE stripe_charge_id IS NOT NULL;

CREATE TABLE public.stripe_payment_ownerships (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  product_kind text NOT NULL,
  ledger_id uuid NOT NULL,
  owner_user_id uuid,
  stripe_customer_id text NOT NULL,
  stripe_payment_intent_id text,
  stripe_charge_id text NOT NULL,
  checkout_session_id text,
  amount_paid bigint NOT NULL,
  currency text NOT NULL,
  claimed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT stripe_payment_ownerships_product_kind_check
    CHECK (
      product_kind IN ('pro_entitlement', 'tip', 'group_pass')
    ),
  CONSTRAINT stripe_payment_ownerships_customer_check
    CHECK (pg_catalog.left(stripe_customer_id, 4) = 'cus_'),
  CONSTRAINT stripe_payment_ownerships_pi_check
    CHECK (
      stripe_payment_intent_id IS NULL
      OR pg_catalog.left(stripe_payment_intent_id, 3) = 'pi_'
    ),
  CONSTRAINT stripe_payment_ownerships_charge_check
    CHECK (pg_catalog.left(stripe_charge_id, 3) = 'ch_'),
  CONSTRAINT stripe_payment_ownerships_session_check
    CHECK (
      checkout_session_id IS NULL
      OR pg_catalog.left(checkout_session_id, 3) = 'cs_'
    ),
  CONSTRAINT stripe_payment_ownerships_amount_check
    CHECK (amount_paid > 0),
  CONSTRAINT stripe_payment_ownerships_currency_check
    CHECK (currency ~ '^[a-z]{3}$'),
  CONSTRAINT stripe_payment_ownerships_kind_ledger_key
    UNIQUE (product_kind, ledger_id),
  CONSTRAINT stripe_payment_ownerships_charge_key
    UNIQUE (stripe_charge_id)
);

CREATE UNIQUE INDEX stripe_payment_ownerships_pi_key
  ON public.stripe_payment_ownerships (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX stripe_payment_ownerships_session_key
  ON public.stripe_payment_ownerships (checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;

ALTER TABLE public.stripe_payment_ownerships OWNER TO postgres;
ALTER TABLE public.stripe_payment_ownerships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stripe_payment_ownerships FORCE ROW LEVEL SECURITY;
CREATE POLICY stripe_payment_ownerships_service_select
  ON public.stripe_payment_ownerships
  FOR SELECT TO service_role
  USING (true);
REVOKE ALL ON TABLE public.stripe_payment_ownerships
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT SELECT ON TABLE public.stripe_payment_ownerships TO service_role;

-- A paid-group consumption is append-only, while the mutable subscription and
-- membership projections may need to be revoked after a payment-first full
-- refund. Each immutable acknowledgment binds one exact ownership,
-- subscription, and full-refund aggregate snapshot. A later Stripe event can
-- append a new snapshot acknowledgment without rewriting history. Readiness
-- still revalidates the current snapshot and live authority rows and never
-- trusts a historical acknowledgment by itself.
CREATE TABLE public.group_pass_refund_revocation_acks (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  ownership_id uuid NOT NULL
    REFERENCES public.stripe_payment_ownerships(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL,
  stripe_charge_id text NOT NULL,
  refund_snapshot_event_id text NOT NULL,
  refund_snapshot_event_created_at timestamptz NOT NULL,
  refund_succeeded_amount bigint NOT NULL,
  amount_paid bigint NOT NULL,
  revocation_action_reference text NOT NULL,
  subscription_action text NOT NULL,
  subscription_status_before text,
  subscription_expires_at_before timestamptz,
  subscription_status_after text,
  subscription_expires_at_after timestamptz,
  membership_action text NOT NULL,
  payment_member_joined_at timestamptz,
  acknowledged_at timestamptz NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT group_pass_refund_revocation_acks_action_key
    UNIQUE (revocation_action_reference),
  CONSTRAINT group_pass_refund_revocation_acks_snapshot_key
    UNIQUE (
      ownership_id,
      subscription_id,
      refund_snapshot_event_id,
      refund_succeeded_amount
    ),
  CONSTRAINT group_pass_refund_revocation_acks_charge_shape
    CHECK (pg_catalog.left(stripe_charge_id, 3) = 'ch_'),
  CONSTRAINT group_pass_refund_revocation_acks_amount_shape
    CHECK (
      amount_paid > 0
      AND refund_succeeded_amount >= amount_paid
    ),
  CONSTRAINT group_pass_refund_revocation_acks_action_shape
    CHECK (
      pg_catalog.length(
        pg_catalog.btrim(revocation_action_reference)
      ) BETWEEN 3 AND 255
    ),
  CONSTRAINT group_pass_refund_revocation_acks_subscription_action
    CHECK (
      subscription_action IN (
        'expired_exact_payment',
        'already_inactive',
        'already_missing'
      )
    ),
  CONSTRAINT group_pass_refund_revocation_acks_membership_action
    CHECK (
      membership_action IN (
        'payment_member_deleted',
        'payment_member_already_absent',
        'payment_member_retained_independent_authority',
        'membership_preexisting',
        'membership_role_changed'
      )
    )
);

CREATE INDEX group_pass_refund_revocation_acks_ownership_idx
  ON public.group_pass_refund_revocation_acks (ownership_id);
CREATE INDEX group_pass_refund_revocation_acks_charge_idx
  ON public.group_pass_refund_revocation_acks (stripe_charge_id);

ALTER TABLE public.group_pass_refund_revocation_acks OWNER TO postgres;
ALTER TABLE public.group_pass_refund_revocation_acks
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_pass_refund_revocation_acks
  FORCE ROW LEVEL SECURITY;
CREATE POLICY group_pass_refund_revocation_acks_service_select
  ON public.group_pass_refund_revocation_acks
  FOR SELECT TO service_role
  USING (true);
REVOKE ALL ON TABLE public.group_pass_refund_revocation_acks
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT SELECT ON TABLE public.group_pass_refund_revocation_acks
  TO service_role;

-- Existing exact Pro payment rows are the only supported legacy source for
-- automatic ownership backfill. Tips and group passes need a verified Charge
-- and Customer from their new exact writer RPCs; this migration never guesses
-- either value from a PaymentIntent.
INSERT INTO public.stripe_payment_ownerships (
  product_kind,
  ledger_id,
  owner_user_id,
  stripe_customer_id,
  stripe_payment_intent_id,
  stripe_charge_id,
  checkout_session_id,
  amount_paid,
  currency,
  claimed_at
)
SELECT
  'pro_entitlement',
  payment.id,
  payment.user_id,
  payment.stripe_customer_id,
  payment.stripe_payment_intent_id,
  payment.stripe_charge_id,
  payment.checkout_session_id,
  payment.amount_paid,
  payment.currency,
  payment.created_at
FROM public.stripe_entitlement_payments AS payment;

ALTER TABLE public.stripe_charge_refund_tombstones
  ADD COLUMN resolution_ownership_id uuid
    REFERENCES public.stripe_payment_ownerships(id) ON DELETE RESTRICT;

UPDATE public.stripe_charge_refund_tombstones AS tombstone
SET resolution_ownership_id = ownership.id,
    resolution_reference = 'ownership:' || ownership.id::text,
    updated_at = pg_catalog.clock_timestamp()
FROM public.stripe_payment_ownerships AS ownership
WHERE tombstone.resolution_kind = 'entitlement_payment'
  AND tombstone.merged_payment_id = ownership.ledger_id
  AND ownership.product_kind = 'pro_entitlement';

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
        resolution_kind = 'non_entitlement_payment'
        AND merged_payment_id IS NULL
        AND resolution_ownership_id IS NOT NULL
        AND resolution_reference =
          'ownership:' || resolution_ownership_id::text
      )
    );

CREATE UNIQUE INDEX stripe_charge_refund_tombstones_ownership_key
  ON public.stripe_charge_refund_tombstones (resolution_ownership_id)
  WHERE resolution_ownership_id IS NOT NULL;

ALTER TABLE public.stripe_entitlement_payments
  DROP CONSTRAINT stripe_entitlement_payments_status_check,
  ADD CONSTRAINT stripe_entitlement_payments_status_check
    CHECK (
      payment_status IN ('paid', 'succeeded', 'ownership_conflict')
    );

CREATE OR REPLACE FUNCTION public.prevent_stripe_payment_ownership_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'Stripe payment ownership ledgers are immutable'
    USING ERRCODE = '23514';
END
$function$;

ALTER FUNCTION public.prevent_stripe_payment_ownership_mutation()
  OWNER TO postgres;

CREATE TRIGGER trg_stripe_payment_ownerships_immutable
  BEFORE UPDATE OR DELETE ON public.stripe_payment_ownerships
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_stripe_payment_ownership_mutation();

CREATE OR REPLACE FUNCTION
  public.prevent_group_pass_refund_revocation_ack_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION
    'group pass refund revocation acknowledgments are immutable'
    USING ERRCODE = '23514';
END
$function$;

ALTER FUNCTION
  public.prevent_group_pass_refund_revocation_ack_mutation()
OWNER TO postgres;

CREATE TRIGGER trg_group_pass_refund_revocation_acks_immutable
  BEFORE UPDATE OR DELETE ON public.group_pass_refund_revocation_acks
  FOR EACH ROW
  EXECUTE FUNCTION
    public.prevent_group_pass_refund_revocation_ack_mutation();

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
        )
    )
$function$;

ALTER FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_payment_ownership_is_exact_v2(uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.group_pass_has_independent_current_authority_v2(
    p_group_id uuid,
    p_user_id uuid,
    p_excluded_subscription_id uuid,
    p_excluded_ownership_id uuid
  )
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT p_group_id IS NOT NULL
    AND p_user_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.group_subscriptions AS subscription
      WHERE subscription.group_id = p_group_id
        AND subscription.user_id = p_user_id
        AND subscription.id IS DISTINCT FROM p_excluded_subscription_id
        AND subscription.status IN ('active', 'trialing')
        AND subscription.expires_at >
          pg_catalog.statement_timestamp()
        AND (
          (
            subscription.status = 'trialing'
            AND subscription.tier = 'trial'
            AND EXISTS (
              SELECT 1
              FROM public.group_trial_consumptions AS trial
              WHERE trial.group_id = subscription.group_id
                AND trial.user_id = subscription.user_id
                AND trial.subscription_id = subscription.id
            )
          )
          OR (
            subscription.status = 'active'
            AND subscription.payment_provider = 'stripe'
            AND EXISTS (
              SELECT 1
              FROM public.group_payment_consumptions AS consumption
              JOIN public.stripe_payment_ownerships AS ownership
                ON ownership.product_kind = 'group_pass'
                AND ownership.ledger_id = consumption.id
              WHERE consumption.subscription_id = subscription.id
                AND consumption.group_id = subscription.group_id
                AND consumption.user_id = subscription.user_id
                AND consumption.outcome IN ('activated', 'renewed')
                AND ownership.id IS DISTINCT FROM
                  p_excluded_ownership_id
                AND subscription.payment_reference =
                  'stripe:' || consumption.payment_intent_id
                AND public.stripe_payment_ownership_is_exact_v2(
                  ownership.id
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM public.stripe_charge_refund_tombstones
                    AS other_tombstone
                  WHERE other_tombstone.stripe_charge_id =
                      ownership.stripe_charge_id
                    AND other_tombstone.refund_state = 'succeeded'
                    AND other_tombstone.refund_succeeded_amount >=
                      other_tombstone.amount_paid
                )
            )
          )
        )
    )
$function$;

ALTER FUNCTION
  public.group_pass_has_independent_current_authority_v2(
    uuid, uuid, uuid, uuid
  )
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.group_pass_has_independent_current_authority_v2(
    uuid, uuid, uuid, uuid
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.group_pass_full_refund_revocation_is_effective_v2(
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
      JOIN public.group_payment_consumptions AS consumption
        ON consumption.id = ownership.ledger_id
      JOIN public.stripe_charge_refund_tombstones AS tombstone
        ON tombstone.resolution_ownership_id = ownership.id
      JOIN public.group_pass_refund_revocation_acks AS acknowledgment
        ON acknowledgment.ownership_id = ownership.id
      WHERE ownership.id = p_ownership_id
        AND ownership.product_kind = 'group_pass'
        AND consumption.outcome IN ('activated', 'renewed')
        AND consumption.result ->> 'status' IN ('subscribed', 'renewed')
        AND consumption.result ->> 'subscription_id' =
          consumption.subscription_id::text
        AND consumption.result ->> 'membership_status' IN (
          'joined',
          'already_member'
        )
        AND tombstone.stripe_charge_id = ownership.stripe_charge_id
        AND tombstone.resolution_kind = 'non_entitlement_payment'
        AND tombstone.merged_payment_id IS NULL
        AND tombstone.refund_state = 'succeeded'
        AND tombstone.refund_succeeded_amount >= tombstone.amount_paid
        AND acknowledgment.subscription_id = consumption.subscription_id
        AND acknowledgment.stripe_charge_id =
          ownership.stripe_charge_id
        AND acknowledgment.refund_snapshot_event_id =
          tombstone.refund_snapshot_event_id
        AND acknowledgment.refund_snapshot_event_created_at =
          tombstone.refund_snapshot_event_created_at
        AND acknowledgment.refund_succeeded_amount =
          tombstone.refund_succeeded_amount
        AND acknowledgment.amount_paid = tombstone.amount_paid
        AND acknowledgment.payment_member_joined_at
          IS NOT DISTINCT FROM consumption.payment_member_joined_at
        -- The historical acknowledgment is necessary but never sufficient:
        -- a resurrected exact subscription immediately makes readiness fail.
        AND NOT EXISTS (
          SELECT 1
          FROM public.group_subscriptions AS subscription
          WHERE subscription.id = consumption.subscription_id
            AND (
              subscription.group_id IS DISTINCT FROM consumption.group_id
              OR subscription.user_id IS DISTINCT FROM consumption.user_id
              OR (
                subscription.status IN ('active', 'trialing')
                AND subscription.expires_at >
                  pg_catalog.statement_timestamp()
              )
            )
        )
        -- Only a membership created by this exact payment is revocation state.
        -- A pre-existing member is not payment authority; owner/admin or any
        -- later promoted role is likewise independent and is never deleted.
        AND (
          consumption.result ->> 'membership_status' =
            'already_member'
          OR NOT EXISTS (
            SELECT 1
            FROM public.group_members AS member
            WHERE member.group_id = consumption.group_id
              AND member.user_id = consumption.user_id
              AND member.role::text = 'member'
          )
          OR public.group_pass_has_independent_current_authority_v2(
            consumption.group_id,
            consumption.user_id,
            consumption.subscription_id,
            ownership.id
          )
        )
    )
$function$;

ALTER FUNCTION
  public.group_pass_full_refund_revocation_is_effective_v2(uuid)
OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.group_pass_full_refund_revocation_is_effective_v2(uuid)
FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE OR REPLACE FUNCTION
  public.acknowledge_group_pass_full_refund_revocation_atomic(
    p_ownership_id uuid,
    p_subscription_id uuid,
    p_refund_snapshot_event_id text,
    p_refund_succeeded_amount bigint,
    p_revocation_action_reference text
  )
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_consumption public.group_payment_consumptions%ROWTYPE;
  v_tombstone public.stripe_charge_refund_tombstones%ROWTYPE;
  v_subscription public.group_subscriptions%ROWTYPE;
  v_ack public.group_pass_refund_revocation_acks%ROWTYPE;
  v_review public.stripe_manual_reviews%ROWTYPE;
  v_member_role text;
  v_member_joined_at timestamptz;
  v_subscription_action text;
  v_membership_action text;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_ownership_id IS NULL
    OR p_subscription_id IS NULL
    OR NULLIF(pg_catalog.btrim(p_refund_snapshot_event_id), '') IS NULL
    OR p_refund_succeeded_amount IS NULL
    OR p_refund_succeeded_amount <= 0
    OR pg_catalog.length(
      pg_catalog.btrim(COALESCE(p_revocation_action_reference, ''))
    ) NOT BETWEEN 3 AND 255
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  -- Derive immutable lock identities without taking a row lock. The canonical
  -- order remains Charge -> PI -> Checkout Session -> group authority.
  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = p_ownership_id
    AND ownership.product_kind = 'group_pass';
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  SELECT consumption.*
  INTO v_consumption
  FROM public.group_payment_consumptions AS consumption
  WHERE consumption.id = v_ownership.ledger_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
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
  IF v_ownership.checkout_session_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-checkout-session:' || v_ownership.checkout_session_id,
        0
      )
    );
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || v_consumption.group_id::text
        || ':' || v_consumption.user_id::text,
      0
    )
  );

  -- Freeze the entire group+user authority set before deciding whether the
  -- payment-created plain membership is still justified by another exact
  -- paid period or one-time trial.
  PERFORM 1
  FROM public.group_subscriptions AS subscription
  WHERE subscription.group_id = v_consumption.group_id
    AND subscription.user_id = v_consumption.user_id
  ORDER BY subscription.id
  FOR UPDATE;
  PERFORM 1
  FROM public.group_members AS member
  WHERE member.group_id = v_consumption.group_id
    AND member.user_id = v_consumption.user_id
  FOR UPDATE;
  PERFORM 1
  FROM public.group_trial_consumptions AS trial
  WHERE trial.group_id = v_consumption.group_id
    AND trial.user_id = v_consumption.user_id
  FOR SHARE;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = p_ownership_id
  FOR UPDATE;
  SELECT consumption.*
  INTO v_consumption
  FROM public.group_payment_consumptions AS consumption
  WHERE consumption.id = v_ownership.ledger_id
  FOR UPDATE;

  IF v_ownership.product_kind IS DISTINCT FROM 'group_pass'
    OR v_consumption.subscription_id IS DISTINCT FROM p_subscription_id
    OR v_consumption.outcome NOT IN ('activated', 'renewed')
    OR v_consumption.result ->> 'status' NOT IN (
      'subscribed',
      'renewed'
    )
    OR v_consumption.result ->> 'subscription_id'
      IS DISTINCT FROM p_subscription_id::text
    OR v_consumption.result ->> 'membership_status' NOT IN (
      'joined',
      'already_member'
    )
    OR NOT public.stripe_payment_ownership_is_exact_v2(v_ownership.id)
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'group_payment',
      v_ownership.ledger_id::text,
      v_ownership.owner_user_id,
      'group_pass_refund_revocation_identity_conflict',
      'A group pass refund revocation request does not match exact payment authority.',
      pg_catalog.jsonb_build_object(
        'ownership_id', p_ownership_id,
        'requested_subscription_id', p_subscription_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT tombstone.*
  INTO v_tombstone
  FROM public.stripe_charge_refund_tombstones AS tombstone
  WHERE tombstone.stripe_charge_id = v_ownership.stripe_charge_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_tombstone.resolution_kind
      IS DISTINCT FROM 'non_entitlement_payment'
    OR v_tombstone.resolution_ownership_id
      IS DISTINCT FROM v_ownership.id
    OR v_tombstone.merged_payment_id IS NOT NULL
    OR v_tombstone.refund_state IS DISTINCT FROM 'succeeded'
    OR v_tombstone.refund_succeeded_amount < v_tombstone.amount_paid
    OR v_tombstone.refund_snapshot_event_id
      IS DISTINCT FROM p_refund_snapshot_event_id
    OR v_tombstone.refund_succeeded_amount
      IS DISTINCT FROM p_refund_succeeded_amount
    OR v_tombstone.stripe_customer_id
      IS DISTINCT FROM v_ownership.stripe_customer_id
    OR v_tombstone.stripe_payment_intent_id
      IS DISTINCT FROM v_ownership.stripe_payment_intent_id
    OR v_tombstone.amount_paid IS DISTINCT FROM v_ownership.amount_paid
    OR v_tombstone.currency IS DISTINCT FROM v_ownership.currency
    OR v_tombstone.captured IS DISTINCT FROM true
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstone_events AS snapshot_event
      WHERE snapshot_event.event_id =
          v_tombstone.refund_snapshot_event_id
        AND snapshot_event.stripe_charge_id =
          v_tombstone.stripe_charge_id
        AND snapshot_event.event_created_at =
          v_tombstone.refund_snapshot_event_created_at
        AND snapshot_event.observations @>
          pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'refund_state', v_tombstone.refund_state,
              'refund_succeeded_amount',
                v_tombstone.refund_succeeded_amount
            )
          )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstone_events AS latest_event
      WHERE latest_event.event_id =
          v_tombstone.latest_refund_event_id
        AND latest_event.stripe_charge_id =
          v_tombstone.stripe_charge_id
        AND latest_event.event_created_at =
          v_tombstone.latest_refund_event_created_at
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_ownership.stripe_charge_id,
      v_ownership.owner_user_id,
      'group_pass_refund_revocation_snapshot_conflict',
      'A group pass revocation request does not match the latest full-refund snapshot.',
      pg_catalog.jsonb_build_object(
        'ownership_id', p_ownership_id,
        'requested_event_id', p_refund_snapshot_event_id,
        'requested_refund_amount', p_refund_succeeded_amount
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'snapshot_conflict');
  END IF;

  SELECT acknowledgment.*
  INTO v_ack
  FROM public.group_pass_refund_revocation_acks AS acknowledgment
  WHERE acknowledgment.ownership_id = v_ownership.id
    AND acknowledgment.subscription_id = p_subscription_id
    AND acknowledgment.refund_snapshot_event_id =
      p_refund_snapshot_event_id
    AND acknowledgment.refund_succeeded_amount =
      p_refund_succeeded_amount
  FOR UPDATE;
  IF FOUND THEN
    IF v_ack.revocation_action_reference =
        pg_catalog.btrim(p_revocation_action_reference)
      AND public.group_pass_full_refund_revocation_is_effective_v2(
        v_ownership.id
      )
    THEN
      UPDATE public.stripe_manual_reviews
      SET state = 'resolved',
          action = 'revoke_group_pass_refund',
          metadata = metadata || pg_catalog.jsonb_build_object(
            'revocation_acknowledgment_id', v_ack.id,
            'revocation_action_reference',
              v_ack.revocation_action_reference,
            'effect_revalidated_at', pg_catalog.clock_timestamp()
          ),
          updated_at = pg_catalog.clock_timestamp(),
          resolved_at = pg_catalog.clock_timestamp()
      WHERE object_type = 'group_payment'
        AND object_id = v_consumption.id::text
        AND reason_key =
          'group_pass_full_refund_revocation_required'
        AND state = 'open';
      RETURN pg_catalog.jsonb_build_object(
        'status', 'already_acknowledged',
        'acknowledgment_id', v_ack.id,
        'ownership_id', v_ownership.id,
        'subscription_id', p_subscription_id
      );
    END IF;

    PERFORM public.record_stripe_manual_review_atomic(
      'group_payment',
      v_consumption.id::text,
      v_consumption.user_id,
      'group_pass_refund_revocation_effect_drift',
      'A prior group refund acknowledgment no longer matches live access authority.',
      pg_catalog.jsonb_build_object(
        'ownership_id', v_ownership.id,
        'acknowledgment_id', v_ack.id
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'manual_review',
      'reason_key', 'group_pass_refund_revocation_effect_drift'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.group_pass_refund_revocation_acks AS acknowledgment
    WHERE acknowledgment.ownership_id = v_ownership.id
      AND (
        acknowledgment.subscription_id IS DISTINCT FROM p_subscription_id
        OR acknowledgment.stripe_charge_id IS DISTINCT FROM
          v_ownership.stripe_charge_id
        OR acknowledgment.amount_paid IS DISTINCT FROM v_ownership.amount_paid
        OR (
          acknowledgment.refund_snapshot_event_id =
            p_refund_snapshot_event_id
          AND acknowledgment.refund_succeeded_amount IS DISTINCT FROM
            p_refund_succeeded_amount
        )
      )
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'group_payment',
      v_consumption.id::text,
      v_consumption.user_id,
      'group_pass_refund_revocation_history_conflict',
      'Historical group refund acknowledgments conflict with immutable payment identity.',
      pg_catalog.jsonb_build_object(
        'ownership_id', v_ownership.id,
        'snapshot_event_id', p_refund_snapshot_event_id
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'manual_review',
      'reason_key', 'group_pass_refund_revocation_history_conflict'
    );
  END IF;

  -- An action reference is an immutable operator-side idempotency key. A
  -- later Stripe refund event for the same Charge receives a new snapshot ack
  -- and must not alias an earlier action or another payment.
  IF EXISTS (
    SELECT 1
    FROM public.group_pass_refund_revocation_acks AS acknowledgment
    WHERE acknowledgment.revocation_action_reference =
        pg_catalog.btrim(p_revocation_action_reference)
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'group_payment',
      v_consumption.id::text,
      v_consumption.user_id,
      'group_pass_refund_revocation_action_conflict',
      'A group refund revocation action reference belongs to another immutable snapshot.',
      pg_catalog.jsonb_build_object(
        'ownership_id', v_ownership.id,
        'snapshot_event_id', p_refund_snapshot_event_id,
        'revocation_action_reference',
          pg_catalog.btrim(p_revocation_action_reference)
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'manual_review',
      'reason_key', 'group_pass_refund_revocation_action_conflict'
    );
  END IF;

  -- One mutable subscription can contain multiple prepaid periods. Without a
  -- per-period projection it is unsafe to expire the row for just one refund;
  -- leave that uncommon case blocked for explicit period reconciliation.
  IF EXISTS (
    SELECT 1
    FROM public.group_payment_consumptions AS other_consumption
    WHERE other_consumption.subscription_id = p_subscription_id
      AND other_consumption.id <> v_consumption.id
      AND other_consumption.outcome IN ('activated', 'renewed')
    FOR SHARE
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'group_payment',
      v_consumption.id::text,
      v_consumption.user_id,
      'group_pass_refund_revocation_multi_payment_subscription',
      'A multi-payment subscription needs exact period reconciliation before revocation.',
      pg_catalog.jsonb_build_object(
        'ownership_id', v_ownership.id,
        'subscription_id', p_subscription_id
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'manual_review',
      'reason_key',
        'group_pass_refund_revocation_multi_payment_subscription'
    );
  END IF;

  SELECT subscription.*
  INTO v_subscription
  FROM public.group_subscriptions AS subscription
  WHERE subscription.id = p_subscription_id
  FOR UPDATE;
  IF FOUND AND (
    v_subscription.group_id IS DISTINCT FROM v_consumption.group_id
    OR v_subscription.user_id IS DISTINCT FROM v_consumption.user_id
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'group_payment',
      v_consumption.id::text,
      v_consumption.user_id,
      'group_pass_refund_revocation_subscription_conflict',
      'The exact paid-group subscription id belongs to different authority.',
      pg_catalog.jsonb_build_object(
        'ownership_id', v_ownership.id,
        'subscription_id', p_subscription_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT review.*
  INTO v_review
  FROM public.stripe_manual_reviews AS review
  WHERE review.object_type = 'group_payment'
    AND review.object_id = v_consumption.id::text
    AND review.reason_key =
      'group_pass_full_refund_revocation_required'
  FOR UPDATE;
  IF NOT FOUND OR v_review.state IS DISTINCT FROM 'open' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'missing_open_review',
      'reason_key', 'group_pass_full_refund_revocation_required'
    );
  END IF;

  BEGIN
    IF v_subscription.id IS NULL THEN
      v_subscription_action := 'already_missing';
    ELSIF v_subscription.status IN ('active', 'trialing')
      AND v_subscription.expires_at > v_now
    THEN
      IF v_subscription.status IS DISTINCT FROM 'active'
        OR v_subscription.tier IS DISTINCT FROM v_consumption.tier
        OR v_subscription.payment_provider IS DISTINCT FROM 'stripe'
        OR v_subscription.payment_reference IS DISTINCT FROM
          'stripe:' || v_consumption.payment_intent_id
      THEN
        RAISE EXCEPTION 'active subscription is not the exact refunded grant'
          USING ERRCODE = '23514';
      END IF;

      UPDATE public.group_subscriptions
      SET status = 'expired',
          expires_at = LEAST(expires_at, v_now),
          cancelled_at = v_now,
          cancel_at_period_end = false,
          updated_at = v_now
      WHERE id = p_subscription_id;
      v_subscription_action := 'expired_exact_payment';
    ELSE
      v_subscription_action := 'already_inactive';
    END IF;

    IF v_consumption.result ->> 'membership_status' =
      'already_member'
    THEN
      v_membership_action := 'membership_preexisting';
    ELSE
      SELECT member.role::text, member.joined_at
      INTO v_member_role, v_member_joined_at
      FROM public.group_members AS member
      WHERE member.group_id = v_consumption.group_id
        AND member.user_id = v_consumption.user_id
      FOR UPDATE;

      IF NOT FOUND THEN
        v_membership_action := 'payment_member_already_absent';
      ELSIF v_member_role = 'member' THEN
        IF v_consumption.payment_member_joined_at IS NULL
          OR v_member_joined_at IS DISTINCT FROM
            v_consumption.payment_member_joined_at
        THEN
          RAISE EXCEPTION
            'payment-created membership provenance changed'
            USING ERRCODE = '23514';
        END IF;
        IF public.group_pass_has_independent_current_authority_v2(
          v_consumption.group_id,
          v_consumption.user_id,
          v_consumption.subscription_id,
          v_ownership.id
        ) THEN
          v_membership_action :=
            'payment_member_retained_independent_authority';
        ELSE
          DELETE FROM public.group_members AS member
          WHERE member.group_id = v_consumption.group_id
            AND member.user_id = v_consumption.user_id
            AND member.role::text = 'member'
            AND member.joined_at =
              v_consumption.payment_member_joined_at;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'payment-created membership changed concurrently'
              USING ERRCODE = '23514';
          END IF;
          v_membership_action := 'payment_member_deleted';
        END IF;
      ELSE
        v_membership_action := 'membership_role_changed';
      END IF;
    END IF;

    INSERT INTO public.group_pass_refund_revocation_acks (
      ownership_id,
      subscription_id,
      stripe_charge_id,
      refund_snapshot_event_id,
      refund_snapshot_event_created_at,
      refund_succeeded_amount,
      amount_paid,
      revocation_action_reference,
      subscription_action,
      subscription_status_before,
      subscription_expires_at_before,
      subscription_status_after,
      subscription_expires_at_after,
      membership_action,
      payment_member_joined_at,
      acknowledged_at
    )
    SELECT
      v_ownership.id,
      p_subscription_id,
      v_ownership.stripe_charge_id,
      v_tombstone.refund_snapshot_event_id,
      v_tombstone.refund_snapshot_event_created_at,
      v_tombstone.refund_succeeded_amount,
      v_tombstone.amount_paid,
      pg_catalog.btrim(p_revocation_action_reference),
      v_subscription_action,
      v_subscription.status,
      v_subscription.expires_at,
      current_subscription.status,
      current_subscription.expires_at,
      v_membership_action,
      v_consumption.payment_member_joined_at,
      v_now
    FROM (VALUES (1)) AS singleton(value)
    LEFT JOIN public.group_subscriptions AS current_subscription
      ON current_subscription.id = p_subscription_id
    RETURNING * INTO v_ack;

    IF NOT public.group_pass_full_refund_revocation_is_effective_v2(
      v_ownership.id
    ) THEN
      RAISE EXCEPTION 'group pass refund revocation is not effective'
        USING ERRCODE = '23514';
    END IF;

    UPDATE public.stripe_manual_reviews
    SET state = 'resolved',
        action = 'revoke_group_pass_refund',
        metadata = metadata || pg_catalog.jsonb_build_object(
          'revocation_acknowledgment_id', v_ack.id,
          'revocation_action_reference',
            pg_catalog.btrim(p_revocation_action_reference),
          'refund_snapshot_event_id',
            v_tombstone.refund_snapshot_event_id,
          'refund_succeeded_amount',
            v_tombstone.refund_succeeded_amount
        ),
        updated_at = v_now,
        resolved_at = v_now
    WHERE id = v_review.id
      AND state = 'open';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'group pass refund review changed concurrently'
        USING ERRCODE = '23514';
    END IF;
  EXCEPTION
    WHEN check_violation OR unique_violation THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'group_payment',
        v_consumption.id::text,
        v_consumption.user_id,
        'group_pass_refund_revocation_effect_failed',
        'Exact paid-group access could not be safely revoked and acknowledged.',
        pg_catalog.jsonb_build_object(
          'ownership_id', v_ownership.id,
          'subscription_id', p_subscription_id,
          'snapshot_event_id', p_refund_snapshot_event_id
        )
      );
      RETURN pg_catalog.jsonb_build_object(
        'status', 'manual_review',
        'reason_key', 'group_pass_refund_revocation_effect_failed'
      );
  END;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'acknowledged',
    'acknowledgment_id', v_ack.id,
    'ownership_id', v_ownership.id,
    'subscription_id', p_subscription_id,
    'subscription_action', v_subscription_action,
    'membership_action', v_membership_action
  );
END
$function$;

ALTER FUNCTION
  public.acknowledge_group_pass_full_refund_revocation_atomic(
    uuid, uuid, text, bigint, text
  )
OWNER TO postgres;

CREATE OR REPLACE FUNCTION
  public.stripe_resolve_non_entitlement_refund_tombstone_atomic(
    p_ownership_id uuid
  )
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_tombstone public.stripe_charge_refund_tombstones%ROWTYPE;
  v_group_consumption public.group_payment_consumptions%ROWTYPE;
  v_was_resolved boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_ownership_id IS NULL THEN
    RAISE EXCEPTION 'Stripe payment ownership id is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = p_ownership_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Stripe payment ownership is missing'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_ownership.product_kind NOT IN ('tip', 'group_pass') THEN
    RAISE EXCEPTION 'non-entitlement ownership is required'
      USING ERRCODE = '22023';
  END IF;

  -- Canonical cross-product lock order: Charge/refund first, then PI. Existing
  -- entitlement activation already owns the Charge fence before its ownership
  -- trigger runs, while refund-only paths never wait on the PI fence.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || v_ownership.stripe_charge_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-payment-identity:'
        || v_ownership.stripe_payment_intent_id,
      0
    )
  );
  IF v_ownership.checkout_session_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-checkout-session:' || v_ownership.checkout_session_id,
        0
      )
    );
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = p_ownership_id
  FOR UPDATE;

  IF NOT public.stripe_payment_ownership_is_exact_v2(v_ownership.id) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_identity',
      v_ownership.stripe_charge_id,
      NULL,
      'non_entitlement_ledger_identity_drift',
      'A non-entitlement Stripe ownership no longer matches its product ledger.',
      pg_catalog.jsonb_build_object(
        'ownership_id', v_ownership.id,
        'product_kind', v_ownership.product_kind,
        'ledger_id', v_ownership.ledger_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  SELECT tombstone.*
  INTO v_tombstone
  FROM public.stripe_charge_refund_tombstones AS tombstone
  WHERE tombstone.stripe_charge_id = v_ownership.stripe_charge_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'no_tombstone');
  END IF;

  IF v_tombstone.stripe_customer_id
      IS DISTINCT FROM v_ownership.stripe_customer_id
    OR v_tombstone.stripe_payment_intent_id
      IS DISTINCT FROM v_ownership.stripe_payment_intent_id
    OR v_tombstone.amount_paid IS DISTINCT FROM v_ownership.amount_paid
    OR v_tombstone.currency IS DISTINCT FROM v_ownership.currency
    OR v_tombstone.captured IS DISTINCT FROM true
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_tombstone.stripe_charge_id,
      NULL,
      'non_entitlement_tombstone_identity_conflict',
      'A Charge refund tombstone conflicts with its product payment ownership.',
      pg_catalog.jsonb_build_object(
        'ownership_id', v_ownership.id,
        'product_kind', v_ownership.product_kind,
        'ledger_id', v_ownership.ledger_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF NOT EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstone_events AS event_row
      WHERE event_row.event_id = v_tombstone.refund_snapshot_event_id
        AND event_row.stripe_charge_id = v_tombstone.stripe_charge_id
        AND event_row.event_created_at =
          v_tombstone.refund_snapshot_event_created_at
        AND event_row.observations @>
          pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object(
              'refund_state', v_tombstone.refund_state,
              'refund_succeeded_amount',
                v_tombstone.refund_succeeded_amount
            )
          )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstone_events AS event_row
      WHERE event_row.event_id = v_tombstone.latest_refund_event_id
        AND event_row.stripe_charge_id = v_tombstone.stripe_charge_id
        AND event_row.event_created_at =
          v_tombstone.latest_refund_event_created_at
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_tombstone.stripe_charge_id,
      NULL,
      'non_entitlement_refund_event_chain_incomplete',
      'A non-entitlement Charge tombstone has an incomplete refund event chain.',
      pg_catalog.jsonb_build_object('ownership_id', v_ownership.id)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  v_was_resolved :=
    v_tombstone.resolution_kind = 'non_entitlement_payment'
    AND v_tombstone.resolution_ownership_id = v_ownership.id
    AND v_tombstone.merged_payment_id IS NULL;

  IF NOT v_was_resolved
    AND (
      v_tombstone.resolution_kind IS DISTINCT FROM 'unclassified'
      OR v_tombstone.merged_payment_id IS NOT NULL
      OR v_tombstone.resolution_ownership_id IS NOT NULL
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_tombstone.stripe_charge_id,
      NULL,
      'cross_product_tombstone_resolution_conflict',
      'A Charge tombstone is already classified to another product payment.',
      pg_catalog.jsonb_build_object(
        'incoming_ownership_id', v_ownership.id,
        'existing_resolution_kind', v_tombstone.resolution_kind,
        'existing_ownership_id', v_tombstone.resolution_ownership_id,
        'existing_payment_id', v_tombstone.merged_payment_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF NOT v_was_resolved THEN
    UPDATE public.stripe_charge_refund_tombstones
    SET resolution_kind = 'non_entitlement_payment',
        resolution_ownership_id = v_ownership.id,
        resolution_reference = 'ownership:' || v_ownership.id::text,
        updated_at = pg_catalog.clock_timestamp()
    WHERE stripe_charge_id = v_tombstone.stripe_charge_id
      AND resolution_kind = 'unclassified';
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
    END IF;
  END IF;

  -- Classification is not projection completion. Re-evaluate the latest
  -- append-only aggregate on every replay so a partial refund that later
  -- becomes full cannot remain hidden behind an "already resolved" result.
  IF v_ownership.product_kind = 'tip'
    AND v_tombstone.refund_state = 'succeeded'
    AND v_tombstone.refund_succeeded_amount >= v_tombstone.amount_paid
  THEN
    UPDATE public.tips
    SET status = 'refunded',
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_ownership.ledger_id
      AND status = 'completed';

    IF NOT EXISTS (
      SELECT 1
      FROM public.tips AS tip
      WHERE tip.id = v_ownership.ledger_id
        AND tip.status = 'refunded'
    ) THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'tip',
        v_ownership.ledger_id::text,
        v_ownership.owner_user_id,
        'tip_full_refund_projection_failed',
        'A fully refunded tip could not be projected to refunded state.',
        pg_catalog.jsonb_build_object(
          'ownership_id', v_ownership.id,
          'stripe_charge_id', v_tombstone.stripe_charge_id
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
    END IF;
  END IF;

  IF v_ownership.product_kind = 'group_pass'
    AND v_tombstone.refund_state = 'succeeded'
    AND v_tombstone.refund_succeeded_amount >= v_tombstone.amount_paid
  THEN
    SELECT consumption.*
    INTO v_group_consumption
    FROM public.group_payment_consumptions AS consumption
    WHERE consumption.id = v_ownership.ledger_id
    FOR UPDATE;

    IF v_group_consumption.outcome IN ('activated', 'renewed') THEN
      IF public.group_pass_full_refund_revocation_is_effective_v2(
        v_ownership.id
      ) THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'revocation_acknowledged',
          'ownership_id', v_ownership.id,
          'product_kind', v_ownership.product_kind,
          'subscription_id', v_group_consumption.subscription_id
        );
      END IF;

      -- Paid-group access can overlap owner/admin/trial authority, so this
      -- migration does not guess a destructive membership delete. Persist an
      -- idempotent revocation review and keep readiness blocked until an exact
      -- authority-aware revocation is acknowledged.
      PERFORM public.record_stripe_manual_review_atomic(
        'group_payment',
        v_group_consumption.id::text,
        v_group_consumption.user_id,
        'group_pass_full_refund_revocation_required',
        'A fully refunded group pass still has an activated payment grant.',
        pg_catalog.jsonb_build_object(
          'ownership_id', v_ownership.id,
          'subscription_id', v_group_consumption.subscription_id,
          'group_id', v_group_consumption.group_id,
          'stripe_charge_id', v_tombstone.stripe_charge_id
        )
      );
      -- record_stripe_manual_review_atomic preserves the stable row even after
      -- resolution. If the acknowledged effect was later resurrected, reopen
      -- only this exact revocation reason so operators cannot miss the drift.
      UPDATE public.stripe_manual_reviews
      SET state = 'open',
          action = 'investigate',
          metadata = metadata || pg_catalog.jsonb_build_object(
            'effect_revalidation_failed_at',
              pg_catalog.clock_timestamp(),
            'refund_snapshot_event_id',
              v_tombstone.refund_snapshot_event_id,
            'refund_succeeded_amount',
              v_tombstone.refund_succeeded_amount
          ),
          updated_at = pg_catalog.clock_timestamp(),
          resolved_at = NULL
      WHERE object_type = 'group_payment'
        AND object_id = v_group_consumption.id::text
        AND reason_key =
          'group_pass_full_refund_revocation_required'
        AND state IS DISTINCT FROM 'open';
      RETURN pg_catalog.jsonb_build_object(
        'status', 'manual_review',
        'ownership_id', v_ownership.id,
        'product_kind', v_ownership.product_kind,
        'reason_key', 'group_pass_full_refund_revocation_required'
      );
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status',
    CASE WHEN v_was_resolved
      THEN 'already_resolved'
      ELSE 'resolved'
    END,
    'ownership_id',
    v_ownership.id,
    'product_kind',
    v_ownership.product_kind
  );
END
$function$;

ALTER FUNCTION
  public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid)
OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.stripe_merge_charge_refund_tombstone_v2(
  p_payment_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_payment public.stripe_entitlement_payments%ROWTYPE;
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_tombstone public.stripe_charge_refund_tombstones%ROWTYPE;
BEGIN
  IF p_payment_id IS NULL THEN
    RAISE EXCEPTION 'entitlement payment merge identity is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT payment.*
  INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.id = p_payment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entitlement payment merge target is missing'
      USING ERRCODE = 'P0002';
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
  IF v_payment.checkout_session_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-checkout-session:' || v_payment.checkout_session_id,
        0
      )
    );
  END IF;

  SELECT payment.*
  INTO v_payment
  FROM public.stripe_entitlement_payments AS payment
  WHERE payment.id = p_payment_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'entitlement payment merge target is missing'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.product_kind = 'pro_entitlement'
    AND ownership.ledger_id = v_payment.id
  FOR UPDATE;
  IF NOT FOUND
    OR NOT public.stripe_payment_ownership_is_exact_v2(v_ownership.id)
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_identity',
      v_payment.stripe_charge_id,
      NULL,
      'unclaimed_entitlement_payment',
      'A Pro payment cannot merge or grant without exact central ownership.',
      pg_catalog.jsonb_build_object('payment_id', v_payment.id)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  SELECT tombstone.*
  INTO v_tombstone
  FROM public.stripe_charge_refund_tombstones AS tombstone
  WHERE tombstone.stripe_charge_id = v_payment.stripe_charge_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'no_tombstone');
  END IF;

  IF v_tombstone.resolution_kind = 'non_entitlement_payment'
    OR (
      v_tombstone.resolution_ownership_id IS NOT NULL
      AND v_tombstone.resolution_ownership_id
        IS DISTINCT FROM v_ownership.id
    )
    OR (
      v_tombstone.merged_payment_id IS NOT NULL
      AND v_tombstone.merged_payment_id IS DISTINCT FROM v_payment.id
    )
    OR v_tombstone.stripe_customer_id
      IS DISTINCT FROM v_payment.stripe_customer_id
    OR v_tombstone.stripe_payment_intent_id
      IS DISTINCT FROM v_payment.stripe_payment_intent_id
    OR v_tombstone.amount_paid IS DISTINCT FROM v_payment.amount_paid
    OR v_tombstone.currency IS DISTINCT FROM v_payment.currency
    OR NOT v_tombstone.captured
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_payment.stripe_charge_id,
      NULL,
      'charge_refund_tombstone_merge_identity_conflict',
      'A Charge tombstone conflicts with exact Pro payment ownership.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'ownership_id', v_ownership.id,
        'resolution_kind', v_tombstone.resolution_kind,
        'resolution_ownership_id',
          v_tombstone.resolution_ownership_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF v_tombstone.resolution_kind = 'entitlement_payment'
    AND v_tombstone.merged_payment_id = v_payment.id
    AND v_tombstone.resolution_ownership_id = v_ownership.id
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'already_merged');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
    JOIN public.stripe_entitlement_refund_events AS refund_event
      ON refund_event.event_id = tombstone_event.event_id
    WHERE tombstone_event.stripe_charge_id =
        v_tombstone.stripe_charge_id
      AND (
        refund_event.entitlement_payment_id IS DISTINCT FROM v_payment.id
        OR refund_event.event_created_at
          IS DISTINCT FROM tombstone_event.event_created_at
      )
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_payment.stripe_charge_id,
      NULL,
      'charge_refund_event_merge_identity_conflict',
      'A tombstone refund event already belongs to another payment.',
      pg_catalog.jsonb_build_object('payment_id', v_payment.id)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF v_tombstone.refund_succeeded_amount
      < v_payment.refund_succeeded_amount
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'charge',
      v_payment.stripe_charge_id,
      NULL,
      'charge_refund_tombstone_merge_aggregate_conflict',
      'A tombstone aggregate was older than the Pro payment refund aggregate.',
      pg_catalog.jsonb_build_object(
        'payment_id', v_payment.id,
        'payment_refund_succeeded_amount',
          v_payment.refund_succeeded_amount,
        'tombstone_refund_succeeded_amount',
          v_tombstone.refund_succeeded_amount
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  UPDATE public.stripe_entitlement_payments
  SET refund_succeeded_amount = v_tombstone.refund_succeeded_amount,
      refund_state = v_tombstone.refund_state,
      latest_refund_event_id = v_tombstone.latest_refund_event_id,
      latest_refund_event_created_at =
        v_tombstone.latest_refund_event_created_at,
      refund_snapshot_event_id = v_tombstone.refund_snapshot_event_id,
      refund_snapshot_event_created_at =
        v_tombstone.refund_snapshot_event_created_at,
      updated_at = pg_catalog.clock_timestamp()
  WHERE id = v_payment.id
  RETURNING * INTO v_payment;

  INSERT INTO public.stripe_entitlement_refund_events (
    event_id,
    entitlement_payment_id,
    user_id,
    refund_state,
    refund_succeeded_amount,
    stripe_subscription_status,
    event_created_at,
    observations
  )
  SELECT
    tombstone_event.event_id,
    v_payment.id,
    v_payment.user_id,
    tombstone_event.refund_state,
    tombstone_event.refund_succeeded_amount,
    NULL,
    tombstone_event.event_created_at,
    tombstone_event.observations
  FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
  WHERE tombstone_event.stripe_charge_id = v_tombstone.stripe_charge_id
  ON CONFLICT (event_id) DO NOTHING;

  UPDATE public.stripe_entitlement_refund_events AS refund_event
  SET observations = (
        SELECT pg_catalog.jsonb_agg(DISTINCT observation.value)
        FROM pg_catalog.jsonb_array_elements(
          refund_event.observations || tombstone_event.observations
        ) AS observation(value)
      ),
      observed_at = pg_catalog.clock_timestamp()
  FROM public.stripe_charge_refund_tombstone_events AS tombstone_event
  WHERE tombstone_event.stripe_charge_id = v_tombstone.stripe_charge_id
    AND refund_event.event_id = tombstone_event.event_id
    AND refund_event.entitlement_payment_id = v_payment.id
    AND refund_event.event_created_at = tombstone_event.event_created_at;

  UPDATE public.stripe_charge_refund_tombstones
  SET merged_payment_id = v_payment.id,
      resolution_kind = 'entitlement_payment',
      resolution_ownership_id = v_ownership.id,
      resolution_reference = 'ownership:' || v_ownership.id::text,
      updated_at = pg_catalog.clock_timestamp()
  WHERE stripe_charge_id = v_tombstone.stripe_charge_id;

  IF v_payment.refund_state = 'succeeded'
    AND v_payment.refund_succeeded_amount >= v_payment.amount_paid
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'refunded_payment');
  END IF;
  RETURN pg_catalog.jsonb_build_object('status', 'merged');
END
$function$;

ALTER FUNCTION public.stripe_merge_charge_refund_tombstone_v2(uuid)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.claim_stripe_payment_ownership_atomic(
  p_stripe_charge_id text,
  p_stripe_payment_intent_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
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
  v_product_kind text;
  v_ledger_id uuid;
  v_owner_user_id uuid;
  v_customer_id text;
  v_payment_intent_id text;
  v_charge_id text;
  v_session_id text;
  v_amount bigint;
  v_currency text;
  v_ownership public.stripe_payment_ownerships%ROWTYPE;
  v_inserted_id uuid;
  v_matching_ownership_count integer;
  v_resolution jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.left(COALESCE(p_stripe_charge_id, ''), 3) <> 'ch_'
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND pg_catalog.left(p_stripe_payment_intent_id, 3) <> 'pi_'
    )
  THEN
    RAISE EXCEPTION 'Stripe payment ownership identity is invalid'
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
    WHERE payment.stripe_charge_id = p_stripe_charge_id
      OR (
        p_stripe_payment_intent_id IS NOT NULL
        AND payment.stripe_payment_intent_id =
          p_stripe_payment_intent_id
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
    WHERE tip.stripe_charge_id = p_stripe_charge_id
      OR (
        p_stripe_payment_intent_id IS NOT NULL
        AND tip.stripe_payment_intent_id =
          p_stripe_payment_intent_id
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
        consumption.stripe_charge_id = p_stripe_charge_id
        OR (
          p_stripe_payment_intent_id IS NOT NULL
          AND consumption.payment_intent_id =
            p_stripe_payment_intent_id
        )
      )
  )
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.array_agg(candidate.product_kind ORDER BY candidate.product_kind),
    pg_catalog.array_agg(candidate.ledger_id ORDER BY candidate.product_kind),
    pg_catalog.array_agg(candidate.owner_user_id ORDER BY candidate.product_kind),
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

  IF v_candidate_count IS DISTINCT FROM 1 THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_identity',
      p_stripe_charge_id,
      NULL,
      'cross_product_payment_identity_conflict',
      'Stripe payment identifiers resolve to zero or multiple product ledgers.',
      pg_catalog.jsonb_build_object(
        'payment_intent_id', p_stripe_payment_intent_id,
        'candidate_count', v_candidate_count,
        'product_kinds', COALESCE(pg_catalog.to_jsonb(v_product_kinds), '[]'::jsonb),
        'ledger_ids', COALESCE(pg_catalog.to_jsonb(v_ledger_ids), '[]'::jsonb)
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  v_product_kind := v_product_kinds[1];
  v_ledger_id := v_ledger_ids[1];
  v_owner_user_id := v_owner_user_ids[1];
  v_customer_id := v_customer_ids[1];
  v_payment_intent_id := v_payment_intent_ids[1];
  v_charge_id := v_charge_ids[1];
  v_session_id := v_session_ids[1];
  v_amount := v_amounts[1];
  v_currency := v_currencies[1];

  IF v_charge_id IS DISTINCT FROM p_stripe_charge_id
    OR v_payment_intent_id
      IS DISTINCT FROM p_stripe_payment_intent_id
    OR pg_catalog.left(COALESCE(v_customer_id, ''), 4) <> 'cus_'
    OR v_amount IS NULL
    OR v_amount <= 0
    OR v_currency IS NULL
    OR v_currency !~ '^[a-z]{3}$'
    OR (
      v_product_kind IN ('tip', 'group_pass')
      AND (
        v_payment_intent_id IS NULL
        OR v_session_id IS NULL
      )
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_identity',
      p_stripe_charge_id,
      NULL,
      'product_payment_immutable_identity_conflict',
      'A product ledger does not match the claimed immutable Stripe identity.',
      pg_catalog.jsonb_build_object(
        'product_kind', v_product_kind,
        'ledger_id', v_ledger_id,
        'payment_intent_id', p_stripe_payment_intent_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF v_session_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-checkout-session:' || v_session_id,
        0
      )
    );
  END IF;

  -- The first pass derives the canonical Session lock from Charge/PI. Re-query
  -- all three products under that lock and include Session-only ledgers (for
  -- example a pending tip whose webhook has not yet attached PI/Charge). A
  -- Charge/PI match is not globally unique ownership if its Checkout Session
  -- already belongs to another product.
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
    WHERE payment.stripe_charge_id = p_stripe_charge_id
      OR (
        p_stripe_payment_intent_id IS NOT NULL
        AND payment.stripe_payment_intent_id =
          p_stripe_payment_intent_id
      )
      OR (
        v_session_id IS NOT NULL
        AND payment.checkout_session_id = v_session_id
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
    WHERE tip.stripe_charge_id = p_stripe_charge_id
      OR (
        p_stripe_payment_intent_id IS NOT NULL
        AND tip.stripe_payment_intent_id =
          p_stripe_payment_intent_id
      )
      OR (
        v_session_id IS NOT NULL
        AND tip.stripe_checkout_session_id = v_session_id
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
        consumption.stripe_charge_id = p_stripe_charge_id
        OR (
          p_stripe_payment_intent_id IS NOT NULL
          AND consumption.payment_intent_id =
            p_stripe_payment_intent_id
        )
        OR (
          v_session_id IS NOT NULL
          AND consumption.checkout_session_id = v_session_id
        )
      )
  )
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.array_agg(candidate.product_kind ORDER BY candidate.product_kind),
    pg_catalog.array_agg(candidate.ledger_id ORDER BY candidate.product_kind),
    pg_catalog.array_agg(candidate.owner_user_id ORDER BY candidate.product_kind),
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

  IF v_candidate_count IS DISTINCT FROM 1 THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_identity',
      p_stripe_charge_id,
      NULL,
      'cross_product_checkout_session_conflict',
      'A Checkout Session resolves to multiple Stripe product ledgers.',
      pg_catalog.jsonb_build_object(
        'payment_intent_id', p_stripe_payment_intent_id,
        'checkout_session_id', v_session_id,
        'candidate_count', v_candidate_count,
        'product_kinds',
          COALESCE(pg_catalog.to_jsonb(v_product_kinds), '[]'::jsonb),
        'ledger_ids',
          COALESCE(pg_catalog.to_jsonb(v_ledger_ids), '[]'::jsonb)
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  v_product_kind := v_product_kinds[1];
  v_ledger_id := v_ledger_ids[1];
  v_owner_user_id := v_owner_user_ids[1];
  v_customer_id := v_customer_ids[1];
  v_payment_intent_id := v_payment_intent_ids[1];
  v_charge_id := v_charge_ids[1];
  v_session_id := v_session_ids[1];
  v_amount := v_amounts[1];
  v_currency := v_currencies[1];

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
    v_product_kind,
    v_ledger_id,
    v_owner_user_id,
    v_customer_id,
    v_payment_intent_id,
    v_charge_id,
    v_session_id,
    v_amount,
    v_currency
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_inserted_id;

  SELECT
    pg_catalog.count(*)::integer,
    (pg_catalog.array_agg(ownership.id ORDER BY ownership.id))[1]
  INTO v_matching_ownership_count, v_ownership.id
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.stripe_charge_id = p_stripe_charge_id
    OR (
      p_stripe_payment_intent_id IS NOT NULL
      AND ownership.stripe_payment_intent_id =
        p_stripe_payment_intent_id
    )
    OR (
      ownership.product_kind = v_product_kind
      AND ownership.ledger_id = v_ledger_id
    )
    OR (
      v_session_id IS NOT NULL
      AND ownership.checkout_session_id = v_session_id
    );

  IF v_matching_ownership_count IS DISTINCT FROM 1 THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_identity',
      p_stripe_charge_id,
      NULL,
      'central_payment_ownership_conflict',
      'Global Stripe identifiers are claimed by incompatible ownership rows.',
      pg_catalog.jsonb_build_object(
        'product_kind', v_product_kind,
        'ledger_id', v_ledger_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT ownership.*
  INTO v_ownership
  FROM public.stripe_payment_ownerships AS ownership
  WHERE ownership.id = v_ownership.id
  FOR UPDATE;

  IF v_ownership.product_kind IS DISTINCT FROM v_product_kind
    OR v_ownership.ledger_id IS DISTINCT FROM v_ledger_id
    OR v_ownership.owner_user_id IS DISTINCT FROM v_owner_user_id
    OR v_ownership.stripe_customer_id IS DISTINCT FROM v_customer_id
    OR v_ownership.stripe_payment_intent_id
      IS DISTINCT FROM v_payment_intent_id
    OR v_ownership.stripe_charge_id IS DISTINCT FROM v_charge_id
    OR v_ownership.checkout_session_id IS DISTINCT FROM v_session_id
    OR v_ownership.amount_paid IS DISTINCT FROM v_amount
    OR v_ownership.currency IS DISTINCT FROM v_currency
    OR NOT public.stripe_payment_ownership_is_exact_v2(v_ownership.id)
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_identity',
      p_stripe_charge_id,
      NULL,
      'central_payment_ownership_identity_conflict',
      'A global Stripe payment ownership changed immutable product identity.',
      pg_catalog.jsonb_build_object(
        'ownership_id', v_ownership.id,
        'product_kind', v_product_kind,
        'ledger_id', v_ledger_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF v_product_kind = 'pro_entitlement' THEN
    v_resolution :=
      public.stripe_merge_charge_refund_tombstone_v2(v_ledger_id);
  ELSE
    v_resolution :=
      public.stripe_resolve_non_entitlement_refund_tombstone_atomic(
        v_ownership.id
      );
  END IF;

  IF COALESCE(v_resolution ->> 'status', '') IN (
    'identity_conflict',
    'manual_review'
  ) THEN
    RETURN v_resolution || pg_catalog.jsonb_build_object(
      'ownership_id',
      v_ownership.id
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status',
    CASE WHEN v_inserted_id IS NULL
      THEN 'already_claimed'
      ELSE 'claimed'
    END,
    'ownership_id',
    v_ownership.id,
    'product_kind',
    v_ownership.product_kind,
    'ledger_id',
    v_ownership.ledger_id,
    'tombstone_status',
    v_resolution ->> 'status'
  );
END
$function$;

ALTER FUNCTION public.claim_stripe_payment_ownership_atomic(text, text)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.claim_new_pro_payment_ownership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_claim jsonb;
BEGIN
  -- Entitlement RPCs insert the payment ledger before touching projections.
  -- This AFTER INSERT hook re-queries that ledger through the central claimant.
  -- A conflict is converted to a non-entitling status; every current activation
  -- function then observes an immutable status mismatch and returns before any
  -- subscription or grant projection can be written.
  v_claim := public.claim_stripe_payment_ownership_atomic(
    NEW.stripe_charge_id,
    NEW.stripe_payment_intent_id
  );
  IF COALESCE(v_claim ->> 'status', '') IN (
    'identity_conflict',
    'manual_review'
  ) THEN
    IF EXISTS (
        SELECT 1
        FROM public.stripe_payment_ownerships AS ownership
        WHERE (
            ownership.stripe_charge_id = NEW.stripe_charge_id
            OR (
              NEW.stripe_payment_intent_id IS NOT NULL
              AND ownership.stripe_payment_intent_id =
                NEW.stripe_payment_intent_id
            )
            OR (
              NEW.checkout_session_id IS NOT NULL
              AND ownership.checkout_session_id =
                NEW.checkout_session_id
            )
          )
          AND ownership.product_kind <> 'pro_entitlement'
      )
      OR EXISTS (
        SELECT 1
        FROM public.tips AS tip
        WHERE tip.stripe_charge_id = NEW.stripe_charge_id
          OR (
            NEW.stripe_payment_intent_id IS NOT NULL
            AND tip.stripe_payment_intent_id =
              NEW.stripe_payment_intent_id
          )
          OR (
            NEW.checkout_session_id IS NOT NULL
            AND tip.stripe_checkout_session_id =
              NEW.checkout_session_id
          )
      )
      OR EXISTS (
        SELECT 1
        FROM public.group_payment_consumptions AS consumption
        WHERE consumption.stripe_charge_id = NEW.stripe_charge_id
          OR (
            NEW.stripe_payment_intent_id IS NOT NULL
            AND consumption.payment_intent_id =
              NEW.stripe_payment_intent_id
          )
          OR (
            NEW.checkout_session_id IS NOT NULL
            AND consumption.checkout_session_id =
              NEW.checkout_session_id
          )
      )
    THEN
      -- Do not leave a false Pro ledger row that could steal later refund
      -- routing from the already-owned non-entitlement Charge.
      DELETE FROM public.stripe_entitlement_payments
      WHERE id = NEW.id;
    ELSE
      UPDATE public.stripe_entitlement_payments
      SET payment_status = 'ownership_conflict',
          updated_at = pg_catalog.clock_timestamp()
      WHERE id = NEW.id
        AND payment_status IN ('paid', 'succeeded');
    END IF;
  END IF;
  RETURN NULL;
END
$function$;

ALTER FUNCTION public.claim_new_pro_payment_ownership() OWNER TO postgres;
CREATE TRIGGER trg_stripe_entitlement_payment_ownership
  AFTER INSERT ON public.stripe_entitlement_payments
  FOR EACH ROW
  EXECUTE FUNCTION public.claim_new_pro_payment_ownership();

CREATE OR REPLACE FUNCTION public.prevent_tip_payment_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  -- A mixed-deploy legacy webhook can redeliver completion after the exact
  -- payment has already become refunded or quarantined. Preserve the stronger
  -- terminal state and original completion time while accepting the otherwise
  -- identical service replay.
  IF OLD.status IN ('refunded', 'identity_conflict')
    AND NEW.status = 'completed'
    AND COALESCE((SELECT auth.role()), '')
      IS NOT DISTINCT FROM 'service_role'
    AND OLD.id = NEW.id
    AND OLD.post_id IS NOT DISTINCT FROM NEW.post_id
    AND OLD.from_user_id = NEW.from_user_id
    AND OLD.to_user_id IS NOT DISTINCT FROM NEW.to_user_id
    AND OLD.amount_cents = NEW.amount_cents
    AND OLD.stripe_checkout_session_id
      IS NOT DISTINCT FROM NEW.stripe_checkout_session_id
    AND OLD.stripe_payment_intent_id
      IS NOT DISTINCT FROM NEW.stripe_payment_intent_id
    AND OLD.stripe_charge_id IS NOT DISTINCT FROM NEW.stripe_charge_id
    AND OLD.stripe_customer_id
      IS NOT DISTINCT FROM NEW.stripe_customer_id
    AND OLD.currency IS NOT DISTINCT FROM NEW.currency
  THEN
    NEW.status := OLD.status;
    NEW.completed_at := OLD.completed_at;
    RETURN NEW;
  END IF;

  IF (
      OLD.status = 'pending'
      AND NEW.status NOT IN ('pending', 'completed', 'failed')
    )
    OR (
      OLD.status = 'completed'
      AND NEW.status NOT IN (
        'completed',
        'refunded',
        'identity_conflict'
      )
    )
    OR (
      OLD.status IN ('failed', 'refunded', 'identity_conflict')
      AND NEW.status IS DISTINCT FROM OLD.status
    )
  THEN
    RAISE EXCEPTION 'tip payment status transition is invalid'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.stripe_checkout_session_id IS NOT NULL
    AND NEW.stripe_checkout_session_id
      IS DISTINCT FROM OLD.stripe_checkout_session_id
  THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-checkout-session:' || NEW.stripe_checkout_session_id,
        0
      )
    );
    IF EXISTS (
        SELECT 1
        FROM public.stripe_payment_ownerships AS ownership
        WHERE ownership.checkout_session_id =
          NEW.stripe_checkout_session_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.stripe_entitlement_payments AS payment
        WHERE payment.checkout_session_id =
          NEW.stripe_checkout_session_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.group_payment_consumptions AS consumption
        WHERE consumption.checkout_session_id =
          NEW.stripe_checkout_session_id
      )
      OR EXISTS (
        SELECT 1
        FROM public.tips AS other_tip
        WHERE other_tip.stripe_checkout_session_id =
            NEW.stripe_checkout_session_id
          AND other_tip.id <> NEW.id
      )
    THEN
      RAISE EXCEPTION
        'tip Checkout Session is already owned by another payment'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- During the additive migration-first window, the legacy checkout webhook
  -- can replay the same completed tip while supplying a fresh wall-clock
  -- completed_at, before or after the exact writer binds Charge/Customer.
  -- Normalize the identical replay to the original terminal timestamp instead
  -- of turning a harmless Stripe redelivery into a permanent 23514 retry.
  IF OLD.status = 'completed'
    AND NEW.status = 'completed'
    AND COALESCE((SELECT auth.role()), '')
      IS NOT DISTINCT FROM 'service_role'
    AND OLD.stripe_charge_id IS NOT DISTINCT FROM NEW.stripe_charge_id
    AND OLD.stripe_customer_id
      IS NOT DISTINCT FROM NEW.stripe_customer_id
    AND OLD.currency IS NOT DISTINCT FROM NEW.currency
    AND OLD.id = NEW.id
    AND OLD.post_id IS NOT DISTINCT FROM NEW.post_id
    AND OLD.from_user_id = NEW.from_user_id
    AND OLD.to_user_id IS NOT DISTINCT FROM NEW.to_user_id
    AND OLD.amount_cents = NEW.amount_cents
    AND OLD.stripe_checkout_session_id
      IS NOT DISTINCT FROM NEW.stripe_checkout_session_id
    AND OLD.stripe_payment_intent_id
      IS NOT DISTINCT FROM NEW.stripe_payment_intent_id
  THEN
    NEW.completed_at := OLD.completed_at;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('completed', 'refunded', 'identity_conflict')
    AND (
      NEW.id IS DISTINCT FROM OLD.id
      OR NEW.post_id IS DISTINCT FROM OLD.post_id
      OR NEW.from_user_id IS DISTINCT FROM OLD.from_user_id
      OR NEW.to_user_id IS DISTINCT FROM OLD.to_user_id
      OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
      OR NEW.stripe_checkout_session_id
        IS DISTINCT FROM OLD.stripe_checkout_session_id
      OR NEW.stripe_payment_intent_id
        IS DISTINCT FROM OLD.stripe_payment_intent_id
      OR NEW.stripe_charge_id IS DISTINCT FROM OLD.stripe_charge_id
      OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
    )
  THEN
    IF NOT (
      OLD.status = 'completed'
      AND NEW.status = 'completed'
      AND COALESCE((SELECT auth.role()), '')
        IS NOT DISTINCT FROM 'service_role'
      AND OLD.stripe_charge_id IS NULL
      AND OLD.stripe_customer_id IS NULL
      AND OLD.currency IS NULL
      AND NEW.stripe_charge_id IS NOT NULL
      AND NEW.stripe_customer_id IS NOT NULL
      AND NEW.currency IS NOT NULL
      AND OLD.id = NEW.id
      AND OLD.post_id IS NOT DISTINCT FROM NEW.post_id
      AND OLD.from_user_id = NEW.from_user_id
      AND OLD.to_user_id IS NOT DISTINCT FROM NEW.to_user_id
      AND OLD.amount_cents = NEW.amount_cents
      AND OLD.stripe_checkout_session_id
        IS NOT DISTINCT FROM NEW.stripe_checkout_session_id
      AND (
        OLD.stripe_payment_intent_id IS NULL
        OR OLD.stripe_payment_intent_id =
          NEW.stripe_payment_intent_id
      )
      AND (
        OLD.completed_at IS NULL
        OR OLD.completed_at = NEW.completed_at
      )
    ) THEN
      RAISE EXCEPTION 'completed tip payment identity is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.prevent_tip_payment_identity_mutation()
  OWNER TO postgres;
CREATE TRIGGER trg_tips_payment_identity_immutable
  BEFORE UPDATE ON public.tips
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_tip_payment_identity_mutation();

ALTER TABLE public.tips
  DROP CONSTRAINT tips_status_check,
  ADD CONSTRAINT tips_status_check
    CHECK (
      status IN (
        'pending',
        'completed',
        'failed',
        'refunded',
        'identity_conflict'
      )
    );

CREATE OR REPLACE FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  p_tip_id uuid,
  p_stripe_customer_id text,
  p_stripe_payment_intent_id text,
  p_stripe_charge_id text,
  p_checkout_session_id text,
  p_amount_paid bigint,
  p_currency text,
  p_completed_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_tip public.tips%ROWTYPE;
  v_claim jsonb;
  v_was_pending boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_tip_id IS NULL
    OR pg_catalog.left(COALESCE(p_stripe_customer_id, ''), 4) <> 'cus_'
    OR pg_catalog.left(
      COALESCE(p_stripe_payment_intent_id, ''),
      3
    ) <> 'pi_'
    OR pg_catalog.left(COALESCE(p_stripe_charge_id, ''), 3) <> 'ch_'
    OR pg_catalog.left(COALESCE(p_checkout_session_id, ''), 3) <> 'cs_'
    OR p_amount_paid IS NULL
    OR p_amount_paid <= 0
    OR p_currency IS NULL
    OR p_currency !~ '^[a-z]{3}$'
    OR p_completed_at IS NULL
  THEN
    RAISE EXCEPTION 'tip Stripe ownership identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || p_stripe_charge_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-payment-identity:' || p_stripe_payment_intent_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-checkout-session:' || p_checkout_session_id,
      0
    )
  );

  SELECT tip.*
  INTO v_tip
  FROM public.tips AS tip
  WHERE tip.id = p_tip_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  v_was_pending := v_tip.status = 'pending';

  IF v_tip.amount_cents::bigint IS DISTINCT FROM p_amount_paid
    OR v_tip.stripe_checkout_session_id
      IS DISTINCT FROM p_checkout_session_id
    OR (
      v_tip.stripe_payment_intent_id IS NOT NULL
      AND v_tip.stripe_payment_intent_id
        IS DISTINCT FROM p_stripe_payment_intent_id
    )
    OR (
      v_tip.stripe_charge_id IS NOT NULL
      AND v_tip.stripe_charge_id IS DISTINCT FROM p_stripe_charge_id
    )
    OR (
      v_tip.stripe_customer_id IS NOT NULL
      AND v_tip.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
    )
    OR (
      v_tip.currency IS NOT NULL
      AND v_tip.currency IS DISTINCT FROM p_currency
    )
    OR v_tip.status NOT IN ('pending', 'completed', 'refunded')
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'tip',
      p_tip_id::text,
      v_tip.from_user_id,
      'tip_payment_identity_conflict',
      'A tip completion changed immutable Stripe or ledger identity.',
      pg_catalog.jsonb_build_object(
        'charge_id', p_stripe_charge_id,
        'payment_intent_id', p_stripe_payment_intent_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_charge_refund_tombstones AS tombstone
    WHERE tombstone.stripe_charge_id = p_stripe_charge_id
      AND (
        tombstone.stripe_customer_id IS DISTINCT FROM p_stripe_customer_id
        OR tombstone.stripe_payment_intent_id
          IS DISTINCT FROM p_stripe_payment_intent_id
        OR tombstone.amount_paid IS DISTINCT FROM p_amount_paid
        OR tombstone.currency IS DISTINCT FROM p_currency
        OR tombstone.captured IS DISTINCT FROM true
      )
  ) THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'tip',
      p_tip_id::text,
      v_tip.from_user_id,
      'tip_refund_tombstone_identity_conflict',
      'A tip completion conflicts with the existing Charge refund tombstone.',
      pg_catalog.jsonb_build_object('charge_id', p_stripe_charge_id)
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF v_tip.status = 'pending' THEN
    UPDATE public.tips
    SET status = 'completed',
        stripe_payment_intent_id = p_stripe_payment_intent_id,
        stripe_charge_id = p_stripe_charge_id,
        stripe_customer_id = p_stripe_customer_id,
        currency = p_currency,
        completed_at = p_completed_at,
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_tip_id
      AND status = 'pending';
  ELSIF v_tip.status = 'completed'
    AND v_tip.stripe_charge_id IS NULL
    AND v_tip.stripe_customer_id IS NULL
    AND v_tip.currency IS NULL
  THEN
    -- Bind the exact identity once for a completion committed by the legacy
    -- webhook during the additive application-deploy window.
    UPDATE public.tips
    SET stripe_payment_intent_id = p_stripe_payment_intent_id,
        stripe_charge_id = p_stripe_charge_id,
        stripe_customer_id = p_stripe_customer_id,
        currency = p_currency,
        completed_at = COALESCE(completed_at, p_completed_at),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_tip_id
      AND status = 'completed'
      AND stripe_charge_id IS NULL
      AND stripe_customer_id IS NULL
      AND currency IS NULL;
  END IF;

  v_claim := public.claim_stripe_payment_ownership_atomic(
    p_stripe_charge_id,
    p_stripe_payment_intent_id
  );
  IF COALESCE(v_claim ->> 'status', '') IN (
    'identity_conflict',
    'manual_review'
  ) THEN
    UPDATE public.tips
    SET status = 'identity_conflict',
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_tip_id
      AND status = 'completed';
    RETURN v_claim;
  END IF;

  SELECT tip.*
  INTO v_tip
  FROM public.tips AS tip
  WHERE tip.id = p_tip_id
  FOR UPDATE;

  RETURN v_claim || pg_catalog.jsonb_build_object(
    'status',
    CASE
      WHEN v_tip.status = 'refunded'
        THEN 'refunded'
      WHEN v_was_pending THEN 'completed'
      ELSE 'already_completed'
    END,
    'tip_id',
    p_tip_id
  );
END
$function$;

ALTER FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  uuid, text, text, text, text, bigint, text, timestamptz
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.allow_exact_group_payment_identity_bind()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'group pass consumption ledgers are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role'
    OR OLD.stripe_charge_id IS NOT NULL
    OR OLD.stripe_customer_id IS NOT NULL
    OR OLD.payment_member_joined_at IS NOT NULL
    OR NEW.stripe_charge_id IS NULL
    OR NEW.stripe_customer_id IS NULL
    OR (
      OLD.result ->> 'membership_status' = 'joined'
      AND NEW.payment_member_joined_at IS NULL
    )
    OR (
      OLD.result ->> 'membership_status' IS DISTINCT FROM 'joined'
      AND NEW.payment_member_joined_at IS NOT NULL
    )
    OR (
      pg_catalog.to_jsonb(NEW)
        - 'stripe_charge_id'
        - 'stripe_customer_id'
        - 'payment_member_joined_at'
    ) IS DISTINCT FROM (
      pg_catalog.to_jsonb(OLD)
        - 'stripe_charge_id'
        - 'stripe_customer_id'
        - 'payment_member_joined_at'
    )
  THEN
    RAISE EXCEPTION 'group pass consumption ledgers are immutable'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.allow_exact_group_payment_identity_bind()
  OWNER TO postgres;
DROP TRIGGER trg_group_payment_consumptions_immutable
  ON public.group_payment_consumptions;
CREATE TRIGGER trg_group_payment_consumptions_immutable
  BEFORE UPDATE OR DELETE ON public.group_payment_consumptions
  FOR EACH ROW
  EXECUTE FUNCTION public.allow_exact_group_payment_identity_bind();

CREATE OR REPLACE FUNCTION
  public.bind_group_pass_stripe_ownership_atomic(
    p_payment_intent_id text,
    p_stripe_charge_id text,
    p_stripe_customer_id text,
    p_payment_member_joined_at timestamptz
  )
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_consumption public.group_payment_consumptions%ROWTYPE;
  v_claim jsonb;
  v_current_member_joined_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF pg_catalog.left(COALESCE(p_payment_intent_id, ''), 3) <> 'pi_'
    OR pg_catalog.left(COALESCE(p_stripe_charge_id, ''), 3) <> 'ch_'
    OR pg_catalog.left(COALESCE(p_stripe_customer_id, ''), 4) <> 'cus_'
  THEN
    RAISE EXCEPTION 'group pass Stripe ownership identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || p_stripe_charge_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-payment-identity:' || p_payment_intent_id,
      0
    )
  );

  SELECT consumption.*
  INTO v_consumption
  FROM public.group_payment_consumptions AS consumption
  WHERE consumption.provider = 'stripe'
    AND consumption.payment_intent_id = p_payment_intent_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_consumption.checkout_session_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-checkout-session:' || v_consumption.checkout_session_id,
        0
      )
    );
  END IF;
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || v_consumption.group_id::text
        || ':' || v_consumption.user_id::text,
      0
    )
  );

  SELECT consumption.*
  INTO v_consumption
  FROM public.group_payment_consumptions AS consumption
  WHERE consumption.provider = 'stripe'
    AND consumption.payment_intent_id = p_payment_intent_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF (
      v_consumption.stripe_charge_id IS NOT NULL
      AND v_consumption.stripe_charge_id
        IS DISTINCT FROM p_stripe_charge_id
    )
    OR (
      v_consumption.stripe_customer_id IS NOT NULL
      AND v_consumption.stripe_customer_id
        IS DISTINCT FROM p_stripe_customer_id
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'group_payment',
      v_consumption.id::text,
      v_consumption.user_id,
      'group_pass_payment_identity_conflict',
      'A group pass changed immutable Stripe payment identity.',
      pg_catalog.jsonb_build_object(
        'charge_id', p_stripe_charge_id,
        'payment_intent_id', p_payment_intent_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  IF v_consumption.outcome NOT IN ('activated', 'renewed')
    OR pg_catalog.left(
      COALESCE(v_consumption.checkout_session_id, ''),
      3
    ) <> 'cs_'
    OR v_consumption.result ->> 'status' NOT IN (
      'subscribed',
      'renewed'
    )
    OR v_consumption.result ->> 'subscription_id'
      IS DISTINCT FROM v_consumption.subscription_id::text
    OR v_consumption.result ->> 'membership_status' NOT IN (
      'joined',
      'already_member'
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'group_payment',
      v_consumption.id::text,
      v_consumption.user_id,
      'group_pass_membership_provenance_invalid',
      'A group payment cannot bind ownership without exact membership provenance.',
      pg_catalog.jsonb_build_object(
        'payment_intent_id', p_payment_intent_id,
        'membership_status',
          v_consumption.result ->> 'membership_status'
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  IF v_consumption.result ->> 'membership_status' = 'joined' THEN
    SELECT member.joined_at
    INTO v_current_member_joined_at
    FROM public.group_members AS member
    WHERE member.group_id = v_consumption.group_id
      AND member.user_id = v_consumption.user_id
      AND member.role::text = 'member'
    FOR SHARE;
    IF NOT FOUND
      OR p_payment_member_joined_at IS NULL
      OR v_current_member_joined_at IS DISTINCT FROM
        p_payment_member_joined_at
    THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'group_payment',
        v_consumption.id::text,
        v_consumption.user_id,
        'group_pass_membership_provenance_conflict',
        'The payment-created group membership changed before ownership binding.',
        pg_catalog.jsonb_build_object(
          'payment_intent_id', p_payment_intent_id,
          'member_present', FOUND
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
    END IF;
  ELSIF p_payment_member_joined_at IS NOT NULL THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'group_payment',
      v_consumption.id::text,
      v_consumption.user_id,
      'group_pass_membership_provenance_conflict',
      'A pre-existing group membership cannot be claimed as payment-created.',
      pg_catalog.jsonb_build_object(
        'payment_intent_id', p_payment_intent_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  IF v_consumption.payment_member_joined_at
      IS DISTINCT FROM p_payment_member_joined_at
    AND v_consumption.payment_member_joined_at IS NOT NULL
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'group_payment',
      v_consumption.id::text,
      v_consumption.user_id,
      'group_pass_membership_provenance_conflict',
      'Immutable group membership provenance changed on replay.',
      pg_catalog.jsonb_build_object(
        'payment_intent_id', p_payment_intent_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
  END IF;

  IF v_consumption.stripe_charge_id IS NULL THEN
    UPDATE public.group_payment_consumptions
    SET stripe_charge_id = p_stripe_charge_id,
        stripe_customer_id = p_stripe_customer_id,
        payment_member_joined_at = p_payment_member_joined_at
    WHERE id = v_consumption.id
      AND stripe_charge_id IS NULL
      AND stripe_customer_id IS NULL;
  END IF;

  v_claim := public.claim_stripe_payment_ownership_atomic(
    p_stripe_charge_id,
    p_payment_intent_id
  );
  RETURN v_claim || pg_catalog.jsonb_build_object(
    'group_payment_consumption_id',
    v_consumption.id
  );
END
$function$;

ALTER FUNCTION public.bind_group_pass_stripe_ownership_atomic(
  text, text, text, timestamptz
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION
  public.activate_group_subscription_with_stripe_ownership_atomic(
    p_actor_id uuid,
    p_group_id uuid,
    p_tier text,
    p_payment_intent_id text,
    p_checkout_session_id text,
    p_amount_cents bigint,
    p_currency text,
    p_stripe_charge_id text,
    p_stripe_customer_id text
  )
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_result jsonb;
  v_bind jsonb;
  v_existing public.group_payment_consumptions%ROWTYPE;
  v_tombstone public.stripe_charge_refund_tombstones%ROWTYPE;
  v_subscription_id uuid;
  v_payment_member_joined_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_tier IS NULL
    OR p_tier NOT IN ('monthly', 'yearly')
    OR pg_catalog.left(COALESCE(p_payment_intent_id, ''), 3) <> 'pi_'
    OR pg_catalog.left(COALESCE(p_checkout_session_id, ''), 3) <> 'cs_'
    OR pg_catalog.left(COALESCE(p_stripe_charge_id, ''), 3) <> 'ch_'
    OR pg_catalog.left(COALESCE(p_stripe_customer_id, ''), 4) <> 'cus_'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_payment');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-charge-refund:' || p_stripe_charge_id,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-payment-identity:' || p_payment_intent_id,
      0
    )
  );
  IF p_checkout_session_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-checkout-session:' || p_checkout_session_id,
        0
      )
    );
  END IF;

  SELECT consumption.*
  INTO v_existing
  FROM public.group_payment_consumptions AS consumption
  WHERE consumption.provider = 'stripe'
    AND consumption.payment_intent_id = p_payment_intent_id
  FOR UPDATE;

  IF EXISTS (
      SELECT 1
      FROM public.stripe_payment_ownerships AS ownership
      WHERE ownership.stripe_charge_id = p_stripe_charge_id
        OR ownership.stripe_payment_intent_id = p_payment_intent_id
        OR (
          p_checkout_session_id IS NOT NULL
          AND ownership.checkout_session_id = p_checkout_session_id
        )
      HAVING pg_catalog.bool_or(
        ownership.product_kind IS DISTINCT FROM 'group_pass'
        OR v_existing.id IS NULL
        OR ownership.ledger_id IS DISTINCT FROM v_existing.id
        OR ownership.stripe_customer_id
          IS DISTINCT FROM p_stripe_customer_id
        OR ownership.amount_paid IS DISTINCT FROM p_amount_cents
        OR ownership.currency IS DISTINCT FROM pg_catalog.lower(p_currency)
        OR ownership.checkout_session_id
          IS DISTINCT FROM p_checkout_session_id
      )
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      WHERE payment.stripe_charge_id = p_stripe_charge_id
        OR payment.stripe_payment_intent_id = p_payment_intent_id
        OR (
          p_checkout_session_id IS NOT NULL
          AND payment.checkout_session_id = p_checkout_session_id
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.tips AS tip
      WHERE tip.stripe_charge_id = p_stripe_charge_id
        OR tip.stripe_payment_intent_id = p_payment_intent_id
        OR (
          p_checkout_session_id IS NOT NULL
          AND tip.stripe_checkout_session_id = p_checkout_session_id
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.group_payment_consumptions AS consumption
      WHERE (
          consumption.stripe_charge_id = p_stripe_charge_id
          OR consumption.payment_intent_id = p_payment_intent_id
          OR (
            p_checkout_session_id IS NOT NULL
            AND consumption.checkout_session_id =
              p_checkout_session_id
          )
        )
        AND (
          v_existing.id IS NULL
          OR consumption.id IS DISTINCT FROM v_existing.id
        )
    )
    OR (
      v_existing.id IS NOT NULL
      AND (
        v_existing.group_id IS DISTINCT FROM p_group_id
        OR v_existing.user_id IS DISTINCT FROM p_actor_id
        OR v_existing.tier IS DISTINCT FROM p_tier
        OR v_existing.checkout_session_id
          IS DISTINCT FROM p_checkout_session_id
        OR v_existing.amount_cents IS DISTINCT FROM p_amount_cents
        OR v_existing.currency
          IS DISTINCT FROM pg_catalog.lower(p_currency)
      )
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_charge_refund_tombstones AS tombstone
      WHERE tombstone.stripe_charge_id = p_stripe_charge_id
        AND (
          tombstone.stripe_customer_id
            IS DISTINCT FROM p_stripe_customer_id
          OR tombstone.stripe_payment_intent_id
            IS DISTINCT FROM p_payment_intent_id
          OR tombstone.amount_paid IS DISTINCT FROM p_amount_cents
          OR tombstone.currency
            IS DISTINCT FROM pg_catalog.lower(p_currency)
          OR tombstone.captured IS DISTINCT FROM true
        )
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'payment_identity',
      p_stripe_charge_id,
      NULL,
      'group_pass_cross_product_identity_conflict',
      'A group pass payment identity is already owned by another product.',
      pg_catalog.jsonb_build_object(
        'payment_intent_id', p_payment_intent_id,
        'group_id', p_group_id,
        'actor_id', p_actor_id
      )
    );
    RETURN pg_catalog.jsonb_build_object('status', 'identity_conflict');
  END IF;

  SELECT tombstone.*
  INTO v_tombstone
  FROM public.stripe_charge_refund_tombstones AS tombstone
  WHERE tombstone.stripe_charge_id = p_stripe_charge_id
  FOR UPDATE;
  IF FOUND THEN
    -- A refund observation that predates the group writer must never create a
    -- paid membership and then rely on a later compensating delete. Consume
    -- the exact payment into an immutable audit outcome, claim it centrally,
    -- and resolve the tombstone without touching subscription/member tables.
    IF v_existing.id IS NOT NULL
      AND v_existing.outcome IS DISTINCT FROM 'refund_blocked'
    THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'group_payment',
        v_existing.id::text,
        v_existing.user_id,
        'group_pass_refund_arrived_after_legacy_grant',
        'A legacy group grant exists for a payment with a refund tombstone.',
        pg_catalog.jsonb_build_object(
          'charge_id', p_stripe_charge_id,
          'payment_intent_id', p_payment_intent_id,
          'outcome', v_existing.outcome
        )
      );
      RETURN pg_catalog.jsonb_build_object('status', 'manual_review');
    END IF;

    BEGIN
      IF v_existing.id IS NULL THEN
        v_subscription_id := pg_catalog.gen_random_uuid();
        v_result := pg_catalog.jsonb_build_object(
          'status', 'refund_observed',
          'subscription_id', v_subscription_id,
          'idempotent_replay', false
        );
        INSERT INTO public.group_payment_consumptions (
          provider,
          payment_intent_id,
          checkout_session_id,
          subscription_id,
          group_id,
          user_id,
          tier,
          amount_cents,
          currency,
          outcome,
          result,
          stripe_charge_id,
          stripe_customer_id
        ) VALUES (
          'stripe',
          p_payment_intent_id,
          p_checkout_session_id,
          v_subscription_id,
          p_group_id,
          p_actor_id,
          p_tier,
          p_amount_cents,
          pg_catalog.lower(p_currency),
          'refund_blocked',
          v_result,
          p_stripe_charge_id,
          p_stripe_customer_id
        );
      ELSE
        v_result := v_existing.result
          || pg_catalog.jsonb_build_object('idempotent_replay', true);
      END IF;

      v_bind := public.claim_stripe_payment_ownership_atomic(
        p_stripe_charge_id,
        p_payment_intent_id
      );
      IF COALESCE(v_bind ->> 'status', '') IN (
        'identity_conflict',
        'manual_review'
      ) THEN
        RAISE EXCEPTION 'refund-blocked group ownership claim failed'
          USING ERRCODE = '23514',
            DETAIL = pg_catalog.left(v_bind::text, 1000);
      END IF;
    EXCEPTION
      WHEN check_violation THEN
        PERFORM public.record_stripe_manual_review_atomic(
          'payment_identity',
          p_stripe_charge_id,
          p_actor_id,
          'group_pass_refund_blocked_ownership_conflict',
          'A refund-blocked group payment could not claim exact central ownership.',
          pg_catalog.jsonb_build_object(
            'payment_intent_id', p_payment_intent_id,
            'checkout_session_id', p_checkout_session_id,
            'group_id', p_group_id
          )
        );
        RETURN pg_catalog.jsonb_build_object(
          'status', 'identity_conflict'
        );
    END;

    RETURN v_result || pg_catalog.jsonb_build_object(
      'stripe_ownership_id', v_bind ->> 'ownership_id',
      'tombstone_status', v_bind ->> 'tombstone_status'
    );
  END IF;

  BEGIN
    v_result := public.activate_group_subscription_atomic(
      p_actor_id,
      p_group_id,
      p_tier,
      'stripe',
      p_payment_intent_id,
      p_checkout_session_id,
      p_amount_cents,
      p_currency
    );
    IF COALESCE(v_result ->> 'status', '') NOT IN (
      'subscribed',
      'renewed'
    ) THEN
      RETURN v_result;
    END IF;

    SELECT consumption.*
    INTO v_existing
    FROM public.group_payment_consumptions AS consumption
    WHERE consumption.provider = 'stripe'
      AND consumption.payment_intent_id = p_payment_intent_id
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'group payment consumption disappeared after activation'
        USING ERRCODE = '23514';
    END IF;

    IF v_result ->> 'membership_status' = 'joined' THEN
      IF v_result ->> 'idempotent_replay' = 'true' THEN
        -- A replay can be an additive-window legacy row or a concurrent old
        -- writer that committed after the entry lookup. Never infer payment
        -- provenance from whichever same-role member happens to exist now.
        IF v_existing.payment_member_joined_at IS NULL THEN
          PERFORM public.record_stripe_manual_review_atomic(
            'group_payment',
            v_existing.id::text,
            v_existing.user_id,
            'group_pass_membership_provenance_required',
            'A legacy joined group payment cannot infer current membership as payment provenance.',
            pg_catalog.jsonb_build_object(
              'payment_intent_id', p_payment_intent_id,
              'checkout_session_id', p_checkout_session_id,
              'group_id', p_group_id
            )
          );
          RETURN pg_catalog.jsonb_build_object(
            'status', 'manual_review',
            'reason_key', 'group_pass_membership_provenance_required'
          );
        END IF;
        v_payment_member_joined_at :=
          v_existing.payment_member_joined_at;
      ELSE
        IF v_result ->> 'idempotent_replay' IS DISTINCT FROM 'false'
          OR v_existing.payment_member_joined_at IS NOT NULL
        THEN
          RAISE EXCEPTION
            'new group membership provenance state is invalid'
            USING ERRCODE = '23514';
        END IF;
        SELECT member.joined_at
        INTO v_payment_member_joined_at
        FROM public.group_members AS member
        WHERE member.group_id = p_group_id
          AND member.user_id = p_actor_id
          AND member.role::text = 'member'
        FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION
            'payment-created group membership provenance is missing'
            USING ERRCODE = '23514';
        END IF;
      END IF;
    ELSIF v_result ->> 'membership_status' IS DISTINCT FROM
      'already_member'
    THEN
      RAISE EXCEPTION 'group membership provenance status is invalid'
        USING ERRCODE = '23514';
    END IF;

    v_bind := public.bind_group_pass_stripe_ownership_atomic(
      p_payment_intent_id,
      p_stripe_charge_id,
      p_stripe_customer_id,
      v_payment_member_joined_at
    );
    IF COALESCE(v_bind ->> 'status', '') IN (
      'identity_conflict',
      'manual_review',
      'not_found'
    ) THEN
      -- Roll back every grant row inside this subtransaction. The outer
      -- handler persists a separate review after the rollback, so the proof of
      -- failure cannot disappear with the grant.
      RAISE EXCEPTION 'group pass central ownership claim failed'
        USING ERRCODE = '23514',
          DETAIL = pg_catalog.left(v_bind::text, 1000);
    END IF;
  EXCEPTION
    WHEN check_violation THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'payment_identity',
        p_stripe_charge_id,
        p_actor_id,
        'group_pass_post_grant_ownership_conflict',
        'A group grant was rolled back because central payment ownership failed.',
        pg_catalog.jsonb_build_object(
          'payment_intent_id', p_payment_intent_id,
          'checkout_session_id', p_checkout_session_id,
          'group_id', p_group_id
        )
      );
      RETURN pg_catalog.jsonb_build_object(
        'status', 'identity_conflict'
      );
  END;

  RETURN v_result || pg_catalog.jsonb_build_object(
    'stripe_ownership_id', v_bind ->> 'ownership_id',
    'tombstone_status', v_bind ->> 'tombstone_status'
  );
END
$function$;

ALTER FUNCTION
  public.activate_group_subscription_with_stripe_ownership_atomic(
    uuid, uuid, text, text, text, bigint, text, text, text
  )
OWNER TO postgres;

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
  v_claim jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  -- The legacy body remains the canonical append-only event/aggregate writer.
  -- This wrapper makes financial recording plus newest product projection one
  -- transaction without changing the application-visible RPC signature. Do
  -- not let the caller-provided user id make the financial writer lock a
  -- profile before the central PI/Session fences; exact attribution is
  -- re-derived from the claimed product ledger below.
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

  SELECT pg_catalog.count(*)::integer
  INTO v_ownership_count
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
        )
    )
$function$;

ALTER FUNCTION public.stripe_refund_tombstone_is_resolved_v2(text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.stripe_refund_tombstone_is_resolved_v2(text)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

ALTER FUNCTION public.stripe_paid_launch_readiness_v2()
  RENAME TO stripe_paid_launch_readiness_entitlement_only_legacy_v2;
REVOKE ALL ON FUNCTION
  public.stripe_paid_launch_readiness_entitlement_only_legacy_v2()
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
  v_unresolved_refund_tombstones integer;
  v_payment_ownership_anomalies integer;
  v_authority_drift integer;
  v_ready boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  v_base :=
    public.stripe_paid_launch_readiness_entitlement_only_legacy_v2();

  SELECT pg_catalog.count(*)::integer
  INTO v_unresolved_refund_tombstones
  FROM public.stripe_charge_refund_tombstones AS tombstone
  WHERE NOT public.stripe_refund_tombstone_is_resolved_v2(
    tombstone.stripe_charge_id
  );

  SELECT pg_catalog.count(*)::integer
  INTO v_payment_ownership_anomalies
  FROM (
    SELECT ownership.id
    FROM public.stripe_payment_ownerships AS ownership
    WHERE NOT public.stripe_payment_ownership_is_exact_v2(ownership.id)
    UNION ALL
    SELECT payment.id
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.payment_status = 'ownership_conflict'
      OR (
        payment.payment_status IN ('paid', 'succeeded')
        AND NOT EXISTS (
          SELECT 1
          FROM public.stripe_payment_ownerships AS ownership
          WHERE ownership.product_kind = 'pro_entitlement'
            AND ownership.ledger_id = payment.id
            AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
        )
      )
    UNION ALL
    SELECT tip.id
    FROM public.tips AS tip
    WHERE tip.stripe_charge_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.stripe_payment_ownerships AS ownership
        WHERE ownership.product_kind = 'tip'
          AND ownership.ledger_id = tip.id
          AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
      )
    UNION ALL
    SELECT tip.id
    FROM public.tips AS tip
    WHERE tip.status IN ('completed', 'refunded')
      AND (
        tip.stripe_charge_id IS NULL
        OR tip.stripe_customer_id IS NULL
        OR tip.currency IS NULL
      )
    UNION ALL
    SELECT consumption.id
    FROM public.group_payment_consumptions AS consumption
    WHERE consumption.stripe_charge_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM public.stripe_payment_ownerships AS ownership
        WHERE ownership.product_kind = 'group_pass'
          AND ownership.ledger_id = consumption.id
          AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
      )
    UNION ALL
    SELECT consumption.id
    FROM public.group_payment_consumptions AS consumption
    WHERE consumption.outcome IN ('activated', 'renewed')
      AND (
        consumption.stripe_charge_id IS NULL
        OR consumption.stripe_customer_id IS NULL
      )
  ) AS anomaly;

  v_authority_drift :=
    COALESCE((v_base ->> 'authority_drift')::integer, -1)
      + v_payment_ownership_anomalies;

  v_ready :=
    COALESCE((v_base ->> 'open_manual_reviews')::integer, -1) = 0
    AND COALESCE((v_base ->> 'unfinished_effects')::integer, -1) = 0
    AND COALESCE(
      (v_base ->> 'completed_effects_without_external_ref')::integer,
      -1
    ) = 0
    AND COALESCE((v_base ->> 'paid_unbound_payments')::integer, -1) = 0
    AND v_unresolved_refund_tombstones = 0
    AND COALESCE((v_base ->> 'reservation_anomalies')::integer, -1) = 0
    AND COALESCE((v_base ->> 'projection_drift')::integer, -1) = 0
    AND v_authority_drift = 0;

  RETURN v_base || pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_ready THEN 'ready' ELSE 'blocked' END,
    'unresolved_refund_tombstones',
      v_unresolved_refund_tombstones,
    'authority_drift',
      v_authority_drift
  );
END
$function$;

ALTER FUNCTION public.stripe_paid_launch_readiness_v2()
  OWNER TO postgres;

REVOKE ALL ON FUNCTION
  public.record_charge_refund_tombstone_atomic(
    uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamptz
  ),
  public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid),
  public.claim_stripe_payment_ownership_atomic(text,text),
  public.complete_tip_with_stripe_ownership_atomic(
    uuid,text,text,text,text,bigint,text,timestamptz
  ),
  public.bind_group_pass_stripe_ownership_atomic(
    text,text,text,timestamptz
  ),
  public.activate_group_subscription_with_stripe_ownership_atomic(
    uuid,uuid,text,text,text,bigint,text,text,text
  ),
  public.acknowledge_group_pass_full_refund_revocation_atomic(
    uuid,uuid,text,bigint,text
  ),
  public.stripe_paid_launch_readiness_v2()
FROM PUBLIC, anon, authenticated, service_role, authenticator;

GRANT EXECUTE ON FUNCTION
  public.record_charge_refund_tombstone_atomic(
    uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamptz
  ),
  public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid),
  public.claim_stripe_payment_ownership_atomic(text,text),
  public.complete_tip_with_stripe_ownership_atomic(
    uuid,text,text,text,text,bigint,text,timestamptz
  ),
  public.activate_group_subscription_with_stripe_ownership_atomic(
    uuid,uuid,text,text,text,bigint,text,text,text
  ),
  public.acknowledge_group_pass_full_refund_revocation_atomic(
    uuid,uuid,text,bigint,text
  ),
  public.stripe_paid_launch_readiness_v2()
TO service_role;

REVOKE ALL ON FUNCTION
  public.prevent_stripe_payment_ownership_mutation(),
  public.prevent_group_pass_refund_revocation_ack_mutation(),
  public.claim_new_pro_payment_ownership(),
  public.prevent_tip_payment_identity_mutation(),
  public.allow_exact_group_payment_identity_bind(),
  public.stripe_payment_ownership_is_exact_v2(uuid),
  public.group_pass_has_independent_current_authority_v2(
    uuid,uuid,uuid,uuid
  ),
  public.group_pass_full_refund_revocation_is_effective_v2(uuid),
  public.stripe_refund_tombstone_is_resolved_v2(text),
  public.stripe_merge_charge_refund_tombstone_v2(uuid),
  public.stripe_paid_launch_readiness_entitlement_only_legacy_v2(),
  public.record_charge_refund_tombstone_financial_legacy_v2(
    uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamptz
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- Renaming a function preserves every pre-existing explicit grant, and
-- postgres default privileges can also grant newly created relations to
-- out-of-band roles. Converge private helpers to owner-only and the two central
-- ledgers to service-read-only instead of merely revoking known JWT roles.
DO $converge_private_authority$
DECLARE
  v_function pg_catalog.regprocedure;
  v_relation pg_catalog.regclass;
  v_grantee oid;
  v_grantee_name name;
  v_attribute_name name;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.record_charge_refund_tombstone_financial_legacy_v2(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.stripe_merge_charge_refund_tombstone_v2(uuid)'::pg_catalog.regprocedure,
    'public.prevent_stripe_payment_ownership_mutation()'::pg_catalog.regprocedure,
    'public.prevent_group_pass_refund_revocation_ack_mutation()'::pg_catalog.regprocedure,
    'public.claim_new_pro_payment_ownership()'::pg_catalog.regprocedure,
    'public.prevent_tip_payment_identity_mutation()'::pg_catalog.regprocedure,
    'public.allow_exact_group_payment_identity_bind()'::pg_catalog.regprocedure,
    'public.bind_group_pass_stripe_ownership_atomic(text,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.stripe_payment_ownership_is_exact_v2(uuid)'::pg_catalog.regprocedure,
    'public.group_pass_has_independent_current_authority_v2(uuid,uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.group_pass_full_refund_revocation_is_effective_v2(uuid)'::pg_catalog.regprocedure,
    'public.stripe_refund_tombstone_is_resolved_v2(text)'::pg_catalog.regprocedure,
    'public.stripe_paid_launch_readiness_entitlement_only_legacy_v2()'::pg_catalog.regprocedure
  ]
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
      v_function
    );
    FOR v_grantee IN
      SELECT DISTINCT acl_row.grantee
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
      WHERE function_row.oid = v_function
        AND acl_row.grantee NOT IN (0, function_row.proowner)
    LOOP
      SELECT role_row.rolname
      INTO v_grantee_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;
      IF v_grantee_name IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
          v_function,
          v_grantee_name
        );
      END IF;
    END LOOP;
  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    'public.record_charge_refund_tombstone_atomic(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid)'::pg_catalog.regprocedure,
    'public.claim_stripe_payment_ownership_atomic(text,text)'::pg_catalog.regprocedure,
    'public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.activate_group_subscription_with_stripe_ownership_atomic(uuid,uuid,text,text,text,bigint,text,text,text)'::pg_catalog.regprocedure,
    'public.acknowledge_group_pass_full_refund_revocation_atomic(uuid,uuid,text,bigint,text)'::pg_catalog.regprocedure,
    'public.stripe_paid_launch_readiness_v2()'::pg_catalog.regprocedure
  ]
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
      v_function
    );
    FOR v_grantee IN
      SELECT DISTINCT acl_row.grantee
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
      WHERE function_row.oid = v_function
        AND acl_row.grantee NOT IN (0, function_row.proowner)
    LOOP
      SELECT role_row.rolname
      INTO v_grantee_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;
      IF v_grantee_name IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
          v_function,
          v_grantee_name
        );
      END IF;
    END LOOP;
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %s TO service_role',
      v_function
    );
  END LOOP;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.stripe_payment_ownerships'::pg_catalog.regclass,
    'public.group_pass_refund_revocation_acks'::pg_catalog.regclass
  ]
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC',
      v_relation
    );
    FOR v_grantee IN
      SELECT DISTINCT granted_role.grantee
      FROM (
        SELECT acl_row.grantee, relation.relowner
        FROM pg_catalog.pg_class AS relation
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          COALESCE(
            relation.relacl,
            pg_catalog.acldefault('r', relation.relowner)
          )
        ) AS acl_row
        WHERE relation.oid = v_relation
        UNION
        SELECT acl_row.grantee, relation.relowner
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = relation.oid
        CROSS JOIN LATERAL pg_catalog.aclexplode(
          attribute.attacl
        ) AS acl_row
        WHERE relation.oid = v_relation
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      ) AS granted_role
      WHERE granted_role.grantee NOT IN (
        0,
        granted_role.relowner
      )
    LOOP
      SELECT role_row.rolname
      INTO v_grantee_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;
      IF v_grantee_name IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON TABLE %s FROM %I',
          v_relation,
          v_grantee_name
        );
        FOR v_attribute_name IN
          SELECT attribute.attname
          FROM pg_catalog.pg_attribute AS attribute
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            attribute.attacl
          ) AS acl_row
          WHERE attribute.attrelid = v_relation
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
            AND acl_row.grantee = v_grantee
        LOOP
          EXECUTE pg_catalog.format(
            'REVOKE ALL PRIVILEGES (%I) ON TABLE %s FROM %I',
            v_attribute_name,
            v_relation,
            v_grantee_name
          );
        END LOOP;
      END IF;
    END LOOP;
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON TABLE %s TO service_role',
      v_relation
    );
  END LOOP;

  FOR v_grantee IN
    SELECT DISTINCT granted_role.grantee
    FROM (
      SELECT acl_row.grantee
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_row
      WHERE relation.oid = 'public.tips'::pg_catalog.regclass
      UNION
      SELECT acl_row.grantee
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        attribute.attacl
      ) AS acl_row
      WHERE attribute.attrelid = 'public.tips'::pg_catalog.regclass
        AND attribute.attname IN (
          'stripe_charge_id',
          'stripe_customer_id'
        )
    ) AS granted_role
    WHERE granted_role.grantee NOT IN (
      0,
      pg_catalog.to_regrole('postgres'),
      pg_catalog.to_regrole('service_role')
    )
  LOOP
    SELECT role_row.rolname
    INTO v_grantee_name
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.oid = v_grantee;
    IF v_grantee_name IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT ON TABLE public.tips FROM %I',
        v_grantee_name
      );
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (stripe_charge_id, stripe_customer_id) '
          || 'ON TABLE public.tips FROM %I',
        v_grantee_name
      );
    END IF;
  END LOOP;
  REVOKE SELECT (stripe_charge_id, stripe_customer_id)
    ON TABLE public.tips FROM PUBLIC;
  GRANT SELECT (
    id,
    post_id,
    from_user_id,
    to_user_id,
    amount_cents,
    message,
    status,
    stripe_checkout_session_id,
    stripe_payment_intent_id,
    completed_at,
    created_at,
    updated_at,
    currency
  ) ON TABLE public.tips TO authenticated;
END
$converge_private_authority$;

DO $postflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service_role oid := pg_catalog.to_regrole('service_role');
  v_function pg_catalog.regprocedure;
  v_relation pg_catalog.regclass;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.stripe_entitlement_payments AS payment
    WHERE payment.payment_status IN ('paid', 'succeeded')
      AND NOT EXISTS (
        SELECT 1
        FROM public.stripe_payment_ownerships AS ownership
        WHERE ownership.product_kind = 'pro_entitlement'
          AND ownership.ledger_id = payment.id
          AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
      )
  ) THEN
    RAISE EXCEPTION 'exact Pro payment ownership backfill is incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_charge_refund_tombstones AS tombstone
    WHERE tombstone.resolution_kind = 'entitlement_payment'
      AND NOT public.stripe_refund_tombstone_is_resolved_v2(
        tombstone.stripe_charge_id
      )
  ) THEN
    RAISE EXCEPTION
      'existing entitlement tombstone ownership backfill is incomplete';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.record_charge_refund_tombstone_atomic(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid)'::pg_catalog.regprocedure,
    'public.claim_stripe_payment_ownership_atomic(text,text)'::pg_catalog.regprocedure,
    'public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.activate_group_subscription_with_stripe_ownership_atomic(uuid,uuid,text,text,text,bigint,text,text,text)'::pg_catalog.regprocedure,
    'public.acknowledge_group_pass_full_refund_revocation_atomic(uuid,uuid,text,bigint,text)'::pg_catalog.regprocedure,
    'public.stripe_paid_launch_readiness_v2()'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND function_row.proowner = v_postgres
        AND function_row.prosecdef
        AND function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp'
        ]::text[]
    ) OR NOT pg_catalog.has_function_privilege(
      'service_role',
      v_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon',
      v_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated',
      v_function,
      'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticator',
      v_function,
      'EXECUTE'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
      WHERE function_row.oid = v_function
        AND acl_row.grantee NOT IN (v_postgres, v_service_role)
    ) THEN
      RAISE EXCEPTION 'Stripe ownership function ACL drifted: %', v_function;
    END IF;
  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    'public.record_charge_refund_tombstone_financial_legacy_v2(uuid,text,text,text,boolean,bigint,text,bigint,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.stripe_merge_charge_refund_tombstone_v2(uuid)'::pg_catalog.regprocedure,
    'public.prevent_stripe_payment_ownership_mutation()'::pg_catalog.regprocedure,
    'public.prevent_group_pass_refund_revocation_ack_mutation()'::pg_catalog.regprocedure,
    'public.claim_new_pro_payment_ownership()'::pg_catalog.regprocedure,
    'public.prevent_tip_payment_identity_mutation()'::pg_catalog.regprocedure,
    'public.allow_exact_group_payment_identity_bind()'::pg_catalog.regprocedure,
    'public.bind_group_pass_stripe_ownership_atomic(text,text,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.stripe_payment_ownership_is_exact_v2(uuid)'::pg_catalog.regprocedure,
    'public.group_pass_has_independent_current_authority_v2(uuid,uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.group_pass_full_refund_revocation_is_effective_v2(uuid)'::pg_catalog.regprocedure,
    'public.stripe_refund_tombstone_is_resolved_v2(text)'::pg_catalog.regprocedure,
    'public.stripe_paid_launch_readiness_entitlement_only_legacy_v2()'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND function_row.proowner = v_postgres
        AND function_row.prosecdef
        AND function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp'
        ]::text[]
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_row
      WHERE function_row.oid = v_function
        AND acl_row.grantee <> v_postgres
    ) THEN
      RAISE EXCEPTION 'private Stripe helper ACL drifted: %', v_function;
    END IF;
  END LOOP;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.stripe_payment_ownerships'::pg_catalog.regclass,
    'public.group_pass_refund_revocation_acks'::pg_catalog.regclass
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relowner = v_postgres
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
    ) OR NOT pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      'SELECT'
    ) OR pg_catalog.has_table_privilege(
      'service_role',
      v_relation,
      'INSERT,UPDATE,DELETE'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_row
      WHERE relation.oid = v_relation
        AND acl_row.grantee NOT IN (v_postgres, v_service_role)
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        attribute.attacl
      ) AS acl_row
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_row.grantee <> v_postgres
    ) THEN
      RAISE EXCEPTION
        'central Stripe ledger table authority drifted: %',
        v_relation;
    END IF;
  END LOOP;

  IF pg_catalog.has_column_privilege(
      'authenticated',
      'public.tips',
      'stripe_charge_id',
      'SELECT'
    )
    OR pg_catalog.has_column_privilege(
      'authenticated',
      'public.tips',
      'stripe_customer_id',
      'SELECT'
    )
    OR pg_catalog.has_column_privilege(
      'anon',
      'public.tips',
      'stripe_charge_id',
      'SELECT'
    )
    OR pg_catalog.has_column_privilege(
      'anon',
      'public.tips',
      'stripe_customer_id',
      'SELECT'
    )
    OR NOT pg_catalog.has_column_privilege(
      'authenticated',
      'public.tips',
      'id',
      'SELECT'
    )
    -- Every application-level user-defined role must also fail the effective
    -- privilege check. This catches role-membership inheritance that a direct
    -- ACL scan alone cannot see. Cluster-trusted principals (the owner,
    -- superusers, BYPASSRLS roles, and members of pg_read_all_data) already sit
    -- outside object-level ACL isolation and are intentionally not treated as
    -- browser exposure. Direct table/column ACLs are still converged and
    -- checked independently below.
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid >= 16384
        AND NOT role_row.rolsuper
        AND NOT role_row.rolbypassrls
        AND role_row.oid NOT IN (v_postgres, v_service_role)
        AND NOT pg_catalog.pg_has_role(
          role_row.oid,
          'pg_read_all_data'::pg_catalog.regrole,
          'USAGE'
        )
        AND (
          pg_catalog.has_column_privilege(
            role_row.rolname,
            'public.tips',
            'stripe_charge_id',
            'SELECT'
          )
          OR pg_catalog.has_column_privilege(
            role_row.rolname,
            'public.tips',
            'stripe_customer_id',
            'SELECT'
          )
        )
    )
    -- Direct table and financial-column ACLs must independently contain no
    -- grant outside the owner and service boundary.
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_row
      WHERE relation.oid = 'public.tips'::pg_catalog.regclass
        AND acl_row.privilege_type = 'SELECT'
        AND acl_row.grantee NOT IN (v_postgres, v_service_role)
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_row
      WHERE attribute.attrelid = 'public.tips'::pg_catalog.regclass
        AND attribute.attname IN (
          'stripe_charge_id',
          'stripe_customer_id'
        )
        AND acl_row.privilege_type = 'SELECT'
        AND acl_row.grantee NOT IN (v_postgres, v_service_role)
    )
  THEN
    RAISE EXCEPTION 'tip financial identity column ACL drifted';
  END IF;
END
$postflight$;

COMMIT;
