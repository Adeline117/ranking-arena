-- Restore idx_posts_status_hot_score dropped in 20260402e_perf_audit_indexes.sql
-- Without this index, ORDER BY hot_score DESC on the /hot page causes full table scans
-- and Supabase statement timeouts (error 57014).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_hot_score
  ON posts (hot_score DESC NULLS LAST)
  WHERE hot_score IS NOT NULL;
