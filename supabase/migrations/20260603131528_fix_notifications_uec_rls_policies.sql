-- Migration: 20260603131528_fix_notifications_uec_rls_policies.sql
-- Created: 2026-06-03T20:15:28Z
-- Description: Fix two RLS policy bugs found by tracing the full migration history.
--
-- Bug 1 (notifications): "Users manage own notifications" (FOR ALL) inadvertently
--   grants INSERT to any authenticated user for their own user_id. The intent is
--   that only service_role can INSERT notifications. Fix: replace the ALL policy
--   with individual SELECT+UPDATE+DELETE, and drop the now-redundant
--   "notifications_insert_service_only" (covered by "Service manage notifications"
--   which is ALL TO service_role).
--
-- Bug 2 (user_exchange_connections): Two successive migrations dropped all policies:
--   20260413213151 dropped individual CRUD policies (intending to keep ALL),
--   20260413213521 then dropped the ALL policy. Result: RLS enabled, zero policies,
--   table completely locked out for non-service-role connections.
--   Fix: restore user self-management as individual CRUD policies.

BEGIN;

-- ============================================================
-- Fix 1: notifications — replace ALL with SELECT+UPDATE+DELETE
-- ============================================================

-- Drop the over-broad ALL policy that grants INSERT to users
DROP POLICY IF EXISTS "Users manage own notifications" ON notifications;

-- Drop the redundant service_role INSERT check (already covered by "Service manage notifications")
DROP POLICY IF EXISTS "notifications_insert_service_only" ON notifications;

-- Recreate as individual operations (no INSERT — only service_role inserts)
CREATE POLICY "Users can read own notifications"
  ON notifications FOR SELECT TO public
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own notifications"
  ON notifications FOR UPDATE TO public
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own notifications"
  ON notifications FOR DELETE TO public
  USING ((SELECT auth.uid()) = user_id);

-- "Service manage notifications" (ALL TO service_role) remains untouched —
-- it handles all service-side operations including INSERT.

-- ============================================================
-- Fix 2: user_exchange_connections — restore user policies
-- ============================================================

-- Individual CRUD policies (not ALL) to satisfy Supabase lint 0016
CREATE POLICY "Users can view own exchange connections"
  ON user_exchange_connections FOR SELECT TO public
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can insert own exchange connections"
  ON user_exchange_connections FOR INSERT TO public
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can update own exchange connections"
  ON user_exchange_connections FOR UPDATE TO public
  USING ((SELECT auth.uid()) = user_id)
  WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY "Users can delete own exchange connections"
  ON user_exchange_connections FOR DELETE TO public
  USING ((SELECT auth.uid()) = user_id);

COMMIT;
