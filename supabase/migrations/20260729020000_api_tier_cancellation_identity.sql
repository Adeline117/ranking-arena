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
  v_reservations pg_catalog.regclass :=
    pg_catalog.to_regclass('public.api_tier_checkout_reservations');
  v_existing_rpc pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.apply_user_api_tier_stripe_event(uuid,uuid,uuid,text,uuid,text,text,integer,text,bigint,text,bigint,boolean,boolean,boolean,text,text,text,text)'
  );
  v_existing_persisted_rpc pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.apply_user_api_tier_persisted_non_grant_event(text,text,text,bigint,text,bigint,boolean,boolean)'
  );
  v_existing_key_rpc pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.create_user_api_key_with_current_entitlement(uuid,text,text)'
  );
  v_existing_reserve_rpc pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.reserve_api_tier_checkout_atomic(uuid,boolean,text,text,text)'
    );
  v_existing_bind_rpc pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.bind_api_tier_checkout_session_atomic(uuid,uuid,boolean,text,text,text,text,bigint)'
    );
  v_existing_release_rpc pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.release_api_tier_checkout_reservation_atomic(uuid,uuid,boolean,text,text,text,bigint)'
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
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname =
        'apply_user_api_tier_persisted_non_grant_event'
      AND routine.oid IS DISTINCT FROM v_existing_persisted_rpc
  ) THEN
    RAISE EXCEPTION
      'persisted API tier non-grant authority has an unreviewed overload';
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
          'stripe_customer_id',
          'text'::pg_catalog.regtype,
          false
        ),
        (
          'public.user_profiles'::pg_catalog.regclass,
          'deleted_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        (
          'public.user_profiles'::pg_catalog.regclass,
          'banned_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        (
          'public.user_profiles'::pg_catalog.regclass,
          'is_banned',
          'boolean'::pg_catalog.regtype,
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
          'id',
          'uuid'::pg_catalog.regtype,
          true
        ),
        (
          'public.api_keys'::pg_catalog.regclass,
          'user_id',
          'uuid'::pg_catalog.regtype,
          true
        ),
        (
          'public.api_keys'::pg_catalog.regclass,
          'key',
          'text'::pg_catalog.regtype,
          true
        ),
        (
          'public.api_keys'::pg_catalog.regclass,
          'name',
          'text'::pg_catalog.regtype,
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
        ),
        (
          'public.api_keys'::pg_catalog.regclass,
          'request_count_today',
          'integer'::pg_catalog.regtype,
          true
        ),
        (
          'public.api_keys'::pg_catalog.regclass,
          'last_used_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        (
          'public.api_keys'::pg_catalog.regclass,
          'revoked_at',
          'timestamp with time zone'::pg_catalog.regtype,
          false
        ),
        (
          'public.api_keys'::pg_catalog.regclass,
          'created_at',
          'timestamp with time zone'::pg_catalog.regtype,
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

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname =
        'create_user_api_key_with_current_entitlement'
      AND routine.oid IS DISTINCT FROM v_existing_key_rpc
  ) THEN
    RAISE EXCEPTION
      'API key entitlement authority has an unreviewed overload';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'reserve_api_tier_checkout_atomic'::name,
          v_existing_reserve_rpc
        ),
        (
          'bind_api_tier_checkout_session_atomic'::name,
          v_existing_bind_rpc
        ),
        (
          'release_api_tier_checkout_reservation_atomic'::name,
          v_existing_release_rpc
        )
    ) AS expected(routine_name, routine_oid)
    JOIN pg_catalog.pg_proc AS routine
      ON routine.pronamespace = 'public'::pg_catalog.regnamespace
     AND routine.proname = expected.routine_name
    WHERE routine.oid IS DISTINCT FROM expected.routine_oid
  ) THEN
    RAISE EXCEPTION
      'API tier checkout reservation authority has an unreviewed overload';
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

  IF v_existing_persisted_rpc IS NOT NULL AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid = v_existing_persisted_rpc
      AND routine.proowner <> v_postgres
  ) THEN
    RAISE EXCEPTION
      'existing persisted API tier non-grant authority has an untrusted owner';
  END IF;

  IF v_existing_key_rpc IS NOT NULL AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid = v_existing_key_rpc
      AND routine.proowner <> v_postgres
  ) THEN
    RAISE EXCEPTION
      'existing API key entitlement authority has an untrusted owner';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid IN (
      v_existing_reserve_rpc,
      v_existing_bind_rpc,
      v_existing_release_rpc
    )
      AND routine.proowner <> v_postgres
  ) THEN
    RAISE EXCEPTION
      'existing API tier checkout reservation authority has an untrusted owner';
  END IF;

  IF v_reservations IS NOT NULL AND (
    NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_reservations
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
      WHERE inheritance.inhrelid = v_reservations
         OR inheritance.inhparent = v_reservations
    )
  ) THEN
    RAISE EXCEPTION
      'existing API tier checkout reservation relation is incompatible';
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
          ('metadata_user_id', 'uuid'::pg_catalog.regtype, true),
          (
            'metadata_supabase_user_id',
            'uuid'::pg_catalog.regtype,
            true
          ),
          ('stripe_customer_id', 'text'::pg_catalog.regtype, true),
          ('checkout_reservation_id', 'uuid'::pg_catalog.regtype, false),
          ('stripe_price_id', 'text'::pg_catalog.regtype, true),
          ('stripe_subscription_id', 'text'::pg_catalog.regtype, true),
          ('subscription_created', 'bigint'::pg_catalog.regtype, true),
          ('stripe_event_created', 'bigint'::pg_catalog.regtype, true),
          ('api_tier', 'text'::pg_catalog.regtype, true),
          ('daily_limit', 'integer'::pg_catalog.regtype, true),
          ('is_active', 'boolean'::pg_catalog.regtype, true),
          ('is_terminal', 'boolean'::pg_catalog.regtype, true),
          ('identity_source', 'text'::pg_catalog.regtype, true),
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

  -- This is the exact reviewed Supabase role graph. INHERIT and SET are
  -- executable authority, while ADMIN can mint either authority for another
  -- member; every recursive edge must therefore include all three options.
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
        AND (
          membership.admin_option
          OR membership.inherit_option
          OR membership.set_option
        )
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_authority AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.admin_option
         OR membership.inherit_option
         OR membership.set_option
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
        AND (
          membership.admin_option
          OR membership.inherit_option
          OR membership.set_option
        )
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      WHERE membership.admin_option
         OR membership.inherit_option
         OR membership.set_option
    )
    SELECT 1 FROM service_inherits
  ) OR EXISTS (
    WITH RECURSIVE browser_authority(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_roles AS browser_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = browser_role.oid
       AND (
         membership.admin_option
         OR membership.inherit_option
         OR membership.set_option
       )
      WHERE browser_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT membership.roleid
      FROM browser_authority AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
      WHERE membership.admin_option
         OR membership.inherit_option
         OR membership.set_option
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

CREATE TABLE IF NOT EXISTS public.api_tier_checkout_reservations (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL,
  livemode boolean NOT NULL,
  stripe_customer_id text NOT NULL,
  api_plan text NOT NULL,
  stripe_price_id text NOT NULL,
  status text NOT NULL,
  checkout_expires_at bigint NOT NULL,
  lease_expires_at timestamp with time zone NOT NULL,
  checkout_session_id text,
  stripe_subscription_id text,
  release_reason text,
  release_event_id text,
  release_event_created bigint,
  created_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  updated_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  released_at timestamp with time zone,
  CONSTRAINT api_tier_checkout_reservations_customer_check
    CHECK (
      stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_customer_id) <= 255
    ),
  CONSTRAINT api_tier_checkout_reservations_plan_check
    CHECK (api_plan IN ('starter', 'pro')),
  CONSTRAINT api_tier_checkout_reservations_price_check
    CHECK (
      stripe_price_id ~ '^price_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_price_id) <= 255
    ),
  CONSTRAINT api_tier_checkout_reservations_expiry_check
    CHECK (
      checkout_expires_at > 0
      AND checkout_expires_at <= 253402300799
      AND lease_expires_at <=
        pg_catalog.to_timestamp(checkout_expires_at)
    ),
  CONSTRAINT api_tier_checkout_reservations_session_check
    CHECK (
      checkout_session_id IS NULL
      OR (
        checkout_session_id ~ '^cs_[A-Za-z0-9_]+$'
        AND pg_catalog.length(checkout_session_id) <= 255
      )
    ),
  CONSTRAINT api_tier_checkout_reservations_subscription_check
    CHECK (
      stripe_subscription_id IS NULL
      OR (
        stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
        AND pg_catalog.length(stripe_subscription_id) <= 255
      )
    ),
  CONSTRAINT api_tier_checkout_reservations_release_event_check
    CHECK (
      release_event_id IS NULL
      OR (
        release_event_id ~ '^evt_[A-Za-z0-9_]+$'
        AND pg_catalog.length(release_event_id) <= 255
        AND release_event_created > 0
        AND release_event_created <= 253402300799
      )
    ),
  CONSTRAINT api_tier_checkout_reservations_state_check
    CHECK (
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
    )
);

ALTER TABLE public.api_tier_checkout_reservations OWNER TO postgres;
ALTER TABLE public.api_tier_checkout_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_tier_checkout_reservations NO FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS
  api_tier_checkout_reservations_active_user_mode_idx
  ON public.api_tier_checkout_reservations (user_id, livemode)
  WHERE status IN ('reserved', 'bound');
CREATE UNIQUE INDEX IF NOT EXISTS
  api_tier_checkout_reservations_session_idx
  ON public.api_tier_checkout_reservations (
    livemode,
    checkout_session_id
  )
  WHERE checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS
  api_tier_checkout_reservations_subscription_idx
  ON public.api_tier_checkout_reservations (
    livemode,
    stripe_subscription_id
  )
  WHERE stripe_subscription_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS
  api_tier_checkout_reservations_release_event_idx
  ON public.api_tier_checkout_reservations (
    livemode,
    release_event_id
  )
  WHERE release_event_id IS NOT NULL;

DO $reservation_shape$
DECLARE
  v_reservations pg_catalog.regclass :=
    'public.api_tier_checkout_reservations'::pg_catalog.regclass;
  v_actual_columns jsonb;
  v_actual_constraints jsonb;
  v_expected_columns jsonb := pg_catalog.jsonb_build_object(
    'api_plan', pg_catalog.jsonb_build_array('text', true, NULL),
    'checkout_expires_at',
      pg_catalog.jsonb_build_array('bigint', true, NULL),
    'checkout_session_id',
      pg_catalog.jsonb_build_array('text', false, NULL),
    'created_at',
      pg_catalog.jsonb_build_array(
        'timestamp with time zone',
        true,
        'clock_timestamp()'
      ),
    'id',
      pg_catalog.jsonb_build_array(
        'uuid',
        true,
        'gen_random_uuid()'
      ),
    'lease_expires_at',
      pg_catalog.jsonb_build_array(
        'timestamp with time zone',
        true,
        NULL
      ),
    'livemode', pg_catalog.jsonb_build_array('boolean', true, NULL),
    'release_event_created',
      pg_catalog.jsonb_build_array('bigint', false, NULL),
    'release_event_id',
      pg_catalog.jsonb_build_array('text', false, NULL),
    'release_reason',
      pg_catalog.jsonb_build_array('text', false, NULL),
    'released_at',
      pg_catalog.jsonb_build_array(
        'timestamp with time zone',
        false,
        NULL
      ),
    'status', pg_catalog.jsonb_build_array('text', true, NULL),
    'stripe_customer_id',
      pg_catalog.jsonb_build_array('text', true, NULL),
    'stripe_price_id',
      pg_catalog.jsonb_build_array('text', true, NULL),
    'stripe_subscription_id',
      pg_catalog.jsonb_build_array('text', false, NULL),
    'updated_at',
      pg_catalog.jsonb_build_array(
        'timestamp with time zone',
        true,
        'clock_timestamp()'
      ),
    'user_id', pg_catalog.jsonb_build_array('uuid', true, NULL)
  );
  v_expected_constraints jsonb := pg_catalog.jsonb_build_object(
    'api_tier_checkout_reservations_customer_check',
    'CHECK (stripe_customer_id ~ ''^cus_[A-Za-z0-9_]+$''::text AND length(stripe_customer_id) <= 255)',
    'api_tier_checkout_reservations_expiry_check',
    'CHECK (checkout_expires_at > 0 AND checkout_expires_at <= ''253402300799''::bigint AND lease_expires_at <= to_timestamp(checkout_expires_at::double precision))',
    'api_tier_checkout_reservations_pkey',
    'PRIMARY KEY (id)',
    'api_tier_checkout_reservations_plan_check',
    'CHECK (api_plan = ANY (ARRAY[''starter''::text, ''pro''::text]))',
    'api_tier_checkout_reservations_price_check',
    'CHECK (stripe_price_id ~ ''^price_[A-Za-z0-9_]+$''::text AND length(stripe_price_id) <= 255)',
    'api_tier_checkout_reservations_release_event_check',
    'CHECK (release_event_id IS NULL OR release_event_id ~ ''^evt_[A-Za-z0-9_]+$''::text AND length(release_event_id) <= 255 AND release_event_created > 0 AND release_event_created <= ''253402300799''::bigint)',
    'api_tier_checkout_reservations_session_check',
    'CHECK (checkout_session_id IS NULL OR checkout_session_id ~ ''^cs_[A-Za-z0-9_]+$''::text AND length(checkout_session_id) <= 255)',
    'api_tier_checkout_reservations_state_check',
    'CHECK (status = ''reserved''::text AND checkout_session_id IS NULL AND stripe_subscription_id IS NULL AND release_reason IS NULL AND release_event_id IS NULL AND release_event_created IS NULL AND released_at IS NULL OR status = ''bound''::text AND checkout_session_id IS NOT NULL AND stripe_subscription_id IS NULL AND release_reason IS NULL AND release_event_id IS NULL AND release_event_created IS NULL AND released_at IS NULL OR status = ''converted''::text AND checkout_session_id IS NOT NULL AND stripe_subscription_id IS NOT NULL AND release_reason IS NULL AND release_event_id IS NULL AND release_event_created IS NULL AND released_at IS NULL OR status = ''released''::text AND checkout_session_id IS NOT NULL AND stripe_subscription_id IS NULL AND release_reason = ''checkout_session_expired''::text AND release_event_id IS NOT NULL AND release_event_created IS NOT NULL AND released_at IS NOT NULL OR status = ''expired''::text AND checkout_session_id IS NULL AND stripe_subscription_id IS NULL AND release_reason = ''lease_expired''::text AND release_event_id IS NULL AND release_event_created IS NULL AND released_at IS NOT NULL)',
    'api_tier_checkout_reservations_subscription_check',
    'CHECK (stripe_subscription_id IS NULL OR stripe_subscription_id ~ ''^sub_[A-Za-z0-9_]+$''::text AND length(stripe_subscription_id) <= 255)'
  );
BEGIN
  SELECT pg_catalog.jsonb_object_agg(
    attribute.attname,
    pg_catalog.jsonb_build_array(
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
      attribute.attnotnull,
      pg_catalog.pg_get_expr(
        attribute_default.adbin,
        attribute_default.adrelid,
        true
      )
    )
  )
  INTO v_actual_columns
  FROM pg_catalog.pg_attribute AS attribute
  LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
    ON attribute_default.adrelid = attribute.attrelid
   AND attribute_default.adnum = attribute.attnum
  WHERE attribute.attrelid = v_reservations
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT pg_catalog.jsonb_object_agg(
    constraint_row.conname,
    pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
  )
  INTO v_actual_constraints
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = v_reservations;

  IF v_actual_columns IS DISTINCT FROM v_expected_columns OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_reservations
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND (
        attribute.attidentity <> ''
        OR attribute.attgenerated <> ''
      )
  ) THEN
    RAISE EXCEPTION
      'API tier checkout reservation columns/defaults drifted';
  END IF;

  IF v_actual_constraints IS DISTINCT FROM v_expected_constraints OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_reservations
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
    WHERE trigger_row.tgrelid = v_reservations
      AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class = v_reservations
  ) THEN
    RAISE EXCEPTION
      'API tier checkout reservation constraint/write shape drifted';
  END IF;
END
$reservation_shape$;

CREATE TABLE IF NOT EXISTS public.api_tier_stripe_event_ledger (
  livemode boolean NOT NULL,
  stripe_event_id text NOT NULL,
  user_id uuid NOT NULL,
  metadata_user_id uuid NOT NULL,
  metadata_supabase_user_id uuid NOT NULL,
  stripe_customer_id text NOT NULL,
  checkout_reservation_id uuid,
  stripe_price_id text NOT NULL,
  stripe_subscription_id text NOT NULL,
  subscription_created bigint NOT NULL,
  stripe_event_created bigint NOT NULL,
  api_tier text NOT NULL,
  daily_limit integer NOT NULL,
  is_active boolean NOT NULL,
  is_terminal boolean NOT NULL,
  identity_source text NOT NULL,
  recorded_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT api_tier_stripe_event_ledger_pkey
    PRIMARY KEY (livemode, stripe_event_id),
  CONSTRAINT api_tier_stripe_event_ledger_identity_check
    CHECK (
      metadata_user_id = user_id
      AND metadata_supabase_user_id = user_id
    ),
  CONSTRAINT api_tier_stripe_event_ledger_customer_check
    CHECK (
      stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_customer_id) <= 255
    ),
  CONSTRAINT api_tier_stripe_event_ledger_reservation_fkey
    FOREIGN KEY (checkout_reservation_id)
    REFERENCES public.api_tier_checkout_reservations(id),
  CONSTRAINT api_tier_stripe_event_ledger_price_check
    CHECK (
      stripe_price_id ~ '^price_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_price_id) <= 255
    ),
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
  CONSTRAINT api_tier_stripe_event_ledger_source_check
    CHECK (
      identity_source IN ('signed_metadata', 'persisted_subscription')
      AND (
        identity_source = 'signed_metadata'
        OR (
          NOT is_active
          AND api_tier = 'free'
        )
      )
    ),
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
    'api_tier_stripe_event_ledger_customer_check',
    'CHECK (stripe_customer_id ~ ''^cus_[A-Za-z0-9_]+$''::text AND length(stripe_customer_id) <= 255)',
    'api_tier_stripe_event_ledger_daily_limit_check',
    'CHECK (api_tier = ''free''::text AND daily_limit = 100 OR api_tier = ''starter''::text AND daily_limit = 10000 OR api_tier = ''pro''::text AND daily_limit = 0)',
    'api_tier_stripe_event_ledger_event_created_check',
    'CHECK (stripe_event_created > 0 AND stripe_event_created <= ''253402300799''::bigint AND subscription_created <= stripe_event_created)',
    'api_tier_stripe_event_ledger_event_id_check',
    'CHECK (stripe_event_id ~ ''^evt_[A-Za-z0-9_]+$''::text AND length(stripe_event_id) <= 255)',
    'api_tier_stripe_event_ledger_identity_check',
    'CHECK (metadata_user_id = user_id AND metadata_supabase_user_id = user_id)',
    'api_tier_stripe_event_ledger_pkey',
    'PRIMARY KEY (livemode, stripe_event_id)',
    'api_tier_stripe_event_ledger_price_check',
    'CHECK (stripe_price_id ~ ''^price_[A-Za-z0-9_]+$''::text AND length(stripe_price_id) <= 255)',
    'api_tier_stripe_event_ledger_reservation_fkey',
    'FOREIGN KEY (checkout_reservation_id) REFERENCES public.api_tier_checkout_reservations(id)',
    'api_tier_stripe_event_ledger_source_check',
    'CHECK ((identity_source = ANY (ARRAY[''signed_metadata''::text, ''persisted_subscription''::text])) AND (identity_source = ''signed_metadata''::text OR NOT is_active AND api_tier = ''free''::text))',
    'api_tier_stripe_event_ledger_subscription_created_check',
    'CHECK (subscription_created > 0 AND subscription_created <= ''253402300799''::bigint)',
    'api_tier_stripe_event_ledger_subscription_id_check',
    'CHECK (stripe_subscription_id ~ ''^sub_[A-Za-z0-9_]+$''::text AND length(stripe_subscription_id) <= 255)',
    'api_tier_stripe_event_ledger_tier_check',
    'CHECK (api_tier = ANY (ARRAY[''free''::text, ''starter''::text, ''pro''::text]))'
  );
  v_actual_constraints jsonb;
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_ledger
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 17 OR EXISTS (
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

-- Account deletion and successful financial reversals permanently retire the
-- exact Stripe subscription that existed at that boundary. This ledger has no
-- profile/auth foreign key: a late signed event must remain blocked after both
-- recovery and hard deletion.
CREATE TABLE IF NOT EXISTS public.api_tier_subscription_blocks (
  livemode boolean NOT NULL,
  stripe_subscription_id text NOT NULL,
  block_kind text NOT NULL,
  user_id uuid NOT NULL,
  stripe_customer_id text,
  blocked_at timestamp with time zone NOT NULL
    DEFAULT pg_catalog.clock_timestamp(),
  CONSTRAINT api_tier_subscription_blocks_pkey
    PRIMARY KEY (livemode, stripe_subscription_id, block_kind),
  CONSTRAINT api_tier_subscription_blocks_subscription_check
    CHECK (
      stripe_subscription_id ~ '^sub_[A-Za-z0-9_]+$'
      AND pg_catalog.length(stripe_subscription_id) <= 255
    ),
  CONSTRAINT api_tier_subscription_blocks_kind_check
    CHECK (block_kind IN ('account_deletion', 'financial_reversal')),
  CONSTRAINT api_tier_subscription_blocks_customer_check
    CHECK (
      stripe_customer_id IS NULL
      OR (
        stripe_customer_id ~ '^cus_[A-Za-z0-9_]+$'
        AND pg_catalog.length(stripe_customer_id) <= 255
      )
    )
);

ALTER TABLE public.api_tier_subscription_blocks OWNER TO postgres;
ALTER TABLE public.api_tier_subscription_blocks
  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.api_tier_subscription_blocks
  NO FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS api_tier_subscription_blocks_user_idx
  ON public.api_tier_subscription_blocks (
    user_id,
    block_kind,
    blocked_at DESC
  );

DO $subscription_block_shape$
DECLARE
  v_blocks pg_catalog.regclass :=
    'public.api_tier_subscription_blocks'::pg_catalog.regclass;
  v_actual_columns jsonb;
  v_actual_constraints jsonb;
  v_expected_columns jsonb := pg_catalog.jsonb_build_object(
    'block_kind', pg_catalog.jsonb_build_array('text', true, NULL),
    'blocked_at',
      pg_catalog.jsonb_build_array(
        'timestamp with time zone',
        true,
        'clock_timestamp()'
      ),
    'livemode', pg_catalog.jsonb_build_array('boolean', true, NULL),
    'stripe_customer_id',
      pg_catalog.jsonb_build_array('text', false, NULL),
    'stripe_subscription_id',
      pg_catalog.jsonb_build_array('text', true, NULL),
    'user_id', pg_catalog.jsonb_build_array('uuid', true, NULL)
  );
  v_expected_constraints jsonb := pg_catalog.jsonb_build_object(
    'api_tier_subscription_blocks_customer_check',
    'CHECK (stripe_customer_id IS NULL OR stripe_customer_id ~ ''^cus_[A-Za-z0-9_]+$''::text AND length(stripe_customer_id) <= 255)',
    'api_tier_subscription_blocks_kind_check',
    'CHECK (block_kind = ANY (ARRAY[''account_deletion''::text, ''financial_reversal''::text]))',
    'api_tier_subscription_blocks_pkey',
    'PRIMARY KEY (livemode, stripe_subscription_id, block_kind)',
    'api_tier_subscription_blocks_subscription_check',
    'CHECK (stripe_subscription_id ~ ''^sub_[A-Za-z0-9_]+$''::text AND length(stripe_subscription_id) <= 255)'
  );
BEGIN
  SELECT pg_catalog.jsonb_object_agg(
    attribute.attname,
    pg_catalog.jsonb_build_array(
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
      attribute.attnotnull,
      pg_catalog.pg_get_expr(
        attribute_default.adbin,
        attribute_default.adrelid,
        true
      )
    )
  )
  INTO v_actual_columns
  FROM pg_catalog.pg_attribute AS attribute
  LEFT JOIN pg_catalog.pg_attrdef AS attribute_default
    ON attribute_default.adrelid = attribute.attrelid
   AND attribute_default.adnum = attribute.attnum
  WHERE attribute.attrelid = v_blocks
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT pg_catalog.jsonb_object_agg(
    constraint_row.conname,
    pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
  )
  INTO v_actual_constraints
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = v_blocks;

  IF v_actual_columns IS DISTINCT FROM v_expected_columns OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_blocks
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND (
        attribute.attidentity <> ''
        OR attribute.attgenerated <> ''
      )
  ) THEN
    RAISE EXCEPTION
      'API tier subscription block columns/defaults drifted';
  END IF;

  IF v_actual_constraints IS DISTINCT FROM v_expected_constraints OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_blocks
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
    WHERE trigger_row.tgrelid = v_blocks
      AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class = v_blocks
  ) THEN
    RAISE EXCEPTION
      'API tier subscription block constraint/write shape drifted';
  END IF;
END
$subscription_block_shape$;

COMMENT ON TABLE public.api_tier_subscription_blocks IS
  'Owner-only durable retirement ledger for exact API-tier Stripe subscriptions; intentionally survives profile/auth deletion.';

CREATE OR REPLACE FUNCTION public.schedule_account_deletion_with_billing_blocks(
  p_user_id uuid,
  p_reason text,
  p_scheduled_at timestamp with time zone,
  p_recovery_token_hash text,
  p_stripe_customer_id text,
  p_stripe_subscription_ids text[]
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
  v_normalized_subscription_ids text[];
  v_all_block_subscription_ids text[];
  v_subscription_id text;
  v_profile_customer_id text;
  v_profile_subscription_id text;
  v_deleted_at timestamp with time zone;
BEGIN
  SELECT COALESCE(
    pg_catalog.array_agg(candidate.subscription_id ORDER BY candidate.subscription_id),
    ARRAY[]::text[]
  )
  INTO v_normalized_subscription_ids
  FROM (
    SELECT DISTINCT supplied.subscription_id
    FROM pg_catalog.unnest(
      COALESCE(p_stripe_subscription_ids, ARRAY[]::text[])
    ) AS supplied(subscription_id)
  ) AS candidate;

  IF p_user_id IS NULL
    OR p_scheduled_at IS NULL
    OR p_recovery_token_hash IS NULL
    OR p_recovery_token_hash !~ '^[0-9a-f]{64}$'
    OR p_stripe_subscription_ids IS NULL
    OR pg_catalog.cardinality(p_stripe_subscription_ids) > 1000
    OR p_stripe_subscription_ids IS DISTINCT FROM
      v_normalized_subscription_ids
    OR (
      p_stripe_customer_id IS NOT NULL
      AND (
        pg_catalog.btrim(p_stripe_customer_id) IS DISTINCT FROM
          p_stripe_customer_id
        OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_stripe_customer_id) > 255
      )
    )
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.unnest(
        v_normalized_subscription_ids
      ) AS supplied(subscription_id)
      WHERE supplied.subscription_id IS NULL
        OR pg_catalog.btrim(supplied.subscription_id) IS DISTINCT FROM
          supplied.subscription_id
        OR supplied.subscription_id !~ '^sub_[A-Za-z0-9_]+$'
        OR pg_catalog.length(supplied.subscription_id) > 255
    )
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '22023',
        MESSAGE = 'invalid account deletion billing identity';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'pro-official-group-user:' || p_user_id::text,
      0
    )
  );
  IF p_stripe_customer_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'stripe-customer-owner:' || p_stripe_customer_id,
        0
      )
    );
  END IF;

  -- The per-user advisory lock makes these local identities stable against
  -- every API-tier writer before the sorted subscription lock fan-out.
  SELECT COALESCE(
    pg_catalog.array_agg(candidate.subscription_id ORDER BY candidate.subscription_id),
    ARRAY[]::text[]
  )
  INTO v_all_block_subscription_ids
  FROM (
    SELECT supplied.subscription_id
    FROM pg_catalog.unnest(
      v_normalized_subscription_ids
    ) AS supplied(subscription_id)
    UNION
    SELECT profile.api_stripe_subscription_id
    FROM public.user_profiles AS profile
    WHERE profile.id = p_user_id
      AND profile.api_stripe_subscription_id IS NOT NULL
    UNION
    SELECT ledger.stripe_subscription_id
    FROM public.api_tier_stripe_event_ledger AS ledger
    WHERE ledger.user_id = p_user_id
    UNION
    SELECT reservation.stripe_subscription_id
    FROM public.api_tier_checkout_reservations AS reservation
    WHERE reservation.user_id = p_user_id
      AND reservation.stripe_subscription_id IS NOT NULL
  ) AS candidate(subscription_id);

  FOREACH v_subscription_id IN ARRAY v_all_block_subscription_ids
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'api-tier-stripe-subscription:false:' || v_subscription_id,
        0
      )
    );
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'api-tier-stripe-subscription:true:' || v_subscription_id,
        0
      )
    );
  END LOOP;

  SELECT
    profile.stripe_customer_id,
    profile.api_stripe_subscription_id
  INTO
    v_profile_customer_id,
    v_profile_subscription_id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'P0002',
        MESSAGE = 'account deletion profile does not exist';
  END IF;
  IF v_profile_customer_id IS NULL
    AND p_stripe_customer_id IS NOT NULL
  THEN
    IF EXISTS (
      SELECT 1
      FROM public.user_profiles AS other_profile
      WHERE other_profile.id <> p_user_id
        AND other_profile.stripe_customer_id =
          p_stripe_customer_id
    ) THEN
      RAISE EXCEPTION
        USING
          ERRCODE = '40001',
          MESSAGE = 'account deletion Stripe customer is already owned';
    END IF;

    UPDATE public.user_profiles AS profile
    SET
      stripe_customer_id = p_stripe_customer_id,
      updated_at = pg_catalog.clock_timestamp()
    WHERE profile.id = p_user_id
      AND profile.stripe_customer_id IS NULL;

    IF NOT FOUND THEN
      RAISE EXCEPTION
        USING
          ERRCODE = '40001',
          MESSAGE = 'account deletion Stripe customer backfill raced';
    END IF;
    v_profile_customer_id := p_stripe_customer_id;
  END IF;
  IF v_profile_customer_id IS DISTINCT FROM p_stripe_customer_id THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'account deletion Stripe customer identity drifted';
  END IF;

  -- The caller supplies every subscription observed remotely. The locked
  -- profile, converted reservations, and sealed event ledger add any local
  -- identities that a retrieve/list race omitted. Unknown-mode profile IDs
  -- are retired in both Stripe modes; known ledger/reservation IDs retain
  -- their exact mode.
  INSERT INTO public.api_tier_subscription_blocks (
    livemode,
    stripe_subscription_id,
    block_kind,
    user_id,
    stripe_customer_id
  )
  SELECT DISTINCT
    candidate.livemode,
    candidate.stripe_subscription_id,
    'account_deletion',
    p_user_id,
    p_stripe_customer_id
  FROM (
    SELECT mode_value.livemode, supplied.subscription_id
    FROM pg_catalog.unnest(
      v_normalized_subscription_ids
    ) AS supplied(subscription_id)
    CROSS JOIN (
      VALUES (false), (true)
    ) AS mode_value(livemode)
    UNION ALL
    SELECT mode_value.livemode, v_profile_subscription_id
    FROM (
      VALUES (false), (true)
    ) AS mode_value(livemode)
    WHERE v_profile_subscription_id IS NOT NULL
    UNION ALL
    SELECT ledger.livemode, ledger.stripe_subscription_id
    FROM public.api_tier_stripe_event_ledger AS ledger
    WHERE ledger.user_id = p_user_id
    UNION ALL
    SELECT reservation.livemode, reservation.stripe_subscription_id
    FROM public.api_tier_checkout_reservations AS reservation
    WHERE reservation.user_id = p_user_id
      AND reservation.stripe_subscription_id IS NOT NULL
  ) AS candidate(livemode, stripe_subscription_id)
  ON CONFLICT (livemode, stripe_subscription_id, block_kind)
    DO NOTHING;

  IF EXISTS (
    SELECT 1
    FROM public.api_tier_subscription_blocks AS block
    WHERE block.block_kind = 'account_deletion'
      AND block.stripe_subscription_id IN (
        SELECT supplied.subscription_id
        FROM pg_catalog.unnest(
          v_normalized_subscription_ids
        ) AS supplied(subscription_id)
        UNION
        SELECT v_profile_subscription_id
        WHERE v_profile_subscription_id IS NOT NULL
        UNION
        SELECT ledger.stripe_subscription_id
        FROM public.api_tier_stripe_event_ledger AS ledger
        WHERE ledger.user_id = p_user_id
        UNION
        SELECT reservation.stripe_subscription_id
        FROM public.api_tier_checkout_reservations AS reservation
        WHERE reservation.user_id = p_user_id
          AND reservation.stripe_subscription_id IS NOT NULL
      )
      AND (
        block.user_id <> p_user_id
        OR (
          block.stripe_customer_id IS NOT NULL
          AND p_stripe_customer_id IS NOT NULL
          AND block.stripe_customer_id <> p_stripe_customer_id
        )
      )
  ) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'account deletion subscription block identity drifted';
  END IF;

  v_deleted_at := public.schedule_account_deletion(
    p_user_id,
    p_reason,
    p_scheduled_at,
    p_recovery_token_hash
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'scheduled',
    'user_id', p_user_id,
    'deleted_at', v_deleted_at,
    'deletion_scheduled_at', p_scheduled_at,
    'stripe_customer_id', p_stripe_customer_id,
    'stripe_subscription_ids', v_normalized_subscription_ids
  );
END
$function$;

ALTER FUNCTION public.schedule_account_deletion_with_billing_blocks(
  uuid,
  text,
  timestamp with time zone,
  text,
  text,
  text[]
) OWNER TO postgres;

COMMENT ON FUNCTION public.schedule_account_deletion_with_billing_blocks(
  uuid,
  text,
  timestamp with time zone,
  text,
  text,
  text[]
) IS 'Service-only account-deletion boundary that permanently retires all exact current API-tier Stripe subscriptions before reversible deletion.';

CREATE OR REPLACE FUNCTION public.reserve_api_tier_checkout_atomic(
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_api_plan text,
  p_stripe_price_id text
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
  v_profile record;
  v_reservation public.api_tier_checkout_reservations%ROWTYPE;
  v_checkout_expires_at bigint;
BEGIN
  IF p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_api_plan NOT IN ('starter', 'pro')
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '22023',
        MESSAGE = 'invalid API tier checkout reservation input';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
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

  SELECT
    profile.api_tier,
    profile.api_stripe_subscription_id,
    profile.stripe_customer_id,
    profile.deleted_at,
    profile.banned_at,
    profile.is_banned
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'P0002',
        MESSAGE = 'API tier checkout owner profile does not exist';
  END IF;
  IF v_profile.deleted_at IS NOT NULL
    OR v_profile.banned_at IS NOT NULL
    OR COALESCE(v_profile.is_banned, false)
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '42501',
        MESSAGE = 'inactive API tier checkout owner';
  END IF;
  IF v_profile.stripe_customer_id IS DISTINCT FROM
    p_stripe_customer_id
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'API tier checkout customer ownership drifted';
  END IF;
  IF v_profile.api_tier <> 'free'
    OR v_profile.api_stripe_subscription_id IS NOT NULL
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_subscribed'
    );
  END IF;

  UPDATE public.api_tier_checkout_reservations AS reservation
  SET
    status = 'expired',
    release_reason = 'lease_expired',
    released_at = pg_catalog.clock_timestamp(),
    updated_at = pg_catalog.clock_timestamp()
  WHERE reservation.user_id = p_user_id
    AND reservation.livemode = p_livemode
    AND reservation.status = 'reserved'
    AND reservation.checkout_session_id IS NULL
    AND reservation.lease_expires_at <= pg_catalog.clock_timestamp();

  SELECT reservation.*
  INTO v_reservation
  FROM public.api_tier_checkout_reservations AS reservation
  WHERE reservation.user_id = p_user_id
    AND reservation.livemode = p_livemode
    AND reservation.status IN ('reserved', 'bound')
  FOR UPDATE;

  IF FOUND THEN
    IF v_reservation.stripe_customer_id <> p_stripe_customer_id THEN
      RAISE EXCEPTION
        USING
          ERRCODE = '40001',
          MESSAGE = 'existing API tier checkout customer identity drifted';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'existing',
      'reservation_id', v_reservation.id,
      'api_plan', v_reservation.api_plan,
      'stripe_price_id', v_reservation.stripe_price_id,
      'checkout_expires_at', v_reservation.checkout_expires_at,
      'checkout_session_id', v_reservation.checkout_session_id
    );
  END IF;

  v_checkout_expires_at := pg_catalog.floor(
    extract(
      epoch FROM pg_catalog.clock_timestamp() + interval '45 minutes'
    )
  )::bigint;

  INSERT INTO public.api_tier_checkout_reservations (
    user_id,
    livemode,
    stripe_customer_id,
    api_plan,
    stripe_price_id,
    status,
    checkout_expires_at,
    lease_expires_at
  ) VALUES (
    p_user_id,
    p_livemode,
    p_stripe_customer_id,
    p_api_plan,
    p_stripe_price_id,
    'reserved',
    v_checkout_expires_at,
    pg_catalog.clock_timestamp() + interval '15 minutes'
  )
  RETURNING * INTO v_reservation;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'reserved',
    'reservation_id', v_reservation.id,
    'api_plan', v_reservation.api_plan,
    'stripe_price_id', v_reservation.stripe_price_id,
    'checkout_expires_at', v_reservation.checkout_expires_at,
    'checkout_session_id', NULL
  );
END
$function$;

ALTER FUNCTION public.reserve_api_tier_checkout_atomic(
  uuid,
  boolean,
  text,
  text,
  text
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.bind_api_tier_checkout_session_atomic(
  p_reservation_id uuid,
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_api_plan text,
  p_stripe_price_id text,
  p_checkout_session_id text,
  p_checkout_expires_at bigint
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
  v_profile_customer_id text;
  v_profile_deleted_at timestamp with time zone;
  v_profile_banned_at timestamp with time zone;
  v_profile_is_banned boolean;
  v_reservation public.api_tier_checkout_reservations%ROWTYPE;
BEGIN
  IF p_reservation_id IS NULL
    OR p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_api_plan NOT IN ('starter', 'pro')
    OR p_stripe_price_id IS NULL
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
    OR p_checkout_session_id IS NULL
    OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_checkout_session_id) > 255
    OR p_checkout_expires_at IS NULL
    OR p_checkout_expires_at <= 0
    OR p_checkout_expires_at > 253402300799
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '22023',
        MESSAGE = 'invalid API tier checkout session binding input';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
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

  SELECT
    profile.stripe_customer_id,
    profile.deleted_at,
    profile.banned_at,
    profile.is_banned
  INTO
    v_profile_customer_id,
    v_profile_deleted_at,
    v_profile_banned_at,
    v_profile_is_banned
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;
  IF NOT FOUND
    OR v_profile_customer_id IS DISTINCT FROM p_stripe_customer_id
    OR v_profile_deleted_at IS NOT NULL
    OR v_profile_banned_at IS NOT NULL
    OR COALESCE(v_profile_is_banned, false)
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'API tier checkout owner changed before Session binding';
  END IF;

  SELECT reservation.*
  INTO v_reservation
  FROM public.api_tier_checkout_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_reservation.user_id <> p_user_id
    OR v_reservation.livemode <> p_livemode
    OR v_reservation.stripe_customer_id <> p_stripe_customer_id
    OR v_reservation.api_plan <> p_api_plan
    OR v_reservation.stripe_price_id <> p_stripe_price_id
    OR v_reservation.checkout_expires_at <> p_checkout_expires_at
    OR v_reservation.status IN ('released', 'expired')
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'API tier checkout reservation changed before Session binding';
  END IF;

  IF v_reservation.checkout_session_id IS NOT NULL THEN
    IF v_reservation.checkout_session_id <> p_checkout_session_id THEN
      RAISE EXCEPTION
        USING
          ERRCODE = '40001',
          MESSAGE = 'API tier checkout reservation has another Session';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'status',
      CASE
        WHEN v_reservation.status = 'converted' THEN 'converted'
        ELSE 'already_bound'
      END
    );
  END IF;

  UPDATE public.api_tier_checkout_reservations AS reservation
  SET
    checkout_session_id = p_checkout_session_id,
    status = CASE
      WHEN reservation.status = 'converted' THEN 'converted'
      ELSE 'bound'
    END,
    updated_at = pg_catalog.clock_timestamp()
  WHERE reservation.id = p_reservation_id;

  RETURN pg_catalog.jsonb_build_object(
    'status',
    CASE
      WHEN v_reservation.status = 'converted' THEN 'converted'
      ELSE 'bound'
    END
  );
END
$function$;

ALTER FUNCTION public.bind_api_tier_checkout_session_atomic(
  uuid,
  uuid,
  boolean,
  text,
  text,
  text,
  text,
  bigint
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.release_api_tier_checkout_reservation_atomic(
  p_reservation_id uuid,
  p_user_id uuid,
  p_livemode boolean,
  p_stripe_customer_id text,
  p_checkout_session_id text,
  p_stripe_event_id text,
  p_stripe_event_created bigint
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
BEGIN
  IF p_reservation_id IS NULL
    OR p_user_id IS NULL
    OR p_livemode IS NULL
    OR p_stripe_customer_id IS NULL
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_checkout_session_id IS NULL
    OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_checkout_session_id) > 255
    OR p_stripe_event_id IS NULL
    OR p_stripe_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_event_id) > 255
    OR p_stripe_event_created IS NULL
    OR p_stripe_event_created <= 0
    OR p_stripe_event_created > 253402300799
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '22023',
        MESSAGE = 'invalid API tier checkout release input';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
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

  SELECT reservation.*
  INTO v_reservation
  FROM public.api_tier_checkout_reservations AS reservation
  WHERE reservation.id = p_reservation_id
  FOR UPDATE;

  IF NOT FOUND
    OR v_reservation.user_id <> p_user_id
    OR v_reservation.livemode <> p_livemode
    OR v_reservation.stripe_customer_id <> p_stripe_customer_id
    OR (
      v_reservation.checkout_session_id IS NOT NULL
      AND v_reservation.checkout_session_id <> p_checkout_session_id
    )
    OR v_reservation.stripe_subscription_id IS NOT NULL
    OR v_reservation.status IN ('converted', 'expired')
    OR p_stripe_event_created < pg_catalog.floor(
      extract(epoch FROM v_reservation.created_at)
    )::bigint
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'API tier checkout signed release identity drifted';
  END IF;

  IF v_reservation.status = 'released' THEN
    IF v_reservation.checkout_session_id = p_checkout_session_id
      AND v_reservation.release_event_id = p_stripe_event_id
      AND v_reservation.release_event_created =
        p_stripe_event_created
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'already_released'
      );
    END IF;
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'API tier checkout release event replay conflicted';
  END IF;

  UPDATE public.api_tier_checkout_reservations AS reservation
  SET
    status = 'released',
    checkout_session_id = p_checkout_session_id,
    release_reason = 'checkout_session_expired',
    release_event_id = p_stripe_event_id,
    release_event_created = p_stripe_event_created,
    released_at = pg_catalog.clock_timestamp(),
    updated_at = pg_catalog.clock_timestamp()
  WHERE reservation.id = p_reservation_id;

  RETURN pg_catalog.jsonb_build_object('status', 'released');
END
$function$;

ALTER FUNCTION public.release_api_tier_checkout_reservation_atomic(
  uuid,
  uuid,
  boolean,
  text,
  text,
  text,
  bigint
) OWNER TO postgres;

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
AS $function$
DECLARE
  v_current_subscription_id text;
  v_current_customer_id text;
  v_subject_missing boolean := false;
  v_subject_deleted boolean := false;
  v_subject_inactive boolean := false;
  v_subscription_blocked boolean := false;
  v_inserted integer := 0;
  v_exact_replay boolean := false;
  v_incoming_controls_subscription boolean := false;
  v_desired_subscription_id text;
  v_desired_tier text;
  v_desired_daily_limit integer;
  v_best_active_created bigint;
  v_best_suspended_created bigint;
  v_projection_rows integer := 0;
  v_reservation public.api_tier_checkout_reservations%ROWTYPE;
BEGIN
  IF p_user_id IS NULL
    OR p_metadata_user_id IS DISTINCT FROM p_user_id
    OR p_metadata_supabase_user_id IS DISTINCT FROM p_user_id
    OR p_stripe_customer_id IS NULL
    OR pg_catalog.btrim(p_stripe_customer_id) IS DISTINCT FROM
      p_stripe_customer_id
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_price_id IS NULL
    OR pg_catalog.btrim(p_stripe_price_id) IS DISTINCT FROM
      p_stripe_price_id
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
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
      p_checkout_reservation_id IS NULL
      AND (
        p_checkout_session_id IS NOT NULL
        OR p_checkout_api_plan IS NOT NULL
        OR p_checkout_price_id IS NOT NULL
      )
    )
    OR (
      p_checkout_reservation_id IS NOT NULL
      AND p_identity_source = 'signed_metadata'
      AND (
        p_checkout_session_id IS NULL
        OR pg_catalog.btrim(p_checkout_session_id) IS DISTINCT FROM
          p_checkout_session_id
        OR p_checkout_session_id !~ '^cs_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_checkout_session_id) > 255
        OR p_checkout_api_plan NOT IN ('starter', 'pro')
        OR p_checkout_price_id IS NULL
        OR pg_catalog.btrim(p_checkout_price_id) IS DISTINCT FROM
          p_checkout_price_id
        OR p_checkout_price_id !~ '^price_[A-Za-z0-9_]+$'
        OR pg_catalog.length(p_checkout_price_id) > 255
      )
    )
    OR p_identity_source IS NULL
    OR p_identity_source NOT IN (
      'signed_metadata',
      'persisted_subscription'
    )
    OR (
      p_identity_source = 'persisted_subscription'
      AND (
        p_is_active
        OR p_api_tier <> 'free'
        OR p_checkout_session_id IS NOT NULL
        OR p_checkout_api_plan IS NOT NULL
        OR p_checkout_price_id IS NOT NULL
      )
    )
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

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
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

  SELECT
    profile.api_stripe_subscription_id,
    profile.stripe_customer_id,
    profile.deleted_at IS NOT NULL,
    (
      profile.deleted_at IS NOT NULL
      OR profile.banned_at IS NOT NULL
      OR COALESCE(profile.is_banned, false)
    )
  INTO
    v_current_subscription_id,
    v_current_customer_id,
    v_subject_deleted,
    v_subject_inactive
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  v_subject_missing := NOT FOUND;
  v_subject_deleted := v_subject_missing OR v_subject_deleted;

  IF NOT v_subject_missing
    AND v_current_customer_id IS DISTINCT FROM p_stripe_customer_id
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'Stripe customer ownership changed before API entitlement projection';
  END IF;

  IF p_checkout_reservation_id IS NULL THEN
    IF v_current_subscription_id IS DISTINCT FROM p_stripe_subscription_id
      AND NOT EXISTS (
        SELECT 1
        FROM public.api_tier_stripe_event_ledger AS ledger
        WHERE ledger.user_id = p_user_id
          AND ledger.livemode = p_livemode
          AND ledger.stripe_subscription_id =
            p_stripe_subscription_id
          AND ledger.checkout_reservation_id IS NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.api_tier_subscription_blocks AS block
        WHERE block.user_id = p_user_id
          AND block.livemode = p_livemode
          AND block.stripe_subscription_id =
            p_stripe_subscription_id
          AND (
            block.stripe_customer_id IS NULL
            OR block.stripe_customer_id = p_stripe_customer_id
          )
      )
    THEN
      RAISE EXCEPTION
        USING
          ERRCODE = '40001',
          MESSAGE = 'new API subscription is missing its checkout reservation identity';
    END IF;
  ELSE
    SELECT reservation.*
    INTO v_reservation
    FROM public.api_tier_checkout_reservations AS reservation
    WHERE reservation.id = p_checkout_reservation_id
    FOR UPDATE;

    IF NOT FOUND
      OR v_reservation.user_id <> p_user_id
      OR v_reservation.livemode <> p_livemode
      OR v_reservation.stripe_customer_id <> p_stripe_customer_id
      OR v_reservation.checkout_session_id IS NULL
    THEN
      RAISE EXCEPTION
        USING
          ERRCODE = '40001',
          MESSAGE = 'API checkout reservation identity drifted';
    END IF;

    IF p_identity_source = 'signed_metadata' THEN
      IF v_reservation.checkout_session_id <> p_checkout_session_id
        OR v_reservation.api_plan <> p_checkout_api_plan
        OR v_reservation.stripe_price_id <> p_checkout_price_id
        OR v_reservation.status NOT IN ('bound', 'converted')
        OR (
          p_is_active
          AND (
            v_reservation.api_plan <> p_api_tier
            OR v_reservation.stripe_price_id <>
              p_stripe_price_id
          )
        )
        OR (
          v_reservation.stripe_subscription_id IS NOT NULL
          AND v_reservation.stripe_subscription_id <>
            p_stripe_subscription_id
        )
      THEN
        RAISE EXCEPTION
          USING
            ERRCODE = '40001',
            MESSAGE = 'API checkout Session confirmation drifted';
      END IF;

      IF v_reservation.status = 'bound' THEN
        UPDATE public.api_tier_checkout_reservations AS reservation
        SET
          status = 'converted',
          stripe_subscription_id = p_stripe_subscription_id,
          updated_at = pg_catalog.clock_timestamp()
        WHERE reservation.id = p_checkout_reservation_id;
      END IF;
    ELSIF v_reservation.status <> 'converted'
      OR v_reservation.stripe_subscription_id <>
        p_stripe_subscription_id
    THEN
      RAISE EXCEPTION
        USING
          ERRCODE = '40001',
          MESSAGE = 'persisted API checkout subscription identity drifted';
    END IF;
  END IF;

  IF p_is_active AND EXISTS (
    SELECT 1
    FROM public.api_tier_stripe_event_ledger AS ledger
    WHERE ledger.user_id = p_user_id
      AND ledger.livemode = p_livemode
      AND ledger.stripe_subscription_id =
        p_stripe_subscription_id
      AND ledger.is_active
      AND (
        ledger.stripe_price_id <> p_stripe_price_id
        OR ledger.api_tier <> p_api_tier
        OR ledger.daily_limit <> p_daily_limit
      )
  ) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'API plan or price change requires separate paid authority';
  END IF;

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
        OR ledger.metadata_user_id <> p_metadata_user_id
        OR ledger.metadata_supabase_user_id <>
          p_metadata_supabase_user_id
        OR ledger.stripe_customer_id <> p_stripe_customer_id
        OR ledger.checkout_reservation_id IS DISTINCT FROM
          p_checkout_reservation_id
        OR ledger.subscription_created <> p_subscription_created
      )
  ) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'Stripe subscription ownership or creation identity drifted';
  END IF;

  -- A subscription first observed after deletion can be the result of a
  -- Checkout completion racing the deletion scan. Once its signed
  -- reservation/ledger identity is proven above, retire it permanently too.
  IF v_subject_deleted THEN
    INSERT INTO public.api_tier_subscription_blocks (
      livemode,
      stripe_subscription_id,
      block_kind,
      user_id,
      stripe_customer_id
    ) VALUES (
      p_livemode,
      p_stripe_subscription_id,
      'account_deletion',
      p_user_id,
      p_stripe_customer_id
    )
    ON CONFLICT (livemode, stripe_subscription_id, block_kind)
      DO NOTHING;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.api_tier_subscription_blocks AS block
    WHERE block.livemode = p_livemode
      AND block.stripe_subscription_id = p_stripe_subscription_id
      AND (
        block.user_id <> p_user_id
        OR (
          block.stripe_customer_id IS NOT NULL
          AND block.stripe_customer_id <> p_stripe_customer_id
        )
      )
  ) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'API subscription block identity drifted';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.api_tier_subscription_blocks AS block
    WHERE block.user_id = p_user_id
      AND block.livemode = p_livemode
      AND block.stripe_subscription_id = p_stripe_subscription_id
  )
  INTO v_subscription_blocked;

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
    p_livemode,
    p_stripe_event_id,
    p_user_id,
    p_metadata_user_id,
    p_metadata_supabase_user_id,
    p_stripe_customer_id,
    p_checkout_reservation_id,
    p_stripe_price_id,
    p_stripe_subscription_id,
    p_subscription_created,
    p_event_created,
    p_api_tier,
    p_daily_limit,
    p_is_active,
    p_is_terminal,
    p_identity_source
  )
  ON CONFLICT (livemode, stripe_event_id) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    SELECT
      ledger.user_id = p_user_id
      AND ledger.metadata_user_id = p_metadata_user_id
      AND ledger.metadata_supabase_user_id =
        p_metadata_supabase_user_id
      AND ledger.stripe_customer_id = p_stripe_customer_id
      AND ledger.checkout_reservation_id IS NOT DISTINCT FROM
        p_checkout_reservation_id
      AND ledger.stripe_price_id = p_stripe_price_id
      AND ledger.stripe_subscription_id = p_stripe_subscription_id
      AND ledger.subscription_created = p_subscription_created
      AND ledger.stripe_event_created = p_event_created
      AND ledger.api_tier = p_api_tier
      AND ledger.daily_limit = p_daily_limit
      AND ledger.is_active = p_is_active
      AND ledger.is_terminal = p_is_terminal
      AND ledger.identity_source = p_identity_source
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

  -- Equally-timed paid events must agree on the paid plan. Stripe timestamps
  -- have only second precision, so a terminal or suspended delivery can
  -- legitimately share a second with an active delivery. Those fail closed
  -- below: terminal is sticky, then suspension wins an equal-time tie.
  IF (
    SELECT pg_catalog.count(
      DISTINCT (
        ledger.api_tier,
        ledger.daily_limit
      )
    )
    FROM public.api_tier_stripe_event_ledger AS ledger
    WHERE ledger.user_id = p_user_id
      AND ledger.livemode = p_livemode
      AND ledger.stripe_subscription_id = p_stripe_subscription_id
      AND ledger.stripe_event_created = p_event_created
      AND ledger.is_active
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
      AND NOT EXISTS (
        SELECT 1
        FROM public.api_tier_subscription_blocks AS block
        WHERE block.user_id = p_user_id
          AND block.livemode = p_livemode
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
        AND NOT EXISTS (
          SELECT 1
          FROM public.api_tier_subscription_blocks AS block
          WHERE block.user_id = p_user_id
            AND block.livemode = p_livemode
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
        AND NOT EXISTS (
          SELECT 1
          FROM public.api_tier_subscription_blocks AS block
          WHERE block.user_id = p_user_id
            AND block.livemode = p_livemode
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
        AND NOT EXISTS (
          SELECT 1
          FROM public.api_tier_subscription_blocks AS block
          WHERE block.user_id = p_user_id
            AND block.livemode = p_livemode
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
        AND NOT EXISTS (
          SELECT 1
          FROM public.api_tier_subscription_blocks AS block
          WHERE block.user_id = p_user_id
            AND block.livemode = p_livemode
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
        AND NOT EXISTS (
          SELECT 1
          FROM public.api_tier_subscription_blocks AS block
          WHERE block.user_id = p_user_id
            AND block.livemode = p_livemode
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

  -- A signed Stripe event remains durable after soft or hard account deletion,
  -- but it can never recreate live quota. Deleted subscriptions are retired in
  -- the independent block ledger, so recovery may grant only a distinct new
  -- subscription created through a fresh checkout.
  IF v_subject_missing OR v_subject_inactive THEN
    v_desired_tier := 'free';
    v_desired_daily_limit := 100;
  END IF;
  IF v_subject_deleted OR v_subscription_blocked THEN
    v_desired_subscription_id := NULL;
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
      ledger.is_active ASC,
      ledger.stripe_event_id DESC
  )
  SELECT state.stripe_event_id = p_stripe_event_id
  INTO v_incoming_controls_subscription
  FROM subscription_state AS state
  WHERE state.stripe_subscription_id = p_stripe_subscription_id;

  IF NOT v_subject_missing THEN
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
      daily_limit = v_desired_daily_limit,
      active = CASE
        WHEN v_subject_inactive THEN false
        ELSE api_key.active
      END,
      revoked_at = CASE
        WHEN v_subject_inactive THEN
          COALESCE(api_key.revoked_at, pg_catalog.clock_timestamp())
        ELSE api_key.revoked_at
      END
    WHERE api_key.user_id = p_user_id
      AND api_key.active;
  END IF;

  IF v_subject_missing THEN
    RETURN 'subject_deleted';
  END IF;

  IF v_exact_replay THEN
    RETURN 'idempotent';
  END IF;
  IF v_subscription_blocked THEN
    RETURN 'blocked';
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
) OWNER TO postgres;

COMMENT ON FUNCTION public.apply_user_api_tier_stripe_event(
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
) IS 'Service-only Stripe API-tier event ledger with explicit signed or persisted non-grant provenance.';

CREATE OR REPLACE FUNCTION public.apply_user_api_tier_persisted_non_grant_event(
  p_stripe_customer_id text,
  p_stripe_price_id text,
  p_stripe_subscription_id text,
  p_subscription_created bigint,
  p_stripe_event_id text,
  p_event_created bigint,
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
  v_user_id uuid;
  v_metadata_user_id uuid;
  v_metadata_supabase_user_id uuid;
  v_checkout_reservation_id uuid;
BEGIN
  IF p_stripe_customer_id IS NULL
    OR pg_catalog.btrim(p_stripe_customer_id) IS DISTINCT FROM
      p_stripe_customer_id
    OR p_stripe_customer_id !~ '^cus_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_customer_id) > 255
    OR p_stripe_price_id IS NULL
    OR pg_catalog.btrim(p_stripe_price_id) IS DISTINCT FROM
      p_stripe_price_id
    OR p_stripe_price_id !~ '^price_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_stripe_price_id) > 255
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
    OR p_is_terminal IS NULL
    OR p_livemode IS NULL
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '22023',
        MESSAGE = 'invalid persisted API tier non-grant event input';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pro-official-group-assignment', 0)
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

  IF EXISTS (
    SELECT 1
    FROM public.api_tier_stripe_event_ledger AS ledger
    WHERE ledger.livemode = p_livemode
      AND ledger.stripe_subscription_id = p_stripe_subscription_id
      AND (
        ledger.stripe_customer_id <> p_stripe_customer_id
        OR ledger.subscription_created <> p_subscription_created
      )
  ) THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'persisted API subscription identity drifted';
  END IF;

  SELECT
    ledger.user_id,
    ledger.metadata_user_id,
    ledger.metadata_supabase_user_id,
    ledger.checkout_reservation_id
  INTO
    v_user_id,
    v_metadata_user_id,
    v_metadata_supabase_user_id,
    v_checkout_reservation_id
  FROM public.api_tier_stripe_event_ledger AS ledger
  WHERE ledger.livemode = p_livemode
    AND ledger.stripe_subscription_id = p_stripe_subscription_id
    AND ledger.stripe_customer_id = p_stripe_customer_id
    AND ledger.subscription_created = p_subscription_created
  ORDER BY
    ledger.stripe_event_created DESC,
    ledger.stripe_event_id DESC
  LIMIT 1;

  IF NOT FOUND THEN
    SELECT
      profile.id,
      profile.id,
      profile.id
    INTO
      v_user_id,
      v_metadata_user_id,
      v_metadata_supabase_user_id
    FROM public.user_profiles AS profile
    WHERE profile.stripe_customer_id = p_stripe_customer_id
      AND profile.api_stripe_subscription_id =
        p_stripe_subscription_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN 'not_api';
    END IF;
    v_checkout_reservation_id := NULL;
  END IF;

  RETURN public.apply_user_api_tier_stripe_event(
    v_user_id,
    v_metadata_user_id,
    v_metadata_supabase_user_id,
    p_stripe_customer_id,
    v_checkout_reservation_id,
    p_stripe_price_id,
    'free',
    100,
    p_stripe_subscription_id,
    p_subscription_created,
    p_stripe_event_id,
    p_event_created,
    false,
    p_is_terminal,
    p_livemode,
    NULL,
    NULL,
    NULL,
    'persisted_subscription'
  );
END
$function$;

ALTER FUNCTION public.apply_user_api_tier_persisted_non_grant_event(
  text,
  text,
  text,
  bigint,
  text,
  bigint,
  boolean,
  boolean
) OWNER TO postgres;

COMMENT ON FUNCTION public.apply_user_api_tier_persisted_non_grant_event(
  text,
  text,
  text,
  bigint,
  text,
  bigint,
  boolean,
  boolean
) IS 'Service-only revoke/suspend fallback resolved from persisted exact API subscription identity.';

-- Creating a key and projecting Stripe entitlement must serialize on the same
-- profile row. If creation wins the lock, a following Stripe event updates the
-- new active key; if the event wins, creation reads the new profile tier.
CREATE OR REPLACE FUNCTION public.create_user_api_key_with_current_entitlement(
  p_user_id uuid,
  p_key text,
  p_name text
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
  v_tier text;
  v_deleted_at timestamp with time zone;
  v_banned_at timestamp with time zone;
  v_is_banned boolean;
  v_daily_limit integer;
  v_active_count bigint;
  v_created_id uuid;
  v_created_name text;
  v_created_key text;
  v_created_at timestamp with time zone;
BEGIN
  IF p_user_id IS NULL
    OR p_key IS NULL
    OR p_key !~ '^arena_sk_[0-9a-f]{32}$'
    OR p_name IS NULL
    OR pg_catalog.btrim(p_name) IS DISTINCT FROM p_name
    OR pg_catalog.length(p_name) < 1
    OR pg_catalog.length(p_name) > 50
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '22023',
        MESSAGE = 'invalid API key creation input';
  END IF;

  SELECT
    profile.api_tier,
    profile.deleted_at,
    profile.banned_at,
    profile.is_banned
  INTO
    v_tier,
    v_deleted_at,
    v_banned_at,
    v_is_banned
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'P0002',
        MESSAGE = 'API key owner profile does not exist';
  END IF;
  IF v_deleted_at IS NOT NULL
    OR v_banned_at IS NOT NULL
    OR COALESCE(v_is_banned, false)
  THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '42501',
        MESSAGE = 'inactive API key owner';
  END IF;

  v_daily_limit := CASE v_tier
    WHEN 'free' THEN 100
    WHEN 'starter' THEN 10000
    WHEN 'pro' THEN 0
    ELSE NULL
  END;
  IF v_daily_limit IS NULL THEN
    RAISE EXCEPTION
      USING
        ERRCODE = '40001',
        MESSAGE = 'API key owner profile has an invalid entitlement';
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_active_count
  FROM public.api_keys AS api_key
  WHERE api_key.user_id = p_user_id
    AND api_key.active;

  IF v_active_count >= 5 THEN
    RAISE EXCEPTION
      USING
        ERRCODE = 'P0001',
        MESSAGE = 'maximum 5 active API keys allowed';
  END IF;

  INSERT INTO public.api_keys AS api_key (
    user_id,
    key,
    name,
    tier,
    daily_limit
  ) VALUES (
    p_user_id,
    p_key,
    p_name,
    v_tier,
    v_daily_limit
  )
  RETURNING
    api_key.id,
    api_key.name,
    api_key.key,
    api_key.created_at
  INTO
    v_created_id,
    v_created_name,
    v_created_key,
    v_created_at;

  RETURN pg_catalog.jsonb_build_object(
    'id', v_created_id,
    'name', v_created_name,
    'key', v_created_key,
    'tier', v_tier,
    'daily_limit', v_daily_limit,
    'created_at', v_created_at
  );
END
$function$;

ALTER FUNCTION public.create_user_api_key_with_current_entitlement(
  uuid,
  text,
  text
) OWNER TO postgres;

COMMENT ON FUNCTION public.create_user_api_key_with_current_entitlement(
  uuid,
  text,
  text
) IS 'Service-only atomic API-key creation using the locked current Stripe entitlement.';

-- Account deletion and moderation are authentication boundaries for every
-- existing API credential, not only for the settings UI. Revoke credentials
-- in the same transaction that first marks the profile inactive. Recovery
-- deliberately does not resurrect copied secrets; the user creates new keys.
CREATE OR REPLACE FUNCTION public.quiesce_inactive_user_api_access()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
BEGIN
  IF NEW.deleted_at IS NOT NULL THEN
    INSERT INTO public.api_tier_subscription_blocks (
      livemode,
      stripe_subscription_id,
      block_kind,
      user_id,
      stripe_customer_id
    )
    SELECT DISTINCT
      candidate.livemode,
      candidate.stripe_subscription_id,
      'account_deletion',
      NEW.id,
      NEW.stripe_customer_id
    FROM (
      SELECT mode_value.livemode, NEW.api_stripe_subscription_id
      FROM (
        VALUES (false), (true)
      ) AS mode_value(livemode)
      WHERE NEW.api_stripe_subscription_id IS NOT NULL
      UNION ALL
      SELECT ledger.livemode, ledger.stripe_subscription_id
      FROM public.api_tier_stripe_event_ledger AS ledger
      WHERE ledger.user_id = NEW.id
      UNION ALL
      SELECT reservation.livemode, reservation.stripe_subscription_id
      FROM public.api_tier_checkout_reservations AS reservation
      WHERE reservation.user_id = NEW.id
        AND reservation.stripe_subscription_id IS NOT NULL
    ) AS candidate(livemode, stripe_subscription_id)
    ON CONFLICT (livemode, stripe_subscription_id, block_kind)
      DO NOTHING;

    IF EXISTS (
      SELECT 1
      FROM public.api_tier_subscription_blocks AS block
      WHERE block.block_kind = 'account_deletion'
        AND block.stripe_subscription_id IN (
          SELECT NEW.api_stripe_subscription_id
          WHERE NEW.api_stripe_subscription_id IS NOT NULL
          UNION
          SELECT ledger.stripe_subscription_id
          FROM public.api_tier_stripe_event_ledger AS ledger
          WHERE ledger.user_id = NEW.id
          UNION
          SELECT reservation.stripe_subscription_id
          FROM public.api_tier_checkout_reservations AS reservation
          WHERE reservation.user_id = NEW.id
            AND reservation.stripe_subscription_id IS NOT NULL
        )
        AND (
          block.user_id <> NEW.id
          OR (
            block.stripe_customer_id IS NOT NULL
            AND NEW.stripe_customer_id IS NOT NULL
            AND block.stripe_customer_id <> NEW.stripe_customer_id
          )
        )
    ) THEN
      RAISE EXCEPTION
        USING
          ERRCODE = '40001',
          MESSAGE = 'account deletion subscription block identity drifted';
    END IF;

    -- The block ledger now carries cancellation/refund identity. Do not leave
    -- an old subscription pointer that would prevent a recovered account from
    -- starting a distinct fresh checkout.
    NEW.api_stripe_subscription_id := NULL;
  END IF;

  IF NEW.deleted_at IS NOT NULL
    OR NEW.banned_at IS NOT NULL
    OR COALESCE(NEW.is_banned, false)
  THEN
    NEW.api_tier := 'free';

    UPDATE public.api_keys AS api_key
    SET
      active = false,
      tier = 'free',
      daily_limit = 100,
      revoked_at = COALESCE(
        api_key.revoked_at,
        pg_catalog.clock_timestamp()
      )
    WHERE api_key.user_id = NEW.id
      AND api_key.active;
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.quiesce_inactive_user_api_access()
  OWNER TO postgres;
REVOKE ALL
  ON FUNCTION public.quiesce_inactive_user_api_access()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

DROP TRIGGER IF EXISTS zzz_quiesce_inactive_user_api_access
  ON public.user_profiles;
CREATE TRIGGER zzz_quiesce_inactive_user_api_access
  BEFORE UPDATE OF deleted_at, banned_at, is_banned
  ON public.user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.quiesce_inactive_user_api_access();

-- The Data API authenticates by calling this RPC directly with a copied key.
-- Joining the locked profile state here is the final fail-closed boundary:
-- a key cannot remain usable during the small interval between session
-- invalidation, Stripe cancellation, and eventual Auth hard deletion.
CREATE OR REPLACE FUNCTION public.increment_api_key_usage(p_key text)
RETURNS TABLE(
  allowed boolean,
  remaining integer,
  daily_limit integer
)
LANGUAGE plpgsql
SECURITY INVOKER
VOLATILE
CALLED ON NULL INPUT
PARALLEL UNSAFE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_daily_limit integer;
  v_new_count integer;
BEGIN
  UPDATE public.api_keys AS api_key
  SET
    request_count_today = api_key.request_count_today + 1,
    last_used_at = pg_catalog.clock_timestamp()
  FROM public.user_profiles AS profile
  WHERE api_key.key = p_key
    AND api_key.active
    AND profile.id = api_key.user_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL
    AND NOT COALESCE(profile.is_banned, false)
  RETURNING api_key.daily_limit, api_key.request_count_today
  INTO v_daily_limit, v_new_count;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, 0;
    RETURN;
  END IF;

  IF v_daily_limit = 0 THEN
    RETURN QUERY SELECT true, -1, 0;
  ELSE
    RETURN QUERY SELECT
      v_new_count <= v_daily_limit,
      pg_catalog.greatest(v_daily_limit - v_new_count, 0),
      v_daily_limit;
  END IF;
END
$function$;

ALTER FUNCTION public.increment_api_key_usage(text)
  OWNER TO postgres;

-- Converge both private authority relations to owner-only table/column ACLs,
-- including replay after an unexpected direct grantee or column grant.
DO $revoke_nonowner_ledger_acl$
DECLARE
  v_relation pg_catalog.regclass;
  v_relation_sql text;
  v_owner oid;
  v_grantee oid;
  v_grantee_name name;
  v_grantee_sql text;
  v_column name;
  v_privilege text;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.api_tier_checkout_reservations'::pg_catalog.regclass,
    'public.api_tier_stripe_event_ledger'::pg_catalog.regclass,
    'public.api_tier_subscription_blocks'::pg_catalog.regclass
  ]
  LOOP
    SELECT
      relation.relowner,
      pg_catalog.format('%I.%I', namespace.nspname, relation.relname)
    INTO v_owner, v_relation_sql
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS namespace
      ON namespace.oid = relation.relnamespace
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
          RAISE EXCEPTION
            'dangling API tier private relation ACL grantee oid: %',
            v_grantee;
        END IF;
        v_grantee_sql := pg_catalog.format('%I', v_grantee_name);
      END IF;
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON TABLE %s FROM %s CASCADE',
        v_relation_sql,
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
            'dangling API tier private column ACL grantee oid: %',
            v_grantee;
        END IF;
        v_grantee_sql := pg_catalog.format('%I', v_grantee_name);
      END IF;
      EXECUTE pg_catalog.format(
        'REVOKE %s (%I) ON TABLE %s FROM %s CASCADE',
        v_privilege,
        v_column,
        v_relation_sql,
        v_grantee_sql
      );
    END LOOP;
  END LOOP;
END
$revoke_nonowner_ledger_acl$;

-- Converge every routine ACL. The legacy updater remains exact service-only in
-- this additive migration so the currently deployed webhook keeps working
-- while the new application rolls out. A separate postdeploy migration removes
-- that final compatibility writer after the new RPC callers are live.
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
    'public.apply_user_api_tier_stripe_event(uuid,uuid,uuid,text,uuid,text,text,integer,text,bigint,text,bigint,boolean,boolean,boolean,text,text,text,text)'::pg_catalog.regprocedure,
    'public.apply_user_api_tier_persisted_non_grant_event(text,text,text,bigint,text,bigint,boolean,boolean)'::pg_catalog.regprocedure,
    'public.create_user_api_key_with_current_entitlement(uuid,text,text)'::pg_catalog.regprocedure,
    'public.increment_api_key_usage(text)'::pg_catalog.regprocedure,
    'public.quiesce_inactive_user_api_access()'::pg_catalog.regprocedure,
    'public.schedule_account_deletion_with_billing_blocks(uuid,text,timestamp with time zone,text,text,text[])'::pg_catalog.regprocedure,
    'public.reserve_api_tier_checkout_atomic(uuid,boolean,text,text,text)'::pg_catalog.regprocedure,
    'public.bind_api_tier_checkout_session_atomic(uuid,uuid,boolean,text,text,text,text,bigint)'::pg_catalog.regprocedure,
    'public.release_api_tier_checkout_reservation_atomic(uuid,uuid,boolean,text,text,text,bigint)'::pg_catalog.regprocedure
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
  TO service_role;

GRANT EXECUTE
  ON FUNCTION public.apply_user_api_tier_persisted_non_grant_event(
    text,
    text,
    text,
    bigint,
    text,
    bigint,
    boolean,
    boolean
  )
  TO service_role;

GRANT EXECUTE
  ON FUNCTION public.reserve_api_tier_checkout_atomic(
    uuid,
    boolean,
    text,
    text,
    text
  )
  TO service_role;

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
  TO service_role;

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
  TO service_role;

GRANT EXECUTE
  ON FUNCTION public.create_user_api_key_with_current_entitlement(
    uuid,
    text,
    text
  )
  TO service_role;

GRANT EXECUTE
  ON FUNCTION public.increment_api_key_usage(text)
  TO service_role;

GRANT EXECUTE
  ON FUNCTION public.schedule_account_deletion_with_billing_blocks(
    uuid,
    text,
    timestamp with time zone,
    text,
    text,
    text[]
  )
  TO service_role;

GRANT EXECUTE
  ON FUNCTION public.update_user_api_tier(
    uuid,
    text,
    text,
    integer
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
  v_reservations pg_catalog.regclass :=
    'public.api_tier_checkout_reservations'::pg_catalog.regclass;
  v_blocks pg_catalog.regclass :=
    'public.api_tier_subscription_blocks'::pg_catalog.regclass;
  v_rpc pg_catalog.regprocedure :=
    'public.apply_user_api_tier_stripe_event(uuid,uuid,uuid,text,uuid,text,text,integer,text,bigint,text,bigint,boolean,boolean,boolean,text,text,text,text)'::pg_catalog.regprocedure;
  v_persisted_rpc pg_catalog.regprocedure :=
    'public.apply_user_api_tier_persisted_non_grant_event(text,text,text,bigint,text,bigint,boolean,boolean)'::pg_catalog.regprocedure;
  v_key_rpc pg_catalog.regprocedure :=
    'public.create_user_api_key_with_current_entitlement(uuid,text,text)'::pg_catalog.regprocedure;
  v_usage_rpc pg_catalog.regprocedure :=
    'public.increment_api_key_usage(text)'::pg_catalog.regprocedure;
  v_quiesce_rpc pg_catalog.regprocedure :=
    'public.quiesce_inactive_user_api_access()'::pg_catalog.regprocedure;
  v_schedule_rpc pg_catalog.regprocedure :=
    'public.schedule_account_deletion_with_billing_blocks(uuid,text,timestamp with time zone,text,text,text[])'::pg_catalog.regprocedure;
  v_reserve_rpc pg_catalog.regprocedure :=
    'public.reserve_api_tier_checkout_atomic(uuid,boolean,text,text,text)'::pg_catalog.regprocedure;
  v_bind_rpc pg_catalog.regprocedure :=
    'public.bind_api_tier_checkout_session_atomic(uuid,uuid,boolean,text,text,text,text,bigint)'::pg_catalog.regprocedure;
  v_release_rpc pg_catalog.regprocedure :=
    'public.release_api_tier_checkout_reservation_atomic(uuid,uuid,boolean,text,text,text,bigint)'::pg_catalog.regprocedure;
  v_old_rpc pg_catalog.regprocedure :=
    'public.update_user_api_tier(uuid,text,text,integer)'::pg_catalog.regprocedure;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY[
        'public.user_profiles',
        'public.api_keys',
        'public.api_tier_checkout_reservations',
        'public.api_tier_stripe_event_ledger',
        'public.api_tier_subscription_blocks'
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
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (v_ledger, v_reservations, v_blocks)
       OR inheritance.inhparent IN (v_ledger, v_reservations, v_blocks)
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
    WHERE relation.oid IN (v_ledger, v_reservations, v_blocks)
      AND acl_entry.grantee <> v_postgres
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid IN (v_ledger, v_reservations, v_blocks)
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (v_ledger, v_reservations, v_blocks)
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
    SELECT pg_catalog.jsonb_object_agg(
      index_relation.relname,
      pg_catalog.pg_get_indexdef(index_row.indexrelid, 0, true)
    )
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    WHERE index_row.indrelid = v_reservations
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND NOT index_row.indisexclusion
      AND index_row.indexprs IS NULL
  ) IS DISTINCT FROM pg_catalog.jsonb_build_object(
    'api_tier_checkout_reservations_active_user_mode_idx',
    'CREATE UNIQUE INDEX api_tier_checkout_reservations_active_user_mode_idx ON public.api_tier_checkout_reservations USING btree (user_id, livemode) WHERE status = ANY (ARRAY[''reserved''::text, ''bound''::text])',
    'api_tier_checkout_reservations_pkey',
    'CREATE UNIQUE INDEX api_tier_checkout_reservations_pkey ON public.api_tier_checkout_reservations USING btree (id)',
    'api_tier_checkout_reservations_release_event_idx',
    'CREATE UNIQUE INDEX api_tier_checkout_reservations_release_event_idx ON public.api_tier_checkout_reservations USING btree (livemode, release_event_id) WHERE release_event_id IS NOT NULL',
    'api_tier_checkout_reservations_session_idx',
    'CREATE UNIQUE INDEX api_tier_checkout_reservations_session_idx ON public.api_tier_checkout_reservations USING btree (livemode, checkout_session_id) WHERE checkout_session_id IS NOT NULL',
    'api_tier_checkout_reservations_subscription_idx',
    'CREATE UNIQUE INDEX api_tier_checkout_reservations_subscription_idx ON public.api_tier_checkout_reservations USING btree (livemode, stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = v_reservations
      AND (
        NOT index_row.indisvalid
        OR NOT index_row.indisready
        OR NOT index_row.indislive
        OR index_row.indisexclusion
        OR index_row.indexprs IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION
      'API tier checkout reservation indexes drifted';
  END IF;

  IF (
    SELECT pg_catalog.jsonb_object_agg(
      index_relation.relname,
      pg_catalog.pg_get_indexdef(index_row.indexrelid, 0, true)
    )
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    WHERE index_row.indrelid = v_blocks
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND NOT index_row.indisexclusion
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
  ) IS DISTINCT FROM pg_catalog.jsonb_build_object(
    'api_tier_subscription_blocks_pkey',
    'CREATE UNIQUE INDEX api_tier_subscription_blocks_pkey ON public.api_tier_subscription_blocks USING btree (livemode, stripe_subscription_id, block_kind)',
    'api_tier_subscription_blocks_user_idx',
    'CREATE INDEX api_tier_subscription_blocks_user_idx ON public.api_tier_subscription_blocks USING btree (user_id, block_kind, blocked_at DESC)'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = v_blocks
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
      'API tier subscription block indexes drifted';
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
        OR routine.pronargs <> 19
        OR routine.pronargdefaults <> 0
        OR routine.proargnames IS DISTINCT FROM ARRAY[
          'p_user_id',
          'p_metadata_user_id',
          'p_metadata_supabase_user_id',
          'p_stripe_customer_id',
          'p_checkout_reservation_id',
          'p_stripe_price_id',
          'p_api_tier',
          'p_daily_limit',
          'p_stripe_subscription_id',
          'p_subscription_created',
          'p_stripe_event_id',
          'p_event_created',
          'p_is_active',
          'p_is_terminal',
          'p_livemode',
          'p_checkout_session_id',
          'p_checkout_api_plan',
          'p_checkout_price_id',
          'p_identity_source'
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

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname =
        'apply_user_api_tier_persisted_non_grant_event'
  ) <> 1 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid = v_persisted_rpc
      AND (
        routine.proowner <> v_postgres
        OR routine.prokind <> 'f'
        OR NOT routine.prosecdef
        OR routine.prorettype <> 'text'::pg_catalog.regtype
        OR routine.proretset
        OR routine.provolatile <> 'v'
        OR routine.proparallel <> 'u'
        OR routine.proisstrict
        OR routine.pronargs <> 8
        OR routine.pronargdefaults <> 0
        OR routine.proargnames IS DISTINCT FROM ARRAY[
          'p_stripe_customer_id',
          'p_stripe_price_id',
          'p_stripe_subscription_id',
          'p_subscription_created',
          'p_stripe_event_id',
          'p_event_created',
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
      'persisted API tier non-grant authority catalog seal drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname =
        'create_user_api_key_with_current_entitlement'
  ) <> 1 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid = v_key_rpc
      AND (
        routine.proowner <> v_postgres
        OR routine.prokind <> 'f'
        OR NOT routine.prosecdef
        OR routine.prorettype <> 'jsonb'::pg_catalog.regtype
        OR routine.proretset
        OR routine.provolatile <> 'v'
        OR routine.proparallel <> 'u'
        OR routine.proisstrict
        OR routine.pronargs <> 3
        OR routine.pronargdefaults <> 0
        OR routine.proargnames IS DISTINCT FROM ARRAY[
          'p_user_id',
          'p_key',
          'p_name'
        ]::text[]
        OR routine.proconfig IS DISTINCT FROM ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off'
        ]::text[]
      )
  ) THEN
    RAISE EXCEPTION
      'API key entitlement authority catalog seal drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname = 'increment_api_key_usage'
  ) <> 1 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid = v_usage_rpc
      AND (
        routine.proowner <> v_postgres
        OR routine.prokind <> 'f'
        OR routine.prosecdef
        OR routine.prorettype <> 'record'::pg_catalog.regtype
        OR NOT routine.proretset
        OR routine.provolatile <> 'v'
        OR routine.proparallel <> 'u'
        OR routine.proisstrict
        OR routine.pronargs <> 1
        OR routine.pronargdefaults <> 0
        OR routine.proargnames IS DISTINCT FROM ARRAY[
          'p_key',
          'allowed',
          'remaining',
          'daily_limit'
        ]::text[]
        OR routine.proconfig IS DISTINCT FROM ARRAY[
          'search_path=pg_catalog, pg_temp'
        ]::text[]
      )
  ) THEN
    RAISE EXCEPTION
      'API key usage lifecycle gate catalog seal drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname = 'quiesce_inactive_user_api_access'
  ) <> 1 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid = v_quiesce_rpc
      AND (
        routine.proowner <> v_postgres
        OR routine.prokind <> 'f'
        OR NOT routine.prosecdef
        OR routine.prorettype <> 'trigger'::pg_catalog.regtype
        OR routine.proretset
        OR routine.provolatile <> 'v'
        OR routine.proparallel <> 'u'
        OR routine.proisstrict
        OR routine.pronargs <> 0
        OR routine.pronargdefaults <> 0
        OR routine.proconfig IS DISTINCT FROM ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off'
        ]::text[]
      )
  ) THEN
    RAISE EXCEPTION
      'inactive-account API quiescence hook catalog seal drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname =
        'schedule_account_deletion_with_billing_blocks'
  ) <> 1 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.oid = v_schedule_rpc
      AND (
        routine.proowner <> v_postgres
        OR routine.prokind <> 'f'
        OR NOT routine.prosecdef
        OR routine.prorettype <> 'jsonb'::pg_catalog.regtype
        OR routine.proretset
        OR routine.provolatile <> 'v'
        OR routine.proparallel <> 'u'
        OR routine.proisstrict
        OR routine.pronargs <> 6
        OR routine.pronargdefaults <> 0
        OR routine.proargnames IS DISTINCT FROM ARRAY[
          'p_user_id',
          'p_reason',
          'p_scheduled_at',
          'p_recovery_token_hash',
          'p_stripe_customer_id',
          'p_stripe_subscription_ids'
        ]::text[]
        OR routine.proconfig IS DISTINCT FROM ARRAY[
          'search_path=pg_catalog, pg_temp',
          'row_security=off'
        ]::text[]
      )
  ) THEN
    RAISE EXCEPTION
      'account deletion billing-block authority catalog seal drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'public.user_profiles'::pg_catalog.regclass
      AND trigger_row.tgname =
        'zzz_quiesce_inactive_user_api_access'
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid =
        'public.user_profiles'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal
      AND (
        (
          trigger_row.tgname =
            'zzz_quiesce_inactive_user_api_access'
          AND (
            trigger_row.tgfoid <> v_quiesce_rpc::oid
            OR trigger_row.tgtype <> 19
            OR trigger_row.tgenabled <> 'O'
            OR trigger_row.tgnargs <> 0
            OR pg_catalog.octet_length(trigger_row.tgargs) <> 0
            OR trigger_row.tgqual IS NOT NULL
            OR pg_catalog.cardinality(
              trigger_row.tgattr::smallint[]
            ) <> 3
            OR (
              SELECT pg_catalog.count(*)
              FROM pg_catalog.unnest(
                trigger_row.tgattr::smallint[]
              ) AS trigger_attribute(attribute_number)
              JOIN pg_catalog.pg_attribute AS attribute
                ON attribute.attrelid = trigger_row.tgrelid
               AND attribute.attnum =
                  trigger_attribute.attribute_number
              WHERE attribute.attname IN (
                'deleted_at',
                'banned_at',
                'is_banned'
              )
                AND NOT attribute.attisdropped
            ) <> 3
          )
        )
        OR (
          trigger_row.tgfoid = v_quiesce_rpc::oid
          AND trigger_row.tgname <>
            'zzz_quiesce_inactive_user_api_access'
        )
      )
  ) THEN
    RAISE EXCEPTION
      'inactive-account API quiescence trigger seal drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    WHERE routine.pronamespace = 'public'::pg_catalog.regnamespace
      AND routine.proname IN (
        'reserve_api_tier_checkout_atomic',
        'bind_api_tier_checkout_session_atomic',
        'release_api_tier_checkout_reservation_atomic'
      )
  ) <> 3 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          v_reserve_rpc,
          5,
          ARRAY[
            'p_user_id',
            'p_livemode',
            'p_stripe_customer_id',
            'p_api_plan',
            'p_stripe_price_id'
          ]::text[]
        ),
        (
          v_bind_rpc,
          8,
          ARRAY[
            'p_reservation_id',
            'p_user_id',
            'p_livemode',
            'p_stripe_customer_id',
            'p_api_plan',
            'p_stripe_price_id',
            'p_checkout_session_id',
            'p_checkout_expires_at'
          ]::text[]
        ),
        (
          v_release_rpc,
          7,
          ARRAY[
            'p_reservation_id',
            'p_user_id',
            'p_livemode',
            'p_stripe_customer_id',
            'p_checkout_session_id',
            'p_stripe_event_id',
            'p_stripe_event_created'
          ]::text[]
        )
    ) AS expected(routine_oid, argument_count, argument_names)
    LEFT JOIN pg_catalog.pg_proc AS routine
      ON routine.oid = expected.routine_oid
    WHERE routine.oid IS NULL
       OR routine.proowner <> v_postgres
       OR routine.prokind <> 'f'
       OR NOT routine.prosecdef
       OR routine.prorettype <> 'jsonb'::pg_catalog.regtype
       OR routine.proretset
       OR routine.provolatile <> 'v'
       OR routine.proparallel <> 'u'
       OR routine.proisstrict
       OR routine.pronargs <> expected.argument_count
       OR routine.pronargdefaults <> 0
       OR routine.proargnames IS DISTINCT FROM
         expected.argument_names
       OR routine.proconfig IS DISTINCT FROM ARRAY[
         'search_path=pg_catalog, pg_temp',
         'row_security=off'
       ]::text[]
  ) THEN
    RAISE EXCEPTION
      'API tier checkout reservation authority catalog seal drifted';
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
    WHERE routine.oid = v_persisted_rpc
      AND acl_entry.grantee NOT IN (v_postgres, v_service)
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS acl_entry
    WHERE routine.oid = v_persisted_rpc
      AND acl_entry.grantee = v_service
      AND acl_entry.privilege_type = 'EXECUTE'
      AND NOT acl_entry.is_grantable
      AND acl_entry.grantor = v_postgres
  ) <> 1
    OR pg_catalog.has_function_privilege(
      'anon',
      v_persisted_rpc,
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      v_persisted_rpc,
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'service_role',
      v_persisted_rpc,
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION
      'persisted API tier non-grant authority is not exact service-only EXECUTE';
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
    WHERE routine.oid = v_key_rpc
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
    WHERE routine.oid = v_key_rpc
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
      WHERE routine.oid = v_key_rpc
        AND acl_entry.grantee = v_service
        AND (
          acl_entry.is_grantable
          OR acl_entry.grantor <> v_postgres
        )
    )
    OR pg_catalog.has_function_privilege(
      'anon',
      v_key_rpc,
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      v_key_rpc,
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'service_role',
      v_key_rpc,
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION
      'API key entitlement authority is not exact service-only EXECUTE';
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
    WHERE routine.oid = v_usage_rpc
      AND acl_entry.grantee NOT IN (v_postgres, v_service)
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS acl_entry
    WHERE routine.oid = v_usage_rpc
      AND acl_entry.grantee = v_service
      AND acl_entry.privilege_type = 'EXECUTE'
      AND NOT acl_entry.is_grantable
      AND acl_entry.grantor = v_postgres
  ) <> 1
    OR pg_catalog.has_function_privilege(
      'anon',
      v_usage_rpc,
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      v_usage_rpc,
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'service_role',
      v_usage_rpc,
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION
      'API key usage lifecycle gate is not exact service-only EXECUTE';
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
    WHERE routine.oid = v_quiesce_rpc
      AND acl_entry.grantee <> v_postgres
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    v_quiesce_rpc,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_quiesce_rpc,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_quiesce_rpc,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'inactive-account API quiescence hook is not owner-only';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY[
        v_schedule_rpc,
        v_reserve_rpc,
        v_bind_rpc,
        v_release_rpc
      ]::pg_catalog.regprocedure[]
    ) AS expected(routine_oid)
    WHERE EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS routine
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          routine.proacl,
          pg_catalog.acldefault('f', routine.proowner)
        )
      ) AS acl_entry
      WHERE routine.oid = expected.routine_oid
        AND acl_entry.grantee NOT IN (v_postgres, v_service)
    )
       OR (
         SELECT pg_catalog.count(*)
         FROM pg_catalog.pg_proc AS routine
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             routine.proacl,
             pg_catalog.acldefault('f', routine.proowner)
           )
         ) AS acl_entry
         WHERE routine.oid = expected.routine_oid
           AND acl_entry.grantee = v_service
           AND acl_entry.privilege_type = 'EXECUTE'
           AND NOT acl_entry.is_grantable
           AND acl_entry.grantor = v_postgres
       ) <> 1
       OR pg_catalog.has_function_privilege(
         'anon',
         expected.routine_oid,
         'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         'authenticated',
         expected.routine_oid,
         'EXECUTE'
       )
       OR NOT pg_catalog.has_function_privilege(
         'service_role',
         expected.routine_oid,
         'EXECUTE'
       )
  ) THEN
    RAISE EXCEPTION
      'API tier checkout/deletion authority is not exact service-only EXECUTE';
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
      AND acl_entry.grantee NOT IN (v_postgres, v_service)
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS routine
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        routine.proacl,
        pg_catalog.acldefault('f', routine.proowner)
      )
    ) AS acl_entry
    WHERE routine.oid = v_old_rpc
      AND acl_entry.grantee = v_service
      AND acl_entry.privilege_type = 'EXECUTE'
      AND NOT acl_entry.is_grantable
      AND acl_entry.grantor = v_postgres
  ) <> 1 OR pg_catalog.has_function_privilege(
    'anon',
    v_old_rpc,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_old_rpc,
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_old_rpc,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'legacy API tier compatibility updater is not exact service-only EXECUTE';
  END IF;

  -- Repeat the exact INHERIT/SET/ADMIN role-graph proof after all DDL and
  -- grants.
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
        AND (
          membership.admin_option
          OR membership.inherit_option
          OR membership.set_option
        )
      UNION
      SELECT membership.member
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_authority AS inherited
        ON membership.roleid = inherited.member_oid
      WHERE membership.admin_option
         OR membership.inherit_option
         OR membership.set_option
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
        AND (
          membership.admin_option
          OR membership.inherit_option
          OR membership.set_option
        )
      UNION
      SELECT membership.roleid
      FROM pg_catalog.pg_auth_members AS membership
      JOIN service_inherits AS inherited
        ON membership.member = inherited.role_oid
      WHERE membership.admin_option
         OR membership.inherit_option
         OR membership.set_option
    )
    SELECT 1 FROM service_inherits
  ) OR EXISTS (
    WITH RECURSIVE browser_authority(role_oid) AS (
      SELECT membership.roleid
      FROM pg_catalog.pg_roles AS browser_role
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = browser_role.oid
       AND (
         membership.admin_option
         OR membership.inherit_option
         OR membership.set_option
       )
      WHERE browser_role.rolname IN ('anon', 'authenticated')
      UNION
      SELECT membership.roleid
      FROM browser_authority AS inherited
      JOIN pg_catalog.pg_auth_members AS membership
        ON membership.member = inherited.role_oid
      WHERE membership.admin_option
         OR membership.inherit_option
         OR membership.set_option
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
