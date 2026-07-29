-- Administrator bans are account-lifecycle transitions, not two unrelated
-- PostgREST writes.  Serialize them with deletion, recovery, hard deletion,
-- request admission, and temporary-ban expiry, then commit the profile state
-- and its audit record in one transaction.

DO $preflight$
DECLARE
  v_column record;
BEGIN
  IF pg_catalog.to_regprocedure(
    'public.set_admin_user_sanction_atomic(uuid,uuid,text,text)'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'atomic administrator user sanctions already exist';
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
    OR pg_catalog.to_regclass('public.user_profiles') IS NULL
    OR pg_catalog.to_regclass('public.admin_logs') IS NULL
    OR pg_catalog.to_regprocedure('auth.role()') IS NULL
    OR pg_catalog.to_regprocedure(
      'public.lock_account_lifecycle_subject_transition()'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'atomic administrator user sanction prerequisites are missing';
  END IF;

  FOR v_column IN
    SELECT *
    FROM (VALUES
      ('user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
      ('user_profiles', 'handle', 'text'::pg_catalog.regtype, true),
      ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
      ('user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype, false),
      ('user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype, true),
      ('user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype, false),
      ('user_profiles', 'banned_reason', 'text'::pg_catalog.regtype, false),
      ('user_profiles', 'banned_by', 'uuid'::pg_catalog.regtype, false),
      ('admin_logs', 'admin_id', 'uuid'::pg_catalog.regtype, true),
      ('admin_logs', 'action', 'text'::pg_catalog.regtype, true),
      ('admin_logs', 'target_type', 'text'::pg_catalog.regtype, false),
      ('admin_logs', 'target_id', 'uuid'::pg_catalog.regtype, false),
      ('admin_logs', 'details', 'jsonb'::pg_catalog.regtype, false)
    ) AS required_column(table_name, column_name, column_type, is_not_null)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = pg_catalog.to_regclass(
          'public.' || v_column.table_name
        )
        AND attribute.attname = v_column.column_name
        AND attribute.atttypid = v_column.column_type
        AND attribute.attnotnull IS NOT DISTINCT FROM v_column.is_not_null
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) THEN
      RAISE EXCEPTION 'atomic administrator user sanction column contract drifted: %.%',
        v_column.table_name,
        v_column.column_name;
    END IF;
  END LOOP;
END
$preflight$;

-- A legacy direct writer can already own the profile tuple by the time this
-- BEFORE ROW trigger runs.  Waiting for the lifecycle advisory lock there can
-- deadlock with a canonical lifecycle operation that acquired the advisory
-- lock first and is waiting for that tuple.  Canonical writers re-enter the
-- lock successfully; legacy inverted writers fail with a retryable conflict.
CREATE OR REPLACE FUNCTION public.lock_account_lifecycle_subject_transition()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_subject_id uuid;
BEGIN
  IF TG_LEVEL IS DISTINCT FROM 'ROW'
    OR TG_WHEN IS DISTINCT FROM 'BEFORE'
    OR TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
    OR TG_TABLE_NAME IS DISTINCT FROM 'user_profiles'
    OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')
  THEN
    RAISE EXCEPTION 'account lifecycle lock is attached outside its contract'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_subject_id := OLD.id;
  ELSE
    v_subject_id := NEW.id;
  END IF;
  IF v_subject_id IS NULL
    OR TG_OP = 'UPDATE' AND OLD.id IS DISTINCT FROM NEW.id
  THEN
    RAISE EXCEPTION 'account lifecycle subject identity is invalid'
      USING ERRCODE = '22023';
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_subject_id::text,
      0
    )
  ) THEN
    RAISE EXCEPTION 'account lifecycle transition conflicts with a canonical writer'
      USING ERRCODE = '40001';
  END IF;

  -- Keep every future writer on one representation even while old report and
  -- service helpers still name only the modern or only the legacy fields.
  -- Clearing a persistent modern marker is an explicit unban and therefore
  -- clears all attached metadata; setting either active representation makes
  -- both admission paths agree immediately.
  IF TG_OP IS DISTINCT FROM 'DELETE' THEN
    IF NEW.banned_at IS NOT NULL THEN
      NEW.is_banned := true;
    ELSIF TG_OP = 'UPDATE' AND OLD.banned_at IS NOT NULL THEN
      NEW.is_banned := false;
      NEW.ban_expires_at := NULL;
      NEW.banned_reason := NULL;
      NEW.banned_by := NULL;
    ELSIF COALESCE(NEW.is_banned, false)
      AND (
        NEW.ban_expires_at IS NULL
        OR NEW.ban_expires_at > pg_catalog.clock_timestamp()
      )
    THEN
      NEW.banned_at := pg_catalog.clock_timestamp();
    ELSIF NOT COALESCE(NEW.is_banned, false) THEN
      NEW.ban_expires_at := NULL;
      NEW.banned_reason := NULL;
      NEW.banned_by := NULL;
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

ALTER FUNCTION public.lock_account_lifecycle_subject_transition()
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.lock_account_lifecycle_subject_transition()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

CREATE FUNCTION public.set_admin_user_sanction_atomic(
  p_actor_id uuid,
  p_target_id uuid,
  p_action text,
  p_reason text DEFAULT NULL
)
RETURNS TABLE (
  applied boolean,
  result_action text,
  status text,
  result_target_id uuid,
  target_handle text
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_affected_count integer;
  v_actor public.user_profiles%ROWTYPE;
  v_actor_auth_locked boolean := false;
  v_now timestamptz;
  v_profile public.user_profiles%ROWTYPE;
  v_reason text := NULLIF(pg_catalog.btrim(p_reason), '');
  v_target public.user_profiles%ROWTYPE;
  v_target_auth_locked boolean := false;
  v_user_id uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required'
      USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL
    OR p_target_id IS NULL
    OR p_action NOT IN ('ban', 'unban')
    OR p_actor_id = p_target_id
    OR pg_catalog.length(v_reason) > 1000
  THEN
    RAISE EXCEPTION 'invalid administrator user sanction input'
      USING ERRCODE = '22023';
  END IF;

  -- Opposing A -> B and B -> A sanctions acquire both lifecycle keys in the
  -- same UUID order.  A single-user deletion/recovery/expiry operation needs
  -- only its own key and therefore composes with this order.
  FOR v_user_id IN
    SELECT required_id
    FROM pg_catalog.unnest(ARRAY[p_actor_id, p_target_id]) AS required(required_id)
    ORDER BY required_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'account-recovery-admission:' || v_user_id::text,
        0
      )
    );
  END LOOP;

  v_now := pg_catalog.clock_timestamp();

  -- Lock Auth parents, then profiles, in the same global UUID order.  This
  -- makes a concurrent Auth deletion either finish first or wait until the
  -- complete sanction and audit transaction commits.
  FOR v_user_id IN
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id = ANY (ARRAY[p_actor_id, p_target_id])
    ORDER BY auth_user.id
    FOR SHARE
  LOOP
    IF v_user_id = p_actor_id THEN
      v_actor_auth_locked := true;
    END IF;
    IF v_user_id = p_target_id THEN
      v_target_auth_locked := true;
    END IF;
  END LOOP;

  FOR v_profile IN
    SELECT profile.*
    FROM public.user_profiles AS profile
    WHERE profile.id = ANY (ARRAY[p_actor_id, p_target_id])
    ORDER BY profile.id
    FOR UPDATE
  LOOP
    IF v_profile.id = p_actor_id THEN
      v_actor := v_profile;
    END IF;
    IF v_profile.id = p_target_id THEN
      v_target := v_profile;
    END IF;
  END LOOP;

  IF NOT v_actor_auth_locked
    OR v_actor.id IS NULL
    OR v_actor.deleted_at IS NOT NULL
    OR v_actor.banned_at IS NOT NULL
    OR (
      COALESCE(v_actor.is_banned, false)
      AND (
        v_actor.ban_expires_at IS NULL
        OR v_actor.ban_expires_at > v_now
      )
    )
  THEN
    RAISE EXCEPTION 'active administrator identity required'
      USING ERRCODE = '42501';
  END IF;

  IF NOT v_target_auth_locked OR v_target.id IS NULL THEN
    RETURN QUERY SELECT
      false,
      p_action,
      'not_found'::text,
      p_target_id,
      NULL::text;
    RETURN;
  END IF;

  IF v_target.deleted_at IS NOT NULL THEN
    RETURN QUERY SELECT
      false,
      p_action,
      'target_deleted'::text,
      p_target_id,
      v_target.handle;
    RETURN;
  END IF;

  IF p_action = 'ban' THEN
    IF v_target.banned_at IS NOT NULL
      OR (
        COALESCE(v_target.is_banned, false)
        AND (
          v_target.ban_expires_at IS NULL
          OR v_target.ban_expires_at > v_now
        )
      )
    THEN
      RETURN QUERY SELECT
        false,
        p_action,
        'already_banned'::text,
        p_target_id,
        v_target.handle;
      RETURN;
    END IF;

    UPDATE public.user_profiles AS target_profile
    SET banned_at = v_now,
        is_banned = true,
        ban_expires_at = NULL,
        banned_reason = v_reason,
        banned_by = p_actor_id
    WHERE target_profile.id = p_target_id;
    GET DIAGNOSTICS v_affected_count = ROW_COUNT;

    IF v_affected_count IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'administrator user sanction did not affect its locked target'
        USING ERRCODE = '40001';
    END IF;

    INSERT INTO public.admin_logs (
      admin_id,
      action,
      target_type,
      target_id,
      details
    ) VALUES (
      p_actor_id,
      'ban_user',
      'user',
      p_target_id,
      pg_catalog.jsonb_build_object(
        'handle', v_target.handle,
        'reason', v_reason
      )
    );
  ELSE
    IF v_target.banned_at IS NULL
      AND NOT COALESCE(v_target.is_banned, false)
      AND v_target.ban_expires_at IS NULL
      AND v_target.banned_reason IS NULL
      AND v_target.banned_by IS NULL
    THEN
      RETURN QUERY SELECT
        false,
        p_action,
        'not_banned'::text,
        p_target_id,
        v_target.handle;
      RETURN;
    END IF;

    -- Clear both the current and legacy representations.  This repairs
    -- legacy-only profiles for which the old endpoint reported "not banned"
    -- while request admission continued to reject the user.
    UPDATE public.user_profiles AS target_profile
    SET banned_at = NULL,
        is_banned = false,
        ban_expires_at = NULL,
        banned_reason = NULL,
        banned_by = NULL
    WHERE target_profile.id = p_target_id;
    GET DIAGNOSTICS v_affected_count = ROW_COUNT;

    IF v_affected_count IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'administrator user sanction did not affect its locked target'
        USING ERRCODE = '40001';
    END IF;

    INSERT INTO public.admin_logs (
      admin_id,
      action,
      target_type,
      target_id,
      details
    ) VALUES (
      p_actor_id,
      'unban_user',
      'user',
      p_target_id,
      pg_catalog.jsonb_build_object('handle', v_target.handle)
    );
  END IF;

  RETURN QUERY SELECT
    true,
    p_action,
    'applied'::text,
    p_target_id,
    v_target.handle;
END
$function$;

ALTER FUNCTION public.set_admin_user_sanction_atomic(uuid, uuid, text, text)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.set_admin_user_sanction_atomic(uuid, uuid, text, text)
FROM PUBLIC, anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION
  public.set_admin_user_sanction_atomic(uuid, uuid, text, text)
TO service_role;

COMMENT ON FUNCTION public.set_admin_user_sanction_atomic(
  uuid,
  uuid,
  text,
  text
) IS
  'Atomically applies an administrator ban/unban and audit record under account lifecycle locks.';

DO $postflight$
DECLARE
  v_function pg_catalog.regprocedure :=
    'public.set_admin_user_sanction_atomic(uuid,uuid,text,text)'::pg_catalog.regprocedure;
  v_lock_function pg_catalog.regprocedure :=
    'public.lock_account_lifecycle_subject_transition()'::pg_catalog.regprocedure;
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service_role oid := pg_catalog.to_regrole('service_role');
  v_source text;
BEGIN
  IF v_postgres IS NULL OR v_service_role IS NULL THEN
    RAISE EXCEPTION 'atomic administrator user sanction roles are missing';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(function_row.oid)
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proretset
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
        'lock_timeout=5s'
      ]::text[]
  )
    OR NOT pg_catalog.has_function_privilege(v_service_role, v_function, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
    OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
    OR pg_catalog.has_function_privilege('authenticator', v_function, 'EXECUTE')
    OR pg_catalog.strpos(
      v_source,
      '''account-recovery-admission:'' || v_user_id::text'
    ) = 0
    OR pg_catalog.strpos(v_source, 'ORDER BY required_id') = 0
    OR pg_catalog.strpos(v_source, 'ORDER BY auth_user.id') = 0
    OR pg_catalog.strpos(v_source, 'ORDER BY profile.id') = 0
    OR pg_catalog.strpos(v_source, 'is_banned = true') = 0
    OR pg_catalog.strpos(v_source, 'is_banned = false') = 0
    OR pg_catalog.strpos(v_source, 'INSERT INTO public.admin_logs') = 0
  THEN
    RAISE EXCEPTION 'atomic administrator user sanction contract drifted';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(function_row.oid)
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_lock_function;

  IF pg_catalog.strpos(v_source, 'pg_try_advisory_xact_lock') = 0
    OR pg_catalog.strpos(v_source, 'ERRCODE = ''40001''') = 0
    OR pg_catalog.strpos(v_source, 'NEW.is_banned := true') = 0
    OR pg_catalog.strpos(v_source, 'NEW.is_banned := false') = 0
    OR pg_catalog.strpos(v_source, 'NEW.banned_at := pg_catalog.clock_timestamp()') = 0
    OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = 'public.user_profiles'::pg_catalog.regclass
        AND trigger_row.tgfoid = v_lock_function
        AND trigger_row.tgname IN (
          '000_account_lifecycle_subject_insert_delete_lock',
          '000_account_lifecycle_subject_status_lock'
        )
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgenabled IN ('O', 'A')
      GROUP BY trigger_row.tgrelid
      HAVING pg_catalog.count(*) = 2
    )
  THEN
    RAISE EXCEPTION 'account lifecycle inverted-writer conflict barrier drifted';
  END IF;
END
$postflight$;

SELECT public.assert_active_authenticated_subject_mutation_barriers();
