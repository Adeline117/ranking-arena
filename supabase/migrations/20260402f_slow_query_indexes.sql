-- Slow query index fixes based on pg_stat_statements analysis
-- Date: 2026-04-02
-- Findings:
--   1. traders handle/trader_key OR lookup: 50K calls × 306ms avg = 15.4M ms total (seq scan on 88K rows)
--   2. pipeline_logs LIKE 'batch-fetch%' + status + started_at: 52K calls × 169ms avg (seq scan on 25K rows)
--   3. traders stale-refresh (last_seen_at IS NULL OR <): 1454 calls × 829ms avg (seq scan + sort)
--   4. posts feed (visibility='public' ORDER BY hot_score DESC): 681 calls × 623ms avg
--   5. posts timeline (visibility='public' ORDER BY created_at DESC): 591 calls × 57ms avg

-- ============================================================
-- 1. traders: handle + trader_key indexes for OR-based lookup
--    Query: WHERE handle = $1 OR trader_key = $2
--    Before: 835ms seq scan → After: 5ms BitmapOr on two index scans
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_traders_handle
  ON traders (handle);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_traders_trader_key
  ON traders (trader_key);

-- ============================================================
-- 2. traders: composite index for stale-refresh enrichment query
--    Query: WHERE is_active AND platform = ANY(...) ORDER BY updated_at
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_traders_active_platform_updated
  ON traders (platform, updated_at ASC) WHERE (is_active = true);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_traders_active_refresh
  ON traders (platform, last_seen_at NULLS FIRST, updated_at ASC) WHERE (is_active = true);

-- ============================================================
-- 3. pipeline_logs: text_pattern_ops for LIKE prefix matching
--    Query: WHERE job_name LIKE 'batch-fetch%' AND status = 'success' AND started_at >= X
--    Before: 671ms seq scan → After: 23ms index scan
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pipeline_logs_job_name_pattern
  ON pipeline_logs (job_name text_pattern_ops, status, started_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pipeline_logs_started_at
  ON pipeline_logs (started_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pipeline_logs_status_ended
  ON pipeline_logs (status, ended_at DESC) WHERE (status = 'success');

-- ============================================================
-- 4. posts: visibility + sort indexes for feed queries
--    Before: 91ms bitmap scan → After: 13ms with covering index
-- ============================================================
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_visibility_hot_score
  ON posts (visibility, hot_score DESC NULLS LAST) WHERE (deleted_at IS NULL);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_visibility_created
  ON posts (visibility, created_at DESC) WHERE (deleted_at IS NULL);

-- ============================================================
-- 5. trader_position_history: created_at for time-range queries
--    52M rows, multiple diagnostic/growth queries filter by created_at
--    NOTE: This index must be created via Supabase Dashboard SQL editor
--    (direct connection, not pooler) due to 52M rows requiring >5min build time
--    which exceeds the connection pooler's statement_timeout.
-- ============================================================
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_position_history_created_at
--   ON trader_position_history (created_at DESC);

-- ============================================================
-- 6. Drop redundant index (exact duplicate)
-- ============================================================
-- idx_pipeline_logs_job_started is identical to idx_pipeline_logs_job_time
DROP INDEX CONCURRENTLY IF EXISTS idx_pipeline_logs_job_started;
