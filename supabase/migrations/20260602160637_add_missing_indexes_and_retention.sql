-- Migration: 20260602160637_add_missing_indexes_and_retention.sql
-- Created: 2026-06-02T23:06:37Z
-- Description: Add missing indexes from DB perf audit + retention cleanup prep

-- 1. Notification dedup — composite index for (user_id, type, actor_id, reference_id)
-- Called on every notification send to check 1h dedup window
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_dedup
  ON notifications (user_id, type, actor_id, reference_id, created_at DESC);

-- 2. Trader monthly/yearly performance — no indexes existed
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_monthly_perf_lookup
  ON trader_monthly_performance (source, source_trader_id, year DESC, month DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_yearly_perf_lookup
  ON trader_yearly_performance (source, source_trader_id, year DESC);

-- 3. Blocked users — only had index on blocked_id, not blocker_id
-- Both directions queried in posts + comments for bidirectional block check
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_blocked_users_blocker
  ON blocked_users (blocker_id);

-- 4. Rank history — idx_rank_history_trader_period was dropped in 20260413212329
-- Trader detail sparkline queries need (platform, trader_key, period, snapshot_date)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rank_history_lookup
  ON rank_history (platform, trader_key, period, snapshot_date DESC);

-- 5. user_interactions — needs created_at index for retention cleanup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_interactions_created_at
  ON user_interactions (created_at);

-- 6. search_analytics — needs created_at index for retention cleanup
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_search_analytics_created_at
  ON search_analytics (created_at);
