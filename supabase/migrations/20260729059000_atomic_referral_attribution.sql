-- Bind a user's immutable referral edge and its reward attribution in one
-- transaction. A partial failure must never consume the user's only apply
-- attempt without leaving the qualification record that owns future rewards.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('atomic-referral-attribution-migration', 0)
);

DO $preflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
BEGIN
  IF v_postgres IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
    OR pg_catalog.to_regprocedure('auth.role()') IS NULL
  THEN
    RAISE EXCEPTION
      'atomic referral attribution requires standard Supabase roles and auth.role()';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.user_profiles'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND relation.relowner = v_postgres
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.referral_attributions'::pg_catalog.regclass
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND relation.relowner = v_postgres
  ) THEN
    RAISE EXCEPTION 'atomic referral attribution relations are incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_profiles', 'referred_by', 'uuid'::pg_catalog.regtype, false),
        ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('referral_attributions', 'id', 'uuid'::pg_catalog.regtype, true),
        ('referral_attributions', 'referred_id', 'uuid'::pg_catalog.regtype, true),
        ('referral_attributions', 'referrer_id', 'uuid'::pg_catalog.regtype, true),
        ('referral_attributions', 'provider', 'text'::pg_catalog.regtype, false),
        ('referral_attributions', 'signup_ip_hash', 'text'::pg_catalog.regtype, false),
        ('referral_attributions', 'friend_granted', 'bool'::pg_catalog.regtype, true),
        ('referral_attributions', 'qualified_at', 'timestamptz'::pg_catalog.regtype, false)
    ) AS required_column(table_name, column_name, type_oid, must_be_not_null)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid =
          pg_catalog.to_regclass('public.' || required_column.table_name)
        AND attribute.attname = required_column.column_name
        AND attribute.atttypid = required_column.type_oid
        AND attribute.atttypmod = -1
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND (
          NOT required_column.must_be_not_null
          OR attribute.attnotnull
        )
    )
  ) THEN
    RAISE EXCEPTION 'atomic referral attribution columns are incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
        'public.referral_attributions'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname
          ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attribute_number, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attribute_number
      ) = ARRAY['referred_id']::name[]
  ) THEN
    RAISE EXCEPTION
      'atomic referral attribution requires unique referred identity';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.apply_referral_attribution_atomic(
  p_referred_id uuid,
  p_referrer_id uuid,
  p_provider text,
  p_signup_ip_hash text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_referred public.user_profiles%ROWTYPE;
  v_attribution public.referral_attributions%ROWTYPE;
  v_referrer_exists boolean := false;
  v_created boolean := false;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_referred_id IS NULL
    OR p_referrer_id IS NULL
    OR p_referred_id = p_referrer_id
    OR (
      p_provider IS NOT NULL
      AND (
        pg_catalog.length(p_provider) NOT BETWEEN 1 AND 100
        OR p_provider <> pg_catalog.btrim(p_provider)
        OR p_provider ~ '[[:cntrl:]]'
      )
    )
    OR (
      p_signup_ip_hash IS NOT NULL
      AND p_signup_ip_hash !~ '^[0-9a-f]{32}$'
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  -- Lock both identities in canonical UUID order. This serializes two codes
  -- racing for one user without introducing an A-refers-B/B-refers-A deadlock.
  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id IN (p_referred_id, p_referrer_id)
  ORDER BY profile.id
  FOR UPDATE;

  SELECT profile.*
  INTO v_referred
  FROM public.user_profiles AS profile
  WHERE profile.id = p_referred_id
    AND profile.deleted_at IS NULL;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    WHERE profile.id = p_referrer_id
      AND profile.deleted_at IS NULL
  )
  INTO STRICT v_referrer_exists;
  IF NOT v_referrer_exists THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT attribution.*
  INTO v_attribution
  FROM public.referral_attributions AS attribution
  WHERE attribution.referred_id = p_referred_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_attribution.referrer_id IS DISTINCT FROM p_referrer_id THEN
      RETURN pg_catalog.jsonb_build_object('status', 'conflict');
    END IF;
    IF v_referred.referred_by IS NOT NULL
      AND v_referred.referred_by IS DISTINCT FROM p_referrer_id
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'inconsistent');
    END IF;

    -- Repair the historical inverse half-write (attribution exists but the
    -- profile edge did not persist) without changing the immutable attribution.
    IF v_referred.referred_by IS NULL THEN
      UPDATE public.user_profiles AS profile
      SET referred_by = p_referrer_id
      WHERE profile.id = p_referred_id
        AND profile.deleted_at IS NULL
        AND profile.referred_by IS NULL;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'referral profile repair matched no row'
          USING ERRCODE = 'P0002';
      END IF;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_applied',
      'referred_id', p_referred_id,
      'referrer_id', p_referrer_id,
      'attribution_id', v_attribution.id,
      'created', false
    );
  END IF;

  IF v_referred.referred_by IS NOT NULL
    AND v_referred.referred_by IS DISTINCT FROM p_referrer_id
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'conflict');
  END IF;

  INSERT INTO public.referral_attributions (
    referred_id,
    referrer_id,
    provider,
    signup_ip_hash,
    friend_granted
  ) VALUES (
    p_referred_id,
    p_referrer_id,
    p_provider,
    p_signup_ip_hash,
    false
  )
  RETURNING * INTO STRICT v_attribution;
  v_created := true;

  -- Insert first so an old profile-only half-write is repaired too. The whole
  -- function remains one transaction: an injected failure in either mutation
  -- rolls both states back.
  IF v_referred.referred_by IS NULL THEN
    UPDATE public.user_profiles AS profile
    SET referred_by = p_referrer_id
    WHERE profile.id = p_referred_id
      AND profile.deleted_at IS NULL
      AND profile.referred_by IS NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'referral profile attribution matched no row'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'applied',
    'referred_id', p_referred_id,
    'referrer_id', p_referrer_id,
    'attribution_id', v_attribution.id,
    'created', v_created
  );
END
$function$;

ALTER FUNCTION public.apply_referral_attribution_atomic(
  uuid,
  uuid,
  text,
  text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.apply_referral_attribution_atomic(
  uuid,
  uuid,
  text,
  text
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.apply_referral_attribution_atomic(
  uuid,
  uuid,
  text,
  text
) TO service_role;

COMMIT;
