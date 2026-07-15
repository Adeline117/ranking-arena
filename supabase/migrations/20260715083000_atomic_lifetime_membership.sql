-- A paid lifetime checkout must never update the subscription record and
-- profile entitlement in separate transactions. Either both facts commit or
-- neither does, allowing the Stripe webhook/session verification to retry.

CREATE OR REPLACE FUNCTION public.activate_lifetime_membership(
  p_user_id uuid,
  p_stripe_customer_id text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.subscriptions (
    user_id,
    stripe_customer_id,
    stripe_subscription_id,
    status,
    tier,
    plan,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    updated_at
  ) VALUES (
    p_user_id,
    p_stripe_customer_id,
    'lifetime_' || p_user_id::text,
    'active',
    'pro',
    'lifetime',
    now(),
    NULL,
    false,
    now()
  )
  ON CONFLICT (user_id) DO UPDATE
  SET stripe_customer_id = EXCLUDED.stripe_customer_id,
      stripe_subscription_id = EXCLUDED.stripe_subscription_id,
      status = EXCLUDED.status,
      tier = EXCLUDED.tier,
      plan = EXCLUDED.plan,
      current_period_start = EXCLUDED.current_period_start,
      current_period_end = NULL,
      cancel_at_period_end = false,
      canceled_at = NULL,
      updated_at = now();

  UPDATE public.user_profiles
  SET subscription_tier = 'pro',
      pro_plan = 'lifetime',
      stripe_customer_id = p_stripe_customer_id,
      updated_at = now()
  WHERE id = p_user_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'active user profile not found';
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.activate_lifetime_membership(uuid, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_lifetime_membership(uuid, text) TO service_role;

COMMENT ON FUNCTION public.activate_lifetime_membership(uuid, text) IS
  'Atomically persists a paid lifetime subscription and its profile entitlement.';
