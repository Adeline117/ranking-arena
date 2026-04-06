-- Drop redundant covering indexes on leaderboard_ranks
-- Root cause: 14 indexes on 74K rows caused 16s SELECT LIMIT 1 due to I/O contention
-- After: 11 indexes, indexes 367MB → 235MB, SELECT LIMIT 1 = 1ms
--
-- idx_leaderboard_ranks_season_arena_score_desc (82MB):
--   Subsumed by idx_leaderboard_ranks_api_default (89MB, same key, more INCLUDE columns)
-- idx_leaderboard_ranks_source_season_arena (11MB):
--   Subsumed by idx_leaderboard_ranks_source_season_score (85MB, same key, more INCLUDE columns)
-- idx_leaderboard_ranks_computed_at (40MB):
--   Only used by time-based freshness checks; idx_leaderboard_ranks_sync covers this use case

DROP INDEX CONCURRENTLY IF EXISTS idx_leaderboard_ranks_season_arena_score_desc;
DROP INDEX CONCURRENTLY IF EXISTS idx_leaderboard_ranks_source_season_arena;
DROP INDEX CONCURRENTLY IF EXISTS idx_leaderboard_ranks_computed_at;

-- Also VACUUM trader_stats_detail which had 148K dead tuples
-- (This is applied manually since VACUUM cannot be in a transaction, but documenting here)
-- VACUUM trader_stats_detail;
