-- Add rank_change and is_new columns to leaderboard_ranks
-- rank_change: positive = moved up, negative = moved down, 0 = unchanged, NULL = unknown
-- is_new: true if trader was not in yesterday's leaderboard

ALTER TABLE leaderboard_ranks ADD COLUMN IF NOT EXISTS rank_change INTEGER;
ALTER TABLE leaderboard_ranks ADD COLUMN IF NOT EXISTS is_new BOOLEAN DEFAULT false;
