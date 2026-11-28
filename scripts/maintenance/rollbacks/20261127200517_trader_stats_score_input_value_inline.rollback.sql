-- Rollback of 20261127200517_trader_stats_score_input_value_inline.sql.
-- Restores arena.trader_stats_score_input_value exactly as 20261116205144
-- created it (body and SET search_path). Runs only when the function is
-- currently the 20261127200517 definition; anything else is refused.
-- Not a migration: applied by hand only inside an owner-approved window.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, pg_temp;

CREATE FUNCTION pg_temp.expected_score_input_value_20261127200517(
  p_row jsonb,
  p_metric text
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
RETURN NULLIF(
  CASE
    WHEN p_metric IN ('sortino', 'calmar', 'volatility')
      THEN p_row->'extras'->p_metric
    ELSE p_row->p_metric
  END,
  'null'::jsonb
);

DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid = 'arena.trader_stats_score_input_value(jsonb,text)'::regprocedure
       AND p.prosqlbody IS NOT NULL
       AND p.proconfig IS NULL
       AND pg_catalog.pg_get_function_sqlbody(p.oid)
           = pg_catalog.pg_get_function_sqlbody(
               'pg_temp.expected_score_input_value_20261127200517(jsonb,text)'::regprocedure
             )
  ) THEN
    RAISE EXCEPTION 'arena.trader_stats_score_input_value is not the 20261127200517 definition; refusing';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION arena.trader_stats_score_input_value(
  p_row jsonb,
  p_metric text
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  SELECT NULLIF(
    CASE
      WHEN p_metric IN ('sortino', 'calmar', 'volatility')
        THEN p_row->'extras'->p_metric
      ELSE p_row->p_metric
    END,
    'null'::jsonb
  )
$function$;

COMMENT ON FUNCTION arena.trader_stats_score_input_value(jsonb, text) IS NULL;

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS p
     WHERE p.oid = 'arena.trader_stats_score_input_value(jsonb,text)'::regprocedure
       AND p.prosqlbody IS NULL
       AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=pg_catalog, pg_temp']::text[]
       AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex')
           = 'a5d13578432570afcad4ec763326eb0bcf59d505c907526ccf841bc91b347429'
  ) THEN
    RAISE EXCEPTION 'rollback did not restore the 20261116205144 definition';
  END IF;
END
$postflight$;

DROP FUNCTION pg_temp.expected_score_input_value_20261127200517(jsonb, text);

COMMIT;
