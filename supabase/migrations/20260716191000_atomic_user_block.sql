-- Make block/unblock and the block-time bidirectional follow cleanup one
-- transaction. Deploy after 20260716190000 and before the social-edge table
-- write contract in 20260716192000.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('public.blocked_users:atomic-mutation:v1', 0)
);

DO $preflight$
DECLARE
  v_invalid_columns text[];
  v_missing_roles text[];
  v_pair_function regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_direct_message_pair_edge()'
  );
  v_follow_function regprocedure := pg_catalog.to_regprocedure(
    'public.mutate_user_follow_atomic(uuid,uuid,text)'
  );
  v_pair_source text;
BEGIN
  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.user_follows') IS NULL
     OR pg_catalog.to_regclass('public.blocked_users') IS NULL
  THEN
    RAISE EXCEPTION
      'social edge authority tables must exist before atomic block deployment';
  END IF;

  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role']::text[]
  ) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'user block ACL roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL THEN
    RAISE EXCEPTION 'auth.role() is required for the service-only block RPC';
  END IF;

  IF v_follow_function IS NULL OR NOT (
    SELECT function_row.prosecdef
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_follow_function
  ) THEN
    RAISE EXCEPTION
      'atomic user follow authority must exist before atomic block deployment';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I.%I (expected %s%s)',
      required_column.table_name,
      required_column.column_name,
      required_column.type_name,
      CASE WHEN required_column.required_not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      (1, 'users', 'id', 'uuid', true),
      (2, 'user_profiles', 'id', 'uuid', true),
      (3, 'user_profiles', 'deleted_at', 'timestamp with time zone', false),
      (4, 'user_profiles', 'banned_at', 'timestamp with time zone', false),
      (5, 'user_profiles', 'is_banned', 'boolean', false),
      (6, 'user_profiles', 'ban_expires_at', 'timestamp with time zone', false),
      (7, 'user_profiles', 'follower_count', 'integer', false),
      (8, 'user_profiles', 'following_count', 'integer', false),
      (9, 'user_follows', 'follower_id', 'uuid', true),
      (10, 'user_follows', 'following_id', 'uuid', true),
      (11, 'blocked_users', 'blocker_id', 'uuid', true),
      (12, 'blocked_users', 'blocked_id', 'uuid', true)
  ) AS required_column(
    ordinality,
    table_name,
    column_name,
    type_name,
    required_not_null
  )
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = CASE required_column.table_name
      WHEN 'users' THEN 'auth.users'::pg_catalog.regclass
      ELSE pg_catalog.to_regclass('public.' || required_column.table_name)
    END
   AND attribute.attname = required_column.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
          <> required_column.type_name
     OR (required_column.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'user block schema has missing or incompatible columns: %',
      v_invalid_columns;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhparent IN (
      'public.user_follows'::pg_catalog.regclass,
      'public.blocked_users'::pg_catalog.regclass
    )
  ) THEN
    RAISE EXCEPTION 'social edge tables must not have inherited children';
  END IF;

  IF v_pair_function IS NULL THEN
    RAISE EXCEPTION
      'canonical block/follow pair serializer must exist before block RPC';
  END IF;
  SELECT pg_catalog.pg_get_functiondef(v_pair_function)
  INTO STRICT v_pair_source;
  IF pg_catalog.strpos(
       v_pair_source,
       $$'direct-message:pair:' || v_pair$$
     ) = 0
     OR pg_catalog.strpos(v_pair_source, $$WHEN 'blocked_users' THEN$$) = 0
     OR pg_catalog.strpos(v_pair_source, $$WHEN 'user_follows' THEN$$) = 0
  THEN
    RAISE EXCEPTION 'canonical block/follow pair serializer is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.blocked_users'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_serialize_dm_block_pair'
      AND trigger_row.tgfoid = v_pair_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_follows'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_serialize_dm_follow_pair'
      AND trigger_row.tgfoid = v_pair_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
  ) THEN
    RAISE EXCEPTION 'canonical block/follow pair serializer triggers are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'mutate_user_block_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
            <> 'p_actor_id uuid, p_target_id uuid, p_action text'
  ) THEN
    RAISE EXCEPTION 'incompatible mutate_user_block_atomic overload exists';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.mutate_user_block_atomic(
  p_actor_id uuid,
  p_target_id uuid,
  p_action text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_pair text;
  v_actor record;
  v_target record;
  v_target_exists boolean := false;
  v_changed boolean := false;
  v_removed_outgoing boolean := false;
  v_removed_incoming boolean := false;
  v_affected integer := 0;
  v_actor_follower_count integer;
  v_actor_following_count integer;
  v_target_follower_count integer;
  v_target_following_count integer;
  v_status text;
BEGIN
  IF COALESCE(NULLIF(auth.role(), ''), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required for atomic user block mutation';
  END IF;

  IF p_actor_id IS NULL
     OR p_target_id IS NULL
     OR p_action IS NULL
     OR p_action NOT IN ('block', 'unblock')
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  IF p_actor_id = p_target_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'self');
  END IF;

  PERFORM auth_user.id
  FROM auth.users AS auth_user
  WHERE auth_user.id IN (p_actor_id, p_target_id)
  ORDER BY auth_user.id
  FOR KEY SHARE;

  v_pair := LEAST(p_actor_id::text, p_target_id::text)
    || ':' || GREATEST(p_actor_id::text, p_target_id::text);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
  );

  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id IN (p_actor_id, p_target_id)
  ORDER BY profile.id
  FOR UPDATE;

  SELECT
    profile.id,
    profile.deleted_at,
    profile.banned_at,
    profile.is_banned,
    profile.ban_expires_at
  INTO v_actor
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id;

  IF NOT FOUND
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
    RETURN pg_catalog.jsonb_build_object('status', 'actor_unavailable');
  END IF;

  SELECT
    profile.id,
    profile.deleted_at,
    profile.banned_at,
    profile.is_banned,
    profile.ban_expires_at
  INTO v_target
  FROM public.user_profiles AS profile
  WHERE profile.id = p_target_id;
  v_target_exists := FOUND;

  IF p_action = 'block' AND (
    NOT v_target_exists
    OR v_target.deleted_at IS NOT NULL
    OR v_target.banned_at IS NOT NULL
    OR (
      COALESCE(v_target.is_banned, false)
      AND (
        v_target.ban_expires_at IS NULL
        OR v_target.ban_expires_at > v_now
      )
    )
  ) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'target_unavailable');
  END IF;

  IF p_action = 'block' THEN
    INSERT INTO public.blocked_users AS block_edge (blocker_id, blocked_id)
    VALUES (p_actor_id, p_target_id)
    ON CONFLICT (blocker_id, blocked_id) DO NOTHING
    RETURNING true INTO v_changed;
    v_changed := COALESCE(v_changed, false);

    v_removed_outgoing := EXISTS (
      SELECT 1
      FROM public.user_follows AS follow_edge
      WHERE follow_edge.follower_id = p_actor_id
        AND follow_edge.following_id = p_target_id
    );
    v_removed_incoming := EXISTS (
      SELECT 1
      FROM public.user_follows AS follow_edge
      WHERE follow_edge.follower_id = p_target_id
        AND follow_edge.following_id = p_actor_id
    );

    DELETE FROM public.user_follows AS follow_edge
    WHERE (
      follow_edge.follower_id = p_actor_id
      AND follow_edge.following_id = p_target_id
    ) OR (
      follow_edge.follower_id = p_target_id
      AND follow_edge.following_id = p_actor_id
    );

    v_status := CASE WHEN v_changed THEN 'blocked' ELSE 'already_blocked' END;
  ELSE
    DELETE FROM public.blocked_users AS block_edge
    WHERE block_edge.blocker_id = p_actor_id
      AND block_edge.blocked_id = p_target_id;
    GET DIAGNOSTICS v_affected = ROW_COUNT;
    v_changed := v_affected = 1;
    v_status := CASE WHEN v_changed THEN 'unblocked' ELSE 'already_unblocked' END;
  END IF;

  SELECT
    pg_catalog.count(*) FILTER (
      WHERE follow_edge.following_id = p_actor_id
    )::integer,
    pg_catalog.count(*) FILTER (
      WHERE follow_edge.follower_id = p_actor_id
    )::integer,
    pg_catalog.count(*) FILTER (
      WHERE follow_edge.following_id = p_target_id
    )::integer,
    pg_catalog.count(*) FILTER (
      WHERE follow_edge.follower_id = p_target_id
    )::integer
  INTO
    v_actor_follower_count,
    v_actor_following_count,
    v_target_follower_count,
    v_target_following_count
  FROM public.user_follows AS follow_edge
  WHERE follow_edge.follower_id IN (p_actor_id, p_target_id)
     OR follow_edge.following_id IN (p_actor_id, p_target_id);

  UPDATE public.user_profiles AS profile
  SET
    follower_count = CASE
      WHEN profile.id = p_actor_id THEN v_actor_follower_count
      ELSE v_target_follower_count
    END,
    following_count = CASE
      WHEN profile.id = p_actor_id THEN v_actor_following_count
      ELSE v_target_following_count
    END
  WHERE profile.id IN (p_actor_id, p_target_id);

  RETURN pg_catalog.jsonb_build_object(
    'status', v_status,
    'actor_id', p_actor_id,
    'target_id', p_target_id,
    'action', p_action,
    'changed', v_changed,
    'blocked', p_action = 'block',
    'removed_outgoing_follow', v_removed_outgoing,
    'removed_incoming_follow', v_removed_incoming,
    'actor_follower_count', v_actor_follower_count,
    'actor_following_count', v_actor_following_count,
    'target_follower_count', v_target_follower_count,
    'target_following_count', v_target_following_count
  );
END
$function$;

ALTER FUNCTION public.mutate_user_block_atomic(uuid, uuid, text)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.mutate_user_block_atomic(uuid, uuid, text)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mutate_user_block_atomic(uuid, uuid, text)
  TO service_role;

COMMENT ON FUNCTION public.mutate_user_block_atomic(uuid, uuid, text) IS
  'Service-only idempotent block/unblock boundary with atomic bidirectional follow cleanup and absolute counter repair.';

DO $postflight$
DECLARE
  v_function regprocedure := 'public.mutate_user_block_atomic(uuid,uuid,text)'::regprocedure;
  v_service_oid oid := (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'service_role');
  v_function_row record;
BEGIN
  SELECT
    function_row.proowner,
    function_row.prosecdef,
    function_row.provolatile,
    function_row.prorettype,
    function_row.proconfig,
    namespace_row.nspname,
    owner_role.rolname AS owner_name
  INTO STRICT v_function_row
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_namespace AS namespace_row
    ON namespace_row.oid = function_row.pronamespace
  JOIN pg_catalog.pg_roles AS owner_role
    ON owner_role.oid = function_row.proowner
  WHERE function_row.oid = v_function;

  IF v_function_row.nspname <> 'public'
     OR v_function_row.owner_name <> 'postgres'
     OR NOT v_function_row.prosecdef
     OR v_function_row.provolatile <> 'v'
     OR v_function_row.prorettype <> 'jsonb'::pg_catalog.regtype
     OR NOT ('search_path=pg_catalog, pg_temp' = ANY(v_function_row.proconfig))
     OR NOT ('lock_timeout=5s' = ANY(v_function_row.proconfig))
  THEN
    RAISE EXCEPTION 'atomic user block function metadata drifted';
  END IF;

  IF pg_catalog.has_function_privilege(
       'anon', v_function, 'EXECUTE'
     ) OR pg_catalog.has_function_privilege(
       'authenticated', v_function, 'EXECUTE'
     ) OR NOT pg_catalog.has_function_privilege(
       'service_role', v_function, 'EXECUTE'
     ) OR EXISTS (
       SELECT 1
       FROM pg_catalog.aclexplode(
         COALESCE(
           (SELECT function_row.proacl FROM pg_catalog.pg_proc AS function_row
            WHERE function_row.oid = v_function),
           '{}'::aclitem[]
         )
       ) AS acl
       WHERE acl.grantee = 0
          OR (acl.grantee NOT IN (v_service_oid, v_function_row.proowner))
     )
  THEN
    RAISE EXCEPTION 'atomic user block EXECUTE boundary drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
