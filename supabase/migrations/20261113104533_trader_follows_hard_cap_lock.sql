-- Enforce the trader-follow hard cap inside the database.
--
-- /api/follow checks "count < limit" and then inserts, so two concurrent
-- follow requests could both pass the check (TOCTOU). The INSERT RLS policy
-- also lets an authenticated user insert into public.trader_follows directly
-- through PostgREST, skipping the route's check entirely.
--
-- This BEFORE INSERT trigger serializes inserts per user with a transaction
-- advisory lock and rejects a new follow once the user already follows
-- trader_follows_max_per_user() accounts. The cap is the highest tier limit
-- (Pro/Elite = 100); the per-tier free limit stays in the route because the
-- Pro free promo is an application flag the database cannot see.
--
-- A duplicate (user, trader, source) row is passed through so the existing
-- unique constraint still raises 23505, which the route treats as "already
-- following" even when the user is at the cap.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.trader_follows') IS NULL THEN
    RAISE EXCEPTION 'public.trader_follows is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.trader_follows'::pg_catalog.regclass
      AND attribute.attname = 'source'
      AND attribute.atttypid = 'text'::pg_catalog.regtype
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'public.trader_follows.source text is required';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.trader_follows_max_per_user()
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT 100
$$;

CREATE OR REPLACE FUNCTION public.enforce_trader_follow_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_count integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('public.trader_follows:cap'),
    pg_catalog.hashtext(NEW.user_id::text)
  );

  IF EXISTS (
    SELECT 1
    FROM public.trader_follows AS follow
    WHERE follow.user_id = NEW.user_id
      AND follow.trader_id = NEW.trader_id
      AND follow.source IS NOT DISTINCT FROM NEW.source
  ) THEN
    RETURN NEW;
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_count
  FROM public.trader_follows AS follow
  WHERE follow.user_id = NEW.user_id;

  IF v_count >= public.trader_follows_max_per_user() THEN
    RAISE EXCEPTION 'FOLLOW_LIMIT'
      USING ERRCODE = 'check_violation',
            DETAIL = pg_catalog.format('user already follows %s accounts', v_count);
  END IF;

  RETURN NEW;
END
$$;

REVOKE ALL ON FUNCTION public.enforce_trader_follow_cap() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trader_follows_max_per_user() FROM PUBLIC;

DROP TRIGGER IF EXISTS trader_follows_enforce_cap ON public.trader_follows;
CREATE TRIGGER trader_follows_enforce_cap
  BEFORE INSERT ON public.trader_follows
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_trader_follow_cap();

COMMIT;
