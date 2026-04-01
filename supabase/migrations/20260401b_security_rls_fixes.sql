-- Security RLS Fixes (2026-04-01)
-- Fixes 4 critical RLS vulnerabilities found during security audit.
-- All executed directly via Supabase SQL editor.

-- P0-1: trader_claims — "Service role" policy had roles={public} (ANY user could CRUD all claims)
-- DROP POLICY IF EXISTS "Service role can manage all claims" ON trader_claims;
-- CREATE POLICY "Service role can manage all claims" ON trader_claims
--   FOR ALL TO service_role USING (true) WITH CHECK (true);

-- P0-2: verified_traders — same roles={public} bug (ANY user could insert/delete verified status)
-- DROP POLICY IF EXISTS "Service role can manage verified traders" ON verified_traders;
-- CREATE POLICY "Service role can manage verified traders" ON verified_traders
--   FOR ALL TO service_role USING (true) WITH CHECK (true);

-- P0-3: user_profiles — SELECT USING(true) exposed email, totp_secret, stripe_subscription_id
-- Created public_user_profiles view with safe columns only.
-- Frontend should migrate to use public_user_profiles for anonymous/public reads.
-- CREATE OR REPLACE VIEW public_user_profiles AS
--   SELECT id, handle, bio, avatar_url, cover_url, ...safe fields...
--   FROM user_profiles WHERE deleted_at IS NULL;

-- P0-4: feedback — INSERT with CHECK(true) for {public} role (anon spam vector)
-- DROP POLICY IF EXISTS "Users can insert feedback" ON feedback;
-- CREATE POLICY "Authenticated users can insert feedback" ON feedback
--   FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);
