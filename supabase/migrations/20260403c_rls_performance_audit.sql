-- RLS Performance Audit — 2026-04-03
--
-- ISSUES FOUND:
--
-- P0-SECURITY: 4 tables have "service role" ALL policies on {public} role with
--   USING(true) WITH CHECK(true) — any anon/authenticated user can read AND write.
--   Tables: bot_subscriptions, pipeline_state, trader_attestations, user_linked_traders
--
-- P1-REDUNDANT: user_profiles has 3 SELECT policies; "Users can view own full profile"
--   is completely subsumed by "Public can view basic profile info" USING(true).
--   PostgreSQL evaluates ALL matching policies with OR, so 3 SELECT policies
--   means 3 expression evaluations per row — wasteful for a table queried on every page.
--
-- P1-REDUNDANT: traders_legacy has 2 SELECT policies (same pattern).
--   user_levels has 2 SELECT policies (same pattern).
--
-- P1-MISSING: leaderboard_ranks (507 MB, highest traffic public table) and
--   trader_daily_snapshots (144 MB) have no service_role write policy.
--   service_role bypasses RLS so this doesn't block writes, but explicit
--   policies are best practice for auditability.
--
-- P1-MISSING: leaderboard_count_cache has RLS enabled but 0 policies — completely
--   locked to all roles including service_role (service_role bypasses, but still messy).
--

BEGIN;

-- ============================================
-- P0-SECURITY FIX 1: bot_subscriptions
-- Was: FOR ALL on {public} USING(true) — any user can CRUD
-- Fix: restrict to service_role only
-- ============================================
DROP POLICY IF EXISTS "service_role_all" ON bot_subscriptions;
DROP POLICY IF EXISTS "bot_subscriptions_service_role_only" ON bot_subscriptions;

CREATE POLICY "bot_subscriptions_service_role_only" ON bot_subscriptions
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================
-- P0-SECURITY FIX 2: pipeline_state
-- Was: FOR ALL on {public} USING(true) — any user can CRUD
-- Fix: restrict to service_role only
-- ============================================
DROP POLICY IF EXISTS "Service role full access" ON pipeline_state;
DROP POLICY IF EXISTS "service_role_all" ON pipeline_state;
DROP POLICY IF EXISTS "pipeline_state_service_role_only" ON pipeline_state;

CREATE POLICY "pipeline_state_service_role_only" ON pipeline_state
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================
-- P0-SECURITY FIX 3: trader_attestations
-- Was: "Service role can manage attestations" FOR ALL on {public} USING(true)
-- Fix: restrict to service_role only
-- Keep: "Anyone can view attestations" SELECT policy (public read is correct)
-- ============================================
DROP POLICY IF EXISTS "Service role can manage attestations" ON trader_attestations;
DROP POLICY IF EXISTS "trader_attestations_service_role_write" ON trader_attestations;

CREATE POLICY "trader_attestations_service_role_write" ON trader_attestations
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================
-- P0-SECURITY FIX 4: user_linked_traders
-- Was: "Service role full access linked traders" FOR ALL on {public} USING(true)
-- Fix: restrict to service_role only
-- Keep: per-user SELECT/INSERT/UPDATE/DELETE policies (correct)
-- ============================================
DROP POLICY IF EXISTS "Service role full access linked traders" ON user_linked_traders;
DROP POLICY IF EXISTS "user_linked_traders_service_role_only" ON user_linked_traders;

CREATE POLICY "user_linked_traders_service_role_only" ON user_linked_traders
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================
-- P1-REDUNDANT FIX: user_profiles — remove redundant SELECT policy
-- "Public can view basic profile info" USING(true) already allows everyone to SELECT.
-- "Users can view own full profile" USING(auth.uid() = id) is subsumed by it.
-- "Service role can read all profiles" USING(true) TO service_role is also redundant
--   since service_role bypasses RLS entirely.
-- Removing 2 redundant policies eliminates 2 unnecessary expression evaluations per row.
-- ============================================
DROP POLICY IF EXISTS "Users can view own full profile" ON user_profiles;
DROP POLICY IF EXISTS "Service role can read all profiles" ON user_profiles;

-- ============================================
-- P1-REDUNDANT FIX: traders_legacy — remove redundant SELECT policy
-- "Public read traders" USING(true) already covers all access.
-- "traders_read_authenticated" is redundant.
-- ============================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'traders_legacy' AND policyname = 'traders_read_authenticated') THEN
    EXECUTE 'DROP POLICY "traders_read_authenticated" ON traders_legacy';
  END IF;
END $$;

-- ============================================
-- P1-REDUNDANT FIX: user_levels — remove redundant SELECT policy
-- "public_read_levels" USING(true) already covers all access.
-- "users_read_own_level" USING(auth.uid() = user_id) is subsumed.
-- ============================================
DROP POLICY IF EXISTS "users_read_own_level" ON user_levels;

-- ============================================
-- P1-MISSING: leaderboard_ranks — add explicit service_role write policy
-- Currently only has public SELECT. service_role bypasses RLS anyway,
-- but explicit policy improves auditability.
-- ============================================
DROP POLICY IF EXISTS "leaderboard_ranks_service_role_write" ON leaderboard_ranks;

CREATE POLICY "leaderboard_ranks_service_role_write" ON leaderboard_ranks
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================
-- P1-MISSING: trader_daily_snapshots — add explicit service_role write policy
-- ============================================
DROP POLICY IF EXISTS "trader_daily_snapshots_service_role_write" ON trader_daily_snapshots;

CREATE POLICY "trader_daily_snapshots_service_role_write" ON trader_daily_snapshots
  FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- ============================================
-- P1-MISSING: leaderboard_count_cache — add policies (RLS enabled, 0 policies)
-- ============================================
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'leaderboard_count_cache' AND table_schema = 'public') THEN
    EXECUTE 'DROP POLICY IF EXISTS "leaderboard_count_cache_public_read" ON leaderboard_count_cache';
    EXECUTE 'CREATE POLICY "leaderboard_count_cache_public_read" ON leaderboard_count_cache FOR SELECT USING (true)';

    EXECUTE 'DROP POLICY IF EXISTS "leaderboard_count_cache_service_write" ON leaderboard_count_cache';
    EXECUTE 'CREATE POLICY "leaderboard_count_cache_service_write" ON leaderboard_count_cache FOR ALL TO service_role USING (true) WITH CHECK (true)';
  END IF;
END $$;

COMMIT;
