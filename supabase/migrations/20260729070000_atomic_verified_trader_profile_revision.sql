-- Prevent a stale verified-trader editor from silently overwriting a newer
-- profile. The database owns profile_version and service_role can update an
-- exact composite identity only through one compare-and-swap statement.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('verified-trader-profile-revision-migrations', 0)
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
      RAISE EXCEPTION 'required verified-trader profile role is missing: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('public.verified_traders') IS NULL THEN
    RAISE EXCEPTION 'verified_traders must exist before profile revision authority';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('id', 'uuid'::pg_catalog.regtype),
        ('user_id', 'uuid'::pg_catalog.regtype),
        ('trader_id', 'text'::pg_catalog.regtype),
        ('source', 'text'::pg_catalog.regtype),
        ('display_name', 'text'::pg_catalog.regtype),
        ('bio', 'text'::pg_catalog.regtype),
        ('avatar_url', 'text'::pg_catalog.regtype),
        ('twitter_url', 'text'::pg_catalog.regtype),
        ('telegram_url', 'text'::pg_catalog.regtype),
        ('discord_url', 'text'::pg_catalog.regtype),
        ('website_url', 'text'::pg_catalog.regtype),
        ('can_receive_messages', 'boolean'::pg_catalog.regtype)
    ) AS required_column(column_name, type_oid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.verified_traders'::pg_catalog.regclass
        AND attribute.attname = required_column.column_name
        AND attribute.atttypid = required_column.type_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'verified-trader profile columns or types are incompatible';
  END IF;
END
$preflight$;

LOCK TABLE public.verified_traders IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.verified_traders
  ADD COLUMN IF NOT EXISTS profile_version integer;

DO $profile_version_type$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.verified_traders'::pg_catalog.regclass
      AND attribute.attname = 'profile_version'
      AND attribute.atttypid = 'integer'::pg_catalog.regtype
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'verified_traders.profile_version has an incompatible type';
  END IF;
END
$profile_version_type$;

UPDATE public.verified_traders AS verified
SET profile_version = 0
WHERE verified.profile_version IS NULL
   OR verified.profile_version < 0;

ALTER TABLE public.verified_traders
  ALTER COLUMN profile_version SET DEFAULT 0,
  ALTER COLUMN profile_version SET NOT NULL;

ALTER TABLE public.verified_traders
  DROP CONSTRAINT IF EXISTS verified_traders_profile_version_nonnegative_check;
ALTER TABLE public.verified_traders
  ADD CONSTRAINT verified_traders_profile_version_nonnegative_check
  CHECK (profile_version >= 0) NOT VALID;
ALTER TABLE public.verified_traders
  VALIDATE CONSTRAINT verified_traders_profile_version_nonnegative_check;

CREATE OR REPLACE FUNCTION public.own_verified_trader_profile_version()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.profile_version := 0;
  ELSIF OLD.display_name IS DISTINCT FROM NEW.display_name
     OR OLD.bio IS DISTINCT FROM NEW.bio
     OR OLD.avatar_url IS DISTINCT FROM NEW.avatar_url
     OR OLD.twitter_url IS DISTINCT FROM NEW.twitter_url
     OR OLD.telegram_url IS DISTINCT FROM NEW.telegram_url
     OR OLD.discord_url IS DISTINCT FROM NEW.discord_url
     OR OLD.website_url IS DISTINCT FROM NEW.website_url
     OR OLD.can_receive_messages IS DISTINCT FROM NEW.can_receive_messages THEN
    NEW.profile_version := OLD.profile_version + 1;
  ELSE
    -- Ignore even a privileged caller's direct attempt to forge the revision.
    NEW.profile_version := OLD.profile_version;
  END IF;

  RETURN NEW;
END;
$function$;

ALTER FUNCTION public.own_verified_trader_profile_version() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.own_verified_trader_profile_version()
  FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_verified_traders_01_profile_version
  ON public.verified_traders;
CREATE TRIGGER trg_verified_traders_01_profile_version
BEFORE INSERT OR UPDATE
ON public.verified_traders
FOR EACH ROW
EXECUTE FUNCTION public.own_verified_trader_profile_version();

CREATE OR REPLACE FUNCTION public.update_verified_trader_profile_cas(
  p_user_id uuid,
  p_trader_id text,
  p_source text,
  p_expected_version integer,
  p_updates jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_verified public.verified_traders%ROWTYPE;
BEGIN
  IF p_user_id IS NULL
     OR p_trader_id IS NULL
     OR p_trader_id = ''
     OR p_source IS NULL
     OR p_source = ''
     OR p_expected_version IS NULL
     OR p_expected_version < 0
     OR p_updates IS NULL
     OR pg_catalog.jsonb_typeof(p_updates) <> 'object'
     OR p_updates = '{}'::jsonb THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid verified-trader profile update';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_object_keys(p_updates) AS update_key(key)
    WHERE update_key.key NOT IN (
      'display_name',
      'bio',
      'avatar_url',
      'twitter_url',
      'telegram_url',
      'discord_url',
      'website_url',
      'can_receive_messages'
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'unknown verified-trader profile field';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('display_name', 100),
        ('bio', 500),
        ('avatar_url', 4096),
        ('twitter_url', 4096),
        ('telegram_url', 4096),
        ('discord_url', 4096),
        ('website_url', 4096)
    ) AS text_field(field_name, maximum_length)
    WHERE p_updates ? text_field.field_name
      AND (
        pg_catalog.jsonb_typeof(p_updates -> text_field.field_name)
          NOT IN ('string', 'null')
        OR pg_catalog.char_length(p_updates ->> text_field.field_name)
          > text_field.maximum_length
      )
  )
  OR (
    p_updates ? 'can_receive_messages'
    AND pg_catalog.jsonb_typeof(p_updates -> 'can_receive_messages') <> 'boolean'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid verified-trader profile field value';
  END IF;

  UPDATE public.verified_traders AS verified
  SET display_name = CASE
        WHEN p_updates ? 'display_name' THEN p_updates ->> 'display_name'
        ELSE verified.display_name
      END,
      bio = CASE
        WHEN p_updates ? 'bio' THEN p_updates ->> 'bio'
        ELSE verified.bio
      END,
      avatar_url = CASE
        WHEN p_updates ? 'avatar_url' THEN p_updates ->> 'avatar_url'
        ELSE verified.avatar_url
      END,
      twitter_url = CASE
        WHEN p_updates ? 'twitter_url' THEN p_updates ->> 'twitter_url'
        ELSE verified.twitter_url
      END,
      telegram_url = CASE
        WHEN p_updates ? 'telegram_url' THEN p_updates ->> 'telegram_url'
        ELSE verified.telegram_url
      END,
      discord_url = CASE
        WHEN p_updates ? 'discord_url' THEN p_updates ->> 'discord_url'
        ELSE verified.discord_url
      END,
      website_url = CASE
        WHEN p_updates ? 'website_url' THEN p_updates ->> 'website_url'
        ELSE verified.website_url
      END,
      can_receive_messages = CASE
        WHEN p_updates ? 'can_receive_messages'
          THEN (p_updates ->> 'can_receive_messages')::boolean
        ELSE verified.can_receive_messages
      END
  WHERE verified.user_id = p_user_id
    AND verified.trader_id = p_trader_id
    AND verified.source = p_source
    AND verified.profile_version = p_expected_version
  RETURNING verified.* INTO v_verified;

  IF NOT FOUND THEN
    IF EXISTS (
      SELECT 1
      FROM public.verified_traders AS verified
      WHERE verified.user_id = p_user_id
        AND verified.trader_id = p_trader_id
        AND verified.source = p_source
        AND verified.profile_version IS DISTINCT FROM p_expected_version
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'verified-trader profile changed since it was loaded';
    END IF;

    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'owned verified-trader profile not found';
  END IF;

  RETURN pg_catalog.to_jsonb(v_verified);
END;
$function$;

ALTER FUNCTION public.update_verified_trader_profile_cas(
  uuid,
  text,
  text,
  integer,
  jsonb
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.update_verified_trader_profile_cas(
  uuid,
  text,
  text,
  integer,
  jsonb
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_verified_trader_profile_cas(
  uuid,
  text,
  text,
  integer,
  jsonb
) TO service_role;

DO $postflight$
DECLARE
  v_postgres oid := 'postgres'::pg_catalog.regrole;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.verified_traders'::pg_catalog.regclass
      AND attribute.attname = 'profile_version'
      AND attribute.atttypid = 'integer'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'verified-trader profile revision column is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.verified_traders'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_verified_traders_01_profile_version'
      AND trigger_row.tgfoid =
            'public.own_verified_trader_profile_version()'::pg_catalog.regprocedure
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
  ) THEN
    RAISE EXCEPTION 'verified-trader profile revision trigger is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.own_verified_trader_profile_version()'::pg_catalog.regprocedure,
          false
        ),
        (
          'public.update_verified_trader_profile_cas(uuid,text,text,integer,jsonb)'::pg_catalog.regprocedure,
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
    RAISE EXCEPTION 'verified-trader profile function authority drifted';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon',
       'public.update_verified_trader_profile_cas(uuid,text,text,integer,jsonb)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.update_verified_trader_profile_cas(uuid,text,text,integer,jsonb)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.update_verified_trader_profile_cas(uuid,text,text,integer,jsonb)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role',
       'public.own_verified_trader_profile_version()',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'verified-trader profile privilege boundary is incorrect';
  END IF;
END
$postflight$;

COMMENT ON COLUMN public.verified_traders.profile_version IS
  'Database-owned revision for compare-and-swap profile edits.';
COMMENT ON FUNCTION public.update_verified_trader_profile_cas(
  uuid,
  text,
  text,
  integer,
  jsonb
) IS
  'Service-only exact-identity compare-and-swap for verified-trader profile edits; stale revisions fail with SQLSTATE 40001.';

NOTIFY pgrst, 'reload schema';

COMMIT;
