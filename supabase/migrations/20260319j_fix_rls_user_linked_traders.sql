-- Fix RLS on user_linked_traders: the service_role policy was missing TO service_role,
-- making it match any authenticated user (USING(true) without role restriction).

-- Drop the overly permissive catch-all service policy
DROP POLICY IF EXISTS "Service role full access linked traders" ON user_linked_traders;

-- Recreate with proper TO service_role restriction
CREATE POLICY "user_linked_traders_service_role_all" ON user_linked_traders
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
