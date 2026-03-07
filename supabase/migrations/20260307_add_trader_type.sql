-- Add trader_type column to support bot/human classification
-- Values: 'human', 'bot', NULL (unknown/unclassified)

ALTER TABLE trader_snapshots ADD COLUMN IF NOT EXISTS trader_type TEXT;
ALTER TABLE leaderboard_ranks ADD COLUMN IF NOT EXISTS trader_type TEXT;

-- Index for filtering by trader_type
CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_trader_type
  ON leaderboard_ranks (season_id, trader_type) WHERE trader_type IS NOT NULL;

COMMENT ON COLUMN trader_snapshots.trader_type IS 'human or bot classification';
COMMENT ON COLUMN leaderboard_ranks.trader_type IS 'human or bot classification';
