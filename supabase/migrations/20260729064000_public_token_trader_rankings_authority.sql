-- Public token boards must be scoped to the exact canonical source allowlist
-- selected by application publication policy. The legacy aggregate RPC reads
-- every source represented in mv_token_trader_daily_90d, so retired, aliased,
-- or quarantined sources can otherwise escape into rows and total_count.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
DECLARE
  v_relation pg_catalog.regclass :=
    pg_catalog.to_regclass('public.mv_token_trader_daily_90d');
  v_expected_columns integer;
BEGIN
  IF v_relation IS NULL THEN
    RAISE EXCEPTION 'public.mv_token_trader_daily_90d materialized view is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
      AND relation.relkind = 'm'
  ) THEN
    RAISE EXCEPTION 'public.mv_token_trader_daily_90d must be a materialized view';
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_expected_columns
  FROM (
    VALUES
      (
        'trade_date',
        ARRAY['date'::pg_catalog.regtype::oid]
      ),
      (
        'token',
        ARRAY[
          'text'::pg_catalog.regtype::oid,
          'character varying'::pg_catalog.regtype::oid
        ]
      ),
      (
        'source',
        ARRAY[
          'text'::pg_catalog.regtype::oid,
          'character varying'::pg_catalog.regtype::oid
        ]
      ),
      (
        'source_trader_id',
        ARRAY[
          'text'::pg_catalog.regtype::oid,
          'character varying'::pg_catalog.regtype::oid
        ]
      ),
      (
        'trade_count',
        ARRAY['bigint'::pg_catalog.regtype::oid]
      ),
      (
        'win_count',
        ARRAY['bigint'::pg_catalog.regtype::oid]
      ),
      (
        'token_pnl',
        ARRAY['numeric'::pg_catalog.regtype::oid]
      ),
      (
        'pnl_pct_sum',
        ARRAY['numeric'::pg_catalog.regtype::oid]
      ),
      (
        'pnl_pct_count',
        ARRAY['bigint'::pg_catalog.regtype::oid]
      )
  ) AS expected(attname, allowed_type_oids)
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = v_relation
   AND attribute.attname = expected.attname
   AND attribute.atttypid = ANY(expected.allowed_type_oids)
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped;

  IF v_expected_columns <> 9 THEN
    RAISE EXCEPTION 'public.mv_token_trader_daily_90d column contract is invalid';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.get_public_token_trader_rankings(
  token_symbol text,
  lookback_days integer,
  max_traders integer,
  row_offset integer,
  allowed_sources text[]
)
RETURNS TABLE(
  source text,
  source_trader_id text,
  token_pnl numeric,
  token_trade_count bigint,
  token_win_rate numeric,
  token_avg_pnl_pct numeric,
  total_count bigint
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF token_symbol IS NULL
     OR token_symbol !~ '^[A-Z0-9]{1,10}$'
     OR token_symbol !~ '[A-Z]' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'token_symbol must be an exact uppercase alphanumeric token with a letter';
  END IF;

  IF lookback_days IS NULL OR lookback_days < 1 OR lookback_days > 90 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'lookback_days must be between 1 and 90';
  END IF;

  IF max_traders IS NULL OR max_traders < 1 OR max_traders > 200 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'max_traders must be between 1 and 200';
  END IF;

  IF row_offset IS NULL OR row_offset < 0 OR row_offset > 250000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'row_offset must be between 0 and 250000';
  END IF;

  IF allowed_sources IS NULL
     OR COALESCE(pg_catalog.array_ndims(allowed_sources), 0) <> 1
     OR pg_catalog.array_lower(allowed_sources, 1) <> 1
     OR pg_catalog.cardinality(allowed_sources) < 1
     OR pg_catalog.cardinality(allowed_sources) > 256 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'allowed_sources must contain between 1 and 256 canonical sources';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(allowed_sources) AS input(source)
    WHERE input.source IS NULL
       OR pg_catalog.length(input.source) > 128
       OR input.source !~ '^[a-z0-9]+(_[a-z0-9]+)*$'
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'allowed_sources contains a malformed canonical source';
  END IF;

  IF (
    SELECT pg_catalog.count(*) <> pg_catalog.count(DISTINCT input.source)
    FROM pg_catalog.unnest(allowed_sources) AS input(source)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'allowed_sources must not contain duplicates';
  END IF;

  RETURN QUERY
  WITH allowed AS MATERIALIZED (
    SELECT input.source
    FROM pg_catalog.unnest(allowed_sources) AS input(source)
  ),
  totals AS (
    SELECT
      daily.source::text AS source,
      daily.source_trader_id::text AS source_trader_id,
      pg_catalog.round(pg_catalog.sum(daily.token_pnl), 2) AS token_pnl,
      pg_catalog.sum(daily.trade_count)::bigint AS token_trade_count,
      pg_catalog.round(
        100.0 * pg_catalog.sum(daily.win_count)
          / NULLIF(pg_catalog.sum(daily.trade_count), 0),
        2
      ) AS token_win_rate,
      pg_catalog.round(
        pg_catalog.sum(daily.pnl_pct_sum)
          / NULLIF(pg_catalog.sum(daily.pnl_pct_count), 0),
        2
      ) AS token_avg_pnl_pct
    FROM public.mv_token_trader_daily_90d AS daily
    JOIN allowed
      ON allowed.source = daily.source::text
    WHERE daily.token::text = token_symbol
      AND daily.trade_date >= CURRENT_DATE - lookback_days
    GROUP BY daily.source, daily.source_trader_id
  ),
  counted AS (
    SELECT
      totals.source,
      totals.source_trader_id,
      totals.token_pnl,
      totals.token_trade_count,
      totals.token_win_rate,
      totals.token_avg_pnl_pct,
      pg_catalog.count(*) OVER ()::bigint AS total_count
    FROM totals
  )
  SELECT
    counted.source,
    counted.source_trader_id,
    counted.token_pnl,
    counted.token_trade_count,
    counted.token_win_rate,
    counted.token_avg_pnl_pct,
    counted.total_count
  FROM counted
  ORDER BY counted.token_pnl DESC, counted.source ASC, counted.source_trader_id ASC
  LIMIT max_traders
  OFFSET row_offset;
END
$function$;

REVOKE ALL ON FUNCTION public.get_public_token_trader_rankings(
  text,
  integer,
  integer,
  integer,
  text[]
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.get_public_token_trader_rankings(
  text,
  integer,
  integer,
  integer,
  text[]
) TO service_role;

COMMENT ON FUNCTION public.get_public_token_trader_rankings(
  text,
  integer,
  integer,
  integer,
  text[]
) IS
  'Ranks token traders only inside the caller-supplied exact canonical public source allowlist.';

DO $postflight$
DECLARE
  v_function pg_catalog.regprocedure :=
    pg_catalog.to_regprocedure(
      'public.get_public_token_trader_rankings(text,integer,integer,integer,text[])'
    );
BEGIN
  IF v_function IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure
       WHERE procedure.oid = v_function
         AND procedure.provolatile = 's'
         AND NOT procedure.prosecdef
         AND procedure.proconfig @> ARRAY[
           'search_path=pg_catalog, public, pg_temp'
         ]::text[]
     )
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
     OR NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           procedure.proacl,
           pg_catalog.acldefault('f', procedure.proowner)
         )
       ) AS privilege
       WHERE procedure.oid = v_function
         AND privilege.grantee = 0
         AND privilege.privilege_type = 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'public token trader ranking RPC authority postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
