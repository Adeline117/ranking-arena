-- Migration: 20260413150324_add_metric_bounds_to_bulk_update_rpc.sql
-- Created: 2026-04-13
-- Description: Add bounds validation to bulk_update_snapshot_metrics RPC.
-- Previously accepted any values; now NULLs out-of-range metrics instead of
-- writing bad data. Matches VALIDATION_BOUNDS from lib/pipeline/types.ts.

CREATE OR REPLACE FUNCTION bulk_update_snapshot_metrics(updates jsonb)
RETURNS integer AS $$
DECLARE
  updated_count integer;
BEGIN
  WITH parsed AS (
    SELECT * FROM jsonb_to_recordset(updates) AS u(
      platform text, trader_key text, "window" text,
      sharpe_ratio double precision, max_drawdown double precision, win_rate double precision,
      beta_btc double precision, beta_eth double precision, alpha double precision
    )
  ),
  -- Bounds gate: NULL out values outside valid ranges instead of rejecting entire row.
  -- This preserves partial data (e.g., valid Sharpe + invalid MDD → write Sharpe, skip MDD).
  bounded AS (
    SELECT
      platform, trader_key, "window",
      CASE WHEN sharpe_ratio BETWEEN -10 AND 10 THEN sharpe_ratio ELSE NULL END AS sharpe_ratio,
      CASE WHEN max_drawdown BETWEEN 0 AND 100 THEN max_drawdown ELSE NULL END AS max_drawdown,
      CASE WHEN win_rate BETWEEN 0 AND 100 THEN win_rate ELSE NULL END AS win_rate,
      CASE WHEN beta_btc BETWEEN -5 AND 5 THEN beta_btc ELSE NULL END AS beta_btc,
      CASE WHEN beta_eth BETWEEN -5 AND 5 THEN beta_eth ELSE NULL END AS beta_eth,
      CASE WHEN alpha BETWEEN -1000 AND 1000 THEN alpha ELSE NULL END AS alpha
    FROM parsed
  )
  UPDATE trader_snapshots_v2 t SET
    sharpe_ratio = COALESCE(p.sharpe_ratio, t.sharpe_ratio),
    max_drawdown = COALESCE(p.max_drawdown, t.max_drawdown),
    win_rate = COALESCE(p.win_rate, t.win_rate),
    beta_btc = COALESCE(p.beta_btc, t.beta_btc),
    beta_eth = COALESCE(p.beta_eth, t.beta_eth),
    alpha = COALESCE(p.alpha, t.alpha),
    updated_at = now()
  FROM bounded p
  WHERE t.platform = p.platform AND t.trader_key = p.trader_key AND UPPER(t."window") = UPPER(p."window");
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;
