-- Migration: 20260409170117_security_block_anon_pii_on_user_profiles.sql
-- Created: 2026-04-10T00:01:17Z
-- Description: P0 SECURITY FIX — Block anonymous PII dump from user_profiles.
--
-- VULNERABILITY:
--   The policy "User profiles are viewable by everyone" ON user_profiles FOR SELECT USING (true)
--   allows anyone holding the public anon key (present in every browser bundle)
--   to curl-dump the ENTIRE user_profiles table via PostgREST, exposing:
--     - email, original_email             (PII)
--     - wallet_address                    (financial identity linkage)
--     - stripe_customer_id, stripe_subscription_id (Stripe internals)
--     - totp_secret, totp_enabled, backup codes    (2FA — catastrophic)
--     - banned_reason, banned_at, banned_by         (moderation data)
--     - utm_source/medium/campaign        (marketing attribution)
--     - search_history                    (behavioral PII)
--     - referred_by                       (social graph)
--     - deletion_reason, deletion_scheduled_at
--
--   Exploit:
--     curl "https://<project>.supabase.co/rest/v1/user_profiles?select=*" \
--          -H "apikey: <anon>" -H "Authorization: Bearer <anon>"
--
--   This was flagged in 20260401b2_security_rls_fixes.sql but the fix was
--   LEFT COMMENTED OUT. This migration completes that fix.
--
-- APPROACH:
--   - Keep the existing USING(true) SELECT policy so authenticated users
--     and existing code paths continue to work.
--   - REVOKE column-level SELECT on user_profiles from the anon role.
--   - GRANT column-level SELECT on a curated list of SAFE columns to anon.
--   - Any anon PostgREST request that touches a sensitive column
--     (or uses select=*) now returns 42501 "permission denied for column".
--   - The `authenticated` role retains full SELECT (used by user's own
--     profile reads, admin reads, stripe portal, etc.). Phase 2 should
--     tighten this further to restrict sensitive columns to
--     auth.uid() = id, likely via SECURITY DEFINER function.
--
-- SAFETY:
--   Verified via grep that ALL client-side user_profiles reads use explicit
--   column lists (no `select('*')`), and only touch safe columns
--   (handle, display_name, avatar_url, bio, cover_url, subscription_tier).
--   No client query reads email/wallet/stripe/totp as anon.
--
--   Reads of sensitive columns (email, wallet_address, stripe_customer_id,
--   totp_enabled) are all done server-side either through the service_role
--   client (stripe webhooks, admin routes) or through authenticated user
--   sessions reading their own profile. Both paths are unaffected.

BEGIN;

-- ============================================================================
-- 1. Revoke full-table SELECT from anon
-- ============================================================================
REVOKE SELECT ON public.user_profiles FROM anon;

-- ============================================================================
-- 2. Grant column-level SELECT on SAFE columns to anon.
--    Any column not in this list is private to anon callers.
--    Uses DO block to conditionally grant only columns that exist, so the
--    migration is safe against schema drift (columns added/removed over time).
-- ============================================================================
DO $$
DECLARE
  safe_cols text[] := ARRAY[
    -- Identity (public)
    'id', 'handle', 'display_name', 'bio', 'avatar_url', 'cover_url', 'uid', 'locale',
    -- Social stats (public)
    'follower_count', 'following_count', 'linked_trader_count', 'reputation_score',
    -- Verification badges (public)
    'is_verified', 'is_verified_trader', 'verified_at', 'kol_tier',
    -- Pro badge (public — needed to render Pro badge next to handle)
    'is_pro', 'show_pro_badge', 'pro_plan', 'pro_expires_at', 'subscription_tier',
    -- Presence (public for social features)
    'is_online', 'last_seen_at',
    -- Moderation badges (public — ban status shown on profile; banned_reason still private)
    'is_banned', 'banned_at', 'ban_expires_at',
    -- Account lifecycle (needed for filtering out deleted users)
    'deleted_at', 'created_at', 'updated_at',
    -- Gamification (public leaderboards)
    'credit_score', 'weight', 'exp', 'level', 'badge',
    -- Referral code (public — shareable)
    'referral_code',
    -- Claimed trader link (public — used for /u/[handle] meta + profile rendering)
    'trader_source', 'trader_source_id',
    -- Role (public — "admin" badge rendered next to handle)
    'role'
  ];
  col text;
BEGIN
  FOREACH col IN ARRAY safe_cols LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'user_profiles'
        AND column_name = col
    ) THEN
      EXECUTE format('GRANT SELECT (%I) ON public.user_profiles TO anon', col);
    END IF;
  END LOOP;
END $$;

-- ============================================================================
-- 3. Document the fix on the policy
-- ============================================================================
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname='public' AND tablename='user_profiles'
      AND policyname='User profiles are viewable by everyone'
  ) THEN
    COMMENT ON POLICY "User profiles are viewable by everyone" ON public.user_profiles IS
      'Row-level visibility is public (USING true), but column-level SELECT grants for the anon role are restricted (see migration 20260409170117). Anonymous callers cannot read email, wallet_address, stripe_customer_id, totp_secret, banned_reason, search_history, utm_*, referred_by, original_email, deletion_reason, or any other sensitive column. Authenticated role retains full column access pending phase 2.';
  END IF;
END $$;

COMMIT;

-- ============================================================================
-- VERIFICATION (run manually in Supabase SQL editor after deploy):
-- ============================================================================
-- 1) Confirm anon column grants are restricted:
--    SELECT column_name, privilege_type
--    FROM information_schema.column_privileges
--    WHERE table_name='user_profiles' AND grantee='anon'
--    ORDER BY column_name;
--
-- 2) Confirm anon cannot read email (should return permission denied):
--    SET ROLE anon;
--    SELECT email FROM user_profiles LIMIT 1;  -- expect error 42501
--    RESET ROLE;
--
-- 3) Confirm anon can still read safe columns:
--    SET ROLE anon;
--    SELECT id, handle, avatar_url FROM user_profiles LIMIT 1;  -- expect success
--    RESET ROLE;
--
-- 4) Confirm authenticated still works (no change):
--    SET ROLE authenticated;
--    SELECT email FROM user_profiles WHERE id = auth.uid();  -- still works
--    RESET ROLE;
