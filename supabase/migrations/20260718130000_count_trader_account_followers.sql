-- Count Arena followers by the full exchange-account identity.
--
-- The legacy count_trader_followers(text[]) groups only by raw trader_id and
-- therefore merges unrelated accounts when two sources reuse the same id.
-- Keep that RPC for compatibility while new application reads move to this
-- source-scoped contract.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.trader_follows') IS NULL THEN
    RAISE EXCEPTION 'public.trader_follows is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.trader_follows'::pg_catalog.regclass
      AND attribute.attname = 'source'
      AND attribute.atttypid = 'text'::pg_catalog.regtype
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'public.trader_follows.source text is required';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.count_trader_account_followers(
  p_trader_ids text[],
  p_sources text[]
)
RETURNS TABLE(trader_id text, source text, cnt bigint)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = pg_catalog, public, pg_temp
AS $function$
BEGIN
  IF p_trader_ids IS NULL
     OR p_sources IS NULL
     OR pg_catalog.cardinality(p_trader_ids)
          <> pg_catalog.cardinality(p_sources) THEN
    RAISE EXCEPTION 'trader ids and sources must be non-null arrays of equal length';
  END IF;

  IF pg_catalog.cardinality(p_trader_ids) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 trader accounts can be counted per call';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ROWS FROM (
      pg_catalog.unnest(p_trader_ids),
      pg_catalog.unnest(p_sources)
    ) AS input(trader_id, source)
    WHERE NULLIF(pg_catalog.btrim(input.trader_id), '') IS NULL
       OR NULLIF(pg_catalog.btrim(input.source), '') IS NULL
  ) THEN
    RAISE EXCEPTION 'every trader account requires a non-empty trader id and source';
  END IF;

  RETURN QUERY
  WITH requested AS (
    SELECT DISTINCT
      pg_catalog.btrim(input.trader_id) AS trader_id,
      pg_catalog.btrim(input.source) AS source
    FROM ROWS FROM (
      pg_catalog.unnest(p_trader_ids),
      pg_catalog.unnest(p_sources)
    ) AS input(trader_id, source)
  )
  SELECT
    requested.trader_id,
    requested.source,
    pg_catalog.count(follow_row.user_id)::bigint AS cnt
  FROM requested
  LEFT JOIN public.trader_follows AS follow_row
    ON follow_row.trader_id = requested.trader_id
   AND follow_row.source = requested.source
  GROUP BY requested.trader_id, requested.source;
END
$function$;

REVOKE ALL ON FUNCTION public.count_trader_account_followers(text[], text[])
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.count_trader_account_followers(text[], text[])
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.count_trader_account_followers(text[], text[]) IS
  'Counts Arena follows by exact (trader_id, source). Never merge raw ids across sources.';

DO $postflight$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.count_trader_account_followers(text[],text[])'
     ) IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS procedure
       WHERE procedure.oid = pg_catalog.to_regprocedure(
         'public.count_trader_account_followers(text[],text[])'
       )
         AND procedure.provolatile = 's'
         AND NOT procedure.prosecdef
         AND procedure.proconfig @> ARRAY[
           'search_path=pg_catalog, public, pg_temp'
         ]::text[]
     ) THEN
    RAISE EXCEPTION 'source-scoped follower count RPC postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
