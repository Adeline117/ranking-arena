-- Migration: 20260729133904_atomic_channel_metadata_mutation.sql
-- Created: 2026-07-29T20:39:04Z
-- Description: Authorize and apply group-channel metadata patches in one
--   serialized transaction so stale admin authority cannot cross the write.
--
-- Forward compensation: roll API callers back before dropping this RPC. This
-- migration changes no existing channel data. Use a forward DROP FUNCTION
-- migration if the boundary must be retired; reserve PITR for data recovery.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.chat_channels:atomic-metadata-mutation:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic channel metadata migration lock is busy';
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
  v_missing_roles text[];
  v_invalid_columns text[];
  v_member_function regprocedure := pg_catalog.to_regprocedure(
    'public.mutate_channel_member_atomic(uuid,uuid,uuid,text,text)'
  );
  v_member_source text;
  v_metadata_function regprocedure := pg_catalog.to_regprocedure(
    'public.update_group_channel_metadata_atomic(uuid,uuid,text,boolean,text,boolean,text,boolean)'
  );
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
    RAISE EXCEPTION 'channel metadata roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.chat_channels') IS NULL
     OR pg_catalog.to_regclass('public.channel_members') IS NULL
  THEN
    RAISE EXCEPTION 'canonical channel metadata relations must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.user_profiles'::regclass,
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'channel metadata mutation requires canonical permanent relation ownership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.chat_channels'::regclass,
         'public.channel_members'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'channel metadata relations must not use inheritance or rewrite rules';
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
      ('public', 'user_profiles', 1, 'id', 'uuid'::regtype, true),
      ('public', 'user_profiles', 2, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 3, 'banned_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 4, 'is_banned', 'boolean'::regtype, false),
      ('public', 'user_profiles', 5, 'ban_expires_at', 'timestamptz'::regtype, false),
      ('public', 'chat_channels', 1, 'id', 'uuid'::regtype, true),
      ('public', 'chat_channels', 2, 'name', 'text'::regtype, false),
      ('public', 'chat_channels', 3, 'type', 'text'::regtype, true),
      ('public', 'chat_channels', 4, 'created_by', 'uuid'::regtype, false),
      ('public', 'chat_channels', 5, 'avatar_url', 'text'::regtype, false),
      ('public', 'chat_channels', 6, 'description', 'text'::regtype, false),
      ('public', 'chat_channels', 7, 'conversation_id', 'uuid'::regtype, false),
      (
        'public', 'chat_channels', 8, 'last_message_at',
        'timestamptz'::regtype, false
      ),
      (
        'public', 'chat_channels', 9, 'last_message_preview',
        'text'::regtype, false
      ),
      (
        'public', 'chat_channels', 10, 'created_at',
        'timestamptz'::regtype, false
      ),
      (
        'public', 'chat_channels', 11, 'updated_at',
        'timestamptz'::regtype, false
      ),
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
    RAISE EXCEPTION 'channel metadata has incompatible columns: %', v_invalid_columns;
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.chat_channels'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 11 THEN
    RAISE EXCEPTION 'chat_channels row shape drifted';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::regtype THEN
    RAISE EXCEPTION 'auth.role() returning text must exist';
  END IF;

  IF v_member_function IS NULL OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'mutate_channel_member_atomic'
  ) <> 1 THEN
    RAISE EXCEPTION 'atomic channel-member mutation authority must deploy first';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_member_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_member_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::regtype
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.strpos(
       v_member_source,
       $$'group-channel-owner-invariant:v1'$$
     ) = 0
     OR pg_catalog.strpos(
       v_member_source,
       $$'channel-membership:channel:'$$
     ) = 0
     OR pg_catalog.strpos(v_member_source, 'FROM auth.users') = 0
     OR pg_catalog.strpos(v_member_source, 'FROM public.channel_members') = 0
  THEN
    RAISE EXCEPTION 'atomic channel-member lock contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'update_group_channel_metadata_atomic'
      AND function_row.oid IS DISTINCT FROM v_metadata_function
  ) THEN
    RAISE EXCEPTION
      'incompatible update_group_channel_metadata_atomic overload exists';
  END IF;

  IF v_metadata_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_metadata_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 8
  ) THEN
    RAISE EXCEPTION
      'existing update_group_channel_metadata_atomic signature is incompatible';
  END IF;

  IF pg_catalog.has_table_privilege(
    'anon', 'public.chat_channels', 'UPDATE'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', 'public.chat_channels', 'UPDATE'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.chat_channels', 'SELECT'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.chat_channels', 'UPDATE'
  ) OR NOT pg_catalog.has_table_privilege(
    'service_role', 'public.channel_members', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'channel metadata service-only boundary drifted';
  END IF;
END
$preflight$;

LOCK TABLE auth.users,
  public.user_profiles,
  public.chat_channels,
  public.channel_members
  IN SHARE MODE;

CREATE OR REPLACE FUNCTION public.update_group_channel_metadata_atomic(
  p_channel_id uuid,
  p_actor_id uuid,
  p_name text,
  p_name_present boolean,
  p_avatar_url text,
  p_avatar_url_present boolean,
  p_description text,
  p_description_present boolean
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_observed_channel record;
  v_channel record;
  v_updated_channel public.chat_channels%ROWTYPE;
  v_observed_channel_found boolean := false;
  v_channel_found boolean := false;
  v_auth_ids uuid[] := ARRAY[]::uuid[];
  v_locked_auth_ids uuid[] := ARRAY[]::uuid[];
  v_actor_role text;
  v_member record;
  v_actor_profile public.user_profiles%ROWTYPE;
  v_actor_profile_found boolean := false;
  v_changed boolean := false;
  v_updated_count integer := 0;
  v_applied_fields text[] := ARRAY[]::text[];
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_channel_id IS NULL
     OR p_actor_id IS NULL
     OR p_name_present IS NULL
     OR p_avatar_url_present IS NULL
     OR p_description_present IS NULL
     OR NOT (p_name_present OR p_avatar_url_present OR p_description_present)
     OR (NOT p_name_present AND p_name IS NOT NULL)
     OR (NOT p_avatar_url_present AND p_avatar_url IS NOT NULL)
     OR (NOT p_description_present AND p_description IS NOT NULL)
     OR (
       p_name_present
       AND (
         p_name IS NULL
         OR p_name IS DISTINCT FROM pg_catalog.btrim(p_name)
         OR pg_catalog.char_length(p_name) NOT BETWEEN 1 AND 100
       )
     )
     OR (
       p_avatar_url_present
       AND p_avatar_url IS NOT NULL
       AND (
         p_avatar_url IS DISTINCT FROM pg_catalog.btrim(p_avatar_url)
         OR pg_catalog.char_length(p_avatar_url) > 2048
         OR p_avatar_url !~ '^https?://'
       )
     )
     OR (
       p_description_present
       AND p_description IS NOT NULL
       AND (
         p_description IS DISTINCT FROM pg_catalog.btrim(p_description)
         OR pg_catalog.char_length(p_description) > 2000
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  IF p_name_present THEN
    v_applied_fields := pg_catalog.array_append(v_applied_fields, 'name');
  END IF;
  IF p_avatar_url_present THEN
    v_applied_fields := pg_catalog.array_append(v_applied_fields, 'avatar_url');
  END IF;
  IF p_description_present THEN
    v_applied_fields := pg_catalog.array_append(v_applied_fields, 'description');
  END IF;

  -- Metadata never changes owner state, so it takes the shared side before
  -- any other lock. Owner/channel deletion either wins first or fails its
  -- canonical try-lock instead of changing authority underneath this call.
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'channel-membership:channel:' || p_channel_id::text,
      0
    )
  );

  SELECT channel_row.*,
    channel_row.xmin::text || ':' || channel_row.ctid::text AS row_token
  INTO v_observed_channel
  FROM public.chat_channels AS channel_row
  WHERE channel_row.id = p_channel_id;
  v_observed_channel_found := FOUND;

  SELECT pg_catalog.array_agg(identity_id ORDER BY identity_id)
  INTO STRICT v_auth_ids
  FROM (
    SELECT p_actor_id AS identity_id
    UNION
    SELECT v_observed_channel.created_by
    WHERE v_observed_channel.created_by IS NOT NULL
  ) AS identity;

  FOR v_member IN
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id = ANY(v_auth_ids)
    ORDER BY auth_user.id
    FOR SHARE
  LOOP
    v_locked_auth_ids := pg_catalog.array_append(v_locked_auth_ids, v_member.id);
  END LOOP;

  IF NOT p_actor_id = ANY(v_locked_auth_ids) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  SELECT channel_row.*,
    channel_row.xmin::text || ':' || channel_row.ctid::text AS row_token
  INTO v_channel
  FROM public.chat_channels AS channel_row
  WHERE channel_row.id = p_channel_id
  FOR UPDATE;
  v_channel_found := FOUND;

  IF NOT v_observed_channel_found THEN
    IF v_channel_found THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'channel identity appeared while locking; retry';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CHANNEL_NOT_FOUND'
    );
  END IF;

  IF NOT v_channel_found
     OR v_channel.id IS DISTINCT FROM v_observed_channel.id
     OR v_channel.type IS DISTINCT FROM v_observed_channel.type
     OR v_channel.created_by IS DISTINCT FROM v_observed_channel.created_by
     OR v_channel.row_token IS DISTINCT FROM v_observed_channel.row_token
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'channel identity changed while locking; retry';
  END IF;

  IF v_channel.type IS DISTINCT FROM 'group' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CHANNEL_NOT_GROUP'
    );
  END IF;

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
  END LOOP;

  IF v_actor_role IS NULL OR v_actor_role NOT IN ('owner', 'admin') THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'PERMISSION_DENIED'
    );
  END IF;

  SELECT profile.*
  INTO v_actor_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR SHARE;
  v_actor_profile_found := FOUND;

  IF NOT v_actor_profile_found
     OR v_actor_profile.deleted_at IS NOT NULL
     OR v_actor_profile.banned_at IS NOT NULL
     OR (
       v_actor_profile.is_banned IS TRUE
       AND (
         v_actor_profile.ban_expires_at IS NULL
         OR v_actor_profile.ban_expires_at > pg_catalog.statement_timestamp()
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  v_changed :=
    (p_name_present AND v_channel.name IS DISTINCT FROM p_name)
    OR (
      p_avatar_url_present
      AND v_channel.avatar_url IS DISTINCT FROM p_avatar_url
    )
    OR (
      p_description_present
      AND v_channel.description IS DISTINCT FROM p_description
    );

  UPDATE public.chat_channels AS channel_row
  SET name = CASE WHEN p_name_present THEN p_name ELSE channel_row.name END,
      avatar_url = CASE
        WHEN p_avatar_url_present THEN p_avatar_url
        ELSE channel_row.avatar_url
      END,
      description = CASE
        WHEN p_description_present THEN p_description
        ELSE channel_row.description
      END,
      updated_at = pg_catalog.clock_timestamp()
  WHERE channel_row.id = p_channel_id
    AND channel_row.type = 'group'
    AND channel_row.created_by IS NOT DISTINCT FROM v_channel.created_by
  RETURNING channel_row.*
  INTO v_updated_channel;
  GET DIAGNOSTICS v_updated_count = ROW_COUNT;

  IF v_updated_count <> 1
     OR v_updated_channel.id IS DISTINCT FROM p_channel_id
     OR v_updated_channel.type IS DISTINCT FROM 'group'
     OR (p_name_present AND v_updated_channel.name IS DISTINCT FROM p_name)
     OR (
       p_avatar_url_present
       AND v_updated_channel.avatar_url IS DISTINCT FROM p_avatar_url
     )
     OR (
       p_description_present
       AND v_updated_channel.description IS DISTINCT FROM p_description
     )
     OR v_updated_channel.updated_at IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'channel metadata update acknowledgement is incomplete';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'actor_id', p_actor_id,
    'channel', pg_catalog.to_jsonb(v_updated_channel),
    'changed', v_changed,
    'applied_fields', pg_catalog.to_jsonb(v_applied_fields)
  );
END
$function$;

ALTER FUNCTION public.update_group_channel_metadata_atomic(
  uuid, uuid, text, boolean, text, boolean, text, boolean
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.update_group_channel_metadata_atomic(uuid,uuid,text,boolean,text,boolean,text,boolean)'::regprocedure;
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
    ON FUNCTION public.update_group_channel_metadata_atomic(
      uuid, uuid, text, boolean, text, boolean, text, boolean
    )
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.update_group_channel_metadata_atomic(
      uuid, uuid, text, boolean, text, boolean, text, boolean
    )
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-channel-metadata-mutation:v1:' || pg_catalog.md5(v_source)
  );
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.update_group_channel_metadata_atomic(uuid,uuid,text,boolean,text,boolean,text,boolean)'::regprocedure;
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
    AND function_row.pronargs = 8
    AND function_row.pronargdefaults = 0
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'atomic-channel-metadata-mutation:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, $$'group-channel-owner-invariant:v1'$$) = 0
     OR pg_catalog.strpos(v_source, $$'channel-membership:channel:'$$) = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.channel_members') = 0
     OR pg_catalog.strpos(v_source, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_source, 'UPDATE public.chat_channels') = 0
     OR pg_catalog.strpos(v_source, 'applied_fields') = 0
  THEN
    RAISE EXCEPTION 'atomic channel metadata body attestation failed';
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
    RAISE EXCEPTION 'atomic channel metadata ACL attestation failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
