-- Restore the private trader watchlist foundation when production drift has
-- removed it, then make every mutation use one authenticated, per-user atomic
-- authority.  The previous API performed count -> upsert/delete -> list as
-- separate statements, so count failures could bypass the hard limit,
-- concurrent adds could exceed it, and a failed final read looked like an
-- authoritative empty list.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('atomic-trader-watchlist-migration', 0)
);

DO $foundations$
BEGIN
  IF pg_catalog.to_regrole('postgres') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regprocedure('auth.uid()') IS NULL
    OR pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR pg_catalog.to_regclass('auth.users') IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('arena.sources') IS NULL
    OR pg_catalog.to_regclass('arena.traders') IS NULL
  THEN
    RAISE EXCEPTION 'atomic trader watchlist foundations are unavailable';
  END IF;
END
$foundations$;

-- The original 20260310000000 migration is recorded but the table has been
-- absent in production before.  Repeating its narrow foundation here makes
-- this authority self-restoring instead of depending on migration-history
-- repair outside the release.
CREATE TABLE IF NOT EXISTS public.trader_watchlist (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source text NOT NULL,
  source_trader_id text NOT NULL,
  handle text,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now(),
  UNIQUE (user_id, source, source_trader_id)
);

ALTER TABLE public.trader_watchlist OWNER TO postgres;
ALTER TABLE public.trader_watchlist ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_trader_watchlist_user
  ON public.trader_watchlist (user_id);
CREATE INDEX IF NOT EXISTS idx_trader_watchlist_trader
  ON public.trader_watchlist (source, source_trader_id);

DROP POLICY IF EXISTS "Users can view own watchlist"
  ON public.trader_watchlist;
CREATE POLICY "Users can view own watchlist"
  ON public.trader_watchlist
  FOR SELECT
  TO authenticated
  USING (user_id = (SELECT auth.uid()));

-- Direct insert/update/delete would race the authority and invalidate the
-- capacity guarantee.  Reads stay private under RLS; only the function below
-- may mutate the table.
DROP POLICY IF EXISTS "Users can insert own watchlist"
  ON public.trader_watchlist;
DROP POLICY IF EXISTS "Users can delete own watchlist"
  ON public.trader_watchlist;

REVOKE ALL ON TABLE public.trader_watchlist FROM PUBLIC, anon, authenticator;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.trader_watchlist
  FROM authenticated, service_role;
GRANT SELECT ON TABLE public.trader_watchlist TO authenticated, service_role;

DO $preflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('trader_watchlist', 'id', 'uuid'::pg_catalog.regtype, true),
        ('trader_watchlist', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('trader_watchlist', 'source', 'text'::pg_catalog.regtype, true),
        ('trader_watchlist', 'source_trader_id', 'text'::pg_catalog.regtype, true),
        ('trader_watchlist', 'handle', 'text'::pg_catalog.regtype, false),
        ('trader_watchlist', 'created_at', 'timestamptz'::pg_catalog.regtype, true)
    ) AS required_column(table_name, column_name, type_oid, must_be_not_null)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      WHERE attribute.attrelid = pg_catalog.to_regclass(
          'public.' || required_column.table_name
        )
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
    RAISE EXCEPTION 'atomic trader watchlist public schema is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('sources', 'id', 'smallint'::pg_catalog.regtype, true),
        ('sources', 'slug', 'text'::pg_catalog.regtype, true),
        ('sources', 'status', 'text'::pg_catalog.regtype, true),
        ('sources', 'serving_mode', 'text'::pg_catalog.regtype, true),
        ('sources', 'meta', 'jsonb'::pg_catalog.regtype, true),
        ('traders', 'source_id', 'smallint'::pg_catalog.regtype, true),
        ('traders', 'exchange_trader_id', 'text'::pg_catalog.regtype, true)
    ) AS required_column(table_name, column_name, type_oid, must_be_not_null)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      WHERE attribute.attrelid = pg_catalog.to_regclass(
          'arena.' || required_column.table_name
        )
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
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
    RAISE EXCEPTION 'atomic trader watchlist arena schema is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid =
        'public.trader_watchlist'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
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
      ) = ARRAY['user_id', 'source', 'source_trader_id']::name[]
  ) THEN
    RAISE EXCEPTION 'atomic trader watchlist requires exact composite uniqueness';
  END IF;

  IF EXISTS (
    SELECT watch_row.user_id
    FROM public.trader_watchlist AS watch_row
    GROUP BY watch_row.user_id
    HAVING pg_catalog.count(*) > 200
  ) THEN
    RAISE EXCEPTION 'trader watchlist contains a user above the hard capacity';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.mutate_trader_watchlist_atomic(
  p_source text,
  p_source_trader_id text,
  p_handle text,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_actor_id uuid := (SELECT auth.uid());
  v_count integer;
  v_identity_count integer;
  v_mutated integer;
  v_status text;
  v_watchlist jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'authenticated role required' USING ERRCODE = '42501';
  END IF;

  IF v_actor_id IS NULL
    OR p_source IS NULL
    OR pg_catalog.length(p_source) NOT BETWEEN 1 AND 50
    OR p_source IS DISTINCT FROM pg_catalog.btrim(p_source)
    OR p_source IS DISTINCT FROM pg_catalog.lower(p_source)
    OR p_source !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
    OR p_source ~ '[[:cntrl:]]'
    OR p_source_trader_id IS NULL
    OR pg_catalog.length(p_source_trader_id) NOT BETWEEN 1 AND 200
    OR p_source_trader_id IS DISTINCT FROM pg_catalog.btrim(p_source_trader_id)
    OR p_source_trader_id ~ '[[:cntrl:]]'
    OR p_action IS NULL
    OR p_action NOT IN ('add', 'remove')
    OR (
      p_handle IS NOT NULL
      AND (
        pg_catalog.length(p_handle) NOT BETWEEN 1 AND 200
        OR p_handle IS DISTINCT FROM pg_catalog.btrim(p_handle)
        OR p_handle ~ '[[:cntrl:]]'
      )
    )
    OR (p_action = 'remove' AND p_handle IS NOT NULL)
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'atomic-trader-watchlist-user:' || v_actor_id::text,
      0
    )
  );

  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id = v_actor_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  IF p_action = 'add' THEN
    -- Require one exact current composite identity.  A source alias and a
    -- trader id are never independently interchangeable.
    SELECT pg_catalog.count(*)::integer
    INTO STRICT v_identity_count
    FROM arena.sources AS source_row
    JOIN arena.traders AS trader_row
      ON trader_row.source_id = source_row.id
    WHERE source_row.status = 'active'
      AND source_row.serving_mode = 'serving'
      AND pg_catalog.btrim(
        COALESCE(source_row.meta->>'legacy_platform', '')
      ) <> 'null'
      AND COALESCE(
        NULLIF(pg_catalog.btrim(source_row.meta->>'legacy_platform'), ''),
        source_row.slug
      ) = p_source
      AND trader_row.exchange_trader_id = p_source_trader_id;

    IF v_identity_count IS DISTINCT FROM 1 THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'identity_unavailable'
      );
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.trader_watchlist AS watch_row
      WHERE watch_row.user_id = v_actor_id
        AND watch_row.source = p_source
        AND watch_row.source_trader_id = p_source_trader_id
    ) THEN
      IF p_handle IS NOT NULL THEN
        UPDATE public.trader_watchlist AS watch_row
        SET handle = p_handle
        WHERE watch_row.user_id = v_actor_id
          AND watch_row.source = p_source
          AND watch_row.source_trader_id = p_source_trader_id
          AND watch_row.handle IS DISTINCT FROM p_handle;
      END IF;
      v_status := 'already_present';
    ELSE
      SELECT pg_catalog.count(*)::integer
      INTO STRICT v_count
      FROM public.trader_watchlist AS watch_row
      WHERE watch_row.user_id = v_actor_id;

      IF v_count >= 200 THEN
        RETURN pg_catalog.jsonb_build_object(
          'status', 'limit_reached',
          'current_count', v_count,
          'limit', 200
        );
      END IF;

      INSERT INTO public.trader_watchlist (
        user_id,
        source,
        source_trader_id,
        handle
      ) VALUES (
        v_actor_id,
        p_source,
        p_source_trader_id,
        p_handle
      )
      ON CONFLICT (user_id, source, source_trader_id) DO NOTHING;
      GET DIAGNOSTICS v_mutated = ROW_COUNT;

      IF v_mutated = 1 THEN
        v_status := 'added';
      ELSIF v_mutated = 0 THEN
        -- Defensive replay if a privileged historical writer entered the same
        -- identity before the direct-write revocation became visible.
        v_status := 'already_present';
      ELSE
        RAISE EXCEPTION 'watchlist add mutated an impossible row count';
      END IF;
    END IF;
  ELSE
    DELETE FROM public.trader_watchlist AS watch_row
    WHERE watch_row.user_id = v_actor_id
      AND watch_row.source = p_source
      AND watch_row.source_trader_id = p_source_trader_id;
    GET DIAGNOSTICS v_mutated = ROW_COUNT;

    IF v_mutated = 1 THEN
      v_status := 'removed';
    ELSIF v_mutated = 0 THEN
      v_status := 'not_present';
    ELSE
      RAISE EXCEPTION 'watchlist remove mutated an impossible row count';
    END IF;
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'source', ordered_watch.source,
          'source_trader_id', ordered_watch.source_trader_id,
          'handle', ordered_watch.handle,
          'created_at', ordered_watch.created_at
        )
        ORDER BY ordered_watch.created_at DESC, ordered_watch.id DESC
      ),
      '[]'::jsonb
    )
  INTO STRICT v_count, v_watchlist
  FROM (
    SELECT
      watch_row.id,
      watch_row.source,
      watch_row.source_trader_id,
      watch_row.handle,
      watch_row.created_at
    FROM public.trader_watchlist AS watch_row
    WHERE watch_row.user_id = v_actor_id
    ORDER BY watch_row.created_at DESC, watch_row.id DESC
    LIMIT 200
  ) AS ordered_watch;

  IF v_count > 200
    OR pg_catalog.jsonb_array_length(v_watchlist) IS DISTINCT FROM v_count
  THEN
    RAISE EXCEPTION 'watchlist authority returned an impossible capacity';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_status,
    'user_id', v_actor_id,
    'source', p_source,
    'source_trader_id', p_source_trader_id,
    'current_count', v_count,
    'limit', 200,
    'watchlist', v_watchlist
  );
END
$function$;

ALTER FUNCTION public.mutate_trader_watchlist_atomic(
  text,
  text,
  text,
  text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.mutate_trader_watchlist_atomic(
  text,
  text,
  text,
  text
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.mutate_trader_watchlist_atomic(
  text,
  text,
  text,
  text
) TO authenticated;

COMMENT ON FUNCTION public.mutate_trader_watchlist_atomic(
  text,
  text,
  text,
  text
) IS
  'Authenticated atomic add/remove authority for an exact source+trader watchlist identity; serializes the 200-row cap and returns the same-transaction private list.';

NOTIFY pgrst, 'reload schema';

COMMIT;
