-- First-party B2C measurement foundation.
-- Client analytics providers are useful diagnostics, but product decisions use
-- these server-owned, deduplicated facts and exact database counts.

CREATE TABLE public.product_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE,
  event_name text NOT NULL CHECK (char_length(event_name) BETWEEN 1 AND 80),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  anonymous_id_hash text,
  session_id_hash text,
  source text NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'server')),
  path text,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(properties) = 'object')
);

CREATE INDEX product_events_name_time_idx
  ON public.product_events (event_name, occurred_at DESC);
CREATE INDEX product_events_user_time_idx
  ON public.product_events (user_id, occurred_at DESC)
  WHERE user_id IS NOT NULL;
CREATE INDEX product_events_anonymous_time_idx
  ON public.product_events (anonymous_id_hash, occurred_at DESC)
  WHERE anonymous_id_hash IS NOT NULL;

CREATE TABLE public.user_activity_days (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  activity_date date NOT NULL,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  heartbeat_count integer NOT NULL DEFAULT 1 CHECK (heartbeat_count > 0),
  PRIMARY KEY (user_id, activity_date)
);

CREATE INDEX user_activity_days_date_idx
  ON public.user_activity_days (activity_date, user_id);

ALTER TABLE public.product_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_activity_days ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service manages product events"
  ON public.product_events FOR ALL TO service_role
  USING (true) WITH CHECK (true);
CREATE POLICY "Service manages activity days"
  ON public.user_activity_days FOR ALL TO service_role
  USING (true) WITH CHECK (true);

REVOKE ALL ON public.product_events FROM anon, authenticated;
REVOKE ALL ON public.user_activity_days FROM anon, authenticated;
GRANT ALL ON public.product_events TO service_role;
GRANT ALL ON public.user_activity_days TO service_role;

CREATE OR REPLACE FUNCTION public.record_user_activity(
  p_user_id uuid,
  p_seen_at timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.user_activity_days (
    user_id,
    activity_date,
    first_seen_at,
    last_seen_at,
    heartbeat_count
  ) VALUES (
    p_user_id,
    (p_seen_at AT TIME ZONE 'UTC')::date,
    p_seen_at,
    p_seen_at,
    1
  )
  ON CONFLICT (user_id, activity_date) DO UPDATE
  SET first_seen_at = LEAST(public.user_activity_days.first_seen_at, EXCLUDED.first_seen_at),
      last_seen_at = GREATEST(public.user_activity_days.last_seen_at, EXCLUDED.last_seen_at),
      heartbeat_count = public.user_activity_days.heartbeat_count + 1;
$$;

CREATE OR REPLACE FUNCTION public.b2c_product_metrics(p_window_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH bounds AS (
    SELECT
      now() - make_interval(days => GREATEST(1, LEAST(p_window_days, 90))) AS window_start,
      now() - interval '30 days' AS activation_cohort_start,
      now() - interval '7 days' AS activation_cohort_end
  ),
  paying AS (
    SELECT count(*)::integer AS value
    FROM public.subscriptions
    WHERE status IN ('active', 'trialing')
      AND tier IN ('pro', 'lifetime')
  ),
  signups AS (
    SELECT count(*)::integer AS value
    FROM public.user_profiles, bounds
    WHERE created_at >= bounds.window_start
      AND deleted_at IS NULL
  ),
  active AS (
    SELECT count(*)::integer AS value
    FROM public.user_profiles, bounds
    WHERE last_seen_at >= bounds.window_start
      AND deleted_at IS NULL
  ),
  activation_cohort AS (
    SELECT p.id, p.created_at
    FROM public.user_profiles p, bounds
    WHERE p.created_at >= bounds.activation_cohort_start
      AND p.created_at < bounds.activation_cohort_end
      AND p.deleted_at IS NULL
  ),
  activation AS (
    SELECT
      count(*)::integer AS eligible,
      count(*) FILTER (
        WHERE (
          SELECT count(DISTINCT d.activity_date)
          FROM public.user_activity_days d
          WHERE d.user_id = c.id
            AND d.activity_date >= (c.created_at AT TIME ZONE 'UTC')::date
            AND d.activity_date <= ((c.created_at + interval '7 days') AT TIME ZONE 'UTC')::date
        ) >= 2
      )::integer AS activated
    FROM activation_cohort c
  ),
  funnel AS (
    SELECT event_name, count(DISTINCT COALESCE(anonymous_id_hash, user_id::text))::integer AS actors
    FROM public.product_events, bounds
    WHERE occurred_at >= bounds.window_start
      AND event_name IN (
        'landing_view',
        'ranking_visible',
        'view_trader',
        'signup_start',
        'signup',
        'onboarding_complete',
        'view_pricing',
        'start_checkout',
        'pro_subscribe'
      )
    GROUP BY event_name
  )
  SELECT jsonb_build_object(
    'window_days', GREATEST(1, LEAST(p_window_days, 90)),
    'wau', (SELECT value FROM active),
    'total_paying', (SELECT value FROM paying),
    'new_signups', (SELECT value FROM signups),
    'activation_eligible', (SELECT eligible FROM activation),
    'activated_7d', (SELECT activated FROM activation),
    'funnel', COALESCE((SELECT jsonb_object_agg(event_name, actors) FROM funnel), '{}'::jsonb),
    'generated_at', now()
  );
$$;

REVOKE ALL ON FUNCTION public.record_user_activity(uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.b2c_product_metrics(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_user_activity(uuid, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.b2c_product_metrics(integer) TO service_role;

COMMENT ON TABLE public.product_events IS
  'Deduplicated first-party B2C journey events; raw anonymous identifiers are hashed before storage.';
COMMENT ON TABLE public.user_activity_days IS
  'One row per user and UTC activity day for exact multi-day activation measurement.';
COMMENT ON FUNCTION public.b2c_product_metrics(integer) IS
  'Exact paying, signup, WAU, 7-day activation and B2C funnel actor counts for a bounded window.';
