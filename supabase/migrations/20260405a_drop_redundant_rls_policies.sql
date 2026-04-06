-- Drop redundant SELECT policies on user_profiles, traders_legacy, and user_levels.
--
-- WHY: PostgreSQL evaluates ALL matching RLS policies with OR for the same command.
-- When a table has a USING(true) SELECT policy, it already grants read access to
-- everyone — any additional SELECT policies are subsumed and only add per-row
-- expression evaluation overhead. For high-traffic tables like user_profiles
-- (queried on every page load), this is wasted CPU.
--
-- The 20260403c migration attempted this cleanup but may have targeted policy names
-- that differed from what was actually in the database (policies created via SQL
-- editor don't always match migration-defined names). This migration uses DROP IF
-- EXISTS for all known variants to ensure cleanup regardless of naming.

BEGIN;

-- ============================================
-- user_profiles: keep only the USING(true) SELECT policy
-- Known USING(true) policies (one of these is the keeper):
--   "User profiles are viewable by everyone" (from 00001/00010 migrations)
--   "Public can view basic profile info" (possibly created via SQL editor)
-- Redundant policies to drop:
-- ============================================
DROP POLICY IF EXISTS "Users can view own full profile" ON user_profiles;
DROP POLICY IF EXISTS "Service role can read all profiles" ON user_profiles;
-- Also drop the original name if a renamed USING(true) policy replaced it,
-- leaving both the old and new name active:
DROP POLICY IF EXISTS "user_profiles_read_all" ON user_profiles;

-- ============================================
-- traders_legacy: keep only the USING(true) SELECT policy
-- "Public read traders" USING(true) already covers all access.
-- ============================================
DROP POLICY IF EXISTS "traders_read_authenticated" ON traders_legacy;
DROP POLICY IF EXISTS "traders_legacy_read_all" ON traders_legacy;

-- ============================================
-- user_levels: keep only the USING(true) SELECT policy
-- "public_read_levels" USING(true) already covers all access.
-- ============================================
DROP POLICY IF EXISTS "users_read_own_level" ON user_levels;

COMMIT;
