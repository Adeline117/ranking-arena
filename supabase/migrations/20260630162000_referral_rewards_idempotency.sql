-- Migration: 20260630162000_referral_rewards_idempotency.sql
-- Created: 2026-06-30T23:20:00Z
-- Persistent idempotency marker for referral rewards.
--
-- Root cause this fixes: the advocate (referrer) Pro-extension grant in
-- /api/referral/apply fired on `totalReferrals === THRESHOLD` after a
-- non-transactional count. Under concurrent friend signups two requests can
-- both observe the threshold (double-granting Pro = a real billing/cost leak),
-- or the exact Nth count can be skipped entirely (reward silently missed).
--
-- This table gives each one-time reward a UNIQUE (referrer_id, reward_type)
-- marker. The apply route inserts the marker with ON CONFLICT DO NOTHING BEFORE
-- granting; only the insert that actually created the row performs the grant.
-- This makes the advocate reward exactly-once regardless of race ordering, so
-- the route can safely use `>= THRESHOLD` (fires even if the exact Nth count is
-- skipped) without any risk of double-granting.

-- Up
CREATE TABLE IF NOT EXISTS public.referral_rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  reward_type text NOT NULL,
  granted_days integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT referral_rewards_unique_marker UNIQUE (referrer_id, reward_type)
);

CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer
  ON public.referral_rewards (referrer_id);

-- RLS: server-only bookkeeping table written exclusively by the service-role
-- apply route. Owners may read their own markers; all writes go through the
-- service role, which bypasses RLS.
ALTER TABLE public.referral_rewards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "referral_rewards_select_own" ON public.referral_rewards;
CREATE POLICY "referral_rewards_select_own" ON public.referral_rewards
  FOR SELECT
  USING (auth.uid() = referrer_id);
