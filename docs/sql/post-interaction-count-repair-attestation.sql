-- Read-only production attestation for
-- 20260803104000_durable_post_interaction_count_repair.sql and
-- 20260803104500_close_hot_score_batch_public_execute.sql and
-- 20260803105000_bind_bookmark_count_consistency.sql.
-- Run with a catalog-visible maintenance role after the repair worker has
-- drained the migration backfill. A queue item older than fifteen minutes or any
-- mismatch between the six cached counters and canonical child rows fails.

BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $attestation$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
  v_service_oid oid := pg_catalog.to_regrole('service_role');
  v_authenticated_oid oid := pg_catalog.to_regrole('authenticated');
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_queue regclass := pg_catalog.to_regclass(
    'public.post_interaction_count_repair_queue'
  );
  v_enqueue_function regprocedure := pg_catalog.to_regprocedure(
    'public.enqueue_post_interaction_count_repair()'
  );
  v_repair_function regprocedure := pg_catalog.to_regprocedure(
    'public.repair_post_interaction_counts_atomic(integer)'
  );
  v_missing_roles text[];
  v_function regprocedure;
  v_source text;
  v_comment text;
  v_expected record;
  v_trigger record;
  v_post_lock_position integer;
  v_actor_lock_position integer;
  v_account_lock_position integer;
  v_auth_lock_position integer;
  v_profile_lock_position integer;
  v_audience_lock_position integer;
  v_folder_lock_position integer;
  v_child_lock_position integer;
  v_post_row_lock_position integer;
  v_queue_lock_position integer;
  v_queue_delete_position integer;
  v_count_position integer;
  v_post_update_position integer;
  v_backlog_count bigint;
  v_due_backlog_count bigint;
  v_oldest_enqueued_at timestamptz;
  v_oldest_age interval;
  v_max_attempt_count integer;
  v_like_drift_count bigint;
  v_dislike_drift_count bigint;
  v_bull_drift_count bigint;
  v_bear_drift_count bigint;
  v_wait_drift_count bigint;
  v_bookmark_drift_count bigint;
  v_drift_post_count bigint;
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
  WHERE pg_catalog.to_regrole(required_role) IS NULL;

  IF v_missing_roles IS NOT NULL
     OR v_postgres_oid IS NULL
     OR v_service_oid IS NULL
     OR v_authenticated_oid IS NULL
     OR v_plpgsql_oid IS NULL
  THEN
    RAISE EXCEPTION
      'post interaction repair attestation roles/language are missing: %',
      v_missing_roles;
  END IF;

  IF v_queue IS NULL
     OR v_enqueue_function IS NULL
     OR v_repair_function IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.post_likes') IS NULL
     OR pg_catalog.to_regclass('public.post_votes') IS NULL
     OR pg_catalog.to_regclass('public.post_bookmarks') IS NULL
     OR pg_catalog.to_regclass('public.bookmark_folders') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.save_post_bookmark_to_folder_atomic(uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'
     ) IS NULL
  THEN
    RAISE EXCEPTION 'post interaction repair substrate is incomplete';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_queue
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND relation.relowner = v_postgres_oid
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
      AND NOT relation.relispartition
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_queue
       OR inheritance.inhparent = v_queue
  ) THEN
    RAISE EXCEPTION 'post interaction repair queue relation/RLS drifted';
  END IF;

  IF (
    SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY attribute.attnum)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_queue
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) IS DISTINCT FROM ARRAY[
    'post_id',
    'enqueued_at',
    'next_attempt_at',
    'attempt_count'
  ]::text[] THEN
    RAISE EXCEPTION 'post interaction repair queue column set drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_queue
      AND attribute.attname = 'post_id'
      AND attribute.atttypid = 'uuid'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = v_queue
      AND attribute.attname = 'enqueued_at'
      AND attribute.atttypid = 'timestamptz'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.pg_get_expr(
            default_row.adbin,
            default_row.adrelid
          ) = 'statement_timestamp()'
  ) THEN
    RAISE EXCEPTION 'post interaction repair queue column shape drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = v_queue
      AND attribute.attname = 'next_attempt_at'
      AND attribute.atttypid = 'timestamptz'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.pg_get_expr(
            default_row.adbin,
            default_row.adrelid
          ) = 'statement_timestamp()'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = v_queue
      AND attribute.attname = 'attempt_count'
      AND attribute.atttypid = 'integer'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.pg_get_expr(
            default_row.adbin,
            default_row.adrelid
          ) = '0'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_queue
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(
            constraint_row.oid,
            true
          ) = 'CHECK (attempt_count >= 0 AND attempt_count <= 1000000)'
  ) THEN
    RAISE EXCEPTION 'post interaction repair queue retry shape drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_queue
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_queue
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum::smallint
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = v_queue
            AND attribute.attname = 'post_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
      ]::smallint[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_queue
      AND constraint_row.contype = 'f'
  ) THEN
    RAISE EXCEPTION 'post interaction repair queue PK/no-FK contract drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = v_queue
  ) <> 2 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS index_relation
    JOIN pg_catalog.pg_index AS index_row
      ON index_row.indexrelid = index_relation.oid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_relation.relnamespace = 'public'::pg_catalog.regnamespace
      AND index_relation.relname =
        'idx_post_interaction_count_repair_queue_oldest'
      AND index_relation.relkind = 'i'
      AND index_relation.relpersistence = 'p'
      AND index_relation.relowner = v_postgres_oid
      AND access_method.amname = 'btree'
      AND index_row.indrelid = v_queue
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indislive
      AND NOT index_row.indisunique
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnatts = 3
      AND index_row.indnkeyatts = 3
      AND index_row.indoption = '0 0 0'::pg_catalog.int2vector
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname::text ORDER BY key_column.ordinality
        )
        FROM pg_catalog.unnest(index_row.indkey::smallint[])
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['next_attempt_at', 'enqueued_at', 'post_id']::text[]
  ) THEN
    RAISE EXCEPTION 'post interaction repair queue index set drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = v_queue
  ) THEN
    RAISE EXCEPTION 'post interaction repair queue must have no RLS policies';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    WHERE pg_catalog.has_any_column_privilege(
            role_name,
            v_queue,
            'SELECT,INSERT,UPDATE,REFERENCES'
          )
       OR pg_catalog.has_table_privilege(
            role_name,
            v_queue,
            'DELETE,TRUNCATE,TRIGGER'
          )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = v_queue
      AND acl_entry.grantee <> v_postgres_oid
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = v_queue
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION 'post interaction repair queue ACL leaked';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'enqueue_post_interaction_count_repair',
        'repair_post_interaction_counts_atomic'
      )
      AND function_row.oid NOT IN (
        v_enqueue_function::oid,
        v_repair_function::oid
      )
  ) THEN
    RAISE EXCEPTION 'post interaction repair function overload set drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_enqueue_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::pg_catalog.regtype
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 0
    AND function_row.pronargdefaults = 0
    AND pg_catalog.cardinality(function_row.proconfig) = 2
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off'
    ]::text[];

  IF v_comment IS DISTINCT FROM
       'post-interaction-count-repair:enqueue-v2:' ||
         pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, 'pg_advisory') <> 0
     OR pg_catalog.strpos(v_source, 'auth.users') <> 0
     OR pg_catalog.strpos(v_source, 'UPDATE public.posts') <> 0
     OR pg_catalog.strpos(v_source, '''post_bookmarks''') = 0
     OR pg_catalog.strpos(
          v_source,
          'INSERT INTO public.post_interaction_count_repair_queue'
        ) = 0
  THEN
    RAISE EXCEPTION 'post interaction repair enqueue source drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_repair_function
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
    AND function_row.pronargs = 1
    AND function_row.pronargdefaults = 1
    AND function_row.proargnames = ARRAY['p_limit']::text[]
    AND pg_catalog.pg_get_expr(function_row.proargdefaults, 0) = '1'
    AND pg_catalog.cardinality(function_row.proconfig) = 4
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=30s'
    ]::text[];

  v_post_lock_position := pg_catalog.strpos(
    v_source,
    'pg_try_advisory_xact_lock'
  );
  v_post_row_lock_position := pg_catalog.strpos(
    v_source,
    'FROM public.posts AS locked_post'
  );
  v_queue_lock_position := pg_catalog.strpos(
    v_source,
    'INTO v_claimed_post_id'
  );
  v_queue_delete_position := pg_catalog.strpos(
    v_source,
    'DELETE FROM public.post_interaction_count_repair_queue'
  );
  v_count_position := pg_catalog.strpos(v_source, 'count(*) FILTER');
  v_child_lock_position := pg_catalog.strpos(
    v_source,
    'FROM public.post_bookmarks AS bookmark'
  );
  v_post_update_position := pg_catalog.strpos(v_source, 'UPDATE public.posts');

  IF v_comment IS DISTINCT FROM
       'post-interaction-count-repair:worker-v2:' ||
         pg_catalog.md5(v_source)
     OR v_post_lock_position = 0
     OR v_post_row_lock_position <= v_post_lock_position
     OR v_queue_lock_position <= v_post_row_lock_position
     OR v_queue_delete_position <= v_queue_lock_position
     OR v_count_position <= v_queue_delete_position
     OR v_post_update_position <= v_count_position
     OR pg_catalog.strpos(v_source, '''post-reaction-counts:''') = 0
     OR pg_catalog.strpos(v_source, 'service role required') = 0
     OR pg_catalog.strpos(v_source, 'p_limit IS DISTINCT FROM 1') = 0
     OR pg_catalog.strpos(v_source, 'LIMIT 1') = 0
     OR pg_catalog.strpos(v_source, 'next_attempt_at') = 0
     OR pg_catalog.strpos(v_source, 'attempt_count') = 0
     OR v_child_lock_position <= v_queue_delete_position
     OR pg_catalog.strpos(
       v_source,
       'bookmark_count = v_bookmark_count::integer'
     ) <= v_child_lock_position
     OR v_post_update_position <= v_child_lock_position
     OR pg_catalog.strpos(
       v_source,
       $$RETURN pg_catalog.jsonb_build_object(
    'status', 'processed',
    'selected_count', v_selected_count,
    'processed_count', v_processed_count,
    'repaired_count', v_repaired_count,
    'discarded_count', v_discarded_count,
    'contended_count', v_contended_count,
    'has_more', v_has_more,
    'remaining_count', v_remaining_count,
    'oldest_enqueued_at', v_oldest_enqueued_at
  );$$
     ) = 0
  THEN
    RAISE EXCEPTION
      'repair worker P -> posts -> Q lock/source contract drifted';
  END IF;

  FOR v_trigger IN
    SELECT *
    FROM (
      VALUES
        (
          'public.post_likes'::pg_catalog.regclass,
          'trg_post_likes_90_enqueue_count_repair',
          ARRAY['post_id', 'reaction_type']::text[]
        ),
        (
          'public.post_votes'::pg_catalog.regclass,
          'trg_post_votes_90_enqueue_count_repair',
          ARRAY['post_id', 'choice']::text[]
        ),
        (
          'public.post_bookmarks'::pg_catalog.regclass,
          'trg_post_bookmarks_90_enqueue_count_repair',
          ARRAY['post_id']::text[]
        )
    ) AS expected_trigger(relation_oid, trigger_name, update_columns)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_trigger.relation_oid
        AND trigger_row.tgname = v_trigger.trigger_name
        AND trigger_row.tgfoid = v_enqueue_function
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgtype = 29
        AND trigger_row.tgqual IS NULL
        AND trigger_row.tgoldtable IS NULL
        AND trigger_row.tgnewtable IS NULL
        AND (
          SELECT pg_catalog.array_agg(
            attribute.attname::text ORDER BY update_column.ordinality
          )
          FROM pg_catalog.unnest(trigger_row.tgattr::smallint[])
            WITH ORDINALITY AS update_column(attnum, ordinality)
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = trigger_row.tgrelid
           AND attribute.attnum = update_column.attnum
        ) = v_trigger.update_columns
    ) THEN
      RAISE EXCEPTION 'post interaction repair trigger drifted: %',
        v_trigger.trigger_name;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid = v_enqueue_function
      AND NOT trigger_row.tgisinternal
  ) <> 3 THEN
    RAISE EXCEPTION 'post interaction repair trigger cardinality drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_repair_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_repair_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_repair_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticator', v_repair_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'service_role', v_enqueue_function, 'EXECUTE'
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
       WHERE function_row.oid IN (v_enqueue_function, v_repair_function)
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
       WHERE function_row.oid = v_repair_function
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee = v_service_oid
         AND acl_entry.is_grantable
     )
  THEN
    RAISE EXCEPTION 'post interaction repair function ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    CROSS JOIN pg_catalog.unnest(
      ARRAY[
        'public.post_likes',
        'public.post_votes',
        'public.post_bookmarks'
      ]::text[]
    ) AS relation_name
    WHERE pg_catalog.has_table_privilege(role_name, relation_name, 'TRUNCATE')
  ) THEN
    RAISE EXCEPTION 'post interaction source TRUNCATE authority leaked';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY[
        pg_catalog.to_regprocedure('public.increment_like_count(uuid)'),
        pg_catalog.to_regprocedure('public.decrement_like_count(uuid)'),
        pg_catalog.to_regprocedure('public.increment_bookmark_count(uuid)'),
        pg_catalog.to_regprocedure('public.decrement_bookmark_count(uuid)')
      ]::regprocedure[]
    ) AS legacy_function
    CROSS JOIN pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    WHERE legacy_function IS NOT NULL
      AND pg_catalog.has_function_privilege(
        role_name,
        legacy_function,
        'EXECUTE'
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    WHERE function_row.oid IN (
      pg_catalog.to_regprocedure('public.increment_like_count(uuid)'),
      pg_catalog.to_regprocedure('public.decrement_like_count(uuid)'),
      pg_catalog.to_regprocedure('public.increment_bookmark_count(uuid)'),
      pg_catalog.to_regprocedure('public.decrement_bookmark_count(uuid)')
    )
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION 'legacy arithmetic post counter RPC remains callable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'increment_like_count',
        'decrement_like_count',
        'increment_bookmark_count',
        'decrement_bookmark_count'
      )
      AND function_row.oid IS DISTINCT FROM CASE function_row.proname
        WHEN 'increment_like_count' THEN
          pg_catalog.to_regprocedure('public.increment_like_count(uuid)')::oid
        WHEN 'decrement_like_count' THEN
          pg_catalog.to_regprocedure('public.decrement_like_count(uuid)')::oid
        WHEN 'increment_bookmark_count' THEN
          pg_catalog.to_regprocedure('public.increment_bookmark_count(uuid)')::oid
        WHEN 'decrement_bookmark_count' THEN
          pg_catalog.to_regprocedure('public.decrement_bookmark_count(uuid)')::oid
      END
  ) THEN
    RAISE EXCEPTION 'legacy arithmetic post counter RPC overload remains';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.toggle_post_reaction(uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.set_post_reaction_desired_state_atomic(uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.toggle_post_vote_atomic(uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.set_post_vote_desired_state_atomic(uuid,uuid,text)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.prokind = 'f'
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef;

    IF pg_catalog.strpos(v_source, '''post-reaction-counts:''') = 0
       OR pg_catalog.strpos(v_source, 'pg_advisory_xact_lock') = 0
       OR pg_catalog.strpos(v_source, 'UPDATE public.posts') = 0
       OR pg_catalog.strpos(v_source, '''post-reaction-counts:''') >
          pg_catalog.strpos(v_source, 'UPDATE public.posts')
    THEN
      RAISE EXCEPTION
        'live post interaction authority left shared post lock: %',
        v_function;
    END IF;
  END LOOP;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)',
          ARRAY['p_actor_id', 'p_post_id', 'p_folder_id']::text[],
          1,
          v_service_oid,
          'bookmark-count-consistency:toggle-v1:'
        ),
        (
          'public.save_post_bookmark_to_folder_atomic(uuid,uuid)',
          ARRAY['p_post_id', 'p_folder_id']::text[],
          0,
          v_authenticated_oid,
          'bookmark-count-consistency:save-v1:'
        ),
        (
          'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)',
          ARRAY['p_post_id', 'p_bookmark_id', 'p_folder_id']::text[],
          0,
          v_authenticated_oid,
          'bookmark-count-consistency:remove-v1:'
        )
    ) AS expected(
      signature,
      argument_names,
      default_count,
      role_oid,
      comment_prefix
    )
  LOOP
    v_function := pg_catalog.to_regprocedure(v_expected.signature);

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
      AND function_row.pronargs =
        pg_catalog.cardinality(v_expected.argument_names)
      AND function_row.pronargdefaults = v_expected.default_count
      AND function_row.proargnames = v_expected.argument_names
      AND pg_catalog.cardinality(function_row.proconfig) = 4
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
        'lock_timeout=5s',
        'statement_timeout=15s'
      ]::text[];

    v_post_lock_position := pg_catalog.strpos(
      v_source,
      '''post-reaction-counts:'''
    );
    v_actor_lock_position := pg_catalog.strpos(v_source, '''post-bookmark:''');
    v_account_lock_position := pg_catalog.strpos(
      v_source,
      '''account-recovery-admission:'''
    );
    v_auth_lock_position := pg_catalog.strpos(
      v_source,
      'FROM auth.users AS actor_account'
    );
    v_profile_lock_position := pg_catalog.strpos(
      v_source,
      'FROM public.user_profiles AS profile'
    );
    v_audience_lock_position := pg_catalog.strpos(
      v_source,
      'public.lock_actor_can_interact_with_post'
    );
    v_folder_lock_position := pg_catalog.strpos(
      v_source,
      'FROM public.bookmark_folders AS folder'
    );
    v_child_lock_position := pg_catalog.strpos(
      v_source,
      'FROM public.post_bookmarks AS bookmark'
    );
    v_count_position := pg_catalog.strpos(
      v_source,
      'SELECT pg_catalog.count(*)'
    );
    v_post_update_position := pg_catalog.strpos(v_source, 'UPDATE public.posts');

    IF v_comment IS DISTINCT FROM
         v_expected.comment_prefix || pg_catalog.md5(v_source)
       OR v_post_lock_position = 0
       OR v_actor_lock_position <= v_post_lock_position
       OR (
         v_expected.signature =
           'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)'
         AND (
           v_auth_lock_position <= v_actor_lock_position
           OR v_audience_lock_position <= v_auth_lock_position
           OR v_folder_lock_position <= v_audience_lock_position
         )
       )
       OR (
         v_expected.signature =
           'public.save_post_bookmark_to_folder_atomic(uuid,uuid)'
         AND (
           v_account_lock_position <= v_actor_lock_position
           OR v_auth_lock_position <= v_account_lock_position
           OR v_profile_lock_position <= v_auth_lock_position
           OR v_audience_lock_position <= v_profile_lock_position
           OR v_folder_lock_position <= v_audience_lock_position
         )
       )
       OR (
         v_expected.signature =
           'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'
         AND (
           v_account_lock_position <= v_actor_lock_position
           OR v_auth_lock_position <= v_account_lock_position
           OR v_profile_lock_position <= v_auth_lock_position
           OR v_folder_lock_position <= v_profile_lock_position
         )
       )
       OR v_child_lock_position <= v_folder_lock_position
       OR v_count_position <= v_child_lock_position
       OR v_post_update_position <= v_count_position
       OR NOT pg_catalog.has_function_privilege(
         v_expected.role_oid,
         v_function,
         'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticator',
         v_function,
         'EXECUTE'
       )
       OR (
         v_expected.role_oid = v_service_oid
         AND pg_catalog.has_function_privilege(
           'authenticated',
           v_function,
           'EXECUTE'
         )
       )
       OR (
         v_expected.role_oid = v_authenticated_oid
         AND pg_catalog.has_function_privilege(
           'service_role',
           v_function,
           'EXECUTE'
         )
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
           AND acl_entry.grantee NOT IN (
             v_postgres_oid,
             v_expected.role_oid
           )
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl)
           AS acl_entry
         WHERE function_row.oid = v_function
           AND acl_entry.privilege_type = 'EXECUTE'
           AND acl_entry.grantee = v_expected.role_oid
           AND acl_entry.is_grantable
       )
    THEN
      RAISE EXCEPTION 'post bookmark authority drifted: %',
        v_expected.signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'toggle_post_bookmark_atomic',
        'save_post_bookmark_to_folder_atomic',
        'remove_post_bookmark_from_folder_atomic'
      )
      AND function_row.oid NOT IN (
        'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)'::regprocedure,
        'public.save_post_bookmark_to_folder_atomic(uuid,uuid)'::regprocedure,
        'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'::regprocedure
      )
  ) THEN
    RAISE EXCEPTION 'post bookmark authority overload set drifted';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.refresh_hot_scores()',
          'UPDATE posts SET',
          'calculate_hot_score'
        ),
        (
          'public.refresh_hot_scores_incremental()',
          'UPDATE posts SET',
          'last_hot_refresh_at'
        ),
        (
          'public.update_post_velocity()',
          'UPDATE posts p SET',
          'comments_last_hour'
        ),
        (
          'public.update_post_report_counts()',
          'UPDATE posts p SET',
          'content_reports'
        )
    ) AS expected_function(signature, source_marker_a, source_marker_b)
  LOOP
    v_function := pg_catalog.to_regprocedure(v_expected.signature);
    IF v_function IS NULL THEN
      RAISE EXCEPTION 'post hot-score service authority is missing: %',
        v_expected.signature;
    END IF;

    SELECT function_row.prosrc,
           pg_catalog.obj_description(function_row.oid, 'pg_proc')
    INTO STRICT v_source, v_comment
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'integer'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.prolang = v_plpgsql_oid
      AND function_row.provolatile = 'v'
      AND NOT function_row.proisstrict
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.pronargs = 0
      AND function_row.pronargdefaults = 0
      AND pg_catalog.cardinality(function_row.proconfig) = 4
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, public, pg_temp',
        'row_security=off',
        'lock_timeout=5s',
        'statement_timeout=60s'
      ]::text[];

    IF pg_catalog.strpos(v_source, v_expected.source_marker_a) = 0
       OR pg_catalog.strpos(v_source, v_expected.source_marker_b) = 0
       OR pg_catalog.strpos(v_source, 'GET DIAGNOSTICS') = 0
       OR v_comment IS DISTINCT FROM
          'post-hot-score-service-authority:v1:' || pg_catalog.md5(v_source)
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
      RAISE EXCEPTION 'post hot-score service authority drifted: %',
        v_function;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'refresh_hot_scores',
        'refresh_hot_scores_incremental',
        'update_post_velocity',
        'update_post_report_counts'
      )
  ) <> 4 THEN
    RAISE EXCEPTION 'post hot-score authority overload set drifted';
  END IF;

  SELECT pg_catalog.count(*),
         pg_catalog.count(*) FILTER (
           WHERE repair_queue.next_attempt_at <=
             pg_catalog.transaction_timestamp()
         ),
         pg_catalog.min(repair_queue.enqueued_at),
         pg_catalog.transaction_timestamp() -
           pg_catalog.min(repair_queue.enqueued_at),
         pg_catalog.max(repair_queue.attempt_count)
  INTO v_backlog_count,
       v_due_backlog_count,
       v_oldest_enqueued_at,
       v_oldest_age,
       v_max_attempt_count
  FROM public.post_interaction_count_repair_queue AS repair_queue;

  WITH reaction_counts AS (
    SELECT reaction.post_id,
           pg_catalog.count(*) FILTER (
             WHERE reaction.reaction_type = 'up'
           ) AS like_count,
           pg_catalog.count(*) FILTER (
             WHERE reaction.reaction_type = 'down'
           ) AS dislike_count
    FROM public.post_likes AS reaction
    GROUP BY reaction.post_id
  ), vote_counts AS (
    SELECT vote.post_id,
           pg_catalog.count(*) FILTER (
             WHERE vote.choice = 'bull'
           ) AS bull_count,
           pg_catalog.count(*) FILTER (
             WHERE vote.choice = 'bear'
           ) AS bear_count,
           pg_catalog.count(*) FILTER (
             WHERE vote.choice = 'wait'
           ) AS wait_count
    FROM public.post_votes AS vote
    GROUP BY vote.post_id
  ), bookmark_counts AS (
    SELECT bookmark.post_id,
           pg_catalog.count(*) AS bookmark_count
    FROM public.post_bookmarks AS bookmark
    GROUP BY bookmark.post_id
  )
  SELECT pg_catalog.count(*) FILTER (
           WHERE COALESCE(target.like_count, 0)::bigint IS DISTINCT FROM
             COALESCE(reaction_counts.like_count, 0::bigint)
         ),
         pg_catalog.count(*) FILTER (
           WHERE COALESCE(target.dislike_count, 0)::bigint IS DISTINCT FROM
             COALESCE(reaction_counts.dislike_count, 0::bigint)
         ),
         pg_catalog.count(*) FILTER (
           WHERE COALESCE(target.poll_bull, 0)::bigint IS DISTINCT FROM
             COALESCE(vote_counts.bull_count, 0::bigint)
         ),
         pg_catalog.count(*) FILTER (
           WHERE COALESCE(target.poll_bear, 0)::bigint IS DISTINCT FROM
             COALESCE(vote_counts.bear_count, 0::bigint)
         ),
         pg_catalog.count(*) FILTER (
           WHERE COALESCE(target.poll_wait, 0)::bigint IS DISTINCT FROM
             COALESCE(vote_counts.wait_count, 0::bigint)
         ),
         pg_catalog.count(*) FILTER (
           WHERE COALESCE(target.bookmark_count, 0)::bigint IS DISTINCT FROM
             COALESCE(bookmark_counts.bookmark_count, 0::bigint)
         ),
         pg_catalog.count(*) FILTER (
           WHERE COALESCE(target.like_count, 0)::bigint IS DISTINCT FROM
                   COALESCE(reaction_counts.like_count, 0::bigint)
              OR COALESCE(target.dislike_count, 0)::bigint IS DISTINCT FROM
                   COALESCE(reaction_counts.dislike_count, 0::bigint)
              OR COALESCE(target.poll_bull, 0)::bigint IS DISTINCT FROM
                   COALESCE(vote_counts.bull_count, 0::bigint)
              OR COALESCE(target.poll_bear, 0)::bigint IS DISTINCT FROM
                   COALESCE(vote_counts.bear_count, 0::bigint)
              OR COALESCE(target.poll_wait, 0)::bigint IS DISTINCT FROM
                   COALESCE(vote_counts.wait_count, 0::bigint)
              OR COALESCE(target.bookmark_count, 0)::bigint IS DISTINCT FROM
                   COALESCE(bookmark_counts.bookmark_count, 0::bigint)
         )
  INTO v_like_drift_count,
       v_dislike_drift_count,
       v_bull_drift_count,
       v_bear_drift_count,
       v_wait_drift_count,
       v_bookmark_drift_count,
       v_drift_post_count
  FROM public.posts AS target
  LEFT JOIN reaction_counts
    ON reaction_counts.post_id = target.id
  LEFT JOIN vote_counts
    ON vote_counts.post_id = target.id
  LEFT JOIN bookmark_counts
    ON bookmark_counts.post_id = target.id;

  RAISE NOTICE
    'post interaction repair report: backlog=%, due_backlog=%, oldest=%, oldest_age=%, max_attempt=%, drift_posts=%, like=%, dislike=%, bull=%, bear=%, wait=%, bookmark=%',
    v_backlog_count,
    v_due_backlog_count,
    v_oldest_enqueued_at,
    v_oldest_age,
    v_max_attempt_count,
    v_drift_post_count,
    v_like_drift_count,
    v_dislike_drift_count,
    v_bull_drift_count,
    v_bear_drift_count,
    v_wait_drift_count,
    v_bookmark_drift_count;

  IF v_oldest_enqueued_at IS NOT NULL
     AND v_oldest_enqueued_at <
       pg_catalog.transaction_timestamp() - INTERVAL '15 minutes'
  THEN
    RAISE EXCEPTION
      'post interaction repair queue exceeded fifteen-minute SLA: backlog %, oldest %, age %',
      v_backlog_count,
      v_oldest_enqueued_at,
      v_oldest_age;
  END IF;

  IF v_drift_post_count <> 0 THEN
    RAISE EXCEPTION
      'post interaction cached-counter drift remains: posts %, like %, dislike %, bull %, bear %, wait %, bookmark %',
      v_drift_post_count,
      v_like_drift_count,
      v_dislike_drift_count,
      v_bull_drift_count,
      v_bear_drift_count,
      v_wait_drift_count,
      v_bookmark_drift_count;
  END IF;

  RAISE NOTICE
    'post interaction count repair and hot-score authority attestation passed';
END
$attestation$;

ROLLBACK;
