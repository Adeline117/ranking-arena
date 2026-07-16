-- Make profile provisioning server-owned and expose only an explicit set of
-- user-editable columns.  Historical permissive policies were additive: the
-- older policy protected only role/subscription_tier, so PostgreSQL OR-ed it
-- with the newer, broader policy and still allowed privilege/counter edits.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('user-profile-authority-migrations', 0)
);

DO $required_objects$
DECLARE
  v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'postgres',
    'anon',
    'authenticated',
    'service_role'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = v_role
    ) THEN
      RAISE EXCEPTION 'required profile authority role is missing: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = 'public.user_profiles'::pg_catalog.regclass
        AND relation.relkind IN ('r', 'p')
        AND relation.relowner = (
          SELECT role_row.oid
          FROM pg_catalog.pg_roles AS role_row
          WHERE role_row.rolname = 'postgres'
        )
    )
  THEN
    RAISE EXCEPTION 'public.user_profiles must be an ordinary postgres-owned table';
  END IF;

  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = 'auth.uid()'::pg_catalog.regprocedure
  ) <> 'uuid'::pg_catalog.regtype THEN
    RAISE EXCEPTION 'auth.uid() must exist and return uuid';
  END IF;
END
$required_objects$;

LOCK TABLE public.user_profiles IN ACCESS EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_signature pg_catalog.regprocedure;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('id', 'uuid'::pg_catalog.regtype),
        ('handle', 'text'::pg_catalog.regtype),
        ('bio', 'text'::pg_catalog.regtype),
        ('avatar_url', 'text'::pg_catalog.regtype),
        ('cover_url', 'text'::pg_catalog.regtype),
        ('market_pairs', 'jsonb'::pg_catalog.regtype),
        ('notify_follow', 'boolean'::pg_catalog.regtype),
        ('notify_like', 'boolean'::pg_catalog.regtype),
        ('notify_comment', 'boolean'::pg_catalog.regtype),
        ('notify_mention', 'boolean'::pg_catalog.regtype),
        ('notify_message', 'boolean'::pg_catalog.regtype),
        ('notify_trader_events', 'boolean'::pg_catalog.regtype),
        ('show_followers', 'boolean'::pg_catalog.regtype),
        ('show_following', 'boolean'::pg_catalog.regtype),
        ('dm_permission', 'text'::pg_catalog.regtype),
        ('email_digest', 'text'::pg_catalog.regtype),
        ('settings_version', 'integer'::pg_catalog.regtype),
        ('show_pro_badge', 'boolean'::pg_catalog.regtype),
        ('last_seen_at', 'timestamptz'::pg_catalog.regtype),
        ('is_online', 'boolean'::pg_catalog.regtype),
        ('interests', 'jsonb'::pg_catalog.regtype),
        ('onboarding_completed', 'boolean'::pg_catalog.regtype),
        ('search_history', 'jsonb'::pg_catalog.regtype),
        ('deleted_at', 'timestamptz'::pg_catalog.regtype),
        ('banned_at', 'timestamptz'::pg_catalog.regtype),
        ('is_banned', 'boolean'::pg_catalog.regtype),
        ('ban_expires_at', 'timestamptz'::pg_catalog.regtype),
        ('weight', 'integer'::pg_catalog.regtype)
    ) AS required_column(column_name, type_oid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.user_profiles'::pg_catalog.regclass
        AND attribute.attname = required_column.column_name
        AND attribute.atttypid = required_column.type_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'public.user_profiles write-authority columns are incompatible';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.calculate_user_weight(uuid)'::pg_catalog.regprocedure,
    'public.trigger_update_user_weight()'::pg_catalog.regprocedure,
    'public.trigger_update_weight_on_activity()'::pg_catalog.regprocedure,
    'public.sync_author_handle()'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_signature
        AND function_row.prokind = 'f'
        AND (
          v_signature = 'public.calculate_user_weight(uuid)'::pg_catalog.regprocedure
          OR function_row.prorettype = 'trigger'::pg_catalog.regtype
        )
    ) THEN
      RAISE EXCEPTION 'required profile side-effect function is incompatible: %',
        v_signature;
    END IF;
  END LOOP;
END
$preflight$;

-- No runtime role needs DDL authority in the API schema.  The profile trigger
-- functions below intentionally use public only after this CREATE privilege
-- has been removed from every request role.
REVOKE CREATE ON SCHEMA public
  FROM PUBLIC, anon, authenticated, service_role;

-- Recalculate weight after the visible profile row has changed.  The legacy
-- BEFORE trigger called a function that UPDATEd the same row and observed the
-- pre-update values; moving the trusted side effect AFTER the write both keeps
-- column ACLs enforceable and computes from canonical persisted values.
ALTER FUNCTION public.calculate_user_weight(uuid) SECURITY DEFINER;
ALTER FUNCTION public.calculate_user_weight(uuid)
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.calculate_user_weight(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.calculate_user_weight(uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.trigger_update_user_weight_after()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF OLD.avatar_url IS DISTINCT FROM NEW.avatar_url
    OR OLD.bio IS DISTINCT FROM NEW.bio
    OR OLD.handle IS DISTINCT FROM NEW.handle
    OR OLD.subscription_tier IS DISTINCT FROM NEW.subscription_tier
  THEN
    PERFORM public.calculate_user_weight(NEW.id);
  END IF;
  RETURN NULL;
END
$function$;

ALTER FUNCTION public.trigger_update_user_weight_after() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trigger_update_user_weight_after()
  FROM PUBLIC, anon, authenticated, service_role;

-- The post/comment activity triggers call the now-private calculator.  Trigger
-- invocation does not require EXECUTE, but the nested function call runs with
-- the trigger function's effective role, so this wrapper must be trusted too.
ALTER FUNCTION public.trigger_update_weight_on_activity() SECURITY DEFINER;
ALTER FUNCTION public.trigger_update_weight_on_activity()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.trigger_update_weight_on_activity() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trigger_update_weight_on_activity()
  FROM PUBLIC, anon, authenticated, service_role;

-- Retire the legacy trigger implementation as an executable entry point even
-- though the canonical trigger no longer references it.
ALTER FUNCTION public.trigger_update_user_weight() SECURITY DEFINER;
ALTER FUNCTION public.trigger_update_user_weight()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.trigger_update_user_weight() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.trigger_update_user_weight()
  FROM PUBLIC, anon, authenticated, service_role;

ALTER FUNCTION public.sync_author_handle() SECURITY DEFINER;
ALTER FUNCTION public.sync_author_handle()
  SET search_path = pg_catalog, public;
ALTER FUNCTION public.sync_author_handle() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.sync_author_handle()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trigger_auto_update_user_weight
  ON public.user_profiles;
CREATE TRIGGER trigger_auto_update_user_weight
AFTER UPDATE
ON public.user_profiles
FOR EACH ROW
EXECUTE FUNCTION public.trigger_update_user_weight_after();

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- Mutation policies are authority, so converge every historical/dashboard
-- name rather than assuming only the two known vulnerable names exist.
DO $replace_profile_mutation_policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polcmd IN ('*', 'a', 'w', 'd')
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.user_profiles',
      v_policy.polname
    );
  END LOOP;
END
$replace_profile_mutation_policies$;

CREATE POLICY user_profiles_authenticated_safe_update
  ON public.user_profiles
  AS PERMISSIVE
  FOR UPDATE
  TO authenticated
  USING (
    id = (SELECT auth.uid())
    AND deleted_at IS NULL
    AND banned_at IS NULL
    AND NOT (
      COALESCE(is_banned, false)
      AND (
        ban_expires_at IS NULL
        OR ban_expires_at > pg_catalog.statement_timestamp()
      )
    )
  )
  WITH CHECK (
    id = (SELECT auth.uid())
    AND deleted_at IS NULL
    AND banned_at IS NULL
    AND NOT (
      COALESCE(is_banned, false)
      AND (
        ban_expires_at IS NULL
        OR ban_expires_at > pg_catalog.statement_timestamp()
      )
    )
  );

CREATE POLICY user_profiles_service_mutation
  ON public.user_profiles
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Table-level UPDATE overrides every column revoke, so remove both table and
-- column grants before granting back the exact self-service surface.  INSERT
-- and DELETE are server-owned: auth.handle_new_user is the sole provisioner,
-- and account deletion is coordinated by the server cleanup flow.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.user_profiles
  FROM PUBLIC, anon, authenticated;

DO $revoke_profile_column_mutations$
DECLARE
  v_columns text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO STRICT v_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.user_profiles'::pg_catalog.regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  EXECUTE pg_catalog.format(
    'REVOKE INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
      || 'ON TABLE public.user_profiles FROM PUBLIC, anon, authenticated',
    v_columns
  );
END
$revoke_profile_column_mutations$;

GRANT UPDATE (
  handle,
  bio,
  avatar_url,
  cover_url,
  market_pairs,
  notify_follow,
  notify_like,
  notify_comment,
  notify_mention,
  notify_message,
  notify_trader_events,
  show_followers,
  show_following,
  dm_permission,
  email_digest,
  settings_version,
  show_pro_badge,
  last_seen_at,
  is_online,
  interests,
  onboarding_completed,
  search_history
) ON TABLE public.user_profiles TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.user_profiles
  TO service_role;

DO $postflight$
DECLARE
  v_postgres oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_anon oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'anon'
  );
  v_authenticated oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_service oid := (
    SELECT role_row.oid FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_signature pg_catalog.regprocedure;
  v_column record;
  v_safe_columns constant text[] := ARRAY[
    'handle',
    'bio',
    'avatar_url',
    'cover_url',
    'market_pairs',
    'notify_follow',
    'notify_like',
    'notify_comment',
    'notify_mention',
    'notify_message',
    'notify_trader_events',
    'show_followers',
    'show_following',
    'dm_permission',
    'email_digest',
    'settings_version',
    'show_pro_badge',
    'last_seen_at',
    'is_online',
    'interests',
    'onboarding_completed',
    'search_history'
  ]::text[];
BEGIN
  IF pg_catalog.has_schema_privilege('anon', 'public', 'CREATE')
    OR pg_catalog.has_schema_privilege('authenticated', 'public', 'CREATE')
    OR pg_catalog.has_schema_privilege('service_role', 'public', 'CREATE')
  THEN
    RAISE EXCEPTION 'runtime role retains public schema CREATE authority';
  END IF;

  IF pg_catalog.has_table_privilege(
      'anon',
      'public.user_profiles',
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR pg_catalog.has_table_privilege(
      'authenticated',
      'public.user_profiles',
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    ) OR pg_catalog.has_any_column_privilege(
      'anon', 'public.user_profiles', 'INSERT,UPDATE,REFERENCES'
    ) OR pg_catalog.has_any_column_privilege(
      'authenticated', 'public.user_profiles', 'INSERT,REFERENCES'
    ) OR NOT pg_catalog.has_table_privilege(
      'service_role', 'public.user_profiles', 'SELECT,INSERT,UPDATE,DELETE'
    )
  THEN
    RAISE EXCEPTION 'profile table-level mutation ACL did not converge';
  END IF;

  FOR v_column IN
    SELECT attribute.attname
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.user_profiles'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  LOOP
    IF v_column.attname = ANY (v_safe_columns) THEN
      IF NOT pg_catalog.has_column_privilege(
        'authenticated',
        'public.user_profiles',
        v_column.attname,
        'UPDATE'
      ) THEN
        RAISE EXCEPTION 'safe profile update column is unavailable: %',
          v_column.attname;
      END IF;
    ELSIF pg_catalog.has_column_privilege(
      'authenticated',
      'public.user_profiles',
      v_column.attname,
      'UPDATE'
    ) THEN
      RAISE EXCEPTION 'protected profile update column remains writable: %',
        v_column.attname;
    END IF;

    IF pg_catalog.has_column_privilege(
      'anon',
      'public.user_profiles',
      v_column.attname,
      'UPDATE'
    ) THEN
      RAISE EXCEPTION 'anonymous profile update column remains writable: %',
        v_column.attname;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polcmd IN ('*', 'a', 'w', 'd')
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polname = 'user_profiles_authenticated_safe_update'
      AND policy.polcmd = 'w'
      AND policy.polpermissive
      AND policy.polroles = ARRAY[v_authenticated]::oid[]
      AND policy.polqual IS NOT NULL
      AND policy.polwithcheck IS NOT NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polname = 'user_profiles_service_mutation'
      AND policy.polcmd = '*'
      AND policy.polpermissive
      AND policy.polroles = ARRAY[v_service]::oid[]
      AND policy.polqual IS NOT NULL
      AND policy.polwithcheck IS NOT NULL
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polcmd IN ('*', 'a', 'w', 'd')
      AND policy.polroles && ARRAY[0::oid, v_anon]::oid[]
  ) THEN
    RAISE EXCEPTION 'profile mutation policy set did not converge';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.calculate_user_weight(uuid)'::pg_catalog.regprocedure,
    'public.trigger_update_user_weight()'::pg_catalog.regprocedure,
    'public.trigger_update_user_weight_after()'::pg_catalog.regprocedure,
    'public.trigger_update_weight_on_activity()'::pg_catalog.regprocedure,
    'public.sync_author_handle()'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_signature
        AND function_row.proowner = v_postgres
        AND function_row.prosecdef
        AND function_row.proconfig =
          ARRAY['search_path=pg_catalog, public']::text[]
    ) OR pg_catalog.has_function_privilege(
      'anon', v_signature, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated', v_signature, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'service_role', v_signature, 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'profile side-effect function authority drifted: %',
        v_signature;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::pg_catalog.regclass
      AND trigger_row.tgname = 'trigger_auto_update_user_weight'
      AND trigger_row.tgfoid =
        'public.trigger_update_user_weight_after()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 17
      AND trigger_row.tgattr = ''::pg_catalog.int2vector
      AND trigger_row.tgqual IS NULL
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::pg_catalog.regclass
      AND trigger_row.tgname = 'trigger_auto_update_user_weight'
      AND NOT trigger_row.tgisinternal
  ) <> 1 THEN
    RAISE EXCEPTION 'canonical profile weight trigger did not converge';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
