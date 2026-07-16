-- Trader claims and verified identities are approval state, not user-editable
-- profile data. Browser roles retain the reads required by the product while
-- every identity mutation remains server-owned through service_role.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Refuse to harden only half of the claim boundary. The service-only atomic
-- activation RPC must already exist before its backing tables are locked down.
DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.activate_trader_claim(uuid,uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION
      'atomic trader-claim activation must exist before identity ACL hardening';
  END IF;
END
$preflight$;

ALTER TABLE public.trader_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.verified_traders ENABLE ROW LEVEL SECURITY;

-- Remove Supabase's historical default ALL grants, including TRUNCATE,
-- REFERENCES, TRIGGER, and policy-backed browser writes. Grant back only the
-- product's explicit read contracts and service-owned CRUD capabilities.
REVOKE ALL PRIVILEGES ON TABLE public.trader_claims
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL PRIVILEGES ON TABLE public.verified_traders
  FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.trader_claims TO authenticated;
GRANT SELECT ON TABLE public.verified_traders TO anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.trader_claims, public.verified_traders
  TO service_role;

-- Remove every policy name used by historical migrations, plus the names
-- owned by this migration so replay converges on the same minimal boundary.
DROP POLICY IF EXISTS "Users can view their own claims"
  ON public.trader_claims;
DROP POLICY IF EXISTS "Users can insert their own claims"
  ON public.trader_claims;
DROP POLICY IF EXISTS "Users can delete their own pending claims"
  ON public.trader_claims;
DROP POLICY IF EXISTS "Service role can manage all claims"
  ON public.trader_claims;
DROP POLICY IF EXISTS "Authenticated users can view own trader claims"
  ON public.trader_claims;
DROP POLICY IF EXISTS "Service role manages trader claims"
  ON public.trader_claims;

DROP POLICY IF EXISTS "Anyone can view verified traders"
  ON public.verified_traders;
DROP POLICY IF EXISTS "Users can update their own verified profile"
  ON public.verified_traders;
DROP POLICY IF EXISTS "Service role can manage verified traders"
  ON public.verified_traders;
DROP POLICY IF EXISTS "Public can view verified traders"
  ON public.verified_traders;
DROP POLICY IF EXISTS "Service role manages verified traders"
  ON public.verified_traders;

CREATE POLICY "Authenticated users can view own trader claims"
  ON public.trader_claims
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING ((SELECT auth.uid()) = user_id);

CREATE POLICY "Public can view verified traders"
  ON public.verified_traders
  AS PERMISSIVE
  FOR SELECT
  TO anon, authenticated
  USING (true);

-- service_role currently bypasses RLS. Keep explicit policies as a second
-- boundary in case that role property changes.
CREATE POLICY "Service role manages trader claims"
  ON public.trader_claims
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role manages verified traders"
  ON public.verified_traders
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

REVOKE ALL ON FUNCTION public.activate_trader_claim(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_trader_claim(uuid, uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
