-- Add composite index for exchange-specific ranking queries
-- Pattern: WHERE source = $1 AND season_id = $2 AND arena_score IS NOT NULL
--          ORDER BY arena_score DESC LIMIT N
-- Without this index, the planner scans all sources in a season before filtering.

CREATE INDEX IF NOT EXISTS idx_leaderboard_ranks_source_season_score
  ON leaderboard_ranks(source, season_id, arena_score DESC NULLS LAST)
  WHERE arena_score IS NOT NULL AND arena_score > 0;
