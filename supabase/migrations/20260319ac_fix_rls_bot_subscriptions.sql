-- Fix RLS on bot_subscriptions: was USING (true) with no role restriction (fully open).
-- Restrict to service_role only.

-- Drop the overly permissive open policy
DROP POLICY IF EXISTS "service_role_all" ON bot_subscriptions;

-- Recreate with TO service_role so only the service role can access this table
CREATE POLICY "bot_subscriptions_service_role_only" ON bot_subscriptions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
