-- Migration: fix_multiple_permissive_policies
-- Purpose: Eliminate overlapping permissive RLS policies that cause redundant evaluation
-- Ref: https://supabase.com/docs/guides/database/database-linter?lint=0016_multiple_permissive_policies
--
-- Three fix patterns applied:
-- A) Drop redundant SELECT when ALL already covers it (identical condition)
-- B) Replace ALL with INSERT+UPDATE+DELETE to avoid overlap with wider SELECT
-- C) Scope service role ALL to TO service_role (not TO public)
--
-- Applied live before this migration file was created.

-- Pattern A: Drop redundant SELECT (ALL already covers)
DROP POLICY IF EXISTS "Users can read own progress" ON public.reading_progress;
DROP POLICY IF EXISTS "Users can read own stats" ON public.reading_statistics;
DROP POLICY IF EXISTS "Admins can view all alerts" ON public.manipulation_alerts;
DROP POLICY IF EXISTS "Admins can view all flags" ON public.trader_flags;

-- Pattern C: Scope service role to TO service_role
DROP POLICY IF EXISTS "Service role full access to notification history" ON public.notification_history;
CREATE POLICY "Service role full access to notification history" ON public.notification_history
  AS PERMISSIVE FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "Service role can manage pipeline_logs" ON public.pipeline_logs;
CREATE POLICY "Service role can manage pipeline_logs" ON public.pipeline_logs
  AS PERMISSIVE FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "Service role can manage subscriptions" ON public.subscriptions;
CREATE POLICY "Service role can manage subscriptions" ON public.subscriptions
  AS PERMISSIVE FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "Service can insert notifications" ON public.notifications;

-- Pattern B: Replace ALL with INSERT+UPDATE+DELETE (keep wider SELECT separate)

-- bookmark_folders
DROP POLICY IF EXISTS "Users can manage own folders" ON public.bookmark_folders;
CREATE POLICY "Users can manage own folders" ON public.bookmark_folders
  AS PERMISSIVE FOR INSERT TO public WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can update own folders" ON public.bookmark_folders
  AS PERMISSIVE FOR UPDATE TO public USING (user_id = (SELECT auth.uid()));
CREATE POLICY "Users can delete own folders" ON public.bookmark_folders
  AS PERMISSIVE FOR DELETE TO public USING (user_id = (SELECT auth.uid()));

-- ranking_snapshots
DROP POLICY IF EXISTS "Users manage own snapshots" ON public.ranking_snapshots;
CREATE POLICY "Users can insert own snapshots" ON public.ranking_snapshots
  AS PERMISSIVE FOR INSERT TO public WITH CHECK (created_by = (SELECT auth.uid()));
CREATE POLICY "Users can update own snapshots" ON public.ranking_snapshots
  AS PERMISSIVE FOR UPDATE TO public USING (created_by = (SELECT auth.uid()));
CREATE POLICY "Users can delete own snapshots" ON public.ranking_snapshots
  AS PERMISSIVE FOR DELETE TO public USING (created_by = (SELECT auth.uid()));

-- user_collections
DROP POLICY IF EXISTS "users_manage_own_collections" ON public.user_collections;
CREATE POLICY "users_insert_own_collections" ON public.user_collections
  AS PERMISSIVE FOR INSERT TO public WITH CHECK (user_id = (SELECT auth.uid()));
CREATE POLICY "users_update_own_collections" ON public.user_collections
  AS PERMISSIVE FOR UPDATE TO public USING (user_id = (SELECT auth.uid()));
CREATE POLICY "users_delete_own_collections" ON public.user_collections
  AS PERMISSIVE FOR DELETE TO public USING (user_id = (SELECT auth.uid()));

-- flash_news
DROP POLICY IF EXISTS "Only admins can manage flash news" ON public.flash_news;
CREATE POLICY "Admins can insert flash news" ON public.flash_news
  AS PERMISSIVE FOR INSERT TO public
  WITH CHECK (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = (SELECT auth.uid()) AND user_profiles.role = 'admin'));
CREATE POLICY "Admins can update flash news" ON public.flash_news
  AS PERMISSIVE FOR UPDATE TO public
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = (SELECT auth.uid()) AND user_profiles.role = 'admin'));
CREATE POLICY "Admins can delete flash news" ON public.flash_news
  AS PERMISSIVE FOR DELETE TO public
  USING (EXISTS (SELECT 1 FROM user_profiles WHERE user_profiles.id = (SELECT auth.uid()) AND user_profiles.role = 'admin'));

-- Top 3 offenders (fixed earlier in session)
DROP POLICY IF EXISTS "Users can manage their own connections" ON public.user_exchange_connections;

DROP POLICY IF EXISTS "Service role full access to push subscriptions" ON public.push_subscriptions;
CREATE POLICY "Service role full access to push subscriptions" ON public.push_subscriptions
  AS PERMISSIVE FOR ALL TO service_role USING (true);

DROP POLICY IF EXISTS "Service role can manage anomalies" ON public.trader_anomalies;
CREATE POLICY "Service role can manage anomalies" ON public.trader_anomalies
  AS PERMISSIVE FOR ALL TO service_role USING (true);
