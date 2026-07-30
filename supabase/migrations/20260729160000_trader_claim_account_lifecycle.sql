-- Trader claims are account-owned authority. Submission, activation, and
-- revocation must serialize with account deletion/recovery and sanctions so a
-- deleted or banned account cannot create (or recreate) ownership projections.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('trader-claim-account-lifecycle-authority@1', 0)
);

DO $preflight$
DECLARE
  v_role text;
  v_relation text;
  v_activate_definition text;
  v_unlink_definition text;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR pg_catalog.to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION
      'trader-claim account lifecycle authority requires PostgreSQL 17 and auth.role()';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'postgres',
    'anon',
    'authenticated',
    'service_role',
    'authenticator'
  ]::text[]
  LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'required trader-claim role is unavailable: %', v_role;
    END IF;
  END LOOP;

  FOREACH v_relation IN ARRAY ARRAY[
    'auth.users',
    'public.user_profiles',
    'public.trader_claims',
    'public.verified_traders',
    'public.user_linked_traders'
  ]::text[]
  LOOP
    IF pg_catalog.to_regclass(v_relation) IS NULL THEN
      RAISE EXCEPTION 'required trader-claim relation is unavailable: %', v_relation;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure(
       'public.submit_trader_claim(uuid,text,text,text,jsonb)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.activate_trader_claim(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.unlink_linked_trader(uuid,uuid)'
     ) IS NULL THEN
    RAISE EXCEPTION 'trader-claim mutation foundations are incomplete';
  END IF;

  SELECT pg_catalog.pg_get_functiondef(
           pg_catalog.to_regprocedure(
             'public.activate_trader_claim(uuid,uuid)'
           )
         ),
         pg_catalog.pg_get_functiondef(
           pg_catalog.to_regprocedure(
             'public.unlink_linked_trader(uuid,uuid)'
           )
         )
  INTO v_activate_definition, v_unlink_definition;

  IF pg_catalog.strpos(v_activate_definition, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_activate_definition, 'linked-trader:') = 0
     OR pg_catalog.strpos(v_activate_definition, 'trader-claim:') = 0
     OR pg_catalog.strpos(v_activate_definition, 'FOR UPDATE')
          > pg_catalog.strpos(v_activate_definition, 'linked-trader:')
     OR pg_catalog.strpos(v_activate_definition, 'linked-trader:')
          > pg_catalog.strpos(v_activate_definition, 'trader-claim:')
     OR pg_catalog.strpos(v_unlink_definition, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_unlink_definition, 'linked-trader:') = 0
     OR pg_catalog.strpos(v_unlink_definition, 'trader-claim:') = 0
     OR pg_catalog.strpos(v_unlink_definition, 'FOR UPDATE')
          > pg_catalog.strpos(v_unlink_definition, 'linked-trader:')
     OR pg_catalog.strpos(v_unlink_definition, 'linked-trader:')
          > pg_catalog.strpos(v_unlink_definition, 'trader-claim:') THEN
    RAISE EXCEPTION
      'claim, linked-trader, and identity lock foundations drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('user_profiles', 'id', 'uuid'::pg_catalog.regtype, true),
        ('user_profiles', 'deleted_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_profiles', 'banned_at', 'timestamptz'::pg_catalog.regtype, false),
        ('user_profiles', 'is_banned', 'boolean'::pg_catalog.regtype, true),
        ('user_profiles', 'ban_expires_at', 'timestamptz'::pg_catalog.regtype, false),
        ('trader_claims', 'id', 'uuid'::pg_catalog.regtype, true),
        ('trader_claims', 'user_id', 'uuid'::pg_catalog.regtype, true)
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
    RAISE EXCEPTION 'trader-claim account lifecycle column contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
      AND attribute.attname = 'id'
      AND attribute.atttypid = 'uuid'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION 'auth.users UUID authority drifted';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.lock_trader_claim_principals_internal(uuid[],boolean)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'public.submit_trader_claim_without_account_lifecycle_internal(uuid,text,text,text,jsonb)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'public.activate_trader_claim_without_account_lifecycle_internal(uuid,uuid)'
     ) IS NOT NULL
     OR pg_catalog.to_regprocedure(
       'public.unlink_linked_trader_without_account_lifecycle_internal(uuid,uuid)'
     ) IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected pre-existing trader-claim lifecycle internals';
  END IF;
END
$preflight$;

-- Preserve the already proven projection logic behind non-executable internal
-- names. The new public boundaries acquire all account locks first and hold
-- them for the complete nested transaction.
ALTER FUNCTION public.submit_trader_claim(uuid, text, text, text, jsonb)
  RENAME TO submit_trader_claim_without_account_lifecycle_internal;
ALTER FUNCTION public.activate_trader_claim(uuid, uuid)
  RENAME TO activate_trader_claim_without_account_lifecycle_internal;
ALTER FUNCTION public.unlink_linked_trader(uuid, uuid)
  RENAME TO unlink_linked_trader_without_account_lifecycle_internal;

ALTER FUNCTION public.submit_trader_claim_without_account_lifecycle_internal(
  uuid,
  text,
  text,
  text,
  jsonb
) OWNER TO postgres;
ALTER FUNCTION public.activate_trader_claim_without_account_lifecycle_internal(
  uuid,
  uuid
) OWNER TO postgres;
ALTER FUNCTION public.unlink_linked_trader_without_account_lifecycle_internal(
  uuid,
  uuid
) OWNER TO postgres;

REVOKE ALL ON FUNCTION
  public.submit_trader_claim_without_account_lifecycle_internal(
    uuid,
    text,
    text,
    text,
    jsonb
  ) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION
  public.activate_trader_claim_without_account_lifecycle_internal(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION
  public.unlink_linked_trader_without_account_lifecycle_internal(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

-- Acquire every account namespace before any tuple lock. UUID ordering makes
-- claimant/reviewer pairs deterministic. Auth tuples are then locked before
-- profile tuples, matching the canonical account lifecycle authorities.
CREATE FUNCTION public.lock_trader_claim_principals_internal(
  p_user_ids uuid[],
  p_require_active boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_user_id uuid;
  v_deleted_at timestamptz;
  v_banned_at timestamptz;
  v_is_banned boolean;
  v_ban_expires_at timestamptz;
BEGIN
  IF p_user_ids IS NULL
     OR pg_catalog.cardinality(p_user_ids) = 0
     OR p_require_active IS NULL
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(p_user_ids) AS supplied(user_id)
       WHERE supplied.user_id IS NULL
     ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'trader claim principals are required';
  END IF;

  FOR v_user_id IN
    SELECT DISTINCT supplied.user_id
    FROM pg_catalog.unnest(p_user_ids) AS supplied(user_id)
    ORDER BY supplied.user_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'account-recovery-admission:' || v_user_id::text,
        0
      )
    );
  END LOOP;

  FOR v_user_id IN
    SELECT DISTINCT supplied.user_id
    FROM pg_catalog.unnest(p_user_ids) AS supplied(user_id)
    ORDER BY supplied.user_id
  LOOP
    PERFORM 1
    FROM auth.users AS auth_user
    WHERE auth_user.id = v_user_id
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'active trader claim principal not found';
    END IF;
  END LOOP;

  FOR v_user_id IN
    SELECT DISTINCT supplied.user_id
    FROM pg_catalog.unnest(p_user_ids) AS supplied(user_id)
    ORDER BY supplied.user_id
  LOOP
    SELECT
      profile.deleted_at,
      profile.banned_at,
      profile.is_banned,
      profile.ban_expires_at
    INTO
      v_deleted_at,
      v_banned_at,
      v_is_banned,
      v_ban_expires_at
    FROM public.user_profiles AS profile
    WHERE profile.id = v_user_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'trader claim principal profile not found';
    END IF;

    IF p_require_active
       AND (
         v_deleted_at IS NOT NULL
         OR v_banned_at IS NOT NULL
         OR (
           COALESCE(v_is_banned, false)
           AND (
             v_ban_expires_at IS NULL
             OR v_ban_expires_at > pg_catalog.clock_timestamp()
           )
         )
       ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'inactive trader claim principal';
    END IF;
  END LOOP;
END
$function$;

ALTER FUNCTION public.lock_trader_claim_principals_internal(uuid[], boolean)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION
  public.lock_trader_claim_principals_internal(uuid[], boolean)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

CREATE FUNCTION public.submit_trader_claim(
  p_user_id uuid,
  p_trader_id text,
  p_source text,
  p_verification_method text,
  p_verification_data jsonb
)
RETURNS public.trader_claims
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '20s'
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'valid claim user, trader id, and source are required';
  END IF;

  PERFORM public.lock_trader_claim_principals_internal(
    ARRAY[p_user_id]::uuid[],
    true
  );

  RETURN public.submit_trader_claim_without_account_lifecycle_internal(
    p_user_id,
    p_trader_id,
    p_source,
    p_verification_method,
    p_verification_data
  );
END
$function$;

CREATE FUNCTION public.activate_trader_claim(
  p_claim_id uuid,
  p_reviewer_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_claimant_snapshot uuid;
  v_claimant_locked uuid;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_claim_id IS NULL OR p_reviewer_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'claim id and reviewer id are required';
  END IF;

  -- This first read is observation only. The claim row is deliberately locked
  -- after both account namespaces and their Auth/profile tuples.
  SELECT claim.user_id
  INTO v_claimant_snapshot
  FROM public.trader_claims AS claim
  WHERE claim.id = p_claim_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'trader claim not found';
  END IF;

  PERFORM public.lock_trader_claim_principals_internal(
    ARRAY[v_claimant_snapshot, p_reviewer_id]::uuid[],
    true
  );

  SELECT claim.user_id
  INTO v_claimant_locked
  FROM public.trader_claims AS claim
  WHERE claim.id = p_claim_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'trader claim not found';
  END IF;
  IF v_claimant_locked IS DISTINCT FROM v_claimant_snapshot THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'trader claim claimant changed during activation';
  END IF;

  RETURN public.activate_trader_claim_without_account_lifecycle_internal(
    p_claim_id,
    p_reviewer_id
  );
END
$function$;

CREATE FUNCTION public.unlink_linked_trader(
  p_user_id uuid,
  p_link_id uuid
)
RETURNS TABLE (
  remaining_count integer,
  removed_trader_id text,
  removed_source text,
  promoted_link_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_user_id IS NULL OR p_link_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'user id and linked trader id are required';
  END IF;

  -- Revocation shares the account-first order but does not require an active
  -- owner: reducing authority remains safe during a soft-delete or sanction.
  PERFORM public.lock_trader_claim_principals_internal(
    ARRAY[p_user_id]::uuid[],
    false
  );

  RETURN QUERY
  SELECT internal_result.remaining_count,
         internal_result.removed_trader_id,
         internal_result.removed_source,
         internal_result.promoted_link_id
  FROM public.unlink_linked_trader_without_account_lifecycle_internal(
    p_user_id,
    p_link_id
  ) AS internal_result;
END
$function$;

ALTER FUNCTION public.submit_trader_claim(uuid, text, text, text, jsonb)
  OWNER TO postgres;
ALTER FUNCTION public.activate_trader_claim(uuid, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.unlink_linked_trader(uuid, uuid)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.submit_trader_claim(
  uuid,
  text,
  text,
  text,
  jsonb
) FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.activate_trader_claim(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;
REVOKE ALL ON FUNCTION public.unlink_linked_trader(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role, authenticator;

GRANT EXECUTE ON FUNCTION public.submit_trader_claim(
  uuid,
  text,
  text,
  text,
  jsonb
) TO service_role;
GRANT EXECUTE ON FUNCTION public.activate_trader_claim(uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.unlink_linked_trader(uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.submit_trader_claim(uuid, text, text, text, jsonb) IS
  'Service-only claim submission serialized with account deletion, recovery, and sanctions; rejects inactive claimants before writing.';
COMMENT ON FUNCTION public.activate_trader_claim(uuid, uuid) IS
  'Service-only atomic claim activation serialized with claimant and reviewer account lifecycle; rejects inactive principals before creating projections.';
COMMENT ON FUNCTION public.unlink_linked_trader(uuid, uuid) IS
  'Service-only atomic trader revocation with account-first lock order, preserving the linked-trader then trader-identity advisory order internally.';
COMMENT ON FUNCTION public.lock_trader_claim_principals_internal(uuid[], boolean) IS
  'Non-executable internal account admission, Auth, and profile lock authority for trader-claim mutations; submission/activation additionally require active profiles.';

DO $postflight$
DECLARE
  v_function oid;
  v_function_name text;
  v_expected_timeout text;
BEGIN
  FOR v_function_name, v_expected_timeout IN
    SELECT *
    FROM (
      VALUES
        ('public.submit_trader_claim(uuid,text,text,text,jsonb)', '20s'),
        ('public.activate_trader_claim(uuid,uuid)', '30s'),
        ('public.unlink_linked_trader(uuid,uuid)', '30s')
    ) AS expected(function_name, statement_timeout)
  LOOP
    v_function := pg_catalog.to_regprocedure(v_function_name);
    IF v_function IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         WHERE function_row.oid = v_function
           AND function_row.proowner = pg_catalog.to_regrole('postgres')
           AND function_row.prosecdef
           AND function_row.provolatile = 'v'
           AND function_row.proconfig @> ARRAY[
             'search_path=pg_catalog, pg_temp',
             'row_security=off',
             'lock_timeout=5s',
             'statement_timeout=' || v_expected_timeout
           ]::text[]
       ) THEN
      RAISE EXCEPTION 'trader-claim boundary contract drifted: %',
        v_function_name;
    END IF;

    IF NOT pg_catalog.has_function_privilege(
         'service_role', v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticated', v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         'authenticator', v_function, 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'trader-claim ACL contract drifted: %', v_function_name;
    END IF;
  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    pg_catalog.to_regprocedure(
      'public.lock_trader_claim_principals_internal(uuid[],boolean)'
    ),
    pg_catalog.to_regprocedure(
      'public.submit_trader_claim_without_account_lifecycle_internal(uuid,text,text,text,jsonb)'
    ),
    pg_catalog.to_regprocedure(
      'public.activate_trader_claim_without_account_lifecycle_internal(uuid,uuid)'
    ),
    pg_catalog.to_regprocedure(
      'public.unlink_linked_trader_without_account_lifecycle_internal(uuid,uuid)'
    )
  ]
  LOOP
    IF v_function IS NULL
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticated', v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         'service_role', v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         'authenticator', v_function, 'EXECUTE'
       ) THEN
      RAISE EXCEPTION 'trader-claim internal execution boundary drifted';
    END IF;
  END LOOP;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
