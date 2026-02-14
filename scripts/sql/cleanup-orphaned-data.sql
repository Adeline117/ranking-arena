-- ============================================================
-- Arena Database Cleanup Script
-- Generated: 2026-02-13
-- Purpose: Remove orphaned records and expired data
-- ============================================================

-- Always run in a transaction
BEGIN;

-- ============================================================
-- 1. Orphaned notifications (user_id references deleted users)
--    Count: 217 rows
-- ============================================================
DELETE FROM notifications
WHERE user_id NOT IN (SELECT id FROM users);

-- ============================================================
-- 2. Duplicate trader_snapshots (same source+trader+date)
--    Keep only the latest snapshot per day per trader
--    Excess rows: ~30,964
-- ============================================================
DELETE FROM trader_snapshots
WHERE id NOT IN (
  SELECT DISTINCT ON (source, source_trader_id, DATE(captured_at))
    id
  FROM trader_snapshots
  ORDER BY source, source_trader_id, DATE(captured_at), captured_at DESC
);

-- ============================================================
-- 3. Expired oauth_states (older than 1 day)
--    Currently 0, but good to run periodically
-- ============================================================
DELETE FROM oauth_states
WHERE created_at < NOW() - INTERVAL '1 day';

-- ============================================================
-- 4. Old notification_history (older than 90 days)
-- ============================================================
DELETE FROM notification_history
WHERE sent_at < NOW() - INTERVAL '90 days';

-- ============================================================
-- 5. Old pipeline_metrics (older than 60 days)
-- ============================================================
DELETE FROM pipeline_metrics
WHERE created_at < NOW() - INTERVAL '60 days';

-- ============================================================
-- Verify counts after cleanup
-- ============================================================
-- SELECT 'notifications_remaining', COUNT(*) FROM notifications;
-- SELECT 'trader_snapshots_remaining', COUNT(*) FROM trader_snapshots;

COMMIT;
