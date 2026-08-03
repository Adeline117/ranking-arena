-- Atomic trader-alert configuration authority.
--
-- The previous API performed existence, per-user count, and INSERT as separate
-- statements. Concurrent requests could both observe 49 alerts and commit the
-- 50th and 51st rows. Authenticated table DML also bypassed the API limit.
-- This migration serializes each user's mutations, enforces the hard cap at
-- the table boundary, and exposes exact authenticated RPC acknowledgements.

BEGIN;

DO $preflight$
BEGIN
  IF pg_catalog.to_regclass('public.trader_alerts') IS NULL THEN
    RAISE EXCEPTION 'public.trader_alerts is required';
  END IF;
  IF pg_catalog.to_regclass('public.user_profiles') IS NULL THEN
    RAISE EXCEPTION 'public.user_profiles is required';
  END IF;
  IF pg_catalog.to_regprocedure(
    'public.has_current_global_pro_entitlement(uuid)'
  ) IS NULL THEN
    RAISE EXCEPTION 'current global Pro entitlement authority is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = constraint_row.conindid
    WHERE constraint_row.conrelid = 'public.trader_alerts'::pg_catalog.regclass
      AND constraint_row.contype = 'u'
      AND index_row.indisunique
      AND index_row.indnullsnotdistinct
      AND (
        SELECT pg_catalog.array_agg(attribute_row.attname::text ORDER BY key_row.ordinality)
        FROM pg_catalog.unnest(constraint_row.conkey)
          WITH ORDINALITY AS key_row(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute_row
          ON attribute_row.attrelid = constraint_row.conrelid
         AND attribute_row.attnum = key_row.attnum
      ) = ARRAY['user_id', 'trader_id', 'source']
  ) THEN
    RAISE EXCEPTION 'trader alerts require exact NULLS NOT DISTINCT identity uniqueness';
  END IF;

  IF EXISTS (
    SELECT alert_row.user_id
    FROM public.trader_alerts AS alert_row
    GROUP BY alert_row.user_id
    HAVING pg_catalog.count(*) > 50
  ) THEN
    RAISE EXCEPTION 'trader alerts contain a user above the hard capacity';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.enforce_trader_alert_insert_limit()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_count integer;
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
    OR TG_TABLE_NAME IS DISTINCT FROM 'trader_alerts'
    OR TG_OP IS DISTINCT FROM 'INSERT'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'trader alert capacity guard is misattached';
  END IF;

  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23502',
      MESSAGE = 'trader alert owner is required';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'atomic-trader-alert-user:' || NEW.user_id::text,
      0
    )
  );

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_count
  FROM public.trader_alerts AS alert_row
  WHERE alert_row.user_id = NEW.user_id;

  IF v_count >= 50 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'maximum 50 trader alerts allowed',
      CONSTRAINT = 'trader_alerts_user_limit';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.enforce_trader_alert_insert_limit() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_trader_alert_insert_limit()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

DROP TRIGGER IF EXISTS enforce_trader_alert_insert_limit
  ON public.trader_alerts;
CREATE TRIGGER enforce_trader_alert_insert_limit
BEFORE INSERT ON public.trader_alerts
FOR EACH ROW
EXECUTE FUNCTION public.enforce_trader_alert_insert_limit();

CREATE OR REPLACE FUNCTION public.upsert_trader_alert_atomic(
  p_trader_id text,
  p_source text,
  p_expected_alert_id uuid,
  p_alert_roi_change boolean,
  p_roi_change_threshold numeric,
  p_alert_drawdown boolean,
  p_drawdown_threshold numeric,
  p_alert_pnl_change boolean,
  p_pnl_change_threshold numeric,
  p_alert_score_change boolean,
  p_score_change_threshold numeric,
  p_alert_rank_change boolean,
  p_rank_change_threshold integer,
  p_one_time boolean,
  p_enabled boolean
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_actor_id uuid := (SELECT auth.uid());
  v_alert public.trader_alerts%ROWTYPE;
  v_count integer;
  v_existing_id uuid;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'authenticated role required' USING ERRCODE = '42501';
  END IF;

  IF v_actor_id IS NULL
    OR p_trader_id IS NULL
    OR pg_catalog.length(p_trader_id) NOT BETWEEN 1 AND 512
    OR p_trader_id IS DISTINCT FROM pg_catalog.btrim(p_trader_id)
    OR p_trader_id ~ '[[:cntrl:]]'
    OR (
      p_source IS NOT NULL
      AND (
        pg_catalog.length(p_source) NOT BETWEEN 1 AND 64
        OR p_source IS DISTINCT FROM pg_catalog.btrim(p_source)
        OR p_source ~ '[[:cntrl:]]'
      )
    )
    OR p_alert_roi_change IS NULL
    OR p_roi_change_threshold IS NULL
    OR p_roi_change_threshold::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_roi_change_threshold NOT BETWEEN 0 AND 100
    OR p_alert_drawdown IS NULL
    OR p_drawdown_threshold IS NULL
    OR p_drawdown_threshold::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_drawdown_threshold NOT BETWEEN 0 AND 100
    OR p_alert_pnl_change IS NULL
    OR p_pnl_change_threshold IS NULL
    OR p_pnl_change_threshold::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_pnl_change_threshold NOT BETWEEN 0 AND 1000000000000000
    OR p_alert_score_change IS NULL
    OR p_score_change_threshold IS NULL
    OR p_score_change_threshold::text IN ('NaN', 'Infinity', '-Infinity')
    OR p_score_change_threshold NOT BETWEEN 0 AND 100
    OR p_alert_rank_change IS NULL
    OR p_rank_change_threshold IS NULL
    OR p_rank_change_threshold NOT BETWEEN 0 AND 1000000
    OR p_one_time IS NULL
    OR p_enabled IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'atomic-trader-alert-user:' || v_actor_id::text,
      0
    )
  );

  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id = v_actor_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  IF NOT public.has_current_global_pro_entitlement(v_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  SELECT alert_row.id
  INTO v_existing_id
  FROM public.trader_alerts AS alert_row
  WHERE alert_row.user_id = v_actor_id
    AND alert_row.trader_id = p_trader_id
    AND alert_row.source IS NOT DISTINCT FROM p_source
  FOR UPDATE;

  IF p_expected_alert_id IS NOT NULL
    AND v_existing_id IS DISTINCT FROM p_expected_alert_id
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'conflict');
  END IF;

  IF v_existing_id IS NULL THEN
    SELECT pg_catalog.count(*)::integer
    INTO STRICT v_count
    FROM public.trader_alerts AS alert_row
    WHERE alert_row.user_id = v_actor_id;

    IF v_count >= 50 THEN
      RETURN pg_catalog.jsonb_build_object(
        'status', 'limit_reached',
        'current_count', v_count,
        'limit', 50
      );
    END IF;

    INSERT INTO public.trader_alerts (
      user_id,
      trader_id,
      source,
      alert_roi_change,
      roi_change_threshold,
      alert_drawdown,
      drawdown_threshold,
      alert_pnl_change,
      pnl_change_threshold,
      alert_score_change,
      score_change_threshold,
      alert_rank_change,
      rank_change_threshold,
      one_time,
      enabled
    ) VALUES (
      v_actor_id,
      p_trader_id,
      p_source,
      p_alert_roi_change,
      p_roi_change_threshold,
      p_alert_drawdown,
      p_drawdown_threshold,
      p_alert_pnl_change,
      p_pnl_change_threshold,
      p_alert_score_change,
      p_score_change_threshold,
      p_alert_rank_change,
      p_rank_change_threshold,
      p_one_time,
      p_enabled
    )
    RETURNING * INTO STRICT v_alert;
    v_status := 'created';
  ELSE
    UPDATE public.trader_alerts AS alert_row
    SET alert_roi_change = p_alert_roi_change,
        roi_change_threshold = p_roi_change_threshold,
        alert_drawdown = p_alert_drawdown,
        drawdown_threshold = p_drawdown_threshold,
        alert_pnl_change = p_alert_pnl_change,
        pnl_change_threshold = p_pnl_change_threshold,
        alert_score_change = p_alert_score_change,
        score_change_threshold = p_score_change_threshold,
        alert_rank_change = p_alert_rank_change,
        rank_change_threshold = p_rank_change_threshold,
        one_time = p_one_time,
        enabled = p_enabled,
        updated_at = pg_catalog.statement_timestamp()
    WHERE alert_row.id = v_existing_id
      AND alert_row.user_id = v_actor_id
    RETURNING alert_row.* INTO STRICT v_alert;
    v_status := 'updated';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_count
  FROM public.trader_alerts AS alert_row
  WHERE alert_row.user_id = v_actor_id;

  IF v_count NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'trader alert authority returned an impossible capacity';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_status,
    'user_id', v_actor_id,
    'current_count', v_count,
    'limit', 50,
    'alert', pg_catalog.jsonb_build_object(
      'id', v_alert.id,
      'user_id', v_alert.user_id,
      'trader_id', v_alert.trader_id,
      'source', v_alert.source,
      'alert_roi_change', v_alert.alert_roi_change,
      'roi_change_threshold', v_alert.roi_change_threshold,
      'alert_drawdown', v_alert.alert_drawdown,
      'drawdown_threshold', v_alert.drawdown_threshold,
      'alert_pnl_change', v_alert.alert_pnl_change,
      'pnl_change_threshold', v_alert.pnl_change_threshold,
      'alert_score_change', v_alert.alert_score_change,
      'score_change_threshold', v_alert.score_change_threshold,
      'alert_rank_change', v_alert.alert_rank_change,
      'rank_change_threshold', v_alert.rank_change_threshold,
      'one_time', v_alert.one_time,
      'enabled', v_alert.enabled,
      'created_at', v_alert.created_at,
      'updated_at', v_alert.updated_at
    )
  );
END
$function$;

ALTER FUNCTION public.upsert_trader_alert_atomic(
  text,
  text,
  uuid,
  boolean,
  numeric,
  boolean,
  numeric,
  boolean,
  numeric,
  boolean,
  numeric,
  boolean,
  integer,
  boolean,
  boolean
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.upsert_trader_alert_atomic(
  text,
  text,
  uuid,
  boolean,
  numeric,
  boolean,
  numeric,
  boolean,
  numeric,
  boolean,
  numeric,
  boolean,
  integer,
  boolean,
  boolean
) FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.upsert_trader_alert_atomic(
  text,
  text,
  uuid,
  boolean,
  numeric,
  boolean,
  numeric,
  boolean,
  numeric,
  boolean,
  numeric,
  boolean,
  integer,
  boolean,
  boolean
) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_trader_alert_atomic(
  p_alert_id uuid,
  p_trader_id text,
  p_source text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_actor_id uuid := (SELECT auth.uid());
  v_alert public.trader_alerts%ROWTYPE;
  v_count integer;
  v_mutated integer;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'authenticated role required' USING ERRCODE = '42501';
  END IF;

  IF v_actor_id IS NULL
    OR (p_alert_id IS NULL) = (p_trader_id IS NULL)
    OR (p_alert_id IS NOT NULL AND p_source IS NOT NULL)
    OR (
      p_trader_id IS NOT NULL
      AND (
        pg_catalog.length(p_trader_id) NOT BETWEEN 1 AND 512
        OR p_trader_id IS DISTINCT FROM pg_catalog.btrim(p_trader_id)
        OR p_trader_id ~ '[[:cntrl:]]'
      )
    )
    OR (
      p_source IS NOT NULL
      AND (
        pg_catalog.length(p_source) NOT BETWEEN 1 AND 64
        OR p_source IS DISTINCT FROM pg_catalog.btrim(p_source)
        OR p_source ~ '[[:cntrl:]]'
      )
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'atomic-trader-alert-user:' || v_actor_id::text,
      0
    )
  );

  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id = v_actor_id
    AND profile.deleted_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  IF p_alert_id IS NOT NULL THEN
    DELETE FROM public.trader_alerts AS alert_row
    WHERE alert_row.user_id = v_actor_id
      AND alert_row.id = p_alert_id
    RETURNING alert_row.* INTO v_alert;
  ELSE
    DELETE FROM public.trader_alerts AS alert_row
    WHERE alert_row.user_id = v_actor_id
      AND alert_row.trader_id = p_trader_id
      AND alert_row.source IS NOT DISTINCT FROM p_source
    RETURNING alert_row.* INTO v_alert;
  END IF;
  GET DIAGNOSTICS v_mutated = ROW_COUNT;

  IF v_mutated = 1 THEN
    v_status := 'deleted';
  ELSIF v_mutated = 0 THEN
    v_status := 'not_found';
  ELSE
    RAISE EXCEPTION 'trader alert delete mutated an impossible row count';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_count
  FROM public.trader_alerts AS alert_row
  WHERE alert_row.user_id = v_actor_id;

  IF v_count NOT BETWEEN 0 AND 50 THEN
    RAISE EXCEPTION 'trader alert delete returned an impossible capacity';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_status,
    'user_id', v_actor_id,
    'alert_id', CASE WHEN v_mutated = 1 THEN v_alert.id ELSE p_alert_id END,
    'trader_id', CASE WHEN v_mutated = 1 THEN v_alert.trader_id ELSE p_trader_id END,
    'source', CASE WHEN v_mutated = 1 THEN v_alert.source ELSE p_source END,
    'deleted_count', v_mutated,
    'current_count', v_count,
    'limit', 50
  );
END
$function$;

ALTER FUNCTION public.delete_trader_alert_atomic(uuid, text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.delete_trader_alert_atomic(uuid, text, text)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
GRANT EXECUTE ON FUNCTION public.delete_trader_alert_atomic(uuid, text, text)
  TO authenticated;

-- All browser writes now cross the RPC boundary. Service-owned cron delivery
-- and account-deletion maintenance retain their trusted table privileges.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.trader_alerts
  FROM anon, authenticated, authenticator;

COMMENT ON FUNCTION public.upsert_trader_alert_atomic(
  text,
  text,
  uuid,
  boolean,
  numeric,
  boolean,
  numeric,
  boolean,
  numeric,
  boolean,
  numeric,
  boolean,
  integer,
  boolean,
  boolean
) IS
  'Authenticated atomic create/update authority for one exact trader+source alert identity; serializes and returns the same-transaction 50-row capacity.';
COMMENT ON FUNCTION public.delete_trader_alert_atomic(uuid, text, text) IS
  'Authenticated exact alert delete authority; an id or one trader+source identity deletes at most one owned row and returns its same-transaction acknowledgement.';

NOTIFY pgrst, 'reload schema';

COMMIT;
