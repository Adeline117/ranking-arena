-- Add indexes for tables with excessive sequential scans
-- trader_follows: 151K seq_scan, 0 idx_scan (100% seq)
-- user_follows: 21K seq_scan, 99% seq
-- pipeline_logs: 55K seq_scan, 1.2B seq_tup_read

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_follows_trader_id
ON trader_follows (trader_id, source);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_follows_follower
ON user_follows (follower_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_follows_following
ON user_follows (following_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pipeline_logs_job_started
ON pipeline_logs (job_name, started_at DESC);
