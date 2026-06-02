-- Migration: 20260601213400_add_missing_performance_indexes.sql
-- 3 missing indexes identified by deep backend audit.

-- 1. trader_alerts: cron scans WHERE enabled = true on every run.
--    No existing index covers this filter. As user base grows, full scan is expensive.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_alerts_enabled
  ON trader_alerts (id) WHERE enabled = true;

-- 2. notifications: dedup query in subscription-expiry and sendNotification uses
--    (user_id, type, created_at) but existing index only covers (user_id, read, created_at).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_notifications_user_type_created
  ON notifications (user_id, type, created_at DESC);

-- 3. trader_daily_snapshots: check-trader-alerts queries by trader_key + date
--    but existing index has platform as leading column (not used in that query).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_trader_daily_snapshots_key_date
  ON trader_daily_snapshots (trader_key, date DESC);
