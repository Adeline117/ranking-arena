-- Expired mutes and temporary account bans must be cleared by one service-only
-- transaction. The former cron performed a read/check/update loop in the
-- application: a failed active-strike read was treated as "no active ban", and
-- a concurrent permanent ban could be erased after the check.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('expired-sanction-cleanup-authority@1', 0)
);

DO $preflight$
DECLARE
  v_relation text;
  v_role text;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION 'expired-sanction cleanup requires PostgreSQL 17 and auth.role()';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'group_members',
    'user_profiles',
    'user_strikes'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = pg_catalog.to_regclass('public.' || v_relation)
        AND relation.relkind IN ('r', 'p')
        AND relation.relowner = pg_catalog.to_regrole('postgres')
    ) THEN
      RAISE EXCEPTION 'postgres-owned cleanup relation is unavailable: public.%',
        v_relation;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('group_members', 'group_id', 'uuid'::pg_catalog.regtype, true),
        ('group_members', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('group_members', 'muted_until', 'timestamptz'::pg_catalog.regtype, false),
        ('group_members', 'mute_reason', 'text'::pg_catalog.regtype, false),
        ('group_members', 'muted_by', 'uuid'::pg_catalog.regtype, false),
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_profiles', 'banned_reason', 'text'::pg_catalog.regtype, false),
        ('user_profiles', 'banned_by', 'uuid'::pg_catalog.regtype, false),
        ('user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype, true),
        ('user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_strikes', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_strikes', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('user_strikes', 'issued_by', 'uuid'::pg_catalog.regtype, false),
        ('user_strikes', 'reason', 'text'::pg_catalog.regtype, true),
        ('user_strikes', 'strike_type', 'text'::pg_catalog.regtype, true),
        ('user_strikes', 'expires_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_strikes', 'created_at', 'timestamptz'::pg_catalog.regtype, false)
    ) AS required_column(relation_name, column_name, type_oid, required_not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass(
        'public.' || required_column.relation_name
      )
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
       OR (
         required_column.required_not_null
         AND NOT attribute.attnotnull
       )
  ) THEN
    RAISE EXCEPTION 'expired-sanction cleanup column contract drifted';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'service_role'
  ]::text[]
  LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'required database role is unavailable: %', v_role;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'expire_mutes_and_temporary_bans_atomic'
  ) THEN
    RAISE EXCEPTION 'unexpected pre-existing expired-sanction cleanup authority';
  END IF;
END
$preflight$;

CREATE FUNCTION public.expire_mutes_and_temporary_bans_atomic(
  p_limit integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
SET statement_timeout = '20s'
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_group_mutes_cleared integer := 0;
  v_temp_bans_cleared integer := 0;
  v_temp_bans_preserved integer := 0;
  v_user_id uuid;
  v_deleted_at timestamptz;
  v_banned_at timestamptz;
  v_banned_reason text;
  v_banned_by uuid;
  v_is_banned boolean;
  v_ban_expires_at timestamptz;
  v_source_strike_id uuid;
  v_has_active_ban boolean;
  v_affected integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 2000 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'p_limit must be between 1 and 2000';
  END IF;

  -- Lock and clear group memberships in stable key order. The second temporal
  -- predicate protects against a concurrent mute extension before row lock.
  WITH locked_mutes AS MATERIALIZED (
    SELECT member.group_id, member.user_id
    FROM public.group_members AS member
    WHERE member.muted_until IS NOT NULL
      AND member.muted_until <= v_now
    ORDER BY member.group_id, member.user_id
    LIMIT p_limit
    FOR UPDATE
  ), cleared_mutes AS (
    UPDATE public.group_members AS member
    SET muted_until = NULL,
        mute_reason = NULL,
        muted_by = NULL
    FROM locked_mutes AS locked
    WHERE member.group_id = locked.group_id
      AND member.user_id = locked.user_id
      AND member.muted_until IS NOT NULL
      AND member.muted_until <= v_now
    RETURNING 1
  )
  SELECT pg_catalog.count(*)::integer
  INTO v_group_mutes_cleared
  FROM cleared_mutes;

  -- Candidate selection is only an optimization. Every decision is repeated
  -- after the canonical account lock and profile row lock below.
  FOR v_user_id IN
    SELECT candidate.user_id
    FROM (
      SELECT DISTINCT strike_row.user_id
      FROM public.user_strikes AS strike_row
      JOIN public.user_profiles AS profile
        ON profile.id = strike_row.user_id
      WHERE strike_row.strike_type = 'temp_ban'
        AND strike_row.expires_at IS NOT NULL
        AND strike_row.expires_at <= v_now
        AND profile.ban_expires_at IS NOT NULL
        AND profile.ban_expires_at <= v_now
        AND profile.deleted_at IS NULL
        AND (
          (
            profile.banned_at IS NULL
            AND profile.is_banned IS TRUE
          )
          OR (
            profile.banned_at IS NOT NULL
            AND strike_row.reason IS NOT DISTINCT FROM profile.banned_reason
            AND strike_row.issued_by IS NOT DISTINCT FROM profile.banned_by
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM public.user_strikes AS candidate_active_strike
          WHERE candidate_active_strike.user_id = strike_row.user_id
            AND (
              candidate_active_strike.strike_type = 'perm_ban'
              OR (
                candidate_active_strike.strike_type = 'temp_ban'
                AND (
                  candidate_active_strike.expires_at IS NULL
                  OR candidate_active_strike.expires_at > v_now
                )
              )
            )
        )
      ORDER BY strike_row.user_id
      LIMIT p_limit
    ) AS candidate
    ORDER BY candidate.user_id
  LOOP
    -- Shared with account recovery and admin ban/unban authority. All account
    -- lifecycle writers acquire this transaction lock before profile rows.
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'account-recovery-admission:' || v_user_id::text,
        0
      )
    );

    SELECT
      profile.deleted_at,
      profile.banned_at,
      profile.banned_reason,
      profile.banned_by,
      profile.is_banned,
      profile.ban_expires_at
    INTO
      v_deleted_at,
      v_banned_at,
      v_banned_reason,
      v_banned_by,
      v_is_banned,
      v_ban_expires_at
    FROM public.user_profiles AS profile
    WHERE profile.id = v_user_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_deleted_at IS NOT NULL
       OR v_ban_expires_at IS NULL
       OR v_ban_expires_at > v_now
       OR (
         v_banned_at IS NULL
         AND v_is_banned IS NOT TRUE
       ) THEN
      v_temp_bans_preserved := v_temp_bans_preserved + 1;
      CONTINUE;
    END IF;

    -- Modern sanctions must still match the exact issuing strike. Legacy rows
    -- are identified by is_banned=true with no banned_at marker. This prevents
    -- an old expired strike from clearing a later manual/permanent ban.
    v_source_strike_id := NULL;
    SELECT strike_row.id
    INTO v_source_strike_id
    FROM public.user_strikes AS strike_row
    WHERE strike_row.user_id = v_user_id
      AND strike_row.strike_type = 'temp_ban'
      AND strike_row.expires_at IS NOT NULL
      AND strike_row.expires_at <= v_now
      AND strike_row.expires_at IS NOT DISTINCT FROM v_ban_expires_at
      AND (
        (
          v_banned_at IS NULL
          AND v_is_banned IS TRUE
        )
        OR (
          v_banned_at IS NOT NULL
          AND strike_row.reason IS NOT DISTINCT FROM v_banned_reason
          AND strike_row.issued_by IS NOT DISTINCT FROM v_banned_by
        )
      )
    ORDER BY strike_row.created_at DESC NULLS LAST, strike_row.id DESC
    LIMIT 1;

    IF v_source_strike_id IS NULL THEN
      v_temp_bans_preserved := v_temp_bans_preserved + 1;
      CONTINUE;
    END IF;

    SELECT EXISTS (
      SELECT 1
      FROM public.user_strikes AS active_strike
      WHERE active_strike.user_id = v_user_id
        AND (
          active_strike.strike_type = 'perm_ban'
          OR (
            active_strike.strike_type = 'temp_ban'
            AND (
              active_strike.expires_at IS NULL
              OR active_strike.expires_at > v_now
            )
          )
        )
    )
    INTO v_has_active_ban;

    IF v_has_active_ban THEN
      v_temp_bans_preserved := v_temp_bans_preserved + 1;
      CONTINUE;
    END IF;

    UPDATE public.user_profiles AS profile
    SET banned_at = NULL,
        banned_reason = NULL,
        banned_by = NULL,
        is_banned = false,
        ban_expires_at = NULL
    WHERE profile.id = v_user_id
      AND profile.deleted_at IS NULL
      AND profile.banned_at IS NOT DISTINCT FROM v_banned_at
      AND profile.banned_reason IS NOT DISTINCT FROM v_banned_reason
      AND profile.banned_by IS NOT DISTINCT FROM v_banned_by
      AND profile.is_banned IS NOT DISTINCT FROM v_is_banned
      AND profile.ban_expires_at IS NOT DISTINCT FROM v_ban_expires_at;

    GET DIAGNOSTICS v_affected = ROW_COUNT;
    IF v_affected <> 1 THEN
      RAISE EXCEPTION 'atomic expired-ban cleanup updated % profiles for %',
        v_affected,
        v_user_id;
    END IF;
    v_temp_bans_cleared := v_temp_bans_cleared + 1;
  END LOOP;

  RETURN pg_catalog.jsonb_build_object(
    'group_mutes_cleared', v_group_mutes_cleared,
    'temp_bans_cleared', v_temp_bans_cleared,
    'temp_bans_preserved', v_temp_bans_preserved
  );
END
$function$;

ALTER FUNCTION public.expire_mutes_and_temporary_bans_atomic(integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.expire_mutes_and_temporary_bans_atomic(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.expire_mutes_and_temporary_bans_atomic(integer)
  TO service_role;

COMMENT ON FUNCTION public.expire_mutes_and_temporary_bans_atomic(integer) IS
  'Service-only atomic expiry of group mutes and provenance-matched temporary account bans. Serializes with account recovery/admin sanctions and preserves deleted, active, permanent, or ambiguous profiles.';

DO $postflight$
DECLARE
  v_function oid := pg_catalog.to_regprocedure(
    'public.expire_mutes_and_temporary_bans_atomic(integer)'
  );
BEGIN
  IF v_function IS NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       JOIN pg_catalog.pg_namespace AS namespace_row
         ON namespace_row.oid = function_row.pronamespace
       WHERE namespace_row.nspname = 'public'
         AND function_row.proname = 'expire_mutes_and_temporary_bans_atomic'
         AND function_row.oid <> v_function
     ) THEN
    RAISE EXCEPTION 'expired-sanction cleanup authority is ambiguous';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = pg_catalog.to_regrole('postgres')
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s',
        'statement_timeout=20s'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'expired-sanction cleanup execution contract drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
     OR pg_catalog.has_function_privilege(
       'authenticated', v_function, 'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'expired-sanction cleanup ACL contract drifted';
  END IF;
END
$postflight$;

COMMIT;
