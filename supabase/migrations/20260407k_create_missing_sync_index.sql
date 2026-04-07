-- ROOT CAUSE FIX: idx_leaderboard_ranks_sync was referenced but never created.
-- idx_leaderboard_ranks_computed_at was dropped in 20260406d assuming sync index existed.
-- Without either index, sync-meilisearch does a full table scan → 30s statement_timeout.
--
-- This covering index supports the sync-meilisearch query:
--   SELECT ... FROM leaderboard_ranks
--   WHERE season_id = ? AND arena_score > 0 AND is_outlier = false
--   ORDER BY computed_at DESC
--   LIMIT 500

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_sync
  ON leaderboard_ranks (season_id, computed_at DESC)
  WHERE arena_score > 0 AND (is_outlier IS NULL OR is_outlier = false);
