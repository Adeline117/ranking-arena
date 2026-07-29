-- Publish one user's fetched portfolio positions and equity as one generation.
-- A failed/older request must never partially overwrite a newer financial view.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('atomic-portfolio-sync-publication-migration', 0)
);

DO $preflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_relation text;
  v_present_columns integer;
BEGIN
  IF v_postgres IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
    OR pg_catalog.to_regprocedure('auth.role()') IS NULL
  THEN
    RAISE EXCEPTION
      'atomic portfolio publication requires standard Supabase roles and auth.role()';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'user_portfolios',
    'user_positions',
    'user_portfolio_snapshots'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = pg_catalog.to_regclass('public.' || v_relation)
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND relation.relowner = v_postgres
    ) THEN
      RAISE EXCEPTION
        'atomic portfolio publication relation is incompatible: public.%',
        v_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('user_portfolios', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_portfolios', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('user_positions', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_positions', 'portfolio_id', 'uuid'::pg_catalog.regtype, true),
        ('user_positions', 'symbol', 'text'::pg_catalog.regtype, true),
        ('user_positions', 'side', 'text'::pg_catalog.regtype, true),
        ('user_positions', 'entry_price', 'numeric'::pg_catalog.regtype, true),
        ('user_positions', 'mark_price', 'numeric'::pg_catalog.regtype, true),
        ('user_positions', 'size', 'numeric'::pg_catalog.regtype, true),
        ('user_positions', 'pnl', 'numeric'::pg_catalog.regtype, true),
        ('user_positions', 'pnl_pct', 'numeric'::pg_catalog.regtype, true),
        ('user_positions', 'leverage', 'numeric'::pg_catalog.regtype, true),
        ('user_positions', 'updated_at', 'timestamptz'::pg_catalog.regtype, true),
        ('user_portfolio_snapshots', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_portfolio_snapshots', 'portfolio_id', 'uuid'::pg_catalog.regtype, true),
        ('user_portfolio_snapshots', 'total_equity', 'numeric'::pg_catalog.regtype, true),
        ('user_portfolio_snapshots', 'total_pnl', 'numeric'::pg_catalog.regtype, true),
        ('user_portfolio_snapshots', 'total_pnl_pct', 'numeric'::pg_catalog.regtype, true),
        (
          'user_portfolio_snapshots',
          'snapshot_at',
          'timestamptz'::pg_catalog.regtype,
          true
        )
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
    RAISE EXCEPTION 'atomic portfolio publication columns are incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.user_positions'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND (
        SELECT pg_catalog.array_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attribute_number, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attribute_number
      ) = ARRAY['portfolio_id', 'symbol', 'side']::name[]
  ) THEN
    RAISE EXCEPTION
      'atomic portfolio publication requires unique portfolio position identity';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_present_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.user_portfolios'::pg_catalog.regclass
    AND attribute.attname IN (
      'sync_generation',
      'published_sync_generation',
      'last_synced_at'
    )
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF v_present_columns NOT IN (0, 3) THEN
    RAISE EXCEPTION
      'atomic portfolio publication generation columns were partially applied';
  END IF;

  IF (
    pg_catalog.to_regprocedure(
      'public.claim_portfolio_sync_generation_atomic(uuid,uuid)'
    ) IS NULL
  ) IS DISTINCT FROM (
    pg_catalog.to_regprocedure(
      'public.publish_portfolio_sync_atomic(uuid,uuid,bigint,timestamp with time zone,jsonb,numeric,numeric,numeric)'
    ) IS NULL
  ) THEN
    RAISE EXCEPTION
      'atomic portfolio publication functions were partially applied';
  END IF;
END
$preflight$;

ALTER TABLE public.user_portfolios
  ADD COLUMN IF NOT EXISTS sync_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS published_sync_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_synced_at timestamptz;

ALTER TABLE public.user_portfolios
  DROP CONSTRAINT IF EXISTS user_portfolios_sync_generation_valid;
ALTER TABLE public.user_portfolios
  ADD CONSTRAINT user_portfolios_sync_generation_valid
  CHECK (
    sync_generation >= 0
    AND published_sync_generation >= 0
    AND published_sync_generation <= sync_generation
    AND (
      (published_sync_generation = 0 AND last_synced_at IS NULL)
      OR (published_sync_generation > 0 AND last_synced_at IS NOT NULL)
    )
  ) NOT VALID;
ALTER TABLE public.user_portfolios
  VALIDATE CONSTRAINT user_portfolios_sync_generation_valid;

CREATE OR REPLACE FUNCTION public.claim_portfolio_sync_generation_atomic(
  p_actor_id uuid,
  p_portfolio_id uuid
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
  v_portfolio public.user_portfolios%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL OR p_portfolio_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT portfolio.*
  INTO v_portfolio
  FROM public.user_portfolios AS portfolio
  WHERE portfolio.id = p_portfolio_id
    AND portfolio.user_id = p_actor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_portfolio.sync_generation = 9223372036854775807 THEN
    RAISE EXCEPTION 'portfolio sync generation exhausted'
      USING ERRCODE = '54000';
  END IF;

  UPDATE public.user_portfolios AS portfolio
  SET sync_generation = portfolio.sync_generation + 1
  WHERE portfolio.id = v_portfolio.id
    AND portfolio.user_id = p_actor_id
  RETURNING portfolio.* INTO STRICT v_portfolio;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'portfolio_id', v_portfolio.id,
    'generation', v_portfolio.sync_generation
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.publish_portfolio_sync_atomic(
  p_actor_id uuid,
  p_portfolio_id uuid,
  p_generation bigint,
  p_synced_at timestamptz,
  p_positions jsonb,
  p_total_equity numeric,
  p_total_pnl numeric,
  p_total_pnl_pct numeric
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
  v_portfolio public.user_portfolios%ROWTYPE;
  v_position_count integer;
  v_pruned_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL
    OR p_portfolio_id IS NULL
    OR p_generation IS NULL
    OR p_generation <= 0
    OR p_synced_at IS NULL
    OR p_synced_at IS DISTINCT FROM
        pg_catalog.date_trunc('milliseconds', p_synced_at)
    OR p_synced_at >
        pg_catalog.statement_timestamp() + pg_catalog.make_interval(mins => 5)
    OR p_positions IS NULL
    OR pg_catalog.jsonb_typeof(p_positions) IS DISTINCT FROM 'array'
    OR pg_catalog.jsonb_array_length(p_positions) > 1000
    OR p_total_equity IS NULL
    OR p_total_equity < 0
    OR p_total_equity::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_total_pnl IS NULL
    OR p_total_pnl::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_total_pnl_pct IS NULL
    OR p_total_pnl_pct::text IN ('NaN', 'Infinity', '-Infinity')
    OR pg_catalog.abs(p_total_equity) > 1000000000000000000::numeric
    OR pg_catalog.abs(p_total_pnl) > 1000000000000000000::numeric
    OR pg_catalog.abs(p_total_pnl_pct) > 1000000000::numeric
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.jsonb_array_elements(p_positions) AS supplied(position)
    WHERE pg_catalog.jsonb_typeof(supplied.position) IS DISTINCT FROM 'object'
      OR NOT supplied.position ?& ARRAY[
        'symbol',
        'side',
        'entry_price',
        'mark_price',
        'size',
        'pnl',
        'pnl_pct',
        'leverage'
      ]
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_object_keys(supplied.position) AS key_name
        WHERE key_name NOT IN (
          'symbol',
          'side',
          'entry_price',
          'mark_price',
          'size',
          'pnl',
          'pnl_pct',
          'leverage'
        )
      )
      OR pg_catalog.jsonb_typeof(supplied.position -> 'symbol')
          IS DISTINCT FROM 'string'
      OR pg_catalog.jsonb_typeof(supplied.position -> 'side')
          IS DISTINCT FROM 'string'
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(ARRAY[
          'entry_price',
          'mark_price',
          'size',
          'pnl',
          'pnl_pct',
          'leverage'
        ]) AS numeric_key(key_name)
        WHERE pg_catalog.jsonb_typeof(
          supplied.position -> numeric_key.key_name
        ) IS DISTINCT FROM 'number'
      )
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_positions');
  END IF;

  CREATE TEMPORARY TABLE IF NOT EXISTS pg_temp.portfolio_sync_positions_stage (
    symbol text NOT NULL,
    side text NOT NULL,
    entry_price numeric NOT NULL,
    mark_price numeric NOT NULL,
    size numeric NOT NULL,
    pnl numeric NOT NULL,
    pnl_pct numeric NOT NULL,
    leverage numeric NOT NULL,
    PRIMARY KEY (symbol, side)
  ) ON COMMIT DROP;
  TRUNCATE TABLE pg_temp.portfolio_sync_positions_stage;

  BEGIN
    INSERT INTO pg_temp.portfolio_sync_positions_stage (
      symbol,
      side,
      entry_price,
      mark_price,
      size,
      pnl,
      pnl_pct,
      leverage
    )
    SELECT
      pg_catalog.btrim(position.symbol),
      position.side,
      position.entry_price,
      position.mark_price,
      position.size,
      position.pnl,
      position.pnl_pct,
      position.leverage
    FROM pg_catalog.jsonb_to_recordset(p_positions) AS position(
      symbol text,
      side text,
      entry_price numeric,
      mark_price numeric,
      size numeric,
      pnl numeric,
      pnl_pct numeric,
      leverage numeric
    );
  EXCEPTION
    WHEN unique_violation OR numeric_value_out_of_range OR invalid_text_representation THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid_positions');
  END;

  IF EXISTS (
    SELECT 1
    FROM pg_temp.portfolio_sync_positions_stage AS position
    WHERE pg_catalog.length(position.symbol) NOT BETWEEN 1 AND 200
      OR position.side NOT IN ('long', 'short')
      OR position.entry_price <= 0
      OR position.mark_price <= 0
      OR position.size <= 0
      OR position.leverage <= 0
      OR position.entry_price::text IN ('NaN', 'Infinity', '-Infinity')
      OR position.mark_price::text IN ('NaN', 'Infinity', '-Infinity')
      OR position.size::text IN ('NaN', 'Infinity', '-Infinity')
      OR position.pnl::text IN ('NaN', 'Infinity', '-Infinity')
      OR position.pnl_pct::text IN ('NaN', 'Infinity', '-Infinity')
      OR position.leverage::text IN ('NaN', 'Infinity', '-Infinity')
      OR pg_catalog.abs(position.entry_price) > 1000000000000000000::numeric
      OR pg_catalog.abs(position.mark_price) > 1000000000000000000::numeric
      OR pg_catalog.abs(position.size) > 1000000000000000000::numeric
      OR pg_catalog.abs(position.pnl) > 1000000000000000000::numeric
      OR pg_catalog.abs(position.pnl_pct) > 1000000000::numeric
      OR pg_catalog.abs(position.leverage) > 1000000::numeric
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_positions');
  END IF;

  SELECT portfolio.*
  INTO v_portfolio
  FROM public.user_portfolios AS portfolio
  WHERE portfolio.id = p_portfolio_id
    AND portfolio.user_id = p_actor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF p_generation < v_portfolio.sync_generation THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'superseded',
      'generation', p_generation,
      'current_generation', v_portfolio.sync_generation
    );
  END IF;
  IF p_generation > v_portfolio.sync_generation THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_generation');
  END IF;
  IF v_portfolio.published_sync_generation = p_generation THEN
    SELECT pg_catalog.count(*)::integer
    INTO v_position_count
    FROM public.user_positions AS position
    WHERE position.portfolio_id = p_portfolio_id;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'already_published',
      'generation', p_generation,
      'position_count', v_position_count,
      'synced_at', v_portfolio.last_synced_at
    );
  END IF;

  INSERT INTO public.user_positions AS existing_position (
    portfolio_id,
    symbol,
    side,
    entry_price,
    mark_price,
    size,
    pnl,
    pnl_pct,
    leverage,
    updated_at
  )
  SELECT
    p_portfolio_id,
    staged.symbol,
    staged.side,
    staged.entry_price,
    staged.mark_price,
    staged.size,
    staged.pnl,
    staged.pnl_pct,
    staged.leverage,
    p_synced_at
  FROM pg_temp.portfolio_sync_positions_stage AS staged
  ON CONFLICT (portfolio_id, symbol, side) DO UPDATE
  SET entry_price = EXCLUDED.entry_price,
      mark_price = EXCLUDED.mark_price,
      size = EXCLUDED.size,
      pnl = EXCLUDED.pnl,
      pnl_pct = EXCLUDED.pnl_pct,
      leverage = EXCLUDED.leverage,
      updated_at = EXCLUDED.updated_at;

  DELETE FROM public.user_positions AS existing_position
  WHERE existing_position.portfolio_id = p_portfolio_id
    AND NOT EXISTS (
      SELECT 1
      FROM pg_temp.portfolio_sync_positions_stage AS staged
      WHERE staged.symbol = existing_position.symbol
        AND staged.side = existing_position.side
    );
  GET DIAGNOSTICS v_pruned_count = ROW_COUNT;

  INSERT INTO public.user_portfolio_snapshots (
    portfolio_id,
    total_equity,
    total_pnl,
    total_pnl_pct,
    snapshot_at
  ) VALUES (
    p_portfolio_id,
    p_total_equity,
    p_total_pnl,
    p_total_pnl_pct,
    p_synced_at
  );

  UPDATE public.user_portfolios AS portfolio
  SET published_sync_generation = p_generation,
      last_synced_at = p_synced_at
  WHERE portfolio.id = p_portfolio_id
    AND portfolio.user_id = p_actor_id
    AND portfolio.sync_generation = p_generation
    AND portfolio.published_sync_generation < p_generation
  RETURNING portfolio.* INTO STRICT v_portfolio;

  SELECT pg_catalog.count(*)::integer
  INTO v_position_count
  FROM pg_temp.portfolio_sync_positions_stage;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'published',
    'portfolio_id', p_portfolio_id,
    'generation', p_generation,
    'position_count', v_position_count,
    'pruned_count', v_pruned_count,
    'synced_at', p_synced_at
  );
END
$function$;

ALTER FUNCTION public.claim_portfolio_sync_generation_atomic(uuid, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.publish_portfolio_sync_atomic(
  uuid,
  uuid,
  bigint,
  timestamptz,
  jsonb,
  numeric,
  numeric,
  numeric
) OWNER TO postgres;

REVOKE ALL ON FUNCTION
  public.claim_portfolio_sync_generation_atomic(uuid, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.publish_portfolio_sync_atomic(
  uuid,
  uuid,
  bigint,
  timestamptz,
  jsonb,
  numeric,
  numeric,
  numeric
) FROM PUBLIC, anon, authenticated, authenticator, service_role;

GRANT EXECUTE ON FUNCTION
  public.claim_portfolio_sync_generation_atomic(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.publish_portfolio_sync_atomic(
  uuid,
  uuid,
  bigint,
  timestamptz,
  jsonb,
  numeric,
  numeric,
  numeric
) TO service_role;

COMMIT;
