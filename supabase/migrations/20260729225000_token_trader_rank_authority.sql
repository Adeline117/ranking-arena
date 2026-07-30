-- Make the token-PnL board return a deterministic, server-owned rank.
--
-- The prior RPC ordered only by token_pnl and applied LIMIT/OFFSET before any
-- rank existed. Equal-PnL rows could therefore move between pages, while the
-- client invented a rank from page position. Rank the complete aggregate with
-- a stable source identity tie-break before pagination and expose that rank as
-- part of the RPC contract.

BEGIN;

SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.mv_token_trader_daily_90d') IS NULL THEN
    RAISE EXCEPTION 'token trader daily aggregate is required';
  END IF;
  IF pg_catalog.to_regprocedure(
       'public.get_token_trader_rankings(text,integer,integer,integer)'
     ) IS NULL THEN
    RAISE EXCEPTION 'token trader ranking RPC foundation is required';
  END IF;
  IF pg_catalog.to_regrole('postgres') IS NULL
     OR pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'Supabase runtime roles are required';
  END IF;
END
$preflight$;

DROP FUNCTION IF EXISTS public.get_token_trader_rankings(
  text,
  integer,
  integer,
  integer
);

CREATE OR REPLACE FUNCTION public.get_token_trader_rankings(
  token_symbol text,
  lookback_days integer DEFAULT 90,
  max_traders integer DEFAULT 50,
  row_offset integer DEFAULT 0
)
RETURNS TABLE(
  source text,
  source_trader_id text,
  token_rank bigint,
  token_pnl numeric,
  token_trade_count bigint,
  token_win_rate numeric,
  token_avg_pnl_pct numeric,
  total_count bigint
)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH totals AS (
    SELECT
      daily.source,
      daily.source_trader_id,
      pg_catalog.round(pg_catalog.sum(daily.token_pnl), 2) AS token_pnl,
      pg_catalog.sum(daily.trade_count)::bigint AS token_trade_count,
      pg_catalog.round(
        100.0 * pg_catalog.sum(daily.win_count)
          / nullif(pg_catalog.sum(daily.trade_count), 0),
        2
      ) AS token_win_rate,
      pg_catalog.round(
        pg_catalog.sum(daily.pnl_pct_sum)
          / nullif(pg_catalog.sum(daily.pnl_pct_count), 0),
        2
      ) AS token_avg_pnl_pct
    FROM public.mv_token_trader_daily_90d AS daily
    WHERE daily.token = pg_catalog.upper(pg_catalog.btrim(token_symbol))
      AND daily.trade_date >= CURRENT_DATE - greatest(1, least(lookback_days, 90))
    GROUP BY daily.source, daily.source_trader_id
  ), ranked AS (
    SELECT
      totals.*,
      row_number() OVER (ORDER BY totals.token_pnl DESC, totals.source ASC, totals.source_trader_id ASC) AS token_rank,
      pg_catalog.count(*) OVER ()::bigint AS total_count
    FROM totals
    WHERE totals.token_pnl IS NOT NULL
  )
  SELECT
    ranked.source,
    ranked.source_trader_id,
    ranked.token_rank,
    ranked.token_pnl,
    ranked.token_trade_count,
    ranked.token_win_rate,
    ranked.token_avg_pnl_pct,
    ranked.total_count
  FROM ranked
  ORDER BY ranked.token_rank ASC
  LIMIT greatest(1, least(max_traders, 200))
  OFFSET greatest(row_offset, 0);
$function$;

ALTER FUNCTION public.get_token_trader_rankings(
  text,
  integer,
  integer,
  integer
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.get_token_trader_rankings(
  text,
  integer,
  integer,
  integer
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.get_token_trader_rankings(
  text,
  integer,
  integer,
  integer
) TO service_role;

COMMENT ON FUNCTION public.get_token_trader_rankings(
  text,
  integer,
  integer,
  integer
) IS 'Deterministic token-PnL ranking; token_rank is assigned before pagination.';

DO $postflight$
DECLARE
  v_result_contract text;
BEGIN
  SELECT pg_catalog.pg_get_function_result(function_row.oid)
    INTO STRICT v_result_contract
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
        'public.get_token_trader_rankings(text,integer,integer,integer)'::pg_catalog.regprocedure
    AND function_row.proowner = 'postgres'::pg_catalog.regrole
    AND function_row.provolatile = 's'
    AND NOT function_row.prosecdef
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp'
    ]::pg_catalog.text[];

  IF v_result_contract <> 'TABLE(source text, source_trader_id text, token_rank bigint, token_pnl numeric, token_trade_count bigint, token_win_rate numeric, token_avg_pnl_pct numeric, total_count bigint)' THEN
    RAISE EXCEPTION 'token trader ranking return contract postflight failed';
  END IF;
  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.get_token_trader_rankings(text,integer,integer,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon',
       'public.get_token_trader_rankings(text,integer,integer,integer)',
       'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated',
       'public.get_token_trader_rankings(text,integer,integer,integer)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'token trader ranking ACL postflight failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
