-- Index optimized for SQL-side diversity filtering
--
-- ROOT CAUSE: The /api/traders endpoint applies platform diversity in JS
-- AFTER fetching from DB, which leaves gaps below the requested limit
-- (30D returns 35/50 because gmx hits the per-platform cap of 20).
--
-- We can't fix this in JS without either:
-- 1. Fetching limit*2 (caused 20s timeouts before our other fixes)
-- 2. Or doing diversity in SQL with a window function
--
-- For window functions to be fast, we need (season_id, source, arena_score DESC)
-- ordering. The existing idx_leaderboard_ranks_source_season_score is
-- (source, season_id, arena_score DESC) which forces a scan of all sources.
--
-- This index is the inverse — leads with season_id (matches WHERE),
-- then source (PARTITION BY), then arena_score (ORDER BY). Query becomes
-- a single index scan with no sort step.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_diverse
ON leaderboard_ranks (season_id, source, arena_score DESC NULLS LAST)
WHERE arena_score > 0 AND (is_outlier IS NULL OR is_outlier = false);
