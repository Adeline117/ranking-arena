-- Migration: 20260803102000_set_post_reaction_desired_state.sql
-- Created: 2026-08-03T10:20:00Z
-- Description: Add an idempotent desired-state authority for post up/down
--   reactions. This migration depends on
--   20260803101000_close_post_interaction_child_direct_writes.sql. It keeps the
--   legacy toggle signature for rolling deploys, while both authorities share
--   the legacy actor/post advisory domain and a post-wide counter domain.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.post_likes:desired-state:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'post reaction desired-state migration lock is busy';
  END IF;
END
$migration_lock$;

-- Freeze the account parent before the post parent and reaction child. Every
-- catalog/constraint preflight below now runs inside the same locked schema
-- window as the DDL and postflight, closing preflight-to-DDL drift races.
LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.posts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.post_likes IN SHARE ROW EXCLUSIVE MODE;

DO $preflight$
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
  v_policy record;
  v_legacy_function regprocedure := pg_catalog.to_regprocedure(
    'public.toggle_post_reaction(uuid,uuid,text)'
  );
  v_audience_function regprocedure := pg_catalog.to_regprocedure(
    'public.lock_actor_can_interact_with_post(uuid,uuid)'
  );
  v_existing_function regprocedure := pg_catalog.to_regprocedure(
    'public.set_post_reaction_desired_state_atomic(uuid,uuid,text)'
  );
  v_legacy_source text;
  v_audience_source text;
  v_actor_lock integer;
  v_audience_lock integer;
  v_first_mutation integer;
  v_invalid_rows bigint;
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

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'post reaction desired-state roles are missing: %',
      v_missing_roles;
  END IF;

  IF v_postgres_oid IS NULL
     OR v_service_oid IS NULL
     OR v_authenticated_oid IS NULL
     OR v_plpgsql_oid IS NULL
  THEN
    RAISE EXCEPTION 'post reaction desired-state role OIDs are unavailable';
  END IF;

  IF NOT COALESCE(
    (
      SELECT role_row.rolbypassrls AND NOT role_row.rolsuper
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.rolname = 'service_role'
    ),
    false
  ) THEN
    RAISE EXCEPTION
      'service_role must remain NOSUPERUSER with BYPASSRLS';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname IN ('anon', 'authenticated', 'authenticator')
      AND (role_row.rolbypassrls OR role_row.rolsuper)
  ) THEN
    RAISE EXCEPTION
      'browser roles must remain NOSUPERUSER NOBYPASSRLS';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR pg_catalog.to_regprocedure('auth.uid()') IS NULL
     OR pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.post_likes') IS NULL
     OR pg_catalog.to_regclass(
       'public.interaction_emoji_reaction_quarantine'
     ) IS NULL
     OR pg_catalog.to_regprocedure('pg_catalog.gen_random_uuid()') IS NULL
     OR pg_catalog.to_regprocedure(
       'public.lock_post_interaction_block_edges(uuid,uuid,uuid)'
     ) IS NULL
     OR pg_catalog.to_regprocedure(
       'public.lock_actor_can_interact_with_post_locked_impl(uuid,uuid)'
     ) IS NULL
     OR v_legacy_function IS NULL
     OR v_audience_function IS NULL
  THEN
    RAISE EXCEPTION
      '20260803101000 and canonical post reaction authorities must deploy first';
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
        'post reaction desired-state requires a canonical permanent relation: %',
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
      RAISE EXCEPTION 'public.%.% has an incompatible desired-state shape',
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
    RAISE EXCEPTION 'public.post_likes requires exact PRIMARY KEY (id)';
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
      'public.post_likes requires an exact valid UNIQUE (post_id, user_id) key';
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
    RAISE EXCEPTION
      'public.post_likes requires exact post/account ON DELETE CASCADE foreign keys';
  END IF;

  SELECT pg_catalog.count(*)
  INTO v_invalid_rows
  FROM public.post_likes AS reaction
  WHERE reaction.reaction_type IS NULL
     OR reaction.reaction_type NOT IN ('up', 'down');
  IF v_invalid_rows <> 0 THEN
    RAISE EXCEPTION
      'public.post_likes contains % invalid reaction rows; repair before desired-state cutover',
      v_invalid_rows;
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
    RAISE EXCEPTION
      '20260803101000 post_likes RLS boundary is missing';
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
  THEN
    RAISE EXCEPTION
      '20260803101000 post_likes own-only policy drifted';
  END IF;

  IF NOT pg_catalog.has_table_privilege(
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
    RAISE EXCEPTION
      '20260803101000 post_likes browser ACL boundary drifted';
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
  THEN
    RAISE EXCEPTION
      'canonical post audience wrapper chain or internal-only ACL drifted';
  END IF;

  IF NOT EXISTS (
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
  ) THEN
    RAISE EXCEPTION 'canonical locked post audience implementation drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_legacy_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_legacy_function
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
    AND function_row.pronargdefaults = 1
    AND function_row.proargnames = ARRAY[
      'p_post_id',
      'p_user_id',
      'p_reaction_type'
    ]::text[]
    AND COALESCE(
      function_row.proconfig,
      ARRAY[]::text[]
    ) @> ARRAY['search_path=pg_catalog, pg_temp']::text[];

  v_actor_lock := pg_catalog.strpos(v_legacy_source, '''post-reaction:''');
  v_audience_lock := pg_catalog.strpos(
    v_legacy_source,
    'public.lock_actor_can_interact_with_post'
  );
  v_first_mutation := LEAST(
    pg_catalog.strpos(v_legacy_source, 'DELETE FROM public.post_likes'),
    pg_catalog.strpos(v_legacy_source, 'INSERT INTO public.post_likes'),
    pg_catalog.strpos(v_legacy_source, 'UPDATE public.post_likes')
  );
  IF v_actor_lock = 0
     OR v_audience_lock <= v_actor_lock
     OR v_first_mutation <= v_audience_lock
     OR pg_catalog.strpos(v_legacy_source, 'count(*) FILTER') = 0
     OR pg_catalog.strpos(
       v_legacy_source,
       'reaction.reaction_type = ''up'''
     ) = 0
     OR pg_catalog.strpos(
       v_legacy_source,
       'reaction.reaction_type = ''down'''
     ) = 0
     OR pg_catalog.strpos(
       v_legacy_source,
       'UPDATE public.posts'
     ) = 0
  THEN
    RAISE EXCEPTION
      'legacy toggle_post_reaction no longer owns the canonical serialization/count contract';
  END IF;

  IF NOT pg_catalog.has_function_privilege(
       'service_role', v_legacy_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'anon', v_legacy_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticated', v_legacy_function, 'EXECUTE'
     )
     OR pg_catalog.has_function_privilege(
       'authenticator', v_legacy_function, 'EXECUTE'
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
       WHERE function_row.oid = v_legacy_function
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
     )
  THEN
    RAISE EXCEPTION 'legacy toggle_post_reaction ACL drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname = 'set_post_reaction_desired_state_atomic'
      AND function_row.oid IS DISTINCT FROM v_existing_function
  ) THEN
    RAISE EXCEPTION
      'incompatible set_post_reaction_desired_state_atomic overload exists';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.post_likes'::pg_catalog.regclass
      AND constraint_row.conname =
        'post_likes_reaction_type_desired_state_check'
      AND constraint_row.contype <> 'c'
  ) THEN
    RAISE EXCEPTION
      'post_likes_reaction_type_desired_state_check has an incompatible type';
  END IF;
END
$preflight$;

ALTER TABLE public.post_likes
  ALTER COLUMN id SET DEFAULT pg_catalog.gen_random_uuid();

ALTER TABLE public.post_likes
  DROP CONSTRAINT IF EXISTS post_likes_reaction_type_desired_state_check;
ALTER TABLE public.post_likes
  ADD CONSTRAINT post_likes_reaction_type_desired_state_check
  CHECK (
    reaction_type IS NOT NULL
    AND reaction_type = ANY ('{up,down}'::text[])
  ) NOT VALID;
ALTER TABLE public.post_likes
  VALIDATE CONSTRAINT post_likes_reaction_type_desired_state_check;

-- Keep the legacy toggle callable during the rolling application cutover. Its
-- valid up/down behavior and success acknowledgement stay unchanged. Explicit
-- NULL now returns invalid instead of falling through SQL three-valued logic;
-- the shared post counter and account-lifecycle guards are also added.
CREATE OR REPLACE FUNCTION public.toggle_post_reaction(
  p_post_id uuid,
  p_user_id uuid,
  p_reaction_type text DEFAULT 'up'
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
  v_existing_type text;
  v_has_existing boolean;
  v_action text;
  v_reaction text;
  v_like_count bigint;
  v_dislike_count bigint;
  v_returned_like_count integer;
  v_returned_dislike_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;
  IF p_post_id IS NULL
     OR p_user_id IS NULL
     OR p_reaction_type IS NULL
     OR p_reaction_type NOT IN ('up', 'down')
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
      'post-reaction:' || p_post_id::text || ':' || p_user_id::text,
      0
    )
  );

  PERFORM 1
  FROM auth.users AS actor_account
  WHERE actor_account.id = p_user_id
  FOR KEY SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF NOT public.lock_actor_can_interact_with_post(p_post_id, p_user_id) THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  SELECT reaction.reaction_type
  INTO v_existing_type
  FROM public.post_likes AS reaction
  WHERE reaction.post_id = p_post_id
    AND reaction.user_id = p_user_id
  FOR UPDATE;
  v_has_existing := FOUND;

  IF v_has_existing AND v_existing_type = p_reaction_type THEN
    DELETE FROM public.post_likes AS reaction
    WHERE reaction.post_id = p_post_id
      AND reaction.user_id = p_user_id;
    v_action := 'removed';
    v_reaction := NULL;
  ELSIF NOT v_has_existing THEN
    INSERT INTO public.post_likes (id, post_id, user_id, reaction_type)
    VALUES (
      pg_catalog.gen_random_uuid(),
      p_post_id,
      p_user_id,
      p_reaction_type
    );
    v_action := 'added';
    v_reaction := p_reaction_type;
  ELSE
    UPDATE public.post_likes AS reaction
    SET reaction_type = p_reaction_type
    WHERE reaction.post_id = p_post_id
      AND reaction.user_id = p_user_id;
    v_action := 'changed';
    v_reaction := p_reaction_type;
  END IF;

  SELECT
    pg_catalog.count(*) FILTER (
      WHERE reaction.reaction_type = 'up'
    ),
    pg_catalog.count(*) FILTER (
      WHERE reaction.reaction_type = 'down'
    )
  INTO v_like_count, v_dislike_count
  FROM public.post_likes AS reaction
  WHERE reaction.post_id = p_post_id;

  IF v_like_count > 2147483647 OR v_dislike_count > 2147483647 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22003',
      MESSAGE = 'post reaction counter exceeds integer range';
  END IF;

  UPDATE public.posts AS target
  SET like_count = v_like_count::integer,
      dislike_count = v_dislike_count::integer
  WHERE target.id = p_post_id
  RETURNING target.like_count, target.dislike_count
  INTO v_returned_like_count, v_returned_dislike_count;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'post disappeared after canonical reaction lock';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_action,
    'action', v_action,
    'reaction', v_reaction,
    'like_count', v_returned_like_count,
    'dislike_count', v_returned_dislike_count
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.set_post_reaction_desired_state_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_desired_reaction text
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
  v_existing_type text;
  v_has_existing boolean;
  v_action text;
  v_final_reaction text;
  v_like_count bigint;
  v_dislike_count bigint;
  v_returned_like_count integer;
  v_returned_dislike_count integer;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;
  IF p_actor_id IS NULL
     OR p_post_id IS NULL
     OR (
       p_desired_reaction IS NOT NULL
       AND p_desired_reaction NOT IN ('up', 'down')
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  -- The post-wide lock makes every absolute recount serial. The second lock is
  -- the exact legacy actor/post domain, so toggle and desired-state callers for
  -- the same identity cannot cross during a rolling application deployment.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-reaction-counts:' || p_post_id::text,
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-reaction:' || p_post_id::text || ':' || p_actor_id::text,
      0
    )
  );

  -- Do not lock or mutate a child row before the account lifecycle is frozen.
  -- A concurrent hard delete either completes first (not_found) or waits until
  -- this transaction commits and then cascades the committed child safely.
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

  SELECT reaction.reaction_type
  INTO v_existing_type
  FROM public.post_likes AS reaction
  WHERE reaction.post_id = p_post_id
    AND reaction.user_id = p_actor_id
  FOR UPDATE;
  v_has_existing := FOUND;

  IF NOT v_has_existing THEN
    IF p_desired_reaction IS NULL THEN
      v_action := 'unchanged';
      v_final_reaction := NULL;
    ELSE
      INSERT INTO public.post_likes (id, post_id, user_id, reaction_type)
      VALUES (
        pg_catalog.gen_random_uuid(),
        p_post_id,
        p_actor_id,
        p_desired_reaction
      );
      v_action := 'added';
      v_final_reaction := p_desired_reaction;
    END IF;
  ELSIF p_desired_reaction IS NULL THEN
    DELETE FROM public.post_likes AS reaction
    WHERE reaction.post_id = p_post_id
      AND reaction.user_id = p_actor_id;
    v_action := 'removed';
    v_final_reaction := NULL;
  ELSIF v_existing_type = p_desired_reaction THEN
    v_action := 'unchanged';
    v_final_reaction := v_existing_type;
  ELSE
    UPDATE public.post_likes AS reaction
    SET reaction_type = p_desired_reaction
    WHERE reaction.post_id = p_post_id
      AND reaction.user_id = p_actor_id;
    v_action := 'changed';
    v_final_reaction := p_desired_reaction;
  END IF;

  -- Recount even for unchanged/no-row requests. This turns a retry into an
  -- idempotent state repair instead of another toggle edge.
  SELECT
    pg_catalog.count(*) FILTER (
      WHERE reaction.reaction_type = 'up'
    ),
    pg_catalog.count(*) FILTER (
      WHERE reaction.reaction_type = 'down'
    )
  INTO v_like_count, v_dislike_count
  FROM public.post_likes AS reaction
  WHERE reaction.post_id = p_post_id;

  IF v_like_count > 2147483647 OR v_dislike_count > 2147483647 THEN
    RAISE EXCEPTION USING
      ERRCODE = '22003',
      MESSAGE = 'post reaction counter exceeds integer range';
  END IF;

  UPDATE public.posts AS target
  SET like_count = v_like_count::integer,
      dislike_count = v_dislike_count::integer
  WHERE target.id = p_post_id
  RETURNING target.like_count, target.dislike_count
  INTO v_returned_like_count, v_returned_dislike_count;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'post disappeared after canonical reaction lock';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', v_action,
    'action', v_action,
    'reaction', v_final_reaction,
    'like_count', v_returned_like_count,
    'dislike_count', v_returned_dislike_count
  );
END
$function$;

ALTER FUNCTION public.toggle_post_reaction(uuid, uuid, text)
  OWNER TO postgres;
ALTER FUNCTION public.set_post_reaction_desired_state_atomic(uuid, uuid, text)
  OWNER TO postgres;

DO $converge_function_acls$
DECLARE
  v_signature regprocedure;
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
  v_grantee record;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.toggle_post_reaction(uuid,uuid,text)'::regprocedure,
    'public.set_post_reaction_desired_state_atomic(uuid,uuid,text)'::regprocedure
  ]
  LOOP
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
        AND acl_entry.privilege_type = 'EXECUTE'
        AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
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
        || 'FROM PUBLIC, anon, authenticated, authenticator, service_role',
      v_signature
    );
    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %s TO service_role',
      v_signature
    );
  END LOOP;
END
$converge_function_acls$;

DO $attest_function_sources$
DECLARE
  v_expected record;
  v_function regprocedure;
  v_source text;
BEGIN
  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.toggle_post_reaction(uuid,uuid,text)',
          'post-reaction-desired-state:legacy-v2:'
        ),
        (
          'public.set_post_reaction_desired_state_atomic(uuid,uuid,text)',
          'post-reaction-desired-state:v1:'
        )
    ) AS expected(signature, comment_prefix)
  LOOP
    v_function := pg_catalog.to_regprocedure(v_expected.signature);
    SELECT function_row.prosrc
    INTO STRICT v_source
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function;

    EXECUTE pg_catalog.format(
      'COMMENT ON FUNCTION %s IS %L',
      v_function,
      v_expected.comment_prefix || pg_catalog.md5(v_source)
    );
  END LOOP;
END
$attest_function_sources$;

DO $postflight$
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
  v_relation regclass;
  v_policy record;
  v_auth_user_id_attnum smallint;
  v_posts_id_attnum smallint;
  v_post_likes_id_attnum smallint;
  v_post_likes_post_id_attnum smallint;
  v_post_likes_user_id_attnum smallint;
  v_id_default text;
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
  v_constraint_definition text;
BEGIN
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
      RAISE EXCEPTION 'post reaction relation postflight drifted: %',
        v_relation;
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
    AND attribute.atttypid = 'uuid'::pg_catalog.regtype
    AND attribute.attnotnull
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
    AND attribute.atttypid = 'uuid'::pg_catalog.regtype
    AND attribute.attnotnull
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  SELECT attribute.attnum
  INTO STRICT v_post_likes_user_id_attnum
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.post_likes'::pg_catalog.regclass
    AND attribute.attname = 'user_id'
    AND attribute.atttypid = 'uuid'::pg_catalog.regtype
    AND attribute.attnotnull
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.post_likes'::pg_catalog.regclass
      AND constraint_row.contype = 'p'
      AND constraint_row.convalidated
      AND constraint_row.conkey = ARRAY[v_post_likes_id_attnum]::smallint[]
  ) OR NOT EXISTS (
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
    RAISE EXCEPTION 'post_likes primary/composite identity postflight drifted';
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
    RAISE EXCEPTION 'post_likes cascade foreign-key postflight drifted';
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
    RAISE EXCEPTION 'post_likes.id default postflight drifted: %',
      v_id_default;
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
    RAISE EXCEPTION 'post_likes RLS postflight drifted';
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
    RAISE EXCEPTION 'post_likes browser boundary postflight drifted';
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
  THEN
    RAISE EXCEPTION 'post reaction desired-state CHECK drifted: %',
      v_constraint_definition;
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
    RAISE EXCEPTION 'canonical post audience authority postflight drifted';
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
      RAISE EXCEPTION 'post reaction desired-state function is missing: %',
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
    v_count := pg_catalog.strpos(
      v_source,
      'count(*) FILTER'
    );
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
      RAISE EXCEPTION 'post reaction authority postflight failed: %',
        v_expected.signature;
    END IF;
  END LOOP;

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

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.set_post_reaction_desired_state_atomic(uuid,uuid,text)'::regprocedure;

  IF pg_catalog.strpos(v_source, 'v_action := ''unchanged''') = 0
     OR pg_catalog.strpos(v_source, 'pg_catalog.gen_random_uuid()') = 0
     OR pg_catalog.strpos(
       v_source,
       'reaction.post_id = p_post_id'
     ) = 0
     OR pg_catalog.strpos(
       v_source,
       'reaction.user_id = p_actor_id'
     ) = 0
  THEN
    RAISE EXCEPTION
      'desired-state idempotency or composite identity mutation drifted';
  END IF;

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.toggle_post_reaction(uuid,uuid,text)'::regprocedure;

  IF pg_catalog.strpos(v_source, 'v_action := ''removed''') = 0
     OR pg_catalog.strpos(v_source, 'pg_catalog.gen_random_uuid()') = 0
     OR pg_catalog.strpos(
       v_source,
       'reaction.post_id = p_post_id'
     ) = 0
     OR pg_catalog.strpos(
       v_source,
       'reaction.user_id = p_user_id'
     ) = 0
  THEN
    RAISE EXCEPTION
      'legacy toggle compatibility or composite identity mutation drifted';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
