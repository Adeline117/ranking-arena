-- Migration: 20260701152254_notify_trader_events_pref.sql
-- Created: 2026-07-01T22:22:54Z
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Per-user opt-out for proactive trader-event broadcasts (big rank/ROI/PnL moves
-- of a trader you FOLLOW). Follows the existing notify_* boolean convention on
-- user_profiles (notify_follow/like/comment/mention/message). Default TRUE:
-- following a trader is an explicit signal you want their major updates; users
-- can opt out in Settings → Notifications.

-- Up
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS notify_trader_events boolean NOT NULL DEFAULT true;
