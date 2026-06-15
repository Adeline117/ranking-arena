-- Migration: 20260615162022_popular_tokens_matview.sql
-- Created: 2026-06-15T23:20:22Z
-- Description: Pre-aggregate popular tokens into a materialized view so
--   /rankings/tokens stops doing a live 4.24M-row aggregation on every cold load
--   (measured 12.7s LCP + 500s when the RPC timed out). get_popular_tokens keeps
--   its exact signature/return type and now reads ~50 pre-aggregated rows, so the
--   SSR page + /api/rankings/by-token are unchanged. Refreshed every 30 min by
--   pg_cron (a bootstrap-aware function does a non-concurrent first populate, then
--   CONCURRENTLY thereafter so reads never block).

-- Up

-- 1) Materialized view — same aggregation body as the original get_popular_tokens
--    RPC. Created WITH NO DATA so the migration applies instantly; the first
--    pg_cron run (or the manual SELECT refresh_popular_tokens_mv() below) populates
--    it. Fixed 90-day window — the only window any caller uses.
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_popular_tokens_90d AS
  WITH base_tokens AS (
    SELECT
      UPPER(
        CASE
          WHEN symbol ILIKE '%.P'    THEN regexp_replace(symbol, '(?i)usdt\.p$', '')
          WHEN symbol ILIKE '%USDT'  THEN regexp_replace(symbol, '(?i)usdt$', '')
          WHEN symbol ILIKE '%BUSD'  THEN regexp_replace(symbol, '(?i)busd$', '')
          WHEN symbol ILIKE '%-PERP' THEN regexp_replace(symbol, '(?i)-perp$', '')
          WHEN symbol ILIKE '%-USD'  THEN regexp_replace(symbol, '(?i)-usd$', '')
          WHEN symbol ILIKE '%USD'   THEN regexp_replace(symbol, '(?i)usd$', '')
          WHEN symbol LIKE '%/%'     THEN split_part(symbol, '/', 1)
          ELSE symbol
        END
      ) AS base_token,
      source,
      source_trader_id,
      pnl_usd
    FROM trader_position_history
    WHERE close_time >= (now() - INTERVAL '90 days')
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
  LIMIT 50
WITH NO DATA;

-- Unique index required for REFRESH MATERIALIZED VIEW CONCURRENTLY.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_popular_tokens_token
  ON mv_popular_tokens_90d (token);

-- 2) Repoint get_popular_tokens to read the matview. Same signature + return
--    columns as the original (20260407l_popular_tokens_rpc.sql) → zero code change
--    at the call sites (SSR page.tsx + /api/rankings/by-token). lookback_days is
--    retained for compatibility but ignored (matview is fixed at 90 days, the only
--    value any caller passes).
CREATE OR REPLACE FUNCTION public.get_popular_tokens(
  lookback_days integer DEFAULT 90,
  max_tokens integer DEFAULT 50
)
RETURNS TABLE(token text, trade_count bigint, trader_count bigint, total_pnl numeric)
LANGUAGE sql
STABLE
SET search_path = public
AS $function$
  SELECT token, trade_count, trader_count, total_pnl
  FROM mv_popular_tokens_90d
  ORDER BY trade_count DESC
  LIMIT max_tokens;
$function$;

-- 3) Bootstrap-aware refresh: the first run (matview not yet populated) must be a
--    plain REFRESH; CONCURRENTLY cannot populate an empty matview. Subsequent runs
--    use CONCURRENTLY so reads never block.
CREATE OR REPLACE FUNCTION public.refresh_popular_tokens_mv()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF (SELECT ispopulated FROM pg_matviews WHERE matviewname = 'mv_popular_tokens_90d') THEN
    REFRESH MATERIALIZED VIEW CONCURRENTLY mv_popular_tokens_90d;
  ELSE
    REFRESH MATERIALIZED VIEW mv_popular_tokens_90d;
  END IF;
END;
$function$;

-- 4) Schedule the refresh every 30 minutes (data feeds a page with revalidate=3600,
--    so ~30 min staleness is well within tolerance). Unschedule any prior job of the
--    same name first to stay idempotent.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'refresh-mv-popular-tokens') THEN
    PERFORM cron.unschedule('refresh-mv-popular-tokens');
  END IF;
END $$;

SELECT cron.schedule(
  'refresh-mv-popular-tokens',
  '*/30 * * * *',
  $$SELECT public.refresh_popular_tokens_mv()$$
);
