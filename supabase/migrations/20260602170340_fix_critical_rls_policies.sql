-- Migration: 20260602170340_fix_critical_rls_policies.sql
-- Created: 2026-06-03T00:03:40Z
-- Description: Fix 3 CRITICAL RLS vulnerabilities found in security audit
--
-- Finding 1: trader_claims "Service role can manage all claims" applies to public role (anyone)
-- Finding 2: verified_traders "Service role can manage verified traders" applies to public role
-- Finding 7: user_profiles UPDATE allows modifying is_pro, is_verified, counters

-- ── Fix 1: trader_claims — restrict to service_role only ──
DROP POLICY IF EXISTS "Service role can manage all claims" ON trader_claims;
CREATE POLICY "Service role can manage all claims" ON trader_claims
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Fix 2: verified_traders — restrict to service_role only ──
DROP POLICY IF EXISTS "Service role can manage verified traders" ON verified_traders;
CREATE POLICY "Service role can manage verified traders" ON verified_traders
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Fix 7: user_profiles UPDATE — block sensitive column modification ──
-- Drop the existing restricted update policy and re-create with expanded guards
DROP POLICY IF EXISTS "Users can update own profile (restricted)" ON user_profiles;
CREATE POLICY "Users can update own profile (restricted)" ON user_profiles
  FOR UPDATE USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    -- Block privilege escalation: these columns are managed by service_role only
    AND role IS NOT DISTINCT FROM (SELECT role FROM user_profiles WHERE id = auth.uid())
    AND subscription_tier IS NOT DISTINCT FROM (SELECT subscription_tier FROM user_profiles WHERE id = auth.uid())
    AND is_pro IS NOT DISTINCT FROM (SELECT is_pro FROM user_profiles WHERE id = auth.uid())
    AND is_verified IS NOT DISTINCT FROM (SELECT is_verified FROM user_profiles WHERE id = auth.uid())
    AND is_verified_trader IS NOT DISTINCT FROM (SELECT is_verified_trader FROM user_profiles WHERE id = auth.uid())
    AND kol_tier IS NOT DISTINCT FROM (SELECT kol_tier FROM user_profiles WHERE id = auth.uid())
    AND pro_plan IS NOT DISTINCT FROM (SELECT pro_plan FROM user_profiles WHERE id = auth.uid())
    AND pro_expires_at IS NOT DISTINCT FROM (SELECT pro_expires_at FROM user_profiles WHERE id = auth.uid())
    AND follower_count IS NOT DISTINCT FROM (SELECT follower_count FROM user_profiles WHERE id = auth.uid())
    AND following_count IS NOT DISTINCT FROM (SELECT following_count FROM user_profiles WHERE id = auth.uid())
    AND reputation_score IS NOT DISTINCT FROM (SELECT reputation_score FROM user_profiles WHERE id = auth.uid())
    AND exp IS NOT DISTINCT FROM (SELECT exp FROM user_profiles WHERE id = auth.uid())
    AND level IS NOT DISTINCT FROM (SELECT level FROM user_profiles WHERE id = auth.uid())
  );
