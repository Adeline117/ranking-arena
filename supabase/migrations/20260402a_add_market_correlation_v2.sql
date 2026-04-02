-- Add beta_btc, beta_eth, alpha columns to trader_snapshots_v2
-- These are computed from equity curve daily returns vs BTC/ETH daily returns
-- Using existing calculateMarketCorrelation() from lib/utils/market-correlation.ts

ALTER TABLE trader_snapshots_v2
  ADD COLUMN IF NOT EXISTS beta_btc DECIMAL(8, 4),
  ADD COLUMN IF NOT EXISTS beta_eth DECIMAL(8, 4),
  ADD COLUMN IF NOT EXISTS alpha DECIMAL(10, 4);

-- Index for sorting/filtering by alpha (most useful for leaderboard)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_snapshots_v2_alpha
  ON trader_snapshots_v2(alpha DESC NULLS LAST)
  WHERE alpha IS NOT NULL;

COMMENT ON COLUMN trader_snapshots_v2.beta_btc IS 'Beta correlation with BTC daily returns';
COMMENT ON COLUMN trader_snapshots_v2.beta_eth IS 'Beta correlation with ETH daily returns';
COMMENT ON COLUMN trader_snapshots_v2.alpha IS 'Jensen alpha: excess return vs BTC benchmark (%)';
