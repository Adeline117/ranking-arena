-- Security Audit: RLS fixes for missing/incomplete policies
-- P0-1: trader_sources, trader_snapshots, search_analytics missing RLS
-- P0-2: Posts RLS USING(true) exposes group private posts
-- P1-7: avoid_votes + competitions incomplete policies
-- P1-9: pipeline_logs needs RLS
-- P2-4: leaderboard_ranks + feedback table policies

BEGIN;

-- ============================================
-- P0-1: Enable RLS on trader_sources
-- ============================================
ALTER TABLE IF EXISTS trader_sources ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "trader_sources_public_select" ON trader_sources;
CREATE POLICY "trader_sources_public_select" ON trader_sources
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "trader_sources_service_role_insert" ON trader_sources;
CREATE POLICY "trader_sources_service_role_insert" ON trader_sources
  FOR INSERT WITH CHECK (
    current_setting('role') = 'service_role'
  );

DROP POLICY IF EXISTS "trader_sources_service_role_update" ON trader_sources;
CREATE POLICY "trader_sources_service_role_update" ON trader_sources
  FOR UPDATE USING (
    current_setting('role') = 'service_role'
  );

DROP POLICY IF EXISTS "trader_sources_service_role_delete" ON trader_sources;
CREATE POLICY "trader_sources_service_role_delete" ON trader_sources
  FOR DELETE USING (
    current_setting('role') = 'service_role'
  );

-- ============================================
-- P0-1: Enable RLS on trader_snapshots (v1 table if exists)
-- ============================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'trader_snapshots' AND table_schema = 'public') THEN
    EXECUTE 'ALTER TABLE trader_snapshots ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "trader_snapshots_public_select" ON trader_snapshots';
    EXECUTE 'CREATE POLICY "trader_snapshots_public_select" ON trader_snapshots FOR SELECT USING (true)';

    EXECUTE 'DROP POLICY IF EXISTS "trader_snapshots_service_role_insert" ON trader_snapshots';
    EXECUTE 'CREATE POLICY "trader_snapshots_service_role_insert" ON trader_snapshots FOR INSERT WITH CHECK (current_setting(''role'') = ''service_role'')';

    EXECUTE 'DROP POLICY IF EXISTS "trader_snapshots_service_role_update" ON trader_snapshots';
    EXECUTE 'CREATE POLICY "trader_snapshots_service_role_update" ON trader_snapshots FOR UPDATE USING (current_setting(''role'') = ''service_role'')';

    EXECUTE 'DROP POLICY IF EXISTS "trader_snapshots_service_role_delete" ON trader_snapshots';
    EXECUTE 'CREATE POLICY "trader_snapshots_service_role_delete" ON trader_snapshots FOR DELETE USING (current_setting(''role'') = ''service_role'')';
  END IF;
END $$;

-- ============================================
-- P0-1 + P0-6: Enable RLS on search_analytics (service_role only)
-- ============================================
ALTER TABLE IF EXISTS search_analytics ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "search_analytics_service_role_all" ON search_analytics;
CREATE POLICY "search_analytics_service_role_all" ON search_analytics
  USING (current_setting('role') = 'service_role')
  WITH CHECK (current_setting('role') = 'service_role');

-- ============================================
-- P0-2: Fix posts SELECT policy to respect visibility
-- ============================================
DROP POLICY IF EXISTS "Posts are viewable by everyone" ON posts;
DROP POLICY IF EXISTS "Posts are viewable based on visibility" ON posts;
CREATE POLICY "Posts are viewable based on visibility" ON posts
  FOR SELECT USING (
    visibility = 'public'
    OR author_id = auth.uid()
    OR (visibility = 'group' AND EXISTS (
      SELECT 1 FROM group_members
      WHERE group_members.group_id = posts.group_id
      AND group_members.user_id = auth.uid()
    ))
  );

-- ============================================
-- P1-7: avoid_votes — add status validation constraint
-- ============================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'avoid_votes' AND table_schema = 'public') THEN
    -- Add CHECK constraint for valid vote statuses if not exists
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.check_constraints
      WHERE constraint_name = 'avoid_votes_status_check'
    ) THEN
      EXECUTE 'ALTER TABLE avoid_votes ADD CONSTRAINT avoid_votes_status_check CHECK (status IN (''pending'', ''approved'', ''rejected''))';
    END IF;
  END IF;
END $$;

-- ============================================
-- P1-7: competitions — add UPDATE policy for entries by creator
-- ============================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'competition_entries' AND table_schema = 'public') THEN
    EXECUTE 'DROP POLICY IF EXISTS "competition_entries_creator_update" ON competition_entries';
    EXECUTE 'CREATE POLICY "competition_entries_creator_update" ON competition_entries FOR UPDATE USING (user_id = auth.uid())';
  END IF;
END $$;

-- ============================================
-- P1-9: Enable RLS on pipeline_logs (service_role only)
-- ============================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'pipeline_logs' AND table_schema = 'public') THEN
    EXECUTE 'ALTER TABLE pipeline_logs ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "pipeline_logs_service_role_all" ON pipeline_logs';
    EXECUTE 'CREATE POLICY "pipeline_logs_service_role_all" ON pipeline_logs USING (current_setting(''role'') = ''service_role'') WITH CHECK (current_setting(''role'') = ''service_role'')';
  END IF;
END $$;

-- ============================================
-- P2-4: Enable RLS on leaderboard_ranks if missing
-- ============================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'leaderboard_ranks' AND table_schema = 'public') THEN
    EXECUTE 'ALTER TABLE leaderboard_ranks ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "leaderboard_ranks_public_select" ON leaderboard_ranks';
    EXECUTE 'CREATE POLICY "leaderboard_ranks_public_select" ON leaderboard_ranks FOR SELECT USING (true)';

    EXECUTE 'DROP POLICY IF EXISTS "leaderboard_ranks_service_role_write" ON leaderboard_ranks';
    EXECUTE 'CREATE POLICY "leaderboard_ranks_service_role_write" ON leaderboard_ranks FOR ALL USING (current_setting(''role'') = ''service_role'') WITH CHECK (current_setting(''role'') = ''service_role'')';
  END IF;
END $$;

-- ============================================
-- P2-4: Fix feedback table SELECT policy (restrict to own + service_role)
-- ============================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'feedback' AND table_schema = 'public') THEN
    EXECUTE 'ALTER TABLE feedback ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "feedback_select" ON feedback';
    EXECUTE 'CREATE POLICY "feedback_select" ON feedback FOR SELECT USING (user_id = auth.uid() OR current_setting(''role'') = ''service_role'')';

    EXECUTE 'DROP POLICY IF EXISTS "feedback_insert" ON feedback';
    EXECUTE 'CREATE POLICY "feedback_insert" ON feedback FOR INSERT WITH CHECK (user_id = auth.uid() OR current_setting(''role'') = ''service_role'')';

    EXECUTE 'DROP POLICY IF EXISTS "feedback_service_role_all" ON feedback';
    EXECUTE 'CREATE POLICY "feedback_service_role_all" ON feedback FOR ALL USING (current_setting(''role'') = ''service_role'') WITH CHECK (current_setting(''role'') = ''service_role'')';
  END IF;
END $$;

COMMIT;
