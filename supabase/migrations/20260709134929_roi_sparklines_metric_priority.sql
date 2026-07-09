-- Migration: 20260709134929_roi_sparklines_metric_priority.sql
-- Created: 2026-07-09T20:49:29Z
-- Description: arena_roi_sparklines 按 metric 优先级取数(roi > account_value > pnl)
--
-- 上线首日核查(2026-07-09):只有 hyperliquid 存 account_value 序列(97.7% 覆盖),
-- CEX 板(bitunix 4685 / bitget 2753 / binance 2482 / gate 2127 交易员)存的是
-- roi/pnl 序列 → 原 RPC 只读 account_value,CEX 排行页曲线全空。
-- 迷你图是 min-max 形状归一化的走势,三种 metric 都能读成轨迹;roi 与所在
-- ROI 格语义最贴,优先。签名不变(Args/Returns 同) → database.types.ts 无 diff。

-- Up
CREATE OR REPLACE FUNCTION public.arena_roi_sparklines(
  p_pairs jsonb,
  p_timeframe int DEFAULT 90,
  p_points int DEFAULT 16
)
RETURNS TABLE(source text, trader_key text, pts numeric[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = arena, public
AS $$
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
  raw AS (
    SELECT tr.source, tr.key, ts.ts, ts.value,
           CASE ts.metric WHEN 'roi' THEN 1 WHEN 'account_value' THEN 2 ELSE 3 END AS pri
    FROM tr
    JOIN arena.trader_series ts ON ts.trader_id = tr.tid
    WHERE ts.timeframe = p_timeframe::smallint
      AND ts.metric IN ('roi', 'account_value', 'pnl')
  ),
  chosen AS (
    SELECT r.source, r.key, r.ts, r.value
    FROM raw r
    JOIN (SELECT source, key, min(pri) AS pri FROM raw GROUP BY source, key) b
      ON b.source = r.source AND b.key = r.key AND b.pri = r.pri
  ),
  ser AS (
    SELECT source, key, ts, value,
           ntile(greatest(1, p_points)) OVER (PARTITION BY source, key ORDER BY ts) AS bucket
    FROM chosen
  ),
  bk AS (
    SELECT DISTINCT ON (source, key, bucket) source, key, bucket, value
    FROM ser
    ORDER BY source, key, bucket, ts DESC
  )
  SELECT source, key AS trader_key, array_agg(value ORDER BY bucket) AS pts
  FROM bk
  GROUP BY source, key
$$;

GRANT EXECUTE ON FUNCTION public.arena_roi_sparklines(jsonb, int, int) TO anon, authenticated, service_role;
