-- Migration: 20260729131858_atomic_channel_member_mutation.sql
-- Created: 2026-07-29T20:18:58Z
-- Description: Make group-channel leave, member removal, and role changes one
--   serialized authorization-and-write transaction.
--
-- Forward compensation: keep this RPC deployed and cut callers back to the
-- previous API only if necessary. Dropping the RPC before callers are rolled
-- back would turn every member mutation into a hard failure. Use PITR only if
-- an independently discovered data correction requires restoring table state.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.channel_members:atomic-member-mutation:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic channel-member mutation migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_missing_roles text[];
  v_invalid_columns text[];
  v_mutation_function regprocedure := pg_catalog.to_regprocedure(
    'public.mutate_channel_member_atomic(uuid,uuid,uuid,text,text)'
  );
  v_serializer_function regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_group_channel_owner_event()'
  );
  v_owner_count_function regprocedure := pg_catalog.to_regprocedure(
    'public.enforce_group_channel_owner_count()'
  );
  v_add_function regprocedure := pg_catalog.to_regprocedure(
    'public.add_channel_members_atomic(uuid,uuid,uuid[])'
  );
  v_serializer_source text;
  v_add_source text;
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'channel-member mutation roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.chat_channels') IS NULL
     OR pg_catalog.to_regclass('public.channel_members') IS NULL
  THEN
    RAISE EXCEPTION
      'canonical auth users and group-channel relations must deploy first';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'auth.users'::regclass,
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
    HAVING pg_catalog.count(*) = 3
  ) THEN
    RAISE EXCEPTION
      'channel-member mutation requires permanent ordinary tables';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'channel-member mutation requires postgres-owned public tables';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.chat_channels'::regclass,
         'public.channel_members'::regclass
       )
  ) THEN
    RAISE EXCEPTION
      'channel-member mutation relations must not use inheritance or partitioning';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'auth.users'::regclass,
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'channel-member mutation relations must not have rewrite rules';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I.%I.%I expected %s%s',
      required_column.schema_name,
      required_column.relation_name,
      required_column.column_name,
      required_column.type_oid::regtype,
      CASE WHEN required_column.required_not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required_column.schema_name,
      required_column.relation_name,
      required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      ('auth', 'users', 1, 'id', 'uuid'::regtype, true),
      ('public', 'chat_channels', 1, 'id', 'uuid'::regtype, true),
      ('public', 'chat_channels', 2, 'type', 'text'::regtype, true),
      ('public', 'chat_channels', 3, 'created_by', 'uuid'::regtype, false),
      ('public', 'channel_members', 1, 'channel_id', 'uuid'::regtype, true),
      ('public', 'channel_members', 2, 'user_id', 'uuid'::regtype, true),
      ('public', 'channel_members', 3, 'role', 'text'::regtype, true)
  ) AS required_column(
    schema_name,
    relation_name,
    ordinality,
    column_name,
    type_oid,
    required_not_null
  )
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass(
      pg_catalog.format(
        '%I.%I',
        required_column.schema_name,
        required_column.relation_name
      )
    )
   AND attribute.attname = required_column.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required_column.type_oid
     OR (required_column.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'channel-member mutation has incompatible columns: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.channel_members'::regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND (
        SELECT pg_catalog.array_agg(attribute.attname ORDER BY key_column.ordinality)
        FROM pg_catalog.unnest(index_row.indkey::smallint[])
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['channel_id', 'user_id']::name[]
  ) THEN
    RAISE EXCEPTION
      'channel_members requires an exact unique channel/user identity';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::regtype THEN
    RAISE EXCEPTION 'auth.role() returning text must exist';
  END IF;

  IF v_serializer_function IS NULL
     OR v_owner_count_function IS NULL
     OR v_add_function IS NULL
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.pronamespace = 'public'::regnamespace
         AND function_row.proname IN (
           'serialize_group_channel_owner_event',
           'enforce_group_channel_owner_count',
           'add_channel_members_atomic'
         )
     ) <> 3
  THEN
    RAISE EXCEPTION
      'canonical group-channel owner and member-add authorities must deploy first';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_serializer_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_serializer_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::regtype
    AND function_row.prosecdef
    AND function_row.proowner = v_postgres_oid
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  SELECT function_row.prosrc
  INTO STRICT v_add_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_add_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::regtype
    AND function_row.prosecdef
    AND function_row.proowner = v_postgres_oid
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.strpos(
       v_serializer_source,
       $$'group-channel-owner-invariant:v1'$$
     ) = 0
     OR pg_catalog.strpos(v_serializer_source, 'pg_try_advisory_xact_lock') = 0
     OR pg_catalog.strpos(
       v_add_source,
       $$'group-channel-owner-invariant:v1'$$
     ) = 0
     OR pg_catalog.strpos(
       v_add_source,
       $$'channel-membership:channel:'$$
     ) = 0
  THEN
    RAISE EXCEPTION 'canonical group-channel lock namespaces drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.channel_members'::regclass
      AND trigger_row.tgname = 'trg_serialize_group_channel_owner_event'
      AND trigger_row.tgfoid = v_serializer_function
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.channel_members'::regclass
      AND trigger_row.tgname = 'trg_enforce_group_channel_owner_count'
      AND trigger_row.tgfoid = v_owner_count_function
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 29
      AND trigger_row.tgdeferrable
      AND trigger_row.tginitdeferred
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'group-channel owner trigger contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'mutate_channel_member_atomic'
      AND function_row.oid IS DISTINCT FROM v_mutation_function
  ) THEN
    RAISE EXCEPTION 'incompatible mutate_channel_member_atomic overload exists';
  END IF;

  IF v_mutation_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_mutation_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 5
  ) THEN
    RAISE EXCEPTION 'existing mutate_channel_member_atomic signature is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
      AND relation.relrowsecurity
    GROUP BY relation.relrowsecurity
    HAVING pg_catalog.count(*) = 2
  ) OR pg_catalog.has_table_privilege(
    'anon', 'public.channel_members', 'INSERT'
  ) OR pg_catalog.has_table_privilege(
    'anon', 'public.channel_members', 'UPDATE'
  ) OR pg_catalog.has_table_privilege(
    'anon', 'public.channel_members', 'DELETE'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'public.channel_members', 'INSERT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'public.channel_members', 'UPDATE'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'public.channel_members', 'DELETE'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_members', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_members', 'UPDATE'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_members', 'DELETE'
  ) THEN
    RAISE EXCEPTION 'channel_members service-only write boundary drifted';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.chat_channels,
  public.channel_members
  IN SHARE MODE;

DO $data_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.chat_channels AS channel_row
    WHERE channel_row.type NOT IN ('direct', 'group')
       OR channel_row.type IS NULL
  ) OR EXISTS (
    SELECT 1
    FROM public.channel_members AS membership
    WHERE membership.role NOT IN ('owner', 'admin', 'member')
       OR membership.role IS NULL
  ) THEN
    RAISE EXCEPTION 'channel type or member role data violates the canonical domain';
  END IF;
END
$data_preflight$;

CREATE OR REPLACE FUNCTION public.mutate_channel_member_atomic(
  p_channel_id uuid,
  p_actor_id uuid,
  p_target_id uuid,
  p_action text,
  p_role text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_observed_channel_exists boolean := false;
  v_rechecked_channel_exists boolean := false;
  v_observed_channel_type text;
  v_channel_type text;
  v_observed_created_by uuid;
  v_rechecked_created_by uuid;
  v_observed_row_token text;
  v_rechecked_row_token text;
  v_auth_lock_ids uuid[] := ARRAY[]::uuid[];
  v_auth_user_ids uuid[] := ARRAY[]::uuid[];
  v_actor_role text;
  v_target_role text;
  v_member record;
  v_user_id uuid;
  v_changed_count integer := 0;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_channel_id IS NULL
     OR p_actor_id IS NULL
     OR p_target_id IS NULL
     OR p_action IS NULL
     OR p_action NOT IN ('leave', 'remove', 'set_role')
     OR (p_action = 'leave' AND p_actor_id IS DISTINCT FROM p_target_id)
     OR (p_action IN ('remove', 'set_role') AND p_actor_id = p_target_id)
     OR (p_action IN ('leave', 'remove') AND p_role IS NOT NULL)
     OR (
       p_action = 'set_role'
       AND (p_role IS NULL OR p_role NOT IN ('admin', 'member'))
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid channel-member mutation request';
  END IF;

  -- This RPC never mutates an owner. The shared side prevents a concurrent
  -- direct owner promotion/demotion/deletion from changing either authority
  -- subject after it is checked below.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );

  -- Serialize every supported mutation with existing channel creation/add
  -- authorities before observing mutable channel or membership state.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'channel-membership:channel:' || p_channel_id::text,
      0
    )
  );

  SELECT
    channel_row.type,
    channel_row.created_by,
    channel_row.xmin::text || ':' || channel_row.ctid::text
  INTO
    v_observed_channel_type,
    v_observed_created_by,
    v_observed_row_token
  FROM public.chat_channels AS channel_row
  WHERE channel_row.id = p_channel_id;
  v_observed_channel_exists := FOUND;

  SELECT pg_catalog.array_agg(identity_id ORDER BY identity_id)
  INTO STRICT v_auth_lock_ids
  FROM (
    SELECT p_actor_id AS identity_id
    UNION
    SELECT p_target_id
    UNION
    SELECT v_observed_created_by
    WHERE v_observed_created_by IS NOT NULL
  ) AS identity;

  -- Auth parents are locked before the channel and membership children. This
  -- is the same parent-to-child order used by the canonical add authority and
  -- prevents account-deletion FK actions from forming a lock cycle.
  FOR v_user_id IN
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id = ANY(v_auth_lock_ids)
    ORDER BY auth_user.id
    FOR SHARE
  LOOP
    v_auth_user_ids := pg_catalog.array_append(v_auth_user_ids, v_user_id);
  END LOOP;

  IF NOT p_actor_id = ANY(v_auth_user_ids) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  SELECT
    channel_row.type,
    channel_row.created_by,
    channel_row.xmin::text || ':' || channel_row.ctid::text
  INTO
    v_channel_type,
    v_rechecked_created_by,
    v_rechecked_row_token
  FROM public.chat_channels AS channel_row
  WHERE channel_row.id = p_channel_id
  FOR UPDATE;
  v_rechecked_channel_exists := FOUND;

  IF NOT v_observed_channel_exists THEN
    IF v_rechecked_channel_exists THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'channel identity appeared while locking; retry';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CHANNEL_NOT_FOUND'
    );
  END IF;

  IF NOT v_rechecked_channel_exists
     OR v_channel_type IS DISTINCT FROM v_observed_channel_type
     OR v_rechecked_created_by IS DISTINCT FROM v_observed_created_by
     OR v_rechecked_row_token IS DISTINCT FROM v_observed_row_token
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'channel identity changed while locking; retry';
  END IF;

  IF v_channel_type IS DISTINCT FROM 'group' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CHANNEL_NOT_GROUP'
    );
  END IF;

  -- Lock the complete roster in stable identity order, then derive both roles
  -- from those locked rows. No check used to authorize the write is stale.
  FOR v_member IN
    SELECT membership.user_id, membership.role
    FROM public.channel_members AS membership
    WHERE membership.channel_id = p_channel_id
    ORDER BY membership.user_id
    FOR UPDATE
  LOOP
    IF v_member.user_id = p_actor_id THEN
      v_actor_role := v_member.role;
    END IF;
    IF v_member.user_id = p_target_id THEN
      v_target_role := v_member.role;
    END IF;
  END LOOP;

  IF v_actor_role IS NULL THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'MEMBERSHIP_NOT_FOUND'
    );
  END IF;

  IF p_action = 'leave' THEN
    IF v_actor_role = 'owner' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'OWNER_FORBIDDEN'
      );
    END IF;
  ELSE
    IF v_actor_role NOT IN ('owner', 'admin')
       OR (p_action = 'set_role' AND v_actor_role <> 'owner')
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'PERMISSION_DENIED'
      );
    END IF;

    IF v_target_role IS NULL THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'MEMBERSHIP_NOT_FOUND'
      );
    END IF;

    IF v_target_role = 'owner' THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'OWNER_FORBIDDEN'
      );
    END IF;

    IF p_action = 'remove'
       AND v_actor_role = 'admin'
       AND v_target_role = 'admin'
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'PEER_ADMIN_FORBIDDEN'
      );
    END IF;
  END IF;

  IF p_action IN ('leave', 'remove') THEN
    DELETE FROM public.channel_members AS membership
    WHERE membership.channel_id = p_channel_id
      AND membership.user_id = p_target_id
      AND membership.role = v_target_role;
    GET DIAGNOSTICS v_changed_count = ROW_COUNT;

    IF v_changed_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'channel member delete acknowledgement is incomplete';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'channel_id', p_channel_id,
      'actor_id', p_actor_id,
      'target_id', p_target_id,
      'action', p_action,
      'changed', true,
      'role', NULL
    );
  END IF;

  IF v_target_role = p_role THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'channel_id', p_channel_id,
      'actor_id', p_actor_id,
      'target_id', p_target_id,
      'action', p_action,
      'changed', false,
      'role', p_role
    );
  END IF;

  UPDATE public.channel_members AS membership
  SET role = p_role
  WHERE membership.channel_id = p_channel_id
    AND membership.user_id = p_target_id
    AND membership.role = v_target_role;
  GET DIAGNOSTICS v_changed_count = ROW_COUNT;

  IF v_changed_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'channel member role acknowledgement is incomplete';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'channel_id', p_channel_id,
    'actor_id', p_actor_id,
    'target_id', p_target_id,
    'action', p_action,
    'changed', true,
    'role', p_role
  );
END
$function$;

ALTER FUNCTION public.mutate_channel_member_atomic(uuid, uuid, uuid, text, text)
  OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.mutate_channel_member_atomic(uuid,uuid,uuid,text,text)'::regprocedure;
  v_owner oid;
  v_grantee record;
  v_source text;
BEGIN
  SELECT function_row.proowner, function_row.prosrc
  INTO STRICT v_owner, v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee, role_row.rolname
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE function_row.oid = v_function
      AND acl_entry.grantee <> v_owner
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
        v_function
      );
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
        v_function,
        v_grantee.rolname
      );
    END IF;
  END LOOP;

  REVOKE ALL PRIVILEGES
    ON FUNCTION public.mutate_channel_member_atomic(uuid, uuid, uuid, text, text)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.mutate_channel_member_atomic(uuid, uuid, uuid, text, text)
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-channel-member-mutation:v1:' || pg_catalog.md5(v_source)
  );
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.mutate_channel_member_atomic(uuid,uuid,uuid,text,text)'::regprocedure;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'jsonb'::regtype
    AND NOT function_row.proretset
    AND function_row.pronargs = 5
    AND function_row.pronargdefaults = 1
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'atomic-channel-member-mutation:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, $$'group-channel-owner-invariant:v1'$$) = 0
     OR pg_catalog.strpos(v_source, $$'channel-membership:channel:'$$) = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'FOR SHARE') = 0
     OR pg_catalog.strpos(v_source, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_source, 'DELETE FROM public.channel_members') = 0
     OR pg_catalog.strpos(v_source, 'UPDATE public.channel_members') = 0
  THEN
    RAISE EXCEPTION 'atomic channel-member mutation body attestation failed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role', v_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_function, 'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_function
      AND acl_entry.grantee <> function_row.proowner
      AND NOT (
        acl_entry.grantee = v_service_oid
        AND acl_entry.privilege_type = 'EXECUTE'
        AND NOT acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'atomic channel-member mutation ACL attestation failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
