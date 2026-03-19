-- Bulk update sharpe_ratio, max_drawdown, win_rate in trader_snapshots_v2
-- Replaces N+1 per-trader UPDATE queries with a single RPC call
CREATE OR REPLACE FUNCTION bulk_update_snapshot_metrics(updates jsonb)
RETURNS integer AS $$
DECLARE
  updated_count integer;
BEGIN
  WITH parsed AS (
    SELECT * FROM jsonb_to_recordset(updates) AS u(
      platform text, trader_key text, window text,
      sharpe_ratio double precision, max_drawdown double precision, win_rate double precision
    )
  )
  UPDATE trader_snapshots_v2 t SET
    sharpe_ratio = COALESCE(p.sharpe_ratio, t.sharpe_ratio),
    max_drawdown = COALESCE(p.max_drawdown, t.max_drawdown),
    win_rate = COALESCE(p.win_rate, t.win_rate),
    updated_at = now()
  FROM parsed p
  WHERE t.platform = p.platform AND t.trader_key = p.trader_key AND t.window = p.window;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;
