-- Fix RLS on trader_position_history: the original migration (00002) created
-- INSERT and UPDATE policies with USING/WITH CHECK (true) and no role restriction,
-- allowing any authenticated user to write position history rows.
-- Drop those open policies and replace with service_role-only write policies.

-- Drop old unrestricted write policies
DROP POLICY IF EXISTS "Service insert trader_position_history" ON trader_position_history;
DROP POLICY IF EXISTS "Service update trader_position_history" ON trader_position_history;

-- Recreate with proper TO service_role restriction
CREATE POLICY "trader_position_history_insert_service_role" ON trader_position_history
  FOR INSERT
  TO service_role
  WITH CHECK (true);

CREATE POLICY "trader_position_history_update_service_role" ON trader_position_history
  FOR UPDATE
  TO service_role
  USING (true);

-- Also add explicit DELETE restriction (not in original, good to be explicit)
CREATE POLICY "trader_position_history_delete_service_role" ON trader_position_history
  FOR DELETE
  TO service_role
  USING (true);
