-- RLS Audit Cleanup — 2026-03-05
-- Fixes: critical daily_trader_stats policy, removes duplicate policies

-- ============================================================
-- 1. CRITICAL FIX: daily_trader_stats had PUBLIC write-all policy
-- ============================================================
DROP POLICY IF EXISTS "daily_stats_service_write" ON daily_trader_stats;
CREATE POLICY "daily_stats_service_write" ON daily_trader_stats
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ============================================================
-- 2. Remove duplicate RLS policies (performance overhead)
-- ============================================================

-- user_profiles: keep "User profiles are viewable by everyone" (r), drop duplicates
DROP POLICY IF EXISTS "user_profiles_read_all" ON user_profiles;
DROP POLICY IF EXISTS "user_profiles_update_self" ON user_profiles;
DROP POLICY IF EXISTS "user_profiles_write_self" ON user_profiles;

-- groups: keep original policies, drop duplicates
DROP POLICY IF EXISTS "groups_read_all" ON groups;
DROP POLICY IF EXISTS "groups_update_admin" ON groups;

-- group_members: keep original policies, drop duplicates
DROP POLICY IF EXISTS "members_read_auth" ON group_members;
DROP POLICY IF EXISTS "members_update_admin" ON group_members;

-- notifications: keep auth.uid() scoped policies, drop duplicates
DROP POLICY IF EXISTS "Users can view their own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can update their own notifications" ON notifications;

-- content_reports: keep admin + user policies, drop duplicates
DROP POLICY IF EXISTS "users_insert_reports" ON content_reports;
DROP POLICY IF EXISTS "users_read_own_reports" ON content_reports;
