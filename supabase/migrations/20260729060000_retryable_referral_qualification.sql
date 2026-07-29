-- Qualify one referral and settle its friend/advocate Pro grants as one
-- retryable transaction. Qualification markers must never outrun financial
-- authority, and a failed grant must leave an explicit pending candidate.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('retryable-referral-qualification-migration', 0)
);

DO $preflight$
DECLARE
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_attribution_columns integer;
  v_reward_columns integer;
BEGIN
  IF v_postgres IS NULL
    OR pg_catalog.to_regrole('service_role') IS NULL
    OR pg_catalog.to_regrole('anon') IS NULL
    OR pg_catalog.to_regrole('authenticated') IS NULL
    OR pg_catalog.to_regrole('authenticator') IS NULL
    OR pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.grant_pro_entitlement_days_atomic(uuid,text,text,integer,timestamp with time zone,jsonb)'
    ) IS NULL
  THEN
    RAISE EXCEPTION
      'retryable referral qualification dependencies are unavailable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_profiles', 'created_at', 'timestamptz'::pg_catalog.regtype, true),
        ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_profiles', 'onboarding_completed', 'bool'::pg_catalog.regtype, false),
        ('user_profiles', 'linked_trader_count', 'int4'::pg_catalog.regtype, false),
        ('referral_attributions', 'id', 'uuid'::pg_catalog.regtype, true),
        ('referral_attributions', 'referred_id', 'uuid'::pg_catalog.regtype, true),
        ('referral_attributions', 'referrer_id', 'uuid'::pg_catalog.regtype, true),
        ('referral_attributions', 'signup_ip_hash', 'text'::pg_catalog.regtype, false),
        ('referral_attributions', 'friend_granted', 'bool'::pg_catalog.regtype, true),
        ('referral_attributions', 'qualified_at', 'timestamptz'::pg_catalog.regtype, false),
        ('referral_attributions', 'created_at', 'timestamptz'::pg_catalog.regtype, true),
        ('referral_rewards', 'id', 'uuid'::pg_catalog.regtype, true),
        ('referral_rewards', 'referrer_id', 'uuid'::pg_catalog.regtype, true),
        ('referral_rewards', 'reward_type', 'text'::pg_catalog.regtype, true),
        ('referral_rewards', 'granted_days', 'int4'::pg_catalog.regtype, false),
        ('referral_rewards', 'created_at', 'timestamptz'::pg_catalog.regtype, true)
    ) AS required_column(table_name, column_name, type_oid, must_be_not_null)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      WHERE attribute.attrelid =
          pg_catalog.to_regclass('public.' || required_column.table_name)
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND relation.relowner = v_postgres
        AND attribute.attname = required_column.column_name
        AND attribute.atttypid = required_column.type_oid
        AND attribute.atttypmod = -1
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND (
          NOT required_column.must_be_not_null
          OR attribute.attnotnull
        )
    )
  ) THEN
    RAISE EXCEPTION 'retryable referral qualification schema is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.referral_rewards'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname
          ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attribute_number, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attribute_number
      ) = ARRAY['referrer_id', 'reward_type']::name[]
  ) THEN
    RAISE EXCEPTION
      'retryable referral qualification requires unique advocate reward identity';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_attribution_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid =
      'public.referral_attributions'::pg_catalog.regclass
    AND attribute.attname IN (
      'friend_grant_status',
      'advocate_evaluated_at',
      'qualification_checked_at'
    )
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  IF v_attribution_columns NOT IN (0, 3) THEN
    RAISE EXCEPTION
      'retryable referral attribution columns were partially applied';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_reward_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.referral_rewards'::pg_catalog.regclass
    AND attribute.attname = 'entitlement_granted_at'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  IF v_reward_columns NOT IN (0, 1) THEN
    RAISE EXCEPTION
      'retryable referral reward columns were partially applied';
  END IF;
END
$preflight$;

ALTER TABLE public.referral_attributions
  ADD COLUMN IF NOT EXISTS friend_grant_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS advocate_evaluated_at timestamptz,
  ADD COLUMN IF NOT EXISTS qualification_checked_at timestamptz;

ALTER TABLE public.referral_attributions
  DROP CONSTRAINT IF EXISTS referral_attributions_friend_grant_status_valid;
ALTER TABLE public.referral_attributions
  ADD CONSTRAINT referral_attributions_friend_grant_status_valid
  CHECK (
    friend_grant_status IN ('pending', 'granted', 'capped', 'disabled')
    AND (
      NOT friend_granted
      OR friend_grant_status IN ('pending', 'granted')
    )
    AND (
      friend_grant_status <> 'granted'
      OR friend_granted
    )
  ) NOT VALID;
ALTER TABLE public.referral_attributions
  VALIDATE CONSTRAINT referral_attributions_friend_grant_status_valid;

ALTER TABLE public.referral_rewards
  ADD COLUMN IF NOT EXISTS entitlement_granted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_referral_attributions_qualification_pending
  ON public.referral_attributions (
    qualification_checked_at ASC NULLS FIRST,
    created_at,
    id
  )
  WHERE qualified_at IS NULL
    OR friend_grant_status = 'pending'
    OR advocate_evaluated_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_referral_rewards_entitlement_pending
  ON public.referral_rewards (created_at, id)
  WHERE entitlement_granted_at IS NULL;

CREATE OR REPLACE FUNCTION public.claim_referral_qualification_candidates_atomic(
  p_now timestamptz,
  p_limit integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_candidates jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_now IS NULL
    OR p_now IS DISTINCT FROM pg_catalog.date_trunc('milliseconds', p_now)
    OR p_now < pg_catalog.statement_timestamp() - pg_catalog.make_interval(mins => 5)
    OR p_now > pg_catalog.statement_timestamp() + pg_catalog.make_interval(mins => 5)
    OR p_limit IS NULL
    OR p_limit NOT BETWEEN 1 AND 500
  THEN
    RETURN NULL;
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('referral-qualification-authority', 0)
  );

  WITH candidates AS (
    SELECT attribution.id
    FROM public.referral_attributions AS attribution
    WHERE attribution.qualified_at IS NULL
      OR attribution.friend_grant_status = 'pending'
      OR attribution.advocate_evaluated_at IS NULL
    ORDER BY
      attribution.qualification_checked_at ASC NULLS FIRST,
      attribution.created_at,
      attribution.id
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  ),
  claimed AS (
    UPDATE public.referral_attributions AS attribution
    SET qualification_checked_at = p_now
    FROM candidates
    WHERE attribution.id = candidates.id
    RETURNING attribution.id
  )
  SELECT COALESCE(
    pg_catalog.jsonb_agg(
      pg_catalog.jsonb_build_object('id', claimed.id)
      ORDER BY claimed.id
    ),
    '[]'::jsonb
  )
  INTO STRICT v_candidates
  FROM claimed;

  RETURN v_candidates;
END
$function$;

CREATE OR REPLACE FUNCTION public.qualify_referral_attribution_atomic(
  p_attribution_id uuid,
  p_now timestamptz,
  p_min_age_hours integer,
  p_friend_days integer,
  p_device_cap integer,
  p_advocate_threshold integer,
  p_advocate_days integer
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_attribution public.referral_attributions%ROWTYPE;
  v_referred_profile public.user_profiles%ROWTYPE;
  v_reward public.referral_rewards%ROWTYPE;
  v_grant_ack jsonb;
  v_friend_status text;
  v_advocate_status text := 'pending';
  v_was_qualified boolean;
  v_device_grants integer := 0;
  v_qualified_count integer := 0;
  v_first_qualified_created_at timestamptz;
  v_last_qualified_created_at timestamptz;
  v_qualified_window_minutes numeric;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_attribution_id IS NULL
    OR p_now IS NULL
    OR p_now IS DISTINCT FROM pg_catalog.date_trunc('milliseconds', p_now)
    OR p_now < pg_catalog.statement_timestamp() - pg_catalog.make_interval(mins => 5)
    OR p_now > pg_catalog.statement_timestamp() + pg_catalog.make_interval(mins => 5)
    OR p_min_age_hours IS NULL
    OR p_min_age_hours NOT BETWEEN 0 AND 8760
    OR p_friend_days IS NULL
    OR p_friend_days NOT BETWEEN 0 AND 3650
    OR p_device_cap IS NULL
    OR p_device_cap NOT BETWEEN 1 AND 1000
    OR p_advocate_threshold IS NULL
    OR p_advocate_threshold NOT BETWEEN 1 AND 1000
    OR p_advocate_days IS NULL
    OR p_advocate_days NOT BETWEEN 1 AND 3650
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  -- This global authority lock keeps device caps, distinct-device thresholds,
  -- marker creation, and both entitlement grants in one deterministic order.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('referral-qualification-authority', 0)
  );

  SELECT attribution.*
  INTO v_attribution
  FROM public.referral_attributions AS attribution
  WHERE attribution.id = p_attribution_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id IN (
    v_attribution.referred_id,
    v_attribution.referrer_id
  )
  ORDER BY profile.id
  FOR UPDATE;

  SELECT profile.*
  INTO v_referred_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = v_attribution.referred_id
    AND profile.deleted_at IS NULL;
  IF NOT FOUND OR NOT EXISTS (
    SELECT 1
    FROM public.user_profiles AS referrer
    WHERE referrer.id = v_attribution.referrer_id
      AND referrer.deleted_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'owner_unavailable',
      'attribution_id', v_attribution.id
    );
  END IF;

  IF v_referred_profile.onboarding_completed IS DISTINCT FROM true
    OR (
      COALESCE(v_referred_profile.linked_trader_count, 0) <= 0
      AND v_referred_profile.created_at >
          p_now - pg_catalog.make_interval(hours => p_min_age_hours)
    )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'not_eligible',
      'attribution_id', v_attribution.id
    );
  END IF;

  v_was_qualified := v_attribution.qualified_at IS NOT NULL;
  IF NOT v_was_qualified THEN
    UPDATE public.referral_attributions AS attribution
    SET qualified_at = p_now
    WHERE attribution.id = v_attribution.id
      AND attribution.qualified_at IS NULL
    RETURNING attribution.* INTO STRICT v_attribution;
  END IF;

  IF v_attribution.friend_grant_status = 'granted' THEN
    v_friend_status := 'already_granted';
  ELSIF v_attribution.friend_grant_status IN ('capped', 'disabled') THEN
    v_friend_status := v_attribution.friend_grant_status;
  ELSIF p_friend_days = 0 THEN
    UPDATE public.referral_attributions AS attribution
    SET friend_granted = false,
        friend_grant_status = 'disabled'
    WHERE attribution.id = v_attribution.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'friend reward disable matched no attribution'
        USING ERRCODE = 'P0002';
    END IF;
    v_friend_status := 'disabled';
  ELSE
    IF v_attribution.signup_ip_hash IS NOT NULL
      AND NOT v_attribution.friend_granted
    THEN
      SELECT pg_catalog.count(*)::integer
      INTO v_device_grants
      FROM public.referral_attributions AS attribution
      WHERE attribution.id <> v_attribution.id
        AND attribution.signup_ip_hash = v_attribution.signup_ip_hash
        AND (
          attribution.friend_granted
          OR attribution.friend_grant_status = 'granted'
        );
    END IF;

    IF v_attribution.signup_ip_hash IS NOT NULL
      AND NOT v_attribution.friend_granted
      AND v_device_grants >= p_device_cap
    THEN
      UPDATE public.referral_attributions AS attribution
      SET friend_granted = false,
          friend_grant_status = 'capped'
      WHERE attribution.id = v_attribution.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'friend reward cap matched no attribution'
          USING ERRCODE = 'P0002';
      END IF;
      v_friend_status := 'capped';
    ELSE
      v_grant_ack := public.grant_pro_entitlement_days_atomic(
        v_attribution.referred_id,
        'referral',
        'friend:' || v_attribution.id::text,
        p_friend_days,
        v_attribution.created_at,
        pg_catalog.jsonb_build_object(
          'kind', 'friend_trial',
          'attribution_id', v_attribution.id,
          'referred_id', v_attribution.referred_id,
          'referrer_id', v_attribution.referrer_id
        )
      );
      IF pg_catalog.jsonb_typeof(v_grant_ack) IS DISTINCT FROM 'object'
        OR (
          SELECT pg_catalog.count(*)
          FROM pg_catalog.jsonb_object_keys(v_grant_ack)
        ) <> 1
        OR COALESCE(v_grant_ack ->> 'status', '')
            NOT IN ('granted', 'already_granted')
      THEN
        RAISE EXCEPTION 'friend entitlement grant returned invalid status';
      END IF;

      UPDATE public.referral_attributions AS attribution
      SET friend_granted = true,
          friend_grant_status = 'granted'
      WHERE attribution.id = v_attribution.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'friend reward grant matched no attribution'
          USING ERRCODE = 'P0002';
      END IF;
      v_friend_status := v_grant_ack ->> 'status';
    END IF;
  END IF;

  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.min(attribution.created_at),
    pg_catalog.max(attribution.created_at)
  INTO
    v_qualified_count,
    v_first_qualified_created_at,
    v_last_qualified_created_at
  FROM public.referral_attributions AS attribution
  WHERE attribution.referrer_id = v_attribution.referrer_id
    AND attribution.qualified_at IS NOT NULL
  GROUP BY attribution.referrer_id;

  IF v_qualified_count > 0 THEN
    v_qualified_window_minutes :=
      EXTRACT(
        EPOCH FROM (
          v_last_qualified_created_at - v_first_qualified_created_at
        )
      ) / 60;
  END IF;

  IF (
    SELECT pg_catalog.count(DISTINCT COALESCE(
      attribution.signup_ip_hash,
      'row:' || attribution.id::text
    ))
    FROM public.referral_attributions AS attribution
    WHERE attribution.referrer_id = v_attribution.referrer_id
      AND attribution.qualified_at IS NOT NULL
  ) >= p_advocate_threshold
  THEN
    SELECT reward.*
    INTO v_reward
    FROM public.referral_rewards AS reward
    WHERE reward.referrer_id = v_attribution.referrer_id
      AND reward.reward_type = 'advocate_milestone'
    FOR UPDATE;

    IF NOT FOUND THEN
      INSERT INTO public.referral_rewards (
        referrer_id,
        reward_type,
        granted_days
      ) VALUES (
        v_attribution.referrer_id,
        'advocate_milestone',
        p_advocate_days
      )
      RETURNING * INTO STRICT v_reward;
    ELSIF v_reward.granted_days IS DISTINCT FROM p_advocate_days THEN
      RAISE EXCEPTION 'advocate reward policy conflicts with durable marker';
    END IF;

    IF v_reward.entitlement_granted_at IS NOT NULL THEN
      v_advocate_status := 'already_granted';
    ELSE
      v_grant_ack := public.grant_pro_entitlement_days_atomic(
        v_attribution.referrer_id,
        'referral',
        'advocate:' || v_reward.id::text,
        p_advocate_days,
        v_reward.created_at,
        pg_catalog.jsonb_build_object(
          'kind', 'advocate_milestone',
          'referral_reward_id', v_reward.id,
          'referrer_id', v_attribution.referrer_id,
          'threshold', p_advocate_threshold
        )
      );
      IF pg_catalog.jsonb_typeof(v_grant_ack) IS DISTINCT FROM 'object'
        OR (
          SELECT pg_catalog.count(*)
          FROM pg_catalog.jsonb_object_keys(v_grant_ack)
        ) <> 1
        OR COALESCE(v_grant_ack ->> 'status', '')
            NOT IN ('granted', 'already_granted')
      THEN
        RAISE EXCEPTION 'advocate entitlement grant returned invalid status';
      END IF;

      UPDATE public.referral_rewards AS reward
      SET entitlement_granted_at = p_now
      WHERE reward.id = v_reward.id
        AND reward.entitlement_granted_at IS NULL
      RETURNING reward.* INTO STRICT v_reward;
      v_advocate_status := v_grant_ack ->> 'status';
    END IF;
  END IF;

  UPDATE public.referral_attributions AS attribution
  SET advocate_evaluated_at = p_now
  WHERE attribution.id = v_attribution.id
  RETURNING attribution.* INTO STRICT v_attribution;

  RETURN pg_catalog.jsonb_build_object(
    'status', CASE
      WHEN v_was_qualified THEN 'already_qualified'
      ELSE 'qualified'
    END,
    'attribution_id', v_attribution.id,
    'referred_id', v_attribution.referred_id,
    'referrer_id', v_attribution.referrer_id,
    'qualified_at', v_attribution.qualified_at,
    'friend_status', v_friend_status,
    'advocate_status', v_advocate_status,
    'advocate_reward_id', v_reward.id,
    'qualified_referral_count', v_qualified_count,
    'qualified_window_minutes', v_qualified_window_minutes
  );
END
$function$;

ALTER FUNCTION public.qualify_referral_attribution_atomic(
  uuid,
  timestamptz,
  integer,
  integer,
  integer,
  integer,
  integer
) OWNER TO postgres;

ALTER FUNCTION public.claim_referral_qualification_candidates_atomic(
  timestamptz,
  integer
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.claim_referral_qualification_candidates_atomic(
  timestamptz,
  integer
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.claim_referral_qualification_candidates_atomic(
  timestamptz,
  integer
) TO service_role;

REVOKE ALL ON FUNCTION public.qualify_referral_attribution_atomic(
  uuid,
  timestamptz,
  integer,
  integer,
  integer,
  integer,
  integer
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.qualify_referral_attribution_atomic(
  uuid,
  timestamptz,
  integer,
  integer,
  integer,
  integer,
  integer
) TO service_role;

COMMIT;
