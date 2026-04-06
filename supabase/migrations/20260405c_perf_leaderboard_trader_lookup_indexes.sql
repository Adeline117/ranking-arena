-- Performance: add trader lookup indexes on leaderboard_ranks
-- Fixes: OR condition (source_trader_id OR handle) with season_id
-- Before: 1,344ms (scanned 24K rows with post-filter)
-- After: 0.18ms (BitmapOr of two index scans)

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_season_trader_id
ON leaderboard_ranks (season_id, source_trader_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_season_handle
ON leaderboard_ranks (season_id, handle);
