-- Reset activation measurement to a product-action contract. A heartbeat on
-- two dates is useful for WAU, but it is not evidence that a new user found
-- and retained a trader worth following.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('public.b2c_product_metrics:v2', 0)
);

DO $preflight$
DECLARE
  v_unexpected_overloads text[];
  v_existing_relation regclass := pg_catalog.to_regclass(
    'public.product_metric_epochs'
  );
BEGIN
  IF pg_catalog.to_regrole('service_role') IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL THEN
    RAISE EXCEPTION 'Supabase API roles are required for the activation metric contract';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.pg_get_function_identity_arguments(procedure_row.oid)
    ORDER BY procedure_row.oid
  )
  INTO v_unexpected_overloads
  FROM pg_catalog.pg_proc AS procedure_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = procedure_row.pronamespace
  WHERE namespace_row.nspname = 'public'
    AND procedure_row.proname = 'b2c_product_metrics'
    AND procedure_row.oid IS DISTINCT FROM pg_catalog.to_regprocedure(
      'public.b2c_product_metrics(integer)'
    );

  IF v_unexpected_overloads IS NOT NULL THEN
    RAISE EXCEPTION
      'unexpected public.b2c_product_metrics overloads must be retired first: %',
      v_unexpected_overloads;
  END IF;

  IF v_existing_relation IS NOT NULL
     AND CURRENT_USER IS DISTINCT FROM (
       SELECT pg_catalog.pg_get_userbyid(relation.relowner)
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = v_existing_relation
     ) THEN
    RAISE EXCEPTION 'migration role must own public.product_metric_epochs on replay';
  END IF;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.product_metric_epochs (
  metric_name text PRIMARY KEY,
  definition_version text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  definition jsonb NOT NULL,
  CHECK (pg_catalog.jsonb_typeof(definition) = 'object')
);

ALTER TABLE public.product_metric_epochs ENABLE ROW LEVEL SECURITY;

DO $drop_metric_epoch_policy_drift$
DECLARE
  v_policy_name name;
BEGIN
  FOR v_policy_name IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.product_metric_epochs'::regclass
    ORDER BY policy.polname
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.product_metric_epochs',
      v_policy_name
    );
  END LOOP;
END
$drop_metric_epoch_policy_drift$;

CREATE POLICY "Service reads product metric epochs"
  ON public.product_metric_epochs
  FOR SELECT
  TO service_role
  USING (true);

-- Supabase default privileges can grant service_role broad rights on newly
-- created tables. Epoch boundaries are migration-owned facts: the runtime may
-- read them through the metric function, but it must not move or rewrite them.
REVOKE ALL ON TABLE public.product_metric_epochs
  FROM PUBLIC, anon, authenticated, service_role;

DO $converge_metric_epoch_acl$
DECLARE
  v_grantee oid;
  v_role_sql text;
  v_column_list text;
BEGIN
  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', '
    ORDER BY attribute.attnum
  )
  INTO STRICT v_column_list
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.product_metric_epochs'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid = 'public.product_metric_epochs'::regclass
      AND acl_entry.grantee <> relation.relowner
    UNION
    SELECT DISTINCT acl_entry.grantee
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = attribute.attrelid
    WHERE attribute.attrelid = 'public.product_metric_epochs'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> relation.relowner
  LOOP
    v_role_sql := CASE
      WHEN v_grantee = 0::oid THEN 'PUBLIC'
      ELSE pg_catalog.format(
        '%I',
        (SELECT role_row.rolname FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee)
      )
    END;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON TABLE public.product_metric_epochs FROM %s',
      v_role_sql
    );
    EXECUTE pg_catalog.format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON TABLE public.product_metric_epochs FROM %2$s',
      v_column_list,
      v_role_sql
    );
  END LOOP;
END
$converge_metric_epoch_acl$;

GRANT SELECT ON TABLE public.product_metric_epochs TO service_role;

INSERT INTO public.product_metric_epochs (
  metric_name,
  definition_version,
  definition
) VALUES (
  'activation_7d',
  'v2_detail_retention_two_utc_days',
  pg_catalog.jsonb_build_object(
    'window', 'registration_plus_7x24h',
    'minimum_distinct_utc_dates', 2,
    'required_detail_event', 'view_trader',
    'retention_events', pg_catalog.jsonb_build_array(
      'save_trader',
      'follow_trader',
      'create_trader_alert:persisted'
    )
  )
)
ON CONFLICT (metric_name) DO UPDATE
SET definition_version = EXCLUDED.definition_version,
    definition = EXCLUDED.definition;

CREATE OR REPLACE FUNCTION public.b2c_product_metrics(p_window_days integer DEFAULT 7)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH measurement AS (
    SELECT epoch.started_at, epoch.definition_version
    FROM public.product_metric_epochs AS epoch
    WHERE epoch.metric_name = 'activation_7d'
  ),
  bounds AS (
    SELECT
      pg_catalog.now()
        - pg_catalog.make_interval(days => GREATEST(1, LEAST(p_window_days, 90)))
        AS window_start,
      pg_catalog.now() - interval '30 days' AS activation_cohort_start,
      pg_catalog.now() - interval '7 days' AS activation_cohort_end
  ),
  paying AS (
    SELECT
      pg_catalog.count(*)::integer AS total,
      pg_catalog.count(*) FILTER (WHERE subscription.created_at >= bounds.window_start)::integer
        AS new_in_window
    FROM public.subscriptions AS subscription
    CROSS JOIN bounds
    WHERE subscription.status IN ('active', 'trialing')
      AND subscription.tier IN ('pro', 'lifetime')
  ),
  signups AS (
    SELECT pg_catalog.count(*)::integer AS value
    FROM public.user_profiles AS profile
    CROSS JOIN bounds
    WHERE profile.created_at >= bounds.window_start
      AND profile.deleted_at IS NULL
  ),
  active AS (
    SELECT pg_catalog.count(*)::integer AS value
    FROM public.user_profiles AS profile
    CROSS JOIN bounds
    WHERE profile.last_seen_at >= bounds.window_start
      AND profile.deleted_at IS NULL
  ),
  activation_cohort AS (
    SELECT profile.id, profile.created_at
    FROM public.user_profiles AS profile
    CROSS JOIN bounds
    CROSS JOIN measurement
    WHERE profile.created_at >= GREATEST(
        bounds.activation_cohort_start,
        measurement.started_at
      )
      AND profile.created_at < bounds.activation_cohort_end
      AND profile.deleted_at IS NULL
  ),
  qualifying_activation_events AS (
    SELECT
      cohort.id AS user_id,
      event.event_name,
      event.occurred_at
    FROM activation_cohort AS cohort
    JOIN public.product_events AS event
      ON event.user_id = cohort.id
     AND event.occurred_at >= cohort.created_at
     AND event.occurred_at < cohort.created_at + interval '7 days'
    WHERE event.event_name IN (
      'view_trader',
      'save_trader',
      'follow_trader',
      'create_trader_alert'
    )
      AND (
        event.event_name <> 'create_trader_alert'
        OR event.properties ->> 'step' = 'persisted'
      )
  ),
  activation_by_user AS (
    SELECT
      event.user_id,
      pg_catalog.bool_or(event.event_name = 'view_trader') AS viewed_detail,
      pg_catalog.bool_or(event.event_name IN (
        'save_trader',
        'follow_trader',
        'create_trader_alert'
      )) AS retained_trader,
      pg_catalog.count(DISTINCT (event.occurred_at AT TIME ZONE 'UTC')::date) AS action_dates
    FROM qualifying_activation_events AS event
    GROUP BY event.user_id
  ),
  activation AS (
    SELECT
      pg_catalog.count(*)::integer AS eligible,
      pg_catalog.count(*) FILTER (
        WHERE activation_user.viewed_detail
          AND activation_user.retained_trader
          AND activation_user.action_dates >= 2
      )::integer AS activated
    FROM activation_cohort AS cohort
    LEFT JOIN activation_by_user AS activation_user
      ON activation_user.user_id = cohort.id
  ),
  funnel AS (
    SELECT
      event.event_name,
      pg_catalog.count(DISTINCT COALESCE(
        event.user_id::text,
        event.anonymous_id_hash
      ))::integer AS actors
    FROM public.product_events AS event
    CROSS JOIN bounds
    WHERE event.occurred_at >= bounds.window_start
      AND event.event_name IN (
        'landing_view',
        'ranking_visible',
        'view_trader',
        'save_trader',
        'follow_trader',
        'create_trader_alert',
        'signup_start',
        'signup',
        'onboarding_complete',
        'view_pricing',
        'start_checkout',
        'pro_subscribe',
        'claim_trader'
      )
    GROUP BY event.event_name
  ),
  collection AS (
    SELECT pg_catalog.min(event.received_at) AS started_at
    FROM public.product_events AS event
  )
  SELECT pg_catalog.jsonb_build_object(
    'window_days', GREATEST(1, LEAST(p_window_days, 90)),
    'wau', (SELECT value FROM active),
    'total_paying', (SELECT total FROM paying),
    'new_paying', (SELECT new_in_window FROM paying),
    'new_signups', (SELECT value FROM signups),
    'activation_eligible', (SELECT eligible FROM activation),
    'activated_7d', (SELECT activated FROM activation),
    'activation_definition_version', (SELECT definition_version FROM measurement),
    'activation_measurement_started_at', (SELECT started_at FROM measurement),
    'funnel', COALESCE(
      (SELECT pg_catalog.jsonb_object_agg(event_name, actors) FROM funnel),
      '{}'::jsonb
    ),
    'event_collection_started_at', (SELECT started_at FROM collection),
    'generated_at', pg_catalog.now()
  );
$function$;

-- CREATE OR REPLACE preserves a historical function owner. Bind the definer
-- capability back to the migration-owned epoch relation before converging its
-- ACL so a previously substituted role cannot rewrite the metric after replay.
ALTER FUNCTION public.b2c_product_metrics(integer) OWNER TO CURRENT_USER;

REVOKE ALL ON FUNCTION public.b2c_product_metrics(integer)
  FROM PUBLIC, anon, authenticated, service_role;

DO $converge_metric_function_acl$
DECLARE
  v_function regprocedure := 'public.b2c_product_metrics(integer)'::regprocedure;
  v_grantee oid;
  v_role_sql text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee
    FROM pg_catalog.pg_proc AS procedure_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(procedure_row.proacl, pg_catalog.acldefault('f', procedure_row.proowner))
    ) AS acl_entry
    WHERE procedure_row.oid = v_function
      AND acl_entry.grantee <> procedure_row.proowner
  LOOP
    v_role_sql := CASE
      WHEN v_grantee = 0::oid THEN 'PUBLIC'
      ELSE pg_catalog.format(
        '%I',
        (SELECT role_row.rolname FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.oid = v_grantee)
      )
    END;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION public.b2c_product_metrics(integer) FROM %s',
      v_role_sql
    );
  END LOOP;
END
$converge_metric_function_acl$;

GRANT EXECUTE ON FUNCTION public.b2c_product_metrics(integer) TO service_role;

COMMENT ON TABLE public.product_metric_epochs IS
  'Versioned start boundaries that prevent pre-instrumentation activity from entering product KPI baselines.';
COMMENT ON FUNCTION public.b2c_product_metrics(integer) IS
  'B2C facts with activation v2: detail plus a durable retention action across two UTC dates within an exact registration+7x24h window.';

DO $postflight$
DECLARE
  v_relation regclass := 'public.product_metric_epochs'::regclass;
  v_function regprocedure := 'public.b2c_product_metrics(integer)'::regprocedure;
  v_role name;
  v_privilege text;
  v_service_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
BEGIN
  IF v_service_role_oid IS NULL THEN
    RAISE EXCEPTION 'service_role is required for the activation metric contract';
  END IF;

  IF NOT (
    SELECT relation.relrowsecurity AND NOT relation.relforcerowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_relation
  ) THEN
    RAISE EXCEPTION 'product_metric_epochs RLS contract is invalid';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM public.product_metric_epochs AS epoch
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM public.product_metric_epochs AS epoch
    WHERE epoch.metric_name = 'activation_7d'
      AND epoch.definition_version = 'v2_detail_retention_two_utc_days'
      AND epoch.started_at IS NOT NULL
      AND epoch.definition ->> 'window' = 'registration_plus_7x24h'
      AND epoch.definition ->> 'minimum_distinct_utc_dates' = '2'
  ) THEN
    RAISE EXCEPTION 'activation v2 epoch was not installed exactly';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
  LOOP
    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT',
      'INSERT',
      'UPDATE',
      'DELETE',
      'TRUNCATE',
      'REFERENCES',
      'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(v_role, v_relation, v_privilege) THEN
        RAISE EXCEPTION '% unexpectedly has % on product_metric_epochs', v_role, v_privilege;
      END IF;
    END LOOP;

    IF pg_catalog.has_function_privilege(v_role, v_function, 'EXECUTE') THEN
      RAISE EXCEPTION '% unexpectedly executes b2c_product_metrics', v_role;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_table_privilege('service_role', v_relation, 'SELECT') THEN
    RAISE EXCEPTION 'service_role cannot read product_metric_epochs';
  END IF;
  FOREACH v_privilege IN ARRAY ARRAY[
    'INSERT',
    'UPDATE',
    'DELETE',
    'TRUNCATE',
    'REFERENCES',
    'TRIGGER'
  ]::text[]
  LOOP
    IF pg_catalog.has_table_privilege('service_role', v_relation, v_privilege) THEN
      RAISE EXCEPTION 'service_role unexpectedly has % on product_metric_epochs', v_privilege;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE') THEN
    RAISE EXCEPTION 'service_role cannot execute b2c_product_metrics';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid = v_relation
      AND acl_entry.grantee = 0::oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) AS acl_entry
    WHERE procedure.oid = v_function
      AND acl_entry.grantee = 0::oid
  ) THEN
    RAISE EXCEPTION 'PUBLIC privileges remain on activation metric objects';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = v_relation
      AND policy.polname = 'Service reads product metric epochs'
      AND policy.polpermissive
      AND policy.polcmd = 'r'
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND policy.polwithcheck IS NULL
  ) THEN
    RAISE EXCEPTION 'product_metric_epochs policy was not installed exactly';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_function
      AND procedure.prosecdef
      AND procedure.provolatile = 's'
      AND procedure.proowner = (
        SELECT relation.relowner
        FROM pg_catalog.pg_class AS relation
        WHERE relation.oid = v_relation
      )
      AND procedure.proconfig = ARRAY['search_path=pg_catalog, pg_temp']::text[]
  ) THEN
    RAISE EXCEPTION 'b2c_product_metrics function security contract is invalid';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = procedure.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND procedure.proname = 'b2c_product_metrics'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    WHERE procedure.oid = v_function
  ) THEN
    RAISE EXCEPTION 'b2c_product_metrics overload inventory is not exact';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid = v_relation
      AND acl_entry.grantee <> relation.relowner
      AND NOT (
        acl_entry.grantee = v_service_role_oid
        AND acl_entry.privilege_type = 'SELECT'
        AND NOT acl_entry.is_grantable
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS procedure
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(procedure.proacl, pg_catalog.acldefault('f', procedure.proowner))
    ) AS acl_entry
    WHERE procedure.oid = v_function
      AND acl_entry.grantee <> procedure.proowner
      AND NOT (
        acl_entry.grantee = v_service_role_oid
        AND acl_entry.privilege_type = 'EXECUTE'
        AND NOT acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'activation metric direct ACL inventory is not exact';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
