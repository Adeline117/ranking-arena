-- Migration: 20260601185217_add_leaderboard_non_outlier_index.sql
-- Partial index for rankings query that filters out outliers.
-- The query uses .or('is_outlier.is.null,is_outlier.eq.false') which
-- forces a bitmap OR on 314K rows. This partial index eliminates the
-- predicate entirely by only indexing non-outlier rows.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leaderboard_ranks_non_outlier
  ON leaderboard_ranks (season_id, arena_score DESC NULLS LAST)
  WHERE is_outlier IS NOT TRUE;
