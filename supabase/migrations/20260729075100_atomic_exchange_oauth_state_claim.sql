-- Atomically lease and consume exchange OAuth state.
--
-- The legacy callback selected a state row and deleted it in two statements.
-- Two callback workers could therefore both pass validation, while deleting
-- the row before the token exchange also made transient upstream failures
-- impossible to retry. This additive migration keeps legacy table access
-- working during a rolling deploy and gives the new route a fenced lease.

BEGIN;

ALTER TABLE public.oauth_states
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

DO $do$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.oauth_states'::pg_catalog.regclass
      AND conname = 'oauth_states_claim_pair_check'
  ) THEN
    ALTER TABLE public.oauth_states
      ADD CONSTRAINT oauth_states_claim_pair_check
      CHECK (
        (claim_token IS NULL AND claim_expires_at IS NULL)
        OR (claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
      );
  END IF;
END
$do$;

CREATE INDEX IF NOT EXISTS oauth_states_callback_lookup_idx
  ON public.oauth_states (user_id, exchange, state);

CREATE OR REPLACE FUNCTION public.claim_exchange_oauth_state_atomic(
  p_user_id uuid,
  p_exchange text,
  p_state text,
  p_lease_seconds integer DEFAULT 120
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_id uuid;
  v_code_verifier text;
  v_claim_token uuid;
  v_now timestamptz := pg_catalog.clock_timestamp();
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL
     OR p_exchange IS NULL
     OR pg_catalog.length(pg_catalog.btrim(p_exchange)) = 0
     OR p_state IS NULL
     OR pg_catalog.length(p_state) = 0
     OR p_lease_seconds < 15
     OR p_lease_seconds > 300 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_input');
  END IF;

  WITH candidate AS (
    SELECT oauth_state.id
    FROM public.oauth_states AS oauth_state
    WHERE oauth_state.user_id = p_user_id
      AND oauth_state.exchange = p_exchange
      AND oauth_state.state = p_state
      AND oauth_state.expires_at > v_now
      AND (
        oauth_state.claim_token IS NULL
        OR oauth_state.claim_expires_at <= v_now
      )
    ORDER BY oauth_state.created_at, oauth_state.id
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.oauth_states AS oauth_state
    SET claim_token = pg_catalog.gen_random_uuid(),
        claim_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds)
    FROM candidate
    WHERE oauth_state.id = candidate.id
    RETURNING oauth_state.id, oauth_state.code_verifier, oauth_state.claim_token
  )
  SELECT claimed.id, claimed.code_verifier, claimed.claim_token
  INTO v_id, v_code_verifier, v_claim_token
  FROM claimed;

  IF v_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_or_claimed');
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'id', v_id,
    'code_verifier', v_code_verifier,
    'claim_token', v_claim_token
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.finish_exchange_oauth_state_claim_atomic(
  p_user_id uuid,
  p_exchange text,
  p_state text,
  p_claim_token uuid,
  p_succeeded boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL
     OR p_exchange IS NULL
     OR p_state IS NULL
     OR p_claim_token IS NULL
     OR p_succeeded IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid_input');
  END IF;

  IF p_succeeded THEN
    DELETE FROM public.oauth_states AS oauth_state
    WHERE oauth_state.user_id = p_user_id
      AND oauth_state.exchange = p_exchange
      AND oauth_state.state = p_state
      AND oauth_state.claim_token = p_claim_token
    RETURNING oauth_state.id INTO v_id;

    RETURN pg_catalog.jsonb_build_object(
      'status', CASE WHEN v_id IS NULL THEN 'stale_claim' ELSE 'consumed' END
    );
  END IF;

  UPDATE public.oauth_states AS oauth_state
  SET claim_token = NULL,
      claim_expires_at = NULL
  WHERE oauth_state.user_id = p_user_id
    AND oauth_state.exchange = p_exchange
    AND oauth_state.state = p_state
    AND oauth_state.claim_token = p_claim_token
  RETURNING oauth_state.id INTO v_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', CASE WHEN v_id IS NULL THEN 'stale_claim' ELSE 'released' END
  );
END
$function$;

REVOKE ALL ON FUNCTION public.claim_exchange_oauth_state_atomic(uuid, text, text, integer)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finish_exchange_oauth_state_claim_atomic(uuid, text, text, uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.claim_exchange_oauth_state_atomic(uuid, text, text, integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_exchange_oauth_state_claim_atomic(uuid, text, text, uuid, boolean)
  TO service_role;

COMMIT;
