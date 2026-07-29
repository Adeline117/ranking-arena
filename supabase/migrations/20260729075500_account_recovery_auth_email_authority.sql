-- Password-based account recovery must resolve the subject from the current
-- Auth identity. user_profiles.email is only a projection and may lag a
-- confirmed email change or retain an address that has since been reassigned.

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
    'authenticator',
    'service_role'
  ]::text[]
  LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'required recovery-email role is missing: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL THEN
    RAISE EXCEPTION 'auth.users and public.user_profiles are required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
      AND attribute.attname = 'id'
      AND attribute.atttypid = 'uuid'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
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
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.user_profiles'::pg_catalog.regclass
      AND attribute.attname = 'id'
      AND attribute.atttypid = 'uuid'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'recovery-email authority columns are incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'resolve_account_recovery_auth_subject'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <>
        'p_email text'
  ) THEN
    RAISE EXCEPTION 'unexpected recovery Auth subject resolver overload exists';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.resolve_account_recovery_auth_subject(
  p_email text
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET statement_timeout = '5s'
AS $function$
DECLARE
  v_candidate uuid;
  v_subject uuid;
  v_match_count integer := 0;
  v_email text;
BEGIN
  IF p_email IS NULL OR pg_catalog.length(p_email) > 320 THEN
    RETURN NULL;
  END IF;
  v_email := pg_catalog.btrim(p_email);
  IF v_email = '' THEN
    RETURN NULL;
  END IF;

  -- Limit to two rows so any unexpected Auth uniqueness drift fails closed
  -- without scanning or returning an arbitrary identity.
  FOR v_candidate IN
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE pg_catalog.lower(pg_catalog.btrim(auth_user.email::text)) =
      pg_catalog.lower(v_email)
    ORDER BY auth_user.id
    LIMIT 2
  LOOP
    v_match_count := v_match_count + 1;
    v_subject := v_candidate;
  END LOOP;

  IF v_match_count <> 1 THEN
    RETURN NULL;
  END IF;
  RETURN v_subject;
END
$function$;

ALTER FUNCTION public.resolve_account_recovery_auth_subject(text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.resolve_account_recovery_auth_subject(text)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_account_recovery_auth_subject(text)
  TO service_role;

DO $postflight$
DECLARE
  v_signature pg_catalog.regprocedure :=
    'public.resolve_account_recovery_auth_subject(text)'::pg_catalog.regprocedure;
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_signature
    AND function_row.proowner = pg_catalog.to_regrole('postgres')
    AND function_row.prorettype = 'uuid'::pg_catalog.regtype
    AND function_row.prokind = 'f'
    AND function_row.prosecdef
    AND function_row.provolatile = 's'
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'statement_timeout=5s'
    ]::text[];

  IF pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'pg_catalog.lower') = 0
     OR pg_catalog.strpos(v_source, 'LIMIT 2') = 0
     OR pg_catalog.strpos(v_source, 'v_match_count <> 1') = 0 THEN
    RAISE EXCEPTION 'recovery Auth subject resolver source drifted';
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
     OR pg_catalog.has_function_privilege('authenticator', v_signature, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
    RAISE EXCEPTION 'recovery Auth subject resolver ACL drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'resolve_account_recovery_auth_subject'
  ) <> 1 THEN
    RAISE EXCEPTION 'recovery Auth subject resolver overload count drifted';
  END IF;
END
$postflight$;

COMMIT;
