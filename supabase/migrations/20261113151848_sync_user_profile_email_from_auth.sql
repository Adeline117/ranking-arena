-- Keep public.user_profiles.email in step with auth.users.email.
--
-- user_profiles.email was written only by the signup trigger. After a user
-- changed their email in Settings, the profile kept the old address forever,
-- so anything that finds an account by profile email — notably password
-- recovery of a pending-deletion account — failed for the new address.
--
-- An AFTER UPDATE OF email trigger on auth.users mirrors every change, and a
-- one-time backfill repairs rows that have already drifted. Rows whose auth
-- email is NULL (phone / wallet-less identities) are left untouched.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('auth.users') IS NULL THEN
    RAISE EXCEPTION 'auth.users is required';
  END IF;
  IF pg_catalog.to_regclass('public.user_profiles') IS NULL THEN
    RAISE EXCEPTION 'public.user_profiles is required';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.user_profiles'::pg_catalog.regclass
      AND attribute.attname = 'email'
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'public.user_profiles.email is required';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.sync_user_profile_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.email IS NOT NULL AND NEW.email IS DISTINCT FROM OLD.email THEN
    UPDATE public.user_profiles AS profile
    SET email = NEW.email
    WHERE profile.id = NEW.id
      AND profile.email IS DISTINCT FROM NEW.email;
  END IF;
  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.sync_user_profile_email() FROM PUBLIC;

DROP TRIGGER IF EXISTS on_auth_user_email_changed ON auth.users;
CREATE TRIGGER on_auth_user_email_changed
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_user_profile_email();

-- One-time repair of profiles that already drifted.
UPDATE public.user_profiles AS profile
SET email = auth_user.email
FROM auth.users AS auth_user
WHERE auth_user.id = profile.id
  AND auth_user.email IS NOT NULL
  AND profile.email IS DISTINCT FROM auth_user.email;

COMMIT;
