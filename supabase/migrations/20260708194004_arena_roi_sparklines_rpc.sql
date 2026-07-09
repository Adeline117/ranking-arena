-- Migration: 20260708194004_arena_roi_sparklines_rpc.sql
-- Batch equity-trend sparkline for the rankings page. ONE call per page returns a
-- downsampled account_value ("is the account growing") series per (source, trader).
-- Rankings rows carry no time-series; without this the ROI cell is a bare number.
-- Uses account_value (present for all sources; roi is NOT stored as a series —
-- trader_series holds pnl + account_value). Frontend normalizes the shape.
-- SECURITY DEFINER + search_path mirror arena_core_modules (public-schema RPC).

-- Up
CREATE OR REPLACE FUNCTION public.arena_roi_sparklines(
  p_pairs jsonb,          -- [{"source":"hyperliquid","key":"0x…"}, …]
  p_timeframe int DEFAULT 90,
  p_points int DEFAULT 16
) RETURNS TABLE(source text, trader_key text, pts numeric[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = arena, public AS $$
  WITH pairs AS (
    SELECT p->>'source' AS source, p->>'key' AS key
    FROM jsonb_array_elements(p_pairs) p
  ),
  tr AS (
    SELECT pr.source, pr.key, t.id AS tid
    FROM pairs pr
    JOIN arena.sources s ON s.slug = pr.source
    JOIN arena.traders t ON t.source_id = s.id AND t.exchange_trader_id = pr.key
  ),
  ser AS (
    SELECT tr.source, tr.key, ts.ts, ts.value,
           ntile(greatest(1, p_points)) OVER (PARTITION BY tr.source, tr.key ORDER BY ts.ts) AS bucket
    FROM tr
    JOIN arena.trader_series ts ON ts.trader_id = tr.tid
    WHERE ts.timeframe = p_timeframe::smallint AND ts.metric = 'account_value'
  ),
  bk AS (
    SELECT DISTINCT ON (source, key, bucket) source, key, bucket, value
    FROM ser ORDER BY source, key, bucket, ts DESC
  )
  SELECT source, key AS trader_key, array_agg(value ORDER BY bucket) AS pts
  FROM bk GROUP BY source, key
$$;

GRANT EXECUTE ON FUNCTION public.arena_roi_sparklines(jsonb, int, int)
  TO anon, authenticated, service_role;
