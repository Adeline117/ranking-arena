-- Migration: 20260630191318_referral_deferred_qualification.sql
-- Created: 2026-07-01T02:13:18Z
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Deferred, activity-based referral qualification.
--
-- Instead of granting Pro rewards at /api/referral/apply time (when a brand-new
-- account has no activity signal and could be a throwaway), attribution is
-- recorded immediately but rewards are DEFERRED: a cron
-- (/api/cron/qualify-referrals) later flips qualified_at once the referred
-- account crosses a real-activity bar (onboarding done + linked trader / min
-- account age). Only qualified referrals grant the friend trial and count toward
-- the advocate threshold — so throwaway/farm accounts never earn rewards.

-- Up
ALTER TABLE public.referral_attributions
  ADD COLUMN IF NOT EXISTS qualified_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_referral_attributions_unqualified
  ON public.referral_attributions (created_at)
  WHERE qualified_at IS NULL;
