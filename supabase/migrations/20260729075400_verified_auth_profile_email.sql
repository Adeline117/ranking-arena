-- Keep the application email projection bound to the currently verified Auth
-- identity. A confirmed email change can otherwise leave user_profiles.email
-- pointing at an address that is later reassigned to another person.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('user-profile-authority-migrations', 0)
);

DO $preflight$
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
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'required profile-email role is missing: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL THEN
    RAISE EXCEPTION 'auth.users and public.user_profiles are required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth', 'users', 'id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_profiles', 'id', 'uuid'::pg_catalog.regtype),
        ('public', 'user_profiles', 'email', 'text'::pg_catalog.regtype),
        ('public', 'user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype),
        ('public', 'user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype)
    ) AS required_column(schema_name, relation_name, column_name, type_oid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
          required_column.schema_name || '.' || required_column.relation_name
        )
        AND attribute.attname = required_column.column_name
        AND attribute.atttypid = required_column.type_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
      AND attribute.attname = 'email'
      AND attribute.atttypid IN (
        'text'::pg_catalog.regtype,
        'varchar'::pg_catalog.regtype
      )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'profile-email authority columns are incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'admit_verified_auth_profile_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <>
        'p_user_id uuid, p_verified_email text'
  ) THEN
    RAISE EXCEPTION 'unexpected verified profile admission overload exists';
  END IF;
END
$preflight$;

-- Match Auth's row-lock order. This closes the migration backfill window and
-- keeps runtime admission ordered auth.users -> user_profiles, the same order
-- used by hard deletion and Auth-owned cascades.
LOCK TABLE auth.users, public.user_profiles IN SHARE ROW EXCLUSIVE MODE;

UPDATE public.user_profiles AS profile
SET email = auth_user.email::text
FROM auth.users AS auth_user
WHERE auth_user.id = profile.id
  AND profile.email IS DISTINCT FROM auth_user.email::text;

CREATE OR REPLACE FUNCTION public.admit_verified_auth_profile_atomic(
  p_user_id uuid,
  p_verified_email text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_auth_email text;
  v_profile_email text;
  v_banned_at timestamptz;
  v_deleted_at timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'user id is required';
  END IF;

  -- FOR UPDATE conflicts with an Auth email UPDATE, unlike FOR KEY SHARE. The
  -- email proven by the caller can therefore neither change before comparison
  -- nor race a stale projection write after comparison.
  SELECT auth_user.email::text
  INTO v_auth_email
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND OR v_auth_email IS DISTINCT FROM p_verified_email THEN
    RETURN 'unavailable';
  END IF;

  SELECT profile.email, profile.banned_at, profile.deleted_at
  INTO v_profile_email, v_banned_at, v_deleted_at
  FROM public.user_profiles AS profile
  WHERE profile.id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'missing';
  END IF;

  IF v_profile_email IS DISTINCT FROM v_auth_email THEN
    UPDATE public.user_profiles AS profile
    SET email = v_auth_email
    WHERE profile.id = p_user_id;
  END IF;

  IF v_banned_at IS NOT NULL OR v_deleted_at IS NOT NULL THEN
    RETURN 'suspended';
  END IF;
  RETURN 'active';
END
$function$;

ALTER FUNCTION public.admit_verified_auth_profile_atomic(uuid, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admit_verified_auth_profile_atomic(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admit_verified_auth_profile_atomic(uuid, text)
  TO service_role;

DO $postflight$
DECLARE
  v_signature pg_catalog.regprocedure :=
    'public.admit_verified_auth_profile_atomic(uuid,text)'::pg_catalog.regprocedure;
  v_source text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM auth.users AS auth_user
    JOIN public.user_profiles AS profile ON profile.id = auth_user.id
    WHERE profile.email IS DISTINCT FROM auth_user.email::text
  ) THEN
    RAISE EXCEPTION 'persisted profile emails were not converged';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_signature
    AND function_row.proowner = pg_catalog.to_regrole('postgres')
    AND function_row.prorettype = 'text'::pg_catalog.regtype
    AND function_row.prokind = 'f'
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proconfig =
      ARRAY['search_path=pg_catalog, pg_temp']::text[];

  IF pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_source, 'IS DISTINCT FROM p_verified_email') = 0
     OR pg_catalog.strpos(v_source, 'UPDATE public.user_profiles AS profile') = 0 THEN
    RAISE EXCEPTION 'verified profile admission source drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS privilege
    WHERE function_row.oid = v_signature
      AND privilege.grantee = 0
      AND privilege.privilege_type = 'EXECUTE'
  ) OR pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
    RAISE EXCEPTION 'verified profile admission ACL drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'admit_verified_auth_profile_atomic'
  ) <> 1 THEN
    RAISE EXCEPTION 'verified profile admission overload count drifted';
  END IF;
END
$postflight$;

COMMIT;
