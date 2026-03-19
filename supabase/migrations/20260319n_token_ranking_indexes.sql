-- Indexes for token-level leaderboard queries
-- Query pattern: GROUP BY symbol on trader_position_history, SUM(pnl_usd),
-- joined with leaderboard_ranks for display data.

-- Index on symbol for token-level aggregation queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_position_history_symbol
  ON trader_position_history(symbol);

-- Composite index for token + trader lookups with PnL
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_position_history_symbol_trader_pnl
  ON trader_position_history(symbol, source, source_trader_id)
  WHERE pnl_usd IS NOT NULL;

-- Index on trader_asset_breakdown symbol for token weight queries
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_asset_breakdown_symbol
  ON trader_asset_breakdown(symbol);
