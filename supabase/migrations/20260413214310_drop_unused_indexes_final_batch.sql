-- Migration: 20260413214310_drop_unused_indexes_final_batch.sql
-- Description: Final batch of unused index drops + RLS policy consolidation.
-- Applied to prod via pg pool + Supabase MCP on 2026-04-14.
-- Performance advisors: 752 → 348 → ~300 (estimated after this batch)

-- 1. Drop 9 unused indexes (0 scans, >1MB each, ~65MB total)
DROP INDEX CONCURRENTLY IF EXISTS idx_interactions_wallet_id;
DROP INDEX CONCURRENTLY IF EXISTS idx_library_items_title_trgm;
DROP INDEX CONCURRENTLY IF EXISTS idx_leaderboard_snapshots_full;
DROP INDEX CONCURRENTLY IF EXISTS idx_mv_daily_rankings_composite;
DROP INDEX CONCURRENTLY IF EXISTS idx_pipeline_logs_status_ended;
DROP INDEX CONCURRENTLY IF EXISTS idx_library_language_group;
DROP INDEX CONCURRENTLY IF EXISTS idx_leaderboard_ranks_active;
DROP INDEX CONCURRENTLY IF EXISTS idx_trader_sources_source_active;
DROP INDEX CONCURRENTLY IF EXISTS idx_trader_snapshots_authorization_id;

-- 2. Consolidate overlapping RLS policies
-- group_members: remove duplicate INSERT
DROP POLICY IF EXISTS "members_join_open" ON group_members;

-- channel_members: merge 3 admin CRUD → 1 ALL
DROP POLICY IF EXISTS "Channel admins can delete members" ON channel_members;
DROP POLICY IF EXISTS "Channel admins can insert members" ON channel_members;
DROP POLICY IF EXISTS "Channel admins can update members" ON channel_members;
CREATE POLICY "Channel admins manage members" ON channel_members FOR ALL
  USING (channel_id IN (SELECT cm.channel_id FROM channel_members cm WHERE cm.user_id = (SELECT auth.uid()) AND cm.role IN ('admin', 'owner')))
  WITH CHECK (channel_id IN (SELECT cm.channel_id FROM channel_members cm WHERE cm.user_id = (SELECT auth.uid()) AND cm.role IN ('admin', 'owner')));

-- trader_anomalies: merge 3 admin CRUD → 1 ALL
DROP POLICY IF EXISTS "Admins can insert anomalies" ON trader_anomalies;
DROP POLICY IF EXISTS "Admins can update anomalies" ON trader_anomalies;
DROP POLICY IF EXISTS "Admins can view all anomalies" ON trader_anomalies;
CREATE POLICY "Admins manage anomalies" ON trader_anomalies FOR ALL
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = (SELECT auth.uid()) AND user_profiles.role = 'admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = (SELECT auth.uid()) AND user_profiles.role = 'admin'));
