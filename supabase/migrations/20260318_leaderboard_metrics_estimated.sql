-- Add metrics_estimated flag to leaderboard_ranks
-- Indicates win_rate and max_drawdown were estimated from ROI (Phase 5),
-- not sourced from exchange data or equity curve derivation.
-- Frontend should display a visual indicator for these values.
ALTER TABLE leaderboard_ranks
  ADD COLUMN IF NOT EXISTS metrics_estimated boolean DEFAULT false;
