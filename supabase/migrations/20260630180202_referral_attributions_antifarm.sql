-- Migration: 20260630180202_referral_attributions_antifarm.sql
-- Created: 2026-07-01T01:02:02Z
-- Description: TODO — explain what this migration does and why

-- Concurrency Safety Checklist (delete after reviewing):
-- [ ] New tables with one-per-user rows: add UNIQUE or partial unique index
-- [ ] Counter columns: use atomic RPC (lib 00021), NOT trigger-based count+1
-- [ ] Check-then-act patterns: use pg_advisory_xact_lock or SELECT FOR UPDATE
-- [ ] FK to parent: include ON DELETE CASCADE
-- [ ] New functions: add SET search_path = public, SECURITY DEFINER if needed
-- [ ] 应用后跑 npm run qa:schema 核对落地 —— "写进仓库 ≠ 应用到生产"(2026-06 漂移教训)

-- Anti-farming substrate for referral rewards.
--
-- Root problem: email_confirmed_at is NOT a usable gate (wallet/SIWE users get a
-- synthetic `<addr>@wallet.arena` auto-confirmed email; email/OAuth are already
-- confirmed before /api/referral/apply runs). So the real farming vector — one
-- attacker spinning up N throwaway accounts, each applying advocate A's code to
-- collect N friend trials + push A over the advocate threshold — cannot be
-- stopped by verification status.
--
-- This table records one row per attributed referral with a hashed signup
-- device fingerprint (from getIdentifier's IP+UA bucket → sha256, no raw IP/PII
-- stored). The apply route uses it to (a) cap friend-trial grants per device and
-- (b) count the advocate threshold by DISTINCT device, so a same-device farm
-- collapses to one. Service-role write only; no client policies (default deny).

-- Up
CREATE TABLE IF NOT EXISTS public.referral_attributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referred_id uuid NOT NULL UNIQUE REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  referrer_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  provider text,
  signup_ip_hash text,
  friend_granted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_referral_attributions_referrer
  ON public.referral_attributions (referrer_id);
CREATE INDEX IF NOT EXISTS idx_referral_attributions_ip_hash
  ON public.referral_attributions (signup_ip_hash);

ALTER TABLE public.referral_attributions ENABLE ROW LEVEL SECURITY;
-- No client policies: this is server-only bookkeeping written exclusively by the
-- service-role apply route. Default-deny for all other roles.
