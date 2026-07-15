-- The daily aggregate contains the partial calendar day at the 90-day cutoff.
-- Include that same boundary date in detail rankings so popular-token counts
-- and the default 90D board resolve to the same trader set.

CREATE OR REPLACE FUNCTION public.get_token_trader_rankings(
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
      AND d.trade_date >= current_date - greatest(1, least(lookback_days, 90))
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
