-- Add missing indexes for trader_frequently_traded and trader_follows
-- Identified by database index audit

-- trader_frequently_traded: queried by (source, source_trader_id, captured_at)
CREATE INDEX IF NOT EXISTS idx_trader_frequently_traded_source_trader
  ON trader_frequently_traded(source, source_trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_frequently_traded_captured
  ON trader_frequently_traded(source, source_trader_id, captured_at DESC);

-- trader_follows: queried by trader_id (follower counts) and user_id (user's follows)
CREATE INDEX IF NOT EXISTS idx_trader_follows_trader_id
  ON trader_follows(trader_id);
CREATE INDEX IF NOT EXISTS idx_trader_follows_user_id
  ON trader_follows(user_id);
