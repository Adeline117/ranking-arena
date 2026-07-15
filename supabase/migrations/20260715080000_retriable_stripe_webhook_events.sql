-- A Stripe event is not idempotently processed merely because it was seen.
-- Track claim/processing/outcome separately so a handler failure remains
-- retryable instead of permanently poisoning the event ID.

ALTER TABLE public.stripe_events
  ADD COLUMN status text NOT NULL DEFAULT 'processed'
    CHECK (status IN ('processing', 'processed', 'failed')),
  ADD COLUMN attempts integer NOT NULL DEFAULT 1 CHECK (attempts > 0),
  ADD COLUMN started_at timestamptz,
  ADD COLUMN last_error text;

ALTER TABLE public.stripe_events ALTER COLUMN processed_at DROP NOT NULL;

UPDATE public.stripe_events
SET status = 'processed',
    started_at = COALESCE(started_at, processed_at, created_at)
WHERE status = 'processed';

ALTER TABLE public.stripe_events ALTER COLUMN status SET DEFAULT 'processing';

CREATE INDEX stripe_events_status_started_idx
  ON public.stripe_events (status, started_at)
  WHERE status <> 'processed';

CREATE OR REPLACE FUNCTION public.claim_stripe_event(
  p_event_id text,
  p_event_type text,
  p_stale_after interval DEFAULT interval '10 minutes'
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  existing_status text;
  existing_started_at timestamptz;
BEGIN
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
    now(),
    NULL,
    NULL
  )
  ON CONFLICT (event_id) DO NOTHING;

  IF FOUND THEN
    RETURN 'claimed';
  END IF;

  SELECT status, started_at
  INTO existing_status, existing_started_at
  FROM public.stripe_events
  WHERE event_id = p_event_id
  FOR UPDATE;

  IF existing_status = 'processed' THEN
    RETURN 'processed';
  END IF;

  IF existing_status = 'processing'
     AND existing_started_at > now() - GREATEST(p_stale_after, interval '1 minute') THEN
    RETURN 'busy';
  END IF;

  UPDATE public.stripe_events
  SET event_type = p_event_type,
      status = 'processing',
      attempts = attempts + 1,
      started_at = now(),
      processed_at = NULL,
      last_error = NULL
  WHERE event_id = p_event_id;

  RETURN 'claimed';
END;
$$;

CREATE OR REPLACE FUNCTION public.finish_stripe_event(
  p_event_id text,
  p_succeeded boolean,
  p_error text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.stripe_events
  SET status = CASE WHEN p_succeeded THEN 'processed' ELSE 'failed' END,
      processed_at = CASE WHEN p_succeeded THEN now() ELSE NULL END,
      last_error = CASE
        WHEN p_succeeded THEN NULL
        ELSE left(COALESCE(p_error, 'unknown handler failure'), 2000)
      END
  WHERE event_id = p_event_id
    AND status = 'processing'
  RETURNING true;
$$;

REVOKE ALL ON FUNCTION public.claim_stripe_event(text, text, interval)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_stripe_event(text, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_stripe_event(text, text, interval) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_stripe_event(text, boolean, text) TO service_role;

COMMENT ON FUNCTION public.claim_stripe_event(text, text, interval) IS
  'Atomically claims a new, failed, or stale Stripe event; processed events remain deduplicated.';
COMMENT ON FUNCTION public.finish_stripe_event(text, boolean, text) IS
  'Marks a claimed Stripe event processed or retryable-failed after handler completion.';
