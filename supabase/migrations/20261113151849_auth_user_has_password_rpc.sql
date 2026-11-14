-- Let server routes ask whether an account actually has a password.
--
-- Email signup creates the auth user (with an `email` identity) when the code
-- is sent; the password is set in a later step. Code that treated "has an
-- email identity" as "has a password" demanded a password that did not exist,
-- e.g. account deletion answered "Invalid password" forever for users who
-- only ever signed in with email codes.
--
-- The answer lives in auth.users.encrypted_password, which is not exposed by
-- the auth admin API. This function returns only the boolean, is callable by
-- service_role alone, and never returns the hash.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'auth.users is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
      AND attribute.attname = 'encrypted_password'
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'auth.users.encrypted_password is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'service_role is required';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.auth_user_has_password(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT COALESCE(
    (
      SELECT auth_user.encrypted_password IS NOT NULL
        AND auth_user.encrypted_password <> ''
      FROM auth.users AS auth_user
      WHERE auth_user.id = p_user_id
    ),
    false
  )
$$;

REVOKE ALL ON FUNCTION public.auth_user_has_password(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_user_has_password(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_user_has_password(uuid) TO service_role;

COMMIT;
