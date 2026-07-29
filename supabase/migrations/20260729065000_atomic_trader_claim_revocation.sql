-- Unlinking a trader is ownership revocation, not a cosmetic list mutation.
-- Revoke every projection created by activate_trader_claim in one transaction
-- so profile editing, credentials, and claimed badges cannot survive unlink.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('trader-claim-revocation-migration', 0)
);

DO $preflight$
DECLARE
  v_role text;
  v_relation text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY[
    'postgres',
    'anon',
    'authenticated',
    'service_role'
  ]::text[]
  LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'required claim-revocation role is missing: %', v_role;
    END IF;
  END LOOP;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.trader_claims',
    'public.verified_traders',
    'public.user_linked_traders',
    'public.user_profiles',
    'public.trader_authorizations',
    'public.user_exchange_connections'
  ]::text[]
  LOOP
    IF pg_catalog.to_regclass(v_relation) IS NULL THEN
      RAISE EXCEPTION 'required claim-revocation relation is missing: %', v_relation;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure(
       'public.activate_trader_claim(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.unlink_linked_trader(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_set_trader_claimed(text,text,uuid,boolean)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.guard_trader_claim_activation_expiry()'
     ) IS NULL THEN
    RAISE EXCEPTION 'atomic claim activation and unlink foundations are incomplete';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.user_linked_traders AS linked
    JOIN public.verified_traders AS verified
      ON verified.trader_id = linked.trader_id
     AND verified.source = linked.source
    WHERE verified.user_id IS DISTINCT FROM linked.user_id
  ) OR EXISTS (
    SELECT 1
    FROM public.user_linked_traders AS linked
    JOIN public.trader_claims AS claim
      ON claim.trader_id = linked.trader_id
     AND claim.source = linked.source
     AND claim.status IN ('pending', 'reviewing', 'verified')
    WHERE claim.user_id IS DISTINCT FROM linked.user_id
       OR claim.status IS DISTINCT FROM 'verified'
  ) THEN
    RAISE EXCEPTION 'linked trader ownership projections are ambiguous';
  END IF;
END
$preflight$;

LOCK TABLE
  public.trader_claims,
  public.verified_traders,
  public.user_linked_traders
IN SHARE ROW EXCLUSIVE MODE;

-- A link is already verified ownership authority. Repair older links that
-- predate the atomic activation RPC without guessing across conflicting users.
INSERT INTO public.verified_traders (
  user_id,
  trader_id,
  source,
  verified_at,
  verification_method,
  is_primary,
  created_at,
  updated_at
)
SELECT
  linked.user_id,
  linked.trader_id,
  linked.source,
  linked.verified_at,
  linked.verification_method,
  linked.is_primary IS TRUE,
  COALESCE(linked.created_at, linked.verified_at),
  COALESCE(linked.updated_at, linked.verified_at)
FROM public.user_linked_traders AS linked
WHERE NOT EXISTS (
  SELECT 1
  FROM public.verified_traders AS verified
  WHERE verified.trader_id = linked.trader_id
    AND verified.source = linked.source
);

INSERT INTO public.trader_claims (
  user_id,
  trader_id,
  source,
  verification_method,
  verification_data,
  status,
  verified_at,
  created_at,
  updated_at
)
SELECT
  linked.user_id,
  linked.trader_id,
  linked.source,
  linked.verification_method,
  '{}'::jsonb,
  'verified',
  linked.verified_at,
  COALESCE(linked.created_at, linked.verified_at),
  COALESCE(linked.updated_at, linked.verified_at)
FROM public.user_linked_traders AS linked
WHERE NOT EXISTS (
  SELECT 1
  FROM public.trader_claims AS claim
  WHERE claim.trader_id = linked.trader_id
    AND claim.source = linked.source
    AND claim.status IN ('pending', 'reviewing', 'verified')
);

DO $repair_proof$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.user_linked_traders AS linked
    LEFT JOIN public.verified_traders AS verified
      ON verified.user_id = linked.user_id
     AND verified.trader_id = linked.trader_id
     AND verified.source = linked.source
    LEFT JOIN public.trader_claims AS claim
      ON claim.user_id = linked.user_id
     AND claim.trader_id = linked.trader_id
     AND claim.source = linked.source
     AND claim.status = 'verified'
    WHERE verified.id IS NULL
       OR claim.id IS NULL
  ) THEN
    RAISE EXCEPTION 'linked trader projection repair was incomplete';
  END IF;
END
$repair_proof$;

ALTER TABLE public.trader_claims
  DROP CONSTRAINT IF EXISTS trader_claims_status_check;
ALTER TABLE public.trader_claims
  ADD CONSTRAINT trader_claims_status_check
  CHECK (
    status IN (
      'pending',
      'reviewing',
      'verified',
      'rejected',
      'expired',
      'revoked'
    )
  ) NOT VALID;
ALTER TABLE public.trader_claims
  VALIDATE CONSTRAINT trader_claims_status_check;

CREATE OR REPLACE FUNCTION public.guard_trader_claim_activation_expiry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.status = 'verified'
     AND OLD.status IS DISTINCT FROM 'verified'
     AND (
       OLD.status IN ('rejected', 'expired', 'revoked')
       OR (
         OLD.status IN ('pending', 'reviewing')
         AND OLD.created_at
               < pg_catalog.statement_timestamp()
                   - pg_catalog.make_interval(days => 30)
       )
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'trader claim is no longer reviewable';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.unlink_linked_trader(
  p_user_id uuid,
  p_link_id uuid
)
RETURNS TABLE (
  remaining_count integer,
  removed_trader_id text,
  removed_source text,
  promoted_link_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_snapshot public.user_linked_traders%ROWTYPE;
  v_existing public.user_linked_traders%ROWTYPE;
  v_verified public.verified_traders%ROWTYPE;
  v_claim public.trader_claims%ROWTYPE;
  v_primary public.user_linked_traders%ROWTYPE;
  v_remaining_count integer;
  v_promoted_link_id uuid;
  v_connection_exchange text;
  v_arena_trader_id bigint;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_user_id IS NULL OR p_link_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'user id and linked trader id are required';
  END IF;

  -- Read only enough identity to acquire locks in the same order as claim
  -- activation: claim row, user namespace, identity namespace, linked row.
  SELECT linked.*
  INTO v_snapshot
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'linked trader not found';
  END IF;

  SELECT claim.*
  INTO v_claim
  FROM public.trader_claims AS claim
  WHERE claim.trader_id = v_snapshot.trader_id
    AND claim.source = v_snapshot.source
    AND claim.status IN ('pending', 'reviewing', 'verified')
  FOR UPDATE;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('linked-trader:' || p_user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'trader-claim:' || v_snapshot.source || ':' || v_snapshot.trader_id,
      0
    )
  );

  SELECT linked.*
  INTO v_existing
  FROM public.user_linked_traders AS linked
  WHERE linked.id = p_link_id
    AND linked.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'linked trader not found';
  END IF;
  IF v_existing.trader_id IS DISTINCT FROM v_snapshot.trader_id
     OR v_existing.source IS DISTINCT FROM v_snapshot.source THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'linked trader identity changed during revocation';
  END IF;

  IF v_claim.id IS NULL
     OR v_claim.user_id IS DISTINCT FROM p_user_id
     OR v_claim.status IS DISTINCT FROM 'verified' THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'verified trader claim projection not found';
  END IF;

  SELECT verified.*
  INTO v_verified
  FROM public.verified_traders AS verified
  WHERE verified.trader_id = v_existing.trader_id
    AND verified.source = v_existing.source
  FOR UPDATE;

  IF NOT FOUND OR v_verified.user_id IS DISTINCT FROM p_user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'verified trader ownership projection not found';
  END IF;

  DELETE FROM public.user_linked_traders AS linked
  WHERE linked.id = v_existing.id
    AND linked.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'linked trader disappeared during revocation';
  END IF;

  DELETE FROM public.verified_traders AS verified
  WHERE verified.id = v_verified.id
    AND verified.user_id = p_user_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'verified trader disappeared during revocation';
  END IF;

  UPDATE public.trader_claims AS claim
  SET status = 'revoked',
      reject_reason = NULL,
      updated_at = v_now
  WHERE claim.id = v_claim.id
    AND claim.user_id = p_user_id
    AND claim.status = 'verified';
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'verified trader claim disappeared during revocation';
  END IF;

  UPDATE public.trader_authorizations AS authorization_row
  SET status = 'revoked',
      verification_error = 'Trader account unlinked by owner',
      updated_at = v_now
  WHERE authorization_row.user_id = p_user_id
    AND authorization_row.platform = v_existing.source
    AND authorization_row.trader_id = v_existing.trader_id
    AND authorization_row.status IS DISTINCT FROM 'revoked';

  v_connection_exchange := pg_catalog.regexp_replace(
    pg_catalog.lower(v_existing.source),
    '_(futures|spot)$',
    ''
  );

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_linked_traders AS remaining
    WHERE remaining.user_id = p_user_id
      AND remaining.trader_id = v_existing.trader_id
      AND pg_catalog.regexp_replace(
            pg_catalog.lower(remaining.source),
            '_(futures|spot)$',
            ''
          ) = v_connection_exchange
  ) THEN
    UPDATE public.user_exchange_connections AS connection
    SET is_active = false,
        updated_at = v_now
    WHERE connection.user_id = p_user_id
      AND connection.exchange = v_connection_exchange
      AND connection.verified_uid = v_existing.trader_id
      AND connection.is_active IS TRUE;
  END IF;

  v_arena_trader_id := public.arena_set_trader_claimed(
    v_existing.source,
    v_existing.trader_id,
    p_user_id,
    false
  );
  IF v_arena_trader_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'Arena trader claim projection was not revoked';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_remaining_count
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = p_user_id;

  IF v_remaining_count = 0 THEN
    UPDATE public.user_profiles AS profile
    SET is_verified_trader = false,
        verified_trader_id = NULL,
        verified_trader_source = NULL,
        linked_trader_count = 0,
        updated_at = v_now
    WHERE profile.id = p_user_id;
  ELSE
    SELECT linked.*
    INTO v_primary
    FROM public.user_linked_traders AS linked
    WHERE linked.user_id = p_user_id
      AND linked.is_primary IS TRUE
    ORDER BY linked.display_order ASC NULLS LAST,
             linked.created_at ASC NULLS LAST,
             linked.id ASC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
      SELECT linked.*
      INTO STRICT v_primary
      FROM public.user_linked_traders AS linked
      WHERE linked.user_id = p_user_id
      ORDER BY linked.display_order ASC NULLS LAST,
               linked.created_at ASC NULLS LAST,
               linked.id ASC
      LIMIT 1
      FOR UPDATE;

      UPDATE public.user_linked_traders AS linked
      SET is_primary = true,
          updated_at = v_now
      WHERE linked.id = v_primary.id;
      v_promoted_link_id := v_primary.id;
    END IF;

    UPDATE public.verified_traders AS verified
    SET is_primary = (
          verified.trader_id = v_primary.trader_id
          AND verified.source = v_primary.source
        ),
        updated_at = v_now
    WHERE verified.user_id = p_user_id;

    UPDATE public.user_profiles AS profile
    SET is_verified_trader = true,
        verified_trader_id = v_primary.trader_id,
        verified_trader_source = v_primary.source,
        linked_trader_count = v_remaining_count,
        updated_at = v_now
    WHERE profile.id = p_user_id;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'user profile not found';
  END IF;

  RETURN QUERY
  SELECT
    v_remaining_count,
    v_existing.trader_id,
    v_existing.source,
    v_promoted_link_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.unlink_linked_trader(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unlink_linked_trader(uuid, uuid)
  TO service_role;
REVOKE ALL ON FUNCTION public.guard_trader_claim_activation_expiry()
  FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.unlink_linked_trader(uuid, uuid) IS
  'Service-only atomic revocation of linked identity, verified profile, claim, credentials, Arena marker, and primary profile projection.';

DO $postflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.trader_claims'::pg_catalog.regclass
      AND constraint_row.conname = 'trader_claims_status_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.strpos(
            pg_catalog.pg_get_constraintdef(constraint_row.oid),
            'revoked'
          ) > 0
  ) THEN
    RAISE EXCEPTION 'revoked trader-claim terminal status is unavailable';
  END IF;

  IF pg_catalog.has_function_privilege(
       'authenticated',
       'public.unlink_linked_trader(uuid,uuid)',
       'EXECUTE'
     )
     OR NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.unlink_linked_trader(uuid,uuid)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'trader claim revocation privilege boundary is incorrect';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
