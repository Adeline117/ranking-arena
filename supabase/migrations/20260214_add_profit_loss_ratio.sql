-- Add profit_loss_ratio column for Bybit P/L Ratio (metricValues[4])
ALTER TABLE trader_snapshots
  ADD COLUMN IF NOT EXISTS profit_loss_ratio DECIMAL(10, 4);

CREATE INDEX IF NOT EXISTS idx_trader_snapshots_profit_loss_ratio
  ON trader_snapshots(profit_loss_ratio DESC NULLS LAST);

COMMENT ON COLUMN trader_snapshots.profit_loss_ratio IS 'Profit/Loss ratio - average win / average loss';
