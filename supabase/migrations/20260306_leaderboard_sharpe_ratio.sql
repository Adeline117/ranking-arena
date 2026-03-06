-- Add sharpe_ratio column to leaderboard_ranks
-- Binance provides native sharpe_ratio; other exchanges compute from equity curve

ALTER TABLE leaderboard_ranks
  ADD COLUMN IF NOT EXISTS sharpe_ratio numeric(10, 4);

COMMENT ON COLUMN leaderboard_ranks.sharpe_ratio IS 'Sharpe ratio - risk-adjusted return. Native from Binance, computed for others. NULL = not available.';
