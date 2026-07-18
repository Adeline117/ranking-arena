-- Create a group channel and its complete privacy-reviewed roster in one
-- transaction. The retired route performed filter -> channel INSERT -> member
-- INSERT -> compensating DELETE, leaving both privacy and orphan-channel races.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('atomic-group-channel-create:migration', 0)
);

DO $preflight$
DECLARE
  v_relation regclass;
  v_relation_name text;
  v_pair_function regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_direct_message_pair_edge()'
  );
  v_post_block_function regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_post_audience_block_edge()'
  );
  v_follow_notification_function regprocedure := pg_catalog.to_regprocedure(
    'public.create_user_follow_notification()'
  );
  v_follow_activity_function regprocedure := pg_catalog.to_regprocedure(
    'public.log_user_follow_activity()'
  );
  v_add_function regprocedure := pg_catalog.to_regprocedure(
    'public.add_channel_members_atomic(uuid,uuid,uuid[])'
  );
  v_create_function regprocedure := pg_catalog.to_regprocedure(
    'public.create_group_channel_atomic(uuid,uuid,text,text,uuid[])'
  );
  v_dissolve_function regprocedure := pg_catalog.to_regprocedure(
    'public.dissolve_group_channel_atomic(uuid,uuid)'
  );
  v_owner_count_function regprocedure := pg_catalog.to_regprocedure(
    'public.enforce_group_channel_owner_count()'
  );
  v_owner_serializer_function regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_group_channel_owner_event()'
  );
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
  v_pair_source text;
  v_post_block_source text;
  v_follow_notification_source text;
  v_follow_activity_source text;
BEGIN
  IF v_postgres_oid IS NULL OR v_service_oid IS NULL OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(ARRAY['anon', 'authenticated']::name[])
      AS required(role_name)
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.rolname = required.role_name
    WHERE role_row.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'required application database role is missing';
  END IF;

  FOREACH v_relation_name IN ARRAY ARRAY[
    'public.chat_channels',
    'public.channel_members',
    'public.user_profiles',
    'public.blocked_users',
    'public.user_follows',
    'auth.users'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass(v_relation_name);
    IF v_relation IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
        OR inheritance.inhparent = v_relation
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_rewrite AS rewrite_rule
      WHERE rewrite_rule.ev_class = v_relation
    ) THEN
      RAISE EXCEPTION
        'atomic group-channel dependency relation is incompatible: %',
        v_relation_name;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass,
      'public.user_profiles'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass
    )
      AND (
        relation.relowner <> v_postgres_oid
        OR relation.relforcerowsecurity
        OR (
          relation.oid IN (
            'public.chat_channels'::regclass,
            'public.channel_members'::regclass
          )
          AND NOT relation.relrowsecurity
        )
      )
  ) THEN
    RAISE EXCEPTION 'atomic group-channel relation ownership/RLS is incompatible';
  END IF;

  -- The channel object is returned as to_jsonb(row), so its eleven-key shape
  -- must remain exact. The roster write likewise names all nine columns rather
  -- than trusting mutable defaults.
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.chat_channels'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 11 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.channel_members'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 9 OR EXISTS (
    SELECT 1
    FROM (
      VALUES
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
        ('public', 'channel_members', 1, 'id', 'uuid'::regtype, true),
        ('public', 'channel_members', 2, 'channel_id', 'uuid'::regtype, true),
        ('public', 'channel_members', 3, 'user_id', 'uuid'::regtype, true),
        ('public', 'channel_members', 4, 'role', 'text'::regtype, true),
        ('public', 'channel_members', 5, 'nickname', 'text'::regtype, false),
        ('public', 'channel_members', 6, 'is_muted', 'boolean'::regtype, false),
        ('public', 'channel_members', 7, 'is_pinned', 'boolean'::regtype, false),
        (
          'public', 'channel_members', 8, 'cleared_before',
          'timestamptz'::regtype, false
        ),
        (
          'public', 'channel_members', 9, 'joined_at',
          'timestamptz'::regtype, false
        ),
        ('public', 'user_profiles', 0, 'id', 'uuid'::regtype, true),
        ('public', 'user_profiles', 0, 'dm_permission', 'text'::regtype, false),
        ('public', 'user_profiles', 0, 'deleted_at', 'timestamptz'::regtype, false),
        ('public', 'user_profiles', 0, 'banned_at', 'timestamptz'::regtype, false),
        ('public', 'user_profiles', 0, 'is_banned', 'boolean'::regtype, false),
        ('public', 'user_profiles', 0, 'ban_expires_at', 'timestamptz'::regtype, false),
        ('public', 'blocked_users', 0, 'blocker_id', 'uuid'::regtype, true),
        ('public', 'blocked_users', 0, 'blocked_id', 'uuid'::regtype, true),
        ('public', 'user_follows', 0, 'follower_id', 'uuid'::regtype, true),
        ('public', 'user_follows', 0, 'following_id', 'uuid'::regtype, true),
        ('auth', 'users', 0, 'id', 'uuid'::regtype, true)
    ) AS required_column(
      schema_name,
      relation_name,
      ordinal_position,
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
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
       OR attribute.attgenerated <> ''
       OR (
         required_column.ordinal_position > 0
         AND attribute.attnum <> required_column.ordinal_position
       )
       OR (
         required_column.required_not_null
         AND NOT attribute.attnotnull
       )
  ) THEN
    RAISE EXCEPTION 'atomic group-channel column contract is incompatible';
  END IF;

  -- Exact identity keys and the complete-roster uniqueness authority.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'auth.users'::regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indimmediate
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indkey[0] = (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = index_row.indrelid
          AND attribute.attname = 'id'
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.user_profiles'::regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indimmediate
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indkey[0] = (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = index_row.indrelid
          AND attribute.attname = 'id'
      )
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.chat_channels'::regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indimmediate
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 1
      AND index_row.indnatts = 1
      AND index_row.indkey[0] = (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = index_row.indrelid
          AND attribute.attname = 'id'
      )
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.channel_members'::regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indimmediate
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['channel_id', 'user_id']::name[]
  ) <> 1 THEN
    RAISE EXCEPTION 'atomic group-channel identity index contract failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid IN (
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
      AND index_row.indisunique
      AND (
        index_row.indpred IS NOT NULL
        OR index_row.indexprs IS NOT NULL
        OR index_row.indnatts <> index_row.indnkeyatts
        OR COALESCE(
          (
            SELECT pg_catalog.array_agg(
              attribute.attname ORDER BY key_column.ordinality
            )
            FROM pg_catalog.unnest(index_row.indkey)
              WITH ORDINALITY AS key_column(attnum, ordinality)
            LEFT JOIN pg_catalog.pg_attribute AS attribute
              ON attribute.attrelid = index_row.indrelid
             AND attribute.attnum = key_column.attnum
            WHERE key_column.ordinality <= index_row.indnkeyatts
          ),
          ARRAY[]::name[]
        ) NOT IN (
          ARRAY['id']::name[],
          ARRAY['channel_id', 'user_id']::name[]
        )
      )
  ) THEN
    RAISE EXCEPTION 'unexpected group-channel unique authority exists';
  END IF;

  -- Auth is the identity parent. Exact immediate FKs make the initial ordered
  -- FOR SHARE locks a proof against hard deletion and later FK cascades.
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND (
        (
          constraint_row.conrelid = 'public.chat_channels'::regclass
          AND constraint_row.confrelid = 'auth.users'::regclass
          AND constraint_row.confdeltype = 'n'
          AND constraint_row.conkey = ARRAY[
            (
              SELECT attribute.attnum
              FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = constraint_row.conrelid
                AND attribute.attname = 'created_by'
            )
          ]::smallint[]
        ) OR (
          constraint_row.conrelid = 'public.channel_members'::regclass
          AND constraint_row.confrelid = 'auth.users'::regclass
          AND constraint_row.confdeltype = 'c'
          AND constraint_row.conkey = ARRAY[
            (
              SELECT attribute.attnum
              FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = constraint_row.conrelid
                AND attribute.attname = 'user_id'
            )
          ]::smallint[]
        ) OR (
          constraint_row.conrelid = 'public.user_profiles'::regclass
          AND constraint_row.confrelid = 'auth.users'::regclass
          AND constraint_row.confdeltype = 'c'
          AND constraint_row.conkey = ARRAY[
            (
              SELECT attribute.attnum
              FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = constraint_row.conrelid
                AND attribute.attname = 'id'
            )
          ]::smallint[]
        )
      )
  ) <> 3 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid IN (
        'public.blocked_users'::regclass,
        'public.user_follows'::regclass
      )
      AND constraint_row.confrelid = 'auth.users'::regclass
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 4 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.channel_members'::regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'public.chat_channels'::regclass
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'channel_id'
        )
      ]::smallint[]
  ) <> 1 THEN
    RAISE EXCEPTION 'atomic group-channel foreign-key contract failed';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.chat_channels'::regclass
      AND constraint_row.contype <> 't'
  ) <> 4 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.channel_members'::regclass
      AND constraint_row.contype <> 't'
  ) <> 5 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.chat_channels'::regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'type'
        )
      ]::smallint[]
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid
      ) = $expression$(type = ANY (ARRAY['direct'::text, 'group'::text]))$expression$
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.channel_members'::regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'role'
        )
      ]::smallint[]
      AND pg_catalog.pg_get_expr(
        constraint_row.conbin,
        constraint_row.conrelid
      ) = $expression$(role = ANY (ARRAY['owner'::text, 'admin'::text, 'member'::text]))$expression$
  ) THEN
    RAISE EXCEPTION 'atomic group-channel constraint inventory is incompatible';
  END IF;

  IF v_owner_count_function IS NULL AND v_owner_serializer_function IS NULL THEN
    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid IN (
        'public.chat_channels'::regclass,
        'public.channel_members'::regclass
      )
        AND NOT trigger_row.tgisinternal
    ) THEN
      RAISE EXCEPTION 'group-channel write tables have an unexpected user trigger';
    END IF;
  ELSIF v_owner_count_function IS NULL
        OR v_owner_serializer_function IS NULL
        OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_owner_count_function
        AND function_row.prokind = 'f'
        AND function_row.prorettype = 'trigger'::regtype
        AND NOT function_row.proretset
        AND function_row.pronargs = 0
        AND function_row.prosecdef
        AND function_row.proowner = v_postgres_oid
        AND function_row.proconfig = ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
        AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
          'group-channel-owner-count:v2:'
            || pg_catalog.md5(function_row.prosrc)
  ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_owner_serializer_function
        AND function_row.prokind = 'f'
        AND function_row.prorettype = 'trigger'::regtype
        AND NOT function_row.proretset
        AND function_row.pronargs = 0
        AND function_row.prosecdef
        AND function_row.proowner = v_postgres_oid
        AND function_row.proconfig = ARRAY[
          'search_path=pg_catalog, pg_temp',
          'lock_timeout=5s'
        ]::text[]
        AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
          'group-channel-owner-serializer:v1:'
            || pg_catalog.md5(function_row.prosrc)
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
      AND NOT trigger_row.tgisinternal
  ) <> 4 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.channel_members'::regclass
      AND trigger_row.tgname = 'trg_serialize_group_channel_owner_event'
      AND trigger_row.tgfoid = v_owner_serializer_function
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
      AND NOT trigger_row.tgdeferrable
      AND NOT trigger_row.tginitdeferred
      AND trigger_row.tgqual IS NULL
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
      AND trigger_row.tgqual IS NULL
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.chat_channels'::regclass
      AND trigger_row.tgname =
        'trg_serialize_group_channel_owner_event_on_channel'
      AND trigger_row.tgfoid = v_owner_serializer_function
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
      AND NOT trigger_row.tgdeferrable
      AND NOT trigger_row.tginitdeferred
      AND trigger_row.tgqual IS NULL
      AND NOT trigger_row.tgisinternal
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.chat_channels'::regclass
      AND trigger_row.tgname =
        'trg_enforce_group_channel_owner_count_on_channel'
      AND trigger_row.tgfoid = v_owner_count_function
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 21
      AND trigger_row.tgdeferrable
      AND trigger_row.tginitdeferred
      AND trigger_row.tgqual IS NULL
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'group-channel owner invariant metadata drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'enforce_group_channel_owner_count'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <> ''
  ) THEN
    RAISE EXCEPTION 'incompatible owner-count invariant overload exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'serialize_group_channel_owner_event'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <> ''
  ) THEN
    RAISE EXCEPTION 'incompatible owner-event serializer overload exists';
  END IF;

  -- Both write tables must remain service-only. The first execution accepts
  -- the historical four-operation channel ACL so this migration can remove
  -- direct parent DELETE; replay accepts the converged three-operation ACL.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid IN (
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
      AND acl_entry.grantee <> relation.relowner
      AND (
        acl_entry.grantee <> v_service_oid
        OR acl_entry.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
        OR acl_entry.is_grantable
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public.chat_channels'::regclass, 'SELECT'::text),
        ('public.chat_channels'::regclass, 'INSERT'::text),
        ('public.chat_channels'::regclass, 'UPDATE'::text),
        ('public.channel_members'::regclass, 'SELECT'::text),
        ('public.channel_members'::regclass, 'INSERT'::text),
        ('public.channel_members'::regclass, 'UPDATE'::text),
        ('public.channel_members'::regclass, 'DELETE'::text)
    ) AS required_privilege(relation_oid, privilege_type)
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = required_privilege.relation_oid
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE acl_entry.grantee = v_service_oid
      AND acl_entry.privilege_type = required_privilege.privilege_type
      AND NOT acl_entry.is_grantable
    HAVING pg_catalog.count(*) = 7
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public.chat_channels'::regclass, ARRAY[3, 4]::integer[]),
        ('public.channel_members'::regclass, ARRAY[4]::integer[])
    ) AS required_relation(relation_oid, allowed_counts)
    WHERE (
      SELECT pg_catalog.count(DISTINCT acl_entry.privilege_type)
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
      ) AS acl_entry
      WHERE relation.oid = required_relation.relation_oid
        AND acl_entry.grantee = v_service_oid
        AND acl_entry.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
        AND NOT acl_entry.is_grantable
    ) <> ALL(required_relation.allowed_counts)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid IN (
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres_oid
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (
          'public.chat_channels'::regclass,
          'Service role manages chat channels'::name
        ),
        (
          'public.channel_members'::regclass,
          'Service role manages channel members'::name
        )
    ) AS required_policy(relation_oid, policy_name)
    WHERE (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = required_policy.relation_oid
        AND policy.polname = required_policy.policy_name
        AND policy.polpermissive
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[v_service_oid]::oid[]
        AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
        AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
    ) <> 1 OR (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = required_policy.relation_oid
    ) <> 1
  ) THEN
    RAISE EXCEPTION 'group-channel service-only table boundary drifted';
  END IF;

  -- Require the exact serializer already used by DM send/delete and existing
  -- channel-member addition. Every block/follow mutation must share the same
  -- unordered-pair namespace before this migration can publish the creator.
  IF v_pair_function IS NULL OR v_post_block_function IS NULL OR v_add_function IS NULL OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'serialize_direct_message_pair_edge'
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'add_channel_members_atomic'
  ) <> 1 THEN
    RAISE EXCEPTION 'canonical channel/pair dependency must deploy first';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_pair_source
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_language AS language_row
    ON language_row.oid = function_row.prolang
  WHERE function_row.oid = v_pair_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::regtype
    AND function_row.prosecdef
    AND function_row.proowner = v_postgres_oid
    AND language_row.lanname = 'plpgsql'
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  SELECT function_row.prosrc
  INTO STRICT v_post_block_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_post_block_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::regtype
    AND function_row.prosecdef
    AND function_row.proowner = v_postgres_oid;

  IF pg_catalog.strpos(v_pair_source, $$WHEN 'blocked_users' THEN$$) = 0
     OR pg_catalog.strpos(v_pair_source, $$WHEN 'user_follows' THEN$$) = 0
     OR pg_catalog.strpos(v_pair_source, 'ORDER BY affected_pair') = 0
     OR pg_catalog.strpos(v_pair_source, 'pg_advisory_xact_lock') = 0
     OR pg_catalog.strpos(
       v_pair_source,
       $$'direct-message:pair:' || v_pair$$
     ) = 0
     OR pg_catalog.strpos(
       v_post_block_source,
       $$'post-audience:block:' || v_pair$$
     ) = 0
  THEN
    RAISE EXCEPTION 'canonical block/follow serializer body is incompatible';
  END IF;

  IF v_follow_notification_function IS NULL OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'create_user_follow_notification'
  ) <> 1 OR v_follow_activity_function IS NULL OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'log_user_follow_activity'
  ) <> 1 THEN
    RAISE EXCEPTION 'canonical follow side-effect functions are incompatible';
  END IF;

  SELECT function_row.prosrc
  INTO v_follow_notification_source
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_language AS language_row
    ON language_row.oid = function_row.prolang
  WHERE function_row.oid = v_follow_notification_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::regtype
    AND NOT function_row.proretset
    AND function_row.pronargs = 0
    AND function_row.pronargdefaults = 0
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.proowner = v_postgres_oid
    AND language_row.lanname = 'plpgsql'
    AND function_row.proconfig =
      ARRAY['search_path=public']::text[];

  SELECT function_row.prosrc
  INTO v_follow_activity_source
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_language AS language_row
    ON language_row.oid = function_row.prolang
  WHERE function_row.oid = v_follow_activity_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::regtype
    AND NOT function_row.proretset
    AND function_row.pronargs = 0
    AND function_row.pronargdefaults = 0
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.proowner = v_postgres_oid
    AND language_row.lanname = 'plpgsql'
    AND function_row.proconfig =
      ARRAY['search_path=public']::text[];

  IF v_follow_notification_source IS NULL
     OR pg_catalog.strpos(
       v_follow_notification_source,
       'INSERT INTO notifications'
     ) = 0
     OR pg_catalog.strpos(
       v_follow_notification_source,
       'notify_follow'
     ) = 0
     OR v_follow_activity_source IS NULL
     OR pg_catalog.strpos(
       v_follow_activity_source,
       'INSERT INTO user_activities'
     ) = 0
     OR pg_catalog.strpos(
       v_follow_activity_source,
       $$'follow_user'$$
     ) = 0
  THEN
    RAISE EXCEPTION 'follow side-effect function contract is incompatible';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.blocked_users'::regclass
      AND NOT trigger_row.tgisinternal
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_follows'::regclass
      AND NOT trigger_row.tgisinternal
  ) <> 3 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid = v_pair_function
      AND trigger_row.tgrelid IN (
        'public.blocked_users'::regclass,
        'public.user_follows'::regclass
      )
      AND trigger_row.tgname IN (
        'trg_serialize_dm_block_pair',
        'trg_serialize_dm_follow_pair'
      )
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 31
      AND trigger_row.tgqual IS NULL
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid = v_post_block_function
      AND trigger_row.tgrelid = 'public.blocked_users'::regclass
      AND trigger_row.tgname = 'trg_serialize_post_audience_block_edge'
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 31
      AND trigger_row.tgqual IS NULL
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_follows'::regclass
      AND trigger_row.tgname = 'on_user_follow'
      AND trigger_row.tgfoid = v_follow_notification_function
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 5
      AND trigger_row.tgqual IS NULL
      AND trigger_row.tgnargs = 0
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.user_follows'::regclass
      AND trigger_row.tgname = 'trg_log_user_follow_activity'
      AND trigger_row.tgfoid = v_follow_activity_function
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 5
      AND trigger_row.tgqual IS NULL
      AND trigger_row.tgnargs = 0
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
  ) <> 1 THEN
    RAISE EXCEPTION 'block/follow serializer trigger inventory is incompatible';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_add_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 3
      AND function_row.pronargdefaults = 0
      AND function_row.proargnames = ARRAY[
        'p_channel_id',
        'p_actor_id',
        'p_candidate_ids'
      ]::text[]
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.proowner = v_postgres_oid
      AND language_row.lanname = 'plpgsql'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_add_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_add_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_add_function,
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_add_function
      AND acl_entry.grantee <> function_row.proowner
      AND (
        acl_entry.grantee <> v_service_oid
        OR acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'certified existing-channel member-add metadata/ACL drifted';
  END IF;

  -- A first deployment upgrades the certified v1 function installed by
  -- 152647. Once the creator exists, this is a replay and only the v2 lock
  -- contract published by this migration is acceptable.
  IF v_create_function IS NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_add_function
        AND function_row.prorettype = 'jsonb'::regtype
        AND function_row.prosecdef
        AND function_row.proowner = v_postgres_oid
        AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
          'atomic-existing-channel-member-add:v1:'
            || pg_catalog.md5(function_row.prosrc)
        AND pg_catalog.strpos(
          function_row.prosrc,
          $$'channel-membership:channel:' || p_channel_id::text$$
        ) > 0
        AND pg_catalog.strpos(
          function_row.prosrc,
          $$'direct-message:pair:'$$
        ) > 0
    ) THEN
      RAISE EXCEPTION 'certified existing-channel member-add v1 is required';
    END IF;
  ELSIF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_add_function
      AND function_row.prorettype = 'jsonb'::regtype
      AND function_row.prosecdef
      AND function_row.proowner = v_postgres_oid
      AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
        'atomic-existing-channel-member-add:v2:'
          || pg_catalog.md5(function_row.prosrc)
      AND pg_catalog.strpos(
        function_row.prosrc,
        'v_observed_channel_exists := FOUND'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'FROM auth.users AS auth_user'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'v_rechecked_row_token'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        $$'direct-message:pair:'$$
      ) > 0
  ) THEN
    RAISE EXCEPTION 'certified existing-channel member-add v2 is required on replay';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'create_group_channel_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <>
        'p_channel_id uuid, p_actor_id uuid, p_name text, p_description text, p_candidate_ids uuid[]'
  ) THEN
    RAISE EXCEPTION 'incompatible create_group_channel_atomic overload exists';
  END IF;

  IF pg_catalog.to_regprocedure(
    'public.create_group_channel_atomic(uuid,uuid,text,text,uuid[])'
  ) IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure(
      'public.create_group_channel_atomic(uuid,uuid,text,text,uuid[])'
    )
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
  ) THEN
    RAISE EXCEPTION 'existing create_group_channel_atomic signature is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'dissolve_group_channel_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid) <>
        'p_channel_id uuid, p_actor_id uuid'
  ) THEN
    RAISE EXCEPTION 'incompatible dissolve_group_channel_atomic overload exists';
  END IF;

  IF v_dissolve_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_dissolve_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
  ) THEN
    RAISE EXCEPTION 'existing dissolve_group_channel_atomic signature is incompatible';
  END IF;
END
$preflight$;

-- Freeze parent/identity dependencies before child write tables. Auth hard
-- deletion takes RowExclusive on these parents before reaching channel rows;
-- acquiring SHARE here first prevents the migration from holding a channel
-- table while waiting back on Auth. The write tables then need ACCESS EXCLUSIVE
-- while the owner-loss invariant triggers and RPC bodies converge.
LOCK TABLE
  auth.users,
  public.user_profiles,
  public.blocked_users,
  public.user_follows
IN SHARE MODE;
LOCK TABLE public.chat_channels, public.channel_members
IN ACCESS EXCLUSIVE MODE;

-- Parent deletion must pass through the atomic dissolution RPC or the
-- invariant's SECURITY DEFINER cleanup. A raw service-role DELETE has already
-- acquired the parent tuple before any trigger can establish Auth-first order.
REVOKE DELETE ON TABLE public.chat_channels FROM service_role;

-- Converge historical rows while both write relations are frozen. Ownerless
-- groups follow the existing owner-loss product semantics and are removed.
-- When a legacy group has multiple owners, retain its creator when possible;
-- otherwise retain the lexicographically smallest owner UUID. Every additional
-- owner becomes an admin, preserving access without preserving ambiguity.
DO $repair_historical_group_owners$
BEGIN
  WITH ranked_owners AS (
    SELECT
      membership.id,
      pg_catalog.row_number() OVER (
        PARTITION BY membership.channel_id
        ORDER BY
          CASE
            WHEN membership.user_id = channel_row.created_by THEN 0
            ELSE 1
          END,
          membership.user_id,
          membership.id
      ) AS owner_rank
    FROM public.channel_members AS membership
    JOIN public.chat_channels AS channel_row
      ON channel_row.id = membership.channel_id
    WHERE channel_row.type = 'group'
      AND membership.role = 'owner'
  )
  UPDATE public.channel_members AS membership
  SET role = 'admin'
  FROM ranked_owners AS ranked_owner
  WHERE ranked_owner.id = membership.id
    AND ranked_owner.owner_rank > 1;

  DELETE FROM public.chat_channels AS channel_row
  WHERE channel_row.type = 'group'
    AND NOT EXISTS (
      SELECT 1
      FROM public.channel_members AS owner_member
      WHERE owner_member.channel_id = channel_row.id
        AND owner_member.role = 'owner'
    );

  IF EXISTS (
    SELECT 1
    FROM public.chat_channels AS channel_row
    WHERE channel_row.type = 'group'
      AND (
        SELECT pg_catalog.count(*)
        FROM public.channel_members AS owner_member
        WHERE owner_member.channel_id = channel_row.id
          AND owner_member.role = 'owner'
      ) <> 1
  ) THEN
    RAISE EXCEPTION 'historical group-channel owner repair was incomplete';
  END IF;
END
$repair_historical_group_owners$;

CREATE OR REPLACE FUNCTION public.serialize_group_channel_owner_event()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_creator_exists boolean := false;
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'group-channel owner serializer trigger is misattached';
  END IF;

  IF TG_TABLE_NAME = 'channel_members' THEN
    IF TG_OP NOT IN ('INSERT', 'DELETE', 'UPDATE') THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'group-channel member owner serializer is misattached';
    END IF;
    IF NOT (
      (TG_OP IN ('UPDATE', 'DELETE') AND OLD.role = 'owner')
      OR (TG_OP IN ('INSERT', 'UPDATE') AND NEW.role = 'owner')
    ) THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;
  ELSIF TG_TABLE_NAME = 'chat_channels' THEN
    IF TG_OP NOT IN ('INSERT', 'DELETE', 'UPDATE') THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'group-channel parent owner serializer is misattached';
    END IF;
    -- A parent DELETE can cascade an owner-role child even for a legacy direct
    -- channel. Serialize every parent deletion before its cascade starts so a
    -- concurrent owner mutation cannot form parent -> child / child -> parent.
    IF TG_OP <> 'DELETE'
       AND (
         (TG_OP = 'INSERT' AND NEW.type IS DISTINCT FROM 'group')
         OR (
           TG_OP = 'UPDATE'
           AND OLD.type IS DISTINCT FROM 'group'
           AND NEW.type IS DISTINCT FROM 'group'
         )
       )
    THEN
      RETURN NEW;
    END IF;
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'group-channel owner serializer trigger is misattached';
  END IF;

  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'group-channel owner mutation is concurrent; retry';
  END IF;

  -- A parent tuple is already locked before this row trigger runs. Never wait
  -- from that child/parent side back to the Auth parent: Auth hard deletion can
  -- already own auth.users and an ordinary membership while waiting to SET
  -- created_by NULL. NOWAIT makes the losing parent deletion roll back and
  -- release every child immediately; the winning path pins the creator before
  -- its CASCADE. This guard also covers the deferred ownerless cleanup below.
  IF TG_TABLE_NAME = 'chat_channels' AND TG_OP = 'DELETE' THEN
    IF OLD.created_by IS NOT NULL THEN
      BEGIN
        PERFORM auth_user.id
        FROM auth.users AS auth_user
        WHERE auth_user.id = OLD.created_by
        FOR SHARE NOWAIT;
        v_creator_exists := FOUND;
      EXCEPTION
        WHEN lock_not_available THEN
          RAISE EXCEPTION USING
            ERRCODE = '40001',
            MESSAGE = 'group-channel creator deletion is concurrent; retry';
      END;

      IF NOT v_creator_exists THEN
        RAISE EXCEPTION USING
          ERRCODE = '40001',
          MESSAGE = 'group-channel creator identity changed; retry';
      END IF;
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

ALTER FUNCTION public.serialize_group_channel_owner_event()
  OWNER TO postgres;

DO $converge_owner_serializer_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.serialize_group_channel_owner_event()'::regprocedure;
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
    ON FUNCTION public.serialize_group_channel_owner_event()
    FROM PUBLIC, anon, authenticated, service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'group-channel-owner-serializer:v1:' || pg_catalog.md5(v_source)
  );
END
$converge_owner_serializer_acl_and_attest$;

-- Auth hard deletion SET NULLs chat_channels.created_by and CASCADEs the owner
-- membership. Member owner loss keeps the established product behavior and
-- removes the group. A direct parent INSERT/type rewrite, however, must not
-- commit a group until its one-owner roster exists. Both deferred paths share
-- one low-frequency advisory key before taking channel locks, and member-only
-- events return before that key so ordinary additions remain independent.
CREATE OR REPLACE FUNCTION public.enforce_group_channel_owner_count()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_channel_ids uuid[] := ARRAY[]::uuid[];
  v_channel_id uuid;
  v_channel_type text;
  v_owner_count integer := 0;
  v_deleted_count integer := 0;
  v_member_owner_event boolean := false;
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'group-channel owner invariant trigger is misattached';
  END IF;

  IF TG_TABLE_NAME = 'channel_members' THEN
    IF TG_OP NOT IN ('INSERT', 'DELETE', 'UPDATE') THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'group-channel member owner invariant trigger is misattached';
    END IF;

    v_member_owner_event :=
      (TG_OP IN ('UPDATE', 'DELETE') AND OLD.role = 'owner')
      OR (TG_OP IN ('INSERT', 'UPDATE') AND NEW.role = 'owner');
    IF NOT v_member_owner_event THEN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    IF TG_OP IN ('UPDATE', 'DELETE') AND OLD.role = 'owner' THEN
      v_channel_ids := pg_catalog.array_append(v_channel_ids, OLD.channel_id);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NEW.role = 'owner' THEN
      v_channel_ids := pg_catalog.array_append(v_channel_ids, NEW.channel_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'chat_channels' THEN
    IF TG_OP NOT IN ('INSERT', 'UPDATE') THEN
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'group-channel parent owner invariant trigger is misattached';
    END IF;
    IF NEW.type IS DISTINCT FROM 'group' THEN
      RETURN NEW;
    END IF;
    v_channel_ids := pg_catalog.array_append(v_channel_ids, NEW.id);
  ELSE
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'group-channel owner invariant trigger is misattached';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );

  FOR v_channel_id IN
    SELECT DISTINCT affected_channel_id
    FROM pg_catalog.unnest(v_channel_ids) AS affected(affected_channel_id)
    WHERE affected_channel_id IS NOT NULL
    ORDER BY affected_channel_id
  LOOP
    SELECT channel_row.type
    INTO v_channel_type
    FROM public.chat_channels AS channel_row
    WHERE channel_row.id = v_channel_id
    FOR UPDATE;

    IF NOT FOUND OR v_channel_type IS DISTINCT FROM 'group' THEN
      CONTINUE;
    END IF;

    SELECT pg_catalog.count(*)::integer
    INTO STRICT v_owner_count
    FROM public.channel_members AS remaining_owner
    WHERE remaining_owner.channel_id = v_channel_id
      AND remaining_owner.role = 'owner';

    IF v_owner_count = 0 AND TG_TABLE_NAME = 'channel_members' THEN
      DELETE FROM public.chat_channels AS channel_row
      WHERE channel_row.id = v_channel_id
        AND channel_row.type = 'group';
      GET DIAGNOSTICS v_deleted_count = ROW_COUNT;

      IF v_deleted_count <> 1 THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'ownerless group-channel cleanup acknowledgement is incomplete';
      END IF;
    ELSIF v_owner_count <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'group channel must have exactly one owner';
    END IF;
  END LOOP;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$function$;

ALTER FUNCTION public.enforce_group_channel_owner_count()
  OWNER TO postgres;

DO $converge_owner_count_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.enforce_group_channel_owner_count()'::regprocedure;
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
    ON FUNCTION public.enforce_group_channel_owner_count()
    FROM PUBLIC, anon, authenticated, service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'group-channel-owner-count:v2:' || pg_catalog.md5(v_source)
  );
END
$converge_owner_count_acl_and_attest$;

DROP TRIGGER IF EXISTS trg_serialize_group_channel_owner_event
  ON public.channel_members;
CREATE TRIGGER trg_serialize_group_channel_owner_event
BEFORE INSERT OR DELETE OR UPDATE OF role, channel_id, user_id
ON public.channel_members
FOR EACH ROW
EXECUTE FUNCTION public.serialize_group_channel_owner_event();

DROP TRIGGER IF EXISTS trg_enforce_group_channel_owner_count
  ON public.channel_members;
CREATE CONSTRAINT TRIGGER trg_enforce_group_channel_owner_count
AFTER INSERT OR DELETE OR UPDATE OF role, channel_id, user_id
ON public.channel_members
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.enforce_group_channel_owner_count();

DROP TRIGGER IF EXISTS trg_serialize_group_channel_owner_event_on_channel
  ON public.chat_channels;
CREATE TRIGGER trg_serialize_group_channel_owner_event_on_channel
BEFORE INSERT OR DELETE OR UPDATE OF type
ON public.chat_channels
FOR EACH ROW
EXECUTE FUNCTION public.serialize_group_channel_owner_event();

DROP TRIGGER IF EXISTS trg_enforce_group_channel_owner_count_on_channel
  ON public.chat_channels;
CREATE CONSTRAINT TRIGGER trg_enforce_group_channel_owner_count_on_channel
AFTER INSERT OR UPDATE OF type
ON public.chat_channels
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public.enforce_group_channel_owner_count();

-- Upgrade the existing-channel member-add RPC to the same owner barrier ->
-- channel advisory -> Auth -> channel -> roster order used by creation. Its v1
-- implementation locked the channel before discovering/locking the creator
-- Auth parent, which deadlocked against Auth hard deletion's parent ->
-- created_by SET NULL order.
CREATE OR REPLACE FUNCTION public.add_channel_members_atomic(
  p_channel_id uuid,
  p_actor_id uuid,
  p_candidate_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_channel_type text;
  v_observed_channel_type text;
  v_observed_created_by uuid;
  v_rechecked_created_by uuid;
  v_observed_row_token text;
  v_rechecked_row_token text;
  v_observed_channel_exists boolean := false;
  v_rechecked_channel_exists boolean := false;
  v_actor_role text;
  v_candidate_ids uuid[] := ARRAY[]::uuid[];
  v_observed_roster_ids uuid[] := ARRAY[]::uuid[];
  v_auth_lock_ids uuid[] := ARRAY[]::uuid[];
  v_roster_ids uuid[] := ARRAY[]::uuid[];
  v_new_candidate_ids uuid[] := ARRAY[]::uuid[];
  v_participant_ids uuid[] := ARRAY[]::uuid[];
  v_auth_user_ids uuid[] := ARRAY[]::uuid[];
  v_active_profile_ids uuid[] := ARRAY[]::uuid[];
  v_mutual_candidate_ids uuid[] := ARRAY[]::uuid[];
  v_inserted_ids uuid[] := ARRAY[]::uuid[];
  v_member record;
  v_profile record;
  v_user_id uuid;
  v_left_id uuid;
  v_right_id uuid;
  v_privacy_denied boolean := false;
  v_inserted_count integer := 0;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_channel_id IS NULL
     OR p_actor_id IS NULL
     OR p_candidate_ids IS NULL
     OR pg_catalog.array_ndims(p_candidate_ids) IS DISTINCT FROM 1
     OR pg_catalog.array_lower(p_candidate_ids, 1) IS DISTINCT FROM 1
     OR pg_catalog.cardinality(p_candidate_ids) NOT BETWEEN 1 AND 50
     OR pg_catalog.array_position(p_candidate_ids, NULL::uuid) IS NOT NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'channel, actor and one to fifty candidate IDs are required';
  END IF;

  SELECT pg_catalog.array_agg(candidate_id ORDER BY candidate_id)
  INTO STRICT v_candidate_ids
  FROM (
    SELECT DISTINCT candidate_id
    FROM pg_catalog.unnest(p_candidate_ids) AS candidate(candidate_id)
  ) AS unique_candidate;

  IF pg_catalog.cardinality(v_candidate_ids) <>
       pg_catalog.cardinality(p_candidate_ids)
     OR p_actor_id = ANY(v_candidate_ids)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'candidate IDs must be distinct and must not include the actor';
  END IF;

  -- Member addition never creates or promotes an owner. Take the shared side
  -- of the global owner barrier before any channel/Auth/tuple/advisory lock:
  -- adds remain concurrent with one another, while a direct owner or parent
  -- mutation either owns the exclusive side first or fails its trigger try-lock
  -- without waiting in a child <-> parent cycle. No shared-to-exclusive upgrade
  -- is possible in this function because every inserted role is "member".
  PERFORM pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'channel-membership:channel:' || p_channel_id::text,
      0
    )
  );

  -- Observe the channel and bounded roster without tuple locks. The creator,
  -- actor, candidates and every observed roster identity are all included in
  -- the sorted Auth parent set before any channel/roster tuple is locked.
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

  FOR v_member IN
    SELECT membership.user_id
    FROM public.channel_members AS membership
    WHERE membership.channel_id = p_channel_id
    ORDER BY membership.user_id
  LOOP
    v_observed_roster_ids := pg_catalog.array_append(
      v_observed_roster_ids,
      v_member.user_id
    );
  END LOOP;

  IF pg_catalog.cardinality(v_observed_roster_ids) > 50 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'channel roster exceeds its enforced capacity';
  END IF;

  SELECT pg_catalog.array_agg(identity_id ORDER BY identity_id)
  INTO STRICT v_auth_lock_ids
  FROM (
    SELECT p_actor_id AS identity_id
    UNION
    SELECT candidate_id
    FROM pg_catalog.unnest(v_candidate_ids) AS candidate(candidate_id)
    UNION
    SELECT roster_id
    FROM pg_catalog.unnest(v_observed_roster_ids) AS roster(roster_id)
    UNION
    SELECT v_observed_created_by
    WHERE v_observed_created_by IS NOT NULL
  ) AS identity;

  FOR v_user_id IN
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id = ANY(v_auth_lock_ids)
    ORDER BY auth_user.id
    FOR SHARE
  LOOP
    v_auth_user_ids := pg_catalog.array_append(v_auth_user_ids, v_user_id);
  END LOOP;

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

  -- The channel parent now blocks new FK edges. Lock the final roster in UUID
  -- order and reject any identity that was not in the no-lock observation,
  -- rather than extending the Auth lock set out of order.
  FOR v_member IN
    SELECT membership.user_id, membership.role
    FROM public.channel_members AS membership
    WHERE membership.channel_id = p_channel_id
    ORDER BY membership.user_id
    FOR UPDATE
  LOOP
    v_roster_ids := pg_catalog.array_append(v_roster_ids, v_member.user_id);
    IF v_member.user_id = p_actor_id THEN
      v_actor_role := v_member.role;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_roster_ids) AS roster(roster_id)
    WHERE NOT roster_id = ANY(v_observed_roster_ids)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'channel roster identity changed while locking; retry';
  END IF;

  IF v_actor_role IS NULL
     OR v_actor_role NOT IN ('owner', 'admin')
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'PERMISSION_DENIED'
    );
  END IF;

  SELECT COALESCE(
    pg_catalog.array_agg(candidate_id ORDER BY candidate_id),
    ARRAY[]::uuid[]
  )
  INTO v_new_candidate_ids
  FROM pg_catalog.unnest(v_candidate_ids) AS candidate(candidate_id)
  WHERE NOT candidate_id = ANY(v_roster_ids);

  IF pg_catalog.cardinality(v_new_candidate_ids) = 0 THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'channel_id', p_channel_id,
      'added', 0
    );
  END IF;

  IF pg_catalog.cardinality(v_roster_ids)
       + pg_catalog.cardinality(v_new_candidate_ids) > 50
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CAPACITY_EXCEEDED'
    );
  END IF;

  SELECT pg_catalog.array_agg(participant_id ORDER BY participant_id)
  INTO STRICT v_participant_ids
  FROM (
    SELECT roster_id AS participant_id
    FROM pg_catalog.unnest(v_roster_ids) AS roster(roster_id)
    UNION
    SELECT candidate_id AS participant_id
    FROM pg_catalog.unnest(v_new_candidate_ids) AS candidate(candidate_id)
  ) AS participant;

  FOR v_left_id, v_right_id IN
    SELECT left_participant.participant_id, right_participant.participant_id
    FROM pg_catalog.unnest(v_participant_ids)
      AS left_participant(participant_id)
    CROSS JOIN pg_catalog.unnest(v_participant_ids)
      AS right_participant(participant_id)
    WHERE left_participant.participant_id < right_participant.participant_id
      AND (
        left_participant.participant_id = ANY(v_new_candidate_ids)
        OR right_participant.participant_id = ANY(v_new_candidate_ids)
      )
    ORDER BY
      left_participant.participant_id,
      right_participant.participant_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'direct-message:pair:'
          || LEAST(v_left_id::text, v_right_id::text)
          || ':'
          || GREATEST(v_left_id::text, v_right_id::text),
        0
      )
    );
  END LOOP;

  FOR v_profile IN
    SELECT
      profile.id,
      profile.dm_permission,
      profile.deleted_at,
      profile.banned_at,
      profile.is_banned,
      profile.ban_expires_at
    FROM public.user_profiles AS profile
    WHERE profile.id = ANY(v_participant_ids)
    ORDER BY profile.id
    FOR SHARE
  LOOP
    IF v_profile.deleted_at IS NULL
       AND v_profile.banned_at IS NULL
       AND NOT (
         v_profile.is_banned IS TRUE
         AND (
           v_profile.ban_expires_at IS NULL
           OR v_profile.ban_expires_at > pg_catalog.statement_timestamp()
         )
       )
    THEN
      v_active_profile_ids := pg_catalog.array_append(
        v_active_profile_ids,
        v_profile.id
      );
    END IF;

    IF v_profile.id = ANY(v_new_candidate_ids) THEN
      CASE v_profile.dm_permission
        WHEN 'all' THEN
          NULL;
        WHEN 'mutual' THEN
          v_mutual_candidate_ids := pg_catalog.array_append(
            v_mutual_candidate_ids,
            v_profile.id
          );
        ELSE
          v_privacy_denied := true;
      END CASE;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_roster_ids) AS roster(roster_id)
    WHERE NOT roster_id = ANY(v_auth_user_ids)
       OR NOT roster_id = ANY(v_active_profile_ids)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'channel roster contains an unavailable identity';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_new_candidate_ids) AS candidate(candidate_id)
    WHERE NOT candidate_id = ANY(v_auth_user_ids)
       OR NOT candidate_id = ANY(v_active_profile_ids)
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CANDIDATE_UNAVAILABLE'
    );
  END IF;

  IF v_privacy_denied OR EXISTS (
    SELECT 1
    FROM public.blocked_users AS block_edge
    WHERE block_edge.blocker_id = ANY(v_participant_ids)
      AND block_edge.blocked_id = ANY(v_participant_ids)
      AND (
        block_edge.blocker_id = ANY(v_new_candidate_ids)
        OR block_edge.blocked_id = ANY(v_new_candidate_ids)
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_mutual_candidate_ids)
      AS mutual_candidate(candidate_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.user_follows AS actor_follow
      WHERE actor_follow.follower_id = p_actor_id
        AND actor_follow.following_id = mutual_candidate.candidate_id
    ) OR NOT EXISTS (
      SELECT 1
      FROM public.user_follows AS candidate_follow
      WHERE candidate_follow.follower_id = mutual_candidate.candidate_id
        AND candidate_follow.following_id = p_actor_id
    )
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'PRIVACY_DENIED'
    );
  END IF;

  WITH inserted_members AS (
    INSERT INTO public.channel_members (
      id,
      channel_id,
      user_id,
      role
    )
    SELECT
      pg_catalog.gen_random_uuid(),
      p_channel_id,
      candidate_id,
      'member'
    FROM pg_catalog.unnest(v_new_candidate_ids) AS candidate(candidate_id)
    ORDER BY candidate_id
    RETURNING channel_id, user_id, role
  )
  SELECT
    pg_catalog.count(*)::integer,
    COALESCE(
      pg_catalog.array_agg(user_id ORDER BY user_id),
      ARRAY[]::uuid[]
    )
  INTO v_inserted_count, v_inserted_ids
  FROM inserted_members
  WHERE channel_id = p_channel_id
    AND role = 'member';

  IF v_inserted_count <> pg_catalog.cardinality(v_new_candidate_ids)
     OR v_inserted_ids IS DISTINCT FROM v_new_candidate_ids
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'channel membership insert acknowledgement is incomplete';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'channel_id', p_channel_id,
    'added', v_inserted_count
  );
END
$function$;

ALTER FUNCTION public.add_channel_members_atomic(uuid, uuid, uuid[])
  OWNER TO postgres;

DO $converge_add_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.add_channel_members_atomic(uuid,uuid,uuid[])'::regprocedure;
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
    ON FUNCTION public.add_channel_members_atomic(uuid, uuid, uuid[])
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.add_channel_members_atomic(uuid, uuid, uuid[])
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-existing-channel-member-add:v2:' || pg_catalog.md5(v_source)
  );
END
$converge_add_acl_and_attest$;

CREATE OR REPLACE FUNCTION public.create_group_channel_atomic(
  p_channel_id uuid,
  p_actor_id uuid,
  p_name text,
  p_description text,
  p_candidate_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_candidate_ids uuid[] := ARRAY[]::uuid[];
  v_participant_ids uuid[] := ARRAY[]::uuid[];
  v_auth_lock_ids uuid[] := ARRAY[]::uuid[];
  v_auth_user_ids uuid[] := ARRAY[]::uuid[];
  v_active_candidate_ids uuid[] := ARRAY[]::uuid[];
  v_mutual_candidate_ids uuid[] := ARRAY[]::uuid[];
  v_inserted_candidate_ids uuid[] := ARRAY[]::uuid[];
  v_inserted_roster jsonb := '[]'::jsonb;
  v_expected_roster jsonb := '[]'::jsonb;
  v_existing_roster jsonb := '[]'::jsonb;
  v_actor_profile_seen boolean := false;
  v_actor_active boolean := false;
  v_privacy_denied boolean := false;
  v_profile record;
  v_left_id uuid;
  v_right_id uuid;
  v_existing_channel_id uuid;
  v_observed_created_by uuid;
  v_observed_row_token text;
  v_rechecked_row_token text;
  v_observed_channel_exists boolean := false;
  v_channel public.chat_channels%ROWTYPE;
  v_now timestamptz := pg_catalog.statement_timestamp();
  v_inserted_count integer := 0;
  v_inserted_owner_count integer := 0;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_channel_id IS NULL
     OR p_actor_id IS NULL
     OR p_name IS NULL
     OR p_name IS DISTINCT FROM pg_catalog.btrim(p_name)
     OR pg_catalog.char_length(p_name) NOT BETWEEN 1 AND 100
     OR (
       p_description IS NOT NULL
       AND (
         p_description IS DISTINCT FROM pg_catalog.btrim(p_description)
         OR pg_catalog.char_length(p_description) NOT BETWEEN 1 AND 2000
       )
     )
     OR p_candidate_ids IS NULL
     OR pg_catalog.array_ndims(p_candidate_ids) IS DISTINCT FROM 1
     OR pg_catalog.array_lower(p_candidate_ids, 1) IS DISTINCT FROM 1
     OR pg_catalog.cardinality(p_candidate_ids) NOT BETWEEN 1 AND 49
     OR pg_catalog.array_position(p_candidate_ids, NULL::uuid) IS NOT NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'canonical channel fields and one to forty-nine candidates are required';
  END IF;

  SELECT pg_catalog.array_agg(candidate_id ORDER BY candidate_id)
  INTO STRICT v_candidate_ids
  FROM (
    SELECT DISTINCT candidate_id
    FROM pg_catalog.unnest(p_candidate_ids) AS candidate(candidate_id)
  ) AS unique_candidate;

  IF pg_catalog.cardinality(v_candidate_ids) <>
       pg_catalog.cardinality(p_candidate_ids)
     OR p_actor_id = ANY(v_candidate_ids)
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'candidate IDs must be distinct and must not include the actor';
  END IF;

  SELECT pg_catalog.array_agg(participant_id ORDER BY participant_id)
  INTO STRICT v_participant_ids
  FROM (
    SELECT p_actor_id AS participant_id
    UNION
    SELECT candidate_id
    FROM pg_catalog.unnest(v_candidate_ids) AS candidate(candidate_id)
  ) AS participant;

  SELECT pg_catalog.jsonb_agg(
    pg_catalog.jsonb_build_object(
      'user_id', participant_id,
      'role', CASE
        WHEN participant_id = p_actor_id THEN 'owner'
        ELSE 'member'
      END
    )
    ORDER BY participant_id
  )
  INTO STRICT v_expected_roster
  FROM pg_catalog.unnest(v_participant_ids) AS participant(participant_id);

  -- Creation writes both a group parent and its owner child. Acquire the
  -- exclusive owner barrier before every channel/Auth/pair/profile/tuple lock.
  -- The parent/member BEFORE triggers later re-enter this same lock. Concurrent
  -- normal creates wait here instead of surfacing a transient 40001/HTTP 500.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );

  -- After the global owner barrier, the same channel key is next in
  -- add_channel_members_atomic. It serializes UUID replay/collision and prevents
  -- a later member-add operation from observing an ownerless or partial roster.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'channel-membership:channel:' || p_channel_id::text,
      0
    )
  );

  -- Observe identity without a tuple lock. Auth hard deletion locks auth.users
  -- before its created_by SET NULL action touches chat_channels; locking the
  -- channel row here would invert that order. The observation is revalidated
  -- only after every relevant Auth parent is stable.
  SELECT
    channel_row.id,
    channel_row.created_by,
    channel_row.xmin::text || ':' || channel_row.ctid::text
  INTO
    v_existing_channel_id,
    v_observed_created_by,
    v_observed_row_token
  FROM public.chat_channels AS channel_row
  WHERE channel_row.id = p_channel_id;
  v_observed_channel_exists := FOUND;

  SELECT pg_catalog.array_agg(identity_id ORDER BY identity_id)
  INTO STRICT v_auth_lock_ids
  FROM (
    SELECT participant_id AS identity_id
    FROM pg_catalog.unnest(v_participant_ids) AS participant(participant_id)
    UNION
    SELECT v_observed_created_by
    WHERE v_observed_created_by IS NOT NULL
  ) AS identity;

  -- Auth parents precede every pair/profile/child lock. A normal block/follow
  -- INSERT takes pair then a compatible FK KEY SHARE; Auth hard deletion takes
  -- an incompatible parent lock before its pair-triggered cascades. Therefore
  -- neither direction can form an auth-parent <-> pair deadlock.
  SELECT COALESCE(
    pg_catalog.array_agg(locked_user.id ORDER BY locked_user.id),
    ARRAY[]::uuid[]
  )
  INTO v_auth_user_ids
  FROM (
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id = ANY(v_auth_lock_ids)
    ORDER BY auth_user.id
    FOR SHARE
  ) AS locked_user;

  SELECT channel_row.*
  INTO v_channel
  FROM public.chat_channels AS channel_row
  WHERE channel_row.id = p_channel_id
  FOR UPDATE;

  IF FOUND THEN
    SELECT channel_row.xmin::text || ':' || channel_row.ctid::text
    INTO STRICT v_rechecked_row_token
    FROM public.chat_channels AS channel_row
    WHERE channel_row.id = p_channel_id;
  END IF;

  IF v_observed_channel_exists THEN
    IF NOT FOUND
       OR v_channel.created_by IS DISTINCT FROM v_observed_created_by
       OR v_rechecked_row_token IS DISTINCT FROM v_observed_row_token
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', false,
        'reason', 'CHANNEL_ID_CONFLICT'
      );
    END IF;
    v_existing_channel_id := v_channel.id;
  ELSIF FOUND THEN
    -- A noncanonical writer introduced this UUID without taking the shared
    -- advisory key. It was not part of the Auth lock set and is never replayed.
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CHANNEL_ID_CONFLICT'
    );
  ELSE
    v_existing_channel_id := NULL;
  END IF;

  -- A committed same-ID create is an idempotent replay only when the complete
  -- immutable creation intent and owner/member roster still match. Lock Auth
  -- parents before roster children, matching the existing-channel RPC and Auth
  -- cascade order. Never re-run current privacy checks for a verified replay:
  -- the original transaction already linearized them before its write.
  IF v_existing_channel_id IS NOT NULL THEN
    SELECT COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'user_id', locked_member.user_id,
          'role', locked_member.role
        )
        ORDER BY locked_member.user_id
      ),
      '[]'::jsonb
    )
    INTO v_existing_roster
    FROM (
      SELECT membership.user_id, membership.role
      FROM public.channel_members AS membership
      WHERE membership.channel_id = p_channel_id
      ORDER BY membership.user_id
      FOR UPDATE
    ) AS locked_member;

    IF v_channel.type IS NOT DISTINCT FROM 'group'
       AND v_channel.created_by IS NOT DISTINCT FROM p_actor_id
       AND v_channel.name IS NOT DISTINCT FROM p_name
       AND v_channel.description IS NOT DISTINCT FROM p_description
       AND v_existing_roster IS NOT DISTINCT FROM v_expected_roster
    THEN
      RETURN pg_catalog.jsonb_build_object(
        'success', true,
        'channel', pg_catalog.to_jsonb(v_channel),
        'member_count', pg_catalog.jsonb_array_length(v_existing_roster),
        'members', v_existing_roster
      );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CHANNEL_ID_CONFLICT'
    );
  END IF;

  IF NOT p_actor_id = ANY(v_auth_user_ids) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_candidate_ids) AS candidate(candidate_id)
    WHERE NOT candidate_id = ANY(v_auth_user_ids)
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CANDIDATE_UNAVAILABLE'
    );
  END IF;

  -- Acquire every participant pair (including self pairs) in UUID order. UUID
  -- text is fixed-width hexadecimal, so this is the same lexical order used by
  -- serialize_direct_message_pair_edge's sorted affected_pair strings.
  FOR v_left_id, v_right_id IN
    SELECT left_participant.participant_id, right_participant.participant_id
    FROM pg_catalog.unnest(v_participant_ids)
      AS left_participant(participant_id)
    CROSS JOIN pg_catalog.unnest(v_participant_ids)
      AS right_participant(participant_id)
    WHERE left_participant.participant_id <= right_participant.participant_id
    ORDER BY
      left_participant.participant_id,
      right_participant.participant_id
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'direct-message:pair:'
          || LEAST(v_left_id::text, v_right_id::text)
          || ':'
          || GREATEST(v_left_id::text, v_right_id::text),
        0
      )
    );
  END LOOP;

  -- Profile rows are stable until commit, closing preference, ban and soft
  -- deletion races. Unknown/null permission values fail closed.
  FOR v_profile IN
    SELECT
      profile.id,
      profile.dm_permission,
      profile.deleted_at,
      profile.banned_at,
      profile.is_banned,
      profile.ban_expires_at
    FROM public.user_profiles AS profile
    WHERE profile.id = ANY(v_participant_ids)
    ORDER BY profile.id
    FOR SHARE
  LOOP
    IF v_profile.id = p_actor_id THEN
      v_actor_profile_seen := true;
      v_actor_active :=
        v_profile.deleted_at IS NULL
        AND v_profile.banned_at IS NULL
        AND v_profile.dm_permission IN ('all', 'mutual', 'none')
        AND NOT (
          v_profile.is_banned IS TRUE
          AND (
            v_profile.ban_expires_at IS NULL
            OR v_profile.ban_expires_at > v_now
          )
        );
    ELSE
      IF v_profile.deleted_at IS NULL
         AND v_profile.banned_at IS NULL
         AND NOT (
           v_profile.is_banned IS TRUE
           AND (
             v_profile.ban_expires_at IS NULL
             OR v_profile.ban_expires_at > v_now
           )
         )
      THEN
        v_active_candidate_ids := pg_catalog.array_append(
          v_active_candidate_ids,
          v_profile.id
        );
      END IF;

      CASE v_profile.dm_permission
        WHEN 'all' THEN
          NULL;
        WHEN 'mutual' THEN
          v_mutual_candidate_ids := pg_catalog.array_append(
            v_mutual_candidate_ids,
            v_profile.id
          );
        ELSE
          v_privacy_denied := true;
      END CASE;
    END IF;
  END LOOP;

  IF NOT v_actor_profile_seen OR NOT v_actor_active THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'ACTOR_UNAVAILABLE'
    );
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_candidate_ids) AS candidate(candidate_id)
    WHERE NOT candidate_id = ANY(v_active_candidate_ids)
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CANDIDATE_UNAVAILABLE'
    );
  END IF;

  IF v_privacy_denied OR EXISTS (
    SELECT 1
    FROM public.blocked_users AS block_edge
    WHERE block_edge.blocker_id = ANY(v_participant_ids)
      AND block_edge.blocked_id = ANY(v_participant_ids)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(v_mutual_candidate_ids)
      AS mutual_candidate(candidate_id)
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.user_follows AS actor_follow
      WHERE actor_follow.follower_id = p_actor_id
        AND actor_follow.following_id = mutual_candidate.candidate_id
    ) OR NOT EXISTS (
      SELECT 1
      FROM public.user_follows AS candidate_follow
      WHERE candidate_follow.follower_id = mutual_candidate.candidate_id
        AND candidate_follow.following_id = p_actor_id
    )
  ) THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'PRIVACY_DENIED'
    );
  END IF;

  INSERT INTO public.chat_channels (
    id,
    name,
    type,
    created_by,
    avatar_url,
    description,
    conversation_id,
    last_message_at,
    last_message_preview,
    created_at,
    updated_at
  ) VALUES (
    p_channel_id,
    p_name,
    'group',
    p_actor_id,
    NULL,
    p_description,
    NULL,
    v_now,
    NULL,
    v_now,
    v_now
  )
  RETURNING * INTO STRICT v_channel;

  WITH inserted_members AS (
    INSERT INTO public.channel_members (
      id,
      channel_id,
      user_id,
      role,
      nickname,
      is_muted,
      is_pinned,
      cleared_before,
      joined_at
    )
    SELECT
      pg_catalog.gen_random_uuid(),
      p_channel_id,
      participant_id,
      CASE WHEN participant_id = p_actor_id THEN 'owner' ELSE 'member' END,
      NULL,
      false,
      false,
      NULL,
      v_now
    FROM pg_catalog.unnest(v_participant_ids) AS participant(participant_id)
    ORDER BY participant_id
    RETURNING channel_id, user_id, role
  )
  SELECT
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) FILTER (WHERE role = 'owner')::integer,
    COALESCE(
      pg_catalog.array_agg(user_id ORDER BY user_id)
        FILTER (WHERE role = 'member'),
      ARRAY[]::uuid[]
    ),
    COALESCE(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object('user_id', user_id, 'role', role)
        ORDER BY user_id
      ),
      '[]'::jsonb
    )
  INTO
    v_inserted_count,
    v_inserted_owner_count,
    v_inserted_candidate_ids,
    v_inserted_roster
  FROM inserted_members
  WHERE channel_id = p_channel_id;

  IF v_inserted_count <> pg_catalog.cardinality(v_participant_ids)
     OR v_inserted_owner_count <> 1
     OR v_inserted_candidate_ids IS DISTINCT FROM v_candidate_ids
     OR v_inserted_roster IS DISTINCT FROM v_expected_roster
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'group-channel roster acknowledgement is incomplete';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'channel', pg_catalog.to_jsonb(v_channel),
    'member_count', v_inserted_count,
    'members', v_inserted_roster
  );
END
$function$;

ALTER FUNCTION public.create_group_channel_atomic(uuid, uuid, text, text, uuid[])
  OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.create_group_channel_atomic(uuid,uuid,text,text,uuid[])'::regprocedure;
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
    ON FUNCTION public.create_group_channel_atomic(uuid, uuid, text, text, uuid[])
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.create_group_channel_atomic(uuid, uuid, text, text, uuid[])
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-group-channel-create:v1:' || pg_catalog.md5(v_source)
  );
END
$converge_acl_and_attest$;

-- Dissolution used to authorize from an unlocked membership read and then issue
-- an unchecked parent DELETE. Keep authorization, deletion and acknowledgement
-- in one transaction. A missing parent is a resource-level idempotent success,
-- which makes retry after a lost successful response safe without allowing a
-- non-owner to delete a channel that currently exists.
CREATE OR REPLACE FUNCTION public.dissolve_group_channel_atomic(
  p_channel_id uuid,
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
  v_observed_channel_type text;
  v_channel_type text;
  v_observed_created_by uuid;
  v_created_by uuid;
  v_observed_row_token text;
  v_row_token text;
  v_rechecked_channel_exists boolean := false;
  v_observed_roster_ids uuid[] := ARRAY[]::uuid[];
  v_auth_lock_ids uuid[] := ARRAY[]::uuid[];
  v_auth_user_ids uuid[] := ARRAY[]::uuid[];
  v_observed_roster jsonb := '[]'::jsonb;
  v_locked_roster jsonb := '[]'::jsonb;
  v_actor_role text;
  v_member record;
  v_deleted_count integer := 0;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_channel_id IS NULL OR p_actor_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'channel and actor are required';
  END IF;

  -- This is an owner/parent mutation. The exclusive barrier must precede the
  -- channel advisory and every tuple lock. Direct/FK-triggered owner events use
  -- the nonblocking exclusive try-lock, so either they linearize first or they
  -- roll back without forming an Auth/child/channel cycle.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('group-channel-owner-invariant:v1', 0)
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'channel-membership:channel:' || p_channel_id::text,
      0
    )
  );

  -- Observe the parent and complete roster without tuple locks. The creator can
  -- legitimately be a non-owner after an ownership transfer; a hard Auth delete
  -- then cascades that ordinary membership before SET NULL reaches the parent.
  -- Every observed identity must therefore join the canonical Auth parent set
  -- before this function is allowed to lock either channel or roster children.
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

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', true,
      'channel_id', p_channel_id,
      'applied', false,
      'deleted', 0
    );
  END IF;

  IF v_observed_channel_type IS DISTINCT FROM 'group' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'channel_id', p_channel_id,
      'reason', 'CHANNEL_NOT_GROUP'
    );
  END IF;

  FOR v_member IN
    SELECT membership.user_id, membership.role
    FROM public.channel_members AS membership
    WHERE membership.channel_id = p_channel_id
    ORDER BY membership.user_id
  LOOP
    v_observed_roster_ids := pg_catalog.array_append(
      v_observed_roster_ids,
      v_member.user_id
    );
    v_observed_roster := v_observed_roster || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'user_id', v_member.user_id,
        'role', v_member.role
      )
    );
  END LOOP;

  SELECT pg_catalog.array_agg(identity_id ORDER BY identity_id)
  INTO STRICT v_auth_lock_ids
  FROM (
    SELECT p_actor_id AS identity_id
    UNION
    SELECT v_observed_created_by
    WHERE v_observed_created_by IS NOT NULL
    UNION
    SELECT roster_id
    FROM pg_catalog.unnest(v_observed_roster_ids) AS roster(roster_id)
  ) AS identity;

  SELECT COALESCE(
    pg_catalog.array_agg(locked_user.id ORDER BY locked_user.id),
    ARRAY[]::uuid[]
  )
  INTO v_auth_user_ids
  FROM (
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id = ANY(v_auth_lock_ids)
    ORDER BY auth_user.id
    FOR SHARE
  ) AS locked_user;

  IF v_auth_user_ids IS DISTINCT FROM v_auth_lock_ids THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'group-channel identity changed while locking; retry';
  END IF;

  SELECT
    channel_row.type,
    channel_row.created_by,
    channel_row.xmin::text || ':' || channel_row.ctid::text
  INTO
    v_channel_type,
    v_created_by,
    v_row_token
  FROM public.chat_channels AS channel_row
  WHERE channel_row.id = p_channel_id
  FOR UPDATE;
  v_rechecked_channel_exists := FOUND;

  IF NOT v_rechecked_channel_exists
     OR v_channel_type IS DISTINCT FROM v_observed_channel_type
     OR v_created_by IS DISTINCT FROM v_observed_created_by
     OR v_row_token IS DISTINCT FROM v_observed_row_token
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'group-channel identity changed while locking; retry';
  END IF;

  -- Lock and exactly revalidate the complete roster in canonical UUID order.
  -- Authorization is read only from these final locked rows, closing both the
  -- former owner-check -> demotion -> DELETE race and Auth parent cascade ring.
  FOR v_member IN
    SELECT membership.user_id, membership.role
    FROM public.channel_members AS membership
    WHERE membership.channel_id = p_channel_id
    ORDER BY membership.user_id
    FOR UPDATE
  LOOP
    v_locked_roster := v_locked_roster || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'user_id', v_member.user_id,
        'role', v_member.role
      )
    );
    IF v_member.user_id = p_actor_id THEN
      v_actor_role := v_member.role;
    END IF;
  END LOOP;

  IF v_locked_roster IS DISTINCT FROM v_observed_roster THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'group-channel roster changed while locking; retry';
  END IF;

  IF v_actor_role IS DISTINCT FROM 'owner' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'channel_id', p_channel_id,
      'reason', 'PERMISSION_DENIED'
    );
  END IF;

  WITH deleted_channel AS (
    DELETE FROM public.chat_channels AS channel_row
    WHERE channel_row.id = p_channel_id
      AND channel_row.type = 'group'
    RETURNING channel_row.id
  )
  SELECT pg_catalog.count(*)::integer
  INTO STRICT v_deleted_count
  FROM deleted_channel;

  IF v_deleted_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'group-channel dissolution acknowledgement is incomplete';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'success', true,
    'channel_id', p_channel_id,
    'applied', true,
    'deleted', v_deleted_count
  );
END
$function$;

ALTER FUNCTION public.dissolve_group_channel_atomic(uuid, uuid)
  OWNER TO postgres;

DO $converge_dissolve_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.dissolve_group_channel_atomic(uuid,uuid)'::regprocedure;
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
    ON FUNCTION public.dissolve_group_channel_atomic(uuid, uuid)
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.dissolve_group_channel_atomic(uuid, uuid)
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-group-channel-dissolve:v1:' || pg_catalog.md5(v_source)
  );
END
$converge_dissolve_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.create_group_channel_atomic(uuid,uuid,text,text,uuid[])'::regprocedure;
  v_pair_function regprocedure :=
    'public.serialize_direct_message_pair_edge()'::regprocedure;
  v_add_function regprocedure :=
    'public.add_channel_members_atomic(uuid,uuid,uuid[])'::regprocedure;
  v_dissolve_function regprocedure :=
    'public.dissolve_group_channel_atomic(uuid,uuid)'::regprocedure;
  v_owner_count_function regprocedure :=
    'public.enforce_group_channel_owner_count()'::regprocedure;
  v_owner_serializer_function regprocedure :=
    'public.serialize_group_channel_owner_event()'::regprocedure;
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
  v_add_source text;
  v_dissolve_source text;
  v_owner_lock integer;
  v_channel_lock integer;
  v_auth_lock integer;
  v_pair_lock integer;
  v_profile_lock integer;
  v_block_read integer;
  v_channel_insert integer;
  v_member_insert integer;
  v_add_owner_lock integer;
  v_add_channel_lock integer;
  v_add_observation integer;
  v_add_auth_lock integer;
  v_add_channel_recheck integer;
  v_add_roster_lock integer;
  v_add_pair_lock integer;
  v_dissolve_owner_lock integer;
  v_dissolve_channel_lock integer;
  v_dissolve_observation integer;
  v_dissolve_auth_lock integer;
  v_dissolve_channel_recheck integer;
  v_dissolve_roster_lock integer;
  v_dissolve_delete integer;
BEGIN
  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'create_group_channel_atomic'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 5
      AND function_row.pronargdefaults = 0
      AND function_row.proargnames = ARRAY[
        'p_channel_id',
        'p_actor_id',
        'p_name',
        'p_description',
        'p_candidate_ids'
      ]::text[]
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.proowner = v_postgres_oid
      AND language_row.lanname = 'plpgsql'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
        'atomic-group-channel-create:v1:'
          || pg_catalog.md5(function_row.prosrc)
  ) THEN
    RAISE EXCEPTION 'atomic group-channel function metadata drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
    'service_role',
    v_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_function,
    'EXECUTE'
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
      AND (
        acl_entry.grantee <> v_service_oid
        OR acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'atomic group-channel EXECUTE boundary drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'add_channel_members_atomic'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_add_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 3
      AND function_row.pronargdefaults = 0
      AND function_row.proargnames = ARRAY[
        'p_channel_id',
        'p_actor_id',
        'p_candidate_ids'
      ]::text[]
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.proowner = v_postgres_oid
      AND language_row.lanname = 'plpgsql'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
        'atomic-existing-channel-member-add:v2:'
          || pg_catalog.md5(function_row.prosrc)
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_add_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_add_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_add_function,
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_add_function
      AND acl_entry.grantee <> function_row.proowner
      AND (
        acl_entry.grantee <> v_service_oid
        OR acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'atomic channel-member v2 metadata/ACL drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'dissolve_group_channel_atomic'
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_dissolve_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 2
      AND function_row.pronargdefaults = 0
      AND function_row.proargnames = ARRAY[
        'p_channel_id',
        'p_actor_id'
      ]::text[]
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.proowner = v_postgres_oid
      AND language_row.lanname = 'plpgsql'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
        'atomic-group-channel-dissolve:v1:'
          || pg_catalog.md5(function_row.prosrc)
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    v_dissolve_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_dissolve_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_dissolve_function,
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_dissolve_function
      AND acl_entry.grantee <> function_row.proowner
      AND (
        acl_entry.grantee <> v_service_oid
        OR acl_entry.privilege_type <> 'EXECUTE'
        OR acl_entry.is_grantable
      )
  ) THEN
    RAISE EXCEPTION 'atomic group-channel dissolve metadata/ACL drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_add_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_add_function;

  v_add_owner_lock := pg_catalog.strpos(
    v_add_source,
    'pg_advisory_xact_lock_shared'
  );
  v_add_channel_lock := pg_catalog.strpos(
    v_add_source,
    $$'channel-membership:channel:' || p_channel_id::text$$
  );
  v_add_observation := pg_catalog.strpos(
    v_add_source,
    'v_observed_channel_exists := FOUND'
  );
  v_add_auth_lock := pg_catalog.strpos(
    v_add_source,
    'FROM auth.users AS auth_user'
  );
  v_add_channel_recheck := pg_catalog.strpos(
    v_add_source,
    'v_rechecked_channel_exists := FOUND'
  );
  v_add_roster_lock := pg_catalog.strpos(
    v_add_source,
    'v_roster_ids := pg_catalog.array_append'
  );
  v_add_pair_lock := pg_catalog.strpos(
    v_add_source,
    $$'direct-message:pair:'$$
  );

  IF v_add_owner_lock = 0
     OR v_add_channel_lock <= v_add_owner_lock
     OR v_add_observation <= v_add_channel_lock
     OR v_add_auth_lock <= v_add_observation
     OR v_add_channel_recheck <= v_add_auth_lock
     OR v_add_roster_lock <= v_add_channel_recheck
     OR v_add_pair_lock <= v_add_roster_lock
     OR pg_catalog.strpos(
       v_add_source,
       'SELECT v_observed_created_by'
     ) = 0
     OR pg_catalog.strpos(v_add_source, 'ORDER BY auth_user.id') = 0
     OR pg_catalog.strpos(v_add_source, 'ORDER BY membership.user_id') = 0
     OR pg_catalog.strpos(
       v_add_source,
       'v_rechecked_row_token IS DISTINCT FROM v_observed_row_token'
     ) = 0
     OR pg_catalog.strpos(
       v_add_source,
       'INSERT INTO public.channel_members'
     ) <= v_add_pair_lock
     OR pg_catalog.strpos(
       v_add_source,
       $$'group-channel-owner-invariant:v1'$$
     ) <= 0
  THEN
    RAISE EXCEPTION 'atomic channel-member v2 lock/write behavior drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_dissolve_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_dissolve_function;

  v_dissolve_owner_lock := pg_catalog.strpos(
    v_dissolve_source,
    $$'group-channel-owner-invariant:v1'$$
  );
  v_dissolve_channel_lock := pg_catalog.strpos(
    v_dissolve_source,
    $$'channel-membership:channel:' || p_channel_id::text$$
  );
  v_dissolve_observation := pg_catalog.strpos(
    v_dissolve_source,
    'WHERE channel_row.id = p_channel_id;'
  );
  v_dissolve_auth_lock := pg_catalog.strpos(
    v_dissolve_source,
    'FROM auth.users AS auth_user'
  );
  v_dissolve_channel_recheck := pg_catalog.strpos(
    v_dissolve_source,
    'v_rechecked_channel_exists := FOUND'
  );
  v_dissolve_roster_lock := pg_catalog.strpos(
    v_dissolve_source,
    'v_locked_roster := v_locked_roster'
  );
  v_dissolve_delete := pg_catalog.strpos(
    v_dissolve_source,
    'DELETE FROM public.chat_channels AS channel_row'
  );

  IF v_dissolve_owner_lock = 0
     OR v_dissolve_channel_lock <= v_dissolve_owner_lock
     OR v_dissolve_observation <= v_dissolve_channel_lock
     OR v_dissolve_auth_lock <= v_dissolve_observation
     OR v_dissolve_channel_recheck <= v_dissolve_auth_lock
     OR v_dissolve_roster_lock <= v_dissolve_channel_recheck
     OR v_dissolve_delete <= v_dissolve_roster_lock
     OR pg_catalog.strpos(
       v_dissolve_source,
       $$v_actor_role IS DISTINCT FROM 'owner'$$
     ) <= v_dissolve_roster_lock
     OR pg_catalog.strpos(v_dissolve_source, $$'applied', false$$) = 0
     OR pg_catalog.strpos(v_dissolve_source, $$'applied', true$$) = 0
     OR pg_catalog.strpos(v_dissolve_source, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_dissolve_source, 'ORDER BY membership.user_id') = 0
     OR pg_catalog.strpos(
       v_dissolve_source,
       'v_auth_user_ids IS DISTINCT FROM v_auth_lock_ids'
     ) = 0
     OR pg_catalog.strpos(
       v_dissolve_source,
       'v_row_token IS DISTINCT FROM v_observed_row_token'
     ) = 0
     OR pg_catalog.strpos(
       v_dissolve_source,
       'v_locked_roster IS DISTINCT FROM v_observed_roster'
     ) = 0
  THEN
    RAISE EXCEPTION 'atomic group-channel dissolve lock/write behavior drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  v_owner_lock := pg_catalog.strpos(
    v_source,
    $$'group-channel-owner-invariant:v1'$$
  );
  v_channel_lock := pg_catalog.strpos(
    v_source,
    $$'channel-membership:channel:' || p_channel_id::text$$
  );
  v_auth_lock := pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user');
  v_pair_lock := pg_catalog.strpos(v_source, $$'direct-message:pair:'$$);
  v_profile_lock := pg_catalog.strpos(
    v_source,
    'FROM public.user_profiles AS profile'
  );
  v_block_read := pg_catalog.strpos(
    v_source,
    'FROM public.blocked_users AS block_edge'
  );
  v_channel_insert := pg_catalog.strpos(
    v_source,
    'INSERT INTO public.chat_channels'
  );
  v_member_insert := pg_catalog.strpos(
    v_source,
    'INSERT INTO public.channel_members'
  );

  IF v_owner_lock = 0
     OR v_channel_lock <= v_owner_lock
     OR v_auth_lock <= v_channel_lock
     OR v_pair_lock <= v_auth_lock
     OR v_profile_lock <= v_pair_lock
     OR v_block_read <= v_profile_lock
     OR v_channel_insert <= v_block_read
     OR v_member_insert <= v_channel_insert
     OR pg_catalog.strpos(
       v_source,
       'FROM public.user_follows AS actor_follow'
     ) = 0
     OR pg_catalog.strpos(v_source, 'FOR SHARE') = 0
     OR pg_catalog.strpos(v_source, 'ORDER BY auth_user.id') = 0
     OR pg_catalog.strpos(v_source, 'ORDER BY profile.id') = 0
     OR pg_catalog.strpos(v_source, $$'role', role$$) = 0
     OR pg_catalog.strpos(
       v_source,
       $$v_inserted_candidate_ids IS DISTINCT FROM v_candidate_ids$$
     ) = 0
  THEN
    RAISE EXCEPTION 'atomic group-channel lock/write behavior drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_pair_function
      AND function_row.prosecdef
      AND function_row.proowner = v_postgres_oid
      AND pg_catalog.strpos(
        function_row.prosrc,
        $$'direct-message:pair:' || v_pair$$
      ) > 0
      AND pg_catalog.strpos(function_row.prosrc, 'ORDER BY affected_pair') > 0
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid = v_pair_function
      AND trigger_row.tgrelid IN (
        'public.blocked_users'::regclass,
        'public.user_follows'::regclass
      )
      AND trigger_row.tgname IN (
        'trg_serialize_dm_block_pair',
        'trg_serialize_dm_follow_pair'
      )
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
      AND trigger_row.tgqual IS NULL
  ) <> 2 OR v_owner_serializer_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_owner_serializer_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'trigger'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 0
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.proowner = v_postgres_oid
      AND language_row.lanname = 'plpgsql'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
        'group-channel-owner-serializer:v1:'
          || pg_catalog.md5(function_row.prosrc)
      AND pg_catalog.strpos(
        function_row.prosrc,
        $$'group-channel-owner-invariant:v1'$$
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'pg_try_advisory_xact_lock'
      ) > 0
      AND pg_catalog.strpos(function_row.prosrc, $$ERRCODE = '40001'$$) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        $$TG_TABLE_NAME = 'channel_members'$$
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        $$TG_TABLE_NAME = 'chat_channels'$$
      ) > 0
      AND pg_catalog.strpos(function_row.prosrc, 'FOR SHARE NOWAIT') > 0
      AND pg_catalog.strpos(function_row.prosrc, 'OLD.created_by') > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        $$WHEN lock_not_available$$
      ) > 0
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_owner_serializer_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_owner_serializer_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    v_owner_serializer_function,
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_owner_serializer_function
      AND acl_entry.grantee <> function_row.proowner
  ) OR v_owner_count_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_language AS language_row
      ON language_row.oid = function_row.prolang
    WHERE function_row.oid = v_owner_count_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'trigger'::regtype
      AND NOT function_row.proretset
      AND function_row.pronargs = 0
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.proowner = v_postgres_oid
      AND language_row.lanname = 'plpgsql'
      AND function_row.proconfig = ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s'
      ]::text[]
      AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
        'group-channel-owner-count:v2:'
          || pg_catalog.md5(function_row.prosrc)
      AND pg_catalog.strpos(
        function_row.prosrc,
        $$'group-channel-owner-invariant:v1'$$
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'FROM public.channel_members AS remaining_owner'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'DELETE FROM public.chat_channels AS channel_row'
      ) > 0
  ) OR pg_catalog.has_function_privilege(
    'anon',
    v_owner_count_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    v_owner_count_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    v_owner_count_function,
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid = v_owner_count_function
      AND acl_entry.grantee <> function_row.proowner
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid IN (
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
      AND NOT trigger_row.tgisinternal
  ) <> 4 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.channel_members'::regclass
      AND NOT trigger_row.tgisinternal
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.channel_members'::regclass
      AND trigger_row.tgname = 'trg_serialize_group_channel_owner_event'
      AND trigger_row.tgfoid = v_owner_serializer_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
      AND trigger_row.tgqual IS NULL
      AND NOT trigger_row.tgdeferrable
      AND NOT trigger_row.tginitdeferred
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.channel_members'::regclass
      AND trigger_row.tgname = 'trg_enforce_group_channel_owner_count'
      AND trigger_row.tgfoid = v_owner_count_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 29
      AND trigger_row.tgqual IS NULL
      AND trigger_row.tgdeferrable
      AND trigger_row.tginitdeferred
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.chat_channels'::regclass
      AND trigger_row.tgname =
        'trg_serialize_group_channel_owner_event_on_channel'
      AND trigger_row.tgfoid = v_owner_serializer_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 31
      AND trigger_row.tgqual IS NULL
      AND NOT trigger_row.tgdeferrable
      AND NOT trigger_row.tginitdeferred
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.chat_channels'::regclass
      AND trigger_row.tgname =
        'trg_enforce_group_channel_owner_count_on_channel'
      AND trigger_row.tgfoid = v_owner_count_function
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgtype = 21
      AND trigger_row.tgqual IS NULL
      AND trigger_row.tgdeferrable
      AND trigger_row.tginitdeferred
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid IN (
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
      AND acl_entry.grantee <> relation.relowner
      AND (
        acl_entry.grantee <> v_service_oid
        OR acl_entry.is_grantable
        OR (
          relation.oid = 'public.chat_channels'::regclass
          AND acl_entry.privilege_type NOT IN ('SELECT', 'INSERT', 'UPDATE')
        )
        OR (
          relation.oid = 'public.channel_members'::regclass
          AND acl_entry.privilege_type NOT IN (
            'SELECT', 'INSERT', 'UPDATE', 'DELETE'
          )
        )
      )
  ) OR (
    SELECT pg_catalog.count(DISTINCT acl_entry.privilege_type)
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid = 'public.chat_channels'::regclass
      AND acl_entry.grantee = v_service_oid
      AND acl_entry.privilege_type IN ('SELECT', 'INSERT', 'UPDATE')
      AND NOT acl_entry.is_grantable
  ) <> 3 OR (
    SELECT pg_catalog.count(DISTINCT acl_entry.privilege_type)
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(relation.relacl, pg_catalog.acldefault('r', relation.relowner))
    ) AS acl_entry
    WHERE relation.oid = 'public.channel_members'::regclass
      AND acl_entry.grantee = v_service_oid
      AND acl_entry.privilege_type IN ('SELECT', 'INSERT', 'UPDATE', 'DELETE')
      AND NOT acl_entry.is_grantable
  ) <> 4 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid IN (
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass,
      'public.user_profiles'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass,
      'auth.users'::regclass
    )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass,
      'public.user_profiles'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass,
      'auth.users'::regclass
    ) OR inheritance.inhparent IN (
      'public.chat_channels'::regclass,
      'public.channel_members'::regclass,
      'public.user_profiles'::regclass,
      'public.blocked_users'::regclass,
      'public.user_follows'::regclass,
      'auth.users'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'atomic group-channel dependency authority drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
