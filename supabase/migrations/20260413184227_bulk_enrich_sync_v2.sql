-- Migration: 20260413184227_bulk_enrich_sync_v2.sql
-- Created: 2026-04-14T01:42:27Z
-- Description: New RPC for batched enrichment-to-v2 sync. Replaces per-row
-- UPDATEs in upsertStatsDetail/upsertEquityCurve with a single batch call.
-- Accepts enrichment fields (win_rate, max_drawdown, trades_count, sharpe_ratio,
-- roi_pct, pnl_usd) and applies bounds validation + COALESCE for partial updates.
-- Expected impact: 99.7% reduction in enrichment DB time (10,822s/day -> ~30s/day).

CREATE OR REPLACE FUNCTION bulk_enrich_sync_v2(updates jsonb)
RETURNS integer
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  updated_count integer;
BEGIN
  WITH parsed AS (
    SELECT * FROM jsonb_to_recordset(updates) AS u(
      platform text,
      trader_key text,
      "window" text,
      win_rate double precision,
      max_drawdown double precision,
      trades_count integer,
      sharpe_ratio double precision,
      roi_pct double precision,
      pnl_usd double precision
    )
  ),
  -- Bounds gate: NULL out-of-range values instead of rejecting entire row.
  -- Matches VALIDATION_BOUNDS from lib/pipeline/types.ts.
  bounded AS (
    SELECT
      platform,
      trader_key,
      UPPER("window") AS "window",
      CASE WHEN win_rate BETWEEN 0 AND 100 THEN win_rate ELSE NULL END AS win_rate,
      CASE WHEN max_drawdown BETWEEN 0 AND 100 THEN max_drawdown ELSE NULL END AS max_drawdown,
      CASE WHEN trades_count >= 0 THEN trades_count ELSE NULL END AS trades_count,
      CASE WHEN sharpe_ratio BETWEEN -10 AND 10 THEN sharpe_ratio ELSE NULL END AS sharpe_ratio,
      CASE WHEN roi_pct BETWEEN -100 AND 100000 THEN roi_pct ELSE NULL END AS roi_pct,
      CASE WHEN pnl_usd BETWEEN -1000000000 AND 1000000000 THEN pnl_usd ELSE NULL END AS pnl_usd
    FROM parsed
  )
  UPDATE trader_snapshots_v2 t SET
    win_rate      = COALESCE(p.win_rate, t.win_rate),
    max_drawdown  = COALESCE(p.max_drawdown, t.max_drawdown),
    trades_count  = COALESCE(p.trades_count, t.trades_count),
    sharpe_ratio  = COALESCE(p.sharpe_ratio, t.sharpe_ratio),
    roi_pct       = COALESCE(p.roi_pct, t.roi_pct),
    pnl_usd       = COALESCE(p.pnl_usd, t.pnl_usd),
    updated_at    = now()
  FROM bounded p
  WHERE t.platform = p.platform
    AND t.trader_key = p.trader_key
    AND UPPER(t."window") = p."window";

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;
