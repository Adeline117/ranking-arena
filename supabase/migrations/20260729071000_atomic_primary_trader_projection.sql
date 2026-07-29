-- Keep the canonical linked-account primary, verified-trader primary, and
-- user-profile projection identical. Historical switches updated only two of
-- these three projections, leaving claimed profiles attached to the wrong
-- account until a later activation or unlink happened to repair them.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('primary-trader-projection-migration', 0)
);

DO $preflight$
DECLARE
  v_role text;
  v_relation text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'postgres',
    'anon',
    'authenticated',
    'service_role'
  ]::text[]
  LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'required primary-projection role is missing: %', v_role;
    END IF;
  END LOOP;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.user_linked_traders',
    'public.verified_traders',
    'public.user_profiles',
    'public.user_linked_traders_one_primary_per_user'
  ]::text[]
  LOOP
    IF pg_catalog.to_regclass(v_relation) IS NULL THEN
      RAISE EXCEPTION 'required primary-projection relation is missing: %', v_relation;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure(
       'public.set_primary_linked_trader(uuid,uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION 'atomic linked-trader primary foundation is missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('user_linked_traders', 'id', 'uuid'::pg_catalog.regtype),
        ('user_linked_traders', 'user_id', 'uuid'::pg_catalog.regtype),
        ('user_linked_traders', 'trader_id', 'text'::pg_catalog.regtype),
        ('user_linked_traders', 'source', 'text'::pg_catalog.regtype),
        ('user_linked_traders', 'is_primary', 'boolean'::pg_catalog.regtype),
        ('user_linked_traders', 'display_order', 'integer'::pg_catalog.regtype),
        ('user_linked_traders', 'created_at', 'timestamptz'::pg_catalog.regtype),
        ('user_linked_traders', 'updated_at', 'timestamptz'::pg_catalog.regtype),
        ('verified_traders', 'user_id', 'uuid'::pg_catalog.regtype),
        ('verified_traders', 'id', 'uuid'::pg_catalog.regtype),
        ('verified_traders', 'trader_id', 'text'::pg_catalog.regtype),
        ('verified_traders', 'source', 'text'::pg_catalog.regtype),
        ('verified_traders', 'is_primary', 'boolean'::pg_catalog.regtype),
        ('verified_traders', 'updated_at', 'timestamptz'::pg_catalog.regtype),
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype),
        ('user_profiles', 'is_verified_trader', 'boolean'::pg_catalog.regtype),
        ('user_profiles', 'verified_trader_id', 'text'::pg_catalog.regtype),
        ('user_profiles', 'verified_trader_source', 'text'::pg_catalog.regtype),
        ('user_profiles', 'linked_trader_count', 'integer'::pg_catalog.regtype),
        ('user_profiles', 'updated_at', 'timestamptz'::pg_catalog.regtype)
    ) AS required_column(table_name, column_name, type_oid)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
              'public.' || required_column.table_name
            )
        AND attribute.attname = required_column.column_name
        AND attribute.atttypid = required_column.type_oid
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'primary-projection columns or types are incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indexrelid =
            'public.user_linked_traders_one_primary_per_user'::pg_catalog.regclass
      AND index_row.indrelid =
            'public.user_linked_traders'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND pg_catalog.pg_get_expr(
            index_row.indpred,
            index_row.indrelid
          ) ~ 'is_primary'
  ) THEN
    RAISE EXCEPTION 'canonical primary uniqueness index is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_linked_traders AS linked
    LEFT JOIN public.verified_traders AS verified
      ON verified.user_id = linked.user_id
     AND verified.trader_id = linked.trader_id
     AND verified.source = linked.source
    WHERE verified.id IS NULL
  ) THEN
    RAISE EXCEPTION 'linked trader ownership is missing its exact verified projection';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_linked_traders AS linked
    LEFT JOIN public.user_profiles AS profile
      ON profile.id = linked.user_id
    WHERE profile.id IS NULL
  ) THEN
    RAISE EXCEPTION 'linked trader owner is missing a user profile';
  END IF;
END
$preflight$;

LOCK TABLE
  public.user_linked_traders,
  public.verified_traders,
  public.user_profiles
IN SHARE ROW EXCLUSIVE MODE;

-- The linked table is canonical ownership authority. Preserve an existing
-- primary when one exists; otherwise select the same deterministic account
-- used by activation and unlink.
WITH ranked AS (
  SELECT
    linked.id,
    pg_catalog.row_number() OVER (
      PARTITION BY linked.user_id
      ORDER BY linked.is_primary DESC NULLS LAST,
               linked.display_order ASC NULLS LAST,
               linked.created_at ASC NULLS LAST,
               linked.id ASC
    ) AS primary_rank
  FROM public.user_linked_traders AS linked
)
UPDATE public.user_linked_traders AS linked
SET is_primary = ranked.primary_rank = 1,
    updated_at = pg_catalog.statement_timestamp()
FROM ranked
WHERE linked.id = ranked.id
  AND linked.is_primary IS DISTINCT FROM (ranked.primary_rank = 1);

-- A verified profile without a canonical link is not ownership authority.
-- Such historical orphans stay available for audit but cannot remain primary.
WITH verified_projection AS (
  SELECT
    verified.id,
    EXISTS (
      SELECT 1
      FROM public.user_linked_traders AS linked
      WHERE linked.user_id = verified.user_id
        AND linked.trader_id = verified.trader_id
        AND linked.source = verified.source
        AND linked.is_primary IS TRUE
    ) AS should_be_primary
  FROM public.verified_traders AS verified
)
UPDATE public.verified_traders AS verified
SET is_primary = projection.should_be_primary,
    updated_at = pg_catalog.statement_timestamp()
FROM verified_projection AS projection
WHERE verified.id = projection.id
  AND verified.is_primary IS DISTINCT FROM projection.should_be_primary;

WITH linked_counts AS (
  SELECT
    linked.user_id,
    pg_catalog.count(*)::integer AS linked_count
  FROM public.user_linked_traders AS linked
  GROUP BY linked.user_id
),
linked_projection AS (
  SELECT
    primary_link.user_id,
    primary_link.trader_id,
    primary_link.source,
    counts.linked_count
  FROM public.user_linked_traders AS primary_link
  JOIN linked_counts AS counts
    ON counts.user_id = primary_link.user_id
  WHERE primary_link.is_primary IS TRUE
)
UPDATE public.user_profiles AS profile
SET is_verified_trader = true,
    verified_trader_id = projection.trader_id,
    verified_trader_source = projection.source,
    linked_trader_count = projection.linked_count,
    updated_at = pg_catalog.statement_timestamp()
FROM linked_projection AS projection
WHERE profile.id = projection.user_id
  AND (
    profile.is_verified_trader IS DISTINCT FROM true
    OR profile.verified_trader_id IS DISTINCT FROM projection.trader_id
    OR profile.verified_trader_source IS DISTINCT FROM projection.source
    OR profile.linked_trader_count IS DISTINCT FROM projection.linked_count
  );

UPDATE public.user_profiles AS profile
SET is_verified_trader = false,
    verified_trader_id = NULL,
    verified_trader_source = NULL,
    linked_trader_count = 0,
    updated_at = pg_catalog.statement_timestamp()
WHERE NOT EXISTS (
        SELECT 1
        FROM public.user_linked_traders AS linked
        WHERE linked.user_id = profile.id
      )
  AND (
    profile.is_verified_trader IS DISTINCT FROM false
    OR profile.verified_trader_id IS NOT NULL
    OR profile.verified_trader_source IS NOT NULL
    OR profile.linked_trader_count IS DISTINCT FROM 0
  );

CREATE OR REPLACE FUNCTION public.set_primary_linked_trader(
  p_user_id uuid,
  p_link_id uuid
)
RETURNS public.user_linked_traders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_target public.user_linked_traders%ROWTYPE;
  v_verified public.verified_traders%ROWTYPE;
  v_linked_count integer;
  v_linked_primary_count integer;
  v_linked_target_count integer;
  v_verified_primary_count integer;
  v_verified_target_count integer;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_user_id IS NULL OR p_link_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'user id and linked trader id are required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('linked-trader:' || p_user_id::text, 0)
  );

  -- Prove the exact canonical owner and its matching verified projection
  -- under lock before changing any primary state.
  SELECT linked.*
  INTO v_target
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'linked trader not found';
  END IF;

  SELECT verified.*
  INTO v_verified
  FROM public.verified_traders AS verified
  WHERE verified.user_id = p_user_id
    AND verified.trader_id = v_target.trader_id
    AND verified.source = v_target.source
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'verified trader ownership projection not found';
  END IF;

  -- Clear before setting so a future immediate partial unique constraint on
  -- either projection cannot make a valid switch depend on row update order.
  UPDATE public.user_linked_traders AS linked
  SET is_primary = false,
      updated_at = v_now
  WHERE linked.user_id = p_user_id
    AND linked.id <> p_link_id
    AND linked.is_primary IS TRUE;

  UPDATE public.user_linked_traders AS linked
  SET is_primary = true,
      updated_at = v_now
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id
    AND linked.is_primary IS DISTINCT FROM true;

  UPDATE public.verified_traders AS verified
  SET is_primary = false,
      updated_at = v_now
  WHERE verified.user_id = p_user_id
    AND verified.id <> v_verified.id
    AND verified.is_primary IS TRUE;

  UPDATE public.verified_traders AS verified
  SET is_primary = true,
      updated_at = v_now
  WHERE verified.id = v_verified.id
    AND verified.user_id = p_user_id
    AND verified.is_primary IS DISTINCT FROM true;

  SELECT linked.*
  INTO STRICT v_target
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (
      WHERE linked.is_primary IS TRUE
    )::integer,
    pg_catalog.count(*) FILTER (
      WHERE linked.is_primary IS TRUE
        AND linked.id = p_link_id
    )::integer
  INTO v_linked_count, v_linked_primary_count, v_linked_target_count
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = p_user_id;

  SELECT
    pg_catalog.count(*) FILTER (
      WHERE verified.is_primary IS TRUE
    )::integer,
    pg_catalog.count(*) FILTER (
      WHERE verified.is_primary IS TRUE
        AND verified.id = v_verified.id
        AND verified.trader_id = v_target.trader_id
        AND verified.source = v_target.source
    )::integer
  INTO v_verified_primary_count, v_verified_target_count
  FROM public.verified_traders AS verified
  WHERE verified.user_id = p_user_id;

  IF v_linked_primary_count <> 1
     OR v_linked_target_count <> 1
     OR v_verified_primary_count <> 1
     OR v_verified_target_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'primary trader projection invariant failed';
  END IF;

  UPDATE public.user_profiles AS profile
  SET is_verified_trader = true,
      verified_trader_id = v_target.trader_id,
      verified_trader_source = v_target.source,
      linked_trader_count = v_linked_count,
      updated_at = v_now
  WHERE profile.id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'user profile not found';
  END IF;

  RETURN v_target;
END;
$function$;

ALTER FUNCTION public.set_primary_linked_trader(uuid, uuid)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_primary_linked_trader(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_primary_linked_trader(uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.set_primary_linked_trader(uuid, uuid) IS
  'Service-only serialized primary switch across canonical link, verified profile, and user profile projections.';

DO $postflight$
DECLARE
  v_function_oid oid := pg_catalog.to_regprocedure(
    'public.set_primary_linked_trader(uuid,uuid)'
  );
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function_oid
      AND function_row.prosecdef
      AND function_row.proowner = pg_catalog.to_regrole('postgres')
      AND 'search_path=pg_catalog, pg_temp' = ANY(function_row.proconfig)
  ) THEN
    RAISE EXCEPTION 'primary projection function authority is incorrect';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon',
       v_function_oid,
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       v_function_oid,
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       v_function_oid,
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'primary projection function privilege boundary is incorrect';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_linked_traders AS linked
    GROUP BY linked.user_id
    HAVING pg_catalog.count(*) FILTER (
      WHERE linked.is_primary IS TRUE
    ) <> 1
  ) OR EXISTS (
    SELECT 1
    FROM public.user_linked_traders AS linked
    LEFT JOIN public.verified_traders AS verified
      ON verified.user_id = linked.user_id
     AND verified.trader_id = linked.trader_id
     AND verified.source = linked.source
    WHERE verified.id IS NULL
       OR verified.is_primary IS DISTINCT FROM linked.is_primary
  ) OR EXISTS (
    SELECT 1
    FROM public.verified_traders AS verified
    WHERE verified.is_primary IS TRUE
      AND NOT EXISTS (
        SELECT 1
        FROM public.user_linked_traders AS linked
        WHERE linked.user_id = verified.user_id
          AND linked.trader_id = verified.trader_id
          AND linked.source = verified.source
          AND linked.is_primary IS TRUE
      )
  ) OR EXISTS (
    SELECT 1
    FROM public.user_profiles AS profile
    LEFT JOIN LATERAL (
      SELECT
        primary_link.trader_id,
        primary_link.source,
        (
          SELECT pg_catalog.count(*)::integer
          FROM public.user_linked_traders AS linked_count
          WHERE linked_count.user_id = profile.id
        ) AS linked_count
      FROM public.user_linked_traders AS primary_link
      WHERE primary_link.user_id = profile.id
        AND primary_link.is_primary IS TRUE
    ) AS projection ON true
    WHERE (
      projection.trader_id IS NULL
      AND (
        profile.is_verified_trader IS DISTINCT FROM false
        OR profile.verified_trader_id IS NOT NULL
        OR profile.verified_trader_source IS NOT NULL
        OR profile.linked_trader_count IS DISTINCT FROM 0
      )
    ) OR (
      projection.trader_id IS NOT NULL
      AND (
        profile.is_verified_trader IS DISTINCT FROM true
        OR profile.verified_trader_id IS DISTINCT FROM projection.trader_id
        OR profile.verified_trader_source IS DISTINCT FROM projection.source
        OR profile.linked_trader_count IS DISTINCT FROM projection.linked_count
      )
    )
  ) THEN
    RAISE EXCEPTION 'primary trader projection repair was incomplete';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
