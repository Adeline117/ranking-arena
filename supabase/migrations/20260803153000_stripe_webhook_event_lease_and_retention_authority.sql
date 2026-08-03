-- Permanently retain Stripe webhook event identities, bind idempotency to the
-- exact test/live event mode, and fence completion with a per-claim lease.
-- Retention and lease authority are installed under one table lock so there is
-- no deployment window where a new insert can trigger the legacy 30-day purge.
-- Legacy RPC signatures remain callable while old application instances drain.

BEGIN;

SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $preflight$
DECLARE
  v_event_id_attnum smallint;
  v_single_event_unique_count integer;
BEGIN
  IF pg_catalog.to_regclass('public.stripe_events') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.claim_stripe_event(text,text,interval)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.finish_stripe_event(text,boolean,text)'
    ) IS NULL
  THEN
    RAISE EXCEPTION
      'Stripe webhook event lease prerequisites are missing';
  END IF;

  IF pg_catalog.to_regprocedure(
      'public.claim_stripe_event_v2(text,text,boolean,interval)'
    ) IS NOT NULL
    OR pg_catalog.to_regprocedure(
      'public.finish_stripe_event_v2(text,text,boolean,uuid,boolean,text)'
    ) IS NOT NULL
    OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
      WHERE attribute_row.attrelid =
          'public.stripe_events'::pg_catalog.regclass
        AND attribute_row.attname IN (
          'livemode',
          'lease_token',
          'lease_expires_at'
        )
        AND NOT attribute_row.attisdropped
    )
  THEN
    RAISE EXCEPTION
      'Stripe webhook event lease authority was already installed';
  END IF;

  IF pg_catalog.to_regrole('postgres') IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
  THEN
    RAISE EXCEPTION 'Stripe webhook event lease roles are missing';
  END IF;

  IF EXISTS (
    SELECT required.column_name
    FROM (
      VALUES
        ('id'),
        ('event_id'),
        ('event_type'),
        ('status'),
        ('attempts'),
        ('started_at'),
        ('processed_at'),
        ('last_error')
    ) AS required(column_name)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute_row
      WHERE attribute_row.attrelid =
          'public.stripe_events'::pg_catalog.regclass
        AND attribute_row.attname = required.column_name
        AND NOT attribute_row.attisdropped
    )
  ) THEN
    RAISE EXCEPTION
      'Stripe webhook event table shape drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.stripe_events AS event_row
    WHERE event_row.event_id IS NULL
      OR event_row.event_id !~ '^evt_[A-Za-z0-9_]+$'
      OR pg_catalog.length(event_row.event_id) > 255
      OR event_row.event_type IS NULL
      OR event_row.event_type !~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'
      OR pg_catalog.length(event_row.event_type) > 255
      OR event_row.status NOT IN ('processing', 'processed', 'failed')
      OR event_row.attempts < 1
  ) THEN
    RAISE EXCEPTION
      'Stripe webhook event data violates the exact identity contract';
  END IF;

  SELECT attribute_row.attnum
  INTO v_event_id_attnum
  FROM pg_catalog.pg_attribute AS attribute_row
  WHERE attribute_row.attrelid =
      'public.stripe_events'::pg_catalog.regclass
    AND attribute_row.attname = 'event_id'
    AND NOT attribute_row.attisdropped;

  SELECT pg_catalog.count(*)
  INTO v_single_event_unique_count
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
      'public.stripe_events'::pg_catalog.regclass
    AND constraint_row.contype = 'u'
    AND pg_catalog.array_length(constraint_row.conkey, 1) = 1
    AND constraint_row.conkey[1] = v_event_id_attnum;

  IF v_single_event_unique_count < 1 THEN
    RAISE EXCEPTION
      'Stripe webhook event_id unique constraint drifted';
  END IF;
END
$preflight$;

LOCK TABLE public.stripe_events IN ACCESS EXCLUSIVE MODE;

-- A processed Stripe event is a permanent money/entitlement idempotency fact.
-- Remove both historical deletion paths before any new exact-mode claim can
-- write a row.
DROP TRIGGER IF EXISTS trg_cleanup_stripe_events
  ON public.stripe_events;
DROP FUNCTION IF EXISTS public.cleanup_old_stripe_events();

CREATE OR REPLACE FUNCTION public.reject_stripe_event_destructive_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION 'Stripe webhook event ledger is permanent and append-only'
    USING ERRCODE = '55000';
END
$function$;

ALTER FUNCTION public.reject_stripe_event_destructive_write()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.reject_stripe_event_destructive_write()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

DROP TRIGGER IF EXISTS trg_reject_stripe_event_destructive_write
  ON public.stripe_events;
CREATE TRIGGER trg_reject_stripe_event_destructive_write
  BEFORE DELETE OR TRUNCATE ON public.stripe_events
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.reject_stripe_event_destructive_write();

-- All webhook mutations must cross a SECURITY DEFINER claim/finish RPC. Keep
-- SELECT available for readiness checks, but close every direct DML bypass.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON TABLE public.stripe_events
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

ALTER TABLE public.stripe_events
  ADD COLUMN livemode boolean,
  ADD COLUMN lease_token uuid,
  ADD COLUMN lease_expires_at timestamptz;

DO $drop_legacy_unique$
DECLARE
  v_event_id_attnum smallint;
  v_constraint record;
BEGIN
  SELECT attribute_row.attnum
  INTO v_event_id_attnum
  FROM pg_catalog.pg_attribute AS attribute_row
  WHERE attribute_row.attrelid =
      'public.stripe_events'::pg_catalog.regclass
    AND attribute_row.attname = 'event_id'
    AND NOT attribute_row.attisdropped;

  FOR v_constraint IN
    SELECT constraint_row.conname
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'public.stripe_events'::pg_catalog.regclass
      AND constraint_row.contype = 'u'
      AND pg_catalog.array_length(constraint_row.conkey, 1) = 1
      AND constraint_row.conkey[1] = v_event_id_attnum
  LOOP
    EXECUTE pg_catalog.format(
      'ALTER TABLE public.stripe_events DROP CONSTRAINT %I',
      v_constraint.conname
    );
  END LOOP;
END
$drop_legacy_unique$;

ALTER TABLE public.stripe_events
  ADD CONSTRAINT stripe_events_event_mode_key
    UNIQUE NULLS NOT DISTINCT (event_id, livemode),
  ADD CONSTRAINT stripe_events_exact_lease_state_check
    CHECK (
      (
        livemode IS NULL
        AND lease_token IS NULL
        AND lease_expires_at IS NULL
      )
      OR (
        livemode IS NOT NULL
        AND (
          (
            status = 'processing'
            AND lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL
          )
          OR (
            status IN ('processed', 'failed')
            AND lease_token IS NULL
            AND lease_expires_at IS NULL
          )
        )
      )
    ) NOT VALID;

ALTER TABLE public.stripe_events
  VALIDATE CONSTRAINT stripe_events_exact_lease_state_check;

CREATE INDEX stripe_events_mode_status_started_idx
  ON public.stripe_events (
    livemode,
    status,
    lease_expires_at,
    started_at
  )
  WHERE status <> 'processed';

CREATE OR REPLACE FUNCTION public.guard_stripe_event_identity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF NEW.event_id IS DISTINCT FROM OLD.event_id
    OR NEW.event_type IS DISTINCT FROM OLD.event_type
  THEN
    RAISE EXCEPTION 'Stripe webhook event identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.livemode IS DISTINCT FROM OLD.livemode
    AND NOT (
      OLD.livemode IS NULL
      AND NEW.livemode IS NOT NULL
      AND pg_catalog.current_setting(
        'arena.stripe_event_mode_promotion',
        true
      ) = 'v2-claim'
      AND NEW.status = 'processing'
      AND NEW.attempts = OLD.attempts + 1
      AND NEW.lease_token IS NOT NULL
      AND NEW.lease_expires_at IS NOT NULL
    )
  THEN
    RAISE EXCEPTION 'Stripe webhook event mode is immutable'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.guard_stripe_event_identity() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.guard_stripe_event_identity()
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE TRIGGER trg_stripe_event_identity
  BEFORE UPDATE OF event_id, event_type, livemode
  ON public.stripe_events
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_stripe_event_identity();

CREATE OR REPLACE FUNCTION public.claim_stripe_event_v2(
  p_event_id text,
  p_event_type text,
  p_livemode boolean,
  p_lease_duration interval DEFAULT interval '10 minutes'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_event public.stripe_events%ROWTYPE;
  v_lease_token uuid;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_event_id IS NULL
    OR p_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_event_id) > 255
    OR p_event_type IS NULL
    OR p_event_type !~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'
    OR pg_catalog.length(p_event_type) > 255
    OR p_livemode IS NULL
    OR p_lease_duration IS NULL
    OR p_lease_duration < interval '1 minute'
    OR p_lease_duration > interval '1 hour'
  THEN
    RAISE EXCEPTION 'Stripe webhook claim identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize the legacy and exact-mode claim functions for the same Stripe ID
  -- while both application versions may be serving traffic.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-webhook-event:' || p_event_id,
      0
    )
  );

  SELECT event_row.*
  INTO v_event
  FROM public.stripe_events AS event_row
  WHERE event_row.event_id = p_event_id
    AND event_row.livemode = p_livemode
  FOR UPDATE;

  IF FOUND THEN
    IF v_event.event_type IS DISTINCT FROM p_event_type THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'identity_conflict'
      );
    END IF;
    IF v_event.status = 'processed' THEN
      RETURN pg_catalog.jsonb_build_object('status', 'processed');
    END IF;
    IF v_event.status = 'processing'
      AND v_event.lease_expires_at > v_now
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'busy');
    END IF;

    v_lease_token := pg_catalog.gen_random_uuid();
    UPDATE public.stripe_events AS event_row
    SET status = 'processing',
        attempts = event_row.attempts + 1,
        started_at = v_now,
        processed_at = NULL,
        last_error = NULL,
        lease_token = v_lease_token,
        lease_expires_at = v_now + p_lease_duration
    WHERE event_row.id = v_event.id;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'claimed',
      'leaseToken', v_lease_token
    );
  END IF;

  -- A legacy instance cannot provide livemode. Honor its completed/fresh claim;
  -- a failed or abandoned legacy claim is atomically promoted to this exact
  -- mode so the v2 worker can retry it with a fenced lease.
  SELECT event_row.*
  INTO v_event
  FROM public.stripe_events AS event_row
  WHERE event_row.event_id = p_event_id
    AND event_row.livemode IS NULL
  FOR UPDATE;

  IF FOUND THEN
    IF v_event.event_type IS DISTINCT FROM p_event_type THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'identity_conflict'
      );
    END IF;
    IF v_event.status = 'processed' THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'processed',
        'legacy', true
      );
    END IF;
    IF v_event.status = 'processing'
      AND v_event.started_at IS NOT NULL
      AND v_event.started_at > v_now - p_lease_duration
    THEN
      RETURN pg_catalog.jsonb_build_object('status', 'busy');
    END IF;

    v_lease_token := pg_catalog.gen_random_uuid();
    PERFORM pg_catalog.set_config(
      'arena.stripe_event_mode_promotion',
      'v2-claim',
      true
    );
    UPDATE public.stripe_events AS event_row
    SET livemode = p_livemode,
        status = 'processing',
        attempts = event_row.attempts + 1,
        started_at = v_now,
        processed_at = NULL,
        last_error = NULL,
        lease_token = v_lease_token,
        lease_expires_at = v_now + p_lease_duration
    WHERE event_row.id = v_event.id;

    RETURN pg_catalog.jsonb_build_object(
      'status', 'claimed',
      'leaseToken', v_lease_token,
      'promotedLegacyClaim', true
    );
  END IF;

  v_lease_token := pg_catalog.gen_random_uuid();
  INSERT INTO public.stripe_events (
    event_id,
    event_type,
    status,
    attempts,
    started_at,
    processed_at,
    last_error,
    livemode,
    lease_token,
    lease_expires_at
  ) VALUES (
    p_event_id,
    p_event_type,
    'processing',
    1,
    v_now,
    NULL,
    NULL,
    p_livemode,
    v_lease_token,
    v_now + p_lease_duration
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'claimed',
    'leaseToken', v_lease_token
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.finish_stripe_event_v2(
  p_event_id text,
  p_event_type text,
  p_livemode boolean,
  p_lease_token uuid,
  p_succeeded boolean,
  p_error text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_event public.stripe_events%ROWTYPE;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_event_id IS NULL
    OR p_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_event_id) > 255
    OR p_event_type IS NULL
    OR p_event_type !~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'
    OR pg_catalog.length(p_event_type) > 255
    OR p_livemode IS NULL
    OR p_lease_token IS NULL
    OR p_succeeded IS NULL
    OR (p_succeeded AND p_error IS NOT NULL)
    OR (
      NOT p_succeeded
      AND (
        p_error IS NULL
        OR pg_catalog.length(pg_catalog.btrim(p_error)) NOT BETWEEN 1 AND 2000
      )
    )
  THEN
    RAISE EXCEPTION 'Stripe webhook completion identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  SELECT event_row.*
  INTO v_event
  FROM public.stripe_events AS event_row
  WHERE event_row.event_id = p_event_id
    AND event_row.livemode = p_livemode
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;
  IF v_event.event_type IS DISTINCT FROM p_event_type THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'identity_conflict'
    );
  END IF;
  IF v_event.status IS DISTINCT FROM 'processing'
    OR v_event.lease_token IS DISTINCT FROM p_lease_token
    OR v_event.lease_expires_at IS NULL
    OR v_event.lease_expires_at <= v_now
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'lease_lost');
  END IF;

  IF p_succeeded THEN
    UPDATE public.stripe_events AS event_row
    SET status = 'processed',
        processed_at = pg_catalog.clock_timestamp(),
        last_error = NULL,
        lease_token = NULL,
        lease_expires_at = NULL
    WHERE event_row.id = v_event.id;
    RETURN pg_catalog.jsonb_build_object('status', 'processed');
  END IF;

  UPDATE public.stripe_events AS event_row
  SET status = 'failed',
      processed_at = NULL,
      last_error = pg_catalog.left(p_error, 2000),
      lease_token = NULL,
      lease_expires_at = NULL
  WHERE event_row.id = v_event.id;
  RETURN pg_catalog.jsonb_build_object('status', 'retry_scheduled');
END
$function$;

-- Legacy RPC compatibility. Old workers keep their response shape and can
-- retry failed legacy claims. They fail closed when an exact-mode v2 identity
-- exists, preventing an old worker from processing a v2-owned event.
CREATE OR REPLACE FUNCTION public.claim_stripe_event(
  p_event_id text,
  p_event_type text,
  p_stale_after interval DEFAULT interval '10 minutes'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_event public.stripe_events%ROWTYPE;
  v_now timestamptz := pg_catalog.statement_timestamp();
BEGIN
  IF p_event_id IS NULL
    OR p_event_id !~ '^evt_[A-Za-z0-9_]+$'
    OR pg_catalog.length(p_event_id) > 255
    OR p_event_type IS NULL
    OR p_event_type !~ '^[a-z0-9_]+(\.[a-z0-9_]+)*$'
    OR pg_catalog.length(p_event_type) > 255
  THEN
    RAISE EXCEPTION 'Stripe webhook claim identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'stripe-webhook-event:' || p_event_id,
      0
    )
  );

  IF EXISTS (
    SELECT 1
    FROM public.stripe_events AS event_row
    WHERE event_row.event_id = p_event_id
      AND event_row.livemode IS NOT NULL
  ) THEN
    RETURN 'busy';
  END IF;

  SELECT event_row.*
  INTO v_event
  FROM public.stripe_events AS event_row
  WHERE event_row.event_id = p_event_id
    AND event_row.livemode IS NULL
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.stripe_events (
      event_id,
      event_type,
      status,
      attempts,
      started_at,
      processed_at,
      last_error
    ) VALUES (
      p_event_id,
      p_event_type,
      'processing',
      1,
      v_now,
      NULL,
      NULL
    );
    RETURN 'claimed';
  END IF;

  IF v_event.event_type IS DISTINCT FROM p_event_type THEN
    RETURN 'identity_conflict';
  END IF;
  IF v_event.status = 'processed' THEN
    RETURN 'processed';
  END IF;
  -- A legacy caller has no lease token to prove which processing generation it
  -- owns. Never let one legacy worker reclaim another; a v2 worker may promote
  -- this row after its bounded lease window and fence the old completion.
  IF v_event.status = 'processing' THEN
    RETURN 'busy';
  END IF;

  UPDATE public.stripe_events AS event_row
  SET status = 'processing',
      attempts = event_row.attempts + 1,
      started_at = v_now,
      processed_at = NULL,
      last_error = NULL
  WHERE event_row.id = v_event.id;
  RETURN 'claimed';
END
$function$;

CREATE OR REPLACE FUNCTION public.finish_stripe_event(
  p_event_id text,
  p_succeeded boolean,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
  UPDATE public.stripe_events AS event_row
  SET status = CASE WHEN p_succeeded THEN 'processed' ELSE 'failed' END,
      processed_at = CASE
        WHEN p_succeeded THEN pg_catalog.clock_timestamp()
        ELSE NULL
      END,
      last_error = CASE
        WHEN p_succeeded THEN NULL
        ELSE pg_catalog.left(
          COALESCE(p_error, 'unknown handler failure'),
          2000
        )
      END
  WHERE event_row.event_id = p_event_id
    AND event_row.livemode IS NULL
    AND event_row.status = 'processing'
    AND event_row.lease_token IS NULL
    AND event_row.lease_expires_at IS NULL
  RETURNING true;
$function$;

ALTER FUNCTION public.claim_stripe_event_v2(
  text, text, boolean, interval
) OWNER TO postgres;
ALTER FUNCTION public.finish_stripe_event_v2(
  text, text, boolean, uuid, boolean, text
) OWNER TO postgres;
ALTER FUNCTION public.claim_stripe_event(text, text, interval)
  OWNER TO postgres;
ALTER FUNCTION public.finish_stripe_event(text, boolean, text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.claim_stripe_event_v2(
  text, text, boolean, interval
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.finish_stripe_event_v2(
  text, text, boolean, uuid, boolean, text
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.claim_stripe_event(text, text, interval)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.finish_stripe_event(text, boolean, text)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

GRANT EXECUTE ON FUNCTION public.claim_stripe_event_v2(
  text, text, boolean, interval
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_stripe_event_v2(
  text, text, boolean, uuid, boolean, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_stripe_event(text, text, interval)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_stripe_event(text, boolean, text)
  TO service_role;

COMMENT ON COLUMN public.stripe_events.livemode IS
  'Exact Stripe account mode. NULL is reserved for rolling legacy claims.';
COMMENT ON COLUMN public.stripe_events.lease_token IS
  'Unforgeable v2 claim generation token; cleared on every terminal attempt.';
COMMENT ON FUNCTION public.claim_stripe_event_v2(
  text, text, boolean, interval
) IS
  'Claims an exact test/live Stripe event identity with an expiring, per-attempt lease token.';
COMMENT ON FUNCTION public.finish_stripe_event_v2(
  text, text, boolean, uuid, boolean, text
) IS
  'Finishes only the exact current Stripe event lease; stale workers cannot overwrite a newer attempt.';
COMMENT ON FUNCTION public.claim_stripe_event(text, text, interval) IS
  'Rolling compatibility claim for legacy webhook workers; exact-mode v2 rows fail closed as busy.';
COMMENT ON FUNCTION public.finish_stripe_event(text, boolean, text) IS
  'Rolling compatibility completion limited to legacy NULL-mode claims.';
COMMENT ON TABLE public.stripe_events IS
  'Permanent Stripe webhook idempotency ledger; mutations require fenced SECURITY DEFINER RPCs.';
COMMENT ON FUNCTION public.reject_stripe_event_destructive_write() IS
  'Rejects DELETE and TRUNCATE so a processed Stripe event identity can never become claimable again.';

DO $postflight$
DECLARE
  v_mode_constraint_ok boolean;
  v_claim_definition text;
  v_finish_definition text;
  v_retention_trigger_definition text;
BEGIN
  SELECT
    constraint_row.contype = 'u'
      AND index_row.indnullsnotdistinct
      AND (
        SELECT pg_catalog.array_agg(
          attribute_row.attname::text
          ORDER BY key_row.ordinality
        )
        FROM pg_catalog.unnest(constraint_row.conkey)
          WITH ORDINALITY AS key_row(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute_row
          ON attribute_row.attrelid = constraint_row.conrelid
         AND attribute_row.attnum = key_row.attnum
      ) = ARRAY['event_id', 'livemode']::text[]
  INTO v_mode_constraint_ok
  FROM pg_catalog.pg_constraint AS constraint_row
  JOIN pg_catalog.pg_index AS index_row
    ON index_row.indexrelid = constraint_row.conindid
  WHERE constraint_row.conrelid =
      'public.stripe_events'::pg_catalog.regclass
    AND constraint_row.conname = 'stripe_events_event_mode_key';

  IF v_mode_constraint_ok IS DISTINCT FROM true
    OR pg_catalog.to_regprocedure(
      'public.claim_stripe_event_v2(text,text,boolean,interval)'
    ) IS NULL
    OR pg_catalog.to_regprocedure(
      'public.finish_stripe_event_v2(text,text,boolean,uuid,boolean,text)'
    ) IS NULL
    OR NOT pg_catalog.has_function_privilege(
      'service_role',
      'public.claim_stripe_event_v2(text,text,boolean,interval)',
      'EXECUTE'
    )
    OR NOT pg_catalog.has_function_privilege(
      'service_role',
      'public.finish_stripe_event_v2(text,text,boolean,uuid,boolean,text)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'authenticated',
      'public.claim_stripe_event_v2(text,text,boolean,interval)',
      'EXECUTE'
    )
    OR pg_catalog.has_function_privilege(
      'anon',
      'public.finish_stripe_event_v2(text,text,boolean,uuid,boolean,text)',
      'EXECUTE'
    )
    OR pg_catalog.to_regprocedure(
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
        AND trigger_row.tgname =
          'trg_reject_stripe_event_destructive_write'
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
    )
    OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          ('service_role'),
          ('authenticated'),
          ('anon'),
          ('authenticator')
      ) AS role_row(role_name)
      CROSS JOIN (
        VALUES
          ('INSERT'),
          ('UPDATE'),
          ('DELETE'),
          ('TRUNCATE')
      ) AS privilege_row(privilege_name)
      WHERE pg_catalog.has_table_privilege(
        role_row.role_name,
        'public.stripe_events',
        privilege_row.privilege_name
      )
    )
    OR pg_catalog.has_function_privilege(
      'service_role',
      'public.reject_stripe_event_destructive_write()',
      'EXECUTE'
    )
  THEN
    RAISE EXCEPTION
      'Stripe webhook event lease catalog postflight failed';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
    'public.claim_stripe_event_v2(text,text,boolean,interval)'::pg_catalog.regprocedure
  ) INTO v_claim_definition;
  SELECT pg_catalog.pg_get_functiondef(
    'public.finish_stripe_event_v2(text,text,boolean,uuid,boolean,text)'::pg_catalog.regprocedure
  ) INTO v_finish_definition;
  SELECT pg_catalog.pg_get_triggerdef(trigger_row.oid)
  INTO v_retention_trigger_definition
  FROM pg_catalog.pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid =
      'public.stripe_events'::pg_catalog.regclass
    AND trigger_row.tgname =
      'trg_reject_stripe_event_destructive_write'
    AND NOT trigger_row.tgisinternal;

  IF v_claim_definition NOT LIKE '%event_row.livemode = p_livemode%'
    OR v_claim_definition NOT LIKE '%v_event.event_type IS DISTINCT FROM p_event_type%'
    OR v_claim_definition NOT LIKE '%v_lease_token := pg_catalog.gen_random_uuid()%'
    OR v_finish_definition NOT LIKE '%v_event.lease_token IS DISTINCT FROM p_lease_token%'
    OR v_finish_definition NOT LIKE '%v_event.lease_expires_at <= v_now%'
    OR v_retention_trigger_definition NOT LIKE '%BEFORE DELETE OR TRUNCATE%'
  THEN
    RAISE EXCEPTION
      'Stripe webhook event lease function definition drifted';
  END IF;
END
$postflight$;

COMMIT;
