-- Complete the business KPI contract before wiring the admin surfaces:
-- exact new-paying counts, user-first funnel identity, and a disclosed event
-- collection start so partial-window data cannot masquerade as history.

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
    SELECT
      count(*)::integer AS total,
      count(*) FILTER (WHERE created_at >= bounds.window_start)::integer AS new_in_window
    FROM public.subscriptions, bounds
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
    SELECT
      event_name,
      count(DISTINCT COALESCE(user_id::text, anonymous_id_hash))::integer AS actors
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
  ),
  collection AS (
    SELECT min(received_at) AS started_at FROM public.product_events
  )
  SELECT jsonb_build_object(
    'window_days', GREATEST(1, LEAST(p_window_days, 90)),
    'wau', (SELECT value FROM active),
    'total_paying', (SELECT total FROM paying),
    'new_paying', (SELECT new_in_window FROM paying),
    'new_signups', (SELECT value FROM signups),
    'activation_eligible', (SELECT eligible FROM activation),
    'activated_7d', (SELECT activated FROM activation),
    'funnel', COALESCE((SELECT jsonb_object_agg(event_name, actors) FROM funnel), '{}'::jsonb),
    'event_collection_started_at', (SELECT started_at FROM collection),
    'generated_at', now()
  );
$$;

REVOKE ALL ON FUNCTION public.b2c_product_metrics(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.b2c_product_metrics(integer) TO service_role;

COMMENT ON FUNCTION public.b2c_product_metrics(integer) IS
  'Exact B2C paying, signup, WAU, activation and journey funnel facts with collection provenance.';
