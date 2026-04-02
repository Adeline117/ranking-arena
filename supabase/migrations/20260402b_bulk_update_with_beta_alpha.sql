-- Update bulk_update_snapshot_metrics RPC to also handle beta_btc, beta_eth, alpha
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
  )
  UPDATE trader_snapshots_v2 t SET
    sharpe_ratio = COALESCE(p.sharpe_ratio, t.sharpe_ratio),
    max_drawdown = COALESCE(p.max_drawdown, t.max_drawdown),
    win_rate = COALESCE(p.win_rate, t.win_rate),
    beta_btc = COALESCE(p.beta_btc, t.beta_btc),
    beta_eth = COALESCE(p.beta_eth, t.beta_eth),
    alpha = COALESCE(p.alpha, t.alpha),
    updated_at = now()
  FROM parsed p
  WHERE t.platform = p.platform AND t.trader_key = p.trader_key AND UPPER(t."window") = UPPER(p."window");
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;
