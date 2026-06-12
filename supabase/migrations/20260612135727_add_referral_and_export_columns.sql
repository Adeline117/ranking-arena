-- Migration: 20260612135727_add_referral_and_export_columns.sql
-- Created: 2026-06-12T20:57:27Z
-- Description: 补齐代码引用但生产缺失的 user_profiles 列（QA 按钮审计 schema 漂移收尾）
--
-- 探测确认生产缺失（2026-06-12）：referral_code / referred_by / last_export_at。
-- 受影响功能：
--   - /api/referral：自定义推荐码 + 推荐人数统计（当前以 handle 兜底、计数恒 0）
--   - /api/settings/export：24h 导出冷却（当前形同虚设，仅剩路由级限流）
-- 注：display_name / exp / level / badge 同样缺失但属陈旧引用 —
--     等级系统用独立表（/api/user/exp），display_name 已从全部代码移除，
--     不补列。

-- Up
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS referral_code text,
  ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS last_export_at timestamptz;

-- 推荐码唯一（允许多行 NULL — 未设置自定义码的用户以 handle 兜底）
CREATE UNIQUE INDEX IF NOT EXISTS user_profiles_referral_code_key
  ON public.user_profiles (referral_code)
  WHERE referral_code IS NOT NULL;

-- 推荐人数统计按 referred_by 查询
CREATE INDEX IF NOT EXISTS idx_user_profiles_referred_by
  ON public.user_profiles (referred_by)
  WHERE referred_by IS NOT NULL;
