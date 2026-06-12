-- Migration: 20260612135859_restrict_user_profiles_pii_v2.sql
-- Created: 2026-06-12T20:58:59Z
-- Description: user_profiles PII 列级 SELECT 限制（修正版）+ get_own_profile_sensitive RPC
--
-- 取代 20260602223029（该迁移从未应用到生产：GRANT 列表引用了不存在的列
-- display_name/exp/level/badge，应用必然失败）。本版按 2026-06-12 实测生产
-- schema 修正列清单（display_name/exp/level/badge 移除；referral_code 等三列
-- 已由 20260612135727 补齐）。
--
-- 安全目标：authenticated 角色不得读取任意用户的 email、totp、订阅、
-- 搜索历史等 PII。自己的敏感数据走 SECURITY DEFINER RPC。
-- 客户端代码已全部迁移到 RPC-first 读取（同批 commit）。

-- Step 1: 收回 authenticated 的整表 SELECT
REVOKE SELECT ON public.user_profiles FROM authenticated;

-- Step 2: 仅授予公开（安全）列
GRANT SELECT (
  id, handle, bio, avatar_url, cover_url,
  follower_count, following_count, linked_trader_count,
  is_verified, is_verified_trader, verified_at, kol_tier,
  is_pro, show_pro_badge, subscription_tier,
  is_online, last_seen_at,
  is_banned, banned_at, ban_expires_at, deleted_at,
  created_at, updated_at,
  reputation_score, credit_score, weight,
  referral_code, role,
  dm_permission, show_followers, show_following,
  verified_trader_id, verified_trader_source,
  wallet_address
) ON public.user_profiles TO authenticated;

-- Step 3: 写权限不变（INSERT/UPDATE 由 RLS 策略约束）

-- Step 4: 本人敏感数据唯一读取通道
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

GRANT EXECUTE ON FUNCTION get_own_profile_sensitive() TO authenticated;
