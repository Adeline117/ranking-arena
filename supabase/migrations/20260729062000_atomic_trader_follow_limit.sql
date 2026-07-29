-- Serialize trader-account follows per user so the exact Free/Pro limit and
-- the edge mutation share one authority transaction. The application no
-- longer treats a failed count as zero or races count-then-insert requests.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('atomic-trader-follow-limit-migration', 0)
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
    OR pg_catalog.to_regprocedure(
      'public.has_current_global_pro_entitlement(uuid)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'atomic trader follow dependencies are unavailable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('trader_follows', 'id', 'uuid'::pg_catalog.regtype, true),
        ('trader_follows', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('trader_follows', 'trader_id', 'text'::pg_catalog.regtype, true),
        ('trader_follows', 'source', 'text'::pg_catalog.regtype, false)
    ) AS required_column(table_name, column_name, type_oid, must_be_not_null)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      WHERE attribute.attrelid =
          pg_catalog.to_regclass('public.' || required_column.table_name)
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND relation.relowner = v_postgres
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
    RAISE EXCEPTION 'atomic trader follow schema is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.trader_follows'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnullsnotdistinct
      AND index_row.indnkeyatts = 3
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
      ) = ARRAY['user_id', 'trader_id', 'source']::name[]
  ) THEN
    RAISE EXCEPTION
      'atomic trader follow requires exact source-scoped uniqueness';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.mutate_trader_follow_atomic(
  p_actor_id uuid,
  p_trader_id text,
  p_source text,
  p_action text,
  p_promo_unlocked boolean,
  p_free_limit integer,
  p_pro_limit integer
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
  v_limit integer;
  v_count integer;
  v_mutated integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL
    OR p_trader_id IS NULL
    OR pg_catalog.length(p_trader_id) NOT BETWEEN 1 AND 255
    OR p_trader_id IS DISTINCT FROM pg_catalog.btrim(p_trader_id)
    OR p_trader_id ~ '[[:cntrl:]]'
    OR p_action IS NULL
    OR p_action NOT IN ('follow', 'unfollow')
    OR (
      p_source IS NOT NULL
      AND (
        pg_catalog.length(p_source) NOT BETWEEN 1 AND 64
        OR p_source IS DISTINCT FROM pg_catalog.btrim(p_source)
        OR p_source ~ '[[:cntrl:]]'
      )
    )
    OR (p_action = 'follow' AND p_source IS NULL)
    OR p_promo_unlocked IS NULL
    OR p_free_limit IS NULL
    OR p_free_limit NOT BETWEEN 1 AND 10000
    OR p_pro_limit IS NULL
    OR p_pro_limit NOT BETWEEN p_free_limit AND 10000
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'atomic-trader-follow-user:' || p_actor_id::text,
      0
    )
  );

  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  IF p_action = 'unfollow' THEN
    IF p_source IS NULL THEN
      DELETE FROM public.trader_follows AS follow_row
      WHERE follow_row.user_id = p_actor_id
        AND follow_row.trader_id = p_trader_id
        AND follow_row.source IS NULL;
    ELSE
      DELETE FROM public.trader_follows AS follow_row
      WHERE follow_row.user_id = p_actor_id
        AND follow_row.trader_id = p_trader_id
        AND follow_row.source = p_source;
    END IF;
    GET DIAGNOSTICS v_mutated = ROW_COUNT;
    IF v_mutated NOT IN (0, 1) THEN
      RAISE EXCEPTION 'trader unfollow mutated an impossible row count';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'status', CASE
        WHEN v_mutated = 1 THEN 'unfollowed'
        ELSE 'not_following'
      END,
      'user_id', p_actor_id,
      'trader_id', p_trader_id,
      'source', p_source,
      'following', false
    );
  END IF;

  v_limit := CASE
    WHEN p_promo_unlocked
      OR public.has_current_global_pro_entitlement(p_actor_id)
    THEN p_pro_limit
    ELSE p_free_limit
  END;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_count
  FROM public.trader_follows AS follow_row
  WHERE follow_row.user_id = p_actor_id;

  IF EXISTS (
    SELECT 1
    FROM public.trader_follows AS follow_row
    WHERE follow_row.user_id = p_actor_id
      AND follow_row.trader_id = p_trader_id
      AND follow_row.source = p_source
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_following',
      'user_id', p_actor_id,
      'trader_id', p_trader_id,
      'source', p_source,
      'following', true,
      'current_count', v_count,
      'limit', v_limit
    );
  END IF;

  IF v_count >= v_limit THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'limit_reached',
      'user_id', p_actor_id,
      'trader_id', p_trader_id,
      'source', p_source,
      'following', false,
      'current_count', v_count,
      'limit', v_limit
    );
  END IF;

  INSERT INTO public.trader_follows (
    user_id,
    trader_id,
    source
  ) VALUES (
    p_actor_id,
    p_trader_id,
    p_source
  )
  ON CONFLICT (user_id, trader_id, source)
  DO NOTHING;
  GET DIAGNOSTICS v_mutated = ROW_COUNT;

  IF v_mutated = 0 THEN
    SELECT pg_catalog.count(*)::integer
    INTO STRICT v_count
    FROM public.trader_follows AS follow_row
    WHERE follow_row.user_id = p_actor_id;
    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_following',
      'user_id', p_actor_id,
      'trader_id', p_trader_id,
      'source', p_source,
      'following', true,
      'current_count', v_count,
      'limit', v_limit
    );
  END IF;
  IF v_mutated IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'trader follow mutated an impossible row count';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'followed',
    'user_id', p_actor_id,
    'trader_id', p_trader_id,
    'source', p_source,
    'following', true,
    'current_count', v_count + 1,
    'limit', v_limit
  );
END
$function$;

ALTER FUNCTION public.mutate_trader_follow_atomic(
  uuid,
  text,
  text,
  text,
  boolean,
  integer,
  integer
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.mutate_trader_follow_atomic(
  uuid,
  text,
  text,
  text,
  boolean,
  integer,
  integer
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.mutate_trader_follow_atomic(
  uuid,
  text,
  text,
  text,
  boolean,
  integer,
  integer
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
