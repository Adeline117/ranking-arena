-- Consume verified Stripe proofs exactly once and apply a paid-group pass,
-- renewal, trial, and membership edge in one database transaction.

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('group-application-authority-migrations', 0)
);
SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.group_subscriptions:server-authority:v1',
    0
  )
);

DO $preflight$
DECLARE
  v_postgres oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_authenticator oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticator'
  );
  v_relation text;
  v_existing pg_catalog.regclass;
BEGIN
  IF v_postgres IS NULL
    OR v_service IS NULL
    OR v_authenticator IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(
        ARRAY['anon', 'authenticated']::name[]
      ) AS required_role(role_name)
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.rolname = required_role.role_name
      WHERE role_row.oid IS NULL
    )
  THEN
    RAISE EXCEPTION 'atomic group passes require standard Supabase roles';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'groups',
    'group_subscriptions',
    'group_members',
    'group_bans',
    'user_profiles',
    'pro_official_groups'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = pg_catalog.to_regclass('public.' || v_relation)
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
        AND relation.relowner = v_postgres
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid =
          pg_catalog.to_regclass('public.' || v_relation)
         OR inheritance.inhparent =
          pg_catalog.to_regclass('public.' || v_relation)
    ) THEN
      RAISE EXCEPTION 'atomic group pass relation is incompatible: public.%',
        v_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('groups', 'id', 'uuid'::pg_catalog.regtype),
        ('groups', 'name', 'text'::pg_catalog.regtype),
        ('groups', 'created_by', 'uuid'::pg_catalog.regtype),
        ('groups', 'dissolved_at', 'timestamptz'::pg_catalog.regtype),
        ('groups', 'is_premium_only', 'boolean'::pg_catalog.regtype),
        ('groups', 'subscription_price_monthly', 'numeric'::pg_catalog.regtype),
        ('groups', 'subscription_price_yearly', 'numeric'::pg_catalog.regtype),
        ('groups', 'original_price_monthly', 'numeric'::pg_catalog.regtype),
        ('groups', 'original_price_yearly', 'numeric'::pg_catalog.regtype),
        ('groups', 'allow_trial', 'boolean'::pg_catalog.regtype),
        ('groups', 'trial_days', 'integer'::pg_catalog.regtype),
        ('groups', 'min_arena_score', 'integer'::pg_catalog.regtype),
        ('groups', 'is_verified_only', 'boolean'::pg_catalog.regtype),
        ('groups', 'member_count', 'integer'::pg_catalog.regtype),
        ('group_subscriptions', 'id', 'uuid'::pg_catalog.regtype),
        ('group_subscriptions', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_subscriptions', 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_subscriptions', 'tier', 'text'::pg_catalog.regtype),
        ('group_subscriptions', 'status', 'text'::pg_catalog.regtype),
        ('group_subscriptions', 'price_paid', 'numeric'::pg_catalog.regtype),
        ('group_subscriptions', 'starts_at', 'timestamptz'::pg_catalog.regtype),
        ('group_subscriptions', 'expires_at', 'timestamptz'::pg_catalog.regtype),
        ('group_subscriptions', 'cancelled_at', 'timestamptz'::pg_catalog.regtype),
        ('group_subscriptions', 'payment_provider', 'text'::pg_catalog.regtype),
        ('group_subscriptions', 'payment_reference', 'text'::pg_catalog.regtype),
        ('group_subscriptions', 'created_at', 'timestamptz'::pg_catalog.regtype),
        ('group_subscriptions', 'updated_at', 'timestamptz'::pg_catalog.regtype),
        ('group_members', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_members', 'user_id', 'uuid'::pg_catalog.regtype),
        ('group_members', 'role', 'public.member_role'::pg_catalog.regtype),
        ('group_bans', 'group_id', 'uuid'::pg_catalog.regtype),
        ('group_bans', 'user_id', 'uuid'::pg_catalog.regtype),
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype),
        ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype),
        ('user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'reputation_score', 'integer'::pg_catalog.regtype),
        ('user_profiles', 'is_verified_trader', 'boolean'::pg_catalog.regtype),
        ('pro_official_groups', 'group_id', 'uuid'::pg_catalog.regtype)
    ) AS required_column(relation_name, column_name, type_oid)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass(
        'public.' || required_column.relation_name
      )
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
       OR attribute.attgenerated <> ''
  ) THEN
    RAISE EXCEPTION 'atomic group pass columns are missing or incompatible';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = 'auth.role()'::pg_catalog.regprocedure
      AND function_row.prorettype = 'text'::pg_catalog.regtype
  ) THEN
    RAISE EXCEPTION 'auth.role() text identity helper is missing';
  END IF;

  -- Supabase's gateway may SET ROLE service_role for a service JWT, but it
  -- must not inherit that authority.  No other direct or recursive browser,
  -- custom-role, downstream, or upstream membership path is accepted.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member = v_authenticator
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member NOT IN (v_authenticator, v_postgres)
  ) OR EXISTS (
    WITH RECURSIVE service_inheritors(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_service
        AND membership.inherit_option
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inheritors AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM service_inheritors AS inherited
    WHERE inherited.member_oid <> v_postgres
  ) OR EXISTS (
    WITH RECURSIVE service_inherits(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = v_service
        AND (membership.inherit_option OR membership.set_option)
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1 FROM service_inherits
  ) OR EXISTS (
    WITH RECURSIVE browser_authority(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_roles AS browser_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = browser_role.oid
       AND (membership.inherit_option OR membership.set_option)
      WHERE browser_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT membership.roleid
      FROM browser_authority AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM browser_authority AS inherited
    WHERE inherited.role_oid IN (v_service, v_postgres)
  ) THEN
    RAISE EXCEPTION 'atomic group pass service-role authority graph is unsafe';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.group_subscriptions'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'public.groups'::pg_catalog.regclass
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = constraint_row.conrelid
          AND attribute.attname = 'group_id'
      )]::smallint[]
      AND constraint_row.confkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = constraint_row.confrelid
          AND attribute.attname = 'id'
      )]::smallint[]
  ) <> 1 THEN
    RAISE EXCEPTION 'group subscription parent cascade is incompatible';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'group_payment_consumptions',
    'group_trial_consumptions'
  ]::text[]
  LOOP
    v_existing := pg_catalog.to_regclass('public.' || v_relation);
    IF v_existing IS NOT NULL AND (
      NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = v_existing
          AND relation.relkind = 'r'
          AND relation.relpersistence = 'p'
          AND NOT relation.relispartition
          AND relation.relowner = v_postgres
      ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_inherits AS inheritance
        WHERE inheritance.inhrelid = v_existing
           OR inheritance.inhparent = v_existing
      )
    ) THEN
      RAISE EXCEPTION 'group pass ledger relation is incompatible: public.%',
        v_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'activate_group_subscription_atomic',
        'cancel_group_subscription_atomic',
        'read_group_subscription_atomic'
      )
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
        NOT IN (
          'p_actor_id uuid, p_group_id uuid, p_tier text, p_payment_provider text, p_payment_intent_id text, p_checkout_session_id text, p_amount_cents bigint, p_currency text',
          'p_actor_id uuid, p_subscription_id uuid',
          'p_actor_id uuid, p_group_id uuid'
        )
  ) THEN
    RAISE EXCEPTION 'unexpected atomic group pass RPC overload exists';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.group_payment_consumptions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  provider text NOT NULL,
  payment_intent_id text NOT NULL,
  checkout_session_id text,
  subscription_id uuid NOT NULL,
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  tier text NOT NULL,
  amount_cents bigint NOT NULL,
  currency text NOT NULL,
  outcome text NOT NULL,
  result jsonb NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT group_payment_consumptions_provider_valid
    CHECK (provider = 'stripe'),
  CONSTRAINT group_payment_consumptions_intent_valid
    CHECK (
      pg_catalog.char_length(payment_intent_id) BETWEEN 4 AND 255
      AND payment_intent_id ~ '^pi_[A-Za-z0-9_]+$'
    ),
  CONSTRAINT group_payment_consumptions_session_valid
    CHECK (
      checkout_session_id IS NULL
      OR (
        pg_catalog.char_length(checkout_session_id) BETWEEN 4 AND 255
        AND checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'
      )
    ),
  CONSTRAINT group_payment_consumptions_tier_valid
    CHECK (tier IN ('monthly', 'yearly')),
  CONSTRAINT group_payment_consumptions_amount_valid
    CHECK (amount_cents > 0),
  CONSTRAINT group_payment_consumptions_currency_valid
    CHECK (currency = 'usd'),
  CONSTRAINT group_payment_consumptions_outcome_valid
    CHECK (outcome IN ('activated', 'renewed')),
  CONSTRAINT group_payment_consumptions_result_valid
    CHECK (
      pg_catalog.jsonb_typeof(result) = 'object'
      AND result ? 'status'
      AND result ? 'subscription_id'
      AND result ->> 'status' IN ('subscribed', 'renewed')
      AND result ->> 'subscription_id' = subscription_id::text
    ),
  CONSTRAINT group_payment_consumptions_intent_unique
    UNIQUE (provider, payment_intent_id)
);
ALTER TABLE public.group_payment_consumptions OWNER TO postgres;

CREATE UNIQUE INDEX IF NOT EXISTS
  group_payment_consumptions_checkout_session_unique
  ON public.group_payment_consumptions (provider, checkout_session_id)
  WHERE checkout_session_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.group_trial_consumptions (
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  subscription_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  PRIMARY KEY (group_id, user_id)
);
ALTER TABLE public.group_trial_consumptions OWNER TO postgres;

LOCK TABLE
  public.groups,
  public.user_profiles,
  public.group_bans,
  public.group_members,
  public.group_subscriptions,
  public.pro_official_groups,
  public.group_payment_consumptions,
  public.group_trial_consumptions
IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.group_subscriptions
  ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;

DO $validate_cancel_column$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
        'public.group_subscriptions'::pg_catalog.regclass
      AND attribute.attname = 'cancel_at_period_end'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.atttypid = 'boolean'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.atthasdef
      AND attribute.attgenerated = ''
  ) THEN
    RAISE EXCEPTION 'group_subscriptions.cancel_at_period_end is incompatible';
  END IF;
END
$validate_cancel_column$;

-- Restore the prepaid period promised by the legacy immediate-cancel route.
UPDATE public.group_subscriptions AS subscription
SET status = 'expired',
    cancel_at_period_end = false,
    updated_at = pg_catalog.clock_timestamp()
WHERE subscription.status IN ('active', 'trialing', 'cancelled')
  AND subscription.expires_at <= pg_catalog.clock_timestamp();

UPDATE public.group_subscriptions AS cancelled_subscription
SET status = CASE
      WHEN cancelled_subscription.tier = 'trial' THEN 'trialing'
      ELSE 'active'
    END,
    cancel_at_period_end = true,
    updated_at = pg_catalog.clock_timestamp()
WHERE cancelled_subscription.status = 'cancelled'
  AND cancelled_subscription.expires_at > pg_catalog.clock_timestamp()
  AND NOT EXISTS (
    SELECT 1
    FROM public.group_subscriptions AS current_subscription
    WHERE current_subscription.group_id = cancelled_subscription.group_id
      AND current_subscription.user_id = cancelled_subscription.user_id
      AND current_subscription.id <> cancelled_subscription.id
      AND current_subscription.status IN ('active', 'trialing')
      AND current_subscription.expires_at > pg_catalog.clock_timestamp()
  );

DO $current_subscription_data_preflight$
BEGIN
  IF EXISTS (
    SELECT subscription.group_id, subscription.user_id
    FROM public.group_subscriptions AS subscription
    WHERE subscription.status IN ('active', 'trialing')
    GROUP BY subscription.group_id, subscription.user_id
    HAVING pg_catalog.count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate current group subscriptions require explicit review';
  END IF;
END
$current_subscription_data_preflight$;

DROP INDEX IF EXISTS public.group_subscriptions_one_current_per_user_group;
CREATE UNIQUE INDEX group_subscriptions_one_current_per_user_group
  ON public.group_subscriptions (group_id, user_id)
  WHERE status IN ('active', 'trialing');

-- Every historical trial consumes the one-time trial slot, even if the
-- subscription later expired or was cancelled.
INSERT INTO public.group_trial_consumptions (
  group_id, user_id, subscription_id, consumed_at
)
SELECT DISTINCT ON (subscription.group_id, subscription.user_id)
  subscription.group_id,
  subscription.user_id,
  subscription.id,
  COALESCE(subscription.created_at, subscription.starts_at)
FROM public.group_subscriptions AS subscription
WHERE subscription.tier = 'trial'
ORDER BY
  subscription.group_id,
  subscription.user_id,
  COALESCE(subscription.created_at, subscription.starts_at),
  subscription.id
ON CONFLICT (group_id, user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.prevent_group_pass_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'group pass consumption ledgers are immutable'
    USING ERRCODE = '23514';
END
$function$;

ALTER FUNCTION public.prevent_group_pass_ledger_mutation() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_group_payment_consumptions_immutable
  ON public.group_payment_consumptions;
CREATE TRIGGER trg_group_payment_consumptions_immutable
  BEFORE UPDATE OR DELETE ON public.group_payment_consumptions
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_group_pass_ledger_mutation();

DROP TRIGGER IF EXISTS trg_group_trial_consumptions_immutable
  ON public.group_trial_consumptions;
CREATE TRIGGER trg_group_trial_consumptions_immutable
  BEFORE UPDATE OR DELETE ON public.group_trial_consumptions
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_group_pass_ledger_mutation();

-- Converge subscription and ledger table authority, including out-of-band
-- roles, future columns, policies, and RLS mode introduced after a replay.
DO $converge_table_authority$
DECLARE
  v_table name;
  v_relation pg_catalog.regclass;
  v_owner oid;
  v_grantee oid;
  v_grantee_name name;
  v_grantee_sql text;
  v_grantees oid[];
  v_columns text;
  v_policy name;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'group_subscriptions',
    'group_payment_consumptions',
    'group_trial_consumptions'
  ]::name[]
  LOOP
    v_relation := ('public.' || v_table)::pg_catalog.regclass;
    SELECT relation.relowner
    INTO STRICT v_owner
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation;

    SELECT pg_catalog.string_agg(
      pg_catalog.format('%I', attribute.attname),
      ', '
      ORDER BY attribute.attnum
    )
    INTO STRICT v_columns
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    SELECT pg_catalog.array_agg(DISTINCT discovered.grantee)
    INTO v_grantees
    FROM (
      SELECT acl_entry.grantee
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_relation
      UNION
      SELECT acl_entry.grantee
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) AS discovered
    WHERE discovered.grantee <> v_owner;

    FOREACH v_grantee IN ARRAY COALESCE(v_grantees, ARRAY[]::oid[])
    LOOP
      IF v_grantee = 0::oid THEN
        v_grantee_sql := 'PUBLIC';
      ELSE
        SELECT role_row.rolname
        INTO v_grantee_name
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.oid = v_grantee;
        IF v_grantee_name IS NULL THEN
          RAISE EXCEPTION 'dangling group pass ACL grantee oid: %', v_grantee;
        END IF;
        v_grantee_sql := pg_catalog.format('%I', v_grantee_name);
      END IF;

      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %s CASCADE',
        v_table,
        v_grantee_sql
      );
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.%2$I FROM %3$s CASCADE',
        v_columns,
        v_table,
        v_grantee_sql
      );
    END LOOP;

    FOR v_policy IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = v_relation
      ORDER BY policy.polname
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON public.%I',
        v_policy,
        v_table
      );
    END LOOP;

    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',
      v_table
    );
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY',
      v_table
    );
  END LOOP;
END
$converge_table_authority$;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.group_subscriptions TO service_role;
CREATE POLICY service_role_manages_group_subscriptions
  ON public.group_subscriptions
  AS PERMISSIVE
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.activate_group_subscription_atomic(
  p_actor_id uuid,
  p_group_id uuid,
  p_tier text,
  p_payment_provider text,
  p_payment_intent_id text,
  p_checkout_session_id text,
  p_amount_cents bigint,
  p_currency text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_group public.groups%ROWTYPE;
  v_profile public.user_profiles%ROWTYPE;
  v_subscription public.group_subscriptions%ROWTYPE;
  v_intent_consumption public.group_payment_consumptions%ROWTYPE;
  v_session_consumption public.group_payment_consumptions%ROWTYPE;
  v_existing_consumption public.group_payment_consumptions%ROWTYPE;
  v_subscription_id uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_expires_at timestamptz;
  v_price_paid numeric;
  v_expected_cents bigint;
  v_subscription_status text;
  v_result_status text;
  v_outcome text;
  v_membership_status text := 'already_member';
  v_member_role text;
  v_member_count integer;
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL
    OR p_group_id IS NULL
    OR p_tier IS NULL
    OR p_tier NOT IN ('monthly', 'yearly', 'trial')
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF p_tier = 'trial' THEN
    IF p_payment_provider IS NOT NULL
      OR p_payment_intent_id IS NOT NULL
      OR p_checkout_session_id IS NOT NULL
      OR COALESCE(p_amount_cents, 0) <> 0
      OR p_currency IS NOT NULL
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid_payment');
    END IF;
  ELSIF p_payment_provider IS DISTINCT FROM 'stripe'
    OR p_payment_intent_id IS NULL
    OR pg_catalog.char_length(p_payment_intent_id) NOT BETWEEN 4 AND 255
    OR p_payment_intent_id !~ '^pi_[A-Za-z0-9_]+$'
    OR (
      p_checkout_session_id IS NOT NULL
      AND (
        pg_catalog.char_length(p_checkout_session_id) NOT BETWEEN 4 AND 255
        OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
      )
    )
    OR p_amount_cents IS NULL
    OR p_amount_cents <= 0
    OR pg_catalog.lower(COALESCE(p_currency, '')) <> 'usd'
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_payment');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || p_group_id::text || ':' || p_actor_id::text,
      0
    )
  );

  IF p_tier <> 'trial' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-payment-intent:stripe:' || p_payment_intent_id,
        0
      )
    );
    IF p_checkout_session_id IS NOT NULL THEN
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
          'group-checkout-session:stripe:' || p_checkout_session_id,
          0
        )
      );
    END IF;

    SELECT consumption.*
    INTO v_intent_consumption
    FROM public.group_payment_consumptions AS consumption
    WHERE consumption.provider = 'stripe'
      AND consumption.payment_intent_id = p_payment_intent_id
    FOR UPDATE;

    IF p_checkout_session_id IS NOT NULL THEN
      SELECT consumption.*
      INTO v_session_consumption
      FROM public.group_payment_consumptions AS consumption
      WHERE consumption.provider = 'stripe'
        AND consumption.checkout_session_id = p_checkout_session_id
      FOR UPDATE;
    END IF;

    IF v_intent_consumption.id IS NOT NULL
      AND v_session_consumption.id IS NOT NULL
      AND v_intent_consumption.id <> v_session_consumption.id
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'payment_replayed');
    END IF;
    IF v_intent_consumption.id IS NOT NULL THEN
      v_existing_consumption := v_intent_consumption;
    ELSE
      v_existing_consumption := v_session_consumption;
    END IF;

    IF v_existing_consumption.id IS NOT NULL THEN
      IF v_existing_consumption.provider IS DISTINCT FROM 'stripe'
        OR v_existing_consumption.payment_intent_id
          IS DISTINCT FROM p_payment_intent_id
        OR v_existing_consumption.checkout_session_id
          IS DISTINCT FROM p_checkout_session_id
        OR v_existing_consumption.group_id IS DISTINCT FROM p_group_id
        OR v_existing_consumption.user_id IS DISTINCT FROM p_actor_id
        OR v_existing_consumption.tier IS DISTINCT FROM p_tier
        OR v_existing_consumption.amount_cents IS DISTINCT FROM p_amount_cents
        OR v_existing_consumption.currency IS DISTINCT FROM 'usd'
      THEN
        RETURN pg_catalog.jsonb_build_object('status', 'payment_replayed');
      END IF;

      RETURN v_existing_consumption.result
        || pg_catalog.jsonb_build_object('idempotent_replay', true);
    END IF;
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_profile.deleted_at IS NOT NULL
    OR v_profile.banned_at IS NOT NULL
    OR (
      COALESCE(v_profile.is_banned, false)
      AND (
        v_profile.ban_expires_at IS NULL
        OR v_profile.ban_expires_at > v_now
      )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  SELECT target_group.*
  INTO v_group
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_group.dissolved_at IS NOT NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'dissolved');
  END IF;
  IF NOT COALESCE(v_group.is_premium_only, false) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_premium');
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.pro_official_groups AS official_group
    WHERE official_group.group_id = p_group_id
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'official');
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.group_bans AS ban
    WHERE ban.group_id = p_group_id
      AND ban.user_id = p_actor_id
    FOR UPDATE
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'banned');
  END IF;
  IF COALESCE(v_group.min_arena_score, 0)
    > COALESCE(v_profile.reputation_score, 0)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'score_too_low');
  END IF;
  IF COALESCE(v_group.is_verified_only, false)
    AND NOT COALESCE(v_profile.is_verified_trader, false)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'verified_only');
  END IF;

  IF p_tier = 'trial' THEN
    IF NOT COALESCE(v_group.allow_trial, false) THEN
      RETURN pg_catalog.jsonb_build_object('status', 'trial_unavailable');
    END IF;
    v_price_paid := 0;
    v_expected_cents := 0;
    v_subscription_status := 'trialing';
    v_expires_at := v_now + pg_catalog.make_interval(
      days => GREATEST(COALESCE(v_group.trial_days, 7), 1)
    );
  ELSIF p_tier = 'monthly' THEN
    v_price_paid := COALESCE(v_group.subscription_price_monthly, 9.9);
    v_expected_cents := pg_catalog.round(v_price_paid * 100)::bigint;
    v_subscription_status := 'active';
    v_expires_at := v_now + interval '30 days';
  ELSE
    v_price_paid := COALESCE(v_group.subscription_price_yearly, 99.9);
    v_expected_cents := pg_catalog.round(v_price_paid * 100)::bigint;
    v_subscription_status := 'active';
    v_expires_at := v_now + interval '365 days';
  END IF;

  IF p_tier <> 'trial'
    AND (
      v_expected_cents <= 0
      OR p_amount_cents IS DISTINCT FROM v_expected_cents
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'amount_mismatch');
  END IF;

  UPDATE public.group_subscriptions AS stale_subscription
  SET status = 'expired',
      cancel_at_period_end = false,
      updated_at = v_now
  WHERE stale_subscription.group_id = p_group_id
    AND stale_subscription.user_id = p_actor_id
    AND stale_subscription.status IN ('active', 'trialing')
    AND stale_subscription.expires_at <= v_now;

  SELECT subscription.*
  INTO v_subscription
  FROM public.group_subscriptions AS subscription
  WHERE subscription.group_id = p_group_id
    AND subscription.user_id = p_actor_id
    AND subscription.status IN ('active', 'trialing')
    AND subscription.expires_at > v_now
  FOR UPDATE;

  IF FOUND AND p_tier = 'trial' THEN
    SELECT member.role::text
    INTO v_member_role
    FROM public.group_members AS member
    WHERE member.group_id = p_group_id
      AND member.user_id = p_actor_id
    FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.group_members (group_id, user_id, role)
      VALUES (
        p_group_id,
        p_actor_id,
        CASE
          WHEN v_group.created_by = p_actor_id
            THEN 'owner'::public.member_role
          ELSE 'member'::public.member_role
        END
      );
      v_membership_status := 'joined';
    END IF;
    SELECT COALESCE(target_group.member_count, 0)
    INTO v_member_count
    FROM public.groups AS target_group
    WHERE target_group.id = p_group_id;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_active',
      'subscription_id', v_subscription.id,
      'tier', v_subscription.tier,
      'subscription_status', v_subscription.status,
      'expires_at', v_subscription.expires_at,
      'price_paid', COALESCE(v_subscription.price_paid, 0),
      'membership_status', v_membership_status,
      'member_count', v_member_count,
      'idempotent_replay', true
    );
  END IF;

  IF p_tier = 'trial' AND EXISTS (
    SELECT 1
    FROM public.group_trial_consumptions AS trial
    WHERE trial.group_id = p_group_id
      AND trial.user_id = p_actor_id
    FOR UPDATE
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'trial_already_used');
  END IF;

  IF v_subscription.id IS NULL THEN
    v_subscription_id := pg_catalog.gen_random_uuid();
    INSERT INTO public.group_subscriptions (
      id,
      group_id,
      user_id,
      tier,
      status,
      price_paid,
      starts_at,
      expires_at,
      cancelled_at,
      cancel_at_period_end,
      payment_provider,
      payment_reference,
      updated_at
    ) VALUES (
      v_subscription_id,
      p_group_id,
      p_actor_id,
      p_tier,
      v_subscription_status,
      v_price_paid,
      v_now,
      v_expires_at,
      NULL,
      false,
      CASE WHEN p_tier = 'trial' THEN NULL ELSE 'stripe' END,
      CASE
        WHEN p_tier = 'trial' THEN NULL
        ELSE 'stripe:' || p_payment_intent_id
      END,
      v_now
    );
    v_result_status := 'subscribed';
    v_outcome := 'activated';
  ELSE
    IF v_subscription.expires_at IS NULL THEN
      RETURN pg_catalog.jsonb_build_object('status', 'perpetual_entitlement');
    END IF;
    v_subscription_id := v_subscription.id;
    v_expires_at := GREATEST(v_subscription.expires_at, v_now)
      + CASE
          WHEN p_tier = 'monthly' THEN interval '30 days'
          ELSE interval '365 days'
        END;
    UPDATE public.group_subscriptions
    SET tier = p_tier,
        status = 'active',
        price_paid = v_price_paid,
        expires_at = v_expires_at,
        cancelled_at = NULL,
        cancel_at_period_end = false,
        payment_provider = 'stripe',
        payment_reference = 'stripe:' || p_payment_intent_id,
        updated_at = v_now
    WHERE id = v_subscription_id;
    v_subscription_status := 'active';
    v_result_status := 'renewed';
    v_outcome := 'renewed';
  END IF;

  SELECT member.role::text
  INTO v_member_role
  FROM public.group_members AS member
  WHERE member.group_id = p_group_id
    AND member.user_id = p_actor_id
  FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.group_members (group_id, user_id, role)
    VALUES (
      p_group_id,
      p_actor_id,
      CASE
        WHEN v_group.created_by = p_actor_id
          THEN 'owner'::public.member_role
        ELSE 'member'::public.member_role
      END
    );
    v_membership_status := 'joined';
  END IF;

  SELECT COALESCE(target_group.member_count, 0)
  INTO v_member_count
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id;

  v_result := pg_catalog.jsonb_build_object(
    'status', v_result_status,
    'subscription_id', v_subscription_id,
    'tier', p_tier,
    'subscription_status', v_subscription_status,
    'expires_at', v_expires_at,
    'price_paid', v_price_paid,
    'membership_status', v_membership_status,
    'member_count', v_member_count,
    'idempotent_replay', false
  );

  IF p_tier = 'trial' THEN
    INSERT INTO public.group_trial_consumptions (
      group_id, user_id, subscription_id
    ) VALUES (
      p_group_id, p_actor_id, v_subscription_id
    );
  ELSE
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
      result
    ) VALUES (
      'stripe',
      p_payment_intent_id,
      p_checkout_session_id,
      v_subscription_id,
      p_group_id,
      p_actor_id,
      p_tier,
      p_amount_cents,
      'usd',
      v_outcome,
      v_result
    );
  END IF;

  RETURN v_result;
END
$function$;

CREATE OR REPLACE FUNCTION public.cancel_group_subscription_atomic(
  p_actor_id uuid,
  p_subscription_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_initial public.group_subscriptions%ROWTYPE;
  v_subscription public.group_subscriptions%ROWTYPE;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL OR p_subscription_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT subscription.*
  INTO v_initial
  FROM public.group_subscriptions AS subscription
  WHERE subscription.id = p_subscription_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_initial.user_id <> p_actor_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'group-membership:' || v_initial.group_id::text || ':' || p_actor_id::text,
      0
    )
  );

  SELECT subscription.*
  INTO v_subscription
  FROM public.group_subscriptions AS subscription
  WHERE subscription.id = p_subscription_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_subscription.user_id <> p_actor_id
    OR v_subscription.group_id <> v_initial.group_id
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;
  IF v_subscription.status NOT IN ('active', 'trialing') THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_inactive',
      'subscription_status', v_subscription.status
    );
  END IF;
  IF v_subscription.expires_at <= v_now THEN
    UPDATE public.group_subscriptions
    SET status = 'expired',
        cancel_at_period_end = false,
        updated_at = v_now
    WHERE id = p_subscription_id;
    RETURN pg_catalog.jsonb_build_object('status', 'expired');
  END IF;
  IF v_subscription.cancel_at_period_end THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_scheduled',
      'expires_at', v_subscription.expires_at
    );
  END IF;

  UPDATE public.group_subscriptions
  SET cancel_at_period_end = true,
      cancelled_at = v_now,
      updated_at = v_now
  WHERE id = p_subscription_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'cancellation_scheduled',
    'expires_at', v_subscription.expires_at
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.read_group_subscription_atomic(
  p_actor_id uuid,
  p_group_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_group public.groups%ROWTYPE;
  v_subscription public.group_subscriptions%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL OR p_group_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT target_group.*
  INTO v_group
  FROM public.groups AS target_group
  WHERE target_group.id = p_group_id;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT subscription.*
  INTO v_subscription
  FROM public.group_subscriptions AS subscription
  WHERE subscription.user_id = p_actor_id
    AND subscription.group_id = p_group_id
    AND subscription.status IN ('active', 'trialing')
    AND subscription.expires_at > pg_catalog.statement_timestamp()
  ORDER BY subscription.expires_at DESC, subscription.id
  LIMIT 1;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'ok',
    'group', pg_catalog.jsonb_build_object(
      'id', v_group.id,
      'name', v_group.name,
      'is_premium_only', COALESCE(v_group.is_premium_only, false),
      'price_monthly', v_group.subscription_price_monthly,
      'price_yearly', v_group.subscription_price_yearly,
      'original_price_monthly', v_group.original_price_monthly,
      'original_price_yearly', v_group.original_price_yearly,
      'allow_trial', COALESCE(v_group.allow_trial, false),
      'trial_days', v_group.trial_days
    ),
    'subscription', CASE
      WHEN v_subscription.id IS NULL THEN 'null'::jsonb
      ELSE pg_catalog.jsonb_build_object(
        'id', v_subscription.id,
        'tier', v_subscription.tier,
        'status', v_subscription.status,
        'expires_at', v_subscription.expires_at,
        'price_paid', COALESCE(v_subscription.price_paid, 0),
        'cancel_at_period_end', v_subscription.cancel_at_period_end
      )
    END,
    'is_subscribed', v_subscription.id IS NOT NULL
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.expire_group_subscriptions()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_affected integer;
BEGIN
  UPDATE public.group_subscriptions
  SET status = 'expired',
      cancel_at_period_end = false,
      updated_at = pg_catalog.clock_timestamp()
  WHERE status IN ('active', 'trialing')
    AND expires_at <= pg_catalog.clock_timestamp();
  GET DIAGNOSTICS v_affected = ROW_COUNT;
  RETURN v_affected;
END
$function$;

ALTER FUNCTION public.activate_group_subscription_atomic(
  uuid, uuid, text, text, text, text, bigint, text
) OWNER TO postgres;
ALTER FUNCTION public.cancel_group_subscription_atomic(uuid, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.read_group_subscription_atomic(uuid, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.expire_group_subscriptions() OWNER TO postgres;

DO $converge_function_authority$
DECLARE
  v_signature pg_catalog.regprocedure;
  v_owner oid;
  v_grantee record;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.prevent_group_pass_ledger_mutation()'::pg_catalog.regprocedure,
    'public.activate_group_subscription_atomic(uuid,uuid,text,text,text,text,bigint,text)'::pg_catalog.regprocedure,
    'public.cancel_group_subscription_atomic(uuid,uuid)'::pg_catalog.regprocedure,
    'public.read_group_subscription_atomic(uuid,uuid)'::pg_catalog.regprocedure,
    'public.expire_group_subscriptions()'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.proowner
    INTO STRICT v_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature;

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee, role_row.rolname
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      LEFT JOIN pg_catalog.pg_roles AS role_row
        ON role_row.oid = acl_entry.grantee
      WHERE function_row.oid = v_signature
        AND acl_entry.grantee <> v_owner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
          v_signature
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
          v_signature,
          v_grantee.rolname
        );
      END IF;
    END LOOP;
  END LOOP;
END
$converge_function_authority$;

GRANT EXECUTE ON FUNCTION public.activate_group_subscription_atomic(
  uuid, uuid, text, text, text, text, bigint, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_group_subscription_atomic(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.read_group_subscription_atomic(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.expire_group_subscriptions()
  TO service_role;

DO $postflight$
DECLARE
  v_postgres oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
  );
  v_service oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
  );
  v_authenticator oid := (
    SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'authenticator'
  );
  v_table name;
  v_signature pg_catalog.regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.group_subscriptions'::pg_catalog.regclass
      AND relation.relowner = v_postgres
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_subscriptions'::pg_catalog.regclass
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.group_subscriptions'::pg_catalog.regclass
      AND policy.polname = 'service_role_manages_group_subscriptions'
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION 'group subscription owner/service authority drifted';
  END IF;

  IF EXISTS (
    WITH expected(grantee, grantor, privilege_type, is_grantable) AS (
      VALUES
        (v_service, v_postgres, 'DELETE'::text, false),
        (v_service, v_postgres, 'INSERT'::text, false),
        (v_service, v_postgres, 'SELECT'::text, false),
        (v_service, v_postgres, 'UPDATE'::text, false)
    ),
    actual AS (
      SELECT acl_entry.grantee,
             acl_entry.grantor,
             acl_entry.privilege_type::text,
             acl_entry.is_grantable
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = 'public.group_subscriptions'::pg_catalog.regclass
        AND acl_entry.grantee <> relation.relowner
    )
    SELECT 1
    FROM expected
    FULL JOIN actual
      USING (grantee, grantor, privilege_type, is_grantable)
    WHERE expected.grantee IS NULL OR actual.grantee IS NULL
  ) THEN
    RAISE EXCEPTION 'group subscription ACL is not exact service CRUD';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'group_payment_consumptions',
    'group_trial_consumptions'
  ]::name[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = ('public.' || v_table)::pg_catalog.regclass
        AND relation.relowner = v_postgres
        AND relation.relrowsecurity
        AND NOT relation.relforcerowsecurity
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = ('public.' || v_table)::pg_catalog.regclass
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = ('public.' || v_table)::pg_catalog.regclass
        AND acl_entry.grantee <> relation.relowner
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = ('public.' || v_table)::pg_catalog.regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> v_postgres
    ) THEN
      RAISE EXCEPTION 'group pass ledger authority drifted: public.%', v_table;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = constraint_row.conindid
    WHERE constraint_row.conrelid =
        'public.group_payment_consumptions'::pg_catalog.regclass
      AND constraint_row.conname =
        'group_payment_consumptions_intent_unique'
      AND constraint_row.contype = 'u'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'provider'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'payment_intent_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
      ]::smallint[]
      AND index_row.indrelid = constraint_row.conrelid
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'payment-intent consumption uniqueness drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    WHERE index_relation.relnamespace = 'public'::pg_catalog.regnamespace
      AND index_relation.relname =
        'group_payment_consumptions_checkout_session_unique'
      AND index_row.indrelid =
        'public.group_payment_consumptions'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND index_row.indexprs IS NULL
      AND index_row.indkey[0] = (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = index_row.indrelid
          AND attribute.attname = 'provider'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )
      AND index_row.indkey[1] = (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = index_row.indrelid
          AND attribute.attname = 'checkout_session_id'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      )
      AND pg_catalog.pg_get_expr(
        index_row.indpred,
        index_row.indrelid,
        true
      ) = 'checkout_session_id IS NOT NULL'
  ) <> 1 THEN
    RAISE EXCEPTION 'checkout-session consumption uniqueness drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = constraint_row.conindid
    WHERE constraint_row.conrelid =
        'public.group_trial_consumptions'::pg_catalog.regclass
      AND constraint_row.conname = 'group_trial_consumptions_pkey'
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'group_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'user_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
      ]::smallint[]
      AND index_row.indrelid = constraint_row.conrelid
      AND index_row.indisprimary
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND index_row.indexprs IS NULL
      AND index_row.indpred IS NULL
  ) <> 1 THEN
    RAISE EXCEPTION 'trial-consumption primary key drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid =
        'public.prevent_group_pass_ledger_mutation()'::pg_catalog.regprocedure
      AND trigger_row.tgrelid IN (
        'public.group_payment_consumptions'::pg_catalog.regclass,
        'public.group_trial_consumptions'::pg_catalog.regclass
      )
      AND NOT trigger_row.tgisinternal
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'public.group_payment_consumptions'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_group_payment_consumptions_immutable'
      AND trigger_row.tgfoid =
        'public.prevent_group_pass_ledger_mutation()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 27
      AND trigger_row.tgqual IS NULL
      AND trigger_row.tgnargs = 0
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'public.group_trial_consumptions'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_group_trial_consumptions_immutable'
      AND trigger_row.tgfoid =
        'public.prevent_group_pass_ledger_mutation()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 27
      AND trigger_row.tgqual IS NULL
      AND trigger_row.tgnargs = 0
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
  ) THEN
    RAISE EXCEPTION 'group pass immutable ledger triggers drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    WHERE index_relation.relname =
        'group_subscriptions_one_current_per_user_group'
      AND index_row.indrelid =
        'public.group_subscriptions'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid, true)
        = 'status = ANY (ARRAY[''active''::text, ''trialing''::text])'
  ) THEN
    RAISE EXCEPTION 'current group subscription uniqueness drifted';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.prevent_group_pass_ledger_mutation()'::pg_catalog.regprocedure,
    'public.activate_group_subscription_atomic(uuid,uuid,text,text,text,text,bigint,text)'::pg_catalog.regprocedure,
    'public.cancel_group_subscription_atomic(uuid,uuid)'::pg_catalog.regprocedure,
    'public.read_group_subscription_atomic(uuid,uuid)'::pg_catalog.regprocedure,
    'public.expire_group_subscriptions()'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_signature
        AND function_row.proowner = v_postgres
        AND function_row.prosecdef
        AND function_row.proconfig =
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
    ) OR pg_catalog.has_function_privilege(
      'anon', v_signature, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated', v_signature, 'EXECUTE'
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          function_row.proacl,
          pg_catalog.acldefault('f', function_row.proowner)
        )
      ) AS acl_entry
      WHERE function_row.oid = v_signature
        AND acl_entry.privilege_type = 'EXECUTE'
        AND acl_entry.grantee NOT IN (
          function_row.proowner,
          CASE
            WHEN v_signature =
              'public.prevent_group_pass_ledger_mutation()'::pg_catalog.regprocedure
              THEN function_row.proowner
            ELSE v_service
          END
        )
    ) THEN
      RAISE EXCEPTION 'atomic group pass function authority drifted: %',
        v_signature;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.activate_group_subscription_atomic(uuid,uuid,text,text,text,text,bigint,text)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.cancel_group_subscription_atomic(uuid,uuid)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.read_group_subscription_atomic(uuid,uuid)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.expire_group_subscriptions()',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service group pass RPC execution drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member = v_authenticator
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = v_service
      AND membership.member NOT IN (v_authenticator, v_postgres)
  ) OR EXISTS (
    WITH RECURSIVE service_inheritors(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_service
        AND membership.inherit_option
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inheritors AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM service_inheritors AS inherited
    WHERE inherited.member_oid <> v_postgres
  ) OR EXISTS (
    WITH RECURSIVE service_inherits(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.member = v_service
        AND (membership.inherit_option OR membership.set_option)
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1 FROM service_inherits
  ) OR EXISTS (
    WITH RECURSIVE browser_authority(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_roles AS browser_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = browser_role.oid
       AND (membership.inherit_option OR membership.set_option)
      WHERE browser_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT membership.roleid
      FROM browser_authority AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM browser_authority AS inherited
    WHERE inherited.role_oid IN (v_postgres, v_service)
  ) THEN
    RAISE EXCEPTION 'atomic group pass service-role authority seal drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
