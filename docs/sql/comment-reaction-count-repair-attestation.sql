-- Read-only production attestation for
-- 20260803106000_durable_comment_reaction_count_repair.sql,
-- 20260803107000_set_comment_reaction_desired_state.sql,
-- 20260803108000_comment_reaction_causal_intents.sql, and
-- 20260803109000_close_legacy_comment_reaction_desired_state.sql.
-- Run with a catalog-visible maintenance role after the initial repair queue
-- has drained. The script never invokes a mutating RPC and always rolls back.

BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $attestation$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
  v_service_oid oid := pg_catalog.to_regrole('service_role');
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_queue regclass := pg_catalog.to_regclass(
    'public.comment_reaction_count_repair_queue'
  );
  v_enqueue_function regprocedure := pg_catalog.to_regprocedure(
    'public.enqueue_comment_reaction_count_repair()'
  );
  v_source_guard_function regprocedure := pg_catalog.to_regprocedure(
    'public.guard_canonical_comment_reaction_mutation()'
  );
  v_sync_function regprocedure := pg_catalog.to_regprocedure(
    'public.sync_comment_reaction_counts()'
  );
  v_cache_guard_function regprocedure := pg_catalog.to_regprocedure(
    'public.guard_contract_comment_reaction_counts()'
  );
  v_toggle_function regprocedure := pg_catalog.to_regprocedure(
    'public.toggle_comment_reaction(uuid,uuid,uuid,text)'
  );
  v_worker_function regprocedure := pg_catalog.to_regprocedure(
    'public.repair_comment_reaction_counts_atomic(integer)'
  );
  v_missing_roles text[];
  v_relation regclass;
  v_required_column record;
  v_trigger record;
  v_source text;
  v_comment text;
  v_enqueue_source text;
  v_source_guard_source text;
  v_sync_source text;
  v_cache_guard_source text;
  v_toggle_source text;
  v_worker_source text;
  v_gate_position integer;
  v_candidate_position integer;
  v_post_lock_position integer;
  v_comment_lock_position integer;
  v_queue_lock_position integer;
  v_queue_delete_position integer;
  v_count_position integer;
  v_update_position integer;
  v_backlog_count bigint;
  v_due_backlog_count bigint;
  v_oldest_enqueued_at timestamptz;
  v_oldest_age interval;
  v_max_attempt_count integer;
  v_like_drift_count bigint;
  v_dislike_drift_count bigint;
  v_drift_comment_count bigint;
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
     OR v_plpgsql_oid IS NULL
  THEN
    RAISE EXCEPTION
      'comment reaction repair attestation roles/language are missing: %',
      v_missing_roles;
  END IF;

  IF v_queue IS NULL
     OR v_enqueue_function IS NULL
     OR v_source_guard_function IS NULL
     OR v_sync_function IS NULL
     OR v_cache_guard_function IS NULL
     OR v_toggle_function IS NULL
     OR v_worker_function IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.comments') IS NULL
     OR pg_catalog.to_regclass('public.comment_likes') IS NULL
  THEN
    RAISE EXCEPTION 'comment reaction repair substrate is incomplete';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.posts'::pg_catalog.regclass,
    'public.comments'::pg_catalog.regclass,
    'public.comment_likes'::pg_catalog.regclass,
    v_queue
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = v_relation
        AND relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND relation.relowner = v_postgres_oid
        AND NOT relation.relispartition
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
         OR inheritance.inhparent = v_relation
    ) THEN
      RAISE EXCEPTION
        'comment reaction repair relation contract drifted: %',
        v_relation;
    END IF;
  END LOOP;

  FOR v_required_column IN
    SELECT *
    FROM (
      VALUES
        ('public.posts'::regclass, 'id', 'uuid'::regtype, true),
        ('public.comments'::regclass, 'id', 'uuid'::regtype, true),
        ('public.comments'::regclass, 'post_id', 'uuid'::regtype, true),
        ('public.comments'::regclass, 'like_count', 'integer'::regtype, true),
        ('public.comments'::regclass, 'dislike_count', 'integer'::regtype, true),
        ('public.comment_likes'::regclass, 'id', 'uuid'::regtype, true),
        ('public.comment_likes'::regclass, 'comment_id', 'uuid'::regtype, true),
        ('public.comment_likes'::regclass, 'user_id', 'uuid'::regtype, true),
        ('public.comment_likes'::regclass, 'reaction_type', 'text'::regtype, true)
    ) AS expected(relation_oid, column_name, type_oid, required_not_null)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_required_column.relation_oid
        AND attribute.attname = v_required_column.column_name
        AND attribute.atttypid = v_required_column.type_oid
        AND (
          NOT v_required_column.required_not_null
          OR attribute.attnotnull
        )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) THEN
      RAISE EXCEPTION 'comment reaction source column drifted: %.%',
        v_required_column.relation_oid,
        v_required_column.column_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_queue
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid = v_queue
  ) OR (
    SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY attribute.attnum)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_queue
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) IS DISTINCT FROM ARRAY[
    'comment_id',
    'enqueued_at',
    'next_attempt_at',
    'attempt_count'
  ]::text[] THEN
    RAISE EXCEPTION 'comment reaction repair queue relation/column/RLS drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_queue
      AND attribute.attname = 'comment_id'
      AND attribute.atttypid = 'uuid'::regtype
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
      AND attribute.atttypid = 'timestamptz'::regtype
      AND attribute.attnotnull
      AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) =
        'statement_timestamp()'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = v_queue
      AND attribute.attname = 'next_attempt_at'
      AND attribute.atttypid = 'timestamptz'::regtype
      AND attribute.attnotnull
      AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) =
        'statement_timestamp()'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = v_queue
      AND attribute.attname = 'attempt_count'
      AND attribute.atttypid = 'integer'::regtype
      AND attribute.attnotnull
      AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) = '0'
  ) THEN
    RAISE EXCEPTION 'comment reaction repair queue defaults drifted';
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
            AND attribute.attname = 'comment_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
      ]::smallint[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_queue
      AND constraint_row.contype = 'f'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_queue
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'CHECK (attempt_count >= 0 AND attempt_count <= 1000000)'
  ) THEN
    RAISE EXCEPTION 'comment reaction repair queue PK/no-FK/backoff drifted';
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
    WHERE index_relation.relnamespace = 'public'::regnamespace
      AND index_relation.relname =
        'idx_comment_reaction_count_repair_queue_oldest'
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
      AND index_row.indnkeyatts = 3
      AND index_row.indnatts = 3
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
      ) = ARRAY['next_attempt_at', 'enqueued_at', 'comment_id']::text[]
  ) THEN
    RAISE EXCEPTION 'comment reaction repair queue index drifted';
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
    RAISE EXCEPTION 'comment reaction repair queue ACL leaked';
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
    WHERE relation.oid = 'public.comment_likes'::regclass
      AND acl_entry.grantee <> v_postgres_oid
      AND acl_entry.privilege_type <> 'SELECT'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.comment_likes'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres_oid
      AND acl_entry.privilege_type <> 'SELECT'
  ) THEN
    RAISE EXCEPTION 'comment reaction source mutation ACL leaked';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname IN (
        'enqueue_comment_reaction_count_repair',
        'guard_canonical_comment_reaction_mutation',
        'sync_comment_reaction_counts',
        'guard_contract_comment_reaction_counts',
        'toggle_comment_reaction',
        'repair_comment_reaction_counts_atomic'
      )
      AND function_row.oid NOT IN (
        v_enqueue_function::oid,
        v_source_guard_function::oid,
        v_sync_function::oid,
        v_cache_guard_function::oid,
        v_toggle_function::oid,
        v_worker_function::oid
      )
  ) THEN
    RAISE EXCEPTION 'comment reaction repair overload set drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_enqueue_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_enqueue_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::regtype
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
       'comment-reaction-count-repair:enqueue-v1:' ||
         pg_catalog.md5(v_enqueue_source)
     OR pg_catalog.strpos(v_enqueue_source, '''comment_likes''') = 0
     OR pg_catalog.strpos(v_enqueue_source, 'pg_advisory') <> 0
     OR pg_catalog.strpos(v_enqueue_source, 'auth.users') <> 0
     OR pg_catalog.strpos(v_enqueue_source, 'public.posts') <> 0
     OR pg_catalog.strpos(v_enqueue_source, 'public.comments') <> 0
     OR pg_catalog.strpos(
       v_enqueue_source,
       'INSERT INTO public.comment_reaction_count_repair_queue'
     ) = 0
  THEN
    RAISE EXCEPTION 'comment reaction enqueue source drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source_guard_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_source_guard_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND NOT function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 0
    AND function_row.pronargdefaults = 0
    AND function_row.proargnames IS NULL
    AND function_row.proallargtypes IS NULL
    AND function_row.proargmodes IS NULL
    AND function_row.proargdefaults IS NULL
    AND function_row.proconfig =
      ARRAY['search_path=pg_catalog, pg_temp']::text[];

  IF v_comment IS DISTINCT FROM
       'comment-reaction-count-repair:source-guard-v1:' ||
         pg_catalog.md5(v_source_guard_source)
     OR pg_catalog.strpos(v_source_guard_source, 'pg_trigger_depth() > 1') = 0
     OR pg_catalog.strpos(
       v_source_guard_source,
       'app.comment_reaction_path'
     ) = 0
     OR pg_catalog.strpos(
       v_source_guard_source,
       'direct comment reaction mutation is disabled'
     ) = 0
  THEN
    RAISE EXCEPTION 'comment reaction canonical source guard drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_sync_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_sync_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 0
    AND function_row.pronargdefaults = 0
    AND function_row.proargnames IS NULL
    AND function_row.proallargtypes IS NULL
    AND function_row.proargmodes IS NULL
    AND function_row.proargdefaults IS NULL
    AND pg_catalog.cardinality(function_row.proconfig) = 2
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off'
    ]::text[];

  v_count_position := pg_catalog.strpos(
    v_sync_source,
    'pg_catalog.count(*) FILTER'
  );
  v_update_position := pg_catalog.strpos(
    v_sync_source,
    'UPDATE public.comments AS target'
  );
  IF v_comment IS DISTINCT FROM
       'comment-reaction-count-repair:sync-v1:' ||
         pg_catalog.md5(v_sync_source)
     OR pg_catalog.strpos(v_sync_source, 'app.comment_reaction_path') = 0
     OR pg_catalog.strpos(
       v_sync_source,
       'FROM public.comment_likes AS reaction'
     ) <= v_count_position
     OR v_count_position = 0
     OR v_update_position <= v_count_position
     OR pg_catalog.strpos(v_sync_source, 'like_count = v_like_count::integer') = 0
     OR pg_catalog.strpos(
       v_sync_source,
       'dislike_count = v_dislike_count::integer'
     ) = 0
     OR pg_catalog.strpos(v_sync_source, 'v_like_delta') <> 0
     OR pg_catalog.strpos(v_sync_source, 'v_dislike_delta') <> 0
  THEN
    RAISE EXCEPTION 'comment reaction absolute sync source drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_cache_guard_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_cache_guard_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND NOT function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 0
    AND function_row.pronargdefaults = 0
    AND function_row.proargnames IS NULL
    AND function_row.proallargtypes IS NULL
    AND function_row.proargmodes IS NULL
    AND function_row.proargdefaults IS NULL
    AND function_row.proconfig =
      ARRAY['search_path=pg_catalog, pg_temp']::text[];

  IF v_comment IS DISTINCT FROM
       'comment-reaction-count-repair:guard-v1:' ||
         pg_catalog.md5(v_cache_guard_source)
     OR pg_catalog.strpos(
       v_cache_guard_source,
       'app.comment_reaction_repair_path'
     ) = 0
     OR pg_catalog.strpos(
       v_cache_guard_source,
       'repair_comment_reaction_counts_atomic'
     ) = 0
     OR pg_catalog.strpos(
       v_cache_guard_source,
       'new comments must start with zero reaction counters'
     ) = 0
  THEN
    RAISE EXCEPTION 'comment reaction cache guard drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_toggle_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_toggle_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::regtype
    AND NOT function_row.proretset
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 4
    AND function_row.pronargdefaults = 1
    AND function_row.proargnames = ARRAY[
      'p_post_id',
      'p_comment_id',
      'p_user_id',
      'p_reaction_type'
    ]::text[]
    AND function_row.proconfig = ARRAY[
      'search_path=pg_catalog, pg_temp',
      'lock_timeout=5s'
    ]::text[];

  IF v_comment IS DISTINCT FROM
       'comment-reaction-count-repair:legacy-wrapper-v1:' ||
         pg_catalog.md5(v_toggle_source)
     OR pg_catalog.strpos(v_toggle_source, 'FROM auth.users AS actor_account') = 0
     OR pg_catalog.strpos(
       v_toggle_source,
       'public.lock_post_interaction_block_edges'
     ) <= pg_catalog.strpos(
       v_toggle_source,
       'FROM auth.users AS actor_account'
     )
     OR pg_catalog.strpos(
       v_toggle_source,
       'public.toggle_comment_reaction_locked_impl'
     ) <= pg_catalog.strpos(
       v_toggle_source,
       'public.lock_post_interaction_block_edges'
     )
  THEN
    RAISE EXCEPTION 'comment reaction auth-first wrapper drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_worker_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_worker_function
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::regtype
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
    AND pg_catalog.cardinality(function_row.proconfig) = 4
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=30s'
    ]::text[];

  v_gate_position := pg_catalog.strpos(
    v_worker_source,
    'pg_catalog.pg_try_advisory_xact_lock_shared'
  );
  v_candidate_position := pg_catalog.strpos(
    v_worker_source,
    'FROM public.comment_reaction_count_repair_queue AS repair_queue'
  );
  v_post_lock_position := pg_catalog.strpos(
    v_worker_source,
    'INTO v_locked_post_id'
  );
  v_comment_lock_position := pg_catalog.strpos(
    v_worker_source,
    'INTO v_locked_comment_id'
  );
  v_queue_lock_position := pg_catalog.strpos(
    v_worker_source,
    'FROM public.comment_reaction_count_repair_queue AS claimed_queue'
  );
  v_queue_delete_position := pg_catalog.strpos(
    v_worker_source,
    'DELETE FROM public.comment_reaction_count_repair_queue AS claimed_queue'
  );
  v_count_position := pg_catalog.strpos(
    v_worker_source,
    'pg_catalog.count(*) FILTER'
  );
  v_update_position := pg_catalog.strpos(
    v_worker_source,
    'UPDATE public.comments AS target'
  );

  IF v_comment IS DISTINCT FROM
       'comment-reaction-count-repair:worker-v1:' ||
         pg_catalog.md5(v_worker_source)
     OR v_gate_position = 0
     OR v_candidate_position <= v_gate_position
     OR v_post_lock_position <= v_candidate_position
     OR v_comment_lock_position <= v_post_lock_position
     OR v_queue_lock_position <= v_comment_lock_position
     OR v_queue_delete_position <= v_queue_lock_position
     OR v_count_position <= v_queue_delete_position
     OR v_update_position <= v_count_position
     OR pg_catalog.strpos(v_worker_source, 'FOR SHARE SKIP LOCKED') = 0
     OR pg_catalog.strpos(v_worker_source, 'FOR UPDATE SKIP LOCKED') = 0
     OR pg_catalog.strpos(v_worker_source, 'p_limit IS DISTINCT FROM 1') = 0
     OR pg_catalog.strpos(v_worker_source, 'LIMIT 1') = 0
     OR pg_catalog.strpos(v_worker_source, 'service role required') = 0
     OR pg_catalog.strpos(v_worker_source, '55P03') = 0
     OR pg_catalog.strpos(
       v_worker_source,
       'public.comment-reaction-count-repair:migration'
     ) = 0
     OR (
       pg_catalog.length(v_worker_source) -
       pg_catalog.length(
         pg_catalog.replace(
           v_worker_source,
           'pg_try_advisory_xact_lock_shared',
           ''
         )
       )
     ) <> pg_catalog.length('pg_try_advisory_xact_lock_shared')
     OR pg_catalog.strpos(
       v_worker_source,
       'pg_advisory_xact_lock_shared('
     ) <> 0
     OR pg_catalog.strpos(v_worker_source, 'pg_try_advisory_xact_lock(') <> 0
     OR pg_catalog.strpos(v_worker_source, 'pg_advisory_xact_lock(') <> 0
     OR pg_catalog.strpos(
       v_worker_source,
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
    RAISE EXCEPTION 'comment reaction repair worker/receipt drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.comment_likes'::regclass
      AND trigger_row.tgname =
        'trg_comment_likes_00_guard_canonical_mutation'
      AND trigger_row.tgfoid = v_source_guard_function
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 31
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
      AND trigger_row.tgqual IS NULL
      AND trigger_row.tgnargs = 0
      AND pg_catalog.octet_length(trigger_row.tgargs) = 0
      AND trigger_row.tgoldtable IS NULL
      AND trigger_row.tgnewtable IS NULL
  ) THEN
    RAISE EXCEPTION 'comment reaction source guard trigger drifted';
  END IF;

  FOR v_trigger IN
    SELECT *
    FROM (
      VALUES
        (
          'public.comment_likes'::regclass,
          'trg_comment_likes_20_sync_counts',
          v_sync_function,
          29::smallint,
          ARRAY['comment_id', 'user_id', 'reaction_type']::text[]
        ),
        (
          'public.comment_likes'::regclass,
          'trg_comment_likes_90_enqueue_count_repair',
          v_enqueue_function,
          29::smallint,
          ARRAY['comment_id', 'reaction_type']::text[]
        ),
        (
          'public.comments'::regclass,
          'trg_comments_04_contract_reaction_counts',
          v_cache_guard_function,
          23::smallint,
          ARRAY['like_count', 'dislike_count']::text[]
        )
    ) AS expected(
      relation_oid,
      trigger_name,
      function_oid,
      trigger_type,
      update_columns
    )
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_trigger.relation_oid
        AND trigger_row.tgname = v_trigger.trigger_name
        AND trigger_row.tgfoid = v_trigger.function_oid
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
        AND trigger_row.tgtype = v_trigger.trigger_type
        AND trigger_row.tgqual IS NULL
        AND trigger_row.tgnargs = 0
        AND pg_catalog.octet_length(trigger_row.tgargs) = 0
        AND trigger_row.tgoldtable IS NULL
        AND trigger_row.tgnewtable IS NULL
        AND (
          SELECT pg_catalog.array_agg(
            attribute.attname::text ORDER BY trigger_column.ordinality
          )
          FROM pg_catalog.unnest(trigger_row.tgattr::smallint[])
            WITH ORDINALITY AS trigger_column(attnum, ordinality)
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = trigger_row.tgrelid
           AND attribute.attnum = trigger_column.attnum
        ) = v_trigger.update_columns
    ) THEN
      RAISE EXCEPTION 'comment reaction repair trigger drifted: %',
        v_trigger.trigger_name;
    END IF;
  END LOOP;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid IN (
      v_enqueue_function::oid,
      v_source_guard_function::oid,
      v_sync_function::oid,
      v_cache_guard_function::oid
    )
      AND NOT trigger_row.tgisinternal
  ) <> 4 THEN
    RAISE EXCEPTION 'comment reaction repair trigger cardinality drifted';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       v_toggle_function,
       'EXECUTE'
     ) OR NOT pg_catalog.has_function_privilege(
       'service_role',
       v_worker_function,
       'EXECUTE'
     ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator']::text[]
    ) AS role_name
    CROSS JOIN pg_catalog.unnest(
      ARRAY[v_toggle_function, v_worker_function]::regprocedure[]
    ) AS callable_function
    WHERE pg_catalog.has_function_privilege(
      role_name,
      callable_function,
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
      v_enqueue_function::oid,
      v_source_guard_function::oid,
      v_sync_function::oid,
      v_cache_guard_function::oid,
      v_toggle_function::oid,
      v_worker_function::oid
    )
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
    WHERE function_row.oid IN (v_toggle_function::oid, v_worker_function::oid)
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee = v_service_oid
      AND acl_entry.is_grantable
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    v_enqueue_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    v_source_guard_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    v_sync_function,
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    v_cache_guard_function,
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'comment reaction repair function ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    WHERE pg_catalog.has_table_privilege(
      role_name,
      'public.comment_likes',
      'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
    )
  ) THEN
    RAISE EXCEPTION 'comment reaction source effective mutation ACL leaked';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY[
        pg_catalog.to_regprocedure('public.increment_comment_like_count(uuid)'),
        pg_catalog.to_regprocedure('public.decrement_comment_like_count(uuid)')
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
      pg_catalog.to_regprocedure('public.increment_comment_like_count(uuid)'),
      pg_catalog.to_regprocedure('public.decrement_comment_like_count(uuid)')
    )
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION 'legacy arithmetic comment counter RPC remains callable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname IN (
        'increment_comment_like_count',
        'decrement_comment_like_count'
      )
      AND function_row.oid IS DISTINCT FROM CASE function_row.proname
        WHEN 'increment_comment_like_count' THEN
          pg_catalog.to_regprocedure(
            'public.increment_comment_like_count(uuid)'
          )::oid
        WHEN 'decrement_comment_like_count' THEN
          pg_catalog.to_regprocedure(
            'public.decrement_comment_like_count(uuid)'
          )::oid
      END
  ) THEN
    RAISE EXCEPTION 'legacy arithmetic comment counter RPC overload remains';
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
  FROM public.comment_reaction_count_repair_queue AS repair_queue;

  WITH source_counts AS (
    SELECT reaction.comment_id,
           pg_catalog.count(*) FILTER (
             WHERE reaction.reaction_type = 'like'
           ) AS like_count,
           pg_catalog.count(*) FILTER (
             WHERE reaction.reaction_type = 'dislike'
           ) AS dislike_count
    FROM public.comment_likes AS reaction
    GROUP BY reaction.comment_id
  )
  SELECT pg_catalog.count(*) FILTER (
           WHERE target.like_count::bigint IS DISTINCT FROM
             COALESCE(source_counts.like_count, 0::bigint)
         ),
         pg_catalog.count(*) FILTER (
           WHERE target.dislike_count::bigint IS DISTINCT FROM
             COALESCE(source_counts.dislike_count, 0::bigint)
         ),
         pg_catalog.count(*) FILTER (
           WHERE target.like_count::bigint IS DISTINCT FROM
                   COALESCE(source_counts.like_count, 0::bigint)
              OR target.dislike_count::bigint IS DISTINCT FROM
                   COALESCE(source_counts.dislike_count, 0::bigint)
         )
  INTO v_like_drift_count,
       v_dislike_drift_count,
       v_drift_comment_count
  FROM public.comments AS target
  LEFT JOIN source_counts
    ON source_counts.comment_id = target.id;

  RAISE NOTICE
    'comment reaction repair report: backlog=%, due_backlog=%, oldest=%, oldest_age=%, max_attempt=%, drift_comments=%, like=%, dislike=%',
    v_backlog_count,
    v_due_backlog_count,
    v_oldest_enqueued_at,
    v_oldest_age,
    v_max_attempt_count,
    v_drift_comment_count,
    v_like_drift_count,
    v_dislike_drift_count;

  IF v_backlog_count > 1000 THEN
    RAISE EXCEPTION
      'comment reaction repair queue exceeded backlog limit: %',
      v_backlog_count;
  END IF;

  IF v_oldest_enqueued_at IS NOT NULL
     AND v_oldest_enqueued_at <
       pg_catalog.transaction_timestamp() - INTERVAL '15 minutes'
  THEN
    RAISE EXCEPTION
      'comment reaction repair queue exceeded fifteen-minute SLA: backlog %, oldest %, age %',
      v_backlog_count,
      v_oldest_enqueued_at,
      v_oldest_age;
  END IF;

  IF v_drift_comment_count <> 0 THEN
    RAISE EXCEPTION
      'comment reaction cached-counter drift remains: comments %, like %, dislike %',
      v_drift_comment_count,
      v_like_drift_count,
      v_dislike_drift_count;
  END IF;

  RAISE NOTICE 'comment reaction count repair attestation passed';
END
$attestation$;

DO $causal_attestation$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
  v_service_oid oid := pg_catalog.to_regrole('service_role');
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_base_function regprocedure := pg_catalog.to_regprocedure(
    'public.set_comment_reaction_desired_state_atomic(uuid,uuid,uuid,text)'
  );
  v_function regprocedure;
  v_expected record;
  v_relation regclass;
  v_source text;
  v_comment text;
  v_invalid text[];
  v_defaults text[];
  v_constraints text[];
  v_indexes text[];
  v_head_count bigint;
  v_operation_count bigint;
  v_expired_retention_count bigint;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
     OR v_postgres_oid IS NULL
     OR v_service_oid IS NULL
     OR v_plpgsql_oid IS NULL
     OR pg_catalog.to_regrole('anon') IS NULL
     OR pg_catalog.to_regrole('authenticated') IS NULL
     OR pg_catalog.to_regrole('authenticator') IS NULL
     OR pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR v_base_function IS NULL
     OR pg_catalog.to_regprocedure(
       'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.cleanup_comment_reaction_intents_atomic(integer)'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'public.comment_reaction_intent_heads'
     ) IS NULL
     OR pg_catalog.to_regclass(
       'public.comment_reaction_intent_operations'
     ) IS NULL
  THEN
    RAISE EXCEPTION
      'comment reaction causal contract foundations are incomplete';
  END IF;

  IF NOT COALESCE(
    (
      SELECT role_row.rolbypassrls AND NOT role_row.rolsuper
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_service_oid
    ),
    false
  ) OR pg_catalog.pg_has_role(
    v_service_oid,
    v_postgres_oid,
    'MEMBER'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname IN ('anon', 'authenticated', 'authenticator')
      AND (role_row.rolbypassrls OR role_row.rolsuper)
  ) THEN
    RAISE EXCEPTION 'comment reaction causal role boundary drifted';
  END IF;

  SELECT pg_catalog.array_agg(
    required.table_name || '.' || required.column_name
    ORDER BY required.table_name, required.ordinal
  )
  INTO v_invalid
  FROM (
    VALUES
      ('comment_reaction_intent_heads', 1, 'actor_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_heads', 2, 'comment_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_heads', 3, 'latest_issued_sequence', 'bigint'::pg_catalog.regtype, true),
      ('comment_reaction_intent_heads', 4, 'latest_applied_sequence', 'bigint'::pg_catalog.regtype, true),
      ('comment_reaction_intent_heads', 5, 'updated_at', 'timestamptz'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 1, 'actor_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 2, 'request_id', 'text'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 3, 'comment_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 4, 'post_id', 'uuid'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 5, 'intent_sequence', 'bigint'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 6, 'desired_reaction', 'text'::pg_catalog.regtype, false),
      ('comment_reaction_intent_operations', 7, 'intent_fingerprint', 'text'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 8, 'state', 'text'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 9, 'result', 'jsonb'::pg_catalog.regtype, false),
      ('comment_reaction_intent_operations', 10, 'issued_at', 'timestamptz'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 11, 'expires_at', 'timestamptz'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 12, 'retain_until', 'timestamptz'::pg_catalog.regtype, true),
      ('comment_reaction_intent_operations', 13, 'completed_at', 'timestamptz'::pg_catalog.regtype, false)
  ) AS required(table_name, ordinal, column_name, type_oid, not_null)
  LEFT JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = pg_catalog.to_regclass(
      'public.' || required.table_name
    )
   AND attribute.attnum = required.ordinal
   AND attribute.attname = required.column_name
   AND NOT attribute.attisdropped
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required.type_oid
     OR attribute.attnotnull IS DISTINCT FROM required.not_null;

  IF v_invalid IS NOT NULL
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
         'public.comment_reaction_intent_heads'::pg_catalog.regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) <> 5
     OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid =
         'public.comment_reaction_intent_operations'::pg_catalog.regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
     ) <> 13
  THEN
    RAISE EXCEPTION
      'comment reaction causal table columns drifted: %',
      v_invalid;
  END IF;

  SELECT pg_catalog.array_agg(
    relation.relname || '.' || attribute.attname || '=' ||
      pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid)
    ORDER BY relation.relname, attribute.attname
  )
  INTO v_defaults
  FROM pg_catalog.pg_attrdef AS default_row
  JOIN pg_catalog.pg_attribute AS attribute
    ON attribute.attrelid = default_row.adrelid
   AND attribute.attnum = default_row.adnum
  JOIN pg_catalog.pg_class AS relation
    ON relation.oid = default_row.adrelid
  WHERE default_row.adrelid IN (
    'public.comment_reaction_intent_heads'::pg_catalog.regclass,
    'public.comment_reaction_intent_operations'::pg_catalog.regclass
  );
  IF v_defaults IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_heads.latest_applied_sequence=0',
    'comment_reaction_intent_heads.latest_issued_sequence=0',
    'comment_reaction_intent_heads.updated_at=statement_timestamp()',
    'comment_reaction_intent_operations.issued_at=statement_timestamp()',
    'comment_reaction_intent_operations.state=''issued''::text'
  ]::text[] THEN
    RAISE EXCEPTION 'comment reaction causal table defaults drifted';
  END IF;

  SELECT pg_catalog.array_agg(
    constraint_row.conname ORDER BY constraint_row.conname
  )
  INTO STRICT v_constraints
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
    'public.comment_reaction_intent_heads'::pg_catalog.regclass;
  IF v_constraints IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_heads_actor_fkey',
    'comment_reaction_intent_heads_comment_fkey',
    'comment_reaction_intent_heads_pkey',
    'comment_reaction_intent_heads_sequence_check'
  ]::text[] OR (
    SELECT pg_catalog.md5(pg_catalog.string_agg(
      constraint_row.conname || ':' ||
        pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
      E'\n' ORDER BY constraint_row.conname
    ))
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.comment_reaction_intent_heads'::pg_catalog.regclass
  ) IS DISTINCT FROM '7c5eaa3f9fc4a9a682ce5ede3fd1a6ca' THEN
    RAISE EXCEPTION 'comment reaction causal head constraints drifted';
  END IF;

  SELECT pg_catalog.array_agg(
    constraint_row.conname ORDER BY constraint_row.conname
  )
  INTO STRICT v_constraints
  FROM pg_catalog.pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
    'public.comment_reaction_intent_operations'::pg_catalog.regclass;
  IF v_constraints IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_operations_desired_check',
    'comment_reaction_intent_operations_fingerprint_check',
    'comment_reaction_intent_operations_head_fkey',
    'comment_reaction_intent_operations_pkey',
    'comment_reaction_intent_operations_request_check',
    'comment_reaction_intent_operations_result_check',
    'comment_reaction_intent_operations_sequence_check',
    'comment_reaction_intent_operations_sequence_key',
    'comment_reaction_intent_operations_state_check',
    'comment_reaction_intent_operations_time_check'
  ]::text[] OR (
    SELECT pg_catalog.md5(pg_catalog.string_agg(
      constraint_row.conname || ':' ||
        pg_catalog.pg_get_constraintdef(constraint_row.oid, false),
      E'\n' ORDER BY constraint_row.conname
    ))
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.comment_reaction_intent_operations'::pg_catalog.regclass
  ) IS DISTINCT FROM '7c85c4c638d898935eec524084a73b6e' THEN
    RAISE EXCEPTION 'comment reaction causal operation constraints drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid IN (
      'public.comment_reaction_intent_heads'::pg_catalog.regclass,
      'public.comment_reaction_intent_operations'::pg_catalog.regclass
    )
      AND NOT constraint_row.convalidated
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conname =
      'comment_reaction_intent_heads_actor_fkey'
      AND constraint_row.conrelid =
        'public.comment_reaction_intent_heads'::pg_catalog.regclass
      AND constraint_row.confrelid = 'auth.users'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'c'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conname =
      'comment_reaction_intent_heads_comment_fkey'
      AND constraint_row.conrelid =
        'public.comment_reaction_intent_heads'::pg_catalog.regclass
      AND constraint_row.confrelid = 'public.comments'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'c'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conname =
      'comment_reaction_intent_operations_head_fkey'
      AND constraint_row.conrelid =
        'public.comment_reaction_intent_operations'::pg_catalog.regclass
      AND constraint_row.confrelid =
        'public.comment_reaction_intent_heads'::pg_catalog.regclass
      AND constraint_row.confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'comment reaction causal foreign-key boundary drifted';
  END IF;

  SELECT pg_catalog.array_agg(index_row.relname ORDER BY index_row.relname)
  INTO STRICT v_indexes
  FROM pg_catalog.pg_index AS index_metadata
  JOIN pg_catalog.pg_class AS index_row
    ON index_row.oid = index_metadata.indexrelid
  WHERE index_metadata.indrelid =
    'public.comment_reaction_intent_heads'::pg_catalog.regclass
    AND index_metadata.indisvalid
    AND index_metadata.indisready;
  IF v_indexes IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_heads_cleanup_idx',
    'comment_reaction_intent_heads_pkey'
  ]::text[] OR (
    SELECT pg_catalog.md5(pg_catalog.string_agg(
      index_row.relname || ':' ||
        pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 0, false),
      E'\n' ORDER BY index_row.relname
    ))
    FROM pg_catalog.pg_index AS index_metadata
    JOIN pg_catalog.pg_class AS index_row
      ON index_row.oid = index_metadata.indexrelid
    WHERE index_metadata.indrelid =
      'public.comment_reaction_intent_heads'::pg_catalog.regclass
  ) IS DISTINCT FROM '6db551c8f0e870195efb3e5341e0050a' THEN
    RAISE EXCEPTION 'comment reaction causal head indexes drifted';
  END IF;

  SELECT pg_catalog.array_agg(index_row.relname ORDER BY index_row.relname)
  INTO STRICT v_indexes
  FROM pg_catalog.pg_index AS index_metadata
  JOIN pg_catalog.pg_class AS index_row
    ON index_row.oid = index_metadata.indexrelid
  WHERE index_metadata.indrelid =
    'public.comment_reaction_intent_operations'::pg_catalog.regclass
    AND index_metadata.indisvalid
    AND index_metadata.indisready;
  IF v_indexes IS DISTINCT FROM ARRAY[
    'comment_reaction_intent_operations_pkey',
    'comment_reaction_intent_operations_retention_idx',
    'comment_reaction_intent_operations_sequence_key'
  ]::text[] OR (
    SELECT pg_catalog.md5(pg_catalog.string_agg(
      index_row.relname || ':' ||
        pg_catalog.pg_get_indexdef(index_metadata.indexrelid, 0, false),
      E'\n' ORDER BY index_row.relname
    ))
    FROM pg_catalog.pg_index AS index_metadata
    JOIN pg_catalog.pg_class AS index_row
      ON index_row.oid = index_metadata.indexrelid
    WHERE index_metadata.indrelid =
      'public.comment_reaction_intent_operations'::pg_catalog.regclass
  ) IS DISTINCT FROM '1a0886f337f4c19cdd9b46c42a130b2b' THEN
    RAISE EXCEPTION 'comment reaction causal operation indexes drifted';
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'public.comment_reaction_intent_heads'::pg_catalog.regclass,
    'public.comment_reaction_intent_operations'::pg_catalog.regclass
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
        AND relation.relrowsecurity
        AND relation.relforcerowsecurity
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy_row
      WHERE policy_row.polrelid = v_relation
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_relation
        AND NOT trigger_row.tgisinternal
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_inherits AS inheritance
      WHERE inheritance.inhrelid = v_relation
         OR inheritance.inhparent = v_relation
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_class AS relation
      CROSS JOIN LATERAL pg_catalog.aclexplode(
        COALESCE(
          relation.relacl,
          pg_catalog.acldefault('r', relation.relowner)
        )
      ) AS acl_entry
      WHERE relation.oid = v_relation
        AND acl_entry.grantee <> relation.relowner
    ) OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
      WHERE attribute.attrelid = v_relation
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND acl_entry.grantee <> relation.relowner
    ) THEN
      RAISE EXCEPTION
        'comment reaction causal private table boundary drifted: %',
        v_relation;
    END IF;
  END LOOP;

  IF pg_catalog.obj_description(
    'public.comment_reaction_intent_heads'::pg_catalog.regclass,
    'pg_class'
  ) IS DISTINCT FROM
    'Bounded actor/comment reservation-order head. Sequence order is server reservation order, not physical click time.'
     OR pg_catalog.obj_description(
       'public.comment_reaction_intent_operations'::pg_catalog.regclass,
       'pg_class'
     ) IS DISTINCT FROM
       'Private replay and causal-ticket ledger with bounded retention and account/comment cascade.'
  THEN
    RAISE EXCEPTION 'comment reaction causal table comments drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'set_comment_reaction_desired_state_atomic',
        'reserve_comment_reaction_intent_atomic',
        'set_comment_reaction_desired_state_causal_atomic',
        'cleanup_comment_reaction_intents_atomic'
      )
  ) <> 4 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'set_comment_reaction_desired_state_atomic',
        'reserve_comment_reaction_intent_atomic',
        'set_comment_reaction_desired_state_causal_atomic',
        'cleanup_comment_reaction_intents_atomic'
      )
      AND function_row.oid NOT IN (
        v_base_function::oid,
        'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)'::pg_catalog.regprocedure::oid,
        'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)'::pg_catalog.regprocedure::oid,
        'public.cleanup_comment_reaction_intents_atomic(integer)'::pg_catalog.regprocedure::oid
      )
  ) THEN
    RAISE EXCEPTION
      'comment reaction desired-state function surface drifted';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_base_function
    AND function_row.proowner = v_postgres_oid
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prolang = v_plpgsql_oid
    AND NOT function_row.proisstrict
    AND function_row.proparallel = 'u'
    AND NOT function_row.proleakproof
    AND function_row.pronargs = 4
    AND function_row.pronargdefaults = 0
    AND function_row.proargnames = ARRAY[
      'p_actor_id',
      'p_post_id',
      'p_comment_id',
      'p_desired_reaction'
    ]::text[]
    AND pg_catalog.cardinality(function_row.proconfig) = 4
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=15s'
    ]::text[];
  IF pg_catalog.md5(v_source) IS DISTINCT FROM
       '2c40ab0522cd0afceb7bbc6a44e29a09'
     OR v_comment IS DISTINCT FROM
       'comment-reaction-desired-state:v1:2c40ab0522cd0afceb7bbc6a44e29a09'
     OR NOT pg_catalog.has_function_privilege(
       v_postgres_oid,
       v_base_function,
       'EXECUTE'
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
       WHERE function_row.oid = v_base_function
         AND acl_entry.grantee <> function_row.proowner
     )
  THEN
    RAISE EXCEPTION
      'legacy comment reaction desired-state authority is not sealed owner-only';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.reserve_comment_reaction_intent_atomic(uuid,uuid,uuid,text,text)',
          ARRAY['p_actor_id', 'p_post_id', 'p_comment_id', 'p_request_id', 'p_desired_reaction']::text[],
          0,
          'comment-reaction-causal-intent:reserve-v1:',
          '2fdaa03887397d4e3c0222d771328c1b'
        ),
        (
          'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)',
          ARRAY['p_actor_id', 'p_post_id', 'p_comment_id', 'p_request_id', 'p_intent_sequence', 'p_desired_reaction']::text[],
          0,
          'comment-reaction-causal-intent:apply-v1:',
          'bd71579634a5312dd8af6093235b2bf8'
        ),
        (
          'public.cleanup_comment_reaction_intents_atomic(integer)',
          ARRAY['p_limit']::text[],
          1,
          'comment-reaction-causal-intent:cleanup-v1:',
          'c9d0d109b295740e1f6b47d45e523c6b'
        )
    ) AS expected(
      signature,
      argument_names,
      argument_defaults,
      source_prefix,
      source_digest
    )
  LOOP
    v_function := pg_catalog.to_regprocedure(v_expected.signature);
    SELECT function_row.prosrc,
           pg_catalog.obj_description(function_row.oid, 'pg_proc')
    INTO STRICT v_source, v_comment
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prolang = v_plpgsql_oid
      AND NOT function_row.proisstrict
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.pronargs =
        pg_catalog.cardinality(v_expected.argument_names)
      AND function_row.pronargdefaults = v_expected.argument_defaults
      AND function_row.proargnames = v_expected.argument_names
      AND pg_catalog.cardinality(function_row.proconfig) = 4
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
        'lock_timeout=5s',
        'statement_timeout=15s'
      ]::text[];
    IF pg_catalog.md5(v_source) IS DISTINCT FROM v_expected.source_digest
       OR v_comment IS DISTINCT FROM
         v_expected.source_prefix || v_expected.source_digest
       OR NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(
           COALESCE(
             function_row.proacl,
             pg_catalog.acldefault('f', function_row.proowner)
           )
         ) AS acl_entry
         WHERE function_row.oid = v_function
           AND acl_entry.grantee = v_service_oid
           AND acl_entry.privilege_type = 'EXECUTE'
           AND NOT acl_entry.is_grantable
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
           AND (
             acl_entry.privilege_type <> 'EXECUTE'
             OR acl_entry.grantee NOT IN (
               function_row.proowner,
               v_service_oid
             )
             OR (
               acl_entry.grantee = v_service_oid
               AND acl_entry.is_grantable
             )
           )
       )
    THEN
      RAISE EXCEPTION
        'causal comment reaction authority drifted: %',
        v_expected.signature;
    END IF;

    IF v_expected.signature =
         'public.set_comment_reaction_desired_state_causal_atomic(uuid,uuid,uuid,text,bigint,text)'
       AND pg_catalog.strpos(
         v_source,
         'public.set_comment_reaction_desired_state_atomic('
       ) = 0
    THEN
      RAISE EXCEPTION
        'causal comment reaction composition drifted';
    END IF;
  END LOOP;

  SELECT pg_catalog.count(*)
  INTO STRICT v_head_count
  FROM public.comment_reaction_intent_heads;
  SELECT pg_catalog.count(*),
         pg_catalog.count(*) FILTER (
           WHERE operation_row.retain_until <
             pg_catalog.transaction_timestamp()
         )
  INTO STRICT v_operation_count, v_expired_retention_count
  FROM public.comment_reaction_intent_operations AS operation_row;

  RAISE NOTICE
    'comment reaction causal contract report: heads=%, operations=%, retention_due=%',
    v_head_count,
    v_operation_count,
    v_expired_retention_count;
  RAISE NOTICE
    'comment reaction causal intent and legacy closure attestation passed';
END
$causal_attestation$;

ROLLBACK;
