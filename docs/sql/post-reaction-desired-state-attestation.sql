-- Read-only production attestation for
-- 20260803102000_set_post_reaction_desired_state.sql.
-- Run with a catalog-visible maintenance role after the migration.

BEGIN;
SET TRANSACTION READ ONLY;
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
  v_service_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'service_role'
  );
  v_authenticated_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'authenticated'
  );
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_missing_roles text[];
  v_relation regclass;
  v_required_column record;
  v_attribute record;
  v_auth_user_id_attnum smallint;
  v_posts_id_attnum smallint;
  v_post_likes_id_attnum smallint;
  v_post_likes_post_id_attnum smallint;
  v_post_likes_user_id_attnum smallint;
  v_constraint_definition text;
  v_id_default text;
  v_policy record;
  v_audience_function regprocedure := pg_catalog.to_regprocedure(
    'public.lock_actor_can_interact_with_post(uuid,uuid)'
  );
  v_audience_source text;
  v_expected record;
  v_function regprocedure;
  v_source text;
  v_comment text;
  v_post_lock integer;
  v_actor_lock integer;
  v_account_lock integer;
  v_audience_lock integer;
  v_child_lock integer;
  v_count integer;
  v_post_update integer;
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY[
      'anon',
      'authenticated',
      'authenticator',
      'service_role',
      'postgres'
    ]::text[]
  ) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL
     OR v_postgres_oid IS NULL
     OR v_service_oid IS NULL
     OR v_authenticated_oid IS NULL
     OR v_plpgsql_oid IS NULL
  THEN
    RAISE EXCEPTION 'post reaction desired-state roles are missing: %',
      v_missing_roles;
  END IF;

  IF NOT COALESCE(
       (
         SELECT role_row.rolbypassrls AND NOT role_row.rolsuper
         FROM pg_catalog.pg_roles AS role_row
         WHERE role_row.rolname = 'service_role'
       ),
       false
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_roles AS role_row
       WHERE role_row.rolname IN ('anon', 'authenticated', 'authenticator')
         AND (role_row.rolbypassrls OR role_row.rolsuper)
     )
  THEN
    RAISE EXCEPTION 'post reaction desired-state role authority drifted';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regprocedure('auth.uid()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.post_likes') IS NULL
     OR pg_catalog.to_regclass(
       'public.interaction_emoji_reaction_quarantine'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.lock_actor_can_interact_with_post(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.lock_post_interaction_block_edges(uuid,uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.lock_actor_can_interact_with_post_locked_impl(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL
  THEN
    RAISE EXCEPTION
      'post reaction desired-state dependency chain is incomplete';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.posts'::pg_catalog.regclass,
    'public.post_likes'::pg_catalog.regclass,
    'public.interaction_emoji_reaction_quarantine'::pg_catalog.regclass
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
        AND relation.relowner = v_postgres_oid
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
         OR inheritance.inhparent = v_relation
    ) THEN
      RAISE EXCEPTION
        'post reaction desired-state relation shape drifted: %',
        v_relation;
    END IF;
  END LOOP;

  FOR v_required_column IN
    SELECT *
    FROM (
      VALUES
        ('posts', 'id', 'uuid'::pg_catalog.regtype, true),
        ('posts', 'like_count', 'integer'::pg_catalog.regtype, false),
        ('posts', 'dislike_count', 'integer'::pg_catalog.regtype, false),
        ('post_likes', 'id', 'uuid'::pg_catalog.regtype, true),
        ('post_likes', 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('post_likes', 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('post_likes', 'reaction_type', 'text'::pg_catalog.regtype, false)
    ) AS required_column(table_name, column_name, type_oid, required_not_null)
  LOOP
    SELECT attribute.attnum,
           attribute.atttypid,
           attribute.attnotnull
    INTO v_attribute
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = pg_catalog.to_regclass(
      'public.' || v_required_column.table_name
    )
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
      RAISE EXCEPTION 'public.%.% shape drifted',
        v_required_column.table_name,
        v_required_column.column_name;
    END IF;
  END LOOP;

  SELECT attribute.attnum
  INTO STRICT v_auth_user_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'auth.users'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.atttypid = 'uuid'::pg_catalog.regtype
    AND attribute.attnotnull
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_posts_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.posts'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_post_likes_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.post_likes'::pg_catalog.regclass
    AND attribute.attname = 'id'
    AND attribute.atttypid = 'uuid'::pg_catalog.regtype
    AND attribute.attnotnull
    AND attribute.attidentity = ''
    AND attribute.attgenerated = ''
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_post_likes_post_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.post_likes'::pg_catalog.regclass
    AND attribute.attname = 'post_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_post_likes_user_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.post_likes'::pg_catalog.regclass
    AND attribute.attname = 'user_id'
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.post_likes'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND constraint_row.conkey = ARRAY[v_post_likes_id_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION 'post_likes exact PRIMARY KEY (id) authority drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.post_likes'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 2
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname::text ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
        WHERE key_column.ordinality <= index_row.indnkeyatts
      ) = ARRAY['post_id', 'user_id']::text[]
  ) THEN
    RAISE EXCEPTION
      'post_likes exact UNIQUE (post_id, user_id) authority drifted';
  END IF;

  SELECT pg_catalog.pg_get_expr(
           default_row.adbin,
           default_row.adrelid,
           true
         )
  INTO STRICT v_id_default
  FROM pg_catalog.pg_attrdef AS default_row
  WHERE default_row.adrelid = 'public.post_likes'::pg_catalog.regclass
    AND default_row.adnum = v_post_likes_id_attnum;

  IF v_id_default IS DISTINCT FROM 'gen_random_uuid()' THEN
    RAISE EXCEPTION 'post_likes.id default authority drifted: %',
      v_id_default;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.post_likes'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.convalidated
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.confrelid = 'public.posts'::pg_catalog.regclass
      AND constraint_row.conkey =
        ARRAY[v_post_likes_post_id_attnum]::smallint[]
      AND constraint_row.confkey = ARRAY[v_posts_id_attnum]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.post_likes'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.convalidated
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.conkey =
        ARRAY[v_post_likes_user_id_attnum]::smallint[]
      AND constraint_row.confkey = ARRAY[v_auth_user_id_attnum]::smallint[]
  ) THEN
    RAISE EXCEPTION 'post_likes canonical cascade foreign keys drifted';
  END IF;

  SELECT pg_catalog.pg_get_expr(
           constraint_row.conbin,
           constraint_row.conrelid,
           true
         )
  INTO STRICT v_constraint_definition
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid = 'public.post_likes'::pg_catalog.regclass
    AND constraint_row.conname =
      'post_likes_reaction_type_desired_state_check'
    AND constraint_row.contype = 'c'
    AND constraint_row.convalidated;

  IF v_constraint_definition IS DISTINCT FROM
    'reaction_type IS NOT NULL AND (reaction_type = ANY (''{up,down}''::text[]))'
     OR EXISTS (
       SELECT 1
       FROM public.post_likes AS reaction
       WHERE reaction.reaction_type IS NULL
          OR reaction.reaction_type NOT IN ('up', 'down')
     )
  THEN
    RAISE EXCEPTION 'post reaction desired-state domain drifted: %',
      v_constraint_definition;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'public.post_likes'::pg_catalog.regclass
      AND relation.relrowsecurity
      AND NOT relation.relforcerowsecurity
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = 'public.post_likes'::pg_catalog.regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'post_likes RLS boundary drifted';
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
  WHERE policy_row.polrelid = 'public.post_likes'::pg_catalog.regclass
    AND policy_row.polname = 'post_likes_select_own_canonical';

  IF v_policy.polcmd IS DISTINCT FROM 'r'
     OR NOT v_policy.polpermissive
     OR v_policy.polroles IS DISTINCT FROM ARRAY[v_authenticated_oid]::oid[]
     OR v_policy.polwithcheck IS NOT NULL
     OR v_policy.qualifier IS DISTINCT FROM
       '(( SELECT auth.uid() AS uid)) = user_id'
     OR NOT pg_catalog.has_table_privilege(
       'authenticated', 'public.post_likes', 'SELECT'
     )
     OR pg_catalog.has_table_privilege('anon', 'public.post_likes', 'SELECT')
     OR pg_catalog.has_table_privilege(
       'authenticator', 'public.post_likes', 'SELECT'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.unnest(
         ARRAY['anon', 'authenticated', 'authenticator']::text[]
       ) AS browser_role(role_name)
       CROSS JOIN pg_catalog.unnest(
         ARRAY[
           'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
         ]::text[]
       ) AS mutation(privilege_name)
       WHERE pg_catalog.has_table_privilege(
         browser_role.role_name,
         'public.post_likes',
         mutation.privilege_name
       )
     )
  THEN
    RAISE EXCEPTION 'post_likes own-read/browser-write boundary drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_audience_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_audience_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'boolean'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 2
    AND function_row.pronargdefaults = 0
    AND function_row.proargnames = ARRAY['p_post_id', 'p_actor_id']::text[]
    AND pg_catalog.cardinality(function_row.proconfig) = 2
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF pg_catalog.strpos(
       v_audience_source,
       'public.lock_post_interaction_block_edges'
     ) = 0
     OR pg_catalog.strpos(
       v_audience_source,
       'public.lock_actor_can_interact_with_post_locked_impl'
     ) <= pg_catalog.strpos(
       v_audience_source,
       'public.lock_post_interaction_block_edges'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid IN (
         v_audience_function,
         'public.lock_post_interaction_block_edges(uuid,uuid,uuid)'::regprocedure,
         'public.lock_actor_can_interact_with_post_locked_impl(uuid,uuid)'::regprocedure
       )
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee <> v_postgres_oid
     )
     OR NOT EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid =
         'public.lock_actor_can_interact_with_post_locked_impl(uuid,uuid)'::regprocedure
         AND function_row.prokind = 'f'
         AND function_row.prorettype = 'boolean'::pg_catalog.regtype
         AND NOT function_row.proretset
         AND function_row.proowner = v_postgres_oid
         AND function_row.prosecdef
         AND function_row.provolatile = 'v'
         AND function_row.prolang = v_plpgsql_oid
         AND NOT function_row.proisstrict
         AND function_row.proparallel = 'u'
         AND NOT function_row.proleakproof
         AND pg_catalog.cardinality(function_row.proconfig) = 1
         AND function_row.proconfig =
           ARRAY['search_path=pg_catalog, pg_temp']::text[]
         AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
           'atomic-comment-block-authorization:v1:'
             || pg_catalog.md5(function_row.prosrc)
     )
  THEN
    RAISE EXCEPTION
      'canonical post audience wrapper, digest, or internal-only ACL drifted';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.toggle_post_reaction(uuid,uuid,text)',
          ARRAY['p_post_id', 'p_user_id', 'p_reaction_type']::text[],
          1,
          'post-reaction-desired-state:legacy-v2:'
        ),
        (
          'public.set_post_reaction_desired_state_atomic(uuid,uuid,text)',
          ARRAY['p_actor_id', 'p_post_id', 'p_desired_reaction']::text[],
          0,
          'post-reaction-desired-state:v1:'
        )
    ) AS expected(signature, argument_names, default_count, comment_prefix)
  LOOP
    v_function := pg_catalog.to_regprocedure(v_expected.signature);
    IF v_function IS NULL THEN
      RAISE EXCEPTION 'post reaction function is missing: %',
        v_expected.signature;
    END IF;

    SELECT function_row.prosrc,
           pg_catalog.obj_description(function_row.oid, 'pg_proc')
    INTO STRICT v_source, v_comment
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prolang = v_plpgsql_oid
      AND NOT function_row.proisstrict
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.pronargs = 3
      AND function_row.pronargdefaults = v_expected.default_count
      AND function_row.proargnames = v_expected.argument_names
      AND pg_catalog.cardinality(function_row.proconfig) = 4
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
        'lock_timeout=5s',
        'statement_timeout=15s'
      ]::text[];

    v_post_lock := pg_catalog.strpos(v_source, '''post-reaction-counts:''');
    v_actor_lock := pg_catalog.strpos(v_source, '''post-reaction:''');
    v_account_lock := pg_catalog.strpos(v_source, 'FROM auth.users');
    v_audience_lock := pg_catalog.strpos(
      v_source,
      'public.lock_actor_can_interact_with_post'
    );
    v_child_lock := pg_catalog.strpos(
      v_source,
      'FROM public.post_likes AS reaction'
    );
    v_count := pg_catalog.strpos(v_source, 'count(*) FILTER');
    v_post_update := pg_catalog.strpos(v_source, 'UPDATE public.posts');

    IF v_comment IS DISTINCT FROM
         v_expected.comment_prefix || pg_catalog.md5(v_source)
       OR v_post_lock = 0
       OR v_actor_lock <= v_post_lock
       OR v_account_lock <= v_actor_lock
       OR v_audience_lock <= v_account_lock
       OR v_child_lock <= v_audience_lock
       OR v_count <= v_child_lock
       OR v_post_update <= v_count
       OR NOT pg_catalog.has_function_privilege(
         'service_role', v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticated', v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege(
         'authenticator', v_function, 'EXECUTE'
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS acl_entry
         WHERE function_row.oid = v_function
           AND acl_entry.privilege_type = 'EXECUTE'
           AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS acl_entry
         WHERE function_row.oid = v_function
           AND acl_entry.privilege_type = 'EXECUTE'
           AND acl_entry.grantee = v_service_oid
           AND acl_entry.is_grantable
       )
    THEN
      RAISE EXCEPTION 'post reaction authority drifted: %',
        v_expected.signature;
    END IF;
  END LOOP;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.set_post_reaction_desired_state_atomic(uuid,uuid,text)'::regprocedure;

  IF pg_catalog.strpos(v_source, 'p_desired_reaction IS NULL') = 0
     OR pg_catalog.strpos(v_source, 'v_action := ''added''') = 0
     OR pg_catalog.strpos(v_source, 'v_action := ''removed''') = 0
     OR pg_catalog.strpos(v_source, 'v_action := ''changed''') = 0
     OR pg_catalog.strpos(v_source, 'v_action := ''unchanged''') = 0
     OR pg_catalog.strpos(v_source, '''status'', ''invalid''') = 0
     OR pg_catalog.strpos(v_source, '''status'', ''not_found''') = 0
     OR pg_catalog.strpos(v_source, '''reaction'', v_final_reaction') = 0
     OR pg_catalog.strpos(v_source, '''like_count'', v_returned_like_count') = 0
     OR pg_catalog.strpos(
       v_source,
       '''dislike_count'', v_returned_dislike_count'
     ) = 0
     OR pg_catalog.strpos(v_source, 'pg_catalog.gen_random_uuid()') = 0
     OR pg_catalog.strpos(v_source, 'reaction.post_id = p_post_id') = 0
     OR pg_catalog.strpos(v_source, 'reaction.user_id = p_actor_id') = 0
  THEN
    RAISE EXCEPTION
      'desired-state idempotency or acknowledgement contract drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.toggle_post_reaction(uuid,uuid,text)'::regprocedure;

  IF pg_catalog.strpos(v_source, 'v_action := ''removed''') = 0
     OR pg_catalog.strpos(v_source, 'v_action := ''added''') = 0
     OR pg_catalog.strpos(v_source, 'v_action := ''changed''') = 0
     OR pg_catalog.strpos(v_source, 'pg_catalog.gen_random_uuid()') = 0
     OR pg_catalog.strpos(v_source, 'reaction.post_id = p_post_id') = 0
     OR pg_catalog.strpos(v_source, 'reaction.user_id = p_user_id') = 0
  THEN
    RAISE EXCEPTION 'legacy toggle compatibility drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'toggle_post_reaction'
  ) <> 1 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'set_post_reaction_desired_state_atomic'
  ) <> 1 THEN
    RAISE EXCEPTION 'post reaction authority overload cardinality drifted';
  END IF;

  RAISE WARNING
    'P1 RELEASE GATE: account hard-delete cascades remain outside the post-wide counter advisory domain; do not claim global cached-counter closure';
  RAISE NOTICE
    'post reaction desired-state production attestation passed (scoped RPC authority only)';
END
$attestation$;

SELECT reaction.reaction_type,
       pg_catalog.count(*) AS source_row_count
FROM public.post_likes AS reaction
GROUP BY reaction.reaction_type
ORDER BY reaction.reaction_type;

ROLLBACK;
