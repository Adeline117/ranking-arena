-- Add score breakdown and trading style columns to leaderboard_ranks
-- These fields are carried over from trader_snapshots during compute-leaderboard cron

ALTER TABLE leaderboard_ranks 
  ADD COLUMN IF NOT EXISTS profitability_score numeric(6,2),
  ADD COLUMN IF NOT EXISTS risk_control_score numeric(6,2),
  ADD COLUMN IF NOT EXISTS execution_score numeric(6,2),
  ADD COLUMN IF NOT EXISTS score_completeness text,
  ADD COLUMN IF NOT EXISTS trading_style text,
  ADD COLUMN IF NOT EXISTS avg_holding_hours numeric(10,2),
  ADD COLUMN IF NOT EXISTS style_confidence numeric(6,4);
