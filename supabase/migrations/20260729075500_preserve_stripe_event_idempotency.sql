-- Preserve the exact Stripe webhook event ledger permanently. Deleting a
-- processed event makes a later redelivery claimable again and can repeat
-- money or entitlement side effects. The ledger is deliberately append-only;
-- failed/processing rows remain mutable only through the leased RPC authority.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.stripe_events') IS NULL THEN
    RAISE EXCEPTION 'Stripe webhook event ledger is missing';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
  THEN
    RAISE EXCEPTION 'Stripe webhook event ledger roles are missing';
  END IF;
END
$preflight$;

LOCK TABLE public.stripe_events IN ACCESS EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS trg_cleanup_stripe_events
  ON public.stripe_events;
DROP FUNCTION IF EXISTS public.cleanup_old_stripe_events();

CREATE OR REPLACE FUNCTION public.reject_stripe_event_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'Stripe webhook event ledger is append-only'
    USING ERRCODE = '55000';
END
$function$;

ALTER FUNCTION public.reject_stripe_event_delete() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reject_stripe_event_delete()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

DROP TRIGGER IF EXISTS trg_reject_stripe_event_delete
  ON public.stripe_events;
CREATE TRIGGER trg_reject_stripe_event_delete
  BEFORE DELETE ON public.stripe_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.reject_stripe_event_delete();

REVOKE DELETE ON TABLE public.stripe_events
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

COMMENT ON TABLE public.stripe_events IS
  'Permanent append-only Stripe webhook idempotency ledger keyed by exact event and livemode identity.';
COMMENT ON FUNCTION public.reject_stripe_event_delete() IS
  'Rejects deletion so a previously processed Stripe event can never become claimable again.';

DO $postflight$
DECLARE
  v_guard_definition text;
BEGIN
  IF pg_catalog.to_regprocedure(
      'public.cleanup_old_stripe_events()'
    ) IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid =
          'public.stripe_events'::pg_catalog.regclass
        AND trigger_row.tgname = 'trg_cleanup_stripe_events'
        AND NOT trigger_row.tgisinternal
    )
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid =
          'public.stripe_events'::pg_catalog.regclass
        AND trigger_row.tgname = 'trg_reject_stripe_event_delete'
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
    )
    OR pg_catalog.has_table_privilege(
      'service_role',
      'public.stripe_events',
      'DELETE'
    )
    OR pg_catalog.has_table_privilege(
      'authenticated',
      'public.stripe_events',
      'DELETE'
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.reject_stripe_event_delete()',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      'public.reject_stripe_event_delete()',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION 'Stripe webhook event retention ACL drifted';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.reject_stripe_event_delete()'::pg_catalog.regprocedure
  ) INTO v_guard_definition;

  IF v_guard_definition NOT LIKE
      '%Stripe webhook event ledger is append-only%'
  THEN
    RAISE EXCEPTION 'Stripe webhook event deletion guard drifted';
  END IF;
END
$postflight$;

COMMIT;
