-- Stripe API-tier events are not guaranteed to arrive in order. Persist every
-- reviewed event, derive one terminal-sticky state per subscription, and
-- project the newest still-active subscription onto the profile and active
-- API keys in one transaction.

BEGIN;

SET LOCAL search_path = pg_catalog, pg_temp;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'public.api-tier-stripe-event-ledger:v1',
    0
  )
);

LOCK TABLE public.user_profiles, public.api_keys IN ACCESS SHARE MODE;

DO $preflight$
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
  v_ledger pg_catalog.regclass :=
    pg_catalog.to_regclass('public.api_tier_stripe_event_ledger');
  v_existing_rpc pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.apply_user_api_tier_stripe_event(uuid,text,integer,text,bigint,text,bigint,boolean,boolean,boolean)'
  );
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
    OR v_postgres IS NULL
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
    RAISE EXCEPTION
      'API tier Stripe event ledger requires PostgreSQL 17 and standard Supabase roles';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['public.user_profiles', 'public.api_keys']::text[]
    ) AS required_relation(relation_name)
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.oid =
        pg_catalog.to_regclass(required_relation.relation_name)
    WHERE relation.oid IS NULL
       OR relation.relkind <> 'r'
       OR relation.relpersistence <> 'p'
       OR relation.relispartition
       OR relation.relowner <> v_postgres
       OR NOT relation.relrowsecurity
       OR relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      pg_catalog.to_regclass('public.user_profiles'),
      pg_catalog.to_regclass('public.api_keys')
    )
       OR inheritance.inhparent IN (
         pg_catalog.to_regclass('public.user_profiles'),
         pg_catalog.to_regclass('public.api_keys')
       )
  ) THEN
    RAISE EXCEPTION
      'API tier projection tables must be ordinary postgres-owned RLS tables without FORCE RLS';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.user_profiles'::pg_catalog.regclass,
          'id',
          'uuid'::pg_catalog.regtype,
          true
        ),
        (
          'public.user_profiles'::pg_catalog.regclass,
          'api_tier',
          'text'::pg_catalog.regtype,
          true
        ),
        (
          'public.user_profiles'::pg_catalog.regclass,
          'api_stripe_subscription_id',
          'text'::pg_catalog.regtype,
          false
        ),
        (
          'public.user_profiles'::pg_catalog.regclass,
          'updated_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        (
          'public.api_keys'::pg_catalog.regclass,
          'user_id',
          'uuid'::pg_catalog.regtype,
          true
        ),
        (
          'public.api_keys'::pg_catalog.regclass,
          'active',
          'boolean'::pg_catalog.regtype,
          true
        ),
        (
          'public.api_keys'::pg_catalog.regclass,
          'tier',
          'text'::pg_catalog.regtype,
          true
        ),
        (
          'public.api_keys'::pg_catalog.regclass,
          'daily_limit',
          'integer'::pg_catalog.regtype,
          true
        )
    ) AS required_column(
      relation_oid,
      column_name,
      type_oid,
      required_not_null
    )
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = required_column.relation_oid
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
       OR attribute.attgenerated <> ''
       OR (
         required_column.required_not_null
         AND NOT attribute.attnotnull
       )
  ) THEN
    RAISE EXCEPTION
      'API tier projection columns are missing or incompatible';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname = 'update_user_api_tier'
  ) <> 1
    OR pg_catalog.to_regprocedure(
      'public.update_user_api_tier(uuid,text,text,integer)'
    ) IS NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS routine
      WHERE routine.oid =
        'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure
        AND (
          routine.proowner <> v_postgres
          OR routine.prokind <> 'f'
          OR NOT routine.prosecdef
          OR routine.prorettype <> 'void'::pg_catalog.regtype
          OR routine.proretset
          OR routine.pronargs <> 4
          OR routine.pronargdefaults <> 0
          OR routine.proargnames IS DISTINCT FROM ARRAY[
            'p_user_id',
            'p_api_tier',
            'p_stripe_subscription_id',
            'p_daily_limit'
          ]::text[]
          OR routine.proconfig IS DISTINCT FROM
            ARRAY['search_path=public']::text[]
        )
    )
  THEN
    RAISE EXCEPTION
      'the reviewed legacy API tier updater is missing, overloaded, or incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname = 'apply_user_api_tier_stripe_event'
      AND routine.oid IS DISTINCT FROM v_existing_rpc
  ) THEN
    RAISE EXCEPTION
      'API tier Stripe event authority has an unreviewed overload';
  END IF;

  IF v_existing_rpc IS NOT NULL AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid = v_existing_rpc
      AND routine.proowner <> v_postgres
  ) THEN
    RAISE EXCEPTION
      'existing API tier Stripe event authority has an untrusted owner';
  END IF;

  IF v_ledger IS NOT NULL AND (
    NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_ledger
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
        AND relation.relowner = v_postgres
        AND relation.relrowsecurity
        AND NOT relation.relforcerowsecurity
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_ledger
         OR inheritance.inhparent = v_ledger
    )
    OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          ('livemode', 'boolean'::pg_catalog.regtype, true),
          ('stripe_event_id', 'text'::pg_catalog.regtype, true),
          ('user_id', 'uuid'::pg_catalog.regtype, true),
          ('stripe_subscription_id', 'text'::pg_catalog.regtype, true),
          ('subscription_created', 'bigint'::pg_catalog.regtype, true),
          ('stripe_event_created', 'bigint'::pg_catalog.regtype, true),
          ('api_tier', 'text'::pg_catalog.regtype, true),
          ('daily_limit', 'integer'::pg_catalog.regtype, true),
          ('is_active', 'boolean'::pg_catalog.regtype, true),
          ('is_terminal', 'boolean'::pg_catalog.regtype, true),
          (
            'recorded_at',
            'timestamp with time zone'::pg_catalog.regtype,
            true
          )
      ) AS required_column(column_name, type_oid, required_not_null)
      LEFT JOIN pg_catalog.pg_attribute AS attribute
        ON attribute.attrelid = v_ledger
       AND attribute.attname = required_column.column_name
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
      WHERE attribute.attnum IS NULL
         OR attribute.atttypid <> required_column.type_oid
         OR attribute.attgenerated <> ''
         OR (
           required_column.required_not_null
           AND NOT attribute.attnotnull
         )
    )
  ) THEN
    RAISE EXCEPTION
      'existing API tier Stripe event ledger is incompatible';
  END IF;

  -- This is the exact reviewed Supabase role graph. In particular, browser
  -- SET-role paths and unknown direct/indirect service_role members fail.
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
    WITH RECURSIVE service_authority(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_service
        AND (membership.inherit_option OR membership.set_option)
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_authority AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM service_authority AS inherited
    JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = inherited.member_oid
    WHERE inherited.member_oid NOT IN (v_authenticator, v_postgres)
      AND NOT (
        role_row.rolname = 'cli_login_postgres'
        AND role_row.rolcanlogin
        AND NOT role_row.rolinherit
        AND NOT role_row.rolcreaterole
        AND NOT role_row.rolcreatedb
        AND NOT role_row.rolreplication
        AND NOT role_row.rolbypassrls
        AND NOT role_row.rolsuper
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS managed_membership
          WHERE managed_membership.roleid = v_postgres
            AND managed_membership.member = role_row.oid
            AND NOT managed_membership.admin_option
            AND NOT managed_membership.inherit_option
            AND managed_membership.set_option
        )
      )
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
    RAISE EXCEPTION
      'API tier Stripe event service-role graph is unsafe';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.api_tier_stripe_event_ledger (
  livemode boolean NOT NULL,
  stripe_event_id text NOT NULL,
  user_id uuid NOT NULL,
  stripe_subscription_id text NOT NULL,
  subscription_created bigint NOT NULL,
  stripe_event_created bigint NOT NULL,
  api_tier text NOT NULL,
  daily_limit integer NOT NULL,
  is_active boolean NOT NULL,
  is_terminal boolean NOT NULL,
  recorded_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT api_tier_stripe_event_ledger_pkey
    PRIMARY KEY (livemode, stripe_event_id),
  CONSTRAINT api_tier_stripe_event_ledger_user_fkey
    FOREIGN KEY (user_id)
    REFERENCES public.user_profiles(id)
    ON DELETE CASCADE,
  CONSTRAINT api_tier_stripe_event_ledger_subscription_id_check
    CHECK (
      stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_subscription_id) <= 255
    ),
  CONSTRAINT api_tier_stripe_event_ledger_event_id_check
    CHECK (
      stripe_event_id ~ '^evt_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_event_id) <= 255
    ),
  CONSTRAINT api_tier_stripe_event_ledger_subscription_created_check
    CHECK (
      subscription_created > 0
      AND subscription_created <= 253402300799
    ),
  CONSTRAINT api_tier_stripe_event_ledger_event_created_check
    CHECK (
      stripe_event_created > 0
      AND stripe_event_created <= 253402300799
      AND subscription_created <= stripe_event_created
    ),
  CONSTRAINT api_tier_stripe_event_ledger_tier_check
    CHECK (api_tier IN ('free', 'starter', 'pro')),
  CONSTRAINT api_tier_stripe_event_ledger_daily_limit_check
    CHECK (
      (api_tier = 'free' AND daily_limit = 100)
      OR (api_tier = 'starter' AND daily_limit = 10000)
      OR (api_tier = 'pro' AND daily_limit = 0)
    ),
  CONSTRAINT api_tier_stripe_event_ledger_activity_check
    CHECK (
      (
        is_active
        AND NOT is_terminal
        AND api_tier IN ('starter', 'pro')
      )
      OR (NOT is_active AND api_tier = 'free')
    )
);

ALTER TABLE public.api_tier_stripe_event_ledger OWNER TO postgres;
ALTER TABLE public.api_tier_stripe_event_ledger
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_tier_stripe_event_ledger
  NO FORCE ROW LEVEL SECURITY;

DO $ledger_shape$
DECLARE
  v_ledger pg_catalog.regclass :=
    'public.api_tier_stripe_event_ledger'::pg_catalog.regclass;
  v_expected_constraints jsonb := pg_catalog.jsonb_build_object(
    'api_tier_stripe_event_ledger_activity_check',
    'CHECK (is_active AND NOT is_terminal AND (api_tier = ANY (ARRAY[''starter''::text, ''pro''::text])) OR NOT is_active AND api_tier = ''free''::text)',
    'api_tier_stripe_event_ledger_daily_limit_check',
    'CHECK (api_tier = ''free''::text AND daily_limit = 100 OR api_tier = ''starter''::text AND daily_limit = 10000 OR api_tier = ''pro''::text AND daily_limit = 0)',
    'api_tier_stripe_event_ledger_event_created_check',
    'CHECK (stripe_event_created > 0 AND stripe_event_created <= ''253402300799''::bigint AND subscription_created <= stripe_event_created)',
    'api_tier_stripe_event_ledger_event_id_check',
    'CHECK (stripe_event_id ~ ''^evt_[A-Za-z0-9_]+$''::text AND length(stripe_event_id) <= 255)',
    'api_tier_stripe_event_ledger_pkey',
    'PRIMARY KEY (livemode, stripe_event_id)',
    'api_tier_stripe_event_ledger_subscription_created_check',
    'CHECK (subscription_created > 0 AND subscription_created <= ''253402300799''::bigint)',
    'api_tier_stripe_event_ledger_subscription_id_check',
    'CHECK (stripe_subscription_id ~ ''^sub_[A-Za-z0-9_]+$''::text AND length(stripe_subscription_id) <= 255)',
    'api_tier_stripe_event_ledger_tier_check',
    'CHECK (api_tier = ANY (ARRAY[''free''::text, ''starter''::text, ''pro''::text]))',
    'api_tier_stripe_event_ledger_user_fkey',
    'FOREIGN KEY (user_id) REFERENCES public.user_profiles(id) ON DELETE CASCADE'
  );
  v_actual_constraints jsonb;
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_ledger
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 11 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_ledger
      AND attribute.attnum > 0
      AND (
        attribute.attidentity <> ''
        OR attribute.attgenerated <> ''
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
      ON attribute_default.adrelid = attribute.attrelid
     AND attribute_default.adnum = attribute.attnum
    WHERE attribute.attrelid = v_ledger
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND (
        (
          attribute.attname = 'recorded_at'
          AND pg_catalog.pg_get_expr(
            attribute_default.adbin,
            attribute_default.adrelid,
            true
          ) IS DISTINCT FROM 'clock_timestamp()'
        )
        OR (
          attribute.attname <> 'recorded_at'
          AND attribute_default.oid IS NOT NULL
        )
      )
  ) THEN
    RAISE EXCEPTION
      'API tier Stripe event ledger columns/defaults drifted';
  END IF;

  SELECT pg_catalog.jsonb_object_agg(
    constraint_row.conname,
    pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
  )
  INTO v_actual_constraints
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = v_ledger;

  IF v_actual_constraints IS DISTINCT FROM v_expected_constraints OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND (
        NOT constraint_row.convalidated
        OR constraint_row.condeferrable
        OR constraint_row.condeferred
        OR constraint_row.conparentid <> 0
        OR constraint_row.coninhcount <> 0
        OR NOT constraint_row.conislocal
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_ledger
      AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class = v_ledger
  ) THEN
    RAISE EXCEPTION
      'API tier Stripe event ledger constraint/write shape drifted';
  END IF;
END
$ledger_shape$;

CREATE INDEX IF NOT EXISTS api_tier_stripe_event_ledger_user_subscription_idx
  ON public.api_tier_stripe_event_ledger (
    user_id,
    livemode,
    stripe_subscription_id,
    stripe_event_created DESC
  );

CREATE OR REPLACE FUNCTION public.apply_user_api_tier_stripe_event(
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
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_current_subscription_id text;
  v_inserted integer := 0;
  v_exact_replay boolean := false;
  v_incoming_controls_subscription boolean := false;
  v_desired_subscription_id text;
  v_desired_tier text;
  v_desired_daily_limit integer;
  v_best_active_created bigint;
  v_best_suspended_created bigint;
  v_projection_rows integer := 0;
BEGIN
  IF p_user_id IS NULL
    OR p_api_tier IS NULL
    OR pg_catalog.btrim(p_api_tier) IS DISTINCT FROM p_api_tier
    OR p_daily_limit IS NULL
    OR p_daily_limit < 0
    OR p_stripe_subscription_id IS NULL
    OR pg_catalog.btrim(p_stripe_subscription_id) IS DISTINCT FROM
      p_stripe_subscription_id
    OR p_stripe_subscription_id !~ '^sub_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_subscription_id) > 255
    OR p_subscription_created IS NULL
    OR p_subscription_created <= 0
    OR p_subscription_created > 253402300799
    OR p_stripe_event_id IS NULL
    OR pg_catalog.btrim(p_stripe_event_id) IS DISTINCT FROM p_stripe_event_id
    OR p_stripe_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_event_id) > 255
    OR p_event_created IS NULL
    OR p_event_created <= 0
    OR p_event_created > 253402300799
    OR p_subscription_created > p_event_created
    OR p_is_active IS NULL
    OR p_is_terminal IS NULL
    OR p_livemode IS NULL
    OR (
      p_is_active
      AND p_is_terminal
    )
    OR (
      p_is_active
      AND p_api_tier NOT IN ('starter', 'pro')
    )
    OR (
      NOT p_is_active
      AND p_api_tier <> 'free'
    )
    OR (
      p_api_tier = 'free'
      AND p_daily_limit <> 100
    )
    OR (
      p_api_tier = 'starter'
      AND p_daily_limit <> 10000
    )
    OR (
      p_api_tier = 'pro'
      AND p_daily_limit <> 0
    )
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '22023',
        MESSAGE = 'invalid API tier Stripe event input';
  END IF;

  SELECT profile.api_stripe_subscription_id
  INTO v_current_subscription_id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'P0002',
        MESSAGE = 'API tier Stripe event user profile does not exist';
  END IF;

  -- Serialize one Stripe subscription across users as well as all events for
  -- this user. The profile row lock serializes competing subscriptions.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'api-tier-stripe-subscription:'
        || p_livemode::text
        || ':'
        || p_stripe_subscription_id,
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM public.api_tier_stripe_event_ledger AS ledger
    WHERE ledger.user_id = p_user_id
      AND ledger.livemode IS DISTINCT FROM p_livemode
  ) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'API tier Stripe livemode identity is ambiguous';
  END IF;

  -- The migration intentionally does not invent timestamps for historical
  -- active subscriptions. Their first accepted event must carry the same ID.
  IF v_current_subscription_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.api_tier_stripe_event_ledger AS ledger
      WHERE ledger.user_id = p_user_id
        AND ledger.livemode = p_livemode
        AND ledger.stripe_subscription_id = v_current_subscription_id
    )
    AND p_stripe_subscription_id <> v_current_subscription_id
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'historical API subscription must be seeded by the same Stripe subscription ID';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.api_tier_stripe_event_ledger AS ledger
    WHERE ledger.livemode = p_livemode
      AND ledger.stripe_subscription_id = p_stripe_subscription_id
      AND (
        ledger.user_id <> p_user_id
        OR ledger.subscription_created <> p_subscription_created
      )
  ) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'Stripe subscription ownership or creation identity drifted';
  END IF;

  INSERT INTO public.api_tier_stripe_event_ledger (
    livemode,
    stripe_event_id,
    user_id,
    stripe_subscription_id,
    subscription_created,
    stripe_event_created,
    api_tier,
    daily_limit,
    is_active,
    is_terminal
  ) VALUES (
    p_livemode,
    p_stripe_event_id,
    p_user_id,
    p_stripe_subscription_id,
    p_subscription_created,
    p_event_created,
    p_api_tier,
    p_daily_limit,
    p_is_active,
    p_is_terminal
  )
  ON CONFLICT (livemode, stripe_event_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT
      ledger.user_id = p_user_id
      AND ledger.stripe_subscription_id = p_stripe_subscription_id
      AND ledger.subscription_created = p_subscription_created
      AND ledger.stripe_event_created = p_event_created
      AND ledger.api_tier = p_api_tier
      AND ledger.daily_limit = p_daily_limit
      AND ledger.is_active = p_is_active
      AND ledger.is_terminal = p_is_terminal
    INTO v_exact_replay
    FROM public.api_tier_stripe_event_ledger AS ledger
    WHERE ledger.livemode = p_livemode
      AND ledger.stripe_event_id = p_stripe_event_id;

    IF NOT COALESCE(v_exact_replay, false) THEN
      RAISE EXCEPTION
        USING
          ERRCODE = '40001',
          MESSAGE = 'Stripe event ID replayed with conflicting API tier payload';
    END IF;
  END IF;

  -- Equally-timed events must describe the same state. A terminal event is
  -- permanently sticky; a recoverable suspension may be superseded later.
  IF (
    SELECT pg_catalog.count(
      DISTINCT (
        ledger.api_tier,
        ledger.daily_limit,
        ledger.is_active,
        ledger.is_terminal
      )
    )
    FROM public.api_tier_stripe_event_ledger AS ledger
    WHERE ledger.user_id = p_user_id
      AND ledger.livemode = p_livemode
      AND ledger.stripe_subscription_id = p_stripe_subscription_id
      AND ledger.stripe_event_created = p_event_created
  ) > 1 THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'same-second API subscription events disagree';
  END IF;

  WITH subscription_state AS (
    SELECT DISTINCT ON (ledger.stripe_subscription_id)
      ledger.stripe_subscription_id,
      ledger.subscription_created,
      ledger.stripe_event_id,
      ledger.stripe_event_created,
      ledger.api_tier,
      ledger.daily_limit,
      ledger.is_active,
      ledger.is_terminal
    FROM public.api_tier_stripe_event_ledger AS ledger
    WHERE ledger.user_id = p_user_id
      AND ledger.livemode = p_livemode
    ORDER BY
      ledger.stripe_subscription_id,
      ledger.is_terminal DESC,
      ledger.stripe_event_created DESC,
      ledger.stripe_event_id DESC
  )
  SELECT pg_catalog.max(state.subscription_created)
  INTO v_best_active_created
  FROM subscription_state AS state
  WHERE state.is_active;

  IF v_best_active_created IS NOT NULL AND (
    WITH subscription_state AS (
      SELECT DISTINCT ON (ledger.stripe_subscription_id)
        ledger.stripe_subscription_id,
        ledger.subscription_created,
        ledger.is_active,
        ledger.is_terminal
      FROM public.api_tier_stripe_event_ledger AS ledger
      WHERE ledger.user_id = p_user_id
        AND ledger.livemode = p_livemode
      ORDER BY
        ledger.stripe_subscription_id,
        ledger.is_terminal DESC,
        ledger.stripe_event_created DESC,
        ledger.stripe_event_id DESC
    )
    SELECT pg_catalog.count(*)
    FROM subscription_state AS state
    WHERE state.is_active
      AND state.subscription_created = v_best_active_created
  ) > 1 THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'equally-created active API subscriptions are ambiguous';
  END IF;

  IF v_best_active_created IS NULL THEN
    WITH subscription_state AS (
      SELECT DISTINCT ON (ledger.stripe_subscription_id)
        ledger.stripe_subscription_id,
        ledger.subscription_created,
        ledger.is_active,
        ledger.is_terminal
      FROM public.api_tier_stripe_event_ledger AS ledger
      WHERE ledger.user_id = p_user_id
        AND ledger.livemode = p_livemode
      ORDER BY
        ledger.stripe_subscription_id,
        ledger.is_terminal DESC,
        ledger.stripe_event_created DESC,
        ledger.stripe_event_id DESC
    )
    SELECT pg_catalog.max(state.subscription_created)
    INTO v_best_suspended_created
    FROM subscription_state AS state
    WHERE NOT state.is_active
      AND NOT state.is_terminal;
  END IF;

  IF v_best_suspended_created IS NOT NULL AND (
    WITH subscription_state AS (
      SELECT DISTINCT ON (ledger.stripe_subscription_id)
        ledger.stripe_subscription_id,
        ledger.subscription_created,
        ledger.is_active,
        ledger.is_terminal
      FROM public.api_tier_stripe_event_ledger AS ledger
      WHERE ledger.user_id = p_user_id
        AND ledger.livemode = p_livemode
      ORDER BY
        ledger.stripe_subscription_id,
        ledger.is_terminal DESC,
        ledger.stripe_event_created DESC,
        ledger.stripe_event_id DESC
    )
    SELECT pg_catalog.count(*)
    FROM subscription_state AS state
    WHERE NOT state.is_active
      AND NOT state.is_terminal
      AND state.subscription_created = v_best_suspended_created
  ) > 1 THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'equally-created suspended API subscriptions are ambiguous';
  END IF;

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
      WHERE ledger.user_id = p_user_id
        AND ledger.livemode = p_livemode
      ORDER BY
        ledger.stripe_subscription_id,
        ledger.is_terminal DESC,
        ledger.stripe_event_created DESC,
        ledger.stripe_event_id DESC
    )
    SELECT
      state.stripe_subscription_id,
      state.api_tier,
      state.daily_limit
    INTO
      v_desired_subscription_id,
      v_desired_tier,
      v_desired_daily_limit
    FROM subscription_state AS state
    WHERE state.is_active
      AND state.subscription_created = v_best_active_created;
  ELSIF v_best_suspended_created IS NOT NULL THEN
    WITH subscription_state AS (
      SELECT DISTINCT ON (ledger.stripe_subscription_id)
        ledger.stripe_subscription_id,
        ledger.subscription_created,
        ledger.is_active,
        ledger.is_terminal
      FROM public.api_tier_stripe_event_ledger AS ledger
      WHERE ledger.user_id = p_user_id
        AND ledger.livemode = p_livemode
      ORDER BY
        ledger.stripe_subscription_id,
        ledger.is_terminal DESC,
        ledger.stripe_event_created DESC,
        ledger.stripe_event_id DESC
    )
    SELECT state.stripe_subscription_id
    INTO v_desired_subscription_id
    FROM subscription_state AS state
    WHERE NOT state.is_active
      AND NOT state.is_terminal
      AND state.subscription_created = v_best_suspended_created;
    v_desired_tier := 'free';
    v_desired_daily_limit := 100;
  ELSE
    v_desired_subscription_id := NULL;
    v_desired_tier := 'free';
    v_desired_daily_limit := 100;
  END IF;

  IF v_desired_tier IS NULL OR v_desired_daily_limit IS NULL THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'API tier Stripe event ledger has no deterministic projection';
  END IF;

  WITH subscription_state AS (
    SELECT DISTINCT ON (ledger.stripe_subscription_id)
      ledger.stripe_subscription_id,
      ledger.stripe_event_id
    FROM public.api_tier_stripe_event_ledger AS ledger
    WHERE ledger.user_id = p_user_id
      AND ledger.livemode = p_livemode
    ORDER BY
      ledger.stripe_subscription_id,
      ledger.is_terminal DESC,
      ledger.stripe_event_created DESC,
      ledger.stripe_event_id DESC
  )
  SELECT state.stripe_event_id = p_stripe_event_id
  INTO v_incoming_controls_subscription
  FROM subscription_state AS state
  WHERE state.stripe_subscription_id = p_stripe_subscription_id;

  UPDATE public.user_profiles AS profile
  SET
    api_tier = v_desired_tier,
    api_stripe_subscription_id = v_desired_subscription_id,
    updated_at = pg_catalog.clock_timestamp()
  WHERE profile.id = p_user_id;

  GET DIAGNOSTICS v_projection_rows = ROW_COUNT;
  IF v_projection_rows <> 1 THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'API tier profile projection lost its locked identity';
  END IF;

  UPDATE public.api_keys AS api_key
  SET
    tier = v_desired_tier,
    daily_limit = v_desired_daily_limit
  WHERE api_key.user_id = p_user_id
    AND api_key.active;

  IF v_exact_replay THEN
    RETURN 'idempotent';
  END IF;
  IF NOT COALESCE(v_incoming_controls_subscription, false) THEN
    RETURN 'stale';
  END IF;
  IF p_is_active
    AND v_desired_subscription_id IS DISTINCT FROM
      p_stripe_subscription_id
  THEN
    RETURN 'not_current';
  END IF;
  IF NOT p_is_active
    AND v_current_subscription_id IS DISTINCT FROM
      p_stripe_subscription_id
  THEN
    RETURN 'not_current';
  END IF;
  RETURN 'applied';
END
$function$;

ALTER FUNCTION public.apply_user_api_tier_stripe_event(
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

COMMENT ON FUNCTION public.apply_user_api_tier_stripe_event(
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
) IS 'Service-only Stripe API-tier event ledger with terminal-sticky and recoverable suspended states.';

-- Converge the new ledger to owner-only table/column ACLs, including replay
-- after an unexpected direct grantee or column grant.
DO $revoke_nonowner_ledger_acl$
DECLARE
  v_relation pg_catalog.regclass :=
    'public.api_tier_stripe_event_ledger'::pg_catalog.regclass;
  v_owner oid;
  v_grantee oid;
  v_grantee_name name;
  v_grantee_sql text;
  v_column name;
  v_privilege text;
BEGIN
  SELECT relation.relowner
  INTO v_owner
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = v_relation;

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = v_relation
      AND acl_entry.grantee <> v_owner
  LOOP
    IF v_grantee = 0::oid THEN
      v_grantee_sql := 'PUBLIC';
    ELSE
      SELECT role_row.rolname
      INTO v_grantee_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;
      IF v_grantee_name IS NULL THEN
        RAISE EXCEPTION 'dangling API tier ledger ACL grantee oid: %', v_grantee;
      END IF;
      v_grantee_sql := pg_catalog.format('%I', v_grantee_name);
    END IF;
    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.api_tier_stripe_event_ledger FROM %s CASCADE',
      v_grantee_sql
    );
  END LOOP;

  FOR v_column, v_grantee, v_privilege IN
    SELECT
      attribute.attname,
      acl_entry.grantee,
      acl_entry.privilege_type
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_owner
  LOOP
    IF v_grantee = 0::oid THEN
      v_grantee_sql := 'PUBLIC';
    ELSE
      SELECT role_row.rolname
      INTO v_grantee_name
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_grantee;
      IF v_grantee_name IS NULL THEN
        RAISE EXCEPTION
          'dangling API tier ledger column ACL grantee oid: %',
          v_grantee;
      END IF;
      v_grantee_sql := pg_catalog.format('%I', v_grantee_name);
    END IF;
    EXECUTE pg_catalog.format(
      'REVOKE %s (%I) ON TABLE public.api_tier_stripe_event_ledger FROM %s CASCADE',
      v_privilege,
      v_column,
      v_grantee_sql
    );
  END LOOP;
END
$revoke_nonowner_ledger_acl$;

-- Revoke the former unsequenced updater and every unexpected ACL on the new
-- authority. update_user_api_tier remains owner-only for catalog continuity.
DO $revoke_nonowner_routine_acl$
DECLARE
  v_routine pg_catalog.regprocedure;
  v_routine_sql text;
  v_owner oid;
  v_grantee oid;
  v_grantee_name name;
  v_grantee_sql text;
BEGIN
  FOREACH v_routine IN ARRAY ARRAY[
    'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure,
    'public.apply_user_api_tier_stripe_event(uuid,text,integer,text,bigint,text,bigint,boolean,boolean,boolean)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT
      pg_catalog.format(
        '%I.%I(%s)',
        namespace.nspname,
        routine.proname,
        pg_catalog.pg_get_function_identity_arguments(routine.oid)
      ),
      routine.proowner
    INTO v_routine_sql, v_owner
    FROM pg_catalog.pg_proc AS routine
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = routine.pronamespace
    WHERE routine.oid = v_routine;

    FOR v_grantee IN
      SELECT DISTINCT acl_entry.grantee
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )
      ) AS acl_entry
      WHERE routine.oid = v_routine
        AND acl_entry.grantee <> v_owner
    LOOP
      IF v_grantee = 0::oid THEN
        v_grantee_sql := 'PUBLIC';
      ELSE
        SELECT role_row.rolname
        INTO v_grantee_name
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.oid = v_grantee;
        IF v_grantee_name IS NULL THEN
          RAISE EXCEPTION
            'dangling API tier routine ACL grantee oid: %',
            v_grantee;
        END IF;
        v_grantee_sql := pg_catalog.format('%I', v_grantee_name);
      END IF;
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s CASCADE',
        v_routine_sql,
        v_grantee_sql
      );
    END LOOP;
  END LOOP;
END
$revoke_nonowner_routine_acl$;

GRANT EXECUTE
  ON FUNCTION public.apply_user_api_tier_stripe_event(
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
  v_ledger pg_catalog.regclass :=
    'public.api_tier_stripe_event_ledger'::pg_catalog.regclass;
  v_rpc pg_catalog.regprocedure :=
    'public.apply_user_api_tier_stripe_event(uuid,text,integer,text,bigint,text,bigint,boolean,boolean,boolean)'::pg_catalog.regprocedure;
  v_old_rpc pg_catalog.regprocedure :=
    'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY[
        'public.user_profiles',
        'public.api_keys',
        'public.api_tier_stripe_event_ledger'
      ]::text[]
    ) AS required_relation(relation_name)
    LEFT JOIN pg_catalog.pg_class AS relation
      ON relation.oid =
        pg_catalog.to_regclass(required_relation.relation_name)
    WHERE relation.oid IS NULL
       OR relation.relkind <> 'r'
       OR relation.relpersistence <> 'p'
       OR relation.relispartition
       OR relation.relowner <> v_postgres
       OR NOT relation.relrowsecurity
       OR relation.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION
      'API tier Stripe event relation owner/RLS seal drifted';
  END IF;

  IF EXISTS (
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
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_ledger
  ) THEN
    RAISE EXCEPTION
      'API tier Stripe event ledger is not owner-only';
  END IF;

  IF (
    SELECT pg_catalog.jsonb_object_agg(
      index_relation.relname,
      pg_catalog.pg_get_indexdef(index_row.indexrelid, 0, true)
    )
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    WHERE index_row.indrelid = v_ledger
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND NOT index_row.indisexclusion
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
  ) IS DISTINCT FROM pg_catalog.jsonb_build_object(
    'api_tier_stripe_event_ledger_pkey',
    'CREATE UNIQUE INDEX api_tier_stripe_event_ledger_pkey ON public.api_tier_stripe_event_ledger USING btree (livemode, stripe_event_id)',
    'api_tier_stripe_event_ledger_user_subscription_idx',
    'CREATE INDEX api_tier_stripe_event_ledger_user_subscription_idx ON public.api_tier_stripe_event_ledger USING btree (user_id, livemode, stripe_subscription_id, stripe_event_created DESC)'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = v_ledger
      AND (
        NOT index_row.indisvalid
        OR NOT index_row.indisready
        OR NOT index_row.indislive
        OR index_row.indisexclusion
        OR index_row.indpred IS NOT NULL
        OR index_row.indexprs IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'API tier Stripe event ledger indexes drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname = 'apply_user_api_tier_stripe_event'
  ) <> 1 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid = v_rpc
      AND (
        routine.proowner <> v_postgres
        OR routine.prokind <> 'f'
        OR NOT routine.prosecdef
        OR routine.prorettype <> 'text'::pg_catalog.regtype
        OR routine.proretset
        OR routine.provolatile <> 'v'
        OR routine.proparallel <> 'u'
        OR routine.proisstrict
        OR routine.pronargs <> 10
        OR routine.pronargdefaults <> 0
        OR routine.proargnames IS DISTINCT FROM ARRAY[
          'p_user_id',
          'p_api_tier',
          'p_daily_limit',
          'p_stripe_subscription_id',
          'p_subscription_created',
          'p_stripe_event_id',
          'p_event_created',
          'p_is_active',
          'p_is_terminal',
          'p_livemode'
        ]::text[]
        OR routine.proconfig IS DISTINCT FROM ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off'
        ]::text[]
      )
  ) THEN
    RAISE EXCEPTION
      'API tier Stripe event authority catalog seal drifted';
  END IF;

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
  ) OR (
    SELECT pg_catalog.array_agg(
      acl_entry.privilege_type
      ORDER BY acl_entry.privilege_type
    )
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS acl_entry
    WHERE routine.oid = v_rpc
      AND acl_entry.grantee = v_service
      AND NOT acl_entry.is_grantable
  ) IS DISTINCT FROM ARRAY['EXECUTE']::text[]
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )
      ) AS acl_entry
      WHERE routine.oid = v_rpc
        AND acl_entry.grantee = v_service
        AND (
          acl_entry.is_grantable
          OR acl_entry.grantor <> v_postgres
        )
    )
    OR pg_catalog.has_function_privilege('anon', v_rpc, 'EXECUTE')
    OR pg_catalog.has_function_privilege(
      'authenticated',
      v_rpc,
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'service_role',
      v_rpc,
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION
      'API tier Stripe event authority is not exact service-only EXECUTE';
  END IF;

  IF EXISTS (
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
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    v_old_rpc,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_old_rpc,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_old_rpc,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'legacy unsequenced API tier updater is not owner-only';
  END IF;

  -- Repeat the exact role-graph proof after all DDL and grants.
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
    WITH RECURSIVE service_authority(member_oid) AS (
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      WHERE membership.roleid = v_service
        AND (membership.inherit_option OR membership.set_option)
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_authority AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.inherit_option OR membership.set_option
    )
    SELECT 1
    FROM service_authority AS inherited
    JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = inherited.member_oid
    WHERE inherited.member_oid NOT IN (v_authenticator, v_postgres)
      AND NOT (
        role_row.rolname = 'cli_login_postgres'
        AND role_row.rolcanlogin
        AND NOT role_row.rolinherit
        AND NOT role_row.rolcreaterole
        AND NOT role_row.rolcreatedb
        AND NOT role_row.rolreplication
        AND NOT role_row.rolbypassrls
        AND NOT role_row.rolsuper
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS managed_membership
          WHERE managed_membership.roleid = v_postgres
            AND managed_membership.member = role_row.oid
            AND NOT managed_membership.admin_option
            AND NOT managed_membership.inherit_option
            AND managed_membership.set_option
        )
      )
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
    RAISE EXCEPTION
      'API tier Stripe event service-role seal drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
