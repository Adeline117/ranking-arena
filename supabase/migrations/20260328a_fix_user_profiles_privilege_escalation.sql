-- P0 Security Fix: Prevent user_profiles privilege escalation
--
-- CRITICAL VULNERABILITIES FIXED:
-- P0-1: Users could self-escalate to admin role by updating user_profiles.role
-- P0-3: Users could self-grant Pro subscription by updating user_profiles.subscription_tier
--
-- SOLUTION: Replace the overly permissive UPDATE policy with column-level restrictions.
-- Users can update their profile data (handle, bio, avatar_url, etc.) but NOT:
--   - role (admin-only via service_role)
--   - subscription_tier (service_role-only, managed by payment webhooks)
--
-- Date: 2026-03-28

-- ============================================
-- 1. Drop existing overly permissive UPDATE policy
-- ============================================

DROP POLICY IF EXISTS "Users can update their own profile" ON user_profiles;

-- ============================================
-- 2. Create restrictive UPDATE policy for regular users
--    Users can only update if role and subscription_tier remain unchanged
-- ============================================

CREATE POLICY "Users can update own profile (restricted columns)"
  ON user_profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    -- Prevent role escalation: new role must equal old role
    AND (
      role IS NOT DISTINCT FROM (
        SELECT up.role FROM user_profiles up WHERE up.id = auth.uid()
      )
    )
    -- Prevent subscription_tier self-modification: new tier must equal old tier
    AND (
      subscription_tier IS NOT DISTINCT FROM (
        SELECT up.subscription_tier FROM user_profiles up WHERE up.id = auth.uid()
      )
    )
  );

-- ============================================
-- 3. Create admin-only policy for role changes
--    Only service_role can modify the role column
-- ============================================

DROP POLICY IF EXISTS "Service role can update user roles" ON user_profiles;

CREATE POLICY "Service role can update user profiles"
  ON user_profiles FOR UPDATE
  USING (auth.role() = 'service_role');

-- ============================================
-- 4. Add comment to document the security fix
-- ============================================

COMMENT ON POLICY "Users can update own profile (restricted columns)" ON user_profiles IS
  'Security fix (2026-03-28): Prevents privilege escalation by blocking user modification of role and subscription_tier columns. Users can only update: handle, bio, avatar_url, email, and other non-privileged fields.';

-- ============================================
-- 5. Verify: List all policies on user_profiles
-- ============================================
-- Run this manually to verify:
-- SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'user_profiles';
