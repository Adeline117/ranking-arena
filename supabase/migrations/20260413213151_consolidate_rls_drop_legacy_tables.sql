-- Migration: 20260413213151_consolidate_rls_drop_legacy_tables.sql
-- Description: Consolidate overlapping RLS policies + drop empty legacy tables.
-- Applied to prod via Supabase MCP on 2026-04-14.

-- 1. Fix SECURITY DEFINER views → SECURITY INVOKER (5 views)
ALTER VIEW public.pipeline_job_stats SET (security_invoker = on);
ALTER VIEW public.pipeline_job_status SET (security_invoker = on);
ALTER VIEW public.public_user_profiles SET (security_invoker = on);
ALTER VIEW public.trader_sources_compat SET (security_invoker = on);
ALTER VIEW public.trader_unified_view SET (security_invoker = on);

-- 2. Fix search_path on bulk_enrich_sync_v2
ALTER FUNCTION public.bulk_enrich_sync_v2(jsonb) SET search_path = public, pg_temp;

-- 3. Consolidate overlapping permissive policies (merge N user CRUD → 1 ALL)
-- user_exchange_connections: drop 4 redundant (ALL policy covers them)
DROP POLICY IF EXISTS "Users can delete their own connections" ON user_exchange_connections;
DROP POLICY IF EXISTS "Users can insert their own connections" ON user_exchange_connections;
DROP POLICY IF EXISTS "Users can update their own connections" ON user_exchange_connections;
DROP POLICY IF EXISTS "Users can view their own connections" ON user_exchange_connections;

-- push_subscriptions: merge 4 user CRUD → 1 ALL
DROP POLICY IF EXISTS "Users can create own push subscriptions" ON push_subscriptions;
DROP POLICY IF EXISTS "Users can delete own push subscriptions" ON push_subscriptions;
DROP POLICY IF EXISTS "Users can update own push subscriptions" ON push_subscriptions;
DROP POLICY IF EXISTS "Users can view own push subscriptions" ON push_subscriptions;
CREATE POLICY "Users manage own push subscriptions" ON push_subscriptions FOR ALL
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- notifications: merge 3 user policies → 1 ALL (keep Service insert)
DROP POLICY IF EXISTS "Users can read own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can update own notifications" ON notifications;
DROP POLICY IF EXISTS "Users can delete their own notifications" ON notifications;
CREATE POLICY "Users manage own notifications" ON notifications FOR ALL
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- user_linked_traders: merge 4 → 1
DROP POLICY IF EXISTS "Users can delete own linked traders" ON user_linked_traders;
DROP POLICY IF EXISTS "Users can insert own linked traders" ON user_linked_traders;
DROP POLICY IF EXISTS "Users can update own linked traders" ON user_linked_traders;
DROP POLICY IF EXISTS "Users can view own linked traders" ON user_linked_traders;
CREATE POLICY "Users manage own linked traders" ON user_linked_traders FOR ALL
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- ranking_snapshots: merge 3 → 1 (uses created_by column)
DROP POLICY IF EXISTS "Users can delete own snapshots" ON ranking_snapshots;
DROP POLICY IF EXISTS "Users can update own snapshots" ON ranking_snapshots;
DROP POLICY IF EXISTS "Users can view own snapshots" ON ranking_snapshots;
CREATE POLICY "Users manage own snapshots" ON ranking_snapshots FOR ALL
  USING (created_by = (SELECT auth.uid())) WITH CHECK (created_by = (SELECT auth.uid()));

-- trader_authorizations: merge 4 → 1
DROP POLICY IF EXISTS "Users can create their own authorizations" ON trader_authorizations;
DROP POLICY IF EXISTS "Users can delete their own authorizations" ON trader_authorizations;
DROP POLICY IF EXISTS "Users can update their own authorizations" ON trader_authorizations;
DROP POLICY IF EXISTS "Users can view their own authorizations" ON trader_authorizations;
CREATE POLICY "Users manage own authorizations" ON trader_authorizations FOR ALL
  USING ((SELECT auth.uid()) = user_id) WITH CHECK ((SELECT auth.uid()) = user_id);

-- 4. Drop 12 empty legacy tables (0 rows, no code refs, no policies)
DROP TABLE IF EXISTS cluster_members CASCADE;
DROP TABLE IF EXISTS clusters CASCADE;
DROP TABLE IF EXISTS funding_hubs CASCADE;
DROP TABLE IF EXISTS labels CASCADE;
DROP TABLE IF EXISTS project_interactions CASCADE;
DROP TABLE IF EXISTS project_labels CASCADE;
DROP TABLE IF EXISTS project_wallets CASCADE;
DROP TABLE IF EXISTS risk_scores CASCADE;
DROP TABLE IF EXISTS tasks CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS transfers CASCADE;
DROP TABLE IF EXISTS wallet_metadata CASCADE;
