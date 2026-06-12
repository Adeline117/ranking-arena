-- Migration: 20260602223029_restrict_user_profiles_pii_columns.sql
-- Created: 2026-06-03T05:30:29Z
-- ⚠️ NEVER APPLIED TO PRODUCTION — superseded by 20260612135859_restrict_user_profiles_pii_v2.sql
--    (this version's GRANT list references columns that don't exist in prod:
--    display_name/exp/level/badge — applying it would fail. Kept for history only.)
-- Description: Restrict authenticated role from reading PII columns on user_profiles
--
-- CRITICAL SECURITY FIX: Any authenticated user could read email, wallet_address,
-- stripe_subscription_id, totp_secret, search_history etc. for ANY user via raw query.
-- The app only selects safe columns, but the RLS layer was wide open.
--
-- Approach: Column-level GRANT on authenticated role (same as anon from 20260409170117).
-- Users read their OWN sensitive data via get_own_profile() SECURITY DEFINER function.

-- Step 1: Revoke blanket SELECT from authenticated
REVOKE SELECT ON public.user_profiles FROM authenticated;

-- Step 2: Grant only safe (public-facing) columns to authenticated
GRANT SELECT (
  id, handle, display_name, bio, avatar_url, cover_url,
  follower_count, following_count, linked_trader_count,
  is_verified, is_verified_trader, verified_at, kol_tier,
  is_pro, show_pro_badge, subscription_tier,
  is_online, last_seen_at,
  is_banned, banned_at, ban_expires_at,
  created_at, updated_at,
  reputation_score, credit_score, weight, exp, level, badge,
  referral_code, role,
  -- Profile settings (public, needed for follow/DM logic)
  dm_permission, show_followers, show_following,
  -- Trader linking (public)
  verified_trader_id, verified_trader_source,
  -- Wallet address (public blockchain data, displayed in UI)
  wallet_address
) ON public.user_profiles TO authenticated;

-- Step 3: Keep INSERT/UPDATE/DELETE grants (already restricted by RLS policies)
-- authenticated role already has INSERT (for profile creation) and UPDATE (restricted by policy)
-- No change needed for write operations

-- Step 4: SECURITY DEFINER function for own-profile sensitive data reads
-- This is the ONLY way authenticated users can read their own PII
CREATE OR REPLACE FUNCTION get_own_profile_sensitive()
RETURNS TABLE(
  email text,
  original_email text,
  wallet_address text,
  stripe_subscription_id text,
  totp_enabled boolean,
  pro_plan text,
  pro_expires_at timestamptz,
  search_history jsonb,
  onboarding_completed boolean,
  notify_comment boolean,
  notify_follow boolean,
  notify_like boolean,
  notify_mention boolean,
  notify_message boolean,
  email_digest text,
  interests jsonb,
  market_pairs jsonb,
  settings_version int,
  utm_source text,
  utm_medium text,
  utm_campaign text
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT
    email, original_email, wallet_address, stripe_subscription_id,
    totp_enabled, pro_plan, pro_expires_at, search_history,
    onboarding_completed, notify_comment, notify_follow, notify_like,
    notify_mention, notify_message, email_digest, interests, market_pairs,
    settings_version, utm_source, utm_medium, utm_campaign
  FROM user_profiles
  WHERE id = auth.uid();
$$;

-- Grant execute to authenticated only (not anon)
GRANT EXECUTE ON FUNCTION get_own_profile_sensitive() TO authenticated;
