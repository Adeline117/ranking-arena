-- Prevent stale settings tabs from silently overwriting a newer profile.
-- The database owns the revision and the authenticated RPC performs one
-- compare-and-swap across every field saved by the profile form.

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
      RAISE EXCEPTION 'required profile revision role is missing: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regprocedure('auth.uid()') IS NULL THEN
    RAISE EXCEPTION 'profile table and auth.uid() must exist before profile revision authority';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('id', 'uuid'::pg_catalog.regtype),
        ('handle', 'text'::pg_catalog.regtype),
        ('bio', 'text'::pg_catalog.regtype),
        ('avatar_url', 'text'::pg_catalog.regtype),
        ('cover_url', 'text'::pg_catalog.regtype),
        ('show_followers', 'boolean'::pg_catalog.regtype),
        ('show_following', 'boolean'::pg_catalog.regtype),
        ('dm_permission', 'text'::pg_catalog.regtype),
        ('show_pro_badge', 'boolean'::pg_catalog.regtype),
        ('settings_version', 'integer'::pg_catalog.regtype),
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
    RAISE EXCEPTION 'profile revision columns or types are incompatible';
  END IF;
END
$preflight$;

LOCK TABLE public.user_profiles IN SHARE ROW EXCLUSIVE MODE;

-- The historical column was nullable and directly writable even though its
-- comment promised conflict detection. Converge it before making it authority.
UPDATE public.user_profiles AS profile
SET settings_version = 0
WHERE profile.settings_version IS NULL
   OR profile.settings_version < 0;

ALTER TABLE public.user_profiles
  ALTER COLUMN settings_version SET DEFAULT 0,
  ALTER COLUMN settings_version SET NOT NULL;

ALTER TABLE public.user_profiles
  DROP CONSTRAINT IF EXISTS user_profiles_settings_version_nonnegative_check;
ALTER TABLE public.user_profiles
  ADD CONSTRAINT user_profiles_settings_version_nonnegative_check
  CHECK (settings_version >= 0) NOT VALID;
ALTER TABLE public.user_profiles
  VALIDATE CONSTRAINT user_profiles_settings_version_nonnegative_check;

CREATE OR REPLACE FUNCTION public.bump_user_profile_settings_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF OLD.handle IS DISTINCT FROM NEW.handle
     OR OLD.bio IS DISTINCT FROM NEW.bio
     OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url
     OR OLD.cover_url IS DISTINCT FROM NEW.cover_url
     OR OLD.show_followers IS DISTINCT FROM NEW.show_followers
     OR OLD.show_following IS DISTINCT FROM NEW.show_following
     OR OLD.dm_permission IS DISTINCT FROM NEW.dm_permission
     OR OLD.show_pro_badge IS DISTINCT FROM NEW.show_pro_badge THEN
    NEW.settings_version := OLD.settings_version + 1;
  ELSE
    NEW.settings_version := OLD.settings_version;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.bump_user_profile_settings_version() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.bump_user_profile_settings_version()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_user_profiles_04_settings_version
  ON public.user_profiles;
CREATE TRIGGER trg_user_profiles_04_settings_version
BEFORE UPDATE OF
  handle,
  bio,
  avatar_url,
  cover_url,
  show_followers,
  show_following,
  dm_permission,
  show_pro_badge
ON public.user_profiles
FOR EACH ROW
EXECUTE FUNCTION public.bump_user_profile_settings_version();

CREATE OR REPLACE FUNCTION public.update_own_profile_settings(
  p_expected_version integer,
  p_handle text,
  p_bio text,
  p_avatar_url text,
  p_cover_url text,
  p_show_followers boolean,
  p_show_following boolean,
  p_dm_permission text,
  p_show_pro_badge boolean
)
RETURNS TABLE (
  profile_id uuid,
  settings_version integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_user_id uuid := (SELECT auth.uid());
  v_profile_id uuid;
  v_settings_version integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'authentication required';
  END IF;

  IF p_expected_version IS NULL
     OR p_expected_version < 0
     OR p_bio IS NOT NULL
        AND pg_catalog.char_length(p_bio) > 200
     OR p_avatar_url IS NOT NULL
        AND pg_catalog.char_length(p_avatar_url) > 4096
     OR p_cover_url IS NOT NULL
        AND pg_catalog.char_length(p_cover_url) > 4096
     OR p_show_followers IS NULL
     OR p_show_following IS NULL
     OR p_show_pro_badge IS NULL
     OR p_dm_permission IS NULL
     OR p_dm_permission NOT IN ('all', 'mutual', 'none') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid profile settings';
  END IF;

  -- NULL means "preserve the existing handle". This keeps an unchanged handle
  -- out of the UPDATE column list, so old rows can save other fields without
  -- accidentally invoking handle mutation semantics.
  IF p_handle IS NULL THEN
    UPDATE public.user_profiles AS profile
    SET bio = p_bio,
        avatar_url = p_avatar_url,
        cover_url = p_cover_url,
        show_followers = p_show_followers,
        show_following = p_show_following,
        dm_permission = p_dm_permission,
        show_pro_badge = p_show_pro_badge
    WHERE profile.id = v_user_id
      AND profile.settings_version = p_expected_version
      AND profile.deleted_at IS NULL
      AND profile.banned_at IS NULL
      AND NOT (
        COALESCE(profile.is_banned, false)
        AND (
          profile.ban_expires_at IS NULL
          OR profile.ban_expires_at > pg_catalog.statement_timestamp()
        )
      )
    RETURNING profile.id, profile.settings_version
    INTO v_profile_id, v_settings_version;
  ELSE
    UPDATE public.user_profiles AS profile
    SET handle = p_handle,
        bio = p_bio,
        avatar_url = p_avatar_url,
        cover_url = p_cover_url,
        show_followers = p_show_followers,
        show_following = p_show_following,
        dm_permission = p_dm_permission,
        show_pro_badge = p_show_pro_badge
    WHERE profile.id = v_user_id
      AND profile.settings_version = p_expected_version
      AND profile.deleted_at IS NULL
      AND profile.banned_at IS NULL
      AND NOT (
        COALESCE(profile.is_banned, false)
        AND (
          profile.ban_expires_at IS NULL
          OR profile.ban_expires_at > pg_catalog.statement_timestamp()
        )
      )
    RETURNING profile.id, profile.settings_version
    INTO v_profile_id, v_settings_version;
  END IF;

  IF v_profile_id IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.user_profiles AS profile
      WHERE profile.id = v_user_id
        AND profile.deleted_at IS NULL
        AND profile.banned_at IS NULL
        AND NOT (
          COALESCE(profile.is_banned, false)
          AND (
            profile.ban_expires_at IS NULL
            OR profile.ban_expires_at > pg_catalog.statement_timestamp()
          )
        )
        AND profile.settings_version IS DISTINCT FROM p_expected_version
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'profile settings changed since they were loaded';
    END IF;

    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'writable user profile not found';
  END IF;

  RETURN QUERY
  SELECT v_profile_id, v_settings_version;
END;
$function$;

ALTER FUNCTION public.update_own_profile_settings(
  integer,
  text,
  text,
  text,
  text,
  boolean,
  boolean,
  text,
  boolean
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_own_profile_settings(
  integer,
  text,
  text,
  text,
  text,
  boolean,
  boolean,
  text,
  boolean
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_own_profile_settings(
  integer,
  text,
  text,
  text,
  text,
  boolean,
  boolean,
  text,
  boolean
) TO authenticated;

-- The revision is trigger-owned. Authenticated callers receive it through
-- get_own_profile_sensitive and the CAS acknowledgement, never by writing it.
REVOKE UPDATE (settings_version)
  ON TABLE public.user_profiles
  FROM PUBLIC, anon, authenticated;

DO $postflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_authenticated oid := pg_catalog.to_regrole('authenticated');
BEGIN
  IF (
       SELECT attribute.attnotnull
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'public.user_profiles'::pg_catalog.regclass
         AND attribute.attname = 'settings_version'
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) IS DISTINCT FROM true
     OR (
       SELECT pg_catalog.pg_get_expr(
         default_row.adbin,
         default_row.adrelid
       )
       FROM pg_catalog.pg_attrdef AS default_row
       JOIN pg_catalog.pg_attribute AS attribute
         ON attribute.attrelid = default_row.adrelid
        AND attribute.attnum = default_row.adnum
       WHERE default_row.adrelid = 'public.user_profiles'::pg_catalog.regclass
         AND attribute.attname = 'settings_version'
     ) <> '0' THEN
    RAISE EXCEPTION 'profile settings revision column is not canonical';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.user_profiles'::pg_catalog.regclass
      AND constraint_row.conname =
            'user_profiles_settings_version_nonnegative_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'profile settings revision constraint is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_profiles'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_user_profiles_04_settings_version'
      AND trigger_row.tgfoid =
            'public.bump_user_profile_settings_version()'::pg_catalog.regprocedure
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'profile settings revision trigger is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.bump_user_profile_settings_version()'::pg_catalog.regprocedure,
          false
        ),
        (
          'public.update_own_profile_settings(integer,text,text,text,text,boolean,boolean,text,boolean)'::pg_catalog.regprocedure,
          true
        )
    ) AS expected_function(signature, security_definer)
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = expected_function.signature
    WHERE function_row.proowner <> v_postgres
       OR function_row.prosecdef IS DISTINCT FROM expected_function.security_definer
       OR function_row.proconfig IS DISTINCT FROM
            ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'profile settings revision function authority drifted';
  END IF;

  IF pg_catalog.has_column_privilege(
       'authenticated',
       'public.user_profiles',
       'settings_version',
       'UPDATE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'public.update_own_profile_settings(integer,text,text,text,text,boolean,boolean,text,boolean)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'authenticated',
       'public.update_own_profile_settings(integer,text,text,text,text,boolean,boolean,text,boolean)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'public.update_own_profile_settings(integer,text,text,text,text,boolean,boolean,text,boolean)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role',
       'public.user_profiles',
       'UPDATE'
     )
     OR v_authenticated IS NULL THEN
    RAISE EXCEPTION 'profile settings revision privilege boundary is incorrect';
  END IF;
END
$postflight$;

COMMENT ON FUNCTION public.update_own_profile_settings(
  integer,
  text,
  text,
  text,
  text,
  boolean,
  boolean,
  text,
  boolean
) IS
  'Authenticated compare-and-swap for the settings profile form; stale revisions fail with SQLSTATE 40001.';

NOTIFY pgrst, 'reload schema';

COMMIT;
