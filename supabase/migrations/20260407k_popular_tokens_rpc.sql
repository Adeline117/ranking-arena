-- Create an RPC function to aggregate popular tokens from trader_position_history
-- Replaces the previous approach of fetching 50K rows and aggregating in JS memory

CREATE OR REPLACE FUNCTION get_popular_tokens(lookback_days int DEFAULT 90, max_tokens int DEFAULT 50)
RETURNS TABLE (
  token text,
  trade_count bigint,
  trader_count bigint,
  total_pnl numeric
)
LANGUAGE sql STABLE
AS $$
  WITH base_tokens AS (
    SELECT
      -- Normalize symbol to base token (replicate extractBaseToken logic)
      UPPER(
        CASE
          WHEN symbol ILIKE '%.P'     THEN regexp_replace(symbol, '(?i)usdt\.p$', '')
          WHEN symbol ILIKE '%USDT'   THEN regexp_replace(symbol, '(?i)usdt$', '')
          WHEN symbol ILIKE '%BUSD'   THEN regexp_replace(symbol, '(?i)busd$', '')
          WHEN symbol ILIKE '%-PERP'  THEN regexp_replace(symbol, '(?i)-perp$', '')
          WHEN symbol ILIKE '%-USD'   THEN regexp_replace(symbol, '(?i)-usd$', '')
          WHEN symbol ILIKE '%USD'    THEN regexp_replace(symbol, '(?i)usd$', '')
          WHEN symbol LIKE '%/%'      THEN split_part(symbol, '/', 1)
          ELSE symbol
        END
      ) AS base_token,
      source,
      source_trader_id,
      pnl_usd
    FROM trader_position_history
    WHERE close_time >= (now() - (lookback_days || ' days')::interval)
      AND pnl_usd IS NOT NULL
  )
  SELECT
    bt.base_token AS token,
    count(*)::bigint AS trade_count,
    count(DISTINCT bt.source || ':' || bt.source_trader_id)::bigint AS trader_count,
    round(sum(bt.pnl_usd)::numeric, 2) AS total_pnl
  FROM base_tokens bt
  WHERE length(bt.base_token) <= 10
    AND bt.base_token <> ''
  GROUP BY bt.base_token
  ORDER BY trade_count DESC
  LIMIT max_tokens;
$$;
