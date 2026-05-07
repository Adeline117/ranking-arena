-- Migration: Composite indexes for posts feed + subscriptions active check
-- Purpose: Posts feed queries filter (visibility='public') + ORDER BY created_at DESC.
--          Separate indexes require bitmap heap scan; partial composite enables index-only scan.
--          Also adds filtered index for subscriptions active status checks (6,771 seq scans).

-- 1. Posts: partial index for public feed (covers 95%+ of feed queries)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_visibility_created
  ON posts (created_at DESC)
  WHERE visibility = 'public' AND is_sensitive = false;

-- 2. Posts: group feed composite (group_id + created_at is the hot path for group pages)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_posts_group_visibility_created
  ON posts (group_id, created_at DESC)
  WHERE visibility = 'public';

-- 3. Subscriptions: partial index for active status checks
-- Fixes 6,771 sequential scans reported by pg_stat_user_tables advisor
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_subscriptions_active_user
  ON subscriptions (user_id)
  WHERE status = 'active';
