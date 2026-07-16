-- Linearize every comment authorization read with the exact block edges it
-- consumes, before any post/group/comment row lock is taken.
--
-- The existing validators enforce current audience truth, but their block
-- reads were not serialized. A block could therefore commit between a read and
-- a comment/reaction write. Acquiring a target edge from a late table trigger
-- is also unsafe: canonical reaction RPCs already hold the target comment row
-- by then, creating an advisory-lock <-> row-lock deadlock with new replies.
-- This migration establishes one order for every path:
--
--   all actor/author block edges (sorted) -> post -> group -> comment

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('atomic-comment-block-authorization:v1', 0)
);

DO $preflight$
DECLARE
  v_relation_name text;
  v_required_role text;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_deploy_state text;
  v_helper_count integer;
  v_internal_count integer;
  v_internal_signature pg_catalog.regprocedure;
  v_internal_digest text;
  v_internal_comment text;
  v_block_serializer pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.serialize_post_audience_block_edge()'
  );
  v_comment_validator pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.validate_comment_integrity()'
  );
  v_reaction_validator pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.validate_comment_reaction_integrity()'
  );
  v_lock_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.lock_actor_can_interact_with_post(uuid,uuid)'
  );
  v_toggle_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.toggle_comment_reaction(uuid,uuid,uuid,text)'
  );
  v_update_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.update_own_comment(uuid,uuid,uuid,text)'
  );
  v_report_function pg_catalog.regprocedure := pg_catalog.to_regprocedure(
    'public.submit_content_report(uuid,text,uuid,text,text,text[])'
  );
  v_report_source text;
  v_block_serializer_source text;
  v_comment_validator_source text;
  v_reaction_validator_source text;
  v_lock_source text;
  v_toggle_source text;
  v_update_source text;
  v_post_report_case text;
  v_comment_report_case text;
  v_blocker_attnum smallint;
  v_blocked_attnum smallint;
  v_parent_attnum smallint;
  v_post_attnum smallint;
  v_comment_user_attnum smallint;
  v_content_attnum smallint;
  v_deleted_attnum smallint;
  v_reaction_comment_attnum smallint;
  v_reaction_user_attnum smallint;
  v_reaction_type_attnum smallint;
BEGIN
  FOREACH v_relation_name IN ARRAY ARRAY[
    'public.blocked_users',
    'public.posts',
    'public.comments',
    'public.comment_likes',
    'public.user_profiles',
    'public.groups',
    'public.group_members',
    'public.group_bans',
    'public.user_follows'
  ]::text[]
  LOOP
    IF pg_catalog.to_regclass(v_relation_name) IS NULL OR (
      SELECT relation.relkind = 'r'
        AND relation.relpersistence = 'p'
        AND NOT relation.relispartition
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = pg_catalog.to_regclass(v_relation_name)
    ) IS NOT TRUE THEN
      RAISE EXCEPTION
        '% must be a permanent, non-partition ordinary table before comment authorization cutover',
        v_relation_name;
    END IF;

    IF EXISTS (
      SELECT 1
      FROM pg_catalog.pg_rewrite AS rewrite_rule
      WHERE rewrite_rule.ev_class = pg_catalog.to_regclass(v_relation_name)
    ) THEN
      RAISE EXCEPTION
        '% must not have rewrite rules before comment authorization cutover',
        v_relation_name;
    END IF;
  END LOOP;

  FOREACH v_required_role IN ARRAY ARRAY[
    'anon', 'authenticated', 'service_role', 'postgres'
  ]::text[]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = v_required_role
    ) THEN
      RAISE EXCEPTION 'required comment authorization role is missing: %',
        v_required_role;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('blocked_users', 'blocker_id', 'uuid', true),
        ('blocked_users', 'blocked_id', 'uuid', true),
        ('posts', 'id', 'uuid', true),
        ('posts', 'author_id', 'uuid', true),
        ('posts', 'original_post_id', 'uuid', false),
        ('comments', 'id', 'uuid', true),
        ('comments', 'post_id', 'uuid', true),
        ('comments', 'user_id', 'uuid', true),
        ('comments', 'parent_id', 'uuid', false),
        ('comments', 'content', 'text', true),
        ('comments', 'deleted_at', 'timestamp with time zone', false),
        ('comment_likes', 'comment_id', 'uuid', true),
        ('comment_likes', 'user_id', 'uuid', true),
        ('comment_likes', 'reaction_type', 'text', true)
    ) AS required_column(table_name, column_name, type_name, is_not_null)
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
       OR attribute.attnotnull IS DISTINCT FROM required_column.is_not_null
  ) THEN
    RAISE EXCEPTION 'comment authorization columns have drifted';
  END IF;

  IF v_block_serializer IS NULL
     OR v_comment_validator IS NULL
     OR v_reaction_validator IS NULL
     OR v_lock_function IS NULL
     OR v_toggle_function IS NULL
     OR v_update_function IS NULL
     OR v_report_function IS NULL THEN
    RAISE EXCEPTION
      'comment authorization requires 20260715091500, 20260715100000, 20260715224000, 20260715224200, and 20260716113800';
  END IF;

  SELECT pg_catalog.count(*)::integer
  INTO v_helper_count
  FROM pg_catalog.unnest(ARRAY[
    'public.guard_post_authorization_identity()',
    'public.acquire_post_audience_block_edges(uuid,uuid[])',
    'public.lock_post_interaction_block_edges(uuid,uuid,uuid)',
    'public.serialize_comment_block_authorization()'
  ]::text[]) AS expected(signature)
  WHERE pg_catalog.to_regprocedure(expected.signature) IS NOT NULL;

  SELECT pg_catalog.count(*)::integer
  INTO v_internal_count
  FROM pg_catalog.unnest(ARRAY[
    'public.lock_actor_can_interact_with_post_locked_impl(uuid,uuid)',
    'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)',
    'public.update_own_comment_locked_impl(uuid,uuid,uuid,text)'
  ]::text[]) AS expected(signature)
  WHERE pg_catalog.to_regprocedure(expected.signature) IS NOT NULL;

  IF v_helper_count = 0 THEN
    -- A failed transaction cannot leave these functions behind. Any same-name
    -- internal residue is safe to replace only while none of this migration's
    -- public helpers exists; the cutover block below drops it without CASCADE.
    v_deploy_state := 'fresh';
  ELSIF v_helper_count = 4 AND v_internal_count = 3 THEN
    v_deploy_state := 'replay';

    FOREACH v_internal_signature IN ARRAY ARRAY[
      'public.lock_actor_can_interact_with_post_locked_impl(uuid,uuid)'::pg_catalog.regprocedure,
      'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)'::pg_catalog.regprocedure,
      'public.update_own_comment_locked_impl(uuid,uuid,uuid,text)'::pg_catalog.regprocedure
    ]
    LOOP
      SELECT
        pg_catalog.md5(function_row.prosrc),
        pg_catalog.obj_description(function_row.oid, 'pg_proc')
      INTO STRICT v_internal_digest, v_internal_comment
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_internal_signature;

      IF v_internal_comment IS DISTINCT FROM
           'atomic-comment-block-authorization:v1:' || v_internal_digest
      THEN
        RAISE EXCEPTION
          'sealed internal comment implementation has drifted: %',
          v_internal_signature;
      END IF;
    END LOOP;
  ELSE
    RAISE EXCEPTION
      'partial atomic comment authorization state: helpers %, internals %',
      v_helper_count,
      v_internal_count;
  END IF;

  PERFORM pg_catalog.set_config(
    'app.atomic_comment_block_authorization_state',
    v_deploy_state,
    true
  );

  -- 114500 changes the shared post helper from row-first to advisory-first.
  -- Refuse the cutover unless the private-report caller deployed immediately
  -- before it has already stopped holding target rows before entering that
  -- helper. Otherwise report-vs-comment transactions can deadlock.
  SELECT function_row.prosrc
  INTO STRICT v_report_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_report_function
    AND function_row.prokind = 'f'
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prolang = v_plpgsql_oid
    AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proconfig =
      ARRAY['search_path=pg_catalog, pg_temp']::text[];

  IF pg_catalog.strpos(v_report_source, $marker$WHEN 'post' THEN$marker$) = 0
     OR pg_catalog.strpos(v_report_source, $marker$WHEN 'comment' THEN$marker$) = 0
     OR pg_catalog.strpos(v_report_source, $marker$WHEN 'user' THEN$marker$) = 0
     OR pg_catalog.strpos(v_report_source, $marker$WHEN 'post' THEN$marker$)
          >= pg_catalog.strpos(v_report_source, $marker$WHEN 'comment' THEN$marker$)
     OR pg_catalog.strpos(v_report_source, $marker$WHEN 'comment' THEN$marker$)
          >= pg_catalog.strpos(v_report_source, $marker$WHEN 'user' THEN$marker$)
  THEN
    RAISE EXCEPTION
      '20260716113800 report target authorization cases have drifted';
  END IF;

  v_post_report_case := pg_catalog.substr(
    v_report_source,
    pg_catalog.strpos(v_report_source, $marker$WHEN 'post' THEN$marker$),
    pg_catalog.strpos(v_report_source, $marker$WHEN 'comment' THEN$marker$)
      - pg_catalog.strpos(v_report_source, $marker$WHEN 'post' THEN$marker$)
  );
  v_comment_report_case := pg_catalog.substr(
    v_report_source,
    pg_catalog.strpos(v_report_source, $marker$WHEN 'comment' THEN$marker$),
    pg_catalog.strpos(v_report_source, $marker$WHEN 'user' THEN$marker$)
      - pg_catalog.strpos(v_report_source, $marker$WHEN 'comment' THEN$marker$)
  );

  IF pg_catalog.strpos(v_post_report_case, 'lock_actor_can_interact_with_post') = 0
     OR pg_catalog.strpos(v_post_report_case, 'FOR SHARE') = 0
     OR pg_catalog.strpos(v_post_report_case, 'lock_actor_can_interact_with_post')
          > pg_catalog.strpos(v_post_report_case, 'FOR SHARE')
     OR pg_catalog.strpos(v_comment_report_case, 'v_candidate_post_id') = 0
     OR pg_catalog.strpos(v_comment_report_case, 'lock_actor_can_interact_with_post') = 0
     OR pg_catalog.strpos(v_comment_report_case, 'FOR SHARE') = 0
     OR pg_catalog.strpos(v_comment_report_case, 'lock_actor_can_interact_with_post')
          > pg_catalog.strpos(v_comment_report_case, 'FOR SHARE')
  THEN
    RAISE EXCEPTION
      '20260716113800 report target authorization must call the post helper before target row locks';
  END IF;

  SELECT attribute.attnum
  INTO STRICT v_blocker_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.blocked_users'::pg_catalog.regclass
    AND attribute.attname = 'blocker_id';
  SELECT attribute.attnum
  INTO STRICT v_blocked_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.blocked_users'::pg_catalog.regclass
    AND attribute.attname = 'blocked_id';

  SELECT function_row.prosrc
  INTO STRICT v_block_serializer_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_block_serializer
    AND function_row.prokind = 'f'
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prolang = v_plpgsql_oid
    AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proconfig =
      ARRAY['search_path=pg_catalog, pg_temp']::text[];

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.blocked_users'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_serialize_post_audience_block_edge'
      AND trigger_row.tgfoid = v_block_serializer
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 31
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 2
      AND trigger_row.tgattr::smallint[] @> ARRAY[
        v_blocker_attnum,
        v_blocked_attnum
      ]::smallint[]
      AND trigger_row.tgqual IS NULL
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid = v_block_serializer
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR pg_catalog.strpos(
        v_block_serializer_source,
        $marker$TG_OP IN ('UPDATE', 'DELETE')$marker$
      ) = 0
      OR pg_catalog.strpos(
        v_block_serializer_source,
        $marker$TG_OP IN ('INSERT', 'UPDATE')$marker$
      ) = 0
      OR pg_catalog.strpos(v_block_serializer_source, 'array_append') = 0
      OR pg_catalog.strpos(v_block_serializer_source, 'unnest') = 0
      OR pg_catalog.strpos(v_block_serializer_source, 'ORDER BY affected_pair') = 0
      OR pg_catalog.strpos(v_block_serializer_source, 'pg_advisory_xact_lock') = 0
      OR pg_catalog.strpos(
        v_block_serializer_source,
        $marker$'post-audience:block:' || v_pair$marker$
      ) = 0
      OR pg_catalog.strpos(
        v_block_serializer_source,
        $marker$RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END$marker$
      ) = 0
      OR v_block_serializer_source ~* 'RETURN[[:space:]]+NEW[[:space:]]*;'
  THEN
    RAISE EXCEPTION
      '20260715224200 block-edge serialization contract has drifted';
  END IF;

  SELECT attribute.attnum INTO STRICT v_parent_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comments'::pg_catalog.regclass
    AND attribute.attname = 'parent_id';
  SELECT attribute.attnum INTO STRICT v_post_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comments'::pg_catalog.regclass
    AND attribute.attname = 'post_id';
  SELECT attribute.attnum INTO STRICT v_comment_user_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comments'::pg_catalog.regclass
    AND attribute.attname = 'user_id';
  SELECT attribute.attnum INTO STRICT v_content_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comments'::pg_catalog.regclass
    AND attribute.attname = 'content';
  SELECT attribute.attnum INTO STRICT v_deleted_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comments'::pg_catalog.regclass
    AND attribute.attname = 'deleted_at';

  SELECT function_row.prosrc
  INTO STRICT v_comment_validator_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_comment_validator
    AND function_row.prokind = 'f'
    AND NOT function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prolang = v_plpgsql_oid
    AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proconfig =
      ARRAY['search_path=public, pg_temp']::text[];

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.comments'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_comments_10_validate_integrity'
      AND trigger_row.tgfoid = v_comment_validator
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 23
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 5
      AND trigger_row.tgattr::smallint[] @> ARRAY[
        v_parent_attnum,
        v_post_attnum,
        v_comment_user_attnum,
        v_content_attnum,
        v_deleted_attnum
      ]::smallint[]
      AND trigger_row.tgqual IS NULL
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid = v_comment_validator
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR pg_catalog.strpos(
        v_comment_validator_source,
        'comment post_id, parent_id, and user_id are immutable'
      ) = 0
      OR pg_catalog.strpos(v_comment_validator_source, 'FROM public.posts') = 0
      OR pg_catalog.strpos(v_comment_validator_source, 'FOR NO KEY UPDATE') = 0
      OR pg_catalog.strpos(v_comment_validator_source, 'FROM public.blocked_users') = 0
      OR pg_catalog.strpos(v_comment_validator_source, 'NEW.parent_id') = 0
      OR pg_catalog.strpos(v_comment_validator_source, 'NEW.user_id') = 0
      OR pg_catalog.strpos(v_comment_validator_source, 'RETURN NEW') = 0
  THEN
    RAISE EXCEPTION 'current comment integrity contract has drifted';
  END IF;

  SELECT attribute.attnum INTO STRICT v_reaction_comment_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comment_likes'::pg_catalog.regclass
    AND attribute.attname = 'comment_id';
  SELECT attribute.attnum INTO STRICT v_reaction_user_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comment_likes'::pg_catalog.regclass
    AND attribute.attname = 'user_id';
  SELECT attribute.attnum INTO STRICT v_reaction_type_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comment_likes'::pg_catalog.regclass
    AND attribute.attname = 'reaction_type';

  SELECT function_row.prosrc
  INTO STRICT v_reaction_validator_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_reaction_validator
    AND function_row.prokind = 'f'
    AND NOT function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proowner = v_postgres_oid
    AND function_row.prolang = v_plpgsql_oid
    AND function_row.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
    AND NOT function_row.proretset
    AND function_row.proconfig =
      ARRAY['search_path=public, pg_temp']::text[];

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.comment_likes'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_comment_likes_10_validate_integrity'
      AND trigger_row.tgfoid = v_reaction_validator
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 23
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 3
      AND trigger_row.tgattr::smallint[] @> ARRAY[
        v_reaction_comment_attnum,
        v_reaction_user_attnum,
        v_reaction_type_attnum
      ]::smallint[]
      AND trigger_row.tgqual IS NULL
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid = v_reaction_validator
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR pg_catalog.strpos(
        v_reaction_validator_source,
        'comment reaction identity is immutable'
      ) = 0
      OR pg_catalog.strpos(v_reaction_validator_source, 'FROM public.comments') = 0
      OR pg_catalog.strpos(v_reaction_validator_source, 'FROM public.posts') = 0
      OR pg_catalog.strpos(v_reaction_validator_source, 'FROM public.blocked_users') = 0
      OR pg_catalog.strpos(v_reaction_validator_source, 'FOR SHARE') = 0
      OR pg_catalog.strpos(v_reaction_validator_source, 'FOR NO KEY UPDATE') = 0
      OR pg_catalog.strpos(v_reaction_validator_source, 'RETURN NEW') = 0
  THEN
    RAISE EXCEPTION 'current comment reaction integrity contract has drifted';
  END IF;

  SELECT function_row.prosrc INTO STRICT v_lock_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_lock_function;
  SELECT function_row.prosrc INTO STRICT v_toggle_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_toggle_function;
  SELECT function_row.prosrc INTO STRICT v_update_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_update_function;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_lock_function
      AND function_row.prokind = 'f'
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proowner = v_postgres_oid
      AND function_row.prolang = v_plpgsql_oid
      AND function_row.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
      AND NOT function_row.proretset
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_toggle_function
      AND function_row.prokind = 'f'
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proowner = v_postgres_oid
      AND function_row.prolang = v_plpgsql_oid
      AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND NOT function_row.proretset
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_update_function
      AND function_row.prokind = 'f'
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.proowner = v_postgres_oid
      AND function_row.prolang = v_plpgsql_oid
      AND function_row.prorettype = 'public.comments'::pg_catalog.regtype
      AND function_row.proretset
  ) THEN
    RAISE EXCEPTION 'canonical comment function metadata has drifted';
  END IF;

  IF v_deploy_state = 'fresh' AND (
    NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_lock_function
        AND function_row.proconfig =
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_toggle_function
        AND function_row.proconfig =
          ARRAY['search_path=public, pg_temp']::text[]
    )
    OR NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_update_function
        AND function_row.proconfig =
          ARRAY['search_path=public, pg_temp']::text[]
    )
    OR pg_catalog.strpos(v_lock_source, 'FROM public.posts') = 0
    OR pg_catalog.strpos(v_lock_source, 'FOR SHARE') = 0
    OR pg_catalog.strpos(v_lock_source, 'pg_advisory_xact_lock') = 0
    OR pg_catalog.strpos(v_lock_source, $marker$'post-audience:block:'$marker$) = 0
    OR pg_catalog.strpos(v_lock_source, 'FOR SHARE') >
         pg_catalog.strpos(v_lock_source, 'pg_advisory_xact_lock')
    OR pg_catalog.strpos(v_toggle_source, 'FROM public.posts') = 0
    OR pg_catalog.strpos(v_toggle_source, 'FROM public.comments') = 0
    OR pg_catalog.strpos(v_toggle_source, 'FROM public.comment_likes') = 0
    OR pg_catalog.strpos(v_toggle_source, 'FOR SHARE') = 0
    OR pg_catalog.strpos(v_toggle_source, 'FOR UPDATE') = 0
    OR pg_catalog.strpos(v_toggle_source, 'app.comment_reaction_path') = 0
    OR pg_catalog.strpos(v_toggle_source, 'DELETE FROM public.comment_likes') = 0
    OR pg_catalog.strpos(v_toggle_source, 'UPDATE public.comment_likes') = 0
    OR pg_catalog.strpos(v_toggle_source, 'INSERT INTO public.comment_likes') = 0
    OR pg_catalog.strpos(v_update_source, 'FROM public.posts') = 0
    OR pg_catalog.strpos(v_update_source, 'FOR NO KEY UPDATE') = 0
    OR pg_catalog.strpos(v_update_source, 'FROM public.comments') = 0
    OR pg_catalog.strpos(v_update_source, 'FOR UPDATE') = 0
    OR pg_catalog.strpos(v_update_source, 'app.comment_mutation_path') = 0
    OR pg_catalog.strpos(v_update_source, 'UPDATE public.comments') = 0
  ) THEN
    RAISE EXCEPTION 'canonical comment function bodies have drifted';
  END IF;
END
$preflight$;

-- Trigger installation and function renames become visible atomically. The
-- lock order matches the existing post -> comment -> reaction DDL order.
LOCK TABLE public.posts IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.comments IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.comment_likes IN ACCESS EXCLUSIVE MODE;

-- Author identity determines every block-edge advisory key. It must never be
-- rewritten behind an already-acquired key. original_post_id is part of the
-- wrapper/root author set and is immutable for the same reason.
CREATE OR REPLACE FUNCTION public.guard_post_authorization_identity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'posts'
     OR TG_OP IS DISTINCT FROM 'UPDATE'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post authorization identity guard is misattached';
  END IF;

  IF NEW.author_id IS DISTINCT FROM OLD.author_id
     OR NEW.original_post_id IS DISTINCT FROM OLD.original_post_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'post author and repost root identity are immutable';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.guard_post_authorization_identity() OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_posts_00_guard_authorization_identity
  ON public.posts;
CREATE TRIGGER trg_posts_00_guard_authorization_identity
BEFORE UPDATE OF author_id, original_post_id
ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.guard_post_authorization_identity();

-- Internal primitive shared by post, comment, and reaction authorization. All
-- callers hand it a complete author set before taking any row lock.
CREATE OR REPLACE FUNCTION public.acquire_post_audience_block_edges(
  p_actor_id uuid,
  p_author_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_pair text;
BEGIN
  IF p_actor_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'block-edge actor is required';
  END IF;

  FOR v_pair IN
    SELECT DISTINCT
      LEAST(p_actor_id::text, author_row.author_id::text)
        || ':' || GREATEST(p_actor_id::text, author_row.author_id::text)
          AS affected_pair
    FROM pg_catalog.unnest(
      COALESCE(p_author_ids, ARRAY[]::uuid[])
    ) AS author_row(author_id)
    WHERE author_row.author_id IS NOT NULL
      AND author_row.author_id <> p_actor_id
    ORDER BY affected_pair
  LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('post-audience:block:' || v_pair, 0)
    );
  END LOOP;
END
$function$;

ALTER FUNCTION public.acquire_post_audience_block_edges(uuid, uuid[])
  OWNER TO postgres;

-- Resolve only immutable identity without row locks, then acquire the complete
-- sorted author set. The caller performs all active/audience checks after its
-- canonical row locks are held.
CREATE OR REPLACE FUNCTION public.lock_post_interaction_block_edges(
  p_post_id uuid,
  p_actor_id uuid,
  p_target_comment_id uuid DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_effective_post_id uuid := p_post_id;
  v_wrapper_author_id uuid;
  v_root_id uuid;
  v_root_author_id uuid;
  v_target_post_id uuid;
  v_target_author_id uuid;
BEGIN
  IF p_actor_id IS NULL
     OR (p_post_id IS NULL AND p_target_comment_id IS NULL)
  THEN
    RETURN false;
  END IF;

  IF p_target_comment_id IS NOT NULL THEN
    SELECT target_comment.post_id, target_comment.user_id
    INTO v_target_post_id, v_target_author_id
    FROM public.comments AS target_comment
    WHERE target_comment.id = p_target_comment_id;

    IF NOT FOUND THEN
      RETURN false;
    END IF;

    IF v_effective_post_id IS NULL THEN
      v_effective_post_id := v_target_post_id;
    ELSIF v_target_post_id IS DISTINCT FROM v_effective_post_id THEN
      RETURN false;
    END IF;
  END IF;

  SELECT wrapper.author_id, wrapper.original_post_id
  INTO v_wrapper_author_id, v_root_id
  FROM public.posts AS wrapper
  WHERE wrapper.id = v_effective_post_id;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_root_id IS NOT NULL THEN
    SELECT root.author_id
    INTO v_root_author_id
    FROM public.posts AS root
    WHERE root.id = v_root_id
      AND root.original_post_id IS NULL;

    IF NOT FOUND THEN
      RETURN false;
    END IF;
  END IF;

  PERFORM public.acquire_post_audience_block_edges(
    p_actor_id,
    ARRAY[
      v_wrapper_author_id,
      v_root_author_id,
      v_target_author_id
    ]::uuid[]
  );

  RETURN true;
END
$function$;

ALTER FUNCTION public.lock_post_interaction_block_edges(uuid, uuid, uuid)
  OWNER TO postgres;

-- Every direct service INSERT now acquires post/root/parent edges before the
-- existing validator takes post/group/parent row locks. Reaction mutations
-- re-acquire an edge already held by the canonical wrapper; the trigger remains
-- a structural defense for nested/maintenance writers.
CREATE OR REPLACE FUNCTION public.serialize_comment_block_authorization()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
DECLARE
  v_locked boolean;
  v_effective_post_id uuid;
  v_root_author_id uuid;
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'comment block serializer is attached outside public';
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'comments' THEN
      IF TG_OP IS DISTINCT FROM 'INSERT' THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'comment block serializer has an invalid comments event';
      END IF;
      v_locked := public.lock_post_interaction_block_edges(
        NEW.post_id,
        NEW.user_id,
        NEW.parent_id
      );
      v_effective_post_id := NEW.post_id;

    WHEN 'comment_likes' THEN
      IF TG_OP NOT IN ('INSERT', 'UPDATE') THEN
        RAISE EXCEPTION USING
          ERRCODE = '55000',
          MESSAGE = 'comment block serializer has an invalid reaction event';
      END IF;
      v_locked := public.lock_post_interaction_block_edges(
        NULL::uuid,
        NEW.user_id,
        NEW.comment_id
      );

      SELECT target_comment.post_id
      INTO v_effective_post_id
      FROM public.comments AS target_comment
      WHERE target_comment.id = NEW.comment_id;

    ELSE
      RAISE EXCEPTION USING
        ERRCODE = '55000',
        MESSAGE = 'comment block serializer is attached to an unsupported table';
  END CASE;

  IF NOT COALESCE(v_locked, false) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'comment authorization target identity is invalid';
  END IF;

  -- The mature row validators already reject wrapper-author and target-comment
  -- blocks. Reposts also inherit the root post's audience contract, so reject
  -- its author here after the complete immutable edge set is held. DELETE is
  -- intentionally absent from this trigger: users may still withdraw an
  -- existing reaction after either side creates a block edge.
  SELECT root.author_id
  INTO v_root_author_id
  FROM public.posts AS wrapper
  JOIN public.posts AS root
    ON root.id = wrapper.original_post_id
   AND root.original_post_id IS NULL
  WHERE wrapper.id = v_effective_post_id;

  IF v_root_author_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.blocked_users AS root_block
    WHERE (
      root_block.blocker_id = NEW.user_id
      AND root_block.blocked_id = v_root_author_id
    ) OR (
      root_block.blocker_id = v_root_author_id
      AND root_block.blocked_id = NEW.user_id
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'a root-author block prevents this comment interaction';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.serialize_comment_block_authorization()
  OWNER TO postgres;

DROP TRIGGER IF EXISTS trg_comments_09_serialize_block_authorization
  ON public.comments;
CREATE TRIGGER trg_comments_09_serialize_block_authorization
BEFORE INSERT
ON public.comments
FOR EACH ROW
EXECUTE FUNCTION public.serialize_comment_block_authorization();

DROP TRIGGER IF EXISTS trg_comment_likes_09_serialize_block_authorization
  ON public.comment_likes;
CREATE TRIGGER trg_comment_likes_09_serialize_block_authorization
BEFORE INSERT OR UPDATE OF comment_id, user_id, reaction_type
ON public.comment_likes
FOR EACH ROW
EXECUTE FUNCTION public.serialize_comment_block_authorization();

-- Preserve the mature implementations exactly, but make their public names
-- advisory-first wrappers. The transaction keeps every lock acquired by the
-- wrapper while the internal implementation takes its canonical row locks.
DO $internalize_existing_implementations$
DECLARE
  v_state text := pg_catalog.current_setting(
    'app.atomic_comment_block_authorization_state',
    true
  );
  v_signature pg_catalog.regprocedure;
  v_digest text;
BEGIN
  IF v_state = 'fresh' THEN
    -- Fresh cutover owns these private names. Drop stale same-name residue
    -- without CASCADE so an unexpected dependent fails closed, then preserve
    -- the three verified public implementations by rename.
    DROP FUNCTION IF EXISTS
      public.lock_actor_can_interact_with_post_locked_impl(uuid, uuid);
    DROP FUNCTION IF EXISTS
      public.toggle_comment_reaction_locked_impl(uuid, uuid, uuid, text);
    DROP FUNCTION IF EXISTS
      public.update_own_comment_locked_impl(uuid, uuid, uuid, text);

    ALTER FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
      RENAME TO lock_actor_can_interact_with_post_locked_impl;
    ALTER FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text)
      RENAME TO toggle_comment_reaction_locked_impl;
    ALTER FUNCTION public.update_own_comment(uuid, uuid, uuid, text)
      RENAME TO update_own_comment_locked_impl;
  ELSIF v_state IS DISTINCT FROM 'replay' THEN
    RAISE EXCEPTION 'atomic comment authorization deployment state is missing';
  END IF;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.lock_actor_can_interact_with_post_locked_impl(uuid,uuid)'::pg_catalog.regprocedure,
    'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.update_own_comment_locked_impl(uuid,uuid,uuid,text)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT pg_catalog.md5(function_row.prosrc)
    INTO STRICT v_digest
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature;

    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L',
      v_signature,
      'atomic-comment-block-authorization:v1:' || v_digest
    );
  END LOOP;
END
$internalize_existing_implementations$;

ALTER FUNCTION public.lock_actor_can_interact_with_post_locked_impl(uuid, uuid)
  OWNER TO postgres;
ALTER FUNCTION public.toggle_comment_reaction_locked_impl(
  uuid, uuid, uuid, text
) OWNER TO postgres;
ALTER FUNCTION public.update_own_comment_locked_impl(
  uuid, uuid, uuid, text
) OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.lock_actor_can_interact_with_post(
  p_post_id uuid,
  p_actor_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF NOT public.lock_post_interaction_block_edges(
    p_post_id,
    p_actor_id,
    NULL::uuid
  ) THEN
    RETURN false;
  END IF;

  RETURN public.lock_actor_can_interact_with_post_locked_impl(
    p_post_id,
    p_actor_id
  );
END
$function$;

ALTER FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.toggle_comment_reaction(
  p_post_id uuid,
  p_comment_id uuid,
  p_user_id uuid,
  p_reaction_type text DEFAULT 'like'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  -- Preserve the implementation's validation codes for malformed arguments.
  IF p_post_id IS NOT NULL
     AND p_comment_id IS NOT NULL
     AND p_user_id IS NOT NULL
  THEN
    IF NOT public.lock_post_interaction_block_edges(
      p_post_id,
      p_user_id,
      p_comment_id
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0002',
        MESSAGE = 'active comment not found for post';
    END IF;
  END IF;

  RETURN public.toggle_comment_reaction_locked_impl(
    p_post_id,
    p_comment_id,
    p_user_id,
    p_reaction_type
  );
END
$function$;

ALTER FUNCTION public.toggle_comment_reaction(uuid, uuid, uuid, text)
  OWNER TO postgres;

CREATE OR REPLACE FUNCTION public.update_own_comment(
  p_comment_id uuid,
  p_post_id uuid,
  p_user_id uuid,
  p_content text
)
RETURNS SETOF public.comments
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET lock_timeout = '5s'
AS $function$
BEGIN
  IF p_post_id IS NOT NULL
     AND p_user_id IS NOT NULL
     AND NOT public.lock_post_interaction_block_edges(
       p_post_id,
       p_user_id,
       NULL::uuid
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0002',
      MESSAGE = 'active post not found';
  END IF;

  -- The locked implementation predates repost-root audience inheritance and
  -- checks only the wrapper author. The wrapper above already owns the root
  -- block edge, so this read cannot race a block mutation and does not add a
  -- row lock ahead of the implementation's canonical post lock.
  IF p_post_id IS NOT NULL
     AND p_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.posts AS wrapper
       JOIN public.posts AS root
         ON root.id = wrapper.original_post_id
        AND root.original_post_id IS NULL
       JOIN public.blocked_users AS root_block
         ON (
           root_block.blocker_id = p_user_id
           AND root_block.blocked_id = root.author_id
         ) OR (
           root_block.blocker_id = root.author_id
           AND root_block.blocked_id = p_user_id
         )
       WHERE wrapper.id = p_post_id
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'a root-author block prevents comment edits on this post';
  END IF;

  RETURN QUERY
  SELECT implementation_result.*
  FROM public.update_own_comment_locked_impl(
    p_comment_id,
    p_post_id,
    p_user_id,
    p_content
  ) AS implementation_result;
END
$function$;

ALTER FUNCTION public.update_own_comment(uuid, uuid, uuid, text)
  OWNER TO postgres;

-- CREATE OR REPLACE and function renames preserve historical ACLs. Converge
-- arbitrary grantees, then publish only the two route-facing mutation RPCs.
DO $converge_function_acls$
DECLARE
  v_signature pg_catalog.regprocedure;
  v_owner oid;
  v_grantee record;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.guard_post_authorization_identity()'::pg_catalog.regprocedure,
    'public.acquire_post_audience_block_edges(uuid,uuid[])'::pg_catalog.regprocedure,
    'public.lock_post_interaction_block_edges(uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.serialize_comment_block_authorization()'::pg_catalog.regprocedure,
    'public.lock_actor_can_interact_with_post_locked_impl(uuid,uuid)'::pg_catalog.regprocedure,
    'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.update_own_comment_locked_impl(uuid,uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.lock_actor_can_interact_with_post(uuid,uuid)'::pg_catalog.regprocedure,
    'public.toggle_comment_reaction(uuid,uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.update_own_comment(uuid,uuid,uuid,text)'::pg_catalog.regprocedure
  ]
  LOOP
    SELECT function_row.proowner
    INTO v_owner
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_signature;

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
      WHERE function_row.oid = v_signature
        AND acl_entry.grantee <> v_owner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',
          v_signature
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',
          v_signature,
          v_grantee.rolname
        );
      END IF;
    END LOOP;

    EXECUTE pg_catalog.format(
      'REVOKE ALL PRIVILEGES ON FUNCTION %s '
        || 'FROM PUBLIC, anon, authenticated, service_role',
      v_signature
    );
  END LOOP;
END
$converge_function_acls$;

GRANT EXECUTE ON FUNCTION public.toggle_comment_reaction(
  uuid, uuid, uuid, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_own_comment(
  uuid, uuid, uuid, text
) TO service_role;

DO $postflight$
DECLARE
  v_signature pg_catalog.regprocedure;
  v_plpgsql_oid oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_author_attnum smallint;
  v_root_attnum smallint;
  v_comment_id_attnum smallint;
  v_comment_user_attnum smallint;
  v_reaction_comment_attnum smallint;
  v_reaction_user_attnum smallint;
  v_reaction_type_attnum smallint;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.guard_post_authorization_identity()'::pg_catalog.regprocedure,
    'public.acquire_post_audience_block_edges(uuid,uuid[])'::pg_catalog.regprocedure,
    'public.lock_post_interaction_block_edges(uuid,uuid,uuid)'::pg_catalog.regprocedure,
    'public.serialize_comment_block_authorization()'::pg_catalog.regprocedure,
    'public.lock_actor_can_interact_with_post(uuid,uuid)'::pg_catalog.regprocedure,
    'public.toggle_comment_reaction(uuid,uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.update_own_comment(uuid,uuid,uuid,text)'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_signature
        AND function_row.prokind = 'f'
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.proowner = v_postgres_oid
        AND function_row.proconfig @>
          ARRAY['search_path=pg_catalog, pg_temp']::text[]
    ) THEN
      RAISE EXCEPTION 'comment authorization function drifted: %', v_signature;
    END IF;
  END LOOP;

  FOREACH v_signature IN ARRAY ARRAY[
    'public.lock_actor_can_interact_with_post_locked_impl(uuid,uuid)'::pg_catalog.regprocedure,
    'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)'::pg_catalog.regprocedure,
    'public.update_own_comment_locked_impl(uuid,uuid,uuid,text)'::pg_catalog.regprocedure
  ]
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_signature
        AND function_row.prokind = 'f'
        AND function_row.prosecdef
        AND function_row.provolatile = 'v'
        AND function_row.prolang = v_plpgsql_oid
        AND function_row.proowner = v_postgres_oid
        AND function_row.proconfig = CASE
          WHEN v_signature =
            'public.lock_actor_can_interact_with_post_locked_impl(uuid,uuid)'::pg_catalog.regprocedure
          THEN ARRAY['search_path=pg_catalog, pg_temp']::text[]
          ELSE ARRAY['search_path=public, pg_temp']::text[]
        END
        AND pg_catalog.obj_description(function_row.oid, 'pg_proc') =
          'atomic-comment-block-authorization:v1:'
            || pg_catalog.md5(function_row.prosrc)
        AND (
          (
            v_signature =
              'public.lock_actor_can_interact_with_post_locked_impl(uuid,uuid)'::pg_catalog.regprocedure
            AND function_row.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
            AND NOT function_row.proretset
          ) OR (
            v_signature =
              'public.toggle_comment_reaction_locked_impl(uuid,uuid,uuid,text)'::pg_catalog.regprocedure
            AND function_row.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
            AND NOT function_row.proretset
          ) OR (
            v_signature =
              'public.update_own_comment_locked_impl(uuid,uuid,uuid,text)'::pg_catalog.regprocedure
            AND function_row.prorettype = 'public.comments'::pg_catalog.regtype
            AND function_row.proretset
          )
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
      WHERE function_row.oid = v_signature
        AND acl_entry.grantee <> function_row.proowner
    ) THEN
      RAISE EXCEPTION 'internal comment implementation drifted: %', v_signature;
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        function_row.proacl,
        pg_catalog.acldefault('f', function_row.proowner)
      )
    ) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE function_row.oid IN (
      'public.guard_post_authorization_identity()'::pg_catalog.regprocedure,
      'public.acquire_post_audience_block_edges(uuid,uuid[])'::pg_catalog.regprocedure,
      'public.lock_post_interaction_block_edges(uuid,uuid,uuid)'::pg_catalog.regprocedure,
      'public.serialize_comment_block_authorization()'::pg_catalog.regprocedure,
      'public.lock_actor_can_interact_with_post(uuid,uuid)'::pg_catalog.regprocedure
    )
      AND acl_entry.grantee <> function_row.proowner
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.toggle_comment_reaction(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role',
    'public.update_own_comment(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.toggle_comment_reaction(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.toggle_comment_reaction(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'anon',
    'public.update_own_comment(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) OR pg_catalog.has_function_privilege(
    'authenticated',
    'public.update_own_comment(uuid,uuid,uuid,text)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'comment authorization ACLs did not converge';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'public.lock_actor_can_interact_with_post(uuid,uuid)'::pg_catalog.regprocedure
      AND pg_catalog.strpos(
        function_row.prosrc,
        'public.lock_post_interaction_block_edges'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'public.lock_post_interaction_block_edges'
      ) < pg_catalog.strpos(
        function_row.prosrc,
        'public.lock_actor_can_interact_with_post_locked_impl'
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'public.toggle_comment_reaction(uuid,uuid,uuid,text)'::pg_catalog.regprocedure
      AND pg_catalog.strpos(
        function_row.prosrc,
        'public.lock_post_interaction_block_edges'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'public.lock_post_interaction_block_edges'
      ) < pg_catalog.strpos(
        function_row.prosrc,
        'public.toggle_comment_reaction_locked_impl'
      )
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid =
      'public.update_own_comment(uuid,uuid,uuid,text)'::pg_catalog.regprocedure
      AND pg_catalog.strpos(
        function_row.prosrc,
        'public.lock_post_interaction_block_edges'
      ) > 0
      AND pg_catalog.strpos(
        function_row.prosrc,
        'public.lock_post_interaction_block_edges'
      ) < pg_catalog.strpos(
        function_row.prosrc,
        'public.update_own_comment_locked_impl'
      )
  ) THEN
    RAISE EXCEPTION 'comment wrappers do not acquire block edges first';
  END IF;

  SELECT attribute.attnum INTO STRICT v_author_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.posts'::pg_catalog.regclass
    AND attribute.attname = 'author_id';
  SELECT attribute.attnum INTO STRICT v_root_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.posts'::pg_catalog.regclass
    AND attribute.attname = 'original_post_id';
  SELECT attribute.attnum INTO STRICT v_comment_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comments'::pg_catalog.regclass
    AND attribute.attname = 'id';
  SELECT attribute.attnum INTO STRICT v_comment_user_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comments'::pg_catalog.regclass
    AND attribute.attname = 'user_id';
  SELECT attribute.attnum INTO STRICT v_reaction_comment_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comment_likes'::pg_catalog.regclass
    AND attribute.attname = 'comment_id';
  SELECT attribute.attnum INTO STRICT v_reaction_user_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comment_likes'::pg_catalog.regclass
    AND attribute.attname = 'user_id';
  SELECT attribute.attnum INTO STRICT v_reaction_type_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.comment_likes'::pg_catalog.regclass
    AND attribute.attname = 'reaction_type';

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_posts_00_guard_authorization_identity'
      AND trigger_row.tgfoid =
        'public.guard_post_authorization_identity()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 19
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 2
      AND trigger_row.tgattr::smallint[] @> ARRAY[
        v_author_attnum,
        v_root_attnum
      ]::smallint[]
      AND trigger_row.tgqual IS NULL
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid =
        'public.guard_post_authorization_identity()'::pg_catalog.regprocedure
      AND NOT trigger_row.tgisinternal
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.comments'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_comments_09_serialize_block_authorization'
      AND trigger_row.tgfoid =
        'public.serialize_comment_block_authorization()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 7
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 0
      AND trigger_row.tgqual IS NULL
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.comment_likes'::pg_catalog.regclass
      AND trigger_row.tgname = 'trg_comment_likes_09_serialize_block_authorization'
      AND trigger_row.tgfoid =
        'public.serialize_comment_block_authorization()'::pg_catalog.regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
      AND trigger_row.tgtype = 23
      AND pg_catalog.cardinality(trigger_row.tgattr::smallint[]) = 3
      AND trigger_row.tgattr::smallint[] @> ARRAY[
        v_reaction_comment_attnum,
        v_reaction_user_attnum,
        v_reaction_type_attnum
      ]::smallint[]
      AND trigger_row.tgqual IS NULL
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgfoid =
        'public.serialize_comment_block_authorization()'::pg_catalog.regprocedure
      AND NOT trigger_row.tgisinternal
  ) <> 2 THEN
    RAISE EXCEPTION 'comment authorization trigger catalog drifted';
  END IF;

  IF (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'guard_post_authorization_identity',
        'acquire_post_audience_block_edges',
        'lock_post_interaction_block_edges',
        'serialize_comment_block_authorization',
        'lock_actor_can_interact_with_post',
        'lock_actor_can_interact_with_post_locked_impl',
        'toggle_comment_reaction',
        'toggle_comment_reaction_locked_impl',
        'update_own_comment',
        'update_own_comment_locked_impl'
      )
  ) <> 10 THEN
    RAISE EXCEPTION 'unexpected comment authorization overload remains';
  END IF;
END
$postflight$;

COMMENT ON FUNCTION public.lock_post_interaction_block_edges(uuid, uuid, uuid) IS
  'Acquires every immutable wrapper/root/target author block edge in sorted order before callers take post/group/comment row locks.';
COMMENT ON FUNCTION public.lock_actor_can_interact_with_post(uuid, uuid) IS
  'Advisory-first wrapper around the canonical locked post audience implementation.';

NOTIFY pgrst, 'reload schema';

COMMIT;
