-- 00033: Security RLS Hardening
-- Fix missing RLS on core tables + tighten notification INSERT policies

-- ============================================
-- 1. trader_snapshots - Enable RLS
-- ============================================
ALTER TABLE trader_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trader_snapshots_select_public"
  ON trader_snapshots FOR SELECT
  USING (true);

CREATE POLICY "trader_snapshots_insert_service_only"
  ON trader_snapshots FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "trader_snapshots_update_service_only"
  ON trader_snapshots FOR UPDATE
  USING (auth.role() = 'service_role');

CREATE POLICY "trader_snapshots_delete_service_only"
  ON trader_snapshots FOR DELETE
  USING (auth.role() = 'service_role');

-- ============================================
-- 2. trader_sources - Enable RLS
-- ============================================
ALTER TABLE trader_sources ENABLE ROW LEVEL SECURITY;

CREATE POLICY "trader_sources_select_public"
  ON trader_sources FOR SELECT
  USING (true);

CREATE POLICY "trader_sources_insert_service_only"
  ON trader_sources FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "trader_sources_update_service_only"
  ON trader_sources FOR UPDATE
  USING (auth.role() = 'service_role');

CREATE POLICY "trader_sources_delete_service_only"
  ON trader_sources FOR DELETE
  USING (auth.role() = 'service_role');

-- ============================================
-- 3. search_analytics - Enable RLS (service_role only)
-- ============================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'search_analytics') THEN
    ALTER TABLE search_analytics ENABLE ROW LEVEL SECURITY;

    EXECUTE 'CREATE POLICY "search_analytics_service_only"
      ON search_analytics FOR ALL
      USING (auth.role() = ''service_role'')';
  END IF;
END $$;

-- ============================================
-- 4. backup_codes - Enable RLS (own user only)
-- ============================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'backup_codes') THEN
    ALTER TABLE backup_codes ENABLE ROW LEVEL SECURITY;

    EXECUTE 'CREATE POLICY "backup_codes_own_user"
      ON backup_codes FOR ALL
      USING (auth.uid() = user_id)';
  END IF;
END $$;

-- ============================================
-- 5. login_sessions - Enable RLS (own user only)
-- ============================================
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'login_sessions') THEN
    ALTER TABLE login_sessions ENABLE ROW LEVEL SECURITY;

    EXECUTE 'CREATE POLICY "login_sessions_own_user"
      ON login_sessions FOR ALL
      USING (auth.uid() = user_id)';
  END IF;
END $$;

-- ============================================
-- 6. Tighten notification-related INSERT policies
-- ============================================

-- notifications: drop overly permissive INSERT, replace with service_role only
DROP POLICY IF EXISTS "System can insert notifications" ON notifications;
CREATE POLICY "notifications_insert_service_only"
  ON notifications FOR INSERT
  WITH CHECK (auth.role() = 'service_role');

-- risk_alerts
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'risk_alerts') THEN
    EXECUTE 'DROP POLICY IF EXISTS "System can insert risk_alerts" ON risk_alerts';
    EXECUTE 'CREATE POLICY "risk_alerts_insert_service_only"
      ON risk_alerts FOR INSERT
      WITH CHECK (auth.role() = ''service_role'')';
  END IF;
END $$;

-- push_notification_logs
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'push_notification_logs') THEN
    EXECUTE 'DROP POLICY IF EXISTS "System can insert push_notification_logs" ON push_notification_logs';
    EXECUTE 'CREATE POLICY "push_notification_logs_insert_service_only"
      ON push_notification_logs FOR INSERT
      WITH CHECK (auth.role() = ''service_role'')';
  END IF;
END $$;
