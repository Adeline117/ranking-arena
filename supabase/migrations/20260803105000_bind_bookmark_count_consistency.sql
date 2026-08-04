-- Migration: 20260803105000_bind_bookmark_count_consistency.sql
-- Created: 2026-08-03T10:50:00Z
-- Description: Put every first-party bookmark writer in the shared post
--   counter lock domain and extend the durable interaction repair obligation
--   to posts.bookmark_count. Cascade/direct row DML stays lock-inversion safe:
--   child triggers enqueue only, while the bounded worker owns P -> posts -> Q.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.post-bookmark-count-consistency:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'post bookmark count consistency migration lock is busy';
  END IF;
END
$migration_lock$;

DO $foundations$
DECLARE
  v_missing_roles text[];
  v_relation text;
  v_signature text;
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

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'post bookmark consistency roles are missing: %',
      v_missing_roles;
  END IF;

  FOREACH v_relation IN ARRAY ARRAY[
    'auth.users',
    'public.user_profiles',
    'public.posts',
    'public.bookmark_folders',
    'public.post_bookmarks',
    'public.post_likes',
    'public.post_votes',
    'public.post_interaction_count_repair_queue'
  ]::text[]
  LOOP
    IF pg_catalog.to_regclass(v_relation) IS NULL THEN
      RAISE EXCEPTION 'post bookmark consistency relation is missing: %',
        v_relation;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'auth.uid()',
    'auth.role()',
    'public.lock_actor_can_interact_with_post(uuid,uuid)',
    'public.enforce_current_post_child_interaction()',
    'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)',
    'public.save_post_bookmark_to_folder_atomic(uuid,uuid)',
    'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)',
    'public.toggle_post_reaction(uuid,uuid,text)',
    'public.set_post_reaction_desired_state_atomic(uuid,uuid,text)',
    'public.toggle_post_vote_atomic(uuid,uuid,text)',
    'public.set_post_vote_desired_state_atomic(uuid,uuid,text)',
    'public.enqueue_post_interaction_count_repair()',
    'public.repair_post_interaction_counts_atomic(integer)'
  ]::text[]
  LOOP
    IF pg_catalog.to_regprocedure(v_signature) IS NULL THEN
      RAISE EXCEPTION 'post bookmark consistency function is missing: %',
        v_signature;
    END IF;
  END LOOP;
END
$foundations$;

-- Match identity deletion and live post/folder writers while closing the
-- preflight/DDL/backfill gap. The queue is last because runtime repair owns it
-- only after the canonical post advisory and posts row locks.
LOCK TABLE auth.users,
  public.posts,
  public.bookmark_folders,
  public.post_likes,
  public.post_votes,
  public.post_bookmarks,
  public.post_interaction_count_repair_queue
IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
  v_relation regclass;
  v_column record;
  v_fk record;
  v_function regprocedure;
  v_source text;
  v_trigger record;
BEGIN
  FOREACH v_relation IN ARRAY ARRAY[
    'public.posts'::pg_catalog.regclass,
    'public.bookmark_folders'::pg_catalog.regclass,
    'public.post_bookmarks'::pg_catalog.regclass,
    'public.post_interaction_count_repair_queue'::pg_catalog.regclass
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
        'post bookmark consistency requires canonical permanent relation: %',
        v_relation;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
  ) OR (
    SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY attribute.attnum)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) IS DISTINCT FROM ARRAY[
    'post_id',
    'enqueued_at',
    'next_attempt_at',
    'attempt_count'
  ]::text[] THEN
    RAISE EXCEPTION '1040 repair queue relation/column/RLS contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
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
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attname = 'enqueued_at'
      AND attribute.atttypid = 'timestamptz'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) =
        'statement_timestamp()'
  ) THEN
    RAISE EXCEPTION '1040 repair queue post/enqueued column shape drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum::smallint
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'post_id'
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
        )
      ]::smallint[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND constraint_row.contype = 'f'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'CHECK (attempt_count >= 0 AND attempt_count <= 1000000)'
  ) THEN
    RAISE EXCEPTION '1040 repair queue PK/FK/backoff CHECK contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attname = 'next_attempt_at'
      AND attribute.atttypid = 'timestamptz'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) =
        'statement_timestamp()'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::pg_catalog.regclass
      AND attribute.attname = 'attempt_count'
      AND attribute.atttypid = 'integer'::pg_catalog.regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) = '0'
  ) THEN
    RAISE EXCEPTION '1040 repair queue retry defaults drifted';
  END IF;

  IF NOT EXISTS (
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
      AND index_row.indrelid =
        'public.post_interaction_count_repair_queue'::pg_catalog.regclass
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
    RAISE EXCEPTION '1040 repair queue ordering index drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    WHERE pg_catalog.has_any_column_privilege(
            role_name,
            'public.post_interaction_count_repair_queue',
            'SELECT,INSERT,UPDATE,REFERENCES'
          )
       OR pg_catalog.has_table_privilege(
            role_name,
            'public.post_interaction_count_repair_queue',
            'DELETE,TRUNCATE,TRIGGER'
          )
  ) THEN
    RAISE EXCEPTION '1040 repair queue private ACL drifted';
  END IF;

  FOR v_column IN
    SELECT *
    FROM (
      VALUES
        ('public.posts'::pg_catalog.regclass, 'id', 'uuid'::pg_catalog.regtype, true),
        ('public.posts'::pg_catalog.regclass, 'bookmark_count', 'integer'::pg_catalog.regtype, false),
        ('public.post_bookmarks'::pg_catalog.regclass, 'id', 'uuid'::pg_catalog.regtype, true),
        ('public.post_bookmarks'::pg_catalog.regclass, 'post_id', 'uuid'::pg_catalog.regtype, true),
        ('public.post_bookmarks'::pg_catalog.regclass, 'user_id', 'uuid'::pg_catalog.regtype, true),
        ('public.post_bookmarks'::pg_catalog.regclass, 'folder_id', 'uuid'::pg_catalog.regtype, false),
        ('public.bookmark_folders'::pg_catalog.regclass, 'id', 'uuid'::pg_catalog.regtype, true),
        ('public.bookmark_folders'::pg_catalog.regclass, 'user_id', 'uuid'::pg_catalog.regtype, true)
    ) AS required_column(relation_oid, column_name, type_oid, required_not_null)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = v_column.relation_oid
        AND attribute.attname = v_column.column_name
        AND attribute.atttypid = v_column.type_oid
        AND (
          NOT v_column.required_not_null
          OR attribute.attnotnull
        )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
    ) THEN
      RAISE EXCEPTION 'post bookmark consistency column drifted: %.%',
        v_column.relation_oid,
        v_column.column_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'public.post_bookmarks'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND (
        SELECT pg_catalog.array_agg(
          attribute.attname::text ORDER BY attribute.attname
        )
        FROM pg_catalog.unnest(index_row.indkey::smallint[])
          WITH ORDINALITY AS key_column(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key_column.attnum
      ) = ARRAY['post_id', 'user_id']::text[]
  ) THEN
    RAISE EXCEPTION
      'post_bookmarks requires exact valid UNIQUE (post_id, user_id)';
  END IF;

  FOR v_fk IN
    SELECT *
    FROM (
      VALUES
        (
          'public.post_bookmarks'::pg_catalog.regclass,
          'post_id',
          'public.posts'::pg_catalog.regclass,
          'id'
        ),
        (
          'public.post_bookmarks'::pg_catalog.regclass,
          'user_id',
          'auth.users'::pg_catalog.regclass,
          'id'
        ),
        (
          'public.post_bookmarks'::pg_catalog.regclass,
          'folder_id',
          'public.bookmark_folders'::pg_catalog.regclass,
          'id'
        )
    ) AS expected_fk(child_relation, child_column, parent_relation, parent_column)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = v_fk.child_relation
        AND constraint_row.contype = 'f'
        AND constraint_row.convalidated
        AND constraint_row.confrelid = v_fk.parent_relation
        AND constraint_row.confdeltype = 'c'
        AND constraint_row.conkey = ARRAY[
          (
            SELECT attribute.attnum::smallint
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = v_fk.child_relation
              AND attribute.attname = v_fk.child_column
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
          )
        ]::smallint[]
        AND constraint_row.confkey = ARRAY[
          (
            SELECT attribute.attnum::smallint
            FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = v_fk.parent_relation
              AND attribute.attname = v_fk.parent_column
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
          )
        ]::smallint[]
    ) THEN
      RAISE EXCEPTION 'post bookmark cascade FK drifted: %.% -> %.%',
        v_fk.child_relation,
        v_fk.child_column,
        v_fk.parent_relation,
        v_fk.parent_column;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.post_bookmarks'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_post_bookmarks_15_current_interaction'
      AND trigger_row.tgfoid =
        'public.enforce_current_post_child_interaction()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND (trigger_row.tgtype & 1) = 1
      AND (trigger_row.tgtype & 2) = 2
      AND (trigger_row.tgtype & 4) = 4
      AND (trigger_row.tgtype & 16) = 16
  ) THEN
    RAISE EXCEPTION 'post_bookmarks audience mutation guard drifted';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.save_post_bookmark_to_folder_atomic(uuid,uuid)'::pg_catalog.regprocedure,
    'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef
      AND function_row.provolatile = 'v';

    IF pg_catalog.strpos(v_source, '''post-bookmark:''') = 0
       OR pg_catalog.strpos(v_source, 'FROM public.post_bookmarks') = 0
       OR pg_catalog.strpos(v_source, 'bookmark_count') = 0
       OR pg_catalog.strpos(v_source, 'UPDATE public.posts') = 0
    THEN
      RAISE EXCEPTION 'bookmark authority source drifted: %', v_function;
    END IF;

  END LOOP;

  FOREACH v_function IN ARRAY ARRAY[
    'public.toggle_post_reaction(uuid,uuid,text)'::regprocedure,
    'public.set_post_reaction_desired_state_atomic(uuid,uuid,text)'::regprocedure,
    'public.toggle_post_vote_atomic(uuid,uuid,text)'::regprocedure,
    'public.set_post_vote_desired_state_atomic(uuid,uuid,text)'::regprocedure
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
       OR pg_catalog.strpos(v_source, 'UPDATE public.posts') = 0
    THEN
      RAISE EXCEPTION 'reaction/vote shared P authority drifted: %', v_function;
    END IF;
  END LOOP;

  FOR v_trigger IN
    SELECT *
    FROM (
      VALUES
        (
          'public.post_likes'::regclass,
          'trg_post_likes_90_enqueue_count_repair',
          ARRAY['post_id', 'reaction_type']::text[],
          true
        ),
        (
          'public.post_votes'::regclass,
          'trg_post_votes_90_enqueue_count_repair',
          ARRAY['post_id', 'choice']::text[],
          true
        ),
        (
          'public.post_bookmarks'::regclass,
          'trg_post_bookmarks_90_enqueue_count_repair',
          ARRAY['post_id']::text[],
          false
        )
    ) AS expected_trigger(
      relation_oid,
      trigger_name,
      column_names,
      required_before_cutover
    )
  LOOP
    IF (
      v_trigger.required_before_cutover
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS named_trigger
        WHERE named_trigger.tgrelid = v_trigger.relation_oid
          AND named_trigger.tgname = v_trigger.trigger_name
          AND NOT named_trigger.tgisinternal
      )
    ) AND NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_trigger.relation_oid
        AND trigger_row.tgname = v_trigger.trigger_name
        AND trigger_row.tgfoid =
          'public.enqueue_post_interaction_count_repair()'::regprocedure
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
        AND (trigger_row.tgtype & 1) = 1
        AND (trigger_row.tgtype & 2) = 0
        AND (trigger_row.tgtype & 4) = 4
        AND (trigger_row.tgtype & 8) = 8
        AND (trigger_row.tgtype & 16) = 16
        AND trigger_row.tgqual IS NULL
        AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) =
          pg_catalog.cardinality(v_trigger.column_names)
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(v_trigger.column_names)
            AS expected_column(column_name)
          WHERE NOT (
            trigger_row.tgattr::smallint[] @> ARRAY[
              (
                SELECT attribute.attnum::smallint
                FROM pg_catalog.pg_attribute AS attribute
                WHERE attribute.attrelid = v_trigger.relation_oid
                  AND attribute.attname = expected_column.column_name
                  AND attribute.attnum > 0
                  AND NOT attribute.attisdropped
              )
            ]::smallint[]
          )
        )
    ) THEN
      RAISE EXCEPTION '1040 source repair trigger drifted: %',
        v_trigger.trigger_name;
    END IF;
  END LOOP;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.repair_post_interaction_counts_atomic(integer)'::regprocedure
    AND function_row.prokind = 'f'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef;

  IF pg_catalog.strpos(v_source, '''post-reaction-counts:''') = 0
     OR pg_catalog.strpos(v_source, 'p_limit IS DISTINCT FROM 1') = 0
     OR pg_catalog.strpos(v_source, 'FROM public.posts AS locked_post') = 0
     OR pg_catalog.strpos(v_source, 'INTO v_claimed_post_id') = 0
     OR pg_catalog.strpos(v_source, 'next_attempt_at') = 0
  THEN
    RAISE EXCEPTION '1040 bounded repair worker contract drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'toggle_post_bookmark_atomic',
        'save_post_bookmark_to_folder_atomic',
        'remove_post_bookmark_from_folder_atomic',
        'enqueue_post_interaction_count_repair',
        'repair_post_interaction_counts_atomic'
      )
      AND function_row.oid NOT IN (
        'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)'::regprocedure,
        'public.save_post_bookmark_to_folder_atomic(uuid,uuid)'::regprocedure,
        'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'::regprocedure,
        'public.enqueue_post_interaction_count_repair()'::regprocedure,
        'public.repair_post_interaction_counts_atomic(integer)'::regprocedure
      )
  ) THEN
    RAISE EXCEPTION 'post bookmark consistency overload set drifted';
  END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.toggle_post_bookmark_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_folder_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_existing_id uuid;
  v_existing_folder_id uuid;
  v_folder_id uuid := p_folder_id;
  v_action text;
  v_count bigint;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_actor_id IS NULL OR p_post_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-reaction-counts:' || p_post_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-bookmark:' || p_post_id::text || ':' || p_actor_id::text,
      0
    )
  );

  PERFORM 1
  FROM auth.users AS actor_account
  WHERE actor_account.id = p_actor_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF NOT public.lock_actor_can_interact_with_post(p_post_id, p_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Explicit-folder toggles always establish folder -> child order. This is
  -- compatible with folder deletion, whose FK cascade also owns F -> child.
  IF p_folder_id IS NOT NULL THEN
    PERFORM 1
    FROM public.bookmark_folders AS folder
    WHERE folder.id = p_folder_id
      AND folder.user_id = p_actor_id
    FOR SHARE;
    IF NOT FOUND THEN
      RETURN pg_catalog.jsonb_build_object('status', 'invalid_folder');
    END IF;
  END IF;

  SELECT bookmark.id, bookmark.folder_id
  INTO v_existing_id, v_existing_folder_id
  FROM public.post_bookmarks AS bookmark
  WHERE bookmark.post_id = p_post_id
    AND bookmark.user_id = p_actor_id
  FOR UPDATE;

  IF FOUND
    AND (p_folder_id IS NULL OR p_folder_id IS NOT DISTINCT FROM v_existing_folder_id)
  THEN
    DELETE FROM public.post_bookmarks WHERE id = v_existing_id;
    v_action := 'removed';
    v_folder_id := NULL;
  ELSE
    IF v_folder_id IS NULL THEN
      -- This branch is reachable only when no child row was found, so it never
      -- holds child -> folder while resolving the default folder.
      PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('bookmark-default:' || p_actor_id::text, 0)
      );
      SELECT folder.id
      INTO v_folder_id
      FROM public.bookmark_folders AS folder
      WHERE folder.user_id = p_actor_id
        AND folder.is_default
      ORDER BY folder.created_at, folder.id
      LIMIT 1
      FOR SHARE;
      IF NOT FOUND THEN
        INSERT INTO public.bookmark_folders (user_id, name, is_default)
        VALUES (p_actor_id, 'Default', true)
        RETURNING id INTO v_folder_id;
      END IF;
    END IF;

    IF v_existing_id IS NULL THEN
      INSERT INTO public.post_bookmarks (post_id, user_id, folder_id)
      VALUES (p_post_id, p_actor_id, v_folder_id);
      v_action := 'added';
    ELSE
      UPDATE public.post_bookmarks
      SET folder_id = v_folder_id
      WHERE id = v_existing_id;
      v_action := 'moved';
    END IF;
  END IF;

  SELECT pg_catalog.count(*)
  INTO STRICT v_count
  FROM public.post_bookmarks AS bookmark
  WHERE bookmark.post_id = p_post_id;

  IF v_count > 2147483647 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22003',
      MESSAGE = 'post bookmark counter exceeds integer range';
  END IF;

  UPDATE public.posts
  SET bookmark_count = v_count::integer
  WHERE id = p_post_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_action,
    'action', v_action,
    'bookmarked', v_action <> 'removed',
    'bookmark_count', v_count,
    'folder_id', v_folder_id
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.save_post_bookmark_to_folder_atomic(
  p_post_id uuid,
  p_folder_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_actor_id uuid := (SELECT auth.uid());
  v_folder record;
  v_bookmark_id uuid;
  v_existing_folder_id uuid;
  v_bookmark_count bigint;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'authenticated role required' USING ERRCODE = '42501';
  END IF;

  IF v_actor_id IS NULL OR p_post_id IS NULL OR p_folder_id IS NULL THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-reaction-counts:' || p_post_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-bookmark:' || p_post_id::text || ':' || v_actor_id::text,
      0
    )
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_actor_id::text,
      0
    )
  );

  PERFORM actor_account.id
  FROM auth.users AS actor_account
  WHERE actor_account.id = v_actor_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id = v_actor_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL
    AND NOT (
      profile.is_banned IS TRUE
      AND (
        profile.ban_expires_at IS NULL
        OR profile.ban_expires_at > pg_catalog.clock_timestamp()
      )
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  IF NOT public.lock_actor_can_interact_with_post(p_post_id, v_actor_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'post_not_found');
  END IF;

  SELECT folder.id, COALESCE(folder.is_default, false) AS is_default
  INTO v_folder
  FROM public.bookmark_folders AS folder
  WHERE folder.id = p_folder_id
    AND folder.user_id = v_actor_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'folder_not_found');
  END IF;

  SELECT bookmark.id, bookmark.folder_id
  INTO v_bookmark_id, v_existing_folder_id
  FROM public.post_bookmarks AS bookmark
  WHERE bookmark.post_id = p_post_id
    AND bookmark.user_id = v_actor_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.post_bookmarks (post_id, user_id, folder_id)
    VALUES (p_post_id, v_actor_id, p_folder_id)
    RETURNING id INTO v_bookmark_id;
    v_status := 'added';
  ELSIF v_existing_folder_id IS NOT DISTINCT FROM p_folder_id
    OR (v_folder.is_default AND v_existing_folder_id IS NULL)
  THEN
    v_status := 'already_saved';
  ELSE
    UPDATE public.post_bookmarks AS bookmark
    SET folder_id = p_folder_id
    WHERE bookmark.id = v_bookmark_id
      AND bookmark.user_id = v_actor_id
      AND bookmark.post_id = p_post_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'bookmark move mutated an impossible row count';
    END IF;
    v_status := 'moved';
  END IF;

  SELECT pg_catalog.count(*)
  INTO STRICT v_bookmark_count
  FROM public.post_bookmarks AS bookmark
  WHERE bookmark.post_id = p_post_id;

  IF v_bookmark_count > 2147483647 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22003',
      MESSAGE = 'post bookmark counter exceeds integer range';
  END IF;

  UPDATE public.posts AS post
  SET bookmark_count = v_bookmark_count::integer
  WHERE post.id = p_post_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_status,
    'user_id', v_actor_id,
    'post_id', p_post_id,
    'bookmark_id', v_bookmark_id,
    'folder_id', p_folder_id,
    'bookmarked', true,
    'bookmark_count', v_bookmark_count
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.remove_post_bookmark_from_folder_atomic(
  p_post_id uuid,
  p_bookmark_id uuid,
  p_folder_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '15s'
AS $function$
DECLARE
  v_actor_id uuid := (SELECT auth.uid());
  v_folder record;
  v_bookmark record;
  v_bookmark_count bigint;
  v_deleted integer;
  v_status text;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION 'authenticated role required' USING ERRCODE = '42501';
  END IF;

  IF v_actor_id IS NULL
    OR p_post_id IS NULL
    OR p_bookmark_id IS NULL
    OR p_folder_id IS NULL
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-reaction-counts:' || p_post_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-bookmark:' || p_post_id::text || ':' || v_actor_id::text,
      0
    )
  );

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'account-recovery-admission:' || v_actor_id::text,
      0
    )
  );

  PERFORM actor_account.id
  FROM auth.users AS actor_account
  WHERE actor_account.id = v_actor_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  PERFORM profile.id
  FROM public.user_profiles AS profile
  WHERE profile.id = v_actor_id
    AND profile.deleted_at IS NULL
    AND profile.banned_at IS NULL
    AND NOT (
      profile.is_banned IS TRUE
      AND (
        profile.ban_expires_at IS NULL
        OR profile.ban_expires_at > pg_catalog.clock_timestamp()
      )
    )
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  SELECT folder.id, COALESCE(folder.is_default, false) AS is_default
  INTO v_folder
  FROM public.bookmark_folders AS folder
  WHERE folder.id = p_folder_id
    AND folder.user_id = v_actor_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'folder_not_found');
  END IF;

  SELECT bookmark.id, bookmark.folder_id
  INTO v_bookmark
  FROM public.post_bookmarks AS bookmark
  WHERE bookmark.user_id = v_actor_id
    AND bookmark.post_id = p_post_id
  FOR UPDATE;

  IF NOT FOUND THEN
    v_status := 'already_removed';
  ELSIF v_bookmark.id IS DISTINCT FROM p_bookmark_id
    OR NOT (
      v_bookmark.folder_id IS NOT DISTINCT FROM p_folder_id
      OR (v_folder.is_default AND v_bookmark.folder_id IS NULL)
    )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'conflict');
  ELSE
    DELETE FROM public.post_bookmarks AS bookmark
    WHERE bookmark.id = p_bookmark_id
      AND bookmark.user_id = v_actor_id
      AND bookmark.post_id = p_post_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    IF v_deleted IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION 'bookmark removal mutated an impossible row count';
    END IF;
    v_status := 'removed';
  END IF;

  SELECT pg_catalog.count(*)
  INTO STRICT v_bookmark_count
  FROM public.post_bookmarks AS bookmark
  WHERE bookmark.post_id = p_post_id;

  IF v_bookmark_count > 2147483647 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22003',
      MESSAGE = 'post bookmark counter exceeds integer range';
  END IF;

  UPDATE public.posts AS post
  SET bookmark_count = v_bookmark_count::integer
  WHERE post.id = p_post_id;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_status,
    'user_id', v_actor_id,
    'post_id', p_post_id,
    'bookmark_id', p_bookmark_id,
    'folder_id', p_folder_id,
    'bookmarked', false,
    'bookmark_count', v_bookmark_count
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.enqueue_post_interaction_count_repair()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_post_id uuid;
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME NOT IN ('post_likes', 'post_votes', 'post_bookmarks')
     OR TG_OP NOT IN ('INSERT', 'UPDATE', 'DELETE')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post interaction count repair trigger is attached incorrectly';
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.post_id IS DISTINCT FROM NEW.post_id
  THEN
    INSERT INTO public.post_interaction_count_repair_queue (post_id)
    VALUES (OLD.post_id)
    ON CONFLICT (post_id) DO NOTHING;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_post_id := OLD.post_id;
  ELSE
    v_post_id := NEW.post_id;
  END IF;

  INSERT INTO public.post_interaction_count_repair_queue (post_id)
  VALUES (v_post_id)
  ON CONFLICT (post_id) DO NOTHING;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION public.repair_post_interaction_counts_atomic(
  p_limit integer DEFAULT 1
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
SET lock_timeout = '5s'
SET statement_timeout = '30s'
AS $function$
DECLARE
  v_candidates uuid[];
  v_post_id uuid;
  v_locked_post_id uuid;
  v_claimed_post_id uuid;
  v_post_still_exists boolean;
  v_like_count bigint;
  v_dislike_count bigint;
  v_bull_count bigint;
  v_bear_count bigint;
  v_wait_count bigint;
  v_bookmark_count bigint;
  v_selected_count integer := 0;
  v_processed_count integer := 0;
  v_repaired_count integer := 0;
  v_discarded_count integer := 0;
  v_contended_count integer := 0;
  v_updated_count integer := 0;
  v_deferred_count integer := 0;
  v_remaining_count bigint;
  v_oldest_enqueued_at timestamptz;
  v_has_more boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;
  IF p_limit IS DISTINCT FROM 1 THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  SELECT pg_catalog.array_agg(
           candidate.post_id ORDER BY candidate.enqueued_at, candidate.post_id
         )
  INTO v_candidates
  FROM (
    SELECT repair_queue.post_id, repair_queue.enqueued_at
    FROM public.post_interaction_count_repair_queue AS repair_queue
    WHERE repair_queue.next_attempt_at <= pg_catalog.statement_timestamp()
    ORDER BY repair_queue.next_attempt_at,
             repair_queue.enqueued_at,
             repair_queue.post_id
    LIMIT 1
  ) AS candidate;

  v_selected_count := COALESCE(pg_catalog.cardinality(v_candidates), 0);

  FOREACH v_post_id IN ARRAY COALESCE(v_candidates, ARRAY[]::uuid[])
  LOOP
    EXIT WHEN v_processed_count >= p_limit;

    IF NOT pg_catalog.pg_try_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'post-reaction-counts:' || v_post_id::text,
        0
      )
    ) THEN
      WITH retryable AS (
        SELECT repair_queue.post_id
        FROM public.post_interaction_count_repair_queue AS repair_queue
        WHERE repair_queue.post_id = v_post_id
        FOR UPDATE SKIP LOCKED
      )
      UPDATE public.post_interaction_count_repair_queue AS repair_queue
      SET attempt_count = LEAST(repair_queue.attempt_count + 1, 1000000),
          next_attempt_at = pg_catalog.statement_timestamp()
            + pg_catalog.make_interval(
              secs => LEAST((repair_queue.attempt_count + 1) * 5, 300)
            )
      FROM retryable
      WHERE repair_queue.post_id = retryable.post_id;
      GET DIAGNOSTICS v_deferred_count = ROW_COUNT;
      v_contended_count := v_contended_count + 1;
      CONTINUE;
    END IF;

    SELECT locked_post.id
    INTO v_locked_post_id
    FROM public.posts AS locked_post
    WHERE locked_post.id = v_post_id
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      SELECT EXISTS (
        SELECT 1
        FROM public.posts AS visible_post
        WHERE visible_post.id = v_post_id
      )
      INTO v_post_still_exists;
      IF v_post_still_exists THEN
        WITH retryable AS (
          SELECT repair_queue.post_id
          FROM public.post_interaction_count_repair_queue AS repair_queue
          WHERE repair_queue.post_id = v_post_id
          FOR UPDATE SKIP LOCKED
        )
        UPDATE public.post_interaction_count_repair_queue AS repair_queue
        SET attempt_count = LEAST(repair_queue.attempt_count + 1, 1000000),
            next_attempt_at = pg_catalog.statement_timestamp()
              + pg_catalog.make_interval(
                secs => LEAST((repair_queue.attempt_count + 1) * 5, 300)
              )
        FROM retryable
        WHERE repair_queue.post_id = retryable.post_id;
        GET DIAGNOSTICS v_deferred_count = ROW_COUNT;
        v_contended_count := v_contended_count + 1;
        CONTINUE;
      END IF;

      SELECT repair_queue.post_id
      INTO v_claimed_post_id
      FROM public.post_interaction_count_repair_queue AS repair_queue
      WHERE repair_queue.post_id = v_post_id
      FOR UPDATE SKIP LOCKED;
      IF NOT FOUND THEN
        v_contended_count := v_contended_count + 1;
        CONTINUE;
      END IF;

      DELETE FROM public.post_interaction_count_repair_queue AS repair_queue
      WHERE repair_queue.post_id = v_claimed_post_id;
      v_processed_count := v_processed_count + 1;
      v_discarded_count := v_discarded_count + 1;
      CONTINUE;
    END IF;

    SELECT repair_queue.post_id
    INTO v_claimed_post_id
    FROM public.post_interaction_count_repair_queue AS repair_queue
    WHERE repair_queue.post_id = v_post_id
    FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      v_contended_count := v_contended_count + 1;
      CONTINUE;
    END IF;

    DELETE FROM public.post_interaction_count_repair_queue AS repair_queue
    WHERE repair_queue.post_id = v_claimed_post_id;

    SELECT
      pg_catalog.count(*) FILTER (
        WHERE reaction.reaction_type = 'up'
      ),
      pg_catalog.count(*) FILTER (
        WHERE reaction.reaction_type = 'down'
      )
    INTO v_like_count, v_dislike_count
    FROM public.post_likes AS reaction
    WHERE reaction.post_id = v_post_id;

    SELECT
      pg_catalog.count(*) FILTER (
        WHERE vote.choice = 'bull'
      ),
      pg_catalog.count(*) FILTER (
        WHERE vote.choice = 'bear'
      ),
      pg_catalog.count(*) FILTER (
        WHERE vote.choice = 'wait'
      )
    INTO v_bull_count, v_bear_count, v_wait_count
    FROM public.post_votes AS vote
    WHERE vote.post_id = v_post_id;

    SELECT pg_catalog.count(*)
    INTO STRICT v_bookmark_count
    FROM public.post_bookmarks AS bookmark
    WHERE bookmark.post_id = v_post_id;

    IF v_like_count > 2147483647
       OR v_dislike_count > 2147483647
       OR v_bull_count > 2147483647
       OR v_bear_count > 2147483647
       OR v_wait_count > 2147483647
       OR v_bookmark_count > 2147483647
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22003',
        MESSAGE = 'post interaction counter exceeds integer range';
    END IF;

    UPDATE public.posts AS target
    SET like_count = v_like_count::integer,
        dislike_count = v_dislike_count::integer,
        poll_bull = v_bull_count::integer,
        poll_bear = v_bear_count::integer,
        poll_wait = v_wait_count::integer,
        bookmark_count = v_bookmark_count::integer
    WHERE target.id = v_locked_post_id;

    GET DIAGNOSTICS v_updated_count = ROW_COUNT;
    IF v_updated_count IS DISTINCT FROM 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '40001',
        MESSAGE = 'locked post disappeared during interaction count repair';
    END IF;
    v_processed_count := v_processed_count + 1;
    v_repaired_count := v_repaired_count + 1;
  END LOOP;

  SELECT pg_catalog.count(*),
         pg_catalog.min(repair_queue.enqueued_at),
         COALESCE(
           pg_catalog.bool_or(
             repair_queue.next_attempt_at <= pg_catalog.statement_timestamp()
           ),
           false
         )
  INTO v_remaining_count, v_oldest_enqueued_at, v_has_more
  FROM public.post_interaction_count_repair_queue AS repair_queue;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'processed',
    'selected_count', v_selected_count,
    'processed_count', v_processed_count,
    'repaired_count', v_repaired_count,
    'discarded_count', v_discarded_count,
    'contended_count', v_contended_count,
    'has_more', v_has_more,
    'remaining_count', v_remaining_count,
    'oldest_enqueued_at', v_oldest_enqueued_at
  );
END
$function$;

ALTER FUNCTION public.toggle_post_bookmark_atomic(uuid, uuid, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.save_post_bookmark_to_folder_atomic(uuid, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid, uuid, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.enqueue_post_interaction_count_repair()
  OWNER TO postgres;
ALTER FUNCTION public.repair_post_interaction_counts_atomic(integer)
  OWNER TO postgres;

REVOKE ALL ON FUNCTION public.toggle_post_bookmark_atomic(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.save_post_bookmark_to_folder_atomic(uuid, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.enqueue_post_interaction_count_repair()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;
REVOKE ALL ON FUNCTION public.repair_post_interaction_counts_atomic(integer)
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

-- Remove unknown historical direct grantees as well as the canonical roles.
DO $close_function_acl_drift$
DECLARE
  v_function regprocedure;
  v_owner oid;
  v_grantee record;
  v_grantee_sql text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)'::regprocedure,
    'public.save_post_bookmark_to_folder_atomic(uuid,uuid)'::regprocedure,
    'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'::regprocedure,
    'public.enqueue_post_interaction_count_repair()'::regprocedure,
    'public.repair_post_interaction_counts_atomic(integer)'::regprocedure
  ]
  LOOP
    SELECT function_row.proowner
    INTO STRICT v_owner
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
      v_grantee_sql := CASE
        WHEN v_grantee.grantee = 0 THEN 'PUBLIC'
        ELSE pg_catalog.quote_ident(v_grantee.rolname)
      END;
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION %s FROM %s',
        v_function,
        v_grantee_sql
      );
    END LOOP;
  END LOOP;
END
$close_function_acl_drift$;

GRANT EXECUTE ON FUNCTION public.toggle_post_bookmark_atomic(uuid, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.save_post_bookmark_to_folder_atomic(uuid, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.remove_post_bookmark_from_folder_atomic(uuid, uuid, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.repair_post_interaction_counts_atomic(integer)
  TO service_role;

DROP TRIGGER IF EXISTS trg_post_bookmarks_90_enqueue_count_repair
  ON public.post_bookmarks;
CREATE TRIGGER trg_post_bookmarks_90_enqueue_count_repair
AFTER INSERT OR DELETE OR UPDATE OF post_id
ON public.post_bookmarks
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_post_interaction_count_repair();

-- Row triggers cannot make TRUNCATE durable. A postgres break-glass reset must
-- be followed by a full queue backfill; no application/maintenance role gets
-- silent destructive authority.
REVOKE TRUNCATE ON TABLE public.post_bookmarks
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

-- Keep schema-cache signatures, but close the arithmetic escape hatches that
-- can mutate posts.bookmark_count without changing canonical child rows.
DO $close_legacy_bookmark_counter_rpcs$
DECLARE
  v_function regprocedure;
  v_owner oid;
  v_grantee record;
  v_grantee_sql text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    pg_catalog.to_regprocedure('public.increment_bookmark_count(uuid)'),
    pg_catalog.to_regprocedure('public.decrement_bookmark_count(uuid)')
  ]
  LOOP
    CONTINUE WHEN v_function IS NULL;

    EXECUTE pg_catalog.format('ALTER FUNCTION %s OWNER TO postgres', v_function);
    SELECT function_row.proowner
    INTO STRICT v_owner
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
      v_grantee_sql := CASE
        WHEN v_grantee.grantee = 0 THEN 'PUBLIC'
        ELSE pg_catalog.quote_ident(v_grantee.rolname)
      END;
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON FUNCTION %s FROM %s',
        v_function,
        v_grantee_sql
      );
    END LOOP;
  END LOOP;
END
$close_legacy_bookmark_counter_rpcs$;

DO $attest_sources$
DECLARE
  v_function regprocedure;
  v_prefix text;
  v_source text;
BEGIN
  FOR v_function, v_prefix IN
    SELECT *
    FROM (
      VALUES
        (
          'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)'::regprocedure,
          'bookmark-count-consistency:toggle-v1:'
        ),
        (
          'public.save_post_bookmark_to_folder_atomic(uuid,uuid)'::regprocedure,
          'bookmark-count-consistency:save-v1:'
        ),
        (
          'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'::regprocedure,
          'bookmark-count-consistency:remove-v1:'
        ),
        (
          'public.enqueue_post_interaction_count_repair()'::regprocedure,
          'post-interaction-count-repair:enqueue-v2:'
        ),
        (
          'public.repair_post_interaction_counts_atomic(integer)'::regprocedure,
          'post-interaction-count-repair:worker-v2:'
        )
    ) AS expected(function_oid, comment_prefix)
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L',
      v_function,
      v_prefix || pg_catalog.md5(v_source)
    );
  END LOOP;
END
$attest_sources$;

COMMENT ON TABLE public.post_interaction_count_repair_queue IS
  'Private durable obligations to restore posts reaction/vote/bookmark counters from canonical child rows.';

-- Enqueue only exact source/cache mismatches. A clean replay therefore adds
-- no work, while NULL, negative, stale-positive, and child-backed drift are
-- all covered by the same grouped source-of-truth comparison.
INSERT INTO public.post_interaction_count_repair_queue (post_id)
SELECT target.id
FROM public.posts AS target
LEFT JOIN (
  SELECT bookmark.post_id, pg_catalog.count(*) AS exact_count
  FROM public.post_bookmarks AS bookmark
  GROUP BY bookmark.post_id
) AS source_truth
  ON source_truth.post_id = target.id
WHERE target.bookmark_count::bigint IS DISTINCT FROM
  COALESCE(source_truth.exact_count, 0::bigint)
ON CONFLICT (post_id) DO NOTHING;

DO $postflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
  v_service_oid oid := pg_catalog.to_regrole('service_role');
  v_authenticated_oid oid := pg_catalog.to_regrole('authenticated');
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_function regprocedure;
  v_expected record;
  v_source text;
  v_comment text;
  v_post_lock integer;
  v_actor_lock integer;
  v_account_lock integer;
  v_auth_lock integer;
  v_profile_lock integer;
  v_audience_lock integer;
  v_folder_lock integer;
  v_child_lock integer;
  v_count integer;
  v_post_update integer;
  v_expected_role oid;
  v_enqueue_source text;
  v_repair_source text;
  v_queue_lock integer;
  v_queue_delete integer;
BEGIN
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
    ) AS expected(signature, argument_names, default_count, role_oid, comment_prefix)
  LOOP
    v_function := pg_catalog.to_regprocedure(v_expected.signature);
    v_expected_role := v_expected.role_oid;

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
      AND function_row.pronargs = pg_catalog.cardinality(v_expected.argument_names)
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
    v_actor_lock := pg_catalog.strpos(v_source, '''post-bookmark:''');
    v_account_lock := pg_catalog.strpos(
      v_source,
      '''account-recovery-admission:'''
    );
    v_auth_lock := pg_catalog.strpos(
      v_source,
      'FROM auth.users AS actor_account'
    );
    v_profile_lock := pg_catalog.strpos(
      v_source,
      'FROM public.user_profiles AS profile'
    );
    v_audience_lock := pg_catalog.strpos(
      v_source,
      'public.lock_actor_can_interact_with_post'
    );
    v_folder_lock := pg_catalog.strpos(
      v_source,
      'FROM public.bookmark_folders AS folder'
    );
    v_child_lock := pg_catalog.strpos(
      v_source,
      'FROM public.post_bookmarks AS bookmark'
    );
    v_count := pg_catalog.strpos(v_source, 'SELECT pg_catalog.count(*)');
    v_post_update := pg_catalog.strpos(v_source, 'UPDATE public.posts');

    IF v_comment IS DISTINCT FROM
         v_expected.comment_prefix || pg_catalog.md5(v_source)
       OR v_post_lock = 0
       OR v_actor_lock <= v_post_lock
       OR (
         v_expected.signature =
           'public.toggle_post_bookmark_atomic(uuid,uuid,uuid)'
         AND (
           v_auth_lock <= v_actor_lock
           OR v_audience_lock <= v_auth_lock
           OR v_folder_lock <= v_audience_lock
         )
       )
       OR (
         v_expected.signature =
           'public.save_post_bookmark_to_folder_atomic(uuid,uuid)'
         AND (
           v_account_lock <= v_actor_lock
           OR v_auth_lock <= v_account_lock
           OR v_profile_lock <= v_auth_lock
           OR v_audience_lock <= v_profile_lock
           OR v_folder_lock <= v_audience_lock
         )
       )
       OR (
         v_expected.signature =
           'public.remove_post_bookmark_from_folder_atomic(uuid,uuid,uuid)'
         AND (
           v_account_lock <= v_actor_lock
           OR v_auth_lock <= v_account_lock
           OR v_profile_lock <= v_auth_lock
           OR v_folder_lock <= v_profile_lock
         )
       )
       OR v_child_lock <= v_folder_lock
       OR v_count <= v_child_lock
       OR v_post_update <= v_count
       OR NOT pg_catalog.has_function_privilege(
         v_expected_role, v_function, 'EXECUTE'
       )
       OR pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       OR pg_catalog.has_function_privilege(
         'authenticator', v_function, 'EXECUTE'
       )
       OR (
         v_expected_role = v_service_oid
         AND pg_catalog.has_function_privilege(
           'authenticated', v_function, 'EXECUTE'
         )
       )
       OR (
         v_expected_role = v_authenticated_oid
         AND pg_catalog.has_function_privilege(
           'service_role', v_function, 'EXECUTE'
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
           AND acl_entry.grantee NOT IN (v_postgres_oid, v_expected_role)
       )
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_proc AS function_row
         CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
         WHERE function_row.oid = v_function
           AND acl_entry.privilege_type = 'EXECUTE'
           AND acl_entry.grantee = v_expected_role
           AND acl_entry.is_grantable
       )
    THEN
      RAISE EXCEPTION 'post bookmark authority postflight drifted: %',
        v_expected.signature;
    END IF;
  END LOOP;

  SELECT function_row.prosrc
  INTO STRICT v_enqueue_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.enqueue_post_interaction_count_repair()'::regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'trigger'::pg_catalog.regtype
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.prolang = v_plpgsql_oid
    AND pg_catalog.cardinality(function_row.proconfig) = 2
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off'
    ]::text[];

  IF pg_catalog.strpos(v_enqueue_source, '''post_bookmarks''') = 0
     OR pg_catalog.strpos(v_enqueue_source, 'pg_advisory') <> 0
     OR pg_catalog.strpos(v_enqueue_source, 'auth.users') <> 0
     OR pg_catalog.strpos(v_enqueue_source, 'UPDATE public.posts') <> 0
  THEN
    RAISE EXCEPTION 'bookmark repair enqueue lock contract drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_repair_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.repair_post_interaction_counts_atomic(integer)'::regprocedure
    AND function_row.prokind = 'f'
    AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
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

  v_post_lock := pg_catalog.strpos(v_repair_source, 'pg_try_advisory_xact_lock');
  v_audience_lock := pg_catalog.strpos(
    v_repair_source,
    'FROM public.posts AS locked_post'
  );
  v_queue_lock := pg_catalog.strpos(v_repair_source, 'INTO v_claimed_post_id');
  v_queue_delete := pg_catalog.strpos(
    v_repair_source,
    'DELETE FROM public.post_interaction_count_repair_queue'
  );
  v_count := pg_catalog.strpos(
    v_repair_source,
    'FROM public.post_bookmarks AS bookmark'
  );
  v_post_update := pg_catalog.strpos(v_repair_source, 'UPDATE public.posts');

  IF v_post_lock = 0
     OR v_audience_lock <= v_post_lock
     OR v_queue_lock <= v_audience_lock
     OR v_queue_delete <= v_queue_lock
     OR v_count <= v_queue_delete
     OR v_post_update <= v_count
     OR pg_catalog.strpos(v_repair_source, 'p_limit IS DISTINCT FROM 1') = 0
     OR pg_catalog.strpos(v_repair_source, 'next_attempt_at') = 0
     OR pg_catalog.strpos(v_repair_source, 'bookmark_count = v_bookmark_count') = 0
  THEN
    RAISE EXCEPTION 'bookmark repair worker P -> posts -> Q contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.post_bookmarks'::regclass
      AND trigger_row.tgname = 'trg_post_bookmarks_90_enqueue_count_repair'
      AND trigger_row.tgfoid =
        'public.enqueue_post_interaction_count_repair()'::regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND (trigger_row.tgtype & 1) = 1
      AND (trigger_row.tgtype & 2) = 0
      AND (trigger_row.tgtype & 4) = 4
      AND (trigger_row.tgtype & 8) = 8
      AND (trigger_row.tgtype & 16) = 16
      AND trigger_row.tgqual IS NULL
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 1
      AND trigger_row.tgattr::smallint[] @> ARRAY[
        (
          SELECT attribute.attnum::smallint
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = 'public.post_bookmarks'::regclass
            AND attribute.attname = 'post_id'
        )
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'post_bookmarks repair trigger drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    WHERE pg_catalog.has_table_privilege(
      role_name,
      'public.post_bookmarks',
      'TRUNCATE'
    )
  ) THEN
    RAISE EXCEPTION 'post_bookmarks TRUNCATE authority leaked';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY[
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
      pg_catalog.to_regprocedure('public.increment_bookmark_count(uuid)'),
      pg_catalog.to_regprocedure('public.decrement_bookmark_count(uuid)')
    )
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION 'legacy arithmetic bookmark counter RPC remains callable';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.posts AS target
    LEFT JOIN (
      SELECT bookmark.post_id, pg_catalog.count(*) AS exact_count
      FROM public.post_bookmarks AS bookmark
      GROUP BY bookmark.post_id
    ) AS source_truth
      ON source_truth.post_id = target.id
    WHERE target.bookmark_count::bigint IS DISTINCT FROM
          COALESCE(source_truth.exact_count, 0::bigint)
      AND NOT EXISTS (
        SELECT 1
        FROM public.post_interaction_count_repair_queue AS repair_queue
        WHERE repair_queue.post_id = target.id
      )
  ) THEN
    RAISE EXCEPTION 'bookmark historical repair backfill is incomplete';
  END IF;
END
$postflight$;

DO $dependency_postflight$
DECLARE
  v_postgres_oid oid := pg_catalog.to_regrole('postgres');
  v_service_oid oid := pg_catalog.to_regrole('service_role');
  v_function regprocedure;
  v_source text;
  v_trigger record;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid =
      'public.post_interaction_count_repair_queue'::regclass
      AND relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND relation.relowner = v_postgres_oid
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
      AND NOT relation.relispartition
  ) OR (
    SELECT pg_catalog.array_agg(attribute.attname::text ORDER BY attribute.attnum)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) IS DISTINCT FROM ARRAY[
    'post_id', 'enqueued_at', 'next_attempt_at', 'attempt_count'
  ]::text[] OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy_row
    WHERE policy_row.polrelid =
      'public.post_interaction_count_repair_queue'::regclass
  ) THEN
    RAISE EXCEPTION 'repair queue postflight relation contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::regclass
      AND attribute.attname = 'post_id'
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
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::regclass
      AND attribute.attname = 'enqueued_at'
      AND attribute.atttypid = 'timestamptz'::regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) =
        'statement_timestamp()'
  ) THEN
    RAISE EXCEPTION 'repair queue postflight column shape drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.post_interaction_count_repair_queue'::regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND constraint_row.conkey = ARRAY[
        (
          SELECT attribute.attnum::smallint
          FROM pg_catalog.pg_attribute AS attribute
          WHERE attribute.attrelid = constraint_row.conrelid
            AND attribute.attname = 'post_id'
        )
      ]::smallint[]
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.post_interaction_count_repair_queue'::regclass
      AND constraint_row.contype = 'f'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
      'public.post_interaction_count_repair_queue'::regclass
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid, true) =
        'CHECK (attempt_count >= 0 AND attempt_count <= 1000000)'
  ) THEN
    RAISE EXCEPTION 'repair queue postflight PK/FK/backoff contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::regclass
      AND attribute.attname = 'next_attempt_at'
      AND attribute.atttypid = 'timestamptz'::regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) =
        'statement_timestamp()'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid =
      'public.post_interaction_count_repair_queue'::regclass
      AND attribute.attname = 'attempt_count'
      AND attribute.atttypid = 'integer'::regtype
      AND attribute.attnotnull
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid) = '0'
  ) THEN
    RAISE EXCEPTION 'repair queue postflight retry defaults drifted';
  END IF;

  IF NOT EXISTS (
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
      AND index_row.indrelid =
        'public.post_interaction_count_repair_queue'::regclass
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
    RAISE EXCEPTION 'repair queue postflight ordering index drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.unnest(
      ARRAY['anon', 'authenticated', 'authenticator', 'service_role']::text[]
    ) AS role_name
    WHERE pg_catalog.has_any_column_privilege(
            role_name,
            'public.post_interaction_count_repair_queue',
            'SELECT,INSERT,UPDATE,REFERENCES'
          )
       OR pg_catalog.has_table_privilege(
            role_name,
            'public.post_interaction_count_repair_queue',
            'DELETE,TRUNCATE,TRIGGER'
          )
  ) THEN
    RAISE EXCEPTION 'repair queue postflight private ACL drifted';
  END IF;

  FOREACH v_function IN ARRAY ARRAY[
    'public.toggle_post_reaction(uuid,uuid,text)'::regprocedure,
    'public.set_post_reaction_desired_state_atomic(uuid,uuid,text)'::regprocedure,
    'public.toggle_post_vote_atomic(uuid,uuid,text)'::regprocedure,
    'public.set_post_vote_desired_state_atomic(uuid,uuid,text)'::regprocedure
  ]
  LOOP
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.proowner = v_postgres_oid
      AND function_row.prosecdef;

    IF pg_catalog.strpos(v_source, '''post-reaction-counts:''') = 0
       OR pg_catalog.strpos(v_source, 'UPDATE public.posts') = 0
    THEN
      RAISE EXCEPTION 'reaction/vote P authority changed during bookmark cutover: %',
        v_function;
    END IF;
  END LOOP;

  FOR v_trigger IN
    SELECT *
    FROM (
      VALUES
        (
          'public.post_likes'::regclass,
          'trg_post_likes_90_enqueue_count_repair',
          ARRAY['post_id', 'reaction_type']::text[]
        ),
        (
          'public.post_votes'::regclass,
          'trg_post_votes_90_enqueue_count_repair',
          ARRAY['post_id', 'choice']::text[]
        ),
        (
          'public.post_bookmarks'::regclass,
          'trg_post_bookmarks_90_enqueue_count_repair',
          ARRAY['post_id']::text[]
        )
    ) AS expected_trigger(relation_oid, trigger_name, column_names)
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_trigger AS trigger_row
      WHERE trigger_row.tgrelid = v_trigger.relation_oid
        AND trigger_row.tgname = v_trigger.trigger_name
        AND trigger_row.tgfoid =
          'public.enqueue_post_interaction_count_repair()'::regprocedure
        AND trigger_row.tgenabled = 'O'
        AND NOT trigger_row.tgisinternal
        AND (trigger_row.tgtype & 1) = 1
        AND (trigger_row.tgtype & 2) = 0
        AND (trigger_row.tgtype & 4) = 4
        AND (trigger_row.tgtype & 8) = 8
        AND (trigger_row.tgtype & 16) = 16
        AND trigger_row.tgqual IS NULL
        AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) =
          pg_catalog.cardinality(v_trigger.column_names)
        AND NOT EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(v_trigger.column_names)
            AS expected_column(column_name)
          WHERE NOT (
            trigger_row.tgattr::smallint[] @> ARRAY[
              (
                SELECT attribute.attnum::smallint
                FROM pg_catalog.pg_attribute AS attribute
                WHERE attribute.attrelid = v_trigger.relation_oid
                  AND attribute.attname = expected_column.column_name
                  AND attribute.attnum > 0
                  AND NOT attribute.attisdropped
              )
            ]::smallint[]
          )
        )
    ) THEN
      RAISE EXCEPTION 'repair trigger postflight drifted: %',
        v_trigger.trigger_name;
    END IF;
  END LOOP;

  IF NOT pg_catalog.has_function_privilege(
       'service_role',
       'public.repair_post_interaction_counts_atomic(integer)'::regprocedure,
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
    WHERE function_row.oid IN (
      'public.enqueue_post_interaction_count_repair()'::regprocedure,
      'public.repair_post_interaction_counts_atomic(integer)'::regprocedure
    )
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
  ) OR pg_catalog.has_function_privilege(
    'service_role',
    'public.enqueue_post_interaction_count_repair()'::regprocedure,
    'EXECUTE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(function_row.proacl) AS acl_entry
    WHERE function_row.oid =
      'public.repair_post_interaction_counts_atomic(integer)'::regprocedure
      AND acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee = v_service_oid
      AND acl_entry.is_grantable
  ) THEN
    RAISE EXCEPTION 'repair function postflight ACL drifted';
  END IF;
END
$dependency_postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
