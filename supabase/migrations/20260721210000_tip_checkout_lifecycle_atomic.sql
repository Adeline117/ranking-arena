-- Make Tip Checkout reservation, Stripe Session binding, and expiry durable
-- database state transitions. The application supplies intent and fresh Stripe
-- authority; this migration owns serialization, exact identity, and terminal
-- state shape.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('tip-checkout-lifecycle-migration', 0)
);

DO $required_objects$
DECLARE
  v_relation pg_catalog.regclass;
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_auth_owner text;
  v_postgres_super boolean;
  v_postgres_bypassrls boolean;
  v_required record;
  v_required_fk record;
  v_audience pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure('public.can_actor_read_post_id(uuid,uuid)');
  v_interaction_lock pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.lock_actor_can_interact_with_post(uuid,uuid)'
    );
  v_authority_lock pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.lock_tip_notification_authority_atomic(uuid)'
    );
  v_manual_review pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.record_stripe_manual_review_atomic(text,text,uuid,text,text,jsonb)'
    );
BEGIN
  IF v_postgres IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
  THEN
    RAISE EXCEPTION 'tip checkout lifecycle roles are missing';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    pg_catalog.to_regclass('public.user_profiles'),
    pg_catalog.to_regclass('public.posts'),
    pg_catalog.to_regclass('public.tips'),
    pg_catalog.to_regclass('public.stripe_payment_ownerships'),
    pg_catalog.to_regclass('public.stripe_entitlement_payments'),
    pg_catalog.to_regclass('public.group_payment_consumptions')
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
        'tip checkout lifecycle prerequisite must be a postgres-owned table: %',
        v_relation;
    END IF;
  END LOOP;

  v_relation := pg_catalog.to_regclass('auth.users');
  IF v_relation IS NULL THEN
    RAISE EXCEPTION 'auth.users must be an ordinary table';
  END IF;

  SELECT owner_role.rolname
  INTO STRICT v_auth_owner
  FROM pg_catalog.pg_class AS relation
  JOIN pg_catalog.pg_roles AS owner_role
    ON owner_role.oid = relation.relowner
  WHERE relation.oid = v_relation
    AND relation.relkind IN ('r', 'p');

  SELECT role_row.rolsuper, role_row.rolbypassrls
  INTO STRICT v_postgres_super, v_postgres_bypassrls
  FROM pg_catalog.pg_roles AS role_row
  WHERE role_row.oid = v_postgres;

  IF v_auth_owner NOT IN ('postgres', 'supabase_auth_admin')
    OR (
      NOT v_postgres_super
      AND NOT pg_catalog.has_schema_privilege('postgres', 'auth', 'USAGE')
    )
    OR (
      v_auth_owner = 'supabase_auth_admin'
      AND NOT v_postgres_super
      AND NOT (
        v_postgres_bypassrls
        AND pg_catalog.has_table_privilege(
          'postgres', v_relation, 'SELECT'
        )
        AND pg_catalog.has_table_privilege(
          'postgres', v_relation, 'UPDATE'
        )
      )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind IN ('r', 'p')
    )
  THEN
    RAISE EXCEPTION
      'auth.users must retain hosted ownership and postgres row-lock authority';
  END IF;

  FOR v_required IN
    SELECT *
    FROM (
      VALUES
        ('tips', 'id', 'uuid'::pg_catalog.regtype, true),
        ('tips', 'post_id', 'uuid'::pg_catalog.regtype, false),
        ('tips', 'from_user_id', 'uuid'::pg_catalog.regtype, true),
        ('tips', 'to_user_id', 'uuid'::pg_catalog.regtype, false),
        ('tips', 'amount_cents', 'integer'::pg_catalog.regtype, true),
        ('tips', 'message', 'text'::pg_catalog.regtype, false),
        ('tips', 'status', 'text'::pg_catalog.regtype, true),
        (
          'tips',
          'stripe_checkout_session_id',
          'text'::pg_catalog.regtype,
          false
        ),
        (
          'tips',
          'stripe_payment_intent_id',
          'text'::pg_catalog.regtype,
          false
        ),
        ('tips', 'stripe_charge_id', 'text'::pg_catalog.regtype, false),
        ('tips', 'stripe_customer_id', 'text'::pg_catalog.regtype, false),
        ('tips', 'currency', 'text'::pg_catalog.regtype, false),
        (
          'tips',
          'completed_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        (
          'tips',
          'created_at',
          'timestamp with time zone'::pg_catalog.regtype,
          true
        ),
        (
          'tips',
          'updated_at',
          'timestamp with time zone'::pg_catalog.regtype,
          true
        ),
        ('posts', 'id', 'uuid'::pg_catalog.regtype, true),
        ('posts', 'author_id', 'uuid'::pg_catalog.regtype, false),
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        (
          'user_profiles',
          'deleted_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        (
          'user_profiles',
          'banned_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        ('user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype, true),
        (
          'user_profiles',
          'ban_expires_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        )
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
        'tip checkout lifecycle column shape is incompatible: %.%',
        v_required.relation_name,
        v_required.column_name;
    END IF;
  END LOOP;

  FOR v_required_fk IN
    SELECT *
    FROM (
      VALUES
        (
          'tips_post_id_fkey',
          'post_id',
          'public.posts'::pg_catalog.regclass,
          'id',
          'n'::"char"
        ),
        (
          'tips_from_user_id_fkey',
          'from_user_id',
          'auth.users'::pg_catalog.regclass,
          'id',
          'c'::"char"
        ),
        (
          'tips_to_user_id_fkey',
          'to_user_id',
          'auth.users'::pg_catalog.regclass,
          'id',
          'n'::"char"
        )
    ) AS required_fk(
      constraint_name,
      source_column,
      target_relation,
      target_column,
      delete_action
    )
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = 'public.tips'::pg_catalog.regclass
        AND constraint_row.conname = v_required_fk.constraint_name
        AND constraint_row.contype = 'f'
        AND constraint_row.convalidated
        AND constraint_row.confrelid = v_required_fk.target_relation
        AND constraint_row.confdeltype = v_required_fk.delete_action
        AND pg_catalog.cardinality(constraint_row.conkey) = 1
        AND pg_catalog.cardinality(constraint_row.confkey) = 1
        AND constraint_row.conkey[1] = (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.tips'::pg_catalog.regclass
            AND attribute.attname = v_required_fk.source_column
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
        AND constraint_row.confkey[1] = (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = v_required_fk.target_relation
            AND attribute.attname = v_required_fk.target_column
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
    ) THEN
      RAISE EXCEPTION
        'Tip checkout lifecycle parent FK is incompatible: %',
        v_required_fk.constraint_name;
    END IF;
  END LOOP;

  IF v_audience IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_audience
      AND function_row.proowner = v_postgres
      AND function_row.prorettype = 'boolean'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
      AND pg_catalog.strpos(function_row.prosrc, 'public.posts') > 0
      AND pg_catalog.strpos(function_row.prosrc, 'p_post_id') > 0
  ) THEN
    RAISE EXCEPTION
      'canonical post audience helper is missing or incompatible';
  END IF;

  IF v_interaction_lock IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_interaction_lock
      AND function_row.proowner = v_postgres
      AND function_row.prorettype = 'boolean'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
      AND pg_catalog.strpos(
        function_row.prosrc,
        'public.lock_post_interaction_block_edges'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'public.lock_actor_can_interact_with_post_locked_impl'
      ) > pg_catalog.strpos(
        function_row.prosrc,
        'public.lock_post_interaction_block_edges'
      )
  ) THEN
    RAISE EXCEPTION
      'canonical post interaction lock is missing or incompatible';
  END IF;

  IF v_authority_lock IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_authority_lock
      AND function_row.proowner = v_postgres
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) THEN
    RAISE EXCEPTION
      'durable tip authority lock is missing or incompatible';
  END IF;

  IF v_manual_review IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_manual_review
      AND function_row.proowner = v_postgres
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) THEN
    RAISE EXCEPTION
      'durable Stripe manual-review recorder is missing or incompatible';
  END IF;

  IF pg_catalog.to_regclass(
      'public.tips_stripe_checkout_session_unique'
    ) IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_row
      WHERE index_row.indexrelid =
          'public.tips_stripe_checkout_session_unique'::pg_catalog.regclass
        AND index_row.indrelid = 'public.tips'::pg_catalog.regclass
        AND index_row.indisunique
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indnkeyatts = 1
        AND index_row.indnatts = 1
        AND index_row.indexprs IS NULL
        AND index_row.indkey[0] = (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.tips'::pg_catalog.regclass
            AND attribute.attname = 'stripe_checkout_session_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
        AND index_row.indpred IS NOT NULL
        AND pg_catalog.pg_get_expr(
          index_row.indpred,
          index_row.indrelid
        ) = '(stripe_checkout_session_id IS NOT NULL)'
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      JOIN pg_catalog.pg_proc AS function_row
        ON function_row.oid = trigger_row.tgfoid
      WHERE trigger_row.tgrelid = 'public.tips'::pg_catalog.regclass
        AND trigger_row.tgname = 'trg_tips_payment_identity_immutable'
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgenabled = 'O'
        AND trigger_row.tgtype = 19
        AND trigger_row.tgattr = ''::pg_catalog.int2vector
        AND trigger_row.tgqual IS NULL
        AND trigger_row.tgconstraint = 0
        AND NOT trigger_row.tgdeferrable
        AND NOT trigger_row.tginitdeferred
        AND trigger_row.tgnargs = 0
        AND pg_catalog.octet_length(trigger_row.tgargs) = 0
        AND function_row.proname = 'prevent_tip_payment_identity_mutation'
        AND function_row.proowner = v_postgres
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp'
        ]::text[]
        AND pg_catalog.strpos(
          function_row.prosrc,
          'pg_catalog.pg_advisory_xact_lock'
        ) > 0
        AND pg_catalog.strpos(
          function_row.prosrc,
          'public.stripe_payment_ownerships'
        ) > 0
        AND pg_catalog.strpos(
          function_row.prosrc,
          'public.stripe_entitlement_payments'
        ) > 0
        AND pg_catalog.strpos(
          function_row.prosrc,
          'public.group_payment_consumptions'
        ) > 0
        AND pg_catalog.strpos(function_row.prosrc, 'public.tips') > 0
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = 'public.tips'::pg_catalog.regclass
        AND constraint_row.conname = 'tips_status_check'
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND pg_catalog.regexp_replace(
          pg_catalog.pg_get_constraintdef(constraint_row.oid),
          '\s+',
          '',
          'g'
        ) =
          'CHECK((status=ANY(ARRAY[''pending''::text,''completed''::text,''failed''::text,''refunded''::text,''identity_conflict''::text])))'
    )
  THEN
    RAISE EXCEPTION
      'Tip payment identity trigger, status, or Session uniqueness is incompatible';
  END IF;

  IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
        AND function_row.proname IN (
          'reserve_tip_checkout_atomic',
          'bind_tip_checkout_session_atomic',
          'expire_pending_tip_checkout_atomic',
          'enforce_tip_checkout_lifecycle'
        )
    )
    OR pg_catalog.to_regclass(
      'public.tips_pending_checkout_reservation_unique'
    ) IS NOT NULL
    OR pg_catalog.to_regclass(
      'public.tips_checkout_failure_event_unique'
    ) IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.tips'::pg_catalog.regclass
        AND attribute.attname IN (
          'checkout_expires_at',
          'checkout_failed_at',
          'checkout_failure_reason',
          'checkout_failure_event_id',
          'checkout_failure_event_created_at',
          'checkout_post_id',
          'checkout_to_user_id'
        )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  THEN
    RAISE EXCEPTION
      'tip checkout lifecycle migration was partially applied';
  END IF;
END
$required_objects$;

-- Serialize the duplicate-history preflight with both legacy direct inserts
-- and the new reservation RPC. Production currently has no Tip rows, but a
-- drifted environment must be classified rather than silently deduplicated.
LOCK TABLE public.tips IN ACCESS EXCLUSIVE MODE;

DO $historical_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.tips AS tip
    WHERE tip.status = 'pending'
    GROUP BY tip.from_user_id, tip.post_id, tip.amount_cents
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION
      'duplicate pending Tip checkout reservations require explicit review';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.tips AS tip
    WHERE tip.status = 'pending'
  ) THEN
    RAISE EXCEPTION
      'legacy pending Tip checkout reservations require explicit review';
  END IF;
END
$historical_preflight$;

ALTER TABLE public.tips
  ADD COLUMN checkout_expires_at timestamptz,
  ADD COLUMN checkout_failed_at timestamptz,
  ADD COLUMN checkout_failure_reason text,
  ADD COLUMN checkout_failure_event_id text,
  ADD COLUMN checkout_failure_event_created_at timestamptz,
  ADD COLUMN checkout_post_id uuid,
  ADD COLUMN checkout_to_user_id uuid;

ALTER TABLE public.tips
  ADD CONSTRAINT tips_checkout_lifecycle_shape
    CHECK (
      (
        -- Compatibility-only state for a row written before this RPC cutover.
        -- New RPCs never create or adopt this shape.
        checkout_expires_at IS NULL
        AND checkout_failed_at IS NULL
        AND checkout_failure_reason IS NULL
        AND checkout_failure_event_id IS NULL
        AND checkout_failure_event_created_at IS NULL
        AND (
          (
            checkout_post_id IS NULL
            AND checkout_to_user_id IS NULL
          )
          OR (
            checkout_post_id IS NOT NULL
            AND checkout_to_user_id IS NOT NULL
            AND (
              post_id IS NULL
              OR post_id IS NOT DISTINCT FROM checkout_post_id
            )
            AND (
              to_user_id IS NULL
              OR to_user_id IS NOT DISTINCT FROM checkout_to_user_id
            )
          )
        )
      )
      OR (
        checkout_expires_at IS NOT NULL
        AND checkout_post_id IS NOT NULL
        AND checkout_to_user_id IS NOT NULL
        AND (
          post_id IS NULL
          OR post_id IS NOT DISTINCT FROM checkout_post_id
        )
        AND (
          to_user_id IS NULL
          OR to_user_id IS NOT DISTINCT FROM checkout_to_user_id
        )
        AND checkout_expires_at =
          pg_catalog.date_trunc('second', checkout_expires_at)
        AND checkout_expires_at > created_at
        AND (
          (
            status = 'pending'
            AND checkout_failed_at IS NULL
            AND checkout_failure_reason IS NULL
            AND checkout_failure_event_id IS NULL
            AND checkout_failure_event_created_at IS NULL
            AND stripe_payment_intent_id IS NULL
            AND stripe_charge_id IS NULL
            AND stripe_customer_id IS NULL
            AND currency IS NULL
            AND completed_at IS NULL
          )
          OR (
            status = 'failed'
            AND stripe_checkout_session_id IS NOT NULL
            AND stripe_payment_intent_id IS NULL
            AND stripe_charge_id IS NULL
            AND stripe_customer_id IS NULL
            AND currency IS NULL
            AND completed_at IS NULL
            AND checkout_failed_at IS NOT NULL
            AND checkout_failed_at =
              pg_catalog.date_trunc('second', checkout_failed_at)
            AND checkout_failed_at >= created_at - interval '5 minutes'
            AND checkout_failure_reason IS NOT NULL
            AND checkout_failure_reason = 'checkout_session_expired'
            AND checkout_failure_event_id IS NOT NULL
            AND pg_catalog.length(checkout_failure_event_id)
              BETWEEN 5 AND 255
            AND checkout_failure_event_id ~ '^evt_[A-Za-z0-9_]+$'
            AND checkout_failure_event_created_at IS NOT NULL
            AND checkout_failure_event_created_at =
              pg_catalog.date_trunc(
                'second',
                checkout_failure_event_created_at
              )
            AND checkout_failure_event_created_at >=
              created_at - interval '5 minutes'
            AND checkout_failure_event_created_at <=
              checkout_failed_at + interval '5 minutes'
          )
          OR (
            status IN ('completed', 'refunded', 'identity_conflict')
            AND checkout_failed_at IS NULL
            AND checkout_failure_reason IS NULL
            AND checkout_failure_event_id IS NULL
            AND checkout_failure_event_created_at IS NULL
          )
        )
      )
    );

CREATE UNIQUE INDEX tips_pending_checkout_reservation_unique
  ON public.tips (from_user_id, checkout_post_id, amount_cents)
  WHERE status = 'pending';

CREATE UNIQUE INDEX tips_checkout_failure_event_unique
  ON public.tips (checkout_failure_event_id)
  WHERE checkout_failure_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.enforce_tip_checkout_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.checkout_post_id IS NULL
      AND NEW.checkout_to_user_id IS NULL
      AND NEW.post_id IS NOT NULL
      AND NEW.to_user_id IS NOT NULL
    THEN
      -- Mixed-deploy legacy inserts still receive immutable non-FK identity,
      -- so parent SET NULL can never release or rewrite the payment tuple.
      NEW.checkout_post_id := NEW.post_id;
      NEW.checkout_to_user_id := NEW.to_user_id;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.from_user_id IS DISTINCT FROM OLD.from_user_id
    OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
    OR NEW.message IS DISTINCT FROM OLD.message
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.checkout_post_id IS DISTINCT FROM OLD.checkout_post_id
    OR NEW.checkout_to_user_id IS DISTINCT FROM OLD.checkout_to_user_id
    OR NOT (
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
    OR NOT (
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
  THEN
    RAISE EXCEPTION 'Tip reservation core identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  -- Expiry is reservation identity, not mutable wall-clock state.
  IF NEW.checkout_expires_at IS DISTINCT FROM OLD.checkout_expires_at THEN
    RAISE EXCEPTION 'Tip checkout expiry is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.stripe_checkout_session_id
      IS DISTINCT FROM OLD.stripe_checkout_session_id
    AND NOT (
      COALESCE((SELECT auth.role()), '') = 'service_role'
      AND OLD.status = 'pending'
      AND NEW.status IN ('pending', 'failed')
      AND OLD.stripe_checkout_session_id IS NULL
      AND NEW.stripe_checkout_session_id IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'Tip Checkout Session binding is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF (
      NEW.checkout_failed_at,
      NEW.checkout_failure_reason,
      NEW.checkout_failure_event_id,
      NEW.checkout_failure_event_created_at
    ) IS DISTINCT FROM (
      OLD.checkout_failed_at,
      OLD.checkout_failure_reason,
      OLD.checkout_failure_event_id,
      OLD.checkout_failure_event_created_at
    )
    AND NOT (
      COALESCE((SELECT auth.role()), '') = 'service_role'
      AND OLD.status = 'pending'
      AND NEW.status = 'failed'
      AND OLD.checkout_failed_at IS NULL
      AND OLD.checkout_failure_reason IS NULL
      AND OLD.checkout_failure_event_id IS NULL
      AND OLD.checkout_failure_event_created_at IS NULL
    )
  THEN
    RAISE EXCEPTION 'Tip checkout failure provenance is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.status IN (
      'completed',
      'failed',
      'refunded',
      'identity_conflict'
    )
    AND (
      NEW.checkout_expires_at IS DISTINCT FROM OLD.checkout_expires_at
      OR NEW.checkout_failed_at IS DISTINCT FROM OLD.checkout_failed_at
      OR NEW.checkout_failure_reason
        IS DISTINCT FROM OLD.checkout_failure_reason
      OR NEW.checkout_failure_event_id
        IS DISTINCT FROM OLD.checkout_failure_event_id
      OR NEW.checkout_failure_event_created_at
        IS DISTINCT FROM OLD.checkout_failure_event_created_at
    )
  THEN
    RAISE EXCEPTION 'terminal Tip checkout lifecycle is immutable'
      USING ERRCODE = '23514';
  END IF;

  -- The older payment trigger already freezes completed/refunded/conflict
  -- identity. Close its historical gap for the newly terminal failed state.
  IF OLD.status = 'failed'
    AND (
      NEW.id IS DISTINCT FROM OLD.id
      OR NOT (
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
      OR NEW.from_user_id IS DISTINCT FROM OLD.from_user_id
      OR NOT (
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
      OR NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
      OR NEW.message IS DISTINCT FROM OLD.message
      OR NEW.stripe_checkout_session_id
        IS DISTINCT FROM OLD.stripe_checkout_session_id
      OR NEW.stripe_payment_intent_id
        IS DISTINCT FROM OLD.stripe_payment_intent_id
      OR NEW.stripe_charge_id IS DISTINCT FROM OLD.stripe_charge_id
      OR NEW.stripe_customer_id IS DISTINCT FROM OLD.stripe_customer_id
      OR NEW.currency IS DISTINCT FROM OLD.currency
      OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    )
  THEN
    RAISE EXCEPTION 'failed Tip checkout identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_tip_checkout_lifecycle() OWNER TO postgres;

CREATE TRIGGER trg_tips_checkout_lifecycle
  BEFORE INSERT OR UPDATE ON public.tips
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_tip_checkout_lifecycle();

CREATE OR REPLACE FUNCTION public.reserve_tip_checkout_atomic(
  p_from_user_id uuid,
  p_post_id uuid,
  p_amount_cents bigint,
  p_message text,
  p_checkout_ttl_seconds integer DEFAULT 3600
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.date_trunc(
    'second',
    pg_catalog.clock_timestamp()
  );
  v_checkout_expires_at timestamptz;
  v_recipient_id uuid;
  v_locked_author_id uuid;
  v_tip public.tips%ROWTYPE;
  v_tip_id uuid;
  v_profile record;
  v_payer_active boolean := false;
  v_recipient_active boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_from_user_id IS NULL
    OR p_post_id IS NULL
    OR p_amount_cents IS NULL
    OR p_amount_cents < 100
    OR p_amount_cents > 50000
    OR p_checkout_ttl_seconds IS NULL
    OR p_checkout_ttl_seconds < 3600
    OR p_checkout_ttl_seconds > 86400
    OR pg_catalog.char_length(COALESCE(p_message, '')) > 200
  THEN
    RAISE EXCEPTION 'Tip checkout reservation input is invalid'
      USING ERRCODE = '22023';
  END IF;

  v_checkout_expires_at := v_now
    + pg_catalog.make_interval(secs => p_checkout_ttl_seconds);

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'tip-checkout-reservation:'
        || p_from_user_id::text
        || ':' || p_post_id::text
        || ':' || p_amount_cents::text,
      0
    )
  );

  -- Snapshot only to establish the parent set. Every decision is repeated
  -- after auth/profile/post locks and before the Tip row lock.
  SELECT post.author_id
  INTO v_recipient_id
  FROM public.posts AS post
  WHERE post.id = p_post_id;
  IF NOT FOUND OR NOT public.can_actor_read_post_id(
    p_post_id,
    p_from_user_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_recipient_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'recipient_unavailable');
  END IF;
  IF v_recipient_id = p_from_user_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'self_tip');
  END IF;

  PERFORM user_row.id
  FROM auth.users AS user_row
  WHERE user_row.id IN (p_from_user_id, v_recipient_id)
  ORDER BY user_row.id
  FOR KEY SHARE;
  IF NOT EXISTS (
    SELECT 1 FROM auth.users AS payer
    WHERE payer.id = p_from_user_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth.users AS recipient
    WHERE recipient.id = v_recipient_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'recipient_unavailable');
  END IF;

  FOR v_profile IN
    SELECT
      profile.id,
      (
        profile.deleted_at IS NULL
        AND profile.banned_at IS NULL
        AND NOT (
          profile.is_banned
          AND (
            profile.ban_expires_at IS NULL
            OR profile.ban_expires_at > pg_catalog.statement_timestamp()
          )
        )
      ) AS is_active
    FROM public.user_profiles AS profile
    WHERE profile.id IN (p_from_user_id, v_recipient_id)
    ORDER BY profile.id
    FOR SHARE
  LOOP
    IF v_profile.id = p_from_user_id THEN
      v_payer_active := v_profile.is_active;
    ELSIF v_profile.id = v_recipient_id THEN
      v_recipient_active := v_profile.is_active;
    END IF;
  END LOOP;
  IF NOT v_payer_active THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF NOT v_recipient_active THEN
    RETURN pg_catalog.jsonb_build_object('status', 'recipient_unavailable');
  END IF;

  -- This is the canonical write-authority primitive. Besides repeating the
  -- audience decision, it linearizes wrapper/root, block, follow, membership,
  -- group-ban, and current group-entitlement state with this reservation.
  IF NOT public.lock_actor_can_interact_with_post(
    p_post_id,
    p_from_user_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT post.author_id
  INTO v_locked_author_id
  FROM public.posts AS post
  WHERE post.id = p_post_id
  FOR SHARE;
  IF NOT FOUND
    OR v_locked_author_id IS DISTINCT FROM v_recipient_id
    OR NOT public.can_actor_read_post_id(p_post_id, p_from_user_id)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Recheck both active profiles while their SHARE locks are still held. The
  -- explicit state check is required because read audience intentionally
  -- degrades an inactive viewer to anonymous for public posts.
  IF EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.id = p_from_user_id
      AND (
        profile.deleted_at IS NOT NULL
        OR profile.banned_at IS NOT NULL
        OR (
          profile.is_banned
          AND (
            profile.ban_expires_at IS NULL
            OR profile.ban_expires_at > pg_catalog.statement_timestamp()
          )
        )
      )
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.id = v_recipient_id
      AND (
        profile.deleted_at IS NOT NULL
        OR profile.banned_at IS NOT NULL
        OR (
          profile.is_banned
          AND (
            profile.ban_expires_at IS NULL
            OR profile.ban_expires_at > pg_catalog.statement_timestamp()
          )
        )
      )
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'recipient_unavailable');
  END IF;

  SELECT tip.*
  INTO v_tip
  FROM public.tips AS tip
  WHERE tip.from_user_id = p_from_user_id
    AND tip.checkout_post_id = p_post_id
    AND tip.amount_cents = p_amount_cents::integer
    AND tip.status = 'pending'
  FOR UPDATE;

  IF FOUND THEN
    IF v_tip.checkout_to_user_id IS DISTINCT FROM v_recipient_id THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'tip_checkout_reservation',
        v_tip.id::text,
        v_tip.from_user_id,
        'tip_checkout_reservation_recipient_drift',
        'A pending Tip reservation conflicts with current post authority.',
        pg_catalog.jsonb_build_object(
          'tip_id', v_tip.id,
          'checkout_post_id', v_tip.checkout_post_id,
          'checkout_to_user_id', v_tip.checkout_to_user_id,
          'current_to_user_id', v_recipient_id
        )
      );
      RETURN pg_catalog.jsonb_build_object(
        'status', 'not_found',
        'tip_id', v_tip.id
      );
    END IF;
    IF v_tip.checkout_expires_at IS NULL THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'tip_checkout_reservation',
        v_tip.id::text,
        v_tip.from_user_id,
        'tip_checkout_legacy_pending',
        'A mixed-deploy pending Tip lacks durable checkout expiry identity.',
        pg_catalog.jsonb_build_object(
          'tip_id', v_tip.id,
          'checkout_post_id', v_tip.checkout_post_id,
          'checkout_to_user_id', v_tip.checkout_to_user_id,
          'amount_cents', v_tip.amount_cents
        )
      );
      RETURN pg_catalog.jsonb_build_object(
        'status', 'not_found',
        'tip_id', v_tip.id
      );
    END IF;

    -- Even a long-expired unbound row may have a successfully created Stripe
    -- Session whose bind response was lost. DB time is never authority to
    -- release the tuple; only the exact signed expiry RPC may terminate it.
    RETURN pg_catalog.jsonb_build_object(
      'status',
        CASE
          WHEN v_tip.stripe_checkout_session_id IS NOT NULL
            THEN 'already_bound'
          WHEN v_tip.checkout_expires_at - v_now
              <= pg_catalog.make_interval(mins => 35)
            THEN 'reservation_expiring'
          ELSE 'reservation_exists'
        END,
      'tip_id', v_tip.id,
      'checkout_session_id', v_tip.stripe_checkout_session_id,
      'checkout_expires_at', v_tip.checkout_expires_at,
      'post_id', v_tip.checkout_post_id,
      'to_user_id', v_tip.checkout_to_user_id
    );
  END IF;

  v_tip_id := pg_catalog.gen_random_uuid();
  INSERT INTO public.tips (
    id,
    post_id,
    from_user_id,
    to_user_id,
    checkout_post_id,
    checkout_to_user_id,
    amount_cents,
    message,
    status,
    checkout_expires_at,
    created_at,
    updated_at
  ) VALUES (
    v_tip_id,
    p_post_id,
    p_from_user_id,
    v_recipient_id,
    p_post_id,
    v_recipient_id,
    p_amount_cents::integer,
    NULLIF(pg_catalog.btrim(p_message), ''),
    'pending',
    v_checkout_expires_at,
    v_now,
    v_now
  )
  ON CONFLICT (from_user_id, checkout_post_id, amount_cents)
    WHERE status = 'pending'
  DO NOTHING
  RETURNING id INTO v_tip_id;

  IF NOT FOUND THEN
    -- A mixed-deploy legacy writer does not own the tuple advisory. The unique
    -- index is therefore the final arbiter; converge on its winner instead of
    -- leaking a 23505 or creating a second Stripe Session.
    SELECT tip.*
    INTO v_tip
    FROM public.tips AS tip
    WHERE tip.from_user_id = p_from_user_id
      AND tip.checkout_post_id = p_post_id
      AND tip.amount_cents = p_amount_cents::integer
      AND tip.status = 'pending'
    FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Tip reservation conflict winner is missing'
        USING ERRCODE = '40001';
    END IF;
    IF v_tip.checkout_to_user_id IS DISTINCT FROM v_recipient_id
      OR v_tip.checkout_expires_at IS NULL
    THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'tip_checkout_reservation',
        v_tip.id::text,
        v_tip.from_user_id,
        CASE
          WHEN v_tip.checkout_expires_at IS NULL
            THEN 'tip_checkout_legacy_pending'
          ELSE 'tip_checkout_reservation_recipient_drift'
        END,
        'A conflicting pending Tip reservation requires manual review.',
        pg_catalog.jsonb_build_object(
          'tip_id', v_tip.id,
          'checkout_post_id', v_tip.checkout_post_id,
          'checkout_to_user_id', v_tip.checkout_to_user_id,
          'current_to_user_id', v_recipient_id,
          'amount_cents', v_tip.amount_cents
        )
      );
      RETURN pg_catalog.jsonb_build_object(
        'status', 'not_found',
        'tip_id', v_tip.id
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status',
        CASE
          WHEN v_tip.stripe_checkout_session_id IS NOT NULL
            THEN 'already_bound'
          WHEN v_tip.checkout_expires_at - v_now
              <= pg_catalog.make_interval(mins => 35)
            THEN 'reservation_expiring'
          ELSE 'reservation_exists'
        END,
      'tip_id', v_tip.id,
      'checkout_session_id', v_tip.stripe_checkout_session_id,
      'checkout_expires_at', v_tip.checkout_expires_at,
      'post_id', v_tip.checkout_post_id,
      'to_user_id', v_tip.checkout_to_user_id
    );
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'reserved',
    'tip_id', v_tip_id,
    'post_id', p_post_id,
    'to_user_id', v_recipient_id,
    'checkout_expires_at', v_checkout_expires_at
  );
END
$function$;

ALTER FUNCTION public.reserve_tip_checkout_atomic(
  uuid, uuid, bigint, text, integer
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.bind_tip_checkout_session_atomic(
  p_tip_id uuid,
  p_from_user_id uuid,
  p_checkout_session_id text,
  p_checkout_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_snapshot public.tips%ROWTYPE;
  v_tip public.tips%ROWTYPE;
  v_normalized_expires_at timestamptz;
  v_profile record;
  v_payer_active boolean := false;
  v_recipient_active boolean := false;
  v_locked_author_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_tip_id IS NULL
    OR p_from_user_id IS NULL
    OR pg_catalog.length(COALESCE(p_checkout_session_id, ''))
      NOT BETWEEN 4 AND 255
    OR COALESCE(p_checkout_session_id, '') !~ '^cs_[A-Za-z0-9_]+$'
    OR p_checkout_expires_at IS NULL
    OR p_checkout_expires_at IS DISTINCT FROM
      pg_catalog.date_trunc('second', p_checkout_expires_at)
  THEN
    RAISE EXCEPTION 'Tip Checkout Session binding input is invalid'
      USING ERRCODE = '22023';
  END IF;
  -- Stripe expiry is an integer Unix second. Reject, rather than silently
  -- normalize, any caller identity with finer precision.
  v_normalized_expires_at := pg_catalog.date_trunc(
    'second',
    p_checkout_expires_at
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-checkout-session:' || p_checkout_session_id,
      0
    )
  );

  -- Snapshot without a row lock only to establish the authority parent set.
  -- The Session advisory is already held, but no Tip lock may precede the
  -- auth/profile/post/group authority locks below.
  SELECT tip.*
  INTO v_snapshot
  FROM public.tips AS tip
  WHERE tip.id = p_tip_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_snapshot.from_user_id IS DISTINCT FROM p_from_user_id
    OR v_snapshot.checkout_post_id IS NULL
    OR v_snapshot.checkout_to_user_id IS NULL
    OR v_snapshot.checkout_expires_at IS NULL
    OR v_snapshot.checkout_expires_at IS DISTINCT FROM
      v_normalized_expires_at
    OR (
      v_snapshot.stripe_checkout_session_id IS NOT NULL
      AND v_snapshot.stripe_checkout_session_id <> p_checkout_session_id
    )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict',
      'tip_id', v_snapshot.id
    );
  END IF;
  IF v_snapshot.status <> 'pending' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'terminal',
      'tip_id', v_snapshot.id,
      'tip_status', v_snapshot.status,
      'checkout_session_id', v_snapshot.stripe_checkout_session_id,
      'checkout_expires_at', v_snapshot.checkout_expires_at
    );
  END IF;
  IF v_snapshot.post_id IS DISTINCT FROM v_snapshot.checkout_post_id
    OR v_snapshot.to_user_id IS DISTINCT FROM
      v_snapshot.checkout_to_user_id
    OR v_snapshot.from_user_id = v_snapshot.checkout_to_user_id
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'not_found',
      'tip_id', v_snapshot.id
    );
  END IF;

  PERFORM user_row.id
  FROM auth.users AS user_row
  WHERE user_row.id IN (
    v_snapshot.from_user_id,
    v_snapshot.checkout_to_user_id
  )
  ORDER BY user_row.id
  FOR KEY SHARE;
  IF NOT EXISTS (
      SELECT 1 FROM auth.users AS payer
      WHERE payer.id = v_snapshot.from_user_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM auth.users AS recipient
      WHERE recipient.id = v_snapshot.checkout_to_user_id
    )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'not_found',
      'tip_id', v_snapshot.id
    );
  END IF;

  FOR v_profile IN
    SELECT
      profile.id,
      (
        profile.deleted_at IS NULL
        AND profile.banned_at IS NULL
        AND NOT (
          profile.is_banned
          AND (
            profile.ban_expires_at IS NULL
            OR profile.ban_expires_at > pg_catalog.statement_timestamp()
          )
        )
      ) AS is_active
    FROM public.user_profiles AS profile
    WHERE profile.id IN (
      v_snapshot.from_user_id,
      v_snapshot.checkout_to_user_id
    )
    ORDER BY profile.id
    FOR SHARE
  LOOP
    IF v_profile.id = v_snapshot.from_user_id THEN
      v_payer_active := v_profile.is_active;
    ELSIF v_profile.id = v_snapshot.checkout_to_user_id THEN
      v_recipient_active := v_profile.is_active;
    END IF;
  END LOOP;
  IF NOT v_payer_active OR NOT v_recipient_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'not_found',
      'tip_id', v_snapshot.id
    );
  END IF;

  IF NOT public.lock_actor_can_interact_with_post(
    v_snapshot.checkout_post_id,
    v_snapshot.from_user_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'not_found',
      'tip_id', v_snapshot.id
    );
  END IF;
  SELECT post.author_id
  INTO v_locked_author_id
  FROM public.posts AS post
  WHERE post.id = v_snapshot.checkout_post_id
  FOR SHARE;
  IF NOT FOUND
    OR v_locked_author_id IS DISTINCT FROM v_snapshot.checkout_to_user_id
    OR NOT public.can_actor_read_post_id(
      v_snapshot.checkout_post_id,
      v_snapshot.from_user_id
    )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'not_found',
      'tip_id', v_snapshot.id
    );
  END IF;

  PERFORM public.lock_tip_notification_authority_atomic(p_tip_id);
  SELECT tip.*
  INTO v_tip
  FROM public.tips AS tip
  WHERE tip.id = p_tip_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_tip.from_user_id IS DISTINCT FROM p_from_user_id
    OR v_tip.checkout_post_id IS DISTINCT FROM v_snapshot.checkout_post_id
    OR v_tip.checkout_to_user_id IS DISTINCT FROM
      v_snapshot.checkout_to_user_id
    OR v_tip.post_id IS DISTINCT FROM v_tip.checkout_post_id
    OR v_tip.to_user_id IS DISTINCT FROM v_tip.checkout_to_user_id
    OR v_tip.checkout_expires_at IS DISTINCT FROM
      v_normalized_expires_at
    OR (
      v_tip.stripe_checkout_session_id IS NOT NULL
      AND v_tip.stripe_checkout_session_id <> p_checkout_session_id
    )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict',
      'tip_id', v_tip.id
    );
  END IF;
  IF v_tip.status <> 'pending' THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'terminal',
      'tip_id', v_tip.id,
      'tip_status', v_tip.status,
      'checkout_session_id', v_tip.stripe_checkout_session_id,
      'checkout_expires_at', v_tip.checkout_expires_at,
      'post_id', v_tip.checkout_post_id,
      'to_user_id', v_tip.checkout_to_user_id
    );
  END IF;
  IF v_tip.stripe_checkout_session_id = p_checkout_session_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_bound',
      'tip_id', v_tip.id,
      'checkout_session_id', v_tip.stripe_checkout_session_id,
      'checkout_expires_at', v_tip.checkout_expires_at,
      'post_id', v_tip.checkout_post_id,
      'to_user_id', v_tip.checkout_to_user_id
    );
  END IF;
  IF v_tip.checkout_expires_at <= pg_catalog.clock_timestamp() THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'reservation_expired',
      'tip_id', v_tip.id,
      'checkout_expires_at', v_tip.checkout_expires_at
    );
  END IF;

  IF EXISTS (
      SELECT 1
      FROM public.stripe_payment_ownerships AS ownership
      WHERE ownership.checkout_session_id = p_checkout_session_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      WHERE payment.checkout_session_id = p_checkout_session_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.group_payment_consumptions AS consumption
      WHERE consumption.checkout_session_id = p_checkout_session_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.tips AS other_tip
      WHERE other_tip.stripe_checkout_session_id = p_checkout_session_id
        AND other_tip.id <> v_tip.id
    )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict',
      'tip_id', v_tip.id
    );
  END IF;

  UPDATE public.tips AS tip
  SET stripe_checkout_session_id = p_checkout_session_id,
      updated_at = pg_catalog.clock_timestamp()
  WHERE tip.id = v_tip.id
    AND tip.from_user_id = p_from_user_id
    AND tip.status = 'pending'
    AND tip.stripe_checkout_session_id IS NULL
    AND tip.checkout_expires_at = v_normalized_expires_at;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Tip Checkout Session binding CAS did not converge'
      USING ERRCODE = '40001';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'bound',
    'tip_id', v_tip.id,
    'checkout_session_id', p_checkout_session_id,
    'checkout_expires_at', v_tip.checkout_expires_at,
    'post_id', v_tip.checkout_post_id,
    'to_user_id', v_tip.checkout_to_user_id
  );
END
$function$;

ALTER FUNCTION public.bind_tip_checkout_session_atomic(
  uuid, uuid, text, timestamptz
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.expire_pending_tip_checkout_atomic(
  p_tip_id uuid,
  p_from_user_id uuid,
  p_post_id uuid,
  p_to_user_id uuid,
  p_amount_cents bigint,
  p_checkout_session_id text,
  p_checkout_expires_at timestamptz,
  p_event_id text,
  p_event_created_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_tip public.tips%ROWTYPE;
  v_normalized_expires_at timestamptz;
  v_normalized_event_created_at timestamptz;
  v_failed_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_tip_id IS NULL
    OR p_from_user_id IS NULL
    OR p_post_id IS NULL
    OR p_to_user_id IS NULL
    OR p_amount_cents IS NULL
    OR p_amount_cents < 100
    OR p_amount_cents > 50000
    OR pg_catalog.length(COALESCE(p_checkout_session_id, ''))
      NOT BETWEEN 4 AND 255
    OR COALESCE(p_checkout_session_id, '') !~ '^cs_[A-Za-z0-9_]+$'
    OR p_checkout_expires_at IS NULL
    OR p_checkout_expires_at IS DISTINCT FROM
      pg_catalog.date_trunc('second', p_checkout_expires_at)
    OR pg_catalog.length(COALESCE(p_event_id, ''))
      NOT BETWEEN 5 AND 255
    OR COALESCE(p_event_id, '') !~ '^evt_[A-Za-z0-9_]+$'
    OR p_event_created_at IS NULL
    OR p_event_created_at IS DISTINCT FROM
      pg_catalog.date_trunc('second', p_event_created_at)
  THEN
    RAISE EXCEPTION 'Tip Checkout expiry input is invalid'
      USING ERRCODE = '22023';
  END IF;
  v_normalized_expires_at := pg_catalog.date_trunc(
    'second',
    p_checkout_expires_at
  );
  v_normalized_event_created_at := pg_catalog.date_trunc(
    'second',
    p_event_created_at
  );
  v_failed_at := pg_catalog.date_trunc(
    'second',
    pg_catalog.clock_timestamp()
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-checkout-session:' || p_checkout_session_id,
      0
    )
  );
  PERFORM public.lock_tip_notification_authority_atomic(p_tip_id);

  SELECT tip.*
  INTO v_tip
  FROM public.tips AS tip
  WHERE tip.id = p_tip_id
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'tip_checkout_expiry',
      p_event_id,
      NULL::uuid,
      'tip_checkout_expiry_subject_missing',
      'A signed Checkout expiry event references a missing Tip reservation.',
      pg_catalog.jsonb_build_object(
        'tip_id', p_tip_id,
        'from_user_id', p_from_user_id,
        'post_id', p_post_id,
        'to_user_id', p_to_user_id,
        'amount_cents', p_amount_cents,
        'checkout_session_id', p_checkout_session_id,
        'checkout_expires_at', v_normalized_expires_at,
        'event_created_at', v_normalized_event_created_at
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'not_found',
      'tip_id', p_tip_id
    );
  END IF;

  IF v_tip.from_user_id IS DISTINCT FROM p_from_user_id
    OR v_tip.amount_cents::bigint IS DISTINCT FROM p_amount_cents
    OR v_tip.checkout_post_id IS NULL
    OR v_tip.checkout_post_id IS DISTINCT FROM p_post_id
    OR v_tip.checkout_to_user_id IS NULL
    OR v_tip.checkout_to_user_id IS DISTINCT FROM p_to_user_id
    OR v_tip.checkout_expires_at IS NULL
    OR v_tip.checkout_expires_at IS DISTINCT FROM v_normalized_expires_at
    OR (
      v_tip.stripe_checkout_session_id IS NOT NULL
      AND v_tip.stripe_checkout_session_id <> p_checkout_session_id
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'tip_checkout_expiry',
      p_event_id,
      v_tip.from_user_id,
      'tip_checkout_expiry_identity_conflict',
      'A signed Checkout expiry event conflicts with Tip reservation identity.',
      pg_catalog.jsonb_build_object(
        'tip_id', v_tip.id,
        'tip_status', v_tip.status,
        'checkout_post_id', v_tip.checkout_post_id,
        'checkout_to_user_id', v_tip.checkout_to_user_id,
        'post_id', p_post_id,
        'to_user_id', p_to_user_id,
        'amount_cents', p_amount_cents,
        'checkout_session_id', p_checkout_session_id,
        'checkout_expires_at', v_normalized_expires_at
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict',
      'tip_id', v_tip.id
    );
  END IF;

  -- A server-side sessions.expire call may produce a signed event well before
  -- the originally scheduled expiry. Validate event time against reservation
  -- creation plus bounded Stripe/DB clock skew, not against scheduled expiry.
  IF v_normalized_event_created_at <
      v_tip.created_at - pg_catalog.make_interval(mins => 5)
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'tip_checkout_expiry',
      p_event_id,
      v_tip.from_user_id,
      'tip_checkout_expiry_event_predates_reservation',
      'A signed Checkout expiry event predates the Tip reservation identity.',
      pg_catalog.jsonb_build_object(
        'tip_id', v_tip.id,
        'tip_created_at', v_tip.created_at,
        'event_created_at', v_normalized_event_created_at,
        'checkout_session_id', p_checkout_session_id
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict',
      'tip_id', v_tip.id
    );
  END IF;
  IF v_normalized_event_created_at >
      pg_catalog.statement_timestamp() + pg_catalog.make_interval(mins => 5)
    OR v_failed_at <
      v_tip.created_at - pg_catalog.make_interval(mins => 5)
  THEN
    RAISE EXCEPTION 'Tip Checkout expiry event time is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF v_tip.status = 'failed' THEN
    IF v_tip.stripe_checkout_session_id = p_checkout_session_id
      AND v_tip.checkout_failure_reason = 'checkout_session_expired'
      AND v_tip.checkout_failure_event_id = p_event_id
      AND v_tip.checkout_failure_event_created_at =
        v_normalized_event_created_at
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'already_expired',
        'tip_id', v_tip.id,
        'checkout_session_id', v_tip.stripe_checkout_session_id,
        'checkout_expires_at', v_tip.checkout_expires_at,
        'event_id', v_tip.checkout_failure_event_id
      );
    END IF;
    PERFORM public.record_stripe_manual_review_atomic(
      'tip_checkout_expiry',
      p_event_id,
      v_tip.from_user_id,
      'tip_checkout_expiry_replay_conflict',
      'A signed Checkout expiry event conflicts with terminal expiry provenance.',
      pg_catalog.jsonb_build_object(
        'tip_id', v_tip.id,
        'checkout_session_id', p_checkout_session_id,
        'recorded_event_id', v_tip.checkout_failure_event_id,
        'recorded_event_created_at',
          v_tip.checkout_failure_event_created_at
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict',
      'tip_id', v_tip.id,
      'checkout_session_id', v_tip.stripe_checkout_session_id,
      'checkout_expires_at', v_tip.checkout_expires_at
    );
  END IF;

  IF v_tip.status IN ('completed', 'refunded', 'identity_conflict') THEN
    IF v_tip.status IN ('completed', 'refunded') THEN
      PERFORM public.record_stripe_manual_review_atomic(
        'tip_checkout',
        p_event_id,
        v_tip.from_user_id,
        'tip_checkout_expired_after_payment_terminal',
        'A signed Checkout expiry event conflicts with a paid Tip terminal state.',
        pg_catalog.jsonb_build_object(
          'tip_id', v_tip.id,
          'tip_status', v_tip.status,
          'checkout_session_id', p_checkout_session_id,
          'checkout_expires_at', v_normalized_expires_at,
          'event_id', p_event_id,
          'event_created_at', v_normalized_event_created_at
        )
      );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_terminal',
      'tip_id', v_tip.id,
      'tip_status', v_tip.status,
      'checkout_session_id', v_tip.stripe_checkout_session_id,
      'checkout_expires_at', v_tip.checkout_expires_at,
      'event_id', p_event_id
    );
  END IF;
  IF v_tip.status <> 'pending' THEN
    RAISE EXCEPTION 'Tip checkout has an unknown lifecycle status'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
      SELECT 1
      FROM public.tips AS failed_tip
      WHERE failed_tip.checkout_failure_event_id = p_event_id
        AND failed_tip.id <> v_tip.id
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_payment_ownerships AS ownership
      WHERE ownership.checkout_session_id = p_checkout_session_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.stripe_entitlement_payments AS payment
      WHERE payment.checkout_session_id = p_checkout_session_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.group_payment_consumptions AS consumption
      WHERE consumption.checkout_session_id = p_checkout_session_id
    )
    OR EXISTS (
      SELECT 1
      FROM public.tips AS other_tip
      WHERE other_tip.stripe_checkout_session_id = p_checkout_session_id
        AND other_tip.id <> v_tip.id
    )
  THEN
    PERFORM public.record_stripe_manual_review_atomic(
      'tip_checkout_expiry',
      p_event_id,
      v_tip.from_user_id,
      'tip_checkout_expiry_ownership_conflict',
      'A signed Checkout expiry event references a foreign payment identity.',
      pg_catalog.jsonb_build_object(
        'tip_id', v_tip.id,
        'checkout_session_id', p_checkout_session_id
      )
    );
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict',
      'tip_id', v_tip.id
    );
  END IF;

  BEGIN
    UPDATE public.tips AS tip
    SET status = 'failed',
        stripe_checkout_session_id = p_checkout_session_id,
        checkout_failed_at = v_failed_at,
        checkout_failure_reason = 'checkout_session_expired',
        checkout_failure_event_id = p_event_id,
        checkout_failure_event_created_at = v_normalized_event_created_at,
        updated_at = v_failed_at
    WHERE tip.id = v_tip.id
      AND tip.from_user_id = p_from_user_id
      AND tip.checkout_post_id = p_post_id
      AND tip.checkout_to_user_id = p_to_user_id
      AND tip.amount_cents::bigint = p_amount_cents
      AND tip.status = 'pending'
      AND (
        tip.stripe_checkout_session_id IS NULL
        OR tip.stripe_checkout_session_id = p_checkout_session_id
      )
      AND tip.checkout_expires_at = v_normalized_expires_at;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Tip Checkout expiry CAS did not converge'
        USING ERRCODE = '40001';
    END IF;
  EXCEPTION
    WHEN unique_violation THEN
      -- A concurrent replay of one Stripe event against another Tip must not
      -- partially fail either reservation.
      PERFORM public.record_stripe_manual_review_atomic(
        'tip_checkout_expiry',
        p_event_id,
        v_tip.from_user_id,
        'tip_checkout_expiry_event_reuse_conflict',
        'A signed Checkout expiry event identity was already consumed elsewhere.',
        pg_catalog.jsonb_build_object(
          'tip_id', v_tip.id,
          'checkout_session_id', p_checkout_session_id
        )
      );
      RETURN pg_catalog.jsonb_build_object(
        'status', 'identity_conflict',
        'tip_id', v_tip.id
      );
  END;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'expired',
    'tip_id', v_tip.id,
    'checkout_session_id', p_checkout_session_id,
    'checkout_expires_at', v_tip.checkout_expires_at,
    'event_id', p_event_id
  );
END
$function$;

ALTER FUNCTION public.expire_pending_tip_checkout_atomic(
  uuid, uuid, uuid, uuid, bigint, text, timestamptz, text, timestamptz
) OWNER TO postgres;

REVOKE ALL ON FUNCTION
  public.enforce_tip_checkout_lifecycle(),
  public.reserve_tip_checkout_atomic(uuid, uuid, bigint, text, integer),
  public.bind_tip_checkout_session_atomic(uuid, uuid, text, timestamptz),
  public.expire_pending_tip_checkout_atomic(
    uuid, uuid, uuid, uuid, bigint, text, timestamptz, text, timestamptz
  )
FROM PUBLIC, anon, authenticated, service_role, authenticator;

GRANT EXECUTE ON FUNCTION
  public.reserve_tip_checkout_atomic(uuid, uuid, bigint, text, integer),
  public.bind_tip_checkout_session_atomic(uuid, uuid, text, timestamptz),
  public.expire_pending_tip_checkout_atomic(
    uuid, uuid, uuid, uuid, bigint, text, timestamptz, text, timestamptz
  )
TO service_role;

COMMENT ON COLUMN public.tips.checkout_expires_at IS
  'DB-owned exact Stripe Checkout expiry, fixed at reservation time to integer-second precision.';
COMMENT ON COLUMN public.tips.checkout_failed_at IS
  'DB observation time for an exact checkout.session.expired terminal transition.';
COMMENT ON COLUMN public.tips.checkout_failure_reason IS
  'Closed Tip checkout reason; currently only checkout_session_expired.';
COMMENT ON COLUMN public.tips.checkout_failure_event_id IS
  'Unique signed Stripe evt_ identity that terminally expired this Tip checkout.';
COMMENT ON COLUMN public.tips.checkout_failure_event_created_at IS
  'Stripe event.created for the exact checkout expiry event.';
COMMENT ON COLUMN public.tips.checkout_post_id IS
  'Immutable non-FK post identity captured for this Tip checkout reservation.';
COMMENT ON COLUMN public.tips.checkout_to_user_id IS
  'Immutable non-FK recipient identity captured for this Tip checkout reservation.';
COMMENT ON FUNCTION public.reserve_tip_checkout_atomic(
  uuid, uuid, bigint, text, integer
) IS
  'Service-only durable Tip reservation with active-account and canonical write-authority revalidation, tuple serialization, and DB-fixed expiry; DB time never releases an unresolved tuple.';
COMMENT ON FUNCTION public.bind_tip_checkout_session_atomic(
  uuid, uuid, text, timestamptz
) IS
  'Service-only exact CAS binding of one Stripe Checkout Session to one live Tip reservation.';
COMMENT ON FUNCTION public.expire_pending_tip_checkout_atomic(
  uuid, uuid, uuid, uuid, bigint, text, timestamptz, text, timestamptz
) IS
  'Service-only exact Stripe event transition from pending Tip reservation to immutable failed state.';

DO $postflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service oid := pg_catalog.to_regrole('service_role');
  v_function pg_catalog.regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indexrelid =
        'public.tips_pending_checkout_reservation_unique'::pg_catalog.regclass
      AND index_row.indrelid = 'public.tips'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 3
      AND index_row.indnatts = 3
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NOT NULL
      AND pg_catalog.pg_get_expr(
        index_row.indpred, index_row.indrelid
      ) = '(status = ''pending''::text)'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indexrelid =
        'public.tips_checkout_failure_event_unique'::pg_catalog.regclass
      AND index_row.indrelid = 'public.tips'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NOT NULL
      AND pg_catalog.pg_get_expr(
        index_row.indpred, index_row.indrelid
      ) = '(checkout_failure_event_id IS NOT NULL)'
  ) THEN
    RAISE EXCEPTION 'Tip checkout lifecycle unique indexes are invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'reserve_tip_checkout_atomic',
        'bind_tip_checkout_session_atomic',
        'expire_pending_tip_checkout_atomic',
        'enforce_tip_checkout_lifecycle'
      )
      AND function_row.oid NOT IN (
        'public.reserve_tip_checkout_atomic(uuid,uuid,bigint,text,integer)'::pg_catalog.regprocedure,
        'public.bind_tip_checkout_session_atomic(uuid,uuid,text,timestamp with time zone)'::pg_catalog.regprocedure,
        'public.expire_pending_tip_checkout_atomic(uuid,uuid,uuid,uuid,bigint,text,timestamp with time zone,text,timestamp with time zone)'::pg_catalog.regprocedure,
        'public.enforce_tip_checkout_lifecycle()'::pg_catalog.regprocedure
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'reserve_tip_checkout_atomic',
        'bind_tip_checkout_session_atomic',
        'expire_pending_tip_checkout_atomic',
        'enforce_tip_checkout_lifecycle'
      )
  ) <> 4 THEN
    RAISE EXCEPTION 'Tip checkout lifecycle function overload drifted';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.reserve_tip_checkout_atomic(uuid,uuid,bigint,text,integer)'::pg_catalog.regprocedure,
    'public.bind_tip_checkout_session_atomic(uuid,uuid,text,timestamp with time zone)'::pg_catalog.regprocedure,
    'public.expire_pending_tip_checkout_atomic(uuid,uuid,uuid,uuid,bigint,text,timestamp with time zone,text,timestamp with time zone)'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND function_row.proowner = v_postgres
        AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.proconfig @> ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
    ) OR pg_catalog.has_function_privilege(
      'authenticated', v_function, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon', v_function, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticator', v_function, 'EXECUTE'
    ) OR NOT pg_catalog.has_function_privilege(
      'service_role', v_function, 'EXECUTE'
    ) THEN
      RAISE EXCEPTION
        'Tip checkout lifecycle function owner, shape, or ACL drifted: %',
        v_function;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_row
    WHERE function_row.oid IN (
      'public.reserve_tip_checkout_atomic(uuid,uuid,bigint,text,integer)'::pg_catalog.regprocedure,
      'public.bind_tip_checkout_session_atomic(uuid,uuid,text,timestamp with time zone)'::pg_catalog.regprocedure,
      'public.expire_pending_tip_checkout_atomic(uuid,uuid,uuid,uuid,bigint,text,timestamp with time zone,text,timestamp with time zone)'::pg_catalog.regprocedure
    )
      AND acl_row.grantee NOT IN (v_postgres, v_service)
  ) THEN
    RAISE EXCEPTION 'Tip checkout lifecycle function has an unknown grantee';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
