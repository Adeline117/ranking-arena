-- Make a completed tip, its exact Stripe ownership, and its user-visible
-- notification one atomic database outcome. The notification remains ordinary
-- user-owned inbox state (and may be deleted); the private delivery ledger is
-- the durable idempotency/tombstone authority and is never a payment ledger.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('durable-tip-completion-notification', 0)
);

DO $required_objects$
DECLARE
  v_required record;
  v_relation pg_catalog.regclass;
  v_tip_function pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamp with time zone)'
    );
  v_refund_resolver pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid)'
    );
  v_postgres oid := pg_catalog.to_regrole('postgres');
BEGIN
  IF v_postgres IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
  THEN
    RAISE EXCEPTION 'durable tip notification roles are missing';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    pg_catalog.to_regclass('public.notifications'),
    pg_catalog.to_regclass('public.tips'),
    pg_catalog.to_regclass('public.user_profiles'),
    pg_catalog.to_regclass('public.posts'),
    pg_catalog.to_regclass('public.stripe_payment_ownerships')
  ]
  LOOP
    IF v_relation IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind IN ('r', 'p')
        AND relation.relowner = v_postgres
    ) THEN
      RAISE EXCEPTION
        'durable tip notification prerequisite must be a postgres-owned table: %',
        v_relation;
    END IF;
  END LOOP;

  FOR v_required IN
    SELECT *
    FROM (
      VALUES
        ('notifications', 'id', 'uuid'::pg_catalog.regtype, true),
        ('notifications', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('notifications', 'type', 'text'::pg_catalog.regtype, true),
        ('notifications', 'title', 'text'::pg_catalog.regtype, true),
        ('notifications', 'message', 'text'::pg_catalog.regtype, true),
        ('notifications', 'link', 'text'::pg_catalog.regtype, false),
        ('notifications', 'read', 'boolean'::pg_catalog.regtype, false),
        (
          'notifications',
          'read_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        ('notifications', 'actor_id', 'uuid'::pg_catalog.regtype, false),
        ('notifications', 'reference_id', 'uuid'::pg_catalog.regtype, false),
        (
          'notifications',
          'created_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        ('tips', 'id', 'uuid'::pg_catalog.regtype, true),
        ('tips', 'post_id', 'uuid'::pg_catalog.regtype, false),
        ('tips', 'from_user_id', 'uuid'::pg_catalog.regtype, true),
        ('tips', 'to_user_id', 'uuid'::pg_catalog.regtype, false),
        ('tips', 'amount_cents', 'integer'::pg_catalog.regtype, true),
        ('tips', 'status', 'text'::pg_catalog.regtype, true),
        ('tips', 'currency', 'text'::pg_catalog.regtype, false),
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('posts', 'id', 'uuid'::pg_catalog.regtype, true),
        ('posts', 'author_id', 'uuid'::pg_catalog.regtype, false)
    ) AS required_column(
      relation_name,
      column_name,
      type_oid,
      must_be_not_null
    )
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
          'public.' || v_required.relation_name
        )
        AND attribute.attname = v_required.column_name
        AND attribute.atttypid = v_required.type_oid
        AND attribute.atttypmod = -1
        AND (
          NOT v_required.must_be_not_null
          OR attribute.attnotnull
        )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) THEN
      RAISE EXCEPTION
        'durable tip notification column shape is incompatible: %.%',
        v_required.relation_name,
        v_required.column_name;
    END IF;
  END LOOP;

  -- These delete actions are part of the production compatibility boundary.
  -- The delivery ledger intentionally has no cascading foreign key of its own.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.notifications'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid =
              'public.notifications'::pg_catalog.regclass
            AND attribute.attname = 'user_id'
        )
      ]::smallint[]
      AND constraint_row.confdeltype = 'c'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.notifications'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid =
              'public.notifications'::pg_catalog.regclass
            AND attribute.attname = 'actor_id'
        )
      ]::smallint[]
      AND constraint_row.confdeltype = 'n'
  ) THEN
    RAISE EXCEPTION
      'notification user/actor foreign-key delete actions are incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.tips'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'public.posts'::pg_catalog.regclass
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.tips'::pg_catalog.regclass
            AND attribute.attname = 'post_id'
        )
      ]::smallint[]
      AND constraint_row.confdeltype = 'n'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.tips'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.tips'::pg_catalog.regclass
            AND attribute.attname = 'from_user_id'
        )
      ]::smallint[]
      AND constraint_row.confdeltype = 'c'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.tips'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.tips'::pg_catalog.regclass
            AND attribute.attname = 'to_user_id'
        )
      ]::smallint[]
      AND constraint_row.confdeltype = 'n'
  ) THEN
    RAISE EXCEPTION 'tip authority foreign-key delete actions are incompatible';
  END IF;

  IF v_tip_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_tip_function
      AND function_row.proowner = v_postgres
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.pronargs = 8
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) THEN
    RAISE EXCEPTION
      '181845 exact tip completion function is missing or incompatible';
  END IF;

  IF v_refund_resolver IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_refund_resolver
      AND function_row.proowner = v_postgres
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.pronargs = 1
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) THEN
    RAISE EXCEPTION
      '181845 non-entitlement refund resolver is missing or incompatible';
  END IF;

  IF pg_catalog.to_regclass(
      'public.tip_completion_notification_deliveries'
    ) IS NOT NULL
    OR pg_catalog.to_regclass(
      'public.notifications_tip_received_reference_unique'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.complete_tip_with_stripe_ownership_financial_legacy_v2(uuid,text,text,text,text,bigint,text,timestamp with time zone)'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.stripe_resolve_non_entitlement_refund_notification_legacy_v2(uuid)'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.lock_tip_notification_authority_atomic(uuid)'
    ) IS NOT NULL
  THEN
    RAISE EXCEPTION
      'durable tip completion notification migration was partially applied';
  END IF;
END
$required_objects$;

-- Freeze all authority rows while historical notifications are classified and
-- the partial unique contract is installed. No historical row is rewritten or
-- deleted by this migration.
LOCK TABLE public.notifications IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.tips IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.user_profiles IN SHARE MODE;
LOCK TABLE public.posts IN SHARE MODE;
LOCK TABLE public.stripe_payment_ownerships IN SHARE MODE;

DO $historical_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.notifications AS notification
    WHERE notification.type = 'tip_received'
      AND notification.reference_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'tip_received notifications with NULL reference_id require explicit review';
  END IF;

  IF EXISTS (
    SELECT notification.reference_id
    FROM public.notifications AS notification
    WHERE notification.type = 'tip_received'
    GROUP BY notification.reference_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'duplicate tip_received reference_id values require explicit review';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.notifications AS notification
    LEFT JOIN public.tips AS tip
      ON tip.id = notification.reference_id
    WHERE notification.type = 'tip_received'
      AND (
        tip.id IS NULL
        OR tip.status IS DISTINCT FROM 'completed'
        OR notification.user_id IS DISTINCT FROM tip.to_user_id
        OR notification.actor_id IS DISTINCT FROM tip.from_user_id
        OR notification.created_at IS NULL
      )
  ) THEN
    RAISE EXCEPTION
      'legacy tip_received identity or terminal state requires explicit review';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.tips AS tip
    LEFT JOIN public.user_profiles AS actor
      ON actor.id = tip.from_user_id
    LEFT JOIN public.posts AS post
      ON post.id = tip.post_id
    WHERE tip.status IN ('completed', 'refunded')
      AND (
        tip.post_id IS NULL
        OR tip.to_user_id IS NULL
        OR tip.currency IS NULL
        OR actor.id IS NULL
        OR post.id IS NULL
        OR post.author_id IS DISTINCT FROM tip.to_user_id
        OR NOT EXISTS (
          SELECT 1
          FROM public.stripe_payment_ownerships AS ownership
          WHERE ownership.product_kind = 'tip'
            AND ownership.ledger_id = tip.id
            AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
        )
      )
  ) THEN
    RAISE EXCEPTION
      'historical terminal tips lack exact notification authority';
  END IF;

  -- An absent notification on a historical completed tip is ambiguous: it may
  -- mean delivery never happened or the recipient intentionally deleted it.
  -- Refuse to guess. Production was verified empty before this migration.
  IF EXISTS (
    SELECT 1
    FROM public.tips AS tip
    WHERE tip.status = 'completed'
      AND NOT EXISTS (
        SELECT 1
        FROM public.notifications AS notification
        WHERE notification.type = 'tip_received'
          AND notification.reference_id = tip.id
      )
  ) THEN
    RAISE EXCEPTION
      'historical completed tips without a notification require explicit classification';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.tips AS tip
    JOIN public.notifications AS notification
      ON notification.type = 'tip_received'
     AND notification.reference_id = tip.id
    WHERE tip.status IN ('refunded', 'identity_conflict')
  ) THEN
    RAISE EXCEPTION
      'terminal non-completed tips still have active notifications';
  END IF;
END
$historical_preflight$;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_tip_received_reference_required
  CHECK (type <> 'tip_received' OR reference_id IS NOT NULL)
  NOT VALID;
ALTER TABLE public.notifications
  VALIDATE CONSTRAINT notifications_tip_received_reference_required;

CREATE UNIQUE INDEX notifications_tip_received_reference_unique
  ON public.notifications (reference_id)
  WHERE type = 'tip_received';

CREATE TABLE public.tip_completion_notification_deliveries (
  tip_id uuid PRIMARY KEY,
  notification_id uuid,
  recipient_user_id uuid,
  actor_user_id uuid NOT NULL,
  post_id uuid,
  amount_cents bigint NOT NULL,
  currency text NOT NULL,
  payload_spec text NOT NULL,
  title text NOT NULL,
  message text NOT NULL,
  link text,
  disposition text NOT NULL,
  delivered_at timestamptz,
  disposed_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT tip_completion_notification_delivery_amount_check
    CHECK (amount_cents > 0),
  CONSTRAINT tip_completion_notification_delivery_currency_check
    CHECK (currency ~ '^[a-z]{3}$'),
  CONSTRAINT tip_completion_notification_delivery_spec_check
    CHECK (
      payload_spec IN (
        'tip_completion_v1',
        'legacy_tip_received_v1',
        'tip_completion_unavailable_v1'
      )
    ),
  CONSTRAINT tip_completion_notification_delivery_disposition_check
    CHECK (
      disposition IN (
        'delivered',
        'recipient_deleted',
        'authority_deleted',
        'authority_unavailable',
        'refund_suppressed',
        'identity_conflict_suppressed'
      )
    ),
  CONSTRAINT tip_completion_notification_delivery_shape_check
    CHECK (
      (
        disposition = 'delivered'
        AND notification_id IS NOT NULL
        AND delivered_at IS NOT NULL
        AND disposed_at IS NULL
      )
      OR (
        disposition IN ('recipient_deleted', 'authority_deleted')
        AND notification_id IS NOT NULL
        AND delivered_at IS NOT NULL
        AND disposed_at IS NOT NULL
      )
      OR (
        disposition = 'authority_unavailable'
        AND notification_id IS NULL
        AND delivered_at IS NULL
        AND disposed_at IS NOT NULL
      )
      OR (
        disposition IN (
          'refund_suppressed',
          'identity_conflict_suppressed'
        )
        AND disposed_at IS NOT NULL
        AND (
          (notification_id IS NULL AND delivered_at IS NULL)
          OR (notification_id IS NOT NULL AND delivered_at IS NOT NULL)
        )
      )
    ),
  CONSTRAINT tip_completion_notification_delivery_stable_link_check
    CHECK (payload_spec <> 'tip_completion_v1' OR link IS NOT NULL),
  CONSTRAINT tip_completion_notification_delivery_authority_shape_check
    CHECK (
      (
        payload_spec = 'tip_completion_unavailable_v1'
        AND disposition IN (
          'authority_unavailable',
          'refund_suppressed',
          'identity_conflict_suppressed'
        )
        AND notification_id IS NULL
        AND delivered_at IS NULL
      )
      OR (
        payload_spec <> 'tip_completion_unavailable_v1'
        AND recipient_user_id IS NOT NULL
        AND post_id IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX tip_completion_notification_delivery_notification_key
  ON public.tip_completion_notification_deliveries (notification_id)
  WHERE notification_id IS NOT NULL;

ALTER TABLE public.tip_completion_notification_deliveries OWNER TO postgres;
ALTER TABLE public.tip_completion_notification_deliveries
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tip_completion_notification_deliveries
  FORCE ROW LEVEL SECURITY;
CREATE POLICY tip_completion_notification_deliveries_service_select
  ON public.tip_completion_notification_deliveries
  FOR SELECT TO service_role
  USING (true);

REVOKE ALL ON TABLE public.tip_completion_notification_deliveries
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT SELECT ON TABLE public.tip_completion_notification_deliveries
  TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_tip_notification_delivery_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'tip completion notification deliveries are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (
    pg_catalog.to_jsonb(NEW) - 'disposition' - 'disposed_at'
  ) IS DISTINCT FROM (
    pg_catalog.to_jsonb(OLD) - 'disposition' - 'disposed_at'
  ) OR NEW.disposed_at IS NULL OR NOT (
    (
      OLD.disposition = 'delivered'
      AND NEW.disposition IN (
        'recipient_deleted',
        'authority_deleted',
        'refund_suppressed',
        'identity_conflict_suppressed'
      )
    )
    OR (
      OLD.disposition = 'recipient_deleted'
      AND NEW.disposition IN (
        'authority_deleted',
        'refund_suppressed',
        'identity_conflict_suppressed'
      )
    )
    OR (
      OLD.disposition = 'authority_deleted'
      AND NEW.disposition IN (
        'refund_suppressed',
        'identity_conflict_suppressed'
      )
    )
    OR (
      OLD.disposition = 'authority_unavailable'
      AND NEW.disposition IN (
        'refund_suppressed',
        'identity_conflict_suppressed'
      )
    )
  ) THEN
    RAISE EXCEPTION 'tip completion notification deliveries are immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.prevent_tip_notification_delivery_mutation()
  OWNER TO postgres;
CREATE TRIGGER trg_tip_notification_deliveries_immutable
  BEFORE UPDATE OR DELETE
  ON public.tip_completion_notification_deliveries
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_tip_notification_delivery_mutation();

CREATE OR REPLACE FUNCTION public.prevent_tip_received_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF OLD.type = 'tip_received' OR NEW.type = 'tip_received' THEN
    -- auth.users(actor) uses ON DELETE SET NULL. Permit only the exact FK
    -- lifecycle rewrite after the parent is no longer visible; every other
    -- identity column remains immutable.
    IF OLD.type = 'tip_received'
      AND NEW.type = 'tip_received'
      AND OLD.actor_id IS NOT NULL
      AND NEW.actor_id IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM auth.users AS actor_user
        WHERE actor_user.id = OLD.actor_id
      )
      AND (
        pg_catalog.to_jsonb(NEW) - 'read' - 'read_at' - 'actor_id'
      ) IS NOT DISTINCT FROM (
        pg_catalog.to_jsonb(OLD) - 'read' - 'read_at' - 'actor_id'
      )
    THEN
      RETURN NEW;
    END IF;

    IF (
      pg_catalog.to_jsonb(NEW) - 'read' - 'read_at'
    ) IS DISTINCT FROM (
      pg_catalog.to_jsonb(OLD) - 'read' - 'read_at'
    ) THEN
      RAISE EXCEPTION
        'tip_received notification identity is immutable'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.prevent_tip_received_identity_mutation()
  OWNER TO postgres;
CREATE TRIGGER trg_notifications_tip_received_identity_immutable
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_tip_received_identity_mutation();

CREATE OR REPLACE FUNCTION public.record_tip_notification_user_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF OLD.type = 'tip_received' AND OLD.reference_id IS NOT NULL THEN
    UPDATE public.tip_completion_notification_deliveries
    SET disposition = 'recipient_deleted',
        disposed_at = pg_catalog.clock_timestamp()
    WHERE tip_id = OLD.reference_id
      AND notification_id = OLD.id
      AND disposition = 'delivered';
  END IF;
  RETURN OLD;
END
$function$;

ALTER FUNCTION public.record_tip_notification_user_deletion()
  OWNER TO postgres;
CREATE TRIGGER trg_notifications_tip_received_delete_tombstone
  AFTER DELETE ON public.notifications
  FOR EACH ROW
  EXECUTE FUNCTION public.record_tip_notification_user_deletion();

-- 181845 made terminal payment identity immutable, but its blanket comparison
-- also rejected the production ON DELETE SET NULL actions for recipient and
-- post authority. Preserve every payment/status rule and narrowly admit only
-- parent-proven FK nullification with all financial identity unchanged.
CREATE OR REPLACE FUNCTION public.prevent_tip_payment_identity_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF OLD.status IN ('completed', 'refunded', 'identity_conflict')
    AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND (
      NEW.post_id IS DISTINCT FROM OLD.post_id
      OR NEW.to_user_id IS DISTINCT FROM OLD.to_user_id
    )
    AND (
      NEW.post_id IS NOT DISTINCT FROM OLD.post_id
      OR (
        OLD.post_id IS NOT NULL
        AND NEW.post_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM public.posts AS deleted_post
          WHERE deleted_post.id = OLD.post_id
        )
      )
    )
    AND (
      NEW.to_user_id IS NOT DISTINCT FROM OLD.to_user_id
      OR (
        OLD.to_user_id IS NOT NULL
        AND NEW.to_user_id IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM auth.users AS deleted_recipient
          WHERE deleted_recipient.id = OLD.to_user_id
        )
      )
    )
    AND NEW.id IS NOT DISTINCT FROM OLD.id
    AND NEW.from_user_id IS NOT DISTINCT FROM OLD.from_user_id
    AND NEW.amount_cents IS NOT DISTINCT FROM OLD.amount_cents
    AND NEW.stripe_checkout_session_id
      IS NOT DISTINCT FROM OLD.stripe_checkout_session_id
    AND NEW.stripe_payment_intent_id
      IS NOT DISTINCT FROM OLD.stripe_payment_intent_id
    AND NEW.stripe_charge_id IS NOT DISTINCT FROM OLD.stripe_charge_id
    AND NEW.stripe_customer_id IS NOT DISTINCT FROM OLD.stripe_customer_id
    AND NEW.currency IS NOT DISTINCT FROM OLD.currency
    AND NEW.completed_at IS NOT DISTINCT FROM OLD.completed_at
  THEN
    RETURN NEW;
  END IF;

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

CREATE OR REPLACE FUNCTION public.suppress_terminal_tip_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_disposition text;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status
    OR NEW.status NOT IN ('refunded', 'identity_conflict')
  THEN
    RETURN NEW;
  END IF;

  v_disposition := CASE NEW.status
    WHEN 'refunded' THEN 'refund_suppressed'
    ELSE 'identity_conflict_suppressed'
  END;

  -- Notification first, then delivery, matches the recipient DELETE lock order.
  DELETE FROM public.notifications AS notification
  WHERE notification.type = 'tip_received'
    AND notification.reference_id = NEW.id;

  UPDATE public.tip_completion_notification_deliveries
  SET disposition = v_disposition,
      disposed_at = pg_catalog.clock_timestamp()
  WHERE tip_id = NEW.id
    AND disposition IN (
      'delivered',
      'recipient_deleted',
      'authority_deleted',
      'authority_unavailable'
    );

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.suppress_terminal_tip_notification()
  OWNER TO postgres;
CREATE TRIGGER trg_tips_terminal_notification_suppression
  AFTER UPDATE OF status ON public.tips
  FOR EACH ROW
  EXECUTE FUNCTION public.suppress_terminal_tip_notification();

CREATE OR REPLACE FUNCTION public.suppress_detached_tip_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_tip_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_tip_id := OLD.id;
  ELSIF (
    OLD.post_id IS NOT NULL
    AND NEW.post_id IS NULL
  ) OR (
    OLD.to_user_id IS NOT NULL
    AND NEW.to_user_id IS NULL
  ) THEN
    v_tip_id := NEW.id;
  ELSE
    RETURN NEW;
  END IF;

  DELETE FROM public.notifications AS notification
  WHERE notification.type = 'tip_received'
    AND notification.reference_id = v_tip_id;

  UPDATE public.tip_completion_notification_deliveries
  SET disposition = 'authority_deleted',
      disposed_at = pg_catalog.clock_timestamp()
  WHERE tip_id = v_tip_id
    AND disposition IN ('delivered', 'recipient_deleted');

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.suppress_detached_tip_notification()
  OWNER TO postgres;
CREATE TRIGGER trg_tips_detached_notification_suppression
  AFTER UPDATE OF post_id, to_user_id OR DELETE ON public.tips
  FOR EACH ROW
  EXECUTE FUNCTION public.suppress_detached_tip_notification();

-- Lifecycle deletes lock their parent authority row before PostgreSQL runs FK
-- actions against tips/notifications. Every tip payment path must therefore
-- take the same parent-before-tip order after its canonical Stripe advisory
-- fences, otherwise ordinary account/post deletion can deadlock with a paid
-- completion or refund projection.
CREATE OR REPLACE FUNCTION public.lock_tip_notification_authority_atomic(
  p_tip_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_snapshot public.tips%ROWTYPE;
  v_locked public.tips%ROWTYPE;
  v_attempt integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_tip_id IS NULL THEN
    RAISE EXCEPTION 'tip notification authority id is required'
      USING ERRCODE = '22023';
  END IF;

  FOR v_attempt IN 1..5 LOOP
    BEGIN
      SELECT tip.*
      INTO v_snapshot
      FROM public.tips AS tip
      WHERE tip.id = p_tip_id;
      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('status', 'not_found');
      END IF;

      -- Opposite-direction tips share these locks, so UUID ordering also
      -- prevents two completions from taking actor/recipient parents in an
      -- inverse order.
      PERFORM user_row.id
      FROM auth.users AS user_row
      WHERE user_row.id = v_snapshot.from_user_id
        OR user_row.id = v_snapshot.to_user_id
      ORDER BY user_row.id
      FOR KEY SHARE;

      PERFORM profile.id
      FROM public.user_profiles AS profile
      WHERE profile.id = v_snapshot.from_user_id
      FOR SHARE;

      IF v_snapshot.post_id IS NOT NULL THEN
        PERFORM post.id
        FROM public.posts AS post
        WHERE post.id = v_snapshot.post_id
        FOR SHARE;
      END IF;

      SELECT tip.*
      INTO v_locked
      FROM public.tips AS tip
      WHERE tip.id = p_tip_id
      FOR UPDATE;
      IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('status', 'not_found');
      END IF;

      IF v_locked.from_user_id IS DISTINCT FROM v_snapshot.from_user_id
        OR v_locked.to_user_id IS DISTINCT FROM v_snapshot.to_user_id
        OR v_locked.post_id IS DISTINCT FROM v_snapshot.post_id
      THEN
        -- Roll back only this subtransaction's parent/tip locks, then retry
        -- from a fresh snapshot. Never retain tip-before-new-parent order.
        RAISE EXCEPTION 'tip notification authority changed while locking'
          USING ERRCODE = 'PTA01';
      END IF;

      RETURN pg_catalog.jsonb_build_object(
        'status', 'locked',
        'tip_id', v_locked.id,
        'actor_user_id', v_locked.from_user_id,
        'recipient_user_id', v_locked.to_user_id,
        'post_id', v_locked.post_id
      );
    EXCEPTION
      WHEN SQLSTATE 'PTA01' THEN
        IF v_attempt = 5 THEN
          RAISE EXCEPTION
            'tip notification authority changed concurrently'
            USING ERRCODE = '40001';
        END IF;
    END;
  END LOOP;

  RAISE EXCEPTION 'tip notification authority lock did not converge'
    USING ERRCODE = '40001';
END
$function$;

ALTER FUNCTION public.lock_tip_notification_authority_atomic(uuid)
  OWNER TO postgres;

-- The 181845 resolver is still the canonical refund state machine. This
-- same-signature wrapper adds only the lifecycle fence before that resolver
-- takes ownership/tip row locks and fires notification suppression triggers.
ALTER FUNCTION
  public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid)
RENAME TO
  stripe_resolve_non_entitlement_refund_notification_legacy_v2;

ALTER FUNCTION
  public.stripe_resolve_non_entitlement_refund_notification_legacy_v2(uuid)
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

  IF v_ownership.product_kind = 'tip' THEN
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

    PERFORM public.lock_tip_notification_authority_atomic(
      v_ownership.ledger_id
    );
  END IF;

  RETURN
    public.stripe_resolve_non_entitlement_refund_notification_legacy_v2(
      p_ownership_id
    );
END
$function$;

ALTER FUNCTION
  public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid)
OWNER TO postgres;

-- Preserve the already-proven 181845 financial state machine byte-for-byte.
-- The new public same-signature wrapper owns only notification delivery after
-- that private function has completed exact ownership/refund resolution.
ALTER FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  uuid, text, text, text, text, bigint, text, timestamptz
)
RENAME TO complete_tip_with_stripe_ownership_financial_legacy_v2;

ALTER FUNCTION
  public.complete_tip_with_stripe_ownership_financial_legacy_v2(
    uuid, text, text, text, text, bigint, text, timestamptz
  )
  OWNER TO postgres;

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
  v_result jsonb;
  v_tip public.tips%ROWTYPE;
  v_ownership_id uuid;
  v_actor_id uuid;
  v_post_author_id uuid;
  v_notification public.notifications%ROWTYPE;
  v_notification_found boolean := false;
  v_delivery public.tip_completion_notification_deliveries%ROWTYPE;
  v_delivery_found boolean := false;
  v_notification_id uuid;
  v_expected_title text := '收到打赏';
  v_expected_message text;
  v_expected_link text;
  v_expected_disposition text;
  v_authority_reason text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  -- Pre-acquire the exact 181845 financial advisory order, then lifecycle
  -- parents, then the tip. The private financial function re-enters these
  -- locks without changing any of its proven payment/refund decisions.
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
  PERFORM public.lock_tip_notification_authority_atomic(p_tip_id);

  v_result :=
    public.complete_tip_with_stripe_ownership_financial_legacy_v2(
      p_tip_id,
      p_stripe_customer_id,
      p_stripe_payment_intent_id,
      p_stripe_charge_id,
      p_checkout_session_id,
      p_amount_paid,
      p_currency,
      p_completed_at
    );

  SELECT tip.*
  INTO v_tip
  FROM public.tips AS tip
  WHERE tip.id = p_tip_id
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'tip_notification',
      p_tip_id::text,
      NULL,
      'tip_completion_subject_missing',
      'A Stripe tip completion references a tip that no longer exists.',
      pg_catalog.jsonb_build_object(
        'charge_id', p_stripe_charge_id,
        'payment_intent_id', p_stripe_payment_intent_id,
        'checkout_session_id', p_checkout_session_id,
        'financial_status', v_result ->> 'status'
      )
    );
    RETURN v_result || pg_catalog.jsonb_build_object(
      'completion_status', v_result ->> 'status',
      'status', 'manual_review',
      'reason_key', 'tip_completion_subject_missing'
    );
  END IF;

  -- Mutable inbox state is always locked before the durable delivery row.
  -- Cached tombstones must be honored before consulting live recipient/post
  -- projections, because those parents may have been legitimately deleted.
  SELECT notification.*
  INTO v_notification
  FROM public.notifications AS notification
  WHERE notification.type = 'tip_received'
    AND notification.reference_id = v_tip.id
  FOR UPDATE;
  v_notification_found := FOUND;

  SELECT delivery.*
  INTO v_delivery
  FROM public.tip_completion_notification_deliveries AS delivery
  WHERE delivery.tip_id = v_tip.id
  FOR UPDATE;
  v_delivery_found := FOUND;

  IF v_delivery_found
    AND v_tip.status = 'completed'
    AND COALESCE(v_result ->> 'status', '') IN (
      'completed',
      'already_completed'
    )
    AND v_delivery.disposition IN (
      'recipient_deleted',
      'authority_deleted',
      'authority_unavailable',
      'identity_conflict_suppressed'
    )
  THEN
    IF v_notification_found THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'tip_notification',
        v_tip.id::text,
        NULL,
        'tip_completion_notification_recreated_after_suppression',
        'A suppressed tip notification was recreated outside delivery authority.',
        pg_catalog.jsonb_build_object(
          'notification_id', v_notification.id,
          'delivery_disposition', v_delivery.disposition
        )
      );
      DELETE FROM public.notifications AS notification
      WHERE notification.id = v_notification.id;
      UPDATE public.tip_completion_notification_deliveries
      SET disposition = 'identity_conflict_suppressed',
          disposed_at = pg_catalog.clock_timestamp()
      WHERE tip_id = v_tip.id
        AND disposition IN (
          'recipient_deleted',
          'authority_deleted',
          'authority_unavailable'
        );
    END IF;
    IF NOT v_notification_found
      AND v_delivery.disposition IN (
        'recipient_deleted',
        'authority_deleted',
        'identity_conflict_suppressed'
      )
    THEN
      -- A recipient deleting ordinary inbox state, or a parent disappearing
      -- after a proven delivery, keeps the established completion replay
      -- contract while the durable tombstone prevents resurrection.
      RETURN v_result;
    END IF;
    RETURN v_result || pg_catalog.jsonb_build_object(
      'completion_status', v_result ->> 'status',
      'status',
        CASE
          WHEN v_delivery.disposition = 'identity_conflict_suppressed'
            OR v_notification_found
            THEN 'manual_review'
          ELSE 'notification_suppressed'
        END,
      'notification_status', 'suppressed',
      'reason_key',
        CASE v_delivery.disposition
          WHEN 'recipient_deleted'
            THEN 'tip_notification_recipient_deleted'
          WHEN 'authority_deleted'
            THEN 'tip_notification_authority_deleted'
          WHEN 'authority_unavailable'
            THEN 'tip_notification_authority_unavailable'
          ELSE 'tip_completion_notification_delivery_conflict'
        END
    );
  END IF;

  IF v_delivery_found
    AND (
      (
        v_tip.status = 'refunded'
        AND v_delivery.disposition = 'refund_suppressed'
      )
      OR (
        v_tip.status = 'identity_conflict'
        AND v_delivery.disposition = 'identity_conflict_suppressed'
      )
    )
  THEN
    IF v_notification_found THEN
      DELETE FROM public.notifications AS notification
      WHERE notification.id = v_notification.id;
    END IF;
    RETURN v_result;
  END IF;

  IF v_delivery_found
    AND v_tip.status IN ('refunded', 'identity_conflict')
    AND v_delivery.disposition IN (
      'delivered',
      'recipient_deleted',
      'authority_deleted',
      'authority_unavailable'
    )
  THEN
    IF v_notification_found THEN
      DELETE FROM public.notifications AS notification
      WHERE notification.id = v_notification.id;
    END IF;
    UPDATE public.tip_completion_notification_deliveries
    SET disposition = CASE v_tip.status
          WHEN 'refunded' THEN 'refund_suppressed'
          ELSE 'identity_conflict_suppressed'
        END,
        disposed_at = pg_catalog.clock_timestamp()
    WHERE tip_id = v_tip.id
      AND disposition IN (
        'delivered',
        'recipient_deleted',
        'authority_deleted',
        'authority_unavailable'
      );
    RETURN v_result;
  END IF;

  -- A rejected event must never manufacture a notification. If an untracked
  -- same-reference row raced in before the rejection, remove it; a previously
  -- recorded legitimate delivery remains ordinary existing inbox state.
  IF COALESCE(v_result ->> 'status', '') NOT IN (
    'completed',
    'already_completed',
    'refunded'
  ) AND v_tip.status NOT IN ('refunded', 'identity_conflict') THEN
    IF v_notification_found AND NOT v_delivery_found THEN
      DELETE FROM public.notifications AS notification
      WHERE notification.id = v_notification.id;
    END IF;
    RETURN v_result;
  END IF;

  IF v_tip.status NOT IN ('completed', 'refunded', 'identity_conflict') THEN
    RETURN v_result;
  END IF;

  IF v_tip.currency IS NULL
    OR v_tip.currency !~ '^[a-z]{3}$'
    OR v_tip.amount_cents <= 0
  THEN
    RAISE EXCEPTION
      'tip notification financial payload is invalid'
      USING ERRCODE = '23514';
  END IF;

  v_actor_id := v_tip.from_user_id;
  v_expected_message :=
    '你的帖子收到了一笔 '
    || CASE v_tip.currency
      WHEN 'usd' THEN '$'
      ELSE pg_catalog.upper(v_tip.currency) || ' '
    END
    || pg_catalog.to_char(
      v_tip.amount_cents::numeric / 100,
      'FM999999999999990.00'
    )
    || ' 打赏';
  v_expected_link := CASE
    WHEN v_tip.post_id IS NOT NULL
      THEN '/post/' || v_tip.post_id::text
    ELSE NULL
  END;

  IF v_tip.status IN ('completed', 'refunded') THEN
    SELECT ownership.id
    INTO v_ownership_id
    FROM public.stripe_payment_ownerships AS ownership
    WHERE ownership.product_kind = 'tip'
      AND ownership.ledger_id = v_tip.id
      AND ownership.owner_user_id IS NOT DISTINCT FROM v_tip.from_user_id
      AND ownership.amount_paid IS NOT DISTINCT FROM
        v_tip.amount_cents::bigint
      AND ownership.currency IS NOT DISTINCT FROM v_tip.currency
      AND public.stripe_payment_ownership_is_exact_v2(ownership.id)
    FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION
        'tip notification requires exact Stripe ownership'
      USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Parent deletion and profile lifecycle are expected terminal webhook
  -- outcomes, not retryable database crashes. Derive every surviving field
  -- from the locked tip/profile/post rows, suppress delivery, and persist an
  -- operator-visible review in the same transaction as financial completion.
  IF v_tip.to_user_id IS NULL THEN
    v_authority_reason := 'tip_notification_recipient_deleted';
  ELSIF v_tip.post_id IS NULL THEN
    v_authority_reason := 'tip_notification_post_deleted';
  ELSE
    PERFORM 1
    FROM public.user_profiles AS profile
    WHERE profile.id = v_tip.from_user_id
    FOR KEY SHARE;
    IF NOT FOUND THEN
      v_authority_reason := 'tip_notification_actor_profile_missing';
    ELSE
      SELECT post.author_id
      INTO v_post_author_id
      FROM public.posts AS post
      WHERE post.id = v_tip.post_id
      FOR KEY SHARE;
      IF NOT FOUND THEN
        v_authority_reason := 'tip_notification_post_deleted';
      ELSIF v_post_author_id IS DISTINCT FROM v_tip.to_user_id THEN
        v_authority_reason :=
          'tip_notification_post_recipient_mismatch';
      END IF;
    END IF;
  END IF;

  IF v_authority_reason IS NOT NULL THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'tip_notification',
      v_tip.id::text,
      NULL,
      v_authority_reason,
      'A completed Stripe tip cannot safely project a recipient notification.',
      pg_catalog.jsonb_build_object(
        'tip_status', v_tip.status,
        'financial_status', v_result ->> 'status',
        'notification_id', v_notification.id,
        'notification_found', v_notification_found,
        'actor_user_id', v_tip.from_user_id,
        'recipient_user_id', v_tip.to_user_id,
        'post_id', v_tip.post_id,
        'post_author_id', v_post_author_id
      )
    );

    IF v_notification_found THEN
      DELETE FROM public.notifications AS notification
      WHERE notification.id = v_notification.id;
    END IF;

    IF v_delivery_found THEN
      UPDATE public.tip_completion_notification_deliveries
      SET disposition = CASE
            WHEN v_tip.status = 'refunded' THEN 'refund_suppressed'
            WHEN v_tip.status = 'identity_conflict'
              THEN 'identity_conflict_suppressed'
            ELSE 'authority_deleted'
          END,
          disposed_at = pg_catalog.clock_timestamp()
      WHERE tip_id = v_tip.id
        AND disposition IN (
          'delivered',
          'recipient_deleted',
          'authority_deleted',
          'authority_unavailable'
        );
    ELSE
      INSERT INTO public.tip_completion_notification_deliveries (
        tip_id,
        notification_id,
        recipient_user_id,
        actor_user_id,
        post_id,
        amount_cents,
        currency,
        payload_spec,
        title,
        message,
        link,
        disposition,
        disposed_at
      ) VALUES (
        v_tip.id,
        NULL,
        v_tip.to_user_id,
        v_tip.from_user_id,
        v_tip.post_id,
        v_tip.amount_cents::bigint,
        v_tip.currency,
        'tip_completion_unavailable_v1',
        v_expected_title,
        v_expected_message,
        v_expected_link,
        CASE
          WHEN v_tip.status = 'refunded' THEN 'refund_suppressed'
          WHEN v_tip.status = 'identity_conflict'
            THEN 'identity_conflict_suppressed'
          ELSE 'authority_unavailable'
        END,
        pg_catalog.clock_timestamp()
      );
    END IF;

    RETURN v_result || pg_catalog.jsonb_build_object(
      'completion_status', v_result ->> 'status',
      'tip_status', v_tip.status,
      'status', 'notification_suppressed',
      'notification_status', 'suppressed',
      'reason_key', v_authority_reason
    );
  END IF;

  IF v_tip.status = 'completed'
    AND COALESCE(v_result ->> 'status', '') IN (
      'completed',
      'already_completed'
    )
  THEN
    IF v_delivery_found THEN
      IF v_delivery.recipient_user_id IS DISTINCT FROM v_tip.to_user_id
        OR v_delivery.actor_user_id IS DISTINCT FROM v_actor_id
        OR v_delivery.post_id IS DISTINCT FROM v_tip.post_id
        OR v_delivery.amount_cents IS DISTINCT FROM
          v_tip.amount_cents::bigint
        OR v_delivery.currency IS DISTINCT FROM v_tip.currency
        OR (
          v_delivery.payload_spec = 'tip_completion_v1'
          AND (
            v_delivery.title IS DISTINCT FROM v_expected_title
            OR v_delivery.message IS DISTINCT FROM v_expected_message
            OR v_delivery.link IS DISTINCT FROM v_expected_link
          )
        )
        OR v_delivery.disposition IS DISTINCT FROM 'delivered'
        OR NOT v_notification_found
        OR v_notification.id IS DISTINCT FROM v_delivery.notification_id
        OR v_notification.user_id IS DISTINCT FROM
          v_delivery.recipient_user_id
        OR v_notification.actor_id IS DISTINCT FROM
          v_delivery.actor_user_id
        OR v_notification.title IS DISTINCT FROM v_delivery.title
        OR v_notification.message IS DISTINCT FROM v_delivery.message
        OR v_notification.link IS DISTINCT FROM v_delivery.link
      THEN
        PERFORM public.record_stripe_manual_review_atomic(
          'tip_notification',
          v_tip.id::text,
          NULL,
          'tip_completion_notification_delivery_conflict',
          'A completed tip notification conflicts with its durable delivery authority.',
          pg_catalog.jsonb_build_object(
            'notification_id', v_notification.id,
            'delivery_notification_id', v_delivery.notification_id,
            'delivery_disposition', v_delivery.disposition,
            'recipient_user_id', v_delivery.recipient_user_id,
            'actor_user_id', v_delivery.actor_user_id,
            'post_id', v_delivery.post_id
          )
        );
        IF v_notification_found THEN
          DELETE FROM public.notifications AS notification
          WHERE notification.id = v_notification.id;
        END IF;
        UPDATE public.tip_completion_notification_deliveries
        SET disposition = 'identity_conflict_suppressed',
            disposed_at = pg_catalog.clock_timestamp()
        WHERE tip_id = v_tip.id
          AND disposition IN (
            'delivered',
            'recipient_deleted',
            'authority_deleted'
          );
        RETURN v_result;
      END IF;

      RETURN v_result;
    END IF;

    IF COALESCE(v_result ->> 'status', '') = 'already_completed' THEN
      -- During the additive deploy window, the old webhook may have completed
      -- the tip and emitted its handle/metadata-based notification first. Its
      -- identity may be adopted, but its historical payload is never rewritten
      -- or pretended to be the stable v1 payload.
      IF NOT v_notification_found
        OR v_notification.user_id IS DISTINCT FROM v_tip.to_user_id
        OR v_notification.actor_id IS DISTINCT FROM v_actor_id
        OR v_notification.created_at IS NULL
      THEN
        PERFORM public.record_stripe_manual_review_atomic(
          'tip_notification',
          v_tip.id::text,
          NULL,
          'legacy_tip_completion_notification_identity_conflict',
          'A legacy completed tip has no safely adoptable notification identity.',
          pg_catalog.jsonb_build_object(
            'notification_id', v_notification.id,
            'notification_found', v_notification_found,
            'expected_recipient_user_id', v_tip.to_user_id,
            'expected_actor_user_id', v_actor_id,
            'expected_post_id', v_tip.post_id
          )
        );
        IF v_notification_found THEN
          DELETE FROM public.notifications AS notification
          WHERE notification.id = v_notification.id;
        END IF;
        INSERT INTO public.tip_completion_notification_deliveries (
          tip_id,
          notification_id,
          recipient_user_id,
          actor_user_id,
          post_id,
          amount_cents,
          currency,
          payload_spec,
          title,
          message,
          link,
          disposition,
          delivered_at,
          disposed_at
        ) VALUES (
          v_tip.id,
          CASE
            WHEN v_notification_found
              AND v_notification.created_at IS NOT NULL
              THEN v_notification.id
            ELSE NULL
          END,
          v_tip.to_user_id,
          v_actor_id,
          v_tip.post_id,
          v_tip.amount_cents::bigint,
          v_tip.currency,
          'tip_completion_v1',
          v_expected_title,
          v_expected_message,
          v_expected_link,
          'identity_conflict_suppressed',
          CASE
            WHEN v_notification_found
              AND v_notification.created_at IS NOT NULL
              THEN v_notification.created_at
            ELSE NULL
          END,
          pg_catalog.clock_timestamp()
        );
        RETURN v_result;
      END IF;

      INSERT INTO public.tip_completion_notification_deliveries (
        tip_id,
        notification_id,
        recipient_user_id,
        actor_user_id,
        post_id,
        amount_cents,
        currency,
        payload_spec,
        title,
        message,
        link,
        disposition,
        delivered_at
      ) VALUES (
        v_tip.id,
        v_notification.id,
        v_tip.to_user_id,
        v_actor_id,
        v_tip.post_id,
        v_tip.amount_cents::bigint,
        v_tip.currency,
        'legacy_tip_received_v1',
        v_notification.title,
        v_notification.message,
        v_notification.link,
        'delivered',
        v_notification.created_at
      );
      RETURN v_result;
    END IF;

    IF v_notification_found THEN
      IF v_notification.user_id IS DISTINCT FROM v_tip.to_user_id
        OR v_notification.actor_id IS DISTINCT FROM v_actor_id
        OR v_notification.title IS DISTINCT FROM v_expected_title
        OR v_notification.message IS DISTINCT FROM v_expected_message
        OR v_notification.link IS DISTINCT FROM v_expected_link
        OR v_notification.created_at IS NULL
      THEN
        PERFORM public.record_stripe_manual_review_atomic(
          'tip_notification',
          v_tip.id::text,
          NULL,
          'tip_completion_notification_identity_conflict',
          'A tip completion found a conflicting same-reference notification.',
          pg_catalog.jsonb_build_object(
            'notification_id', v_notification.id,
            'expected_recipient_user_id', v_tip.to_user_id,
            'expected_actor_user_id', v_actor_id,
            'expected_post_id', v_tip.post_id
          )
        );
        DELETE FROM public.notifications AS notification
        WHERE notification.id = v_notification.id;
        INSERT INTO public.tip_completion_notification_deliveries (
          tip_id,
          notification_id,
          recipient_user_id,
          actor_user_id,
          post_id,
          amount_cents,
          currency,
          payload_spec,
          title,
          message,
          link,
          disposition,
          delivered_at,
          disposed_at
        ) VALUES (
          v_tip.id,
          CASE
            WHEN v_notification.created_at IS NOT NULL
              THEN v_notification.id
            ELSE NULL
          END,
          v_tip.to_user_id,
          v_actor_id,
          v_tip.post_id,
          v_tip.amount_cents::bigint,
          v_tip.currency,
          'tip_completion_v1',
          v_expected_title,
          v_expected_message,
          v_expected_link,
          'identity_conflict_suppressed',
          v_notification.created_at,
          pg_catalog.clock_timestamp()
        );
        RETURN v_result;
      END IF;
      v_notification_id := v_notification.id;
    ELSE
      v_notification_id := pg_catalog.gen_random_uuid();
      INSERT INTO public.notifications (
        id,
        user_id,
        type,
        title,
        message,
        link,
        actor_id,
        reference_id,
        read,
        created_at
      ) VALUES (
        v_notification_id,
        v_tip.to_user_id,
        'tip_received',
        v_expected_title,
        v_expected_message,
        v_expected_link,
        v_actor_id,
        v_tip.id,
        false,
        pg_catalog.clock_timestamp()
      )
      RETURNING * INTO v_notification;
    END IF;

    INSERT INTO public.tip_completion_notification_deliveries (
      tip_id,
      notification_id,
      recipient_user_id,
      actor_user_id,
      post_id,
      amount_cents,
      currency,
      payload_spec,
      title,
      message,
      link,
      disposition,
      delivered_at
    ) VALUES (
      v_tip.id,
      v_notification_id,
      v_tip.to_user_id,
      v_actor_id,
      v_tip.post_id,
      v_tip.amount_cents::bigint,
      v_tip.currency,
      'tip_completion_v1',
      v_expected_title,
      v_expected_message,
      v_expected_link,
      'delivered',
      v_notification.created_at
    );

    RETURN v_result;
  END IF;

  IF v_tip.status IN ('refunded', 'identity_conflict') THEN
    v_expected_disposition := CASE v_tip.status
      WHEN 'refunded' THEN 'refund_suppressed'
      ELSE 'identity_conflict_suppressed'
    END;

    IF v_notification_found THEN
      DELETE FROM public.notifications AS notification
      WHERE notification.id = v_notification.id;
      v_notification_found := false;

      SELECT delivery.*
      INTO v_delivery
      FROM public.tip_completion_notification_deliveries AS delivery
      WHERE delivery.tip_id = v_tip.id
      FOR UPDATE;
      v_delivery_found := FOUND;
    END IF;

    IF v_delivery_found THEN
      IF v_delivery.recipient_user_id IS DISTINCT FROM v_tip.to_user_id
        OR v_delivery.actor_user_id IS DISTINCT FROM v_actor_id
        OR v_delivery.post_id IS DISTINCT FROM v_tip.post_id
        OR v_delivery.amount_cents IS DISTINCT FROM
          v_tip.amount_cents::bigint
        OR v_delivery.currency IS DISTINCT FROM v_tip.currency
      THEN
        RAISE EXCEPTION
          'terminal tip notification delivery authority conflict'
          USING ERRCODE = '23514';
      END IF;

      IF v_delivery.disposition IN (
        'delivered',
        'recipient_deleted',
        'authority_deleted',
        'authority_unavailable'
      ) THEN
        UPDATE public.tip_completion_notification_deliveries
        SET disposition = v_expected_disposition,
            disposed_at = pg_catalog.clock_timestamp()
        WHERE tip_id = v_tip.id;
      ELSIF v_delivery.disposition IS DISTINCT FROM
        v_expected_disposition
      THEN
        RAISE EXCEPTION
          'terminal tip notification disposition conflict'
          USING ERRCODE = '23514';
      END IF;
    ELSE
      INSERT INTO public.tip_completion_notification_deliveries (
        tip_id,
        notification_id,
        recipient_user_id,
        actor_user_id,
        post_id,
        amount_cents,
        currency,
        payload_spec,
        title,
        message,
        link,
        disposition,
        disposed_at
      ) VALUES (
        v_tip.id,
        NULL,
        v_tip.to_user_id,
        v_actor_id,
        v_tip.post_id,
        v_tip.amount_cents::bigint,
        v_tip.currency,
        'tip_completion_v1',
        v_expected_title,
        v_expected_message,
        v_expected_link,
        v_expected_disposition,
        pg_catalog.clock_timestamp()
      );
    END IF;
  END IF;

  RETURN v_result;
END
$function$;

ALTER FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  uuid, text, text, text, text, bigint, text, timestamptz
) OWNER TO postgres;

-- Adopt only historically proven identities. The old payload is preserved as
-- observed; completed tips without a row were rejected above rather than
-- guessed. Refunded tips get an explicit non-delivery tombstone.
INSERT INTO public.tip_completion_notification_deliveries (
  tip_id,
  notification_id,
  recipient_user_id,
  actor_user_id,
  post_id,
  amount_cents,
  currency,
  payload_spec,
  title,
  message,
  link,
  disposition,
  delivered_at
)
SELECT
  tip.id,
  notification.id,
  tip.to_user_id,
  tip.from_user_id,
  tip.post_id,
  tip.amount_cents::bigint,
  tip.currency,
  'legacy_tip_received_v1',
  notification.title,
  notification.message,
  notification.link,
  'delivered',
  notification.created_at
FROM public.tips AS tip
JOIN public.notifications AS notification
  ON notification.type = 'tip_received'
 AND notification.reference_id = tip.id
WHERE tip.status = 'completed';

INSERT INTO public.tip_completion_notification_deliveries (
  tip_id,
  notification_id,
  recipient_user_id,
  actor_user_id,
  post_id,
  amount_cents,
  currency,
  payload_spec,
  title,
  message,
  link,
  disposition,
  disposed_at
)
SELECT
  tip.id,
  NULL,
  tip.to_user_id,
  tip.from_user_id,
  tip.post_id,
  tip.amount_cents::bigint,
  tip.currency,
  'tip_completion_v1',
  '收到打赏',
  '你的帖子收到了一笔 '
    || CASE tip.currency
      WHEN 'usd' THEN '$'
      ELSE pg_catalog.upper(tip.currency) || ' '
    END
    || pg_catalog.to_char(
      tip.amount_cents::numeric / 100,
      'FM999999999999990.00'
    )
    || ' 打赏',
  '/post/' || tip.post_id::text,
  'refund_suppressed',
  pg_catalog.clock_timestamp()
FROM public.tips AS tip
WHERE tip.status = 'refunded';

-- Extend the existing paid-launch gate without changing its public signature.
-- The private 181845 result remains canonical for financial ownership; this
-- wrapper adds the notification-delivery projection as another fail-closed
-- authority surface.
ALTER FUNCTION public.stripe_paid_launch_readiness_v2()
  RENAME TO stripe_paid_launch_readiness_non_notification_legacy_v2;
REVOKE ALL ON FUNCTION
  public.stripe_paid_launch_readiness_non_notification_legacy_v2()
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
  v_notification_delivery_anomalies integer;
  v_authority_drift integer;
  v_ready boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  v_base :=
    public.stripe_paid_launch_readiness_non_notification_legacy_v2();

  SELECT pg_catalog.count(*)::integer
  INTO v_notification_delivery_anomalies
  FROM (
    SELECT 'tip:' || tip.id::text AS anomaly_key
    FROM public.tips AS tip
    LEFT JOIN public.tip_completion_notification_deliveries AS delivery
      ON delivery.tip_id = tip.id
    WHERE (
        tip.status = 'completed'
        AND (
          delivery.tip_id IS NULL
          OR delivery.disposition NOT IN (
            'delivered',
            'recipient_deleted',
            'authority_deleted',
            'authority_unavailable',
            'identity_conflict_suppressed'
          )
          OR (
            delivery.disposition = 'delivered'
            AND NOT EXISTS (
              SELECT 1
              FROM public.notifications AS notification
              WHERE notification.id = delivery.notification_id
                AND notification.type = 'tip_received'
                AND notification.reference_id = tip.id
                AND notification.user_id = delivery.recipient_user_id
                AND notification.actor_id = delivery.actor_user_id
                AND notification.title = delivery.title
                AND notification.message = delivery.message
                AND notification.link IS NOT DISTINCT FROM delivery.link
            )
          )
          OR (
            delivery.disposition <> 'delivered'
            AND EXISTS (
              SELECT 1
              FROM public.notifications AS notification
              WHERE notification.type = 'tip_received'
                AND notification.reference_id = tip.id
            )
          )
        )
      )
      OR (
        tip.status = 'refunded'
        AND (
          delivery.tip_id IS NULL
          OR delivery.disposition <> 'refund_suppressed'
          OR EXISTS (
            SELECT 1
            FROM public.notifications AS notification
            WHERE notification.type = 'tip_received'
              AND notification.reference_id = tip.id
          )
        )
      )
      OR (
        tip.status = 'identity_conflict'
        AND (
          delivery.tip_id IS NULL
          OR delivery.disposition <> 'identity_conflict_suppressed'
          OR EXISTS (
            SELECT 1
            FROM public.notifications AS notification
            WHERE notification.type = 'tip_received'
              AND notification.reference_id = tip.id
          )
        )
      )
      OR (
        tip.status NOT IN ('completed', 'refunded', 'identity_conflict')
        AND (
          delivery.tip_id IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM public.notifications AS notification
            WHERE notification.type = 'tip_received'
              AND notification.reference_id = tip.id
          )
        )
      )
      OR (
        delivery.tip_id IS NOT NULL
        AND (
          delivery.actor_user_id IS DISTINCT FROM tip.from_user_id
          OR delivery.amount_cents IS DISTINCT FROM
            tip.amount_cents::bigint
          OR delivery.currency IS DISTINCT FROM tip.currency
          OR (
            delivery.disposition IN ('delivered', 'recipient_deleted')
            AND (
              delivery.recipient_user_id IS DISTINCT FROM tip.to_user_id
              OR delivery.post_id IS DISTINCT FROM tip.post_id
              OR NOT EXISTS (
                SELECT 1
                FROM public.user_profiles AS profile
                WHERE profile.id = tip.from_user_id
              )
              OR NOT EXISTS (
                SELECT 1
                FROM public.posts AS post
                WHERE post.id = tip.post_id
                  AND post.author_id = tip.to_user_id
              )
            )
          )
        )
      )

    UNION

    SELECT 'notification:' || notification.id::text
    FROM public.notifications AS notification
    LEFT JOIN public.tip_completion_notification_deliveries AS delivery
      ON delivery.notification_id = notification.id
    LEFT JOIN public.tips AS tip
      ON tip.id = delivery.tip_id
    WHERE notification.type = 'tip_received'
      AND (
        delivery.tip_id IS NULL
        OR tip.id IS NULL
        OR tip.status <> 'completed'
        OR delivery.disposition <> 'delivered'
        OR notification.reference_id IS DISTINCT FROM delivery.tip_id
        OR notification.user_id IS DISTINCT FROM
          delivery.recipient_user_id
        OR notification.actor_id IS DISTINCT FROM delivery.actor_user_id
        OR notification.title IS DISTINCT FROM delivery.title
        OR notification.message IS DISTINCT FROM delivery.message
        OR notification.link IS DISTINCT FROM delivery.link
      )

    UNION

    SELECT 'delivery:' || delivery.tip_id::text
    FROM public.tip_completion_notification_deliveries AS delivery
    LEFT JOIN public.tips AS tip
      ON tip.id = delivery.tip_id
    WHERE tip.id IS NULL
      OR (
        delivery.payload_spec = 'tip_completion_v1'
        AND (
          delivery.title <> '收到打赏'
          OR delivery.message IS DISTINCT FROM (
            '你的帖子收到了一笔 '
            || CASE delivery.currency
              WHEN 'usd' THEN '$'
              ELSE pg_catalog.upper(delivery.currency) || ' '
            END
            || pg_catalog.to_char(
              delivery.amount_cents::numeric / 100,
              'FM999999999999990.00'
            )
            || ' 打赏'
          )
          OR delivery.link IS DISTINCT FROM
            '/post/' || delivery.post_id::text
        )
      )
      OR (
        delivery.payload_spec = 'tip_completion_unavailable_v1'
        AND (
          delivery.title <> '收到打赏'
          OR delivery.message IS DISTINCT FROM (
            '你的帖子收到了一笔 '
            || CASE delivery.currency
              WHEN 'usd' THEN '$'
              ELSE pg_catalog.upper(delivery.currency) || ' '
            END
            || pg_catalog.to_char(
              delivery.amount_cents::numeric / 100,
              'FM999999999999990.00'
            )
            || ' 打赏'
          )
          OR delivery.link IS DISTINCT FROM CASE
            WHEN delivery.post_id IS NULL THEN NULL
            ELSE '/post/' || delivery.post_id::text
          END
        )
      )
  ) AS anomaly;

  v_authority_drift :=
    COALESCE((v_base ->> 'authority_drift')::integer, -1)
      + v_notification_delivery_anomalies;
  v_ready :=
    v_base ->> 'status' = 'ready'
    AND v_notification_delivery_anomalies = 0;

  RETURN v_base || pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_ready THEN 'ready' ELSE 'blocked' END,
    'notification_delivery_anomalies',
      v_notification_delivery_anomalies,
    'authority_drift', v_authority_drift
  );
END
$function$;

ALTER FUNCTION public.stripe_paid_launch_readiness_v2()
  OWNER TO postgres;

REVOKE ALL ON FUNCTION
  public.complete_tip_with_stripe_ownership_financial_legacy_v2(
    uuid, text, text, text, text, bigint, text, timestamptz
  ),
  public.prevent_tip_notification_delivery_mutation(),
  public.prevent_tip_received_identity_mutation(),
  public.record_tip_notification_user_deletion(),
  public.suppress_terminal_tip_notification(),
  public.suppress_detached_tip_notification(),
  public.lock_tip_notification_authority_atomic(uuid),
  public.stripe_resolve_non_entitlement_refund_notification_legacy_v2(uuid),
  public.stripe_paid_launch_readiness_non_notification_legacy_v2()
FROM PUBLIC, anon, authenticated, service_role, authenticator;

REVOKE ALL ON FUNCTION
  public.complete_tip_with_stripe_ownership_atomic(
    uuid, text, text, text, text, bigint, text, timestamptz
  ),
  public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid),
  public.stripe_paid_launch_readiness_v2()
FROM PUBLIC, anon, authenticated, service_role, authenticator;
GRANT EXECUTE ON FUNCTION
  public.complete_tip_with_stripe_ownership_atomic(
    uuid, text, text, text, text, bigint, text, timestamptz
  ),
  public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid),
  public.stripe_paid_launch_readiness_v2()
TO service_role;

-- Remove out-of-band direct default grants as well as the known JWT roles.
DO $converge_acl$
DECLARE
  v_function pg_catalog.regprocedure;
  v_relation pg_catalog.regclass :=
    'public.tip_completion_notification_deliveries'::pg_catalog.regclass;
  v_grantee oid;
  v_grantee_name name;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.complete_tip_with_stripe_ownership_financial_legacy_v2(uuid,text,text,text,text,bigint,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.prevent_tip_notification_delivery_mutation()'::pg_catalog.regprocedure,
    'public.prevent_tip_received_identity_mutation()'::pg_catalog.regprocedure,
    'public.record_tip_notification_user_deletion()'::pg_catalog.regprocedure,
    'public.suppress_terminal_tip_notification()'::pg_catalog.regprocedure,
    'public.suppress_detached_tip_notification()'::pg_catalog.regprocedure,
    'public.prevent_tip_payment_identity_mutation()'::pg_catalog.regprocedure,
    'public.lock_tip_notification_authority_atomic(uuid)'::pg_catalog.regprocedure,
    'public.stripe_resolve_non_entitlement_refund_notification_legacy_v2(uuid)'::pg_catalog.regprocedure,
    'public.stripe_paid_launch_readiness_non_notification_legacy_v2()'::pg_catalog.regprocedure
  ]
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
      v_function
    );
    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl)
        AS acl_entry
      WHERE function_row.oid = v_function
        AND acl_entry.grantee NOT IN (0, function_row.proowner)
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
    'public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid)'::pg_catalog.regprocedure,
    'public.stripe_paid_launch_readiness_v2()'::pg_catalog.regprocedure
  ]
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
      v_function
    );
    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl)
        AS acl_entry
      WHERE function_row.oid = v_function
        AND acl_entry.grantee NOT IN (0, function_row.proowner)
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
  GRANT EXECUTE ON FUNCTION
    public.complete_tip_with_stripe_ownership_atomic(
      uuid, text, text, text, text, bigint, text, timestamptz
    ),
    public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid),
    public.stripe_paid_launch_readiness_v2()
  TO service_role;

  EXECUTE pg_catalog.format(
    'REVOKE ALL PRIVILEGES ON TABLE %s FROM PUBLIC',
    v_relation
  );
  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(relation.relacl)
      AS acl_entry
    WHERE relation.oid = v_relation
      AND acl_entry.grantee NOT IN (0, relation.relowner)
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
    END IF;
  END LOOP;
  GRANT SELECT ON TABLE public.tip_completion_notification_deliveries
    TO service_role;
END
$converge_acl$;

COMMENT ON TABLE public.tip_completion_notification_deliveries IS
  'Service-read-only idempotency and suppression ledger for atomic tip completion notifications. It intentionally has no cascading FK and is not payment authority.';
COMMENT ON FUNCTION public.complete_tip_with_stripe_ownership_atomic(
  uuid, text, text, text, text, bigint, text, timestamptz
) IS
  'Service-only exact tip completion wrapper: preserves the private 181845 financial state machine and atomically records or validates durable notification delivery.';
COMMENT ON FUNCTION
  public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid)
IS
  'Service-only 181845 refund resolver wrapper: takes Stripe advisories and immutable notification authority parents before the tip row.';
COMMENT ON FUNCTION public.stripe_paid_launch_readiness_v2() IS
  'Service-only paid-launch gate including exact tip notification delivery and suppression authority.';

DO $postflight$
DECLARE
  v_wrapper pg_catalog.regprocedure :=
    'public.complete_tip_with_stripe_ownership_atomic(uuid,text,text,text,text,bigint,text,timestamp with time zone)'::pg_catalog.regprocedure;
  v_private pg_catalog.regprocedure :=
    'public.complete_tip_with_stripe_ownership_financial_legacy_v2(uuid,text,text,text,text,bigint,text,timestamp with time zone)'::pg_catalog.regprocedure;
  v_refund_wrapper pg_catalog.regprocedure :=
    'public.stripe_resolve_non_entitlement_refund_tombstone_atomic(uuid)'::pg_catalog.regprocedure;
  v_refund_private pg_catalog.regprocedure :=
    'public.stripe_resolve_non_entitlement_refund_notification_legacy_v2(uuid)'::pg_catalog.regprocedure;
  v_authority_lock pg_catalog.regprocedure :=
    'public.lock_tip_notification_authority_atomic(uuid)'::pg_catalog.regprocedure;
  v_readiness pg_catalog.regprocedure :=
    'public.stripe_paid_launch_readiness_v2()'::pg_catalog.regprocedure;
  v_readiness_private pg_catalog.regprocedure :=
    'public.stripe_paid_launch_readiness_non_notification_legacy_v2()'::pg_catalog.regprocedure;
  v_delivery pg_catalog.regclass :=
    'public.tip_completion_notification_deliveries'::pg_catalog.regclass;
  v_postgres oid := pg_catalog.to_regrole('postgres');
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indexrelid =
        'public.notifications_tip_received_reference_unique'
          ::pg_catalog.regclass
      AND index_row.indrelid = 'public.notifications'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND pg_catalog.pg_get_expr(
        index_row.indpred,
        index_row.indrelid
      ) = '(type = ''tip_received''::text)'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.notifications'::pg_catalog.regclass
      AND constraint_row.conname =
        'notifications_tip_received_reference_required'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION
      'tip_received reference idempotency contract did not converge';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_delivery
      AND relation.relowner = v_postgres
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', v_delivery, 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'service_role', v_delivery, 'INSERT'
  ) OR pg_catalog.has_table_privilege(
    'service_role', v_delivery, 'UPDATE'
  ) OR pg_catalog.has_table_privilege(
    'service_role', v_delivery, 'DELETE'
  ) OR pg_catalog.has_table_privilege(
    'anon', v_delivery, 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', v_delivery, 'SELECT'
  ) THEN
    RAISE EXCEPTION
      'tip completion notification delivery ACL did not converge';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_wrapper
      AND function_row.proowner = v_postgres
      AND function_row.prosecdef
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_wrapper, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_wrapper, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_wrapper, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticator', v_wrapper, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role', v_private, 'EXECUTE'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_refund_wrapper
      AND function_row.proowner = v_postgres
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_refund_wrapper, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_refund_wrapper, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_refund_wrapper, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticator', v_refund_wrapper, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role', v_refund_private, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role', v_authority_lock, 'EXECUTE'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_readiness
      AND function_row.proowner = v_postgres
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_readiness, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_readiness, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_readiness, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticator', v_readiness, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role', v_readiness_private, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'durable tip completion function ACL did not converge';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.notifications'::pg_catalog.regclass
      AND trigger_row.tgname =
        'trg_notifications_tip_received_identity_immutable'
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.notifications'::pg_catalog.regclass
      AND trigger_row.tgname =
        'trg_notifications_tip_received_delete_tombstone'
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.tips'::pg_catalog.regclass
      AND trigger_row.tgname =
        'trg_tips_terminal_notification_suppression'
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.tips'::pg_catalog.regclass
      AND trigger_row.tgname =
        'trg_tips_detached_notification_suppression'
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION
      'durable tip notification triggers did not converge';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.tips AS tip
    WHERE tip.status = 'completed'
      AND NOT EXISTS (
        SELECT 1
        FROM public.tip_completion_notification_deliveries AS delivery
        JOIN public.notifications AS notification
          ON notification.id = delivery.notification_id
        WHERE delivery.tip_id = tip.id
          AND delivery.disposition = 'delivered'
          AND notification.type = 'tip_received'
          AND notification.reference_id = tip.id
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.tips AS tip
    WHERE tip.status = 'refunded'
      AND (
        EXISTS (
          SELECT 1
          FROM public.notifications AS notification
          WHERE notification.type = 'tip_received'
            AND notification.reference_id = tip.id
        )
        OR NOT EXISTS (
          SELECT 1
          FROM public.tip_completion_notification_deliveries AS delivery
          WHERE delivery.tip_id = tip.id
            AND delivery.disposition = 'refund_suppressed'
        )
      )
  ) THEN
    RAISE EXCEPTION
      'historical tip notification delivery projection did not converge';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
