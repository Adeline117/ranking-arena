-- Add copiers column to leaderboard_ranks for exchange copy-trade follower counts
-- The existing followers column will now store Arena internal follower counts
ALTER TABLE leaderboard_ranks ADD COLUMN IF NOT EXISTS copiers integer DEFAULT 0;

-- Migrate existing exchange follower data to copiers column
UPDATE leaderboard_ranks SET copiers = followers WHERE followers > 0;

-- Reset followers to 0 (will be populated from trader_follows table)
UPDATE leaderboard_ranks SET followers = 0;

-- Comment for clarity
COMMENT ON COLUMN leaderboard_ranks.followers IS 'Arena platform follower count (from trader_follows table)';
COMMENT ON COLUMN leaderboard_ranks.copiers IS 'Exchange copy-trade follower count (from exchange APIs)';
