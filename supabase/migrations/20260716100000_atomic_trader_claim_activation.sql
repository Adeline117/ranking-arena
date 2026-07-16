-- Activate every projection of an approved trader claim in one transaction.
-- A claim must never become verified while its linked identity, profile,
-- first-party authorization, or Arena claimed marker is missing.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Fail closed when this migration is replayed before its identity and
-- first-party foundations. PL/pgSQL resolves table references lazily, so an
-- explicit preflight is required to prevent a partially usable RPC boundary.
DO $preflight$
BEGIN
  IF pg_catalog.to_regprocedure(
       'public.set_primary_linked_trader(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.unlink_linked_trader(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.arena_set_trader_claimed(text,text,uuid,boolean)'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'public.user_linked_traders_one_primary_per_user'
     ) IS NULL THEN
    RAISE EXCEPTION
      'atomic linked-trader and Arena claimed foundations must exist before claim activation';
  END IF;

  IF NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'user_exchange_connections'
         AND column_name = 'scope_permissions'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'user_exchange_connections'
         AND column_name = 'verified_uid'
     )
     OR NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'trader_authorizations'
         AND column_name = 'read_only_verified_at'
     ) THEN
    RAISE EXCEPTION
      'verified-data connection columns must exist before claim activation';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.activate_trader_claim(
  p_claim_id uuid,
  p_reviewer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_claim public.trader_claims%ROWTYPE;
  v_verified public.verified_traders%ROWTYPE;
  v_link public.user_linked_traders%ROWTYPE;
  v_primary public.user_linked_traders%ROWTYPE;
  v_connection public.user_exchange_connections%ROWTYPE;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_linked_count integer;
  v_next_display_order integer;
  v_connection_exchange text;
  v_authorization_id uuid;
  v_arena_trader_id bigint;
BEGIN
  IF p_claim_id IS NULL OR p_reviewer_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'claim id and reviewer id are required';
  END IF;

  -- Lock the review record before inspecting status. A concurrent reject or
  -- approval must observe the final committed state, never an intermediate
  -- projection.
  SELECT claim.*
  INTO v_claim
  FROM public.trader_claims AS claim
  WHERE claim.id = p_claim_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'trader claim not found';
  END IF;

  IF v_claim.status = 'rejected' THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'rejected trader claim cannot be activated';
  END IF;

  IF v_claim.status NOT IN ('pending', 'reviewing', 'verified') THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'trader claim status cannot be activated';
  END IF;

  -- Share the exact per-user lock namespace with set-primary and unlink, then
  -- serialize the claimed trader identity across different users as well.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('linked-trader:' || v_claim.user_id::text, 0)
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'trader-claim:' || v_claim.source || ':' || v_claim.trader_id,
      0
    )
  );

  -- A unique violation is not automatically idempotent: an existing identity
  -- owned by somebody else is a hard ownership conflict.
  SELECT verified.*
  INTO v_verified
  FROM public.verified_traders AS verified
  WHERE verified.trader_id = v_claim.trader_id
    AND verified.source = v_claim.source
  FOR UPDATE;

  IF FOUND AND v_verified.user_id <> v_claim.user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'trader identity is already verified by another user';
  END IF;

  IF FOUND THEN
    UPDATE public.verified_traders AS verified
    SET verification_method = v_claim.verification_method,
        verified_at = COALESCE(verified.verified_at, v_now),
        updated_at = v_now
    WHERE verified.id = v_verified.id
    RETURNING verified.* INTO STRICT v_verified;
  ELSE
    INSERT INTO public.verified_traders (
      user_id,
      trader_id,
      source,
      verified_at,
      verification_method,
      is_primary
    ) VALUES (
      v_claim.user_id,
      v_claim.trader_id,
      v_claim.source,
      v_now,
      v_claim.verification_method,
      false
    )
    RETURNING * INTO STRICT v_verified;
  END IF;

  SELECT linked.*
  INTO v_link
  FROM public.user_linked_traders AS linked
  WHERE linked.trader_id = v_claim.trader_id
    AND linked.source = v_claim.source
  FOR UPDATE;

  IF FOUND AND v_link.user_id <> v_claim.user_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '23505',
      MESSAGE = 'trader identity is already linked to another user';
  END IF;

  IF FOUND THEN
    UPDATE public.user_linked_traders AS linked
    SET verification_method = v_claim.verification_method,
        verified_at = COALESCE(linked.verified_at, v_now),
        updated_at = v_now
    WHERE linked.id = v_link.id
    RETURNING linked.* INTO STRICT v_link;
  ELSE
    SELECT
      pg_catalog.count(*)::integer,
      COALESCE(pg_catalog.max(linked.display_order), -1) + 1
    INTO v_linked_count, v_next_display_order
    FROM public.user_linked_traders AS linked
    WHERE linked.user_id = v_claim.user_id;

    INSERT INTO public.user_linked_traders (
      user_id,
      trader_id,
      source,
      is_primary,
      display_order,
      verified_at,
      verification_method
    ) VALUES (
      v_claim.user_id,
      v_claim.trader_id,
      v_claim.source,
      v_linked_count = 0,
      v_next_display_order,
      v_now,
      v_claim.verification_method
    )
    RETURNING * INTO STRICT v_link;
  END IF;

  -- Preserve an existing primary. Historical zero-primary drift is repaired
  -- deterministically without trusting application array order.
  SELECT linked.*
  INTO v_primary
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = v_claim.user_id
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
    WHERE linked.user_id = v_claim.user_id
    ORDER BY linked.display_order ASC NULLS LAST,
             linked.created_at ASC NULLS LAST,
             linked.id ASC
    LIMIT 1
    FOR UPDATE;

    UPDATE public.user_linked_traders AS linked
    SET is_primary = true,
        updated_at = v_now
    WHERE linked.id = v_primary.id
    RETURNING linked.* INTO STRICT v_primary;
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_linked_count
  FROM public.user_linked_traders AS linked
  WHERE linked.user_id = v_claim.user_id;

  UPDATE public.verified_traders AS verified
  SET is_primary = (
        verified.trader_id = v_primary.trader_id
        AND verified.source = v_primary.source
      ),
      updated_at = v_now
  WHERE verified.user_id = v_claim.user_id;

  UPDATE public.user_profiles AS profile
  SET is_verified_trader = true,
      verified_trader_id = v_primary.trader_id,
      verified_trader_source = v_primary.source,
      linked_trader_count = v_linked_count,
      updated_at = v_now
  WHERE profile.id = v_claim.user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'user profile not found';
  END IF;

  -- scope_permissions is written only after the exchange reports a read-only
  -- key. Re-check the verified UID here before copying credentials into the
  -- first-party authorization projection.
  IF v_claim.verification_method = 'api_key' THEN
    v_connection_exchange := pg_catalog.regexp_replace(
      pg_catalog.lower(v_claim.source),
      '_(futures|spot)$',
      ''
    );

    SELECT connection.*
    INTO v_connection
    FROM public.user_exchange_connections AS connection
    WHERE connection.user_id = v_claim.user_id
      AND connection.exchange = v_connection_exchange
      AND connection.is_active IS TRUE
      AND connection.verified_uid = v_claim.trader_id
      AND connection.last_verified_at IS NOT NULL
      AND pg_catalog.btrim(connection.api_key_encrypted) <> ''
      AND pg_catalog.btrim(connection.api_secret_encrypted) <> ''
      AND pg_catalog.jsonb_typeof(connection.scope_permissions) = 'array'
      AND pg_catalog.jsonb_array_length(connection.scope_permissions) > 0
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'verified read-only exchange connection not found';
    END IF;

    INSERT INTO public.trader_authorizations AS existing_authorization (
      user_id,
      platform,
      trader_id,
      encrypted_api_key,
      encrypted_api_secret,
      encrypted_passphrase,
      permissions,
      read_only_verified_at,
      status,
      last_verified_at,
      last_sync_at,
      last_sync_status,
      consecutive_failures,
      verification_error,
      sync_frequency,
      updated_at
    ) VALUES (
      v_claim.user_id,
      v_claim.source,
      v_claim.trader_id,
      v_connection.api_key_encrypted,
      v_connection.api_secret_encrypted,
      v_connection.passphrase_encrypted,
      v_connection.scope_permissions,
      v_connection.last_verified_at,
      'active',
      v_connection.last_verified_at,
      NULL,
      'pending',
      0,
      NULL,
      'realtime',
      v_now
    )
    ON CONFLICT (user_id, platform, trader_id) DO UPDATE
    SET encrypted_api_key = EXCLUDED.encrypted_api_key,
        encrypted_api_secret = EXCLUDED.encrypted_api_secret,
        encrypted_passphrase = EXCLUDED.encrypted_passphrase,
        permissions = EXCLUDED.permissions,
        read_only_verified_at = EXCLUDED.read_only_verified_at,
        status = EXCLUDED.status,
        last_verified_at = EXCLUDED.last_verified_at,
        last_sync_at = CASE
          WHEN existing_authorization.encrypted_api_key
                 IS DISTINCT FROM EXCLUDED.encrypted_api_key
            OR existing_authorization.encrypted_api_secret
                 IS DISTINCT FROM EXCLUDED.encrypted_api_secret
            OR existing_authorization.encrypted_passphrase
                 IS DISTINCT FROM EXCLUDED.encrypted_passphrase
            OR existing_authorization.permissions IS DISTINCT FROM EXCLUDED.permissions
          THEN NULL
          ELSE existing_authorization.last_sync_at
        END,
        last_sync_status = CASE
          WHEN existing_authorization.encrypted_api_key
                 IS DISTINCT FROM EXCLUDED.encrypted_api_key
            OR existing_authorization.encrypted_api_secret
                 IS DISTINCT FROM EXCLUDED.encrypted_api_secret
            OR existing_authorization.encrypted_passphrase
                 IS DISTINCT FROM EXCLUDED.encrypted_passphrase
            OR existing_authorization.permissions IS DISTINCT FROM EXCLUDED.permissions
          THEN 'pending'
          ELSE existing_authorization.last_sync_status
        END,
        consecutive_failures = CASE
          WHEN existing_authorization.encrypted_api_key
                 IS DISTINCT FROM EXCLUDED.encrypted_api_key
            OR existing_authorization.encrypted_api_secret
                 IS DISTINCT FROM EXCLUDED.encrypted_api_secret
            OR existing_authorization.encrypted_passphrase
                 IS DISTINCT FROM EXCLUDED.encrypted_passphrase
            OR existing_authorization.permissions IS DISTINCT FROM EXCLUDED.permissions
          THEN 0
          ELSE existing_authorization.consecutive_failures
        END,
        verification_error = CASE
          WHEN existing_authorization.encrypted_api_key
                 IS DISTINCT FROM EXCLUDED.encrypted_api_key
            OR existing_authorization.encrypted_api_secret
                 IS DISTINCT FROM EXCLUDED.encrypted_api_secret
            OR existing_authorization.encrypted_passphrase
                 IS DISTINCT FROM EXCLUDED.encrypted_passphrase
            OR existing_authorization.permissions IS DISTINCT FROM EXCLUDED.permissions
          THEN NULL
          ELSE existing_authorization.verification_error
        END,
        updated_at = EXCLUDED.updated_at
    RETURNING id INTO v_authorization_id;
  END IF;

  -- The nested SECURITY DEFINER function executes in this same transaction;
  -- an unknown Arena source or any other failure rolls every projection back.
  v_arena_trader_id := public.arena_set_trader_claimed(
    v_claim.source,
    v_claim.trader_id,
    v_claim.user_id,
    true
  );

  IF v_arena_trader_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'Arena trader claim projection was not created';
  END IF;

  -- Commit the externally visible review state last. Replays preserve the
  -- first successful reviewer and timestamps while reconciling projections.
  UPDATE public.trader_claims AS claim
  SET status = 'verified',
      reviewed_by = COALESCE(claim.reviewed_by, p_reviewer_id),
      reviewed_at = COALESCE(claim.reviewed_at, v_now),
      verified_at = COALESCE(claim.verified_at, v_now),
      reject_reason = NULL,
      updated_at = v_now
  WHERE claim.id = v_claim.id
  RETURNING claim.* INTO STRICT v_claim;

  RETURN pg_catalog.jsonb_build_object(
    'claim', pg_catalog.to_jsonb(v_claim),
    'linked_trader_id', v_link.id,
    'primary_link_id', v_primary.id,
    'linked_count', v_linked_count,
    'authorization_id', v_authorization_id,
    'arena_trader_id', v_arena_trader_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.activate_trader_claim(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.activate_trader_claim(uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.activate_trader_claim(uuid, uuid) IS
  'Service-only atomic claim activation across identity, profile, authorization, and Arena projections.';

NOTIFY pgrst, 'reload schema';

COMMIT;
