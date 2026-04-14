-- Migration: 20260413212242_bulk_enrich_sync_v2_rpc.sql
-- Created: 2026-04-13
-- Description: Batch enrichment-to-v2 sync RPC. Replaces 2,742 individual UPDATE
-- calls (10,822s/day) with ~50 batch RPC calls (~30s/day). Applied to prod via
-- Supabase MCP on 2026-04-13.

CREATE OR REPLACE FUNCTION bulk_enrich_sync_v2(updates jsonb)
RETURNS integer AS $$
DECLARE
  updated_count integer;
BEGIN
  WITH parsed AS (
    SELECT * FROM jsonb_to_recordset(updates) AS u(
      platform text, trader_key text, "window" text,
      win_rate double precision, max_drawdown double precision,
      trades_count integer, sharpe_ratio double precision,
      roi_pct double precision, pnl_usd double precision
    )
  ),
  bounded AS (
    SELECT
      platform, trader_key, UPPER("window") as window,
      CASE WHEN win_rate BETWEEN 0 AND 100 THEN win_rate ELSE NULL END AS win_rate,
      CASE WHEN max_drawdown BETWEEN 0 AND 100 THEN max_drawdown ELSE NULL END AS max_drawdown,
      CASE WHEN trades_count >= 0 THEN trades_count ELSE NULL END AS trades_count,
      CASE WHEN sharpe_ratio BETWEEN -10 AND 10 THEN sharpe_ratio ELSE NULL END AS sharpe_ratio,
      CASE WHEN roi_pct BETWEEN -10000 AND 10000 THEN roi_pct ELSE NULL END AS roi_pct,
      CASE WHEN pnl_usd BETWEEN -10000000 AND 100000000 THEN pnl_usd ELSE NULL END AS pnl_usd
    FROM parsed
    WHERE platform IS NOT NULL AND trader_key IS NOT NULL
  )
  UPDATE trader_snapshots_v2 t SET
    win_rate = COALESCE(p.win_rate, t.win_rate),
    max_drawdown = COALESCE(p.max_drawdown, t.max_drawdown),
    trades_count = COALESCE(p.trades_count, t.trades_count),
    sharpe_ratio = COALESCE(p.sharpe_ratio, t.sharpe_ratio),
    roi_pct = COALESCE(p.roi_pct, t.roi_pct),
    pnl_usd = COALESCE(p.pnl_usd, t.pnl_usd),
    updated_at = now()
  FROM bounded p
  WHERE t.platform = p.platform
    AND t.trader_key = p.trader_key
    AND UPPER(t."window") = p.window;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;
