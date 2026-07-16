-- Linked-trader identity is verified ownership state, not user-editable
-- profile data. Browser roles may read only the authenticated user's rows;
-- every mutation remains server-owned through service_role.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- This migration intentionally follows 20260715235000. Refuse to create a
-- partial boundary if either service-only mutation RPC is missing.
DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure('public.set_primary_linked_trader(uuid,uuid)') IS NULL
     OR pg_catalog.to_regprocedure('public.unlink_linked_trader(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'atomic linked-trader RPCs must exist before ACL hardening';
  END IF;
END
$preflight$;

ALTER TABLE public.user_linked_traders ENABLE ROW LEVEL SECURITY;

-- Remove Supabase's historical default ALL grants, including TRUNCATE and
-- policy-backed browser writes, then grant only the required capabilities.
REVOKE ALL PRIVILEGES ON TABLE public.user_linked_traders
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.user_linked_traders TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.user_linked_traders
  TO service_role;

-- Remove every policy name used by historical migrations so replaying this
-- migration converges on one explicit read policy and one service policy.
DROP POLICY IF EXISTS "Service role full access linked traders"
  ON public.user_linked_traders;
DROP POLICY IF EXISTS "user_linked_traders_service_role_all"
  ON public.user_linked_traders;
DROP POLICY IF EXISTS "user_linked_traders_service_role_only"
  ON public.user_linked_traders;
DROP POLICY IF EXISTS "Users can view own linked traders"
  ON public.user_linked_traders;
DROP POLICY IF EXISTS "Users can insert own linked traders"
  ON public.user_linked_traders;
DROP POLICY IF EXISTS "Users can update own linked traders"
  ON public.user_linked_traders;
DROP POLICY IF EXISTS "Users can delete own linked traders"
  ON public.user_linked_traders;
DROP POLICY IF EXISTS "Users manage own linked traders"
  ON public.user_linked_traders;
DROP POLICY IF EXISTS "Authenticated users can view own linked traders"
  ON public.user_linked_traders;
DROP POLICY IF EXISTS "Service role manages linked traders"
  ON public.user_linked_traders;

CREATE POLICY "Authenticated users can view own linked traders"
  ON public.user_linked_traders
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

-- service_role currently bypasses RLS. Keep an explicit policy as a second
-- boundary in case that role property changes.
CREATE POLICY "Service role manages linked traders"
  ON public.user_linked_traders
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON FUNCTION public.set_primary_linked_trader(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.unlink_linked_trader(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_primary_linked_trader(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.unlink_linked_trader(uuid, uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
