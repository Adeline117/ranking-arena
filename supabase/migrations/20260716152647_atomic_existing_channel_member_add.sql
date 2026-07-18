-- Make additions to an existing group channel one database transaction.
-- The previous route read authority, capacity and privacy state before issuing
-- a separate channel_members INSERT. A block, follow, profile or roster change
-- could therefore commit between the decision and the write.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('atomic-existing-channel-member-add:migration', 0)
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
  v_pair_source text;
  v_post_block_source text;
  v_follow_notification_source text;
  v_follow_activity_source text;
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
  v_blocker_attnum smallint;
  v_blocked_attnum smallint;
  v_follower_attnum smallint;
  v_following_attnum smallint;
BEGIN
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
        'atomic channel-member dependency relation is incompatible: %',
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
    RAISE EXCEPTION
      'atomic channel-member public relation ownership/RLS is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('public', 'chat_channels', 'id', 'uuid'::regtype, true),
        ('public', 'chat_channels', 'type', 'text'::regtype, true),
        ('public', 'channel_members', 'id', 'uuid'::regtype, true),
        ('public', 'channel_members', 'channel_id', 'uuid'::regtype, true),
        ('public', 'channel_members', 'user_id', 'uuid'::regtype, true),
        ('public', 'channel_members', 'role', 'text'::regtype, true),
        ('public', 'user_profiles', 'id', 'uuid'::regtype, true),
        ('public', 'user_profiles', 'dm_permission', 'text'::regtype, false),
        ('public', 'user_profiles', 'deleted_at', 'timestamptz'::regtype, false),
        ('public', 'user_profiles', 'banned_at', 'timestamptz'::regtype, false),
        ('public', 'user_profiles', 'is_banned', 'boolean'::regtype, false),
        ('public', 'user_profiles', 'ban_expires_at', 'timestamptz'::regtype, false),
        ('public', 'blocked_users', 'blocker_id', 'uuid'::regtype, true),
        ('public', 'blocked_users', 'blocked_id', 'uuid'::regtype, true),
        ('public', 'user_follows', 'follower_id', 'uuid'::regtype, true),
        ('public', 'user_follows', 'following_id', 'uuid'::regtype, true),
        ('auth', 'users', 'id', 'uuid'::regtype, true)
    ) AS required_column(
      schema_name,
      relation_name,
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
         required_column.required_not_null
         AND NOT attribute.attnotnull
       )
  ) THEN
    RAISE EXCEPTION 'atomic channel-member dependency columns are incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS required_role
    RIGHT JOIN pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'service_role']::name[]
    ) AS required(role_name)
      ON required_role.rolname = required.role_name
    WHERE required_role.oid IS NULL
  ) THEN
    RAISE EXCEPTION 'required application database role is missing';
  END IF;

  -- The RPC relies on one immediate identity authority per roster/profile row.
  IF NOT EXISTS (
    SELECT 1
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
      AND (
        SELECT attribute.attname
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality = 1
      ) = 'id'
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
      AND (
        SELECT attribute.attname
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality = 1
      ) = 'id'
  ) OR NOT EXISTS (
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
      AND (
        SELECT attribute.attname
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality = 1
      ) = 'id'
  ) THEN
    RAISE EXCEPTION 'channel/profile/auth identity index contract failed';
  END IF;

  IF (
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
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.blocked_users'::regclass
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
      ) = ARRAY['blocker_id', 'blocked_id']::name[]
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.user_follows'::regclass
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
      ) = ARRAY['follower_id', 'following_id']::name[]
  ) <> 1 THEN
    RAISE EXCEPTION 'membership/block/follow edge uniqueness contract failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.channel_members'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts >= 1
      AND index_row.indkey[0] = (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = index_row.indrelid
          AND attribute.attname = 'channel_id'
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.blocked_users'::regclass
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts >= 1
      AND index_row.indkey[0] = (
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = index_row.indrelid
          AND attribute.attname = 'blocked_id'
      )
  ) THEN
    RAISE EXCEPTION 'bounded roster or reverse-block lookup index is missing';
  END IF;

  -- Extra unique authorities can make otherwise valid membership or privacy
  -- edges fail for unrelated keys. Allow only the documented identities.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.channel_members'::regclass
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
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.blocked_users'::regclass
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
        ) <> ARRAY['blocker_id', 'blocked_id']::name[]
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.user_follows'::regclass
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
          ARRAY['follower_id', 'following_id']::name[]
        )
      )
  ) THEN
    RAISE EXCEPTION 'unexpected unique edge authority exists';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.channel_members'::regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'public.chat_channels'::regclass
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'channel_id'
        )
      ]::smallint[]
      AND constraint_row.confkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.confrelid
            AND attribute.attname = 'id'
        )
      ]::smallint[]
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.channel_members'::regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.confrelid = 'auth.users'::regclass
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'user_id'
        )
      ]::smallint[]
      AND constraint_row.confkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.confrelid
            AND attribute.attname = 'id'
        )
      ]::smallint[]
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) <> 1 THEN
    RAISE EXCEPTION 'channel_members foreign-key authority is incompatible';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.channel_members'::regclass
  ) <> 5 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.channel_members'::regclass
      AND constraint_row.contype = 'f'
  ) <> 2 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.channel_members'::regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'id'
        )
      ]::smallint[]
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.channel_members'::regclass
      AND constraint_row.contype = 'u'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'channel_id'
        ),
        (
          SELECT attribute.attnum
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'user_id'
        )
      ]::smallint[]
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
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
  ) <> 1 THEN
    RAISE EXCEPTION 'channel_members constraint inventory is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.channel_members'::regclass
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'channel_members has an unexpected user trigger';
  END IF;

  -- Keep the base table on the 112100 server boundary. Channel creation still
  -- needs service-role INSERT, but no browser, PUBLIC, column-only or arbitrary
  -- role grant may bypass the route/RPC decision.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.channel_members'::regclass
      AND acl_entry.grantee <> relation.relowner
      AND (
        acl_entry.grantee <> v_service_oid
        OR acl_entry.privilege_type NOT IN (
          'SELECT',
          'INSERT',
          'UPDATE',
          'DELETE'
        )
        OR acl_entry.is_grantable
      )
  ) OR (
    SELECT pg_catalog.count(DISTINCT acl_entry.privilege_type)
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.channel_members'::regclass
      AND acl_entry.grantee = v_service_oid
      AND acl_entry.privilege_type IN (
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE'
      )
      AND NOT acl_entry.is_grantable
  ) <> 4 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      attribute.attacl
    ) AS acl_entry
    WHERE attribute.attrelid = 'public.channel_members'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres_oid
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.channel_members'::regclass
      AND policy.polname = 'Service role manages channel members'
      AND policy.polpermissive
      AND policy.polcmd = '*'
      AND policy.polroles = ARRAY[v_service_oid]::oid[]
      AND pg_catalog.pg_get_expr(policy.polqual, policy.polrelid) = 'true'
      AND pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid) = 'true'
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.channel_members'::regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'channel_members service-only table boundary drifted';
  END IF;

  IF v_pair_function IS NULL OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'serialize_direct_message_pair_edge'
  ) <> 1 THEN
    RAISE EXCEPTION
      'canonical atomic direct-message pair serializer must deploy first';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_pair_source
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_language AS language_row
    ON language_row.oid = function_row.prolang
  WHERE function_row.oid = v_pair_function
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
    ]::text[];

  IF v_pair_source IS NULL
     OR pg_catalog.strpos(v_pair_source, $$WHEN 'blocked_users' THEN$$) = 0
     OR pg_catalog.strpos(v_pair_source, $$WHEN 'user_follows' THEN$$) = 0
     OR pg_catalog.strpos(v_pair_source, 'pg_advisory_xact_lock') = 0
     OR pg_catalog.strpos(v_pair_source, 'ORDER BY affected_pair') = 0
     OR pg_catalog.strpos(
       v_pair_source,
       $$'direct-message:pair:' || v_pair$$
     ) = 0
     OR pg_catalog.strpos(
       v_pair_source,
       $$RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END$$
     ) = 0
  THEN
    RAISE EXCEPTION 'direct-message pair serializer body is incompatible';
  END IF;

  SELECT attribute.attnum INTO STRICT v_blocker_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.blocked_users'::regclass
    AND attribute.attname = 'blocker_id';
  SELECT attribute.attnum INTO STRICT v_blocked_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.blocked_users'::regclass
    AND attribute.attname = 'blocked_id';
  SELECT attribute.attnum INTO STRICT v_follower_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.user_follows'::regclass
    AND attribute.attname = 'follower_id';
  SELECT attribute.attnum INTO STRICT v_following_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.user_follows'::regclass
    AND attribute.attname = 'following_id';

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE NOT trigger_row.tgisinternal
      AND trigger_row.tgenabled = 'O'
      AND trigger_row.tgfoid = v_pair_function
      AND trigger_row.tgqual IS NULL
      AND trigger_row.tgtype = 31
      AND (
        (
          trigger_row.tgrelid = 'public.blocked_users'::regclass
          AND trigger_row.tgname = 'trg_serialize_dm_block_pair'
          AND ARRAY(
            SELECT affected_column.attnum
            FROM pg_catalog.unnest(trigger_row.tgattr)
              WITH ORDINALITY AS affected_column(attnum, ordinality)
            ORDER BY affected_column.ordinality
          )::smallint[] = ARRAY[v_blocker_attnum, v_blocked_attnum]::smallint[]
        ) OR (
          trigger_row.tgrelid = 'public.user_follows'::regclass
          AND trigger_row.tgname = 'trg_serialize_dm_follow_pair'
          AND ARRAY(
            SELECT affected_column.attnum
            FROM pg_catalog.unnest(trigger_row.tgattr)
              WITH ORDINALITY AS affected_column(attnum, ordinality)
            ORDER BY affected_column.ordinality
          )::smallint[] = ARRAY[v_follower_attnum, v_following_attnum]::smallint[]
        )
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'block/follow pair serializer trigger contract failed';
  END IF;

  IF v_post_block_function IS NULL OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'serialize_post_audience_block_edge'
  ) <> 1 THEN
    RAISE EXCEPTION 'canonical post block serializer must deploy first';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_post_block_source
  FROM pg_catalog.pg_proc AS function_row
  JOIN pg_catalog.pg_language AS language_row
    ON language_row.oid = function_row.prolang
  WHERE function_row.oid = v_post_block_function
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
    AND function_row.proconfig =
      ARRAY['search_path=pg_catalog, pg_temp']::text[];

  IF v_post_block_source IS NULL
     OR pg_catalog.strpos(
       v_post_block_source,
       $$TG_OP IN ('UPDATE', 'DELETE')$$
     ) = 0
     OR pg_catalog.strpos(
       v_post_block_source,
       $$TG_OP IN ('INSERT', 'UPDATE')$$
     ) = 0
     OR pg_catalog.strpos(v_post_block_source, 'ORDER BY affected_pair') = 0
     OR pg_catalog.strpos(v_post_block_source, 'pg_advisory_xact_lock') = 0
     OR pg_catalog.strpos(
       v_post_block_source,
       $$'post-audience:block:' || v_pair$$
     ) = 0
     OR pg_catalog.strpos(
       v_post_block_source,
       $$RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END$$
     ) = 0
  THEN
    RAISE EXCEPTION 'post block serializer body is incompatible';
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
    WHERE trigger_row.tgrelid = 'public.blocked_users'::regclass
      AND trigger_row.tgname = 'trg_serialize_post_audience_block_edge'
      AND trigger_row.tgfoid = v_post_block_function
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 31
      AND trigger_row.tgqual IS NULL
      AND ARRAY(
        SELECT affected_column.attnum
        FROM pg_catalog.unnest(trigger_row.tgattr)
          WITH ORDINALITY AS affected_column(attnum, ordinality)
        ORDER BY affected_column.ordinality
      )::smallint[] = ARRAY[v_blocker_attnum, v_blocked_attnum]::smallint[]
  ) <> 1 OR (
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
    RAISE EXCEPTION 'block/follow trigger inventory is incompatible';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'add_channel_members_atomic'
      AND pg_catalog.pg_get_function_identity_arguments(function_row.oid)
        <> 'p_channel_id uuid, p_actor_id uuid, p_candidate_ids uuid[]'
  ) THEN
    RAISE EXCEPTION 'incompatible add_channel_members_atomic overload exists';
  END IF;

  IF pg_catalog.to_regprocedure(
    'public.add_channel_members_atomic(uuid,uuid,uuid[])'
  ) IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure(
      'public.add_channel_members_atomic(uuid,uuid,uuid[])'
    )
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::regtype
      AND NOT function_row.proretset
  ) THEN
    RAISE EXCEPTION 'existing add_channel_members_atomic signature is incompatible';
  END IF;
END
$preflight$;

-- Freeze every validated dependency for the remainder of this short DDL
-- transaction. SHARE blocks concurrent DML/trigger or constraint rewrites, so
-- the postflight cannot certify a different catalog from the preflight.
LOCK TABLE
  public.chat_channels,
  auth.users,
  public.channel_members,
  public.user_profiles,
  public.blocked_users,
  public.user_follows
IN SHARE MODE;

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
  v_actor_role text;
  v_candidate_ids uuid[] := ARRAY[]::uuid[];
  v_observed_roster_ids uuid[] := ARRAY[]::uuid[];
  v_lock_participant_ids uuid[] := ARRAY[]::uuid[];
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

  -- The channel key is always first. The parent row then blocks concurrent
  -- channel deletion and new FK inserts while parent identities and the
  -- existing child roster are reconciled below.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'channel-membership:channel:' || p_channel_id::text,
      0
    )
  );

  SELECT channel_row.type
  INTO v_channel_type
  FROM public.chat_channels AS channel_row
  WHERE channel_row.id = p_channel_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CHANNEL_NOT_FOUND'
    );
  END IF;

  IF v_channel_type IS DISTINCT FROM 'group' THEN
    RETURN pg_catalog.jsonb_build_object(
      'success', false,
      'reason', 'CHANNEL_NOT_GROUP'
    );
  END IF;

  -- Observe, but do not row-lock, the bounded roster. Holding the channel
  -- parent prevents a new channel FK edge from committing. Existing child
  -- DELETE/UPDATE may still finish, so this is only the upper bound used to
  -- acquire auth parents before child rows.
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

  SELECT pg_catalog.array_agg(participant_id ORDER BY participant_id)
  INTO STRICT v_lock_participant_ids
  FROM (
    SELECT roster_id AS participant_id
    FROM pg_catalog.unnest(v_observed_roster_ids) AS roster(roster_id)
    UNION
    SELECT candidate_id AS participant_id
    FROM pg_catalog.unnest(v_candidate_ids) AS candidate(candidate_id)
  ) AS participant;

  -- Auth parents must be locked before channel_members children. Auth hard
  -- deletion locks auth.users first and then cascades to channel_members; the
  -- opposite order here would create a parent/child deadlock. Missing auth
  -- identities are recorded and fail closed after the roster is reconciled.
  FOR v_user_id IN
    SELECT auth_user.id
    FROM auth.users AS auth_user
    WHERE auth_user.id = ANY(v_lock_participant_ids)
    ORDER BY auth_user.id
    FOR SHARE
  LOOP
    v_auth_user_ids := pg_catalog.array_append(v_auth_user_ids, v_user_id);
  END LOOP;

  -- Re-read and row-lock the current roster after all possible auth parents.
  -- The channel parent rules out new FK inserts, so a legitimate concurrent
  -- child DELETE can only shrink the observed set. A changed user_id would
  -- introduce a parent/pair that was not necessarily locked; reject it as a
  -- serialization conflict instead of extending the lock set out of order.
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

  -- Share the exact unordered-pair key used by block and follow mutation
  -- triggers. Auth parents are already stable and final roster children are
  -- locked, so an Auth cascade cannot hold a parent while waiting on a pair
  -- owned here. Locks remain deterministic and close the privacy check/write
  -- window against concurrent block or mutual-follow changes.
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
          -- NULL, none and any future/legacy unknown preference fail closed.
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

DO $converge_acl_and_attest$
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
    'atomic-existing-channel-member-add:v1:' || pg_catalog.md5(v_source)
  );
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.add_channel_members_atomic(uuid,uuid,uuid[])'::regprocedure;
  v_pair_function regprocedure :=
    'public.serialize_direct_message_pair_edge()'::regprocedure;
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
    WHERE function_row.oid = v_function
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
        'atomic-existing-channel-member-add:v1:'
          || pg_catalog.md5(function_row.prosrc)
  ) THEN
    RAISE EXCEPTION 'atomic channel-member function metadata drifted';
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
    RAISE EXCEPTION 'atomic channel-member EXECUTE boundary drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function;

  IF pg_catalog.strpos(
       v_source,
       $$'channel-membership:channel:' || p_channel_id::text$$
     ) = 0
     OR pg_catalog.strpos(v_source, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(
       v_source,
       $$'direct-message:pair:'$$
     ) = 0
     OR pg_catalog.strpos(v_source, 'FROM auth.users AS auth_user') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_profiles AS profile') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.blocked_users AS block_edge') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.user_follows AS actor_follow') = 0
     OR pg_catalog.strpos(v_source, 'INSERT INTO public.channel_members') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.blocked_users AS block_edge') >
       pg_catalog.strpos(v_source, 'INSERT INTO public.channel_members')
  THEN
    RAISE EXCEPTION 'atomic channel-member behavior contract drifted';
  END IF;

  IF v_pair_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_pair_function
      AND function_row.prosecdef
      AND function_row.proowner = v_postgres_oid
      AND pg_catalog.strpos(
        function_row.prosrc,
        $$'direct-message:pair:' || v_pair$$
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'pg_advisory_xact_lock'
      ) > 0
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
  ) <> 2 THEN
    RAISE EXCEPTION 'atomic channel-member serializer dependency drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.channel_members'::regclass
      AND NOT trigger_row.tgisinternal
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
    RAISE EXCEPTION 'atomic channel-member relation authority drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
