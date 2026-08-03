-- Migration: 20260729182000_durable_channel_message_send.sql
-- Created: 2026-07-30T01:20:00Z
-- Description: Give every group-channel message send a durable operation ID.
--   Exact replays return the original message acknowledgement; concurrent
--   replays serialize to one message insert and conflicting intent fails closed.
--
-- Forward compensation: roll API callers back before restoring EXECUTE on the
-- seven-argument RPC and dropping the eight-argument RPC or its private ledger.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.channel_messages:durable-send:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'durable channel-message send migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_missing_roles text[];
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_base_function regprocedure := pg_catalog.to_regprocedure(
    'public.send_channel_message_atomic(uuid,uuid,text,text,text,text,uuid)'
  );
  v_base_source text;
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION
      'durable channel-message roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR v_base_function IS NULL
     OR pg_catalog.to_regclass('public.channel_messages') IS NULL
     OR pg_catalog.to_regclass('public.channel_message_reads') IS NULL
  THEN
    RAISE EXCEPTION 'atomic channel-message send authority must deploy first';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_base_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_base_function
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'jsonb'::regtype
    AND NOT function_row.proretset
    AND function_row.pronargs = 7
    AND function_row.pronargdefaults = 4
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.obj_description(v_base_function, 'pg_proc') IS DISTINCT FROM
       'atomic-channel-message-send:v1:' || pg_catalog.md5(v_base_source)
     OR pg_catalog.strpos(
       v_base_source,
       $$'group-channel-owner-invariant:v1'$$
     ) = 0
     OR pg_catalog.strpos(
       v_base_source,
       $$'channel-membership:channel:'$$
     ) = 0
     OR pg_catalog.strpos(
       v_base_source,
       'INSERT INTO public.channel_messages'
     ) = 0
     OR pg_catalog.strpos(
       v_base_source,
       'INSERT INTO public.channel_message_reads'
     ) = 0
  THEN
    RAISE EXCEPTION 'atomic channel-message send base contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'send_channel_message_idempotent'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
        <> 'p_operation_id uuid, p_channel_id uuid, p_sender_id uuid, p_content text, p_media_url text, p_media_type text, p_media_name text, p_reply_to_id uuid'
  ) THEN
    RAISE EXCEPTION
      'incompatible send_channel_message_idempotent overload exists';
  END IF;
END
$preflight$;

DO $create_private_replay_ledger$
BEGIN
  IF pg_catalog.to_regclass(
    'public.channel_message_send_operations'
  ) IS NULL THEN
    CREATE TABLE public.channel_message_send_operations (
      operation_id uuid NOT NULL,
      actor_id uuid NOT NULL,
      channel_id uuid NOT NULL,
      intent_fingerprint text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
      CONSTRAINT channel_message_send_operations_pkey
        PRIMARY KEY (operation_id),
      CONSTRAINT channel_message_send_fingerprint_check CHECK (
        intent_fingerprint ~ '^[0-9a-f]{64}$'
        AND pg_catalog.octet_length(intent_fingerprint) = 64
      ),
      CONSTRAINT channel_message_send_result_check CHECK (
        pg_catalog.jsonb_typeof(result) = 'object'
        AND NOT result ? 'applied'
        AND result ?& ARRAY[
          'success',
          'operation_id',
          'actor_id',
          'channel_id',
          'message',
          'reply_author_id',
          'read_at'
        ]
        AND result ->> 'success' = 'true'
        AND result ->> 'operation_id' = operation_id::text
        AND result ->> 'actor_id' = actor_id::text
        AND result ->> 'channel_id' = channel_id::text
        AND pg_catalog.jsonb_typeof(result -> 'message') = 'object'
        AND result #>> '{message,channel_id}' = channel_id::text
        AND result #>> '{message,sender_id}' = actor_id::text
        AND pg_catalog.jsonb_typeof(result -> 'read_at') = 'string'
      )
    );
  END IF;
END
$create_private_replay_ledger$;

-- The ledger is the deployment/runtime barrier. Runtime takes ROW EXCLUSIVE
-- before delegating to the old transactional authority; replay takes ACCESS
-- EXCLUSIVE before changing the dependency or its ACL.
LOCK TABLE public.channel_message_send_operations
  IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.channel_messages
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.channel_message_reads
  IN SHARE ROW EXCLUSIVE MODE;

ALTER TABLE public.channel_message_send_operations OWNER TO postgres;
ALTER TABLE public.channel_message_send_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES
  ON TABLE public.channel_message_send_operations
  FROM PUBLIC, anon, authenticated, service_role;

DO $ledger_attestation$
DECLARE
  v_ledger regclass := 'public.channel_message_send_operations'::regclass;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_invalid_columns text[];
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_ledger
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relowner <> v_postgres_oid
        OR NOT relation.relrowsecurity
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_ledger
       OR inheritance.inhparent = v_ledger
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = v_ledger
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.contype = 'f'
  ) THEN
    RAISE EXCEPTION 'channel-message send replay ledger catalog drifted';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I expected %s%s',
      required.name,
      required.type_oid::regtype,
      CASE WHEN required.not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      (1, 'operation_id', 'uuid'::regtype, true),
      (2, 'actor_id', 'uuid'::regtype, true),
      (3, 'channel_id', 'uuid'::regtype, true),
      (4, 'intent_fingerprint', 'text'::regtype, true),
      (5, 'result', 'jsonb'::regtype, true),
      (6, 'created_at', 'timestamptz'::regtype, true)
  ) AS required(ordinality, name, type_oid, not_null)
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = v_ledger
   AND attribute.attname = required.name
   AND attribute.attnum = required.ordinality
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required.type_oid
     OR (required.not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_ledger
      AND attribute.attnum > 6
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION
      'channel-message send replay ledger columns drifted: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.conname = 'channel_message_send_operations_pkey'
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.conname = 'channel_message_send_fingerprint_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_ledger
      AND constraint_row.conname = 'channel_message_send_result_check'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
  ) THEN
    RAISE EXCEPTION 'channel-message send replay ledger constraints drifted';
  END IF;
END
$ledger_attestation$;

CREATE OR REPLACE FUNCTION public.send_channel_message_idempotent(
  p_operation_id uuid,
  p_channel_id uuid,
  p_sender_id uuid,
  p_content text,
  p_media_url text DEFAULT NULL,
  p_media_type text DEFAULT NULL,
  p_media_name text DEFAULT NULL,
  p_reply_to_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_intent_fingerprint text;
  v_existing public.channel_message_send_operations%ROWTYPE;
  v_base_result jsonb;
  v_base_key_count integer;
  v_message_key_count integer;
  v_result jsonb;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  LOCK TABLE public.channel_message_send_operations
    IN ROW EXCLUSIVE MODE;

  IF p_operation_id IS NULL
     OR p_channel_id IS NULL
     OR p_sender_id IS NULL
     OR p_content IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'INVALID'
    );
  END IF;

  v_intent_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(
      pg_catalog.jsonb_build_array(
        'channel-message-send:v1',
        p_sender_id,
        p_channel_id,
        p_content,
        p_media_url,
        p_media_type,
        p_media_name,
        p_reply_to_id
      )::text,
      'UTF8'
    )),
    'hex'
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'channel-message-send-operation:' || p_operation_id::text,
      0
    )
  );

  SELECT operation_row.*
  INTO v_existing
  FROM public.channel_message_send_operations AS operation_row
  WHERE operation_row.operation_id = p_operation_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.actor_id IS DISTINCT FROM p_sender_id
       OR v_existing.channel_id IS DISTINCT FROM p_channel_id
       OR v_existing.intent_fingerprint IS DISTINCT FROM v_intent_fingerprint
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'OPERATION_CONFLICT'
      );
    END IF;

    RETURN v_existing.result
      || pg_catalog.jsonb_build_object('applied', false);
  END IF;

  SELECT public.send_channel_message_atomic(
    p_channel_id,
    p_sender_id,
    p_content,
    p_media_url,
    p_media_type,
    p_media_name,
    p_reply_to_id
  )
  INTO STRICT v_base_result;

  IF pg_catalog.jsonb_typeof(v_base_result) IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_base_result -> 'success') IS DISTINCT FROM 'boolean'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'channel-message send base acknowledgement is malformed';
  END IF;

  SELECT pg_catalog.count(*)
  INTO STRICT v_base_key_count
  FROM pg_catalog.jsonb_object_keys(v_base_result);

  IF v_base_result ->> 'success' = 'false' THEN
    IF v_base_key_count <> 2
       OR pg_catalog.jsonb_typeof(v_base_result -> 'reason') IS DISTINCT FROM 'string'
       OR v_base_result ->> 'reason' NOT IN (
         'INVALID',
         'ACTOR_UNAVAILABLE',
         'CHANNEL_NOT_FOUND',
         'CHANNEL_NOT_GROUP',
         'MEMBERSHIP_NOT_FOUND',
         'INVALID_REPLY_TARGET'
       )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'channel-message send base denial is malformed';
    END IF;
    RETURN v_base_result;
  END IF;

  IF v_base_result ->> 'success' IS DISTINCT FROM 'true'
     OR v_base_key_count <> 6
     OR NOT v_base_result ?& ARRAY[
       'success',
       'actor_id',
       'channel_id',
       'message',
       'reply_author_id',
       'read_at'
     ]
     OR v_base_result ->> 'actor_id' IS DISTINCT FROM p_sender_id::text
     OR v_base_result ->> 'channel_id' IS DISTINCT FROM p_channel_id::text
     OR pg_catalog.jsonb_typeof(v_base_result -> 'message') IS DISTINCT FROM 'object'
     OR pg_catalog.jsonb_typeof(v_base_result -> 'read_at') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(v_base_result -> 'reply_author_id') NOT IN ('string', 'null')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'channel-message send base success is malformed';
  END IF;

  SELECT pg_catalog.count(*)
  INTO STRICT v_message_key_count
  FROM pg_catalog.jsonb_object_keys(v_base_result -> 'message');

  IF v_message_key_count <> 9
     OR NOT (v_base_result -> 'message') ?& ARRAY[
       'id',
       'channel_id',
       'sender_id',
       'content',
       'media_url',
       'media_type',
       'media_name',
       'created_at',
       'reply_to_id'
     ]
     OR pg_catalog.jsonb_typeof(v_base_result #> '{message,id}') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(v_base_result #> '{message,channel_id}') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(v_base_result #> '{message,sender_id}') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(v_base_result #> '{message,content}') IS DISTINCT FROM 'string'
     OR pg_catalog.jsonb_typeof(v_base_result #> '{message,media_url}') NOT IN ('string', 'null')
     OR pg_catalog.jsonb_typeof(v_base_result #> '{message,media_type}') NOT IN ('string', 'null')
     OR pg_catalog.jsonb_typeof(v_base_result #> '{message,media_name}') NOT IN ('string', 'null')
     OR pg_catalog.jsonb_typeof(v_base_result #> '{message,reply_to_id}') NOT IN ('string', 'null')
     OR v_base_result #>> '{message,channel_id}' IS DISTINCT FROM p_channel_id::text
     OR v_base_result #>> '{message,sender_id}' IS DISTINCT FROM p_sender_id::text
     OR v_base_result #>> '{message,content}' IS DISTINCT FROM p_content
     OR (v_base_result #>> '{message,media_url}') IS DISTINCT FROM p_media_url
     OR (v_base_result #>> '{message,media_type}') IS DISTINCT FROM p_media_type
     OR (v_base_result #>> '{message,media_name}') IS DISTINCT FROM p_media_name
     OR (v_base_result #>> '{message,reply_to_id}') IS DISTINCT FROM p_reply_to_id::text
     OR pg_catalog.jsonb_typeof(v_base_result #> '{message,created_at}') IS DISTINCT FROM 'string'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'channel-message send base success is malformed';
  END IF;

  v_result := v_base_result || pg_catalog.jsonb_build_object(
    'operation_id', p_operation_id
  );

  INSERT INTO public.channel_message_send_operations (
    operation_id,
    actor_id,
    channel_id,
    intent_fingerprint,
    result
  ) VALUES (
    p_operation_id,
    p_sender_id,
    p_channel_id,
    v_intent_fingerprint,
    v_result
  );

  RETURN v_result || pg_catalog.jsonb_build_object('applied', true);
END
$function$;

ALTER FUNCTION public.send_channel_message_idempotent(
  uuid, uuid, uuid, text, text, text, text, uuid
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_base_function regprocedure :=
    'public.send_channel_message_atomic(uuid,uuid,text,text,text,text,uuid)'::regprocedure;
  v_function regprocedure :=
    'public.send_channel_message_idempotent(uuid,uuid,uuid,text,text,text,text,uuid)'::regprocedure;
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
    ON FUNCTION public.send_channel_message_atomic(
      uuid, uuid, text, text, text, text, uuid
    )
    FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL PRIVILEGES
    ON FUNCTION public.send_channel_message_idempotent(
      uuid, uuid, uuid, text, text, text, text, uuid
    )
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.send_channel_message_idempotent(
      uuid, uuid, uuid, text, text, text, text, uuid
    )
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'durable-channel-message-send:v1:' || pg_catalog.md5(v_source)
  );

  IF pg_catalog.has_function_privilege(
    'service_role', v_base_function, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'legacy channel-message send RPC remained externally executable';
  END IF;
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_ledger regclass := 'public.channel_message_send_operations'::regclass;
  v_base_function regprocedure :=
    'public.send_channel_message_atomic(uuid,uuid,text,text,text,text,uuid)'::regprocedure;
  v_function regprocedure :=
    'public.send_channel_message_idempotent(uuid,uuid,uuid,text,text,text,text,uuid)'::regprocedure;
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
    AND function_row.pronargdefaults = 4
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.obj_description(v_function, 'pg_proc') IS DISTINCT FROM
       'durable-channel-message-send:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(
       v_source,
       'FROM public.channel_message_send_operations'
     ) = 0
     OR pg_catalog.strpos(
       v_source,
       'public.send_channel_message_atomic('
     ) = 0
     OR pg_catalog.strpos(
       v_source,
       'INSERT INTO public.channel_message_send_operations'
     ) = 0
     OR pg_catalog.strpos(v_source, $$'OPERATION_CONFLICT'$$) = 0
     OR pg_catalog.strpos(v_source, $$'applied', false$$) = 0
     OR pg_catalog.strpos(v_source, $$'applied', true$$) = 0
  THEN
    RAISE EXCEPTION
      'durable channel-message send body attestation failed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role', v_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role', v_base_function, 'EXECUTE'
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
  ) OR pg_catalog.has_table_privilege(
    'service_role', v_ledger, 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'service_role', v_ledger, 'INSERT'
  ) OR pg_catalog.has_table_privilege(
    'authenticated', v_ledger, 'SELECT'
  ) OR pg_catalog.has_table_privilege(
    'anon', v_ledger, 'SELECT'
  ) THEN
    RAISE EXCEPTION 'durable channel-message send ACL attestation failed';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
