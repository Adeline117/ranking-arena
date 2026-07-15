-- Unify token index statistics and token-detail rankings on one normalized source.
--
-- The former detail query scanned trader_position_history directly and omitted
-- bare symbols such as "BTC". On the current 30M+ row history table that query
-- also exceeds the statement timeout, which the API previously surfaced as an
-- empty board. The popular-token MV normalized those rows, so the two screens
-- contradicted each other.

SET statement_timeout = 0;

CREATE MATERIALIZED VIEW public.mv_token_trader_daily_90d AS
WITH normalized AS (
  SELECT
    close_time::date AS trade_date,
    upper(
      CASE
        WHEN symbol ILIKE '%.P' THEN regexp_replace(symbol, '(?i)usdt\.p$', '')
        WHEN symbol ILIKE '%USDT' THEN regexp_replace(symbol, '(?i)usdt$', '')
        WHEN symbol ILIKE '%BUSD' THEN regexp_replace(symbol, '(?i)busd$', '')
        WHEN symbol ILIKE '%-PERP' THEN regexp_replace(symbol, '(?i)-perp$', '')
        WHEN symbol ILIKE '%-USD' THEN regexp_replace(symbol, '(?i)-usd$', '')
        WHEN symbol ILIKE '%USD' THEN regexp_replace(symbol, '(?i)usd$', '')
        WHEN symbol LIKE '%/%' THEN split_part(symbol, '/', 1)
        ELSE symbol
      END
    ) AS token,
    source,
    source_trader_id,
    pnl_usd,
    pnl_pct
  FROM public.trader_position_history
  WHERE close_time >= now() - interval '90 days'
    AND pnl_usd IS NOT NULL
), valid AS (
  SELECT *
  FROM normalized
  WHERE length(token) BETWEEN 1 AND 10
    AND token ~ '^[A-Z0-9]+$'
    AND token ~ '[A-Z]'
)
SELECT
  trade_date,
  token,
  source,
  source_trader_id,
  count(*)::bigint AS trade_count,
  count(*) FILTER (WHERE pnl_usd > 0)::bigint AS win_count,
  round(sum(pnl_usd), 2) AS token_pnl,
  sum(pnl_pct) FILTER (WHERE pnl_pct IS NOT NULL) AS pnl_pct_sum,
  count(pnl_pct)::bigint AS pnl_pct_count
FROM valid
GROUP BY trade_date, token, source, source_trader_id;

CREATE UNIQUE INDEX idx_mv_token_trader_daily_unique
  ON public.mv_token_trader_daily_90d (trade_date, token, source, source_trader_id);
CREATE INDEX idx_mv_token_trader_daily_lookup
  ON public.mv_token_trader_daily_90d (token, trade_date DESC);

DROP FUNCTION IF EXISTS public.get_popular_tokens(integer, integer);
DROP FUNCTION IF EXISTS public.refresh_popular_tokens_mv();
DROP MATERIALIZED VIEW IF EXISTS public.mv_popular_tokens_90d;

CREATE MATERIALIZED VIEW public.mv_popular_tokens_90d AS
SELECT
  token,
  sum(trade_count)::bigint AS trade_count,
  count(*)::bigint AS trader_count,
  round(sum(token_pnl), 2) AS total_pnl
FROM (
  SELECT
    token,
    source,
    source_trader_id,
    sum(trade_count) AS trade_count,
    sum(token_pnl) AS token_pnl
  FROM public.mv_token_trader_daily_90d
  GROUP BY token, source, source_trader_id
) trader_totals
GROUP BY token
ORDER BY sum(trade_count) DESC
LIMIT 60;

CREATE UNIQUE INDEX idx_mv_popular_tokens_token
  ON public.mv_popular_tokens_90d (token);

CREATE FUNCTION public.get_popular_tokens(
  lookback_days integer DEFAULT 90,
  max_tokens integer DEFAULT 50
)
RETURNS TABLE(token text, trade_count bigint, trader_count bigint, total_pnl numeric)
LANGUAGE sql STABLE SET search_path TO 'public'
AS $function$
  SELECT token, trade_count, trader_count, total_pnl
  FROM public.mv_popular_tokens_90d
  ORDER BY trade_count DESC
  LIMIT greatest(1, least(max_tokens, 60));
$function$;

CREATE FUNCTION public.get_token_trader_rankings(
  token_symbol text,
  lookback_days integer DEFAULT 90,
  max_traders integer DEFAULT 50,
  row_offset integer DEFAULT 0
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
LANGUAGE sql STABLE SET search_path TO 'public'
AS $function$
  WITH totals AS (
    SELECT
      d.source,
      d.source_trader_id,
      round(sum(d.token_pnl), 2) AS token_pnl,
      sum(d.trade_count)::bigint AS token_trade_count,
      round(100.0 * sum(d.win_count) / nullif(sum(d.trade_count), 0), 2) AS token_win_rate,
      round(sum(d.pnl_pct_sum) / nullif(sum(d.pnl_pct_count), 0), 2) AS token_avg_pnl_pct
    FROM public.mv_token_trader_daily_90d d
    WHERE d.token = upper(trim(token_symbol))
      AND d.trade_date >= current_date - (greatest(1, least(lookback_days, 90)) - 1)
    GROUP BY d.source, d.source_trader_id
  )
  SELECT
    totals.source,
    totals.source_trader_id,
    totals.token_pnl,
    totals.token_trade_count,
    totals.token_win_rate,
    totals.token_avg_pnl_pct,
    count(*) OVER ()::bigint AS total_count
  FROM totals
  ORDER BY totals.token_pnl DESC
  LIMIT greatest(1, least(max_traders, 200))
  OFFSET greatest(row_offset, 0);
$function$;

CREATE FUNCTION public.refresh_popular_tokens_mv()
RETURNS void LANGUAGE plpgsql SET search_path TO 'public'
AS $function$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_token_trader_daily_90d;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.mv_popular_tokens_90d;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_token_trader_rankings(text, integer, integer, integer)
  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_popular_tokens_mv() FROM PUBLIC;
GRANT SELECT ON public.mv_token_trader_daily_90d TO service_role;
GRANT SELECT ON public.mv_popular_tokens_90d TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_popular_tokens(integer, integer)
  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_token_trader_rankings(text, integer, integer, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_popular_tokens_mv() TO service_role;

RESET statement_timeout;
