-- Fix missing RLS on hot_topics and refresh_jobs tables.
-- hot_topics: public read (data is not sensitive), service_role write
-- refresh_jobs: service_role only (internal job queue, never client-facing)

-- ============================================
-- 1. hot_topics
-- ============================================
ALTER TABLE hot_topics ENABLE ROW LEVEL SECURITY;

-- Public can read hot topics (they are displayed on the homepage/market page)
CREATE POLICY "hot_topics_select_public" ON hot_topics
  FOR SELECT
  USING (true);

-- Only service_role can insert/update/delete
CREATE POLICY "hot_topics_insert_service_role" ON hot_topics
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "hot_topics_update_service_role" ON hot_topics
  FOR UPDATE
  TO service_role
  USING (true);

CREATE POLICY "hot_topics_delete_service_role" ON hot_topics
  FOR DELETE
  TO service_role
  USING (true);

-- ============================================
-- 2. refresh_jobs
-- ============================================
ALTER TABLE refresh_jobs ENABLE ROW LEVEL SECURITY;

-- service_role only: this is an internal job queue, never accessed by clients
CREATE POLICY "refresh_jobs_service_role_only" ON refresh_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
