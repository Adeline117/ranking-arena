-- Add a single-transaction soft-delete contract for 1:1 direct messages.
-- This migration is deliberately SQL-first: deploy 20260716112100 and
-- 20260716114000 first, deploy this boundary second, and switch the DELETE
-- route only after the database contract is present and verified.
--
-- Empty conversations use their created_at as last_message_at. If a legacy
-- conversation has no created_at, Unix epoch is the non-sensitive fallback;
-- a deleted message timestamp is never retained as the empty-thread summary.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.direct_messages:atomic-delete-boundary',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic direct-message delete migration lock is busy';
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
  v_service_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_authenticated_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_missing_roles text[];
  v_invalid_columns text[];
  v_invalid_rows bigint;
  v_send_function regprocedure := pg_catalog.to_regprocedure(
    'public.send_direct_message_atomic(uuid,uuid,text,text,text,text,uuid)'
  );
  v_permission_function regprocedure := pg_catalog.to_regprocedure(
    'public.check_dm_permission(uuid,uuid)'
  );
  v_pair_function regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_direct_message_pair_edge()'
  );
  v_integrity_function regprocedure := pg_catalog.to_regprocedure(
    'public.validate_direct_message_integrity()'
  );
  v_insert_summary_function regprocedure := pg_catalog.to_regprocedure(
    'public.update_conversation_on_message()'
  );
  v_notification_function regprocedure := pg_catalog.to_regprocedure(
    'public.create_message_notification()'
  );
  v_reader_function regprocedure := pg_catalog.to_regprocedure(
    'public.is_current_user_active_for_direct_messages()'
  );
  v_delete_function regprocedure := pg_catalog.to_regprocedure(
    'public.delete_direct_message_atomic(uuid,uuid)'
  );
  v_recalculate_function regprocedure := pg_catalog.to_regprocedure(
    'public.recalculate_direct_message_conversation_summary(uuid)'
  );
  v_delete_trigger_function regprocedure := pg_catalog.to_regprocedure(
    'public.maintain_direct_message_delete_summary()'
  );
  v_immutable_guard_function regprocedure := pg_catalog.to_regprocedure(
    'public.guard_direct_message_immutable_fields()'
  );
  v_new_component_count integer;
  v_is_replay boolean;
  v_id_attnum smallint;
  v_conversation_id_attnum smallint;
  v_conversations_id_attnum smallint;
  v_conversation_user1_attnum smallint;
  v_conversation_user2_attnum smallint;
  v_sender_attnum smallint;
  v_receiver_attnum smallint;
  v_content_attnum smallint;
  v_media_url_attnum smallint;
  v_media_type_attnum smallint;
  v_media_name_attnum smallint;
  v_deleted_attnum smallint;
  v_reply_attnum smallint;
  v_latest_index regclass := pg_catalog.to_regclass(
    'public.idx_direct_messages_live_conversation_latest'
  );
  v_relation_name text;
  v_relation regclass;
  v_role name;
  v_privilege text;
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
    RAISE EXCEPTION 'direct-message ACL roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('public.conversations') IS NULL
     OR pg_catalog.to_regclass('public.direct_messages') IS NULL
  THEN
    RAISE EXCEPTION
      '20260716114000 conversations/direct_messages tables are required';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.conversations'::regclass,
      'public.direct_messages'::regclass
    )
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
      AND relation.relowner = v_postgres_oid
      AND relation.relrowsecurity
    GROUP BY relation.relowner
    HAVING pg_catalog.count(*) = 2
  ) THEN
    RAISE EXCEPTION
      '20260716114000 permanent ordinary postgres-owned RLS table contract is required';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'public.conversations'::regclass,
      'public.direct_messages'::regclass
    )
       OR inheritance.inhparent IN (
         'public.conversations'::regclass,
         'public.direct_messages'::regclass
       )
  ) THEN
    RAISE EXCEPTION
      'direct-message relations must not participate in inheritance or partitioning';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'public.conversations'::regclass,
      'public.direct_messages'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'direct-message relations must not have rewrite rules';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::regtype THEN
    RAISE EXCEPTION 'auth.role() returning text must exist';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      'public.%I.%I (expected %s%s)',
      required_column.table_name,
      required_column.column_name,
      required_column.type_name,
      CASE WHEN required_column.required_not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required_column.table_name, required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      ('conversations', 1, 'id', 'uuid', true),
      ('conversations', 2, 'user1_id', 'uuid', true),
      ('conversations', 3, 'user2_id', 'uuid', true),
      ('conversations', 4, 'last_message_at', 'timestamp with time zone', false),
      ('conversations', 5, 'last_message_preview', 'text', false),
      ('conversations', 6, 'created_at', 'timestamp with time zone', false),
      ('direct_messages', 1, 'id', 'uuid', true),
      ('direct_messages', 2, 'conversation_id', 'uuid', true),
      ('direct_messages', 3, 'sender_id', 'uuid', true),
      ('direct_messages', 4, 'receiver_id', 'uuid', true),
      ('direct_messages', 5, 'content', 'text', true),
      ('direct_messages', 6, 'read', 'boolean', false),
      ('direct_messages', 7, 'created_at', 'timestamp with time zone', false),
      ('direct_messages', 8, 'media_url', 'text', false),
      ('direct_messages', 9, 'media_type', 'text', false),
      ('direct_messages', 10, 'media_name', 'text', false),
      ('direct_messages', 11, 'read_at', 'timestamp with time zone', false),
      ('direct_messages', 12, 'deleted_at', 'timestamp with time zone', false),
      ('direct_messages', 13, 'reply_to_id', 'uuid', false)
  ) AS required_column(
    table_name,
    ordinality,
    column_name,
    type_name,
    required_not_null
  )
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass(
      pg_catalog.format('public.%I', required_column.table_name)
    )
   AND attribute.attname = required_column.column_name
   AND attribute.attnum > 0
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
          <> required_column.type_name
     OR (required_column.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION
      'direct-message delete boundary has incompatible columns: %',
      v_invalid_columns;
  END IF;

  -- The current direct_messages contract has no updated_at column. If one is
  -- added later it must be explicitly classified before this fail-closed guard
  -- can permit it as mutable state.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.direct_messages'::regclass
      AND attribute.attname = 'updated_at'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) THEN
    RAISE EXCEPTION
      'direct_messages.updated_at requires an explicit mutability decision';
  END IF;

  -- Exact 112100 and 114000 callable contracts are required. ACL drift in a
  -- dependency is rejected rather than silently repaired by this migration.
  IF v_permission_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_permission_function
      AND function_row.prokind = 'f'
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.pronargs = 2
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_permission_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_permission_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_permission_function,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'canonical 20260716112100 check_dm_permission contract is required';
  END IF;

  IF v_send_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_send_function
      AND function_row.prokind = 'f'
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.pronargs = 7
      AND function_row.pronargdefaults = 4
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.strpos(
        function_row.prosrc,
        'direct-message:pair:'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'public.check_dm_permission'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'INSERT INTO public.direct_messages'
      ) > 0
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_send_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_send_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_send_function,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'canonical 20260716114000 send_direct_message_atomic contract is required';
  END IF;

  FOREACH v_pair_function IN ARRAY ARRAY[
    v_pair_function,
    v_integrity_function,
    v_insert_summary_function,
    v_notification_function
  ]::regprocedure[]
  LOOP
    IF v_pair_function IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_pair_function
        AND function_row.prokind = 'f'
        AND function_row.proowner = v_postgres_oid
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.prorettype = 'trigger'::regtype
        AND function_row.pronargs = 0
        AND function_row.pronargdefaults = 0
        AND function_row.proconfig = ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
    ) THEN
      RAISE EXCEPTION
        'canonical 20260716114000 trigger-function contracts are required';
    END IF;
  END LOOP;

  -- Restore the pair-function variable after the catalog-contract loop.
  v_pair_function := pg_catalog.to_regprocedure(
    'public.serialize_direct_message_pair_edge()'
  );

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid IN (
      v_permission_function,
      v_send_function,
      v_pair_function,
      v_integrity_function,
      v_insert_summary_function,
      v_notification_function
    )
      AND acl_entry.grantee <> function_row.proowner
      AND NOT (
        function_row.oid IN (
          v_permission_function::oid,
          v_send_function::oid
        )
        AND acl_entry.grantee = v_service_role_oid
        AND acl_entry.privilege_type = 'EXECUTE'
      )
  ) THEN
    RAISE EXCEPTION
      '20260716112100/114000 dependency function ACL drift detected';
  END IF;

  IF pg_catalog.strpos(
    (SELECT function_row.prosrc FROM pg_catalog.pg_proc AS function_row
     WHERE function_row.oid = v_pair_function),
    'direct-message:pair:'
  ) = 0 THEN
    RAISE EXCEPTION
      '20260716114000 pair serializer does not use the canonical lock key';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'send_direct_message_atomic'
      AND function_row.prokind = 'f'
  ) <> 1 THEN
    RAISE EXCEPTION
      'send_direct_message_atomic has duplicate or missing overloads';
  END IF;

  -- Detect whether this is a fresh install or a replay. Partial/duplicate new
  -- boundary components are drift and must never be guessed around.
  SELECT pg_catalog.count(*)
  INTO v_new_component_count
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_namespace AS function_schema
    ON function_schema.oid = function_row.pronamespace
  WHERE function_schema.nspname = 'public'
    AND function_row.proname IN (
      'delete_direct_message_atomic',
      'recalculate_direct_message_conversation_summary',
      'maintain_direct_message_delete_summary',
      'guard_direct_message_immutable_fields'
    )
    AND function_row.prokind = 'f';

  IF v_new_component_count = 0 THEN
    v_is_replay := false;
  ELSIF v_new_component_count = 4
    AND v_delete_function IS NOT NULL
    AND v_recalculate_function IS NOT NULL
    AND v_delete_trigger_function IS NOT NULL
    AND v_immutable_guard_function IS NOT NULL
    AND (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
        AND trigger_row.tgname = 'trg_recalculate_dm_summary_after_delete'
        AND NOT trigger_row.tgisinternal
    ) = 1
    AND (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
        AND trigger_row.tgname = 'trg_guard_dm_immutable_fields'
        AND NOT trigger_row.tgisinternal
    ) = 1
  THEN
    v_is_replay := true;
  ELSE
    RAISE EXCEPTION
      'atomic direct-message delete boundary is partial or overloaded';
  END IF;

  IF NOT v_is_replay AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname IN (
        'trg_recalculate_dm_summary_after_delete',
        'trg_guard_dm_immutable_fields'
      )
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION
      'fresh atomic delete install found a conflicting summary trigger';
  END IF;

  IF v_is_replay AND (
    NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_delete_function
        AND function_row.proowner = v_postgres_oid
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.prorettype = 'jsonb'::regtype
        AND function_row.pronargs = 2
        AND function_row.pronargdefaults = 0
        AND function_row.proconfig = ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_recalculate_function
        AND function_row.proowner = v_postgres_oid
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.prorettype = 'boolean'::regtype
        AND function_row.pronargs = 1
        AND function_row.pronargdefaults = 0
        AND function_row.proconfig = ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_delete_trigger_function
        AND function_row.proowner = v_postgres_oid
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.prorettype = 'trigger'::regtype
        AND function_row.pronargs = 0
        AND function_row.pronargdefaults = 0
        AND function_row.proconfig = ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_immutable_guard_function
        AND function_row.proowner = v_postgres_oid
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.prorettype = 'trigger'::regtype
        AND function_row.pronargs = 0
        AND function_row.pronargdefaults = 0
        AND function_row.proconfig = ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
    )
  ) THEN
    RAISE EXCEPTION
      'atomic direct-message delete function catalog drift detected';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgfoid = v_insert_summary_function
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'on_dm_sent'
      AND trigger_row.tgfoid = v_insert_summary_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 5
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgfoid = v_notification_function
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'on_dm_received'
      AND trigger_row.tgfoid = v_notification_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 5
  ) THEN
    RAISE EXCEPTION
      '20260716114000 insert side-effect triggers are not exactly once';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgfoid = v_pair_function
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_serialize_dm_message_pair'
      AND trigger_row.tgfoid = v_pair_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
  ) THEN
    RAISE EXCEPTION
      '20260716114000 direct-message pair trigger is not exactly once';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_validate_direct_message_integrity'
      AND trigger_row.tgfoid = v_integrity_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 23
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgname NOT IN (
        'on_dm_received',
        'on_dm_sent',
        'trg_serialize_dm_message_pair',
        'trg_validate_direct_message_integrity',
        'trg_recalculate_dm_summary_after_delete',
        'trg_guard_dm_immutable_fields'
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
  ) <> (CASE WHEN v_is_replay THEN 6 ELSE 4 END) THEN
    RAISE EXCEPTION
      'direct_messages has unexpected, disabled, or duplicate user triggers';
  END IF;

  SELECT attribute.attnum
  INTO STRICT v_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'id';
  SELECT attribute.attnum
  INTO STRICT v_conversation_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'conversation_id';
  SELECT attribute.attnum
  INTO STRICT v_conversations_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversations'::regclass
    AND attribute.attname = 'id';
  SELECT attribute.attnum
  INTO STRICT v_conversation_user1_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversations'::regclass
    AND attribute.attname = 'user1_id';
  SELECT attribute.attnum
  INTO STRICT v_conversation_user2_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversations'::regclass
    AND attribute.attname = 'user2_id';
  SELECT attribute.attnum
  INTO STRICT v_sender_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'sender_id';
  SELECT attribute.attnum
  INTO STRICT v_receiver_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'receiver_id';
  SELECT attribute.attnum
  INTO STRICT v_content_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'content';
  SELECT attribute.attnum
  INTO STRICT v_media_url_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'media_url';
  SELECT attribute.attnum
  INTO STRICT v_media_type_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'media_type';
  SELECT attribute.attnum
  INTO STRICT v_media_name_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'media_name';
  SELECT attribute.attnum
  INTO STRICT v_deleted_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'deleted_at';
  SELECT attribute.attnum
  INTO STRICT v_reply_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'reply_to_id';

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'on_dm_sent'
      AND trigger_row.tgfoid = v_insert_summary_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 5
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
      AND trigger_row.tgqual IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'on_dm_received'
      AND trigger_row.tgfoid = v_notification_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 5
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
      AND trigger_row.tgqual IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_serialize_dm_message_pair'
      AND trigger_row.tgfoid = v_pair_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
      AND trigger_row.tgqual IS NULL
      AND (
        (
          NOT v_is_replay
          AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 2
          AND trigger_row.tgattr::smallint[] @> ARRAY[
            v_sender_attnum,
            v_receiver_attnum
          ]::smallint[]
        ) OR (
          v_is_replay
          AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 3
          AND trigger_row.tgattr::smallint[] @> ARRAY[
            v_sender_attnum,
            v_receiver_attnum,
            v_deleted_attnum
          ]::smallint[]
        )
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_validate_direct_message_integrity'
      AND trigger_row.tgfoid = v_integrity_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 23
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 8
      AND trigger_row.tgattr::smallint[] @> ARRAY[
        v_conversation_id_attnum,
        v_sender_attnum,
        v_receiver_attnum,
        v_content_attnum,
        v_media_url_attnum,
        v_media_type_attnum,
        v_media_name_attnum,
        v_reply_attnum
      ]::smallint[]
      AND trigger_row.tgqual IS NULL
  ) OR (
    v_is_replay AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
        AND trigger_row.tgname = 'trg_recalculate_dm_summary_after_delete'
        AND trigger_row.tgfoid = v_delete_trigger_function
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgenabled = 'O'
        AND trigger_row.tgtype = 25
        AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 1
        AND trigger_row.tgattr::smallint[] @>
          ARRAY[v_deleted_attnum]::smallint[]
        AND trigger_row.tgqual IS NULL
    )
  ) OR (
    v_is_replay AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
        AND trigger_row.tgname = 'trg_guard_dm_immutable_fields'
        AND trigger_row.tgfoid = v_immutable_guard_function
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgenabled = 'O'
        AND trigger_row.tgtype = 19
        AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
        AND trigger_row.tgqual IS NULL
    )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
  ) <> (CASE WHEN v_is_replay THEN 6 ELSE 4 END) THEN
    RAISE EXCEPTION
      'direct_messages exact user-trigger catalog drift detected';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.direct_messages'::regclass
      AND constraint_row.confrelid = 'public.direct_messages'::regclass
      AND constraint_row.conkey = ARRAY[v_reply_attnum]::smallint[]
      AND constraint_row.confkey = ARRAY[v_id_attnum]::smallint[]
      AND constraint_row.confupdtype = 'a'
      AND constraint_row.confdeltype = 'n'
      AND constraint_row.confmatchtype = 's'
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.convalidated
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.direct_messages'::regclass
      AND (
        v_reply_attnum = ANY(constraint_row.conkey)
        OR constraint_row.confrelid = 'public.direct_messages'::regclass
      )
  ) <> 1 THEN
    RAISE EXCEPTION
      'direct_messages.reply_to_id ON DELETE SET NULL FK contract drift detected';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.direct_messages'::regclass
      AND constraint_row.confrelid = 'public.conversations'::regclass
      AND constraint_row.conkey =
        ARRAY[v_conversation_id_attnum]::smallint[]
      AND constraint_row.confkey =
        ARRAY[v_conversations_id_attnum]::smallint[]
      AND constraint_row.confupdtype = 'a'
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.confmatchtype = 's'
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.convalidated
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.direct_messages'::regclass
      AND (
        v_conversation_id_attnum = ANY(constraint_row.conkey)
        OR constraint_row.confrelid = 'public.conversations'::regclass
      )
  ) <> 1 THEN
    RAISE EXCEPTION
      'direct_messages.conversation_id ON DELETE CASCADE FK contract drift detected';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_serialize_dm_message_pair'
      AND (
        (
          NOT v_is_replay
          AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 2
          AND trigger_row.tgattr::smallint[] @> ARRAY[
            v_sender_attnum,
            v_receiver_attnum
          ]::smallint[]
        )
        OR (
          v_is_replay
          AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 3
          AND trigger_row.tgattr::smallint[] @> ARRAY[
            v_sender_attnum,
            v_receiver_attnum,
            v_deleted_attnum
          ]::smallint[]
        )
      )
  ) THEN
    RAISE EXCEPTION
      'direct-message pair trigger column contract drift detected';
  END IF;

  IF v_is_replay AND (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgfoid = v_delete_trigger_function
  ) <> 1 THEN
    RAISE EXCEPTION
      'direct-message delete summary trigger is duplicated or missing';
  END IF;

  IF v_is_replay AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_recalculate_dm_summary_after_delete'
      AND trigger_row.tgfoid = v_delete_trigger_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 25
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 1
      AND trigger_row.tgattr::smallint[] @>
        ARRAY[v_deleted_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'direct-message delete summary trigger catalog drift detected';
  END IF;

  IF v_is_replay AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_guard_dm_immutable_fields'
      AND trigger_row.tgfoid = v_immutable_guard_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 19
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
  ) THEN
    RAISE EXCEPTION
      'direct-message immutable-field guard trigger catalog drift detected';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.conversations'::regclass
      AND (
        index_metadata.indisunique
        OR index_metadata.indisexclusion
      )
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 2
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname ORDER BY attribute.attname
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality <= index_metadata.indnkeyatts
      ) = ARRAY['user1_id', 'user2_id']::name[]
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.conversations'::regclass
      AND constraint_row.contype IN ('u', 'x')
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname ORDER BY attribute.attname
        )
        FROM pg_catalog.unnest(constraint_row.conkey)
          AS key_column(attnum)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = constraint_row.conrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['user1_id', 'user2_id']::name[]
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_index AS index_metadata
      ON index_metadata.indexrelid = constraint_row.conindid
    WHERE constraint_row.conrelid = 'public.conversations'::regclass
      AND constraint_row.contype = 'u'
      AND constraint_row.conkey = ARRAY[
        v_conversation_user1_attnum,
        v_conversation_user2_attnum
      ]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND index_metadata.indrelid = 'public.conversations'::regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indimmediate
      AND NOT index_metadata.indisexclusion
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 2
      AND index_metadata.indnatts = 2
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.conversations'::regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.regexp_replace(
        pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ),
        '[()[:space:]]',
        '',
        'g'
      ) = 'user1_id<user2_id'
  ) THEN
    RAISE EXCEPTION
      '20260716114000 immediate nondeferrable ordered conversation-pair contract is required';
  END IF;

  IF v_latest_index IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indexrelid = v_latest_index
      AND index_metadata.indrelid = 'public.direct_messages'::regclass
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND NOT index_metadata.indisunique
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 3
      AND index_metadata.indnatts = 3
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['conversation_id', 'created_at', 'id']::name[]
      AND pg_catalog.pg_get_expr(
        index_metadata.indpred,
        index_metadata.indrelid,
        true
      ) = 'deleted_at IS NULL'
      AND pg_catalog.strpos(
        pg_catalog.pg_get_indexdef(index_metadata.indexrelid),
        'created_at DESC NULLS LAST, id DESC'
      ) > 0
  ) THEN
    RAISE EXCEPTION
      'named direct-message live-summary index has incompatible drift';
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_invalid_rows
  FROM public.direct_messages AS message_row
  LEFT JOIN public.conversations AS conversation
    ON conversation.id = message_row.conversation_id
  WHERE message_row.sender_id = message_row.receiver_id
     OR conversation.id IS NULL
     OR conversation.user1_id <> LEAST(
       message_row.sender_id,
       message_row.receiver_id
     )
     OR conversation.user2_id <> GREATEST(
       message_row.sender_id,
       message_row.receiver_id
     );

  IF v_invalid_rows > 0 THEN
    RAISE EXCEPTION
      'direct_messages has % rows outside their canonical conversation pair',
      v_invalid_rows;
  END IF;

  -- Keep the exact browser/service ACL boundary established by 114000. This
  -- migration adds one RPC; it does not reopen table writes to clients or
  -- accept a replay that silently removed a required read/write grant.
  FOREACH v_relation_name IN ARRAY ARRAY[
    'conversations',
    'direct_messages'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]::text[]
      LOOP
        IF pg_catalog.has_table_privilege(
          v_role,
          v_relation,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            '20260716114000 browser table ACL contract drift detected';
        END IF;
      END LOOP;
    END LOOP;

    IF pg_catalog.has_table_privilege('anon', v_relation, 'SELECT')
       OR NOT pg_catalog.has_table_privilege(
         'authenticated',
         v_relation,
         'SELECT'
       )
    THEN
      RAISE EXCEPTION
        '20260716114000 browser read ACL contract drift detected';
    END IF;

    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE'
    ]::text[]
    LOOP
      IF NOT pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          '20260716114000 service table ACL contract drift detected';
      END IF;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          '20260716114000 service table ACL contract drift detected';
      END IF;
    END LOOP;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid IN (
      'public.conversations'::regclass,
      'public.direct_messages'::regclass
    )
      AND acl_entry.grantee <> relation.relowner
      AND NOT (
        acl_entry.grantee = v_authenticated_oid
        AND acl_entry.privilege_type = 'SELECT'
      )
      AND NOT (
        acl_entry.grantee = v_service_role_oid
        AND acl_entry.privilege_type IN (
          'SELECT', 'INSERT', 'UPDATE', 'DELETE'
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid IN (
      'public.conversations'::regclass,
      'public.direct_messages'::regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      '20260716114000 arbitrary table/column ACL drift detected';
  END IF;

  -- 114200 owns and reconstructs the complete four-policy RLS set after its
  -- ACCESS EXCLUSIVE lock. Do not bless a replay merely because an attacker-
  -- supplied expression retained a few canonical-looking text fragments.
  IF v_reader_function IS NULL THEN
    RAISE EXCEPTION
      '20260716114000 direct-message reader helper is required';
  END IF;
END
$preflight$;

-- Stable lock order and bounded DDL. The current production table is tiny,
-- but a busy deployment must retry rather than wait indefinitely.
LOCK TABLE public.conversations, public.direct_messages
  IN ACCESS EXCLUSIVE MODE;

-- The browser read boundary is small enough to converge rather than compare
-- fragments of deparsed expressions. Recreate its helper and every policy in
-- the same locked transaction, removing same-name and extra fail-open policy
-- drift before any data calibration runs.
CREATE OR REPLACE FUNCTION public.is_current_user_active_for_direct_messages()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_actor_id uuid;
  v_actor_role text;
BEGIN
  v_actor_role := auth.role();
  IF v_actor_role IS DISTINCT FROM 'authenticated'
     AND v_actor_role IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'active direct-message reader requires an application role';
  END IF;

  v_actor_id := auth.uid();
  IF v_actor_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM public.user_profiles AS actor_profile
    WHERE actor_profile.id = v_actor_id
      AND actor_profile.deleted_at IS NULL
      AND actor_profile.banned_at IS NULL
  );
END
$function$;

ALTER FUNCTION public.is_current_user_active_for_direct_messages()
  OWNER TO postgres;

DO $converge_message_policies$
DECLARE
  v_relation_name text;
  v_policy_name name;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'conversations',
    'direct_messages'
  ]::text[]
  LOOP
    FOR v_policy_name IN
      SELECT policy.polname
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = pg_catalog.to_regclass(
        pg_catalog.format('public.%I', v_relation_name)
      )
      ORDER BY policy.polname
    LOOP
      EXECUTE pg_catalog.format(
        'DROP POLICY %I ON public.%I',
        v_policy_name,
        v_relation_name
      );
    END LOOP;
  END LOOP;
END
$converge_message_policies$;

CREATE POLICY "Authenticated participants read conversations"
  ON public.conversations
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_current_user_active_for_direct_messages())
    AND (SELECT auth.uid()) IN (user1_id, user2_id)
  );

CREATE POLICY "Service role manages conversations"
  ON public.conversations
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated participants read direct messages"
  ON public.direct_messages
  AS PERMISSIVE
  FOR SELECT
  TO authenticated
  USING (
    (SELECT public.is_current_user_active_for_direct_messages())
    AND direct_messages.deleted_at IS NULL
    AND (SELECT auth.uid()) IN (sender_id, receiver_id)
    AND EXISTS (
      SELECT 1
      FROM public.conversations AS conversation
      WHERE conversation.id = direct_messages.conversation_id
        AND conversation.user1_id = LEAST(sender_id, receiver_id)
        AND conversation.user2_id = GREATEST(sender_id, receiver_id)
        AND (SELECT auth.uid()) IN (
          conversation.user1_id,
          conversation.user2_id
        )
    )
  );

CREATE POLICY "Service role manages direct messages"
  ON public.direct_messages
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE INDEX IF NOT EXISTS idx_direct_messages_live_conversation_latest
  ON public.direct_messages (
    conversation_id,
    created_at DESC NULLS LAST,
    id DESC
  )
  WHERE deleted_at IS NULL;

-- These three 112100/114000 functions are behavior-bearing dependencies, not
-- merely signatures. Reinstall their canonical definitions on every replay
-- so metadata-compatible body drift cannot bypass blocks, cross-thread
-- integrity, or notification behavior.
CREATE OR REPLACE FUNCTION public.check_dm_permission(
  p_sender_id uuid,
  p_receiver_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_dm_permission text;
  v_is_mutual boolean := false;
  v_receiver_replied boolean := false;
  v_sent_count bigint := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'check_dm_permission is restricted to service_role'
      USING ERRCODE = '42501';
  END IF;

  IF p_sender_id IS NULL OR p_receiver_id IS NULL THEN
    RAISE EXCEPTION 'sender and receiver IDs are required'
      USING ERRCODE = '22023';
  END IF;

  IF p_sender_id = p_receiver_id THEN
    RAISE EXCEPTION 'sender and receiver IDs must differ'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.user_profiles AS sender_profile
    WHERE sender_profile.id = p_sender_id
      AND sender_profile.deleted_at IS NULL
      AND sender_profile.banned_at IS NULL
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'SENDER_UNAVAILABLE'
    );
  END IF;

  SELECT profile.dm_permission
  INTO v_dm_permission
  FROM public.user_profiles AS profile
  WHERE profile.id = p_receiver_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'USER_NOT_FOUND'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.blocked_users AS block_edge
    WHERE (
      block_edge.blocker_id = p_sender_id
      AND block_edge.blocked_id = p_receiver_id
    ) OR (
      block_edge.blocker_id = p_receiver_id
      AND block_edge.blocked_id = p_sender_id
    )
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'BLOCKED'
    );
  END IF;

  -- NULL or unexpected legacy values fail closed. The production constraint
  -- permits only all/mutual/none, but this prevents partial drift from opening
  -- a message path.
  IF v_dm_permission IS NULL OR v_dm_permission = 'none' THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'DM_DISABLED'
    );
  END IF;

  -- The historical function checked the unreachable literal "everyone" even
  -- though the persisted/UI contract is "all".
  IF v_dm_permission = 'all' THEN
    RETURN pg_catalog.jsonb_build_object('allowed', true);
  END IF;

  IF v_dm_permission <> 'mutual' THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', false,
      'reason', 'DM_DISABLED'
    );
  END IF;

  SELECT
    EXISTS (
      SELECT 1
      FROM public.user_follows AS sender_follow
      WHERE sender_follow.follower_id = p_sender_id
        AND sender_follow.following_id = p_receiver_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.user_follows AS receiver_follow
      WHERE receiver_follow.follower_id = p_receiver_id
        AND receiver_follow.following_id = p_sender_id
    )
  INTO v_is_mutual;

  IF v_is_mutual THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', true,
      'is_mutual', true
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.direct_messages AS receiver_message
    WHERE receiver_message.sender_id = p_receiver_id
      AND receiver_message.receiver_id = p_sender_id
  )
  INTO v_receiver_replied;

  IF v_receiver_replied THEN
    RETURN pg_catalog.jsonb_build_object(
      'allowed', true,
      'receiver_replied', true
    );
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_sent_count
  FROM public.direct_messages AS sender_message
  WHERE sender_message.sender_id = p_sender_id
    AND sender_message.receiver_id = p_receiver_id;

  -- Preserve the existing non-mutual contract and response fields exactly:
  -- fewer than three messages are allowed; at three the limit is reached.
  RETURN pg_catalog.jsonb_build_object(
    'allowed', v_sent_count < 3,
    'sent_count', v_sent_count,
    'reason', CASE
      WHEN v_sent_count >= 3 THEN 'LIMIT_REACHED'
      ELSE NULL
    END
  );
END
$function$;

ALTER FUNCTION public.check_dm_permission(uuid, uuid) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.create_message_notification()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_sender_handle text;
  v_receiver_notify_message boolean;
BEGIN
  SELECT sender_profile.handle
  INTO v_sender_handle
  FROM public.user_profiles AS sender_profile
  WHERE sender_profile.id = NEW.sender_id;

  SELECT COALESCE(receiver_profile.notify_message, true)
  INTO v_receiver_notify_message
  FROM public.user_profiles AS receiver_profile
  WHERE receiver_profile.id = NEW.receiver_id;

  IF v_receiver_notify_message THEN
    INSERT INTO public.notifications (
      user_id,
      type,
      title,
      message,
      link,
      actor_id,
      reference_id
    ) VALUES (
      NEW.receiver_id,
      'message',
      '新私信',
      COALESCE(v_sender_handle, '有人') || ' 给你发送了一条私信',
      '/messages/' || NEW.conversation_id::text,
      NEW.sender_id,
      NEW.conversation_id
    );
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.create_message_notification() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.validate_direct_message_integrity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF NEW.sender_id IS NULL
     OR NEW.receiver_id IS NULL
     OR NEW.sender_id = NEW.receiver_id
     OR NEW.conversation_id IS NULL
     OR pg_catalog.char_length(pg_catalog.btrim(NEW.content))
          NOT BETWEEN 1 AND 2000
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'invalid direct-message participant/content shape';
  END IF;

  IF NEW.media_url IS NULL THEN
    IF NEW.media_type IS NOT NULL OR NEW.media_name IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'direct-message media metadata requires a URL';
    END IF;
  ELSIF pg_catalog.char_length(pg_catalog.btrim(NEW.media_url))
            NOT BETWEEN 1 AND 2000
     OR pg_catalog.btrim(NEW.media_url) !~ '^https://[^[:space:]]+$'
     OR NEW.media_type IS NULL
     OR pg_catalog.lower(pg_catalog.btrim(NEW.media_type))
          NOT IN ('image', 'video', 'file')
     OR (
       NEW.media_name IS NOT NULL
       AND pg_catalog.char_length(pg_catalog.btrim(NEW.media_name))
            NOT BETWEEN 1 AND 255
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'invalid direct-message media shape';
  END IF;

  PERFORM 1
  FROM public.conversations AS conversation
  WHERE conversation.id = NEW.conversation_id
    AND conversation.user1_id = LEAST(NEW.sender_id, NEW.receiver_id)
    AND conversation.user2_id = GREATEST(NEW.sender_id, NEW.receiver_id)
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'direct message must use its participants canonical conversation';
  END IF;

  IF NEW.reply_to_id IS NOT NULL THEN
    PERFORM 1
    FROM public.direct_messages AS parent_message
    WHERE parent_message.id = NEW.reply_to_id
      AND parent_message.conversation_id = NEW.conversation_id
      AND parent_message.deleted_at IS NULL
      AND LEAST(parent_message.sender_id, parent_message.receiver_id)
            = LEAST(NEW.sender_id, NEW.receiver_id)
      AND GREATEST(parent_message.sender_id, parent_message.receiver_id)
            = GREATEST(NEW.sender_id, NEW.receiver_id)
    FOR SHARE;

    IF NOT FOUND THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'reply target is not visible in this direct-message thread';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.validate_direct_message_integrity() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.recalculate_direct_message_conversation_summary(
  p_conversation_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_updated_count bigint;
BEGIN
  IF p_conversation_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'conversation ID is required for summary recalculation';
  END IF;

  WITH latest_message AS (
    SELECT
      message_row.id,
      message_row.created_at,
      message_row.content
    FROM public.direct_messages AS message_row
    WHERE message_row.conversation_id = p_conversation_id
      AND message_row.deleted_at IS NULL
    ORDER BY
      message_row.created_at DESC NULLS LAST,
      message_row.id DESC
    LIMIT 1
  )
  UPDATE public.conversations AS conversation
  SET last_message_at = COALESCE(
        (SELECT latest_message.created_at FROM latest_message),
        conversation.created_at,
        '1970-01-01 00:00:00+00'::timestamptz
      ),
      last_message_preview = (
        SELECT pg_catalog.left(latest_message.content, 100)
        FROM latest_message
      )
  WHERE conversation.id = p_conversation_id;

  GET DIAGNOSTICS v_updated_count = ROW_COUNT;
  IF v_updated_count > 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'conversation summary recalculation updated multiple rows';
  END IF;

  RETURN v_updated_count = 1;
END
$function$;

ALTER FUNCTION public.recalculate_direct_message_conversation_summary(uuid)
  OWNER TO postgres;

-- Insert summaries now use the same canonical newest-live-message query as
-- deletes. This also makes a backdated trusted insert unable to replace a
-- newer preview.
CREATE OR REPLACE FUNCTION public.update_conversation_on_message()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'direct_messages'
     OR TG_OP IS DISTINCT FROM 'INSERT'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'direct-message insert summary trigger is misattached';
  END IF;

  IF NOT public.recalculate_direct_message_conversation_summary(
    NEW.conversation_id
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23503',
      MESSAGE = 'direct-message conversation disappeared during insert';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.update_conversation_on_message() OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.maintain_direct_message_delete_summary()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_conversation_ids uuid[] := ARRAY[OLD.conversation_id]::uuid[];
  v_conversation_id uuid;
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'direct_messages'
     OR TG_OP NOT IN ('UPDATE', 'DELETE')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'direct-message delete summary trigger is misattached';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    v_conversation_ids := pg_catalog.array_append(
      v_conversation_ids,
      NEW.conversation_id
    );
  END IF;

  -- A conversation cascade may remove its messages after the conversation
  -- row is no longer visible. A standalone message delete/update always has
  -- the FK-protected conversation and must recalculate it successfully. A
  -- Although the immutable-field guard rejects moves, this trigger still
  -- handles both row images defensively and in UUID order so catalog drift or
  -- a future controlled transition cannot leave either side stale.
  FOR v_conversation_id IN
    SELECT DISTINCT affected.conversation_id
    FROM pg_catalog.unnest(v_conversation_ids) AS affected(conversation_id)
    WHERE affected.conversation_id IS NOT NULL
    ORDER BY affected.conversation_id
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.conversations AS conversation
      WHERE conversation.id = v_conversation_id
    ) THEN
      -- A standalone legacy child DELETE/soft-delete already owns its message
      -- tuple before this AFTER trigger runs. Never wait behind a concurrent
      -- parent DELETE that will in turn wait for that child tuple; abort this
      -- legacy writer as a retryable serialization failure instead.
      BEGIN
        PERFORM 1
        FROM public.conversations AS conversation
        WHERE conversation.id = v_conversation_id
        FOR UPDATE NOWAIT;
      EXCEPTION
        WHEN lock_not_available THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE =
              'direct-message conversation is changing; retry message delete';
      END;

      IF FOUND AND NOT public.recalculate_direct_message_conversation_summary(
        v_conversation_id
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'direct-message summary recalculation failed';
      END IF;
    END IF;
  END LOOP;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

ALTER FUNCTION public.maintain_direct_message_delete_summary()
  OWNER TO postgres;

-- Row-level triggers run after PostgreSQL has identified and locked their
-- tuple. A parent conversation cascade is therefore the one operation that
-- cannot acquire the pair key first: its parent tuple is already locked. It
-- may safely skip the child pair lock because the exact ON DELETE CASCADE FK,
-- ordered-pair uniqueness, and parent tuple lock prevent a canonical send or
-- delete RPC from reaching a message row until the parent outcome is known.
-- Standalone legacy message UPDATE/DELETE uses a nonblocking pair claim and
-- retries instead of forming the reverse tuple -> pair deadlock.
CREATE OR REPLACE FUNCTION public.serialize_direct_message_pair_edge()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_pairs text[] := ARRAY[]::text[];
  v_pair text;
  v_old_left uuid;
  v_old_right uuid;
  v_new_left uuid;
  v_new_right uuid;
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'direct-message pair serializer attached outside public';
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'blocked_users' THEN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old_left := OLD.blocker_id;
        v_old_right := OLD.blocked_id;
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_new_left := NEW.blocker_id;
        v_new_right := NEW.blocked_id;
      END IF;
    WHEN 'user_follows' THEN
      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old_left := OLD.follower_id;
        v_old_right := OLD.following_id;
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_new_left := NEW.follower_id;
        v_new_right := NEW.following_id;
      END IF;
    WHEN 'direct_messages' THEN
      IF TG_OP = 'DELETE'
         AND OLD.conversation_id IS NOT NULL
         AND pg_catalog.pg_trigger_depth() > 1
         AND NOT EXISTS (
           SELECT 1
           FROM public.conversations AS parent_conversation
           WHERE parent_conversation.id = OLD.conversation_id
         )
      THEN
        -- The parent conversation cascade owns this deletion boundary. Its
        -- row lock substitutes for the pair key and must never wait behind a
        -- canonical pair -> conversation waiter.
        RETURN OLD;
      END IF;

      IF TG_OP IN ('UPDATE', 'DELETE') THEN
        v_old_left := OLD.sender_id;
        v_old_right := OLD.receiver_id;
      END IF;
      IF TG_OP IN ('INSERT', 'UPDATE') THEN
        v_new_left := NEW.sender_id;
        v_new_right := NEW.receiver_id;
      END IF;
    ELSE
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'direct-message pair serializer attached to unsupported table';
  END CASE;

  IF v_old_left IS NOT NULL AND v_old_right IS NOT NULL THEN
    v_pairs := pg_catalog.array_append(
      v_pairs,
      LEAST(v_old_left::text, v_old_right::text)
        || ':' || GREATEST(v_old_left::text, v_old_right::text)
    );
  END IF;

  IF v_new_left IS NOT NULL AND v_new_right IS NOT NULL THEN
    v_pairs := pg_catalog.array_append(
      v_pairs,
      LEAST(v_new_left::text, v_new_right::text)
        || ':' || GREATEST(v_new_left::text, v_new_right::text)
    );
  END IF;

  FOR v_pair IN
    SELECT DISTINCT affected_pair
    FROM pg_catalog.unnest(v_pairs) AS affected(affected_pair)
    ORDER BY affected_pair
  LOOP
    IF TG_TABLE_NAME = 'direct_messages'
       AND TG_OP IN ('UPDATE', 'DELETE')
    THEN
      IF NOT pg_catalog.pg_try_advisory_xact_lock(
        pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'direct-message pair is changing; retry message write';
      END IF;
    ELSE
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
      );
    END IF;
  END LOOP;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

ALTER FUNCTION public.serialize_direct_message_pair_edge()
  OWNER TO postgres;

-- Direct messages have no edit/move feature. Once inserted, every payload,
-- participant, thread, reply, identity, and creation field is immutable. Only
-- delivery/read/delete state may change. Comparing the complete row minus the
-- three allowed state fields also fails closed if a future column is added
-- without an explicit mutability decision.
CREATE OR REPLACE FUNCTION public.guard_direct_message_immutable_fields()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'direct_messages'
     OR TG_OP IS DISTINCT FROM 'UPDATE'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'direct-message immutable-field guard is misattached';
  END IF;

  -- Soft deletion is a one-way privacy boundary. Trusted legacy writers may
  -- set or refresh a deletion timestamp, but no service-role UPDATE may make
  -- previously hidden content live again.
  IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'direct-message soft deletion is irreversible';
  END IF;

  -- reply_to_id is an ON DELETE SET NULL self-reference. Permit only the
  -- referential-action trigger's unlink after its parent row has disappeared;
  -- a direct UPDATE (including a direct nulling) remains forbidden. Excluding
  -- reply_to_id in this branch is safe only because every other non-state
  -- field is still compared in full.
  IF OLD.reply_to_id IS NOT NULL
     AND NEW.reply_to_id IS NULL
     AND pg_catalog.pg_trigger_depth() > 1
     AND NOT EXISTS (
       SELECT 1
       FROM public.direct_messages AS parent_message
       WHERE parent_message.id = OLD.reply_to_id
     )
     AND (
       pg_catalog.to_jsonb(NEW)
         - ARRAY['read', 'read_at', 'deleted_at', 'reply_to_id']::text[]
     ) IS NOT DISTINCT FROM (
       pg_catalog.to_jsonb(OLD)
         - ARRAY['read', 'read_at', 'deleted_at', 'reply_to_id']::text[]
     )
  THEN
    RETURN NEW;
  END IF;

  IF (
    pg_catalog.to_jsonb(NEW)
      - ARRAY['read', 'read_at', 'deleted_at']::text[]
  ) IS DISTINCT FROM (
    pg_catalog.to_jsonb(OLD)
      - ARRAY['read', 'read_at', 'deleted_at']::text[]
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'direct-message identity and payload are immutable after send';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.guard_direct_message_immutable_fields()
  OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_guard_dm_immutable_fields
  ON public.direct_messages;
CREATE TRIGGER trg_guard_dm_immutable_fields
BEFORE UPDATE
ON public.direct_messages
FOR EACH ROW
EXECUTE FUNCTION public.guard_direct_message_immutable_fields();

-- Include deleted_at in the existing pair serializer. Consequently atomic
-- sends, RPC deletes, legacy service soft deletes, and hard deletes all use
-- exactly the same unordered-pair transaction lock.
DROP TRIGGER trg_serialize_dm_message_pair ON public.direct_messages;
CREATE TRIGGER trg_serialize_dm_message_pair
BEFORE INSERT OR DELETE OR UPDATE OF sender_id, receiver_id, deleted_at
ON public.direct_messages
FOR EACH ROW
EXECUTE FUNCTION public.serialize_direct_message_pair_edge();

DROP TRIGGER IF EXISTS trg_recalculate_dm_summary_after_delete
  ON public.direct_messages;
CREATE TRIGGER trg_recalculate_dm_summary_after_delete
AFTER DELETE OR UPDATE OF deleted_at
ON public.direct_messages
FOR EACH ROW
EXECUTE FUNCTION public.maintain_direct_message_delete_summary();

-- Preserve the 114000 send contract while making its row-lock order explicit:
-- pair -> conversation -> optional reply message. In particular, a send with
-- a reply must never lock the child message before waiting for a conversation
-- that an FK cascade has already locked for deletion.
CREATE OR REPLACE FUNCTION public.send_direct_message_atomic(
  p_sender_id uuid,
  p_receiver_id uuid,
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
  v_content text;
  v_media_url text;
  v_media_type text;
  v_media_name text;
  v_user1_id uuid;
  v_user2_id uuid;
  v_pair text;
  v_permission jsonb;
  v_reply_conversation_id uuid;
  v_conversation_id uuid;
  v_message public.direct_messages%ROWTYPE;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_sender_id IS NULL
     OR p_receiver_id IS NULL
     OR p_sender_id = p_receiver_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'distinct sender and receiver IDs are required';
  END IF;

  v_content := pg_catalog.btrim(p_content);
  IF v_content IS NULL
     OR pg_catalog.char_length(v_content) NOT BETWEEN 1 AND 2000
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'message content must contain 1 to 2000 characters';
  END IF;

  v_media_url := NULLIF(pg_catalog.btrim(p_media_url), '');
  v_media_type := NULLIF(
    pg_catalog.lower(pg_catalog.btrim(p_media_type)),
    ''
  );
  v_media_name := NULLIF(pg_catalog.btrim(p_media_name), '');

  IF p_media_url IS NOT NULL AND v_media_url IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'media URL cannot be blank';
  END IF;

  IF v_media_url IS NULL THEN
    IF p_media_type IS NOT NULL OR p_media_name IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'media metadata requires a media URL';
    END IF;
  ELSE
    v_media_type := COALESCE(v_media_type, 'file');
    IF pg_catalog.char_length(v_media_url) > 2000
       OR v_media_url !~ '^https://[^[:space:]]+$'
       OR v_media_type NOT IN ('image', 'video', 'file')
       OR (
         v_media_name IS NOT NULL
         AND pg_catalog.char_length(v_media_name) > 255
       )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'invalid direct-message media metadata';
    END IF;
  END IF;

  v_user1_id := LEAST(p_sender_id, p_receiver_id);
  v_user2_id := GREATEST(p_sender_id, p_receiver_id);
  v_pair := v_user1_id::text || ':' || v_user2_id::text;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
  );

  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id IN (p_sender_id, p_receiver_id)
  ORDER BY profile.id
  FOR SHARE;

  v_permission := public.check_dm_permission(
    p_sender_id,
    p_receiver_id
  );

  IF pg_catalog.jsonb_typeof(v_permission) IS DISTINCT FROM 'object'
     OR v_permission ->> 'allowed' IS NULL
     OR v_permission ->> 'allowed' NOT IN ('true', 'false')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'check_dm_permission returned an invalid contract';
  END IF;

  IF (v_permission ->> 'allowed')::boolean IS NOT TRUE THEN
    RETURN v_permission || pg_catalog.jsonb_build_object('success', false);
  END IF;

  IF p_reply_to_id IS NOT NULL THEN
    -- The parent conversation is always locked before its message. If a
    -- concurrent conversation cascade won first, this returns a stable
    -- INVALID_REPLY_TARGET without ever holding a child row lock.
    SELECT conversation.id
    INTO v_conversation_id
    FROM public.conversations AS conversation
    WHERE conversation.user1_id = v_user1_id
      AND conversation.user2_id = v_user2_id
    FOR SHARE;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'allowed', false,
        'reason', 'INVALID_REPLY_TARGET'
      );
    END IF;

    SELECT parent_message.conversation_id
    INTO v_reply_conversation_id
    FROM public.direct_messages AS parent_message
    WHERE parent_message.id = p_reply_to_id
      AND parent_message.conversation_id = v_conversation_id
      AND parent_message.deleted_at IS NULL
      AND (
        (
          parent_message.sender_id = p_sender_id
          AND parent_message.receiver_id = p_receiver_id
        ) OR (
          parent_message.sender_id = p_receiver_id
          AND parent_message.receiver_id = p_sender_id
        )
      )
    FOR SHARE;

    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'allowed', false,
        'reason', 'INVALID_REPLY_TARGET'
      );
    END IF;
  END IF;

  IF v_conversation_id IS NULL THEN
    -- Read/lock the canonical parent first. If a concurrent DELETE owns the
    -- old row, this waits for its outcome before deciding whether to create a
    -- replacement; it avoids retaining a stale ON CONFLICT snapshot after the
    -- conflicting row has been cascaded away.
    SELECT conversation.id
    INTO v_conversation_id
    FROM public.conversations AS conversation
    WHERE conversation.user1_id = v_user1_id
      AND conversation.user2_id = v_user2_id
    FOR SHARE;

    IF v_conversation_id IS NULL THEN
      INSERT INTO public.conversations (user1_id, user2_id)
      VALUES (v_user1_id, v_user2_id)
      ON CONFLICT (user1_id, user2_id) DO NOTHING
      RETURNING id INTO v_conversation_id;

      IF v_conversation_id IS NULL THEN
        SELECT conversation.id
        INTO STRICT v_conversation_id
        FROM public.conversations AS conversation
        WHERE conversation.user1_id = v_user1_id
          AND conversation.user2_id = v_user2_id
        FOR SHARE;
      END IF;
    END IF;
  END IF;

  IF v_reply_conversation_id IS NOT NULL
     AND v_reply_conversation_id <> v_conversation_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'reply target conversation violates ordered-pair uniqueness';
  END IF;

  INSERT INTO public.direct_messages (
    conversation_id,
    sender_id,
    receiver_id,
    content,
    media_url,
    media_type,
    media_name,
    reply_to_id
  ) VALUES (
    v_conversation_id,
    p_sender_id,
    p_receiver_id,
    v_content,
    v_media_url,
    v_media_type,
    v_media_name,
    p_reply_to_id
  )
  RETURNING * INTO v_message;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'allowed', true,
    'message', pg_catalog.to_jsonb(v_message),
    'conversation_id', v_conversation_id
  );
END
$function$;

ALTER FUNCTION public.send_direct_message_atomic(
  uuid,
  uuid,
  text,
  text,
  text,
  text,
  uuid
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.delete_direct_message_atomic(
  p_message_id uuid,
  p_actor_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_initial_sender_id uuid;
  v_initial_receiver_id uuid;
  v_initial_conversation_id uuid;
  v_sender_id uuid;
  v_receiver_id uuid;
  v_conversation_id uuid;
  v_deleted_at timestamptz;
  v_existing_deleted_at timestamptz;
  v_user1_id uuid;
  v_user2_id uuid;
  v_pair text;
  v_last_message_at timestamptz;
  v_last_message_preview text;
BEGIN
  -- p_actor_id must be derived from the authenticated request by the trusted
  -- service route. Browser roles cannot call this function, and ownership is
  -- revalidated here after the canonical pair lock is held.
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_message_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'message and actor IDs are required';
  END IF;

  -- This first snapshot only derives the pair and parent lock keys. The
  -- canonical locks below re-read and validate every security-relevant field.
  SELECT
    message_row.sender_id,
    message_row.receiver_id,
    message_row.conversation_id
  INTO
    v_initial_sender_id,
    v_initial_receiver_id,
    v_initial_conversation_id
  FROM public.direct_messages AS message_row
  WHERE message_row.id = p_message_id;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'deleted', false,
      'reason', 'NOT_FOUND'
    );
  END IF;

  IF v_initial_sender_id IS NULL
     OR v_initial_receiver_id IS NULL
     OR v_initial_conversation_id IS NULL
     OR v_initial_sender_id = v_initial_receiver_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'direct message has an invalid participant pair';
  END IF;

  v_pair := LEAST(
    v_initial_sender_id::text,
    v_initial_receiver_id::text
  ) || ':' || GREATEST(
    v_initial_sender_id::text,
    v_initial_receiver_id::text
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('direct-message:pair:' || v_pair, 0)
  );

  -- Lock the parent before the child. A concurrent FK cascade that already
  -- owns the conversation row can finish deleting its messages without ever
  -- waiting for this transaction's pair key.
  SELECT
    conversation.user1_id,
    conversation.user2_id
  INTO
    v_user1_id,
    v_user2_id
  FROM public.conversations AS conversation
  WHERE conversation.id = v_initial_conversation_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'deleted', false,
      'reason', 'NOT_FOUND'
    );
  END IF;

  SELECT
    message_row.sender_id,
    message_row.receiver_id,
    message_row.conversation_id,
    message_row.deleted_at
  INTO
    v_sender_id,
    v_receiver_id,
    v_conversation_id,
    v_existing_deleted_at
  FROM public.direct_messages AS message_row
  WHERE message_row.id = p_message_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'deleted', false,
      'reason', 'NOT_FOUND'
    );
  END IF;

  -- A trusted legacy rewrite that won the first pair lock must be retried;
  -- acquiring a second key here could invert the serializer's sorted order.
  IF v_sender_id IS DISTINCT FROM v_initial_sender_id
     OR v_receiver_id IS DISTINCT FROM v_initial_receiver_id
     OR v_conversation_id IS DISTINCT FROM v_initial_conversation_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'direct-message pair or conversation changed; retry delete';
  END IF;

  IF v_sender_id = v_receiver_id
     OR v_user1_id <> LEAST(v_sender_id, v_receiver_id)
     OR v_user2_id <> GREATEST(v_sender_id, v_receiver_id)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'direct message is outside its canonical conversation pair';
  END IF;

  IF v_sender_id <> p_actor_id THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'deleted', false,
      'reason', 'FORBIDDEN'
    );
  END IF;

  IF v_existing_deleted_at IS NOT NULL THEN
    SELECT
      conversation.last_message_at,
      conversation.last_message_preview
    INTO v_last_message_at, v_last_message_preview
    FROM public.conversations AS conversation
    WHERE conversation.id = v_conversation_id;

    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'deleted', false,
      'already_deleted', true,
      'message_id', p_message_id,
      'conversation_id', v_conversation_id,
      'deleted_at', v_existing_deleted_at,
      'last_message_at', v_last_message_at,
      'last_message_preview', v_last_message_preview
    );
  END IF;

  v_deleted_at := pg_catalog.clock_timestamp();

  UPDATE public.direct_messages AS message_row
  SET deleted_at = v_deleted_at
  WHERE message_row.id = p_message_id
    AND message_row.sender_id = p_actor_id
    AND message_row.deleted_at IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'direct-message delete lost its locked row';
  END IF;

  -- The AFTER UPDATE trigger has recalculated the summary inside this same
  -- transaction. Reading it here also proves the conversation still exists.
  SELECT
    conversation.last_message_at,
    conversation.last_message_preview
  INTO STRICT v_last_message_at, v_last_message_preview
  FROM public.conversations AS conversation
  WHERE conversation.id = v_conversation_id;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'deleted', true,
    'already_deleted', false,
    'message_id', p_message_id,
    'conversation_id', v_conversation_id,
    'deleted_at', v_deleted_at,
    'last_message_at', v_last_message_at,
    'last_message_preview', v_last_message_preview
  );
END
$function$;

ALTER FUNCTION public.delete_direct_message_atomic(uuid, uuid)
  OWNER TO postgres;

-- Remove PUBLIC and arbitrary/dashboard role EXECUTE drift from every new or
-- replaced function. Route RPCs remain service-only; the RLS reader helper is
-- callable only by authenticated and service roles.
DO $converge_function_acls$
DECLARE
  v_function regprocedure;
  v_function_owner oid;
  v_delete_function regprocedure :=
    'public.delete_direct_message_atomic(uuid,uuid)'::regprocedure;
  v_grantee record;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.delete_direct_message_atomic(uuid,uuid)'::regprocedure,
    'public.recalculate_direct_message_conversation_summary(uuid)'::regprocedure,
    'public.maintain_direct_message_delete_summary()'::regprocedure,
    'public.guard_direct_message_immutable_fields()'::regprocedure,
    'public.update_conversation_on_message()'::regprocedure,
    'public.serialize_direct_message_pair_edge()'::regprocedure,
    'public.send_direct_message_atomic(uuid,uuid,text,text,text,text,uuid)'::regprocedure,
    'public.is_current_user_active_for_direct_messages()'::regprocedure,
    'public.check_dm_permission(uuid,uuid)'::regprocedure,
    'public.create_message_notification()'::regprocedure,
    'public.validate_direct_message_integrity()'::regprocedure
  ]::regprocedure[]
  LOOP
    SELECT function_row.proowner
    INTO STRICT v_function_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function::oid;

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
      WHERE function_row.oid = v_function::oid
        AND acl_entry.grantee <> v_function_owner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM PUBLIC',
          v_function
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM %I',
          v_function,
          v_grantee.rolname
        );
      END IF;
    END LOOP;
  END LOOP;

  REVOKE ALL ON FUNCTION public.delete_direct_message_atomic(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.delete_direct_message_atomic(uuid, uuid)
    TO service_role;

  REVOKE ALL ON FUNCTION public.send_direct_message_atomic(
    uuid, uuid, text, text, text, text, uuid
  ) FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.send_direct_message_atomic(
    uuid, uuid, text, text, text, text, uuid
  ) TO service_role;

  REVOKE ALL ON FUNCTION public.check_dm_permission(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.check_dm_permission(uuid, uuid)
    TO service_role;

  REVOKE ALL
    ON FUNCTION public.is_current_user_active_for_direct_messages()
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.is_current_user_active_for_direct_messages()
    TO authenticated, service_role;

  REVOKE ALL
    ON FUNCTION public.recalculate_direct_message_conversation_summary(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL
    ON FUNCTION public.maintain_direct_message_delete_summary()
    FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL
    ON FUNCTION public.guard_direct_message_immutable_fields()
    FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL
    ON FUNCTION public.update_conversation_on_message()
    FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL
    ON FUNCTION public.serialize_direct_message_pair_edge()
    FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL
    ON FUNCTION public.create_message_notification()
    FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL
    ON FUNCTION public.validate_direct_message_integrity()
    FROM PUBLIC, anon, authenticated, service_role;
END
$converge_function_acls$;

-- One-time calibration: derive every summary only from live history. This
-- neither deletes nor exposes a message and is safe to repeat.
WITH canonical_summary AS (
  SELECT
    conversation.id AS conversation_id,
    COALESCE(
      latest_message.created_at,
      conversation.created_at,
      '1970-01-01 00:00:00+00'::timestamptz
    ) AS last_message_at,
    CASE
      WHEN latest_message.id IS NULL THEN NULL
      ELSE pg_catalog.left(latest_message.content, 100)
    END AS last_message_preview
  FROM public.conversations AS conversation
  LEFT JOIN LATERAL (
    SELECT
      message_row.id,
      message_row.created_at,
      message_row.content
    FROM public.direct_messages AS message_row
    WHERE message_row.conversation_id = conversation.id
      AND message_row.deleted_at IS NULL
    ORDER BY
      message_row.created_at DESC NULLS LAST,
      message_row.id DESC
    LIMIT 1
  ) AS latest_message ON true
)
UPDATE public.conversations AS conversation
SET last_message_at = canonical_summary.last_message_at,
    last_message_preview = canonical_summary.last_message_preview
FROM canonical_summary
WHERE canonical_summary.conversation_id = conversation.id
  AND (
    conversation.last_message_at IS DISTINCT FROM
      canonical_summary.last_message_at
    OR conversation.last_message_preview IS DISTINCT FROM
      canonical_summary.last_message_preview
  );

DO $postflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_service_role_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_authenticated_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_delete_function regprocedure :=
    'public.delete_direct_message_atomic(uuid,uuid)'::regprocedure;
  v_send_function regprocedure :=
    'public.send_direct_message_atomic(uuid,uuid,text,text,text,text,uuid)'::regprocedure;
  v_permission_function regprocedure :=
    'public.check_dm_permission(uuid,uuid)'::regprocedure;
  v_reader_function regprocedure :=
    'public.is_current_user_active_for_direct_messages()'::regprocedure;
  v_recalculate_function regprocedure :=
    'public.recalculate_direct_message_conversation_summary(uuid)'::regprocedure;
  v_delete_trigger_function regprocedure :=
    'public.maintain_direct_message_delete_summary()'::regprocedure;
  v_immutable_guard_function regprocedure :=
    'public.guard_direct_message_immutable_fields()'::regprocedure;
  v_insert_summary_function regprocedure :=
    'public.update_conversation_on_message()'::regprocedure;
  v_notification_function regprocedure :=
    'public.create_message_notification()'::regprocedure;
  v_pair_function regprocedure :=
    'public.serialize_direct_message_pair_edge()'::regprocedure;
  v_integrity_function regprocedure :=
    'public.validate_direct_message_integrity()'::regprocedure;
  v_id_attnum smallint;
  v_conversation_id_attnum smallint;
  v_conversations_id_attnum smallint;
  v_conversation_user1_attnum smallint;
  v_conversation_user2_attnum smallint;
  v_sender_attnum smallint;
  v_receiver_attnum smallint;
  v_content_attnum smallint;
  v_media_url_attnum smallint;
  v_media_type_attnum smallint;
  v_media_name_attnum smallint;
  v_deleted_attnum smallint;
  v_reply_attnum smallint;
  v_latest_index regclass :=
    'public.idx_direct_messages_live_conversation_latest'::regclass;
  v_relation_name text;
  v_relation regclass;
  v_role name;
  v_privilege text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.conversations'::regclass,
      'public.direct_messages'::regclass
    )
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
      AND relation.relowner = v_postgres_oid
      AND relation.relrowsecurity
    GROUP BY relation.relowner
    HAVING pg_catalog.count(*) = 2
  ) THEN
    RAISE EXCEPTION
      'direct-message relation shape postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'public.conversations'::regclass,
      'public.direct_messages'::regclass
    )
       OR inheritance.inhparent IN (
         'public.conversations'::regclass,
         'public.direct_messages'::regclass
       )
  ) THEN
    RAISE EXCEPTION
      'direct-message inheritance postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'public.conversations'::regclass,
      'public.direct_messages'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'direct-message rewrite-rule postflight failed';
  END IF;

  FOREACH v_relation_name IN ARRAY ARRAY[
    'conversations',
    'direct_messages'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(
      pg_catalog.format('public.%I', v_relation_name)
    );

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated']::name[]
    LOOP
      FOREACH v_privilege IN ARRAY ARRAY[
        'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
      ]::text[]
      LOOP
        IF pg_catalog.has_table_privilege(
          v_role,
          v_relation,
          v_privilege
        ) THEN
          RAISE EXCEPTION
            'direct-message browser table ACL postflight failed';
        END IF;
      END LOOP;
    END LOOP;

    IF pg_catalog.has_table_privilege('anon', v_relation, 'SELECT')
       OR NOT pg_catalog.has_table_privilege(
         'authenticated',
         v_relation,
         'SELECT'
       )
    THEN
      RAISE EXCEPTION
        'direct-message browser read ACL postflight failed';
    END IF;

    FOREACH v_privilege IN ARRAY ARRAY[
      'SELECT', 'INSERT', 'UPDATE', 'DELETE'
    ]::text[]
    LOOP
      IF NOT pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'direct-message service table ACL postflight failed';
      END IF;
    END LOOP;

    FOREACH v_privilege IN ARRAY ARRAY[
      'TRUNCATE', 'REFERENCES', 'TRIGGER'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(
        'service_role',
        v_relation,
        v_privilege
      ) THEN
        RAISE EXCEPTION
          'direct-message service table ACL postflight failed';
      END IF;
    END LOOP;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS function_schema
      ON function_schema.oid = function_row.pronamespace
    WHERE function_schema.nspname = 'public'
      AND function_row.proname = 'delete_direct_message_atomic'
      AND function_row.prokind = 'f'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_delete_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.pronargs = 2
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'atomic direct-message delete RPC catalog failed';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role', v_delete_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_delete_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_delete_function, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'atomic direct-message delete RPC is not service-only';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_send_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.pronargs = 7
      AND function_row.pronargdefaults = 4
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.strpos(
        function_row.prosrc,
        'The parent conversation is always locked before its message'
      ) > 0
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_send_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_send_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_send_function, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'atomic direct-message send lock-order convergence failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS function_language
      ON function_language.oid = function_row.prolang
    WHERE function_row.oid = v_permission_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.pronargs = 2
      AND function_row.pronargdefaults = 0
      AND function_language.lanname = 'plpgsql'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
      AND pg_catalog.md5(function_row.prosrc) =
        '1bc16d1d61dc83b45e9fe4d7796949c1'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS function_language
      ON function_language.oid = function_row.prolang
    WHERE function_row.oid = v_notification_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'trigger'::regtype
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND function_language.lanname = 'plpgsql'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.md5(function_row.prosrc) =
        '8cede0f9d7aa6ec34e9212e69e4311c6'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS function_language
      ON function_language.oid = function_row.prolang
    WHERE function_row.oid = v_integrity_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'trigger'::regtype
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND function_language.lanname = 'plpgsql'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.md5(function_row.prosrc) =
        '9a0170f32101b7994e983a2b43dd52c7'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_permission_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_permission_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated', v_permission_function, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'canonical direct-message dependency definitions did not converge';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_reader_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 's'
      AND function_row.prorettype = 'boolean'::regtype
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp'
      ]::text[]
  ) OR NOT pg_catalog.has_function_privilege(
    'authenticated', v_reader_function, 'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_reader_function, 'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon', v_reader_function, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'direct-message reader helper convergence failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid IN (
      v_delete_function,
      v_send_function,
      v_permission_function,
      v_reader_function,
      v_recalculate_function,
      v_delete_trigger_function,
      v_immutable_guard_function,
      v_insert_summary_function,
      v_pair_function,
      v_notification_function,
      v_integrity_function
    )
      AND acl_entry.grantee <> function_row.proowner
      AND NOT (
        function_row.oid IN (
          v_delete_function::oid,
          v_send_function::oid,
          v_permission_function::oid
        )
        AND acl_entry.grantee = v_service_role_oid
      )
      AND NOT (
        function_row.oid = v_reader_function::oid
        AND acl_entry.grantee IN (
          v_authenticated_oid,
          v_service_role_oid
        )
      )
  ) THEN
    RAISE EXCEPTION
      'direct-message delete boundary retained an arbitrary function ACL';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid IN (
      'public.conversations'::regclass,
      'public.direct_messages'::regclass
    )
  ) <> 4 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.conversations'::regclass
      AND policy.polname = 'Authenticated participants read conversations'
      AND policy.polcmd = 'r'
      AND policy.polpermissive
      AND policy.polroles = ARRAY[v_authenticated_oid]::oid[]
      AND policy.polwithcheck IS NULL
      AND pg_catalog.regexp_replace(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
        '[[:space:]]+',
        ' ',
        'g'
      ) = $policy$( SELECT is_current_user_active_for_direct_messages() AS is_current_user_active_for_direct_messages) AND ((( SELECT auth.uid() AS uid)) = user1_id OR (( SELECT auth.uid() AS uid)) = user2_id)$policy$
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.direct_messages'::regclass
      AND policy.polname = 'Authenticated participants read direct messages'
      AND policy.polcmd = 'r'
      AND policy.polpermissive
      AND policy.polroles = ARRAY[v_authenticated_oid]::oid[]
      AND policy.polwithcheck IS NULL
      AND pg_catalog.regexp_replace(
        pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
        '[[:space:]]+',
        ' ',
        'g'
      ) = $policy$( SELECT is_current_user_active_for_direct_messages() AS is_current_user_active_for_direct_messages) AND deleted_at IS NULL AND ((( SELECT auth.uid() AS uid)) = sender_id OR (( SELECT auth.uid() AS uid)) = receiver_id) AND (EXISTS ( SELECT 1 FROM conversations conversation WHERE conversation.id = direct_messages.conversation_id AND conversation.user1_id = LEAST(direct_messages.sender_id, direct_messages.receiver_id) AND conversation.user2_id = GREATEST(direct_messages.sender_id, direct_messages.receiver_id) AND ((( SELECT auth.uid() AS uid)) = conversation.user1_id OR (( SELECT auth.uid() AS uid)) = conversation.user2_id)))$policy$
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.conversations'::regclass
      AND policy.polname = 'Service role manages conversations'
      AND policy.polcmd = '*'
      AND policy.polpermissive
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(
        policy.polqual,
        policy.polrelid,
        true
      ) = 'true'
      AND pg_catalog.pg_get_expr(
        policy.polwithcheck,
        policy.polrelid,
        true
      ) = 'true'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.direct_messages'::regclass
      AND policy.polname = 'Service role manages direct messages'
      AND policy.polcmd = '*'
      AND policy.polpermissive
      AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
      AND pg_catalog.pg_get_expr(
        policy.polqual,
        policy.polrelid,
        true
      ) = 'true'
      AND pg_catalog.pg_get_expr(
        policy.polwithcheck,
        policy.polrelid,
        true
      ) = 'true'
  ) THEN
    RAISE EXCEPTION
      'direct-message policy exact-definition postflight failed';
  END IF;

  SELECT attribute.attnum
  INTO STRICT v_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'id';
  SELECT attribute.attnum
  INTO STRICT v_conversation_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'conversation_id';
  SELECT attribute.attnum
  INTO STRICT v_conversations_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversations'::regclass
    AND attribute.attname = 'id';
  SELECT attribute.attnum
  INTO STRICT v_conversation_user1_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversations'::regclass
    AND attribute.attname = 'user1_id';
  SELECT attribute.attnum
  INTO STRICT v_conversation_user2_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.conversations'::regclass
    AND attribute.attname = 'user2_id';
  SELECT attribute.attnum
  INTO STRICT v_sender_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'sender_id';
  SELECT attribute.attnum
  INTO STRICT v_receiver_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'receiver_id';
  SELECT attribute.attnum
  INTO STRICT v_content_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'content';
  SELECT attribute.attnum
  INTO STRICT v_media_url_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'media_url';
  SELECT attribute.attnum
  INTO STRICT v_media_type_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'media_type';
  SELECT attribute.attnum
  INTO STRICT v_media_name_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'media_name';
  SELECT attribute.attnum
  INTO STRICT v_deleted_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'deleted_at';
  SELECT attribute.attnum
  INTO STRICT v_reply_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.direct_messages'::regclass
    AND attribute.attname = 'reply_to_id';

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.direct_messages'::regclass
      AND constraint_row.confrelid = 'public.direct_messages'::regclass
      AND constraint_row.conkey = ARRAY[v_reply_attnum]::smallint[]
      AND constraint_row.confkey = ARRAY[v_id_attnum]::smallint[]
      AND constraint_row.confupdtype = 'a'
      AND constraint_row.confdeltype = 'n'
      AND constraint_row.confmatchtype = 's'
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.convalidated
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.direct_messages'::regclass
      AND (
        v_reply_attnum = ANY(constraint_row.conkey)
        OR constraint_row.confrelid = 'public.direct_messages'::regclass
      )
  ) <> 1 THEN
    RAISE EXCEPTION
      'direct_messages.reply_to_id FK postflight failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.direct_messages'::regclass
      AND constraint_row.confrelid = 'public.conversations'::regclass
      AND constraint_row.conkey =
        ARRAY[v_conversation_id_attnum]::smallint[]
      AND constraint_row.confkey =
        ARRAY[v_conversations_id_attnum]::smallint[]
      AND constraint_row.confupdtype = 'a'
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.confmatchtype = 's'
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.convalidated
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.direct_messages'::regclass
      AND (
        v_conversation_id_attnum = ANY(constraint_row.conkey)
        OR constraint_row.confrelid = 'public.conversations'::regclass
      )
  ) <> 1 THEN
    RAISE EXCEPTION
      'direct_messages.conversation_id FK postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'on_dm_sent'
      AND trigger_row.tgfoid = v_insert_summary_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 5
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
      AND trigger_row.tgqual IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'on_dm_received'
      AND trigger_row.tgfoid = v_notification_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 5
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
      AND trigger_row.tgqual IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_serialize_dm_message_pair'
      AND trigger_row.tgfoid = v_pair_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 3
      AND trigger_row.tgattr::smallint[] @> ARRAY[
        v_sender_attnum,
        v_receiver_attnum,
        v_deleted_attnum
      ]::smallint[]
      AND trigger_row.tgqual IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_validate_direct_message_integrity'
      AND trigger_row.tgfoid = v_integrity_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 23
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 8
      AND trigger_row.tgattr::smallint[] @> ARRAY[
        v_conversation_id_attnum,
        v_sender_attnum,
        v_receiver_attnum,
        v_content_attnum,
        v_media_url_attnum,
        v_media_type_attnum,
        v_media_name_attnum,
        v_reply_attnum
      ]::smallint[]
      AND trigger_row.tgqual IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_recalculate_dm_summary_after_delete'
      AND trigger_row.tgfoid = v_delete_trigger_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 25
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 1
      AND trigger_row.tgattr::smallint[] @>
        ARRAY[v_deleted_attnum]::smallint[]
      AND trigger_row.tgqual IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_guard_dm_immutable_fields'
      AND trigger_row.tgfoid = v_immutable_guard_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 19
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
      AND trigger_row.tgqual IS NULL
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
  ) <> 6 THEN
    RAISE EXCEPTION
      'direct_messages six-trigger exact catalog postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_pair_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'trigger'::regtype
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.strpos(
        function_row.prosrc,
        'The parent conversation cascade owns this deletion boundary'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'pg_try_advisory_xact_lock'
      ) > 0
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgfoid = v_pair_function
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_serialize_dm_message_pair'
      AND trigger_row.tgfoid = v_pair_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 3
      AND trigger_row.tgattr::smallint[] @> ARRAY[
          v_sender_attnum,
          v_receiver_attnum,
          v_deleted_attnum
        ]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'direct-message pair serializer does not cover deleted_at exactly once';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgfoid = v_delete_trigger_function
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_recalculate_dm_summary_after_delete'
      AND trigger_row.tgfoid = v_delete_trigger_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 25
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 1
      AND trigger_row.tgattr::smallint[] @>
        ARRAY[v_deleted_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'direct-message delete summary trigger is not exactly once';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_immutable_guard_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prorettype = 'trigger'::regtype
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.strpos(
        function_row.prosrc,
        'identity and payload are immutable after send'
      ) > 0
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_guard_dm_immutable_fields'
      AND trigger_row.tgfoid = v_immutable_guard_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 19
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
  ) THEN
    RAISE EXCEPTION
      'direct-message immutable-field guard postflight failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled <> 'D'
      AND trigger_row.tgfoid = v_insert_summary_function
  ) <> 1 THEN
    RAISE EXCEPTION
      'direct-message insert summary trigger is not exactly once';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND trigger_row.tgname = 'trg_validate_direct_message_integrity'
      AND trigger_row.tgfoid = v_integrity_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 23
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgname NOT IN (
        'on_dm_received',
        'on_dm_sent',
        'trg_serialize_dm_message_pair',
        'trg_validate_direct_message_integrity',
        'trg_recalculate_dm_summary_after_delete',
        'trg_guard_dm_immutable_fields'
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.direct_messages'::regclass
      AND NOT trigger_row.tgisinternal
  ) <> 6 THEN
    RAISE EXCEPTION
      'direct-message trigger set did not converge exactly';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indrelid = 'public.conversations'::regclass
      AND (
        index_metadata.indisunique
        OR index_metadata.indisexclusion
      )
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 2
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname ORDER BY attribute.attname
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality <= index_metadata.indnkeyatts
      ) = ARRAY['user1_id', 'user2_id']::name[]
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.conversations'::regclass
      AND constraint_row.contype IN ('u', 'x')
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname ORDER BY attribute.attname
        )
        FROM pg_catalog.unnest(constraint_row.conkey)
          AS key_column(attnum)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = constraint_row.conrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['user1_id', 'user2_id']::name[]
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    JOIN pg_catalog.pg_index AS index_metadata
      ON index_metadata.indexrelid = constraint_row.conindid
    WHERE constraint_row.conrelid = 'public.conversations'::regclass
      AND constraint_row.contype = 'u'
      AND constraint_row.conkey = ARRAY[
        v_conversation_user1_attnum,
        v_conversation_user2_attnum
      ]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND index_metadata.indrelid = 'public.conversations'::regclass
      AND index_metadata.indisunique
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND index_metadata.indimmediate
      AND NOT index_metadata.indisexclusion
      AND index_metadata.indpred IS NULL
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 2
      AND index_metadata.indnatts = 2
  ) THEN
    RAISE EXCEPTION
      'conversation pair immediate unique constraint postflight failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_metadata
    WHERE index_metadata.indexrelid = v_latest_index
      AND index_metadata.indrelid = 'public.direct_messages'::regclass
      AND index_metadata.indisvalid
      AND index_metadata.indisready
      AND NOT index_metadata.indisunique
      AND index_metadata.indexprs IS NULL
      AND index_metadata.indnkeyatts = 3
      AND index_metadata.indnatts = 3
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_metadata.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_metadata.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['conversation_id', 'created_at', 'id']::name[]
      AND pg_catalog.pg_get_expr(
        index_metadata.indpred,
        index_metadata.indrelid,
        true
      ) = 'deleted_at IS NULL'
      AND pg_catalog.strpos(
        pg_catalog.pg_get_indexdef(index_metadata.indexrelid),
        'created_at DESC NULLS LAST, id DESC'
      ) > 0
  ) THEN
    RAISE EXCEPTION
      'direct-message live-summary index postflight failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.conversations AS conversation
    LEFT JOIN LATERAL (
      SELECT
        message_row.id,
        message_row.created_at,
        message_row.content
      FROM public.direct_messages AS message_row
      WHERE message_row.conversation_id = conversation.id
        AND message_row.deleted_at IS NULL
      ORDER BY
        message_row.created_at DESC NULLS LAST,
        message_row.id DESC
      LIMIT 1
    ) AS latest_message ON true
    WHERE conversation.last_message_at IS DISTINCT FROM COALESCE(
        latest_message.created_at,
        conversation.created_at,
        '1970-01-01 00:00:00+00'::timestamptz
      )
       OR conversation.last_message_preview IS DISTINCT FROM CASE
         WHEN latest_message.id IS NULL THEN NULL
         ELSE pg_catalog.left(latest_message.content, 100)
       END
  ) THEN
    RAISE EXCEPTION
      'direct-message conversation summaries did not calibrate canonically';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
