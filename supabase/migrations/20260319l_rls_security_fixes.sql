-- RLS Security Fixes
-- Fix 1: feedback anonymous INSERT — restrict to authenticated users
-- Fix 2: avoid_votes — users can SELECT their own votes regardless of status
-- Fix 3: competitions — add DELETE policy for creator
-- Fix 4: competition_entries — add UPDATE/DELETE policies for users

-- ============================================================
-- 1. feedback: restrict INSERT to authenticated users only
-- ============================================================

DROP POLICY IF EXISTS "Users can insert feedback" ON feedback;

CREATE POLICY "Authenticated users can insert feedback"
  ON feedback FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- ============================================================
-- 2. avoid_votes: users can SELECT their own votes regardless of status
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'avoid_votes'
  ) THEN
    DROP POLICY IF EXISTS "Users can view own votes" ON avoid_votes;

    CREATE POLICY "Users can view own votes"
      ON avoid_votes FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

-- ============================================================
-- 3. competitions: DELETE policy for creator
-- ============================================================

DROP POLICY IF EXISTS "Creator delete competitions" ON competitions;

CREATE POLICY "Creator delete competitions"
  ON competitions FOR DELETE
  USING (auth.uid() = creator_id);

-- ============================================================
-- 4. competition_entries: DELETE policy (withdraw from competition)
-- ============================================================

DROP POLICY IF EXISTS "Users can withdraw from competitions" ON competition_entries;

CREATE POLICY "Users can withdraw from competitions"
  ON competition_entries FOR DELETE
  USING (auth.uid() = user_id);
