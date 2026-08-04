-- Production attestation for
--   20260803101000_close_post_interaction_child_direct_writes.sql
--
-- Run through a direct PostgreSQL session as postgres after the migration is
-- visible in the production migration ledger. This script is read-only and
-- fails with ON_ERROR_STOP semantics on any missing core relation, browser
-- raw-write grant, broad identity policy, invalid emoji, or controlled-writer
-- ownership drift. post_reactions and comment_emoji_reactions are historical
-- optional relations: absent is safe; present must satisfy the full boundary.

\set ON_ERROR_STOP on

BEGIN TRANSACTION READ ONLY;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $attestation$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_authenticated_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_allowed text[] := ARRAY[
    '👍', '🔥', '💎', '🚀', '❤️', '👀',
    '🎯', '💰', '📈', '📉', '🤔', '😂'
  ]::text[];
  v_table text;
  v_relation regclass;
  v_policy record;
  v_policy_name text;
  v_role text;
  v_attribute record;
  v_required_column record;
  v_key record;
  v_auth_user_id_attnum smallint;
  v_user_id_attnum smallint;
  v_invalid bigint;
  v_constraint_name text;
  v_constraint_definition text;
  v_quarantine_constraint record;
  v_signature text;
  v_function regprocedure;
BEGIN
  IF v_postgres_oid IS NULL
     OR v_authenticated_oid IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticator'
     )
     OR NOT EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
     )
  THEN
    RAISE EXCEPTION 'required production roles are missing';
  END IF;

  IF NOT COALESCE(
    (
      SELECT role_row.rolbypassrls
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = 'service_role'
    ),
    false
  ) THEN
    RAISE EXCEPTION 'service_role must retain BYPASSRLS for server aggregate reads';
  END IF;
  IF COALESCE(
    (
      SELECT role_row.rolsuper
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = 'service_role'
    ),
    false
  ) THEN
    RAISE EXCEPTION
      'service_role must remain NOSUPERUSER despite its scoped BYPASSRLS authority';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname IN ('anon', 'authenticated', 'authenticator')
      AND (role_row.rolbypassrls OR role_row.rolsuper)
  ) THEN
    RAISE EXCEPTION
      'browser roles must remain NOSUPERUSER NOBYPASSRLS for own-only interaction reads';
  END IF;

  SELECT attribute.attnum
  INTO v_auth_user_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.atttypid = 'uuid'::pg_catalog.regtype
    AND attribute.attnotnull
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'canonical auth.users.id must be uuid NOT NULL';
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'post_likes',
    'post_votes',
    'post_bookmarks',
    'post_emoji_reactions',
    'poll_votes'
  ]::text[]
  LOOP
    IF pg_catalog.to_regclass('public.' || v_table) IS NULL THEN
      RAISE EXCEPTION 'required interaction relation is missing: public.%', v_table;
    END IF;
  END LOOP;

  FOR v_key IN
    SELECT *
    FROM (
      VALUES
        (
          'post_likes',
          ARRAY['post_id', 'user_id']::text[]
        ),
        (
          'post_votes',
          ARRAY['post_id', 'user_id']::text[]
        ),
        (
          'post_bookmarks',
          ARRAY['post_id', 'user_id']::text[]
        ),
        (
          'post_reactions',
          ARRAY['post_id', 'user_id']::text[]
        ),
        (
          'post_emoji_reactions',
          ARRAY['emoji', 'post_id', 'user_id']::text[]
        ),
        (
          'comment_emoji_reactions',
          ARRAY['comment_id', 'emoji', 'user_id']::text[]
        ),
        (
          'poll_votes',
          ARRAY['option_index', 'poll_id', 'user_id']::text[]
        )
    ) AS required_key(table_name, sorted_key_columns)
  LOOP
    v_relation := pg_catalog.to_regclass('public.' || v_key.table_name);
    CONTINUE WHEN v_relation IS NULL;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_index AS index_row
      WHERE index_row.indrelid = v_relation
        AND index_row.indisunique
        AND index_row.indisvalid
        AND index_row.indisready
        AND index_row.indpred IS NULL
        AND index_row.indexprs IS NULL
        AND index_row.indnkeyatts =
          pg_catalog.cardinality(v_key.sorted_key_columns)
        AND (
          SELECT pg_catalog.array_agg(
            attribute.attname::text ORDER BY attribute.attname
          )
          FROM pg_catalog.unnest(index_row.indkey)
            WITH ORDINALITY AS key_column(attnum, ordinality)
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = index_row.indrelid
           AND attribute.attnum = key_column.attnum
          WHERE key_column.ordinality <= index_row.indnkeyatts
        ) = v_key.sorted_key_columns
    ) THEN
      RAISE EXCEPTION 'public.% exact UNIQUE key drifted: %',
        v_key.table_name,
        v_key.sorted_key_columns;
    END IF;

  END LOOP;

  FOR v_required_column IN
    SELECT *
    FROM (
      VALUES
        ('post_likes', 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('post_votes', 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('post_bookmarks', 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('post_reactions', 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('post_emoji_reactions', 'id', 'uuid'::pg_catalog.regtype, true),
        ('post_emoji_reactions', 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('post_emoji_reactions', 'emoji', 'text'::pg_catalog.regtype, true),
        ('comment_emoji_reactions', 'id', 'uuid'::pg_catalog.regtype, true),
        ('comment_emoji_reactions', 'comment_id', 'uuid'::pg_catalog.regtype, true),
        ('comment_emoji_reactions', 'emoji', 'text'::pg_catalog.regtype, true),
        ('poll_votes', 'poll_id', 'uuid'::pg_catalog.regtype, true),
        ('poll_votes', 'option_index', 'integer'::pg_catalog.regtype, true)
    ) AS required_column(table_name, column_name, type_oid, required_not_null)
  LOOP
    v_relation := pg_catalog.to_regclass(
      'public.' || v_required_column.table_name
    );
    CONTINUE WHEN v_relation IS NULL;

    SELECT attribute.atttypid, attribute.attnotnull
    INTO v_attribute
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attname = v_required_column.column_name
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;

    IF NOT FOUND
       OR v_attribute.atttypid <> v_required_column.type_oid
       OR (
         v_required_column.required_not_null
         AND NOT v_attribute.attnotnull
       )
    THEN
      RAISE EXCEPTION 'public.%.% interaction key shape drifted',
        v_required_column.table_name,
        v_required_column.column_name;
    END IF;
  END LOOP;

  FOREACH v_table IN ARRAY ARRAY[
    'post_likes',
    'post_votes',
    'post_bookmarks',
    'post_reactions',
    'post_emoji_reactions',
    'comment_emoji_reactions',
    'poll_votes'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass('public.' || v_table);
    CONTINUE WHEN v_relation IS NULL;
    v_policy_name := v_table || '_select_own_canonical';

    SELECT attribute.attnum
    INTO v_user_id_attnum
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attname = 'user_id'
      AND attribute.atttypid = 'uuid'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'public.%.user_id must be uuid NOT NULL', v_table;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_relation
        AND constraint_row.contype = 'f'
        AND constraint_row.convalidated
        AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
        AND constraint_row.confdeltype = 'c'
        AND constraint_row.conkey = ARRAY[v_user_id_attnum]::smallint[]
        AND constraint_row.confkey =
          ARRAY[v_auth_user_id_attnum]::smallint[]
    ) THEN
      RAISE EXCEPTION
        'public.%.user_id auth.users(id) ON DELETE CASCADE authority drifted',
        v_table;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
        AND relation.relowner = v_postgres_oid
        AND relation.relrowsecurity
        AND NOT relation.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'public.% relation or RLS authority drifted', v_table;
    END IF;

    IF (
      SELECT pg_catalog.count(*)
      FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_relation
    ) <> 1 THEN
      RAISE EXCEPTION 'public.% must have exactly one policy', v_table;
    END IF;

    SELECT policy_row.polcmd,
           policy_row.polpermissive,
           policy_row.polroles,
           pg_catalog.pg_get_expr(
             policy_row.polqual,
             policy_row.polrelid,
             true
           ) AS qualifier,
           policy_row.polwithcheck
    INTO STRICT v_policy
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = v_relation
      AND policy_row.polname = v_policy_name;

    IF v_policy.polcmd IS DISTINCT FROM 'r'
       OR NOT v_policy.polpermissive
       OR v_policy.polroles IS DISTINCT FROM ARRAY[v_authenticated_oid]::oid[]
       OR v_policy.polwithcheck IS NOT NULL
       OR v_policy.qualifier IS DISTINCT FROM
         '(( SELECT auth.uid() AS uid)) = user_id'
    THEN
      RAISE EXCEPTION 'public.% own-only SELECT policy drifted: %',
        v_table,
        v_policy.qualifier;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_relation
        AND acl_entry.grantee = 0
        AND acl_entry.privilege_type IN (
          'SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE',
          'REFERENCES', 'TRIGGER'
        )
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee = 0
        AND acl_entry.privilege_type IN (
          'SELECT', 'INSERT', 'UPDATE', 'REFERENCES'
        )
    ) THEN
      RAISE EXCEPTION 'public.% remains exposed through PUBLIC ACLs', v_table;
    END IF;

    FOREACH v_role IN ARRAY ARRAY[
      'anon',
      'authenticated',
      'authenticator'
    ]::text[]
    LOOP
      IF pg_catalog.has_table_privilege(v_role, v_relation, 'INSERT')
         OR pg_catalog.has_table_privilege(v_role, v_relation, 'UPDATE')
         OR pg_catalog.has_table_privilege(v_role, v_relation, 'DELETE')
         OR pg_catalog.has_table_privilege(v_role, v_relation, 'TRUNCATE')
         OR pg_catalog.has_table_privilege(v_role, v_relation, 'REFERENCES')
         OR pg_catalog.has_table_privilege(v_role, v_relation, 'TRIGGER')
      THEN
        RAISE EXCEPTION 'public.% raw mutation remains exposed to %',
          v_table,
          v_role;
      END IF;

      FOR v_attribute IN
        SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_relation
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      LOOP
        IF pg_catalog.has_column_privilege(
             v_role, v_relation, v_attribute.attname, 'INSERT'
           )
           OR pg_catalog.has_column_privilege(
             v_role, v_relation, v_attribute.attname, 'UPDATE'
           )
           OR pg_catalog.has_column_privilege(
             v_role, v_relation, v_attribute.attname, 'REFERENCES'
           )
        THEN
          RAISE EXCEPTION 'public.%.% column mutation remains exposed to %',
            v_table,
            v_attribute.attname,
            v_role;
        END IF;
      END LOOP;
    END LOOP;

    IF NOT pg_catalog.has_table_privilege('authenticated', v_relation, 'SELECT')
       OR pg_catalog.has_table_privilege('anon', v_relation, 'SELECT')
       OR pg_catalog.has_table_privilege('authenticator', v_relation, 'SELECT')
       OR NOT pg_catalog.has_table_privilege('service_role', v_relation, 'SELECT')
    THEN
      RAISE EXCEPTION 'public.% read ACL drifted', v_table;
    END IF;
  END LOOP;

  FOREACH v_table IN ARRAY ARRAY[
    'post_emoji_reactions',
    'comment_emoji_reactions'
  ]::text[]
  LOOP
    v_relation := pg_catalog.to_regclass('public.' || v_table);
    CONTINUE WHEN v_relation IS NULL;
    v_constraint_name := v_table || '_emoji_allowlist_check';

    SELECT pg_catalog.pg_get_expr(
             constraint_row.conbin,
             constraint_row.conrelid,
             true
           )
    INTO STRICT v_constraint_definition
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_relation
      AND constraint_row.conname = v_constraint_name
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated;

    IF v_constraint_definition IS DISTINCT FROM
      'emoji = ANY (''{👍,🔥,💎,🚀,❤️,👀,🎯,💰,📈,📉,🤔,😂}''::text[])'
    THEN
      RAISE EXCEPTION 'public.% emoji allowlist definition drifted: %',
        v_table,
        v_constraint_definition;
    END IF;

    EXECUTE pg_catalog.format(
      'SELECT pg_catalog.count(*)
       FROM public.%I AS reaction
       WHERE reaction.emoji IS NULL
          OR NOT (reaction.emoji = ANY ($1))',
      v_table
    )
    INTO v_invalid
    USING v_allowed;
    IF v_invalid <> 0 THEN
      RAISE EXCEPTION 'public.% contains % unsupported emoji rows',
        v_table,
        v_invalid;
    END IF;
  END LOOP;

  v_relation := pg_catalog.to_regclass(
    'public.interaction_emoji_reaction_quarantine'
  );

  IF v_relation IS NOT NULL THEN
    SELECT attribute.attnum
    INTO v_user_id_attnum
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_relation
      AND attribute.attname = 'user_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;
  END IF;

  IF v_relation IS NULL
     OR v_user_id_attnum IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = v_relation
         AND relation.relkind = 'r'
         AND relation.relpersistence = 'p'
         AND NOT relation.relispartition
         AND relation.relowner = v_postgres_oid
         AND relation.relrowsecurity
         AND NOT relation.relforcerowsecurity
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = v_relation
         AND constraint_row.conname =
           'interaction_emoji_reaction_quarantine_pkey'
         AND constraint_row.contype = 'p'
         AND pg_catalog.strpos(
           pg_catalog.pg_get_constraintdef(constraint_row.oid, true),
           '(source_table, source_id, payload_fingerprint)'
         ) > 0
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_constraint AS constraint_row
       WHERE constraint_row.conrelid = v_relation
         AND constraint_row.conname =
           'interaction_emoji_reaction_quarantine_user_id_fkey'
         AND constraint_row.contype = 'f'
         AND constraint_row.confrelid = 'auth.users'::regclass
         AND constraint_row.confdeltype = 'c'
         AND constraint_row.convalidated
         AND constraint_row.conkey = ARRAY[v_user_id_attnum]::smallint[]
         AND constraint_row.confkey =
           ARRAY[v_auth_user_id_attnum]::smallint[]
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_policy AS policy_row
       WHERE policy_row.polrelid = v_relation
     )
     OR EXISTS (
       SELECT 1
       FROM public.interaction_emoji_reaction_quarantine AS evidence
       WHERE evidence.payload_fingerprint IS DISTINCT FROM
         pg_catalog.md5(evidence.payload::text)
          OR evidence.source_id::text IS DISTINCT FROM evidence.payload->>'id'
          OR evidence.user_id::text IS DISTINCT FROM evidence.payload->>'user_id'
          OR evidence.reason IS DISTINCT FROM 'unsupported_emoji'
     )
  THEN
    RAISE EXCEPTION 'server-only emoji quarantine authority drifted';
  END IF;

  FOR v_quarantine_constraint IN
    SELECT *
    FROM (
      VALUES
        (
          'interaction_emoji_reaction_quarantine_source_check',
          'source_table = ANY (ARRAY[''post_emoji_reactions''::text, ''comment_emoji_reactions''::text])'
        ),
        (
          'interaction_emoji_reaction_quarantine_reason_check',
          'reason = ''unsupported_emoji''::text'
        ),
        (
          'interaction_emoji_reaction_quarantine_fingerprint_check',
          'payload_fingerprint ~ ''^[0-9a-f]{32}$''::text'
        )
    ) AS required_constraint(constraint_name, expected_expression)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_relation
        AND constraint_row.conname =
          v_quarantine_constraint.constraint_name
        AND constraint_row.contype = 'c'
        AND constraint_row.convalidated
        AND pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid,
          true
        ) = v_quarantine_constraint.expected_expression
    ) THEN
      RAISE EXCEPTION 'server-only emoji quarantine CHECK drifted: %',
        v_quarantine_constraint.constraint_name;
    END IF;
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
    WHERE relation.oid = v_relation
      AND (
        acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
        OR (
          acl_entry.grantee = v_service_oid
          AND acl_entry.privilege_type <> 'SELECT'
        )
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_relation
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION
      'server-only emoji quarantine has noncanonical direct table/column ACL drift';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'authenticator',
    'service_role'
  ]::text[]
  LOOP
    IF pg_catalog.has_table_privilege(v_role, v_relation, 'INSERT')
       OR pg_catalog.has_table_privilege(v_role, v_relation, 'UPDATE')
       OR pg_catalog.has_table_privilege(v_role, v_relation, 'DELETE')
       OR pg_catalog.has_table_privilege(v_role, v_relation, 'TRUNCATE')
       OR pg_catalog.has_table_privilege(v_role, v_relation, 'REFERENCES')
       OR pg_catalog.has_table_privilege(v_role, v_relation, 'TRIGGER')
       OR (
         v_role <> 'service_role'
         AND pg_catalog.has_table_privilege(v_role, v_relation, 'SELECT')
       )
       OR (
         v_role = 'service_role'
         AND NOT pg_catalog.has_table_privilege(v_role, v_relation, 'SELECT')
       )
    THEN
      RAISE EXCEPTION 'server-only emoji quarantine table ACL drifted for %',
        v_role;
    END IF;

    FOR v_attribute IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    LOOP
      IF pg_catalog.has_column_privilege(
           v_role, v_relation, v_attribute.attname, 'INSERT'
         )
         OR pg_catalog.has_column_privilege(
           v_role, v_relation, v_attribute.attname, 'UPDATE'
         )
         OR pg_catalog.has_column_privilege(
           v_role, v_relation, v_attribute.attname, 'REFERENCES'
         )
         OR (
           v_role <> 'service_role'
           AND pg_catalog.has_column_privilege(
             v_role, v_relation, v_attribute.attname, 'SELECT'
           )
         )
      THEN
        RAISE EXCEPTION 'server-only emoji quarantine column %.% ACL drifted for %',
          'interaction_emoji_reaction_quarantine',
          v_attribute.attname,
          v_role;
      END IF;
    END LOOP;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.toggle_post_reaction(uuid,uuid,text)',
    'public.toggle_post_vote_atomic(uuid,uuid,text)',
    'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)',
    'public.toggle_post_emoji_reaction_atomic(uuid,uuid,text)',
    'public.cast_post_poll_vote_atomic(uuid,uuid,integer[])',
    'public.cast_post_poll_vote_expected_atomic(uuid,uuid,uuid,integer[])'
  ]::text[]
  LOOP
    v_function := pg_catalog.to_regprocedure(v_signature);
    IF v_function IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND function_row.prokind = 'f'
        AND function_row.proowner = v_postgres_oid
        AND function_row.prosecdef
        AND COALESCE(
          function_row.proconfig,
          ARRAY[]::text[]
        ) @> ARRAY['search_path=pg_catalog, pg_temp']::text[]
    ) OR NOT pg_catalog.has_function_privilege(
      'service_role', v_function, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon', v_function, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticated', v_function, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticator', v_function, 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'service controlled writer ACL drifted: %', v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.save_post_bookmark_to_folder_atomic(uuid,uuid)',
    'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'
  ]::text[]
  LOOP
    v_function := pg_catalog.to_regprocedure(v_signature);
    IF v_function IS NULL OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_function
        AND function_row.prokind = 'f'
        AND function_row.proowner = v_postgres_oid
        AND function_row.prosecdef
        AND COALESCE(
          function_row.proconfig,
          ARRAY[]::text[]
        ) @> ARRAY['search_path=pg_catalog, pg_temp']::text[]
    ) OR NOT pg_catalog.has_function_privilege(
      'authenticated', v_function, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'anon', v_function, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'authenticator', v_function, 'EXECUTE'
    ) OR pg_catalog.has_function_privilege(
      'service_role', v_function, 'EXECUTE'
    ) THEN
      RAISE EXCEPTION 'authenticated controlled writer ACL drifted: %', v_signature;
    END IF;
  END LOOP;

  RAISE NOTICE 'post interaction child boundary production attestation passed';
  RAISE NOTICE 'historical cached-count parity is outside this boundary attestation';
END
$attestation$;

SELECT target.table_name,
       CASE
         WHEN pg_catalog.to_regclass('public.' || target.table_name) IS NULL
           THEN 'absent_safe'
         ELSE 'closed_own_select_only'
       END AS boundary_status
FROM pg_catalog.unnest(
  ARRAY[
    'post_likes',
    'post_votes',
    'post_bookmarks',
    'post_reactions',
    'post_emoji_reactions',
    'comment_emoji_reactions',
    'poll_votes'
  ]::text[]
) AS target(table_name)
ORDER BY target.table_name;

SELECT source_table,
       pg_catalog.count(*) AS quarantined_row_count,
       pg_catalog.min(quarantined_at) AS first_quarantined_at,
       pg_catalog.max(quarantined_at) AS last_quarantined_at
FROM public.interaction_emoji_reaction_quarantine
GROUP BY source_table
ORDER BY source_table;

COMMIT;
