-- Migration: 20260519124947_api_tier_stripe_integration.sql
-- Add API tier subscription support to user_profiles.
-- Tracks Stripe subscription for B2B API tiers (Starter/Pro) independently
-- from the existing Pro membership subscription.

-- 1. Add API tier columns to user_profiles
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS api_tier text NOT NULL DEFAULT 'free'
    CHECK (api_tier IN ('free', 'starter', 'pro')),
  ADD COLUMN IF NOT EXISTS api_stripe_subscription_id text;

-- 2. RPC: Atomically upgrade/downgrade a user's API tier + all active keys
CREATE OR REPLACE FUNCTION update_user_api_tier(
  p_user_id uuid,
  p_api_tier text,
  p_stripe_subscription_id text,
  p_daily_limit integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Update user_profiles
  UPDATE user_profiles
  SET api_tier = p_api_tier,
      api_stripe_subscription_id = p_stripe_subscription_id,
      updated_at = now()
  WHERE id = p_user_id;

  -- Upgrade all active API keys for this user
  UPDATE api_keys
  SET tier = p_api_tier,
      daily_limit = p_daily_limit
  WHERE user_id = p_user_id
    AND active = true;
END;
$$;
