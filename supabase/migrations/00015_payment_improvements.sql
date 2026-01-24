-- Migration: Payment Improvements
-- Adds transactional subscription update RPC and tip idempotency support

-- Transactional function to update both subscription and profile atomically
CREATE OR REPLACE FUNCTION update_subscription_and_profile(
  p_user_id uuid,
  p_tier text,
  p_status text,
  p_stripe_sub_id text,
  p_stripe_customer_id text,
  p_plan text,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_cancel_at_period_end boolean DEFAULT false
) RETURNS void AS $$
BEGIN
  -- Upsert subscription record
  INSERT INTO subscriptions (
    user_id, stripe_subscription_id, stripe_customer_id,
    status, tier, plan, current_period_start, current_period_end,
    cancel_at_period_end, updated_at
  ) VALUES (
    p_user_id, p_stripe_sub_id, p_stripe_customer_id,
    p_status, p_tier, p_plan, p_period_start, p_period_end,
    p_cancel_at_period_end, now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    stripe_subscription_id = EXCLUDED.stripe_subscription_id,
    stripe_customer_id = EXCLUDED.stripe_customer_id,
    status = EXCLUDED.status,
    tier = EXCLUDED.tier,
    plan = EXCLUDED.plan,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end = EXCLUDED.current_period_end,
    cancel_at_period_end = EXCLUDED.cancel_at_period_end,
    updated_at = now();

  -- Update user profile tier
  UPDATE user_profiles SET
    subscription_tier = CASE
      WHEN p_status IN ('active', 'trialing') THEN 'pro'
      ELSE 'free'
    END,
    stripe_customer_id = p_stripe_customer_id,
    updated_at = now()
  WHERE id = p_user_id;
END;
$$ LANGUAGE plpgsql;

-- Tip idempotency: add index for checking recent pending tips
CREATE INDEX IF NOT EXISTS idx_tips_idempotency
  ON tips(from_user_id, post_id, amount_cents, status)
  WHERE status = 'pending';
