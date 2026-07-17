-- Replace public profile row visibility with the current B2C audience:
-- active accounts are discoverable, an authenticated account can still read
-- itself for recovery/settings, and service_role retains operational access.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '1min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('user-profile-authority-migrations', 0)
);

DO $required_objects$
DECLARE
  v_role text;
  v_profile pg_catalog.regclass := pg_catalog.to_regclass(
    'public.user_profiles'
  );
  v_uid pg_catalog.regprocedure := pg_catalog.to_regprocedure('auth.uid()');
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
      RAISE EXCEPTION 'required profile-read role is missing: %', v_role;
    END IF;
  END LOOP;

  IF v_profile IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_profile
      AND relation.relkind IN ('r', 'p')
      AND relation.relowner = (
        SELECT role_row.oid
        FROM pg_catalog.pg_roles AS role_row
        WHERE role_row.rolname = 'postgres'
      )
  ) THEN
    RAISE EXCEPTION 'public.user_profiles must be an ordinary postgres-owned table';
  END IF;

  IF v_uid IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_uid
      AND function_row.prorettype = 'uuid'::pg_catalog.regtype
      AND function_row.prokind = 'f'
  ) THEN
    RAISE EXCEPTION 'auth.uid() must exist and return uuid';
  END IF;
END
$required_objects$;

LOCK TABLE public.user_profiles IN ACCESS EXCLUSIVE MODE;

DO $preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('id', 'uuid'::pg_catalog.regtype),
        ('deleted_at', 'timestamptz'::pg_catalog.regtype),
        ('banned_at', 'timestamptz'::pg_catalog.regtype),
        ('is_banned', 'boolean'::pg_catalog.regtype),
        ('ban_expires_at', 'timestamptz'::pg_catalog.regtype)
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
    RAISE EXCEPTION 'public.user_profiles read-audience columns are incompatible';
  END IF;
END
$preflight$;

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;

-- PostgreSQL ORs permissive policies.  Replacing only the historical named
-- SELECT policy would leave any dashboard/manual SELECT or FOR ALL policy as a
-- row-enumeration backdoor.  Converge every policy that can authorize SELECT,
-- including the canonical service FOR ALL policy, then rebuild both roles.
DO $replace_profile_read_policies$
DECLARE
  v_policy record;
BEGIN
  FOR v_policy IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polcmd IN ('r', '*')
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.user_profiles',
      v_policy.polname
    );
  END LOOP;
END
$replace_profile_read_policies$;

CREATE POLICY user_profiles_active_or_self_read
  ON public.user_profiles
  AS PERMISSIVE
  FOR SELECT
  TO anon, authenticated
  USING (
    (
      deleted_at IS NULL
      AND banned_at IS NULL
      AND NOT (
        COALESCE(is_banned, false)
        AND (
          ban_expires_at IS NULL
          OR ban_expires_at > pg_catalog.statement_timestamp()
        )
      )
    )
    OR (
      CURRENT_USER = 'authenticated'
      AND id = (SELECT auth.uid())
    )
  );

-- Recreate the mutation migration's canonical service policy exactly.  Using
-- NOBYPASSRLS in the executable proof ensures this policy, rather than a role
-- attribute, preserves recovery/moderation/server-helper access.
CREATE POLICY user_profiles_service_mutation
  ON public.user_profiles
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

DO $postflight$
DECLARE
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
  v_read_source text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.user_profiles'::pg_catalog.regclass
      AND relation.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'public.user_profiles row security is disabled';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polcmd IN ('r', '*')
  ) <> 2 THEN
    RAISE EXCEPTION 'profile read policy set did not converge';
  END IF;

  SELECT pg_catalog.pg_get_expr(policy.polqual, policy.polrelid)
  INTO v_read_source
  FROM pg_catalog.pg_policy AS policy
  WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
    AND policy.polname = 'user_profiles_active_or_self_read'
    AND policy.polpermissive
    AND policy.polcmd = 'r'
    AND policy.polroles @> ARRAY[v_anon, v_authenticated]::oid[]
    AND policy.polroles <@ ARRAY[v_anon, v_authenticated]::oid[]
    AND policy.polwithcheck IS NULL;

  IF v_read_source IS NULL
    OR pg_catalog.strpos(pg_catalog.lower(v_read_source), 'deleted_at is null') = 0
    OR pg_catalog.strpos(pg_catalog.lower(v_read_source), 'banned_at is null') = 0
    OR pg_catalog.strpos(pg_catalog.lower(v_read_source), 'is_banned') = 0
    OR pg_catalog.strpos(pg_catalog.lower(v_read_source), 'ban_expires_at') = 0
    OR pg_catalog.strpos(
      pg_catalog.lower(v_read_source),
      'statement_timestamp()'
    ) = 0
    OR pg_catalog.strpos(pg_catalog.lower(v_read_source), 'current_user') = 0
    OR pg_catalog.strpos(pg_catalog.lower(v_read_source), 'auth.uid()') = 0
  THEN
    RAISE EXCEPTION 'active-or-self profile read policy is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.user_profiles'::pg_catalog.regclass
      AND policy.polname = 'user_profiles_service_mutation'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) THEN
    RAISE EXCEPTION 'service profile authority was not preserved';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
