-- Migration: 20260729186000_post_hashtag_count_integrity.sql
-- Created: 2026-07-30T02:00:00Z
-- Description: Make post_hashtags the sole source of truth for cached hashtag
--   post counts. Repair historical drift, harden the cache domain, and maintain
--   it with transaction-local arithmetic deltas for every association writer.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'public.post_hashtags:post-count-integrity:migration',
      0
    )
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'post hashtag count integrity migration lock is busy';
  END IF;
END
$migration_lock$;

DO $relation_preflight$
DECLARE
  v_missing_roles text[];
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
    RAISE EXCEPTION 'post hashtag count roles are missing: %',
      v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.hashtags') IS NULL
     OR pg_catalog.to_regclass('public.post_hashtags') IS NULL
  THEN
    RAISE EXCEPTION 'canonical post hashtag relations must deploy first';
  END IF;
END
$relation_preflight$;

-- Block every source-row mutation while the historical cache is recounted and
-- its trigger is installed. Taking all three locks together also blocks post
-- deletion cascades from opening a recount/install gap.
LOCK TABLE public.posts,
  public.hashtags,
  public.post_hashtags
  IN SHARE ROW EXCLUSIVE MODE;

DO $canonical_preflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_invalid_columns text[];
  v_role text;
  v_relation regclass;
  v_column record;
  v_expected_trigger_function regprocedure := pg_catalog.to_regprocedure(
    'public.maintain_post_hashtag_count()'
  );
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.posts'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
        OR relation.relowner <> v_postgres_oid
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'public.posts'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
       OR inheritance.inhparent IN (
         'public.posts'::regclass,
         'public.hashtags'::regclass,
         'public.post_hashtags'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'public.posts'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
  ) THEN
    RAISE EXCEPTION
      'post hashtag count integrity requires canonical postgres-owned tables';
  END IF;

  SELECT pg_catalog.array_agg(
    pg_catalog.format(
      '%I.%I.%I expected %s%s',
      required_column.schema_name,
      required_column.relation_name,
      required_column.column_name,
      required_column.type_oid::regtype,
      CASE WHEN required_column.required_not_null THEN ' NOT NULL' ELSE '' END
    )
    ORDER BY required_column.relation_name, required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      ('public', 'posts', 1, 'id', 'uuid'::regtype, true),
      ('public', 'hashtags', 1, 'id', 'uuid'::regtype, true),
      ('public', 'hashtags', 2, 'tag', 'text'::regtype, true),
      ('public', 'hashtags', 3, 'post_count', 'integer'::regtype, false),
      ('public', 'post_hashtags', 1, 'post_id', 'uuid'::regtype, true),
      ('public', 'post_hashtags', 2, 'hashtag_id', 'uuid'::regtype, true)
  ) AS required_column(
    schema_name,
    relation_name,
    ordinality,
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
  WHERE attribute.attname IS NULL
     OR attribute.atttypid <> required_column.type_oid
     OR (required_column.required_not_null AND NOT attribute.attnotnull);

  IF v_invalid_columns IS NOT NULL THEN
    RAISE EXCEPTION 'post hashtag count columns are incompatible: %',
      v_invalid_columns;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'p'
      AND constraint_row.conrelid = 'public.posts'::regclass
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.posts'::regclass
          AND attribute.attname = 'id'
      )]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'p'
      AND constraint_row.conrelid = 'public.hashtags'::regclass
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.hashtags'::regclass
          AND attribute.attname = 'id'
      )]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype IN ('p', 'u')
      AND constraint_row.conrelid = 'public.hashtags'::regclass
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.hashtags'::regclass
          AND attribute.attname = 'tag'
      )]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'p'
      AND constraint_row.conrelid = 'public.post_hashtags'::regclass
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.conkey = ARRAY[
        (SELECT attribute.attnum
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.post_hashtags'::regclass
           AND attribute.attname = 'post_id'),
        (SELECT attribute.attnum
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.post_hashtags'::regclass
           AND attribute.attname = 'hashtag_id')
      ]::smallint[]
  ) THEN
    RAISE EXCEPTION 'canonical post hashtag primary/unique keys are missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.post_hashtags'::regclass
      AND constraint_row.confrelid = 'public.posts'::regclass
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.post_hashtags'::regclass
          AND attribute.attname = 'post_id'
      )]::smallint[]
      AND constraint_row.confkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.posts'::regclass
          AND attribute.attname = 'id'
      )]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.contype = 'f'
      AND constraint_row.conrelid = 'public.post_hashtags'::regclass
      AND constraint_row.confrelid = 'public.hashtags'::regclass
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.post_hashtags'::regclass
          AND attribute.attname = 'hashtag_id'
      )]::smallint[]
      AND constraint_row.confkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = 'public.hashtags'::regclass
          AND attribute.attname = 'id'
      )]::smallint[]
  ) THEN
    RAISE EXCEPTION
      'canonical cascading post hashtag foreign keys are missing';
  END IF;

  -- The 185000 post-create cutover removes both table and historical column
  -- DML from browser roles. Refuse to install a privileged maintenance trigger
  -- over a source table if that closure has drifted or was skipped.
  FOREACH v_role IN ARRAY ARRAY[
    'anon',
    'authenticated',
    'authenticator'
  ]::text[]
  LOOP
    FOREACH v_relation IN ARRAY ARRAY[
      'public.posts'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    ]::regclass[]
    LOOP
      IF pg_catalog.has_table_privilege(v_role, v_relation, 'INSERT')
         OR pg_catalog.has_table_privilege(v_role, v_relation, 'UPDATE')
         OR pg_catalog.has_table_privilege(v_role, v_relation, 'DELETE')
      THEN
        RAISE EXCEPTION
          'browser post/hashtag DML closure must deploy first: % on %',
          v_role,
          v_relation;
      END IF;

      FOR v_column IN
        SELECT attribute.attname
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid = v_relation
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped
      LOOP
        IF pg_catalog.has_column_privilege(
             v_role,
             v_relation,
             v_column.attname,
             'INSERT'
           ) OR pg_catalog.has_column_privilege(
             v_role,
             v_relation,
             v_column.attname,
             'UPDATE'
           )
        THEN
          RAISE EXCEPTION
            'browser post/hashtag column DML closure must deploy first: %.%',
            v_relation,
            v_column.attname;
        END IF;
      END LOOP;
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
      'public.posts'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
      AND acl_entry.grantee = 0
      AND acl_entry.privilege_type IN ('INSERT', 'UPDATE', 'DELETE')
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid IN (
      'public.posts'::regclass,
      'public.hashtags'::regclass,
      'public.post_hashtags'::regclass
    )
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
      AND acl_entry.grantee = 0
      AND acl_entry.privilege_type IN ('INSERT', 'UPDATE')
  ) THEN
    RAISE EXCEPTION 'post/hashtag DML remains exposed to PUBLIC';
  END IF;

  IF pg_catalog.to_regprocedure(
       'public.recount_hashtag_posts(uuid[])'
     ) IS NULL
  THEN
    RAISE EXCEPTION 'canonical hashtag recount signature must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::regnamespace
      AND function_row.proname = 'maintain_post_hashtag_count'
      AND (
        v_expected_trigger_function IS NULL
        OR function_row.oid <> v_expected_trigger_function::oid
      )
  ) THEN
    RAISE EXCEPTION 'post hashtag count trigger signature is incompatible';
  END IF;
END
$canonical_preflight$;

-- Repair every registry row from the association table, including NULL,
-- negative, stale positive, and zero-association rows. Zero-count hashtags are
-- retained; the migration only converges their cache value.
UPDATE public.hashtags AS hashtag
SET post_count = exact_count.post_count
FROM (
  SELECT
    counted_hashtag.id AS hashtag_id,
    pg_catalog.count(post_hashtag.post_id)::integer AS post_count
  FROM public.hashtags AS counted_hashtag
  LEFT JOIN public.post_hashtags AS post_hashtag
    ON post_hashtag.hashtag_id = counted_hashtag.id
  GROUP BY counted_hashtag.id
) AS exact_count
WHERE hashtag.id = exact_count.hashtag_id
  AND hashtag.post_count IS DISTINCT FROM exact_count.post_count;

ALTER TABLE public.hashtags
  ALTER COLUMN post_count SET DEFAULT 0,
  ALTER COLUMN post_count SET NOT NULL;

DO $post_count_constraint$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.hashtags'::regclass
      AND constraint_row.conname = 'hashtags_post_count_nonnegative'
      AND (
        constraint_row.contype <> 'c'
        OR pg_catalog.replace(
          pg_catalog.pg_get_expr(
            constraint_row.conbin,
            constraint_row.conrelid
          ),
          ' ',
          ''
        ) <> '(post_count>=0)'
      )
  ) THEN
    RAISE EXCEPTION
      'hashtags_post_count_nonnegative has an incompatible definition';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.hashtags'::regclass
      AND constraint_row.conname = 'hashtags_post_count_nonnegative'
  ) THEN
    ALTER TABLE public.hashtags
      ADD CONSTRAINT hashtags_post_count_nonnegative
      CHECK (post_count >= 0) NOT VALID;
  END IF;
END
$post_count_constraint$;

ALTER TABLE public.hashtags
  VALIDATE CONSTRAINT hashtags_post_count_nonnegative;

-- Keep the compatibility recount RPC, but lock every requested parent in UUID
-- order before taking the association snapshot. Trigger deltas for a concurrent
-- association then happen wholly before or wholly after this recount.
CREATE OR REPLACE FUNCTION public.recount_hashtag_posts(hashtag_ids uuid[])
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_hashtag_ids uuid[];
BEGIN
  v_hashtag_ids := ARRAY(
    SELECT DISTINCT requested.hashtag_id
    FROM pg_catalog.unnest(
      COALESCE(hashtag_ids, ARRAY[]::uuid[])
    ) AS requested(hashtag_id)
    WHERE requested.hashtag_id IS NOT NULL
    ORDER BY requested.hashtag_id
  );

  IF pg_catalog.cardinality(v_hashtag_ids) = 0 THEN
    RETURN;
  END IF;

  PERFORM 1
  FROM public.hashtags AS hashtag
  WHERE hashtag.id = ANY(v_hashtag_ids)
  ORDER BY hashtag.id
  FOR UPDATE;

  UPDATE public.hashtags AS hashtag
  SET post_count = (
    SELECT pg_catalog.count(*)::integer
    FROM public.post_hashtags AS post_hashtag
    WHERE post_hashtag.hashtag_id = hashtag.id
  )
  WHERE hashtag.id = ANY(v_hashtag_ids);
END
$function$;

ALTER FUNCTION public.recount_hashtag_posts(uuid[]) OWNER TO postgres;

-- A relative UPDATE owns each cache delta. It never reads an association
-- snapshot. Moves lock both hashtag rows in UUID order before decrementing and
-- incrementing, so opposite A->B / B->A moves cannot deadlock.
CREATE OR REPLACE FUNCTION public.maintain_post_hashtag_count()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_old_hashtag_id uuid;
  v_new_hashtag_id uuid;
  v_affected_rows integer;
BEGIN
  IF TG_RELID IS DISTINCT FROM 'public.post_hashtags'::regclass
     OR TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'post_hashtags'
     OR TG_LEVEL IS DISTINCT FROM 'ROW'
     OR TG_WHEN IS DISTINCT FROM 'AFTER'
     OR TG_OP NOT IN ('INSERT', 'DELETE', 'UPDATE')
     OR TG_NARGS <> 0
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post hashtag count trigger is misattached';
  END IF;

  IF TG_OP <> 'INSERT' THEN
    v_old_hashtag_id := OLD.hashtag_id;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    v_new_hashtag_id := NEW.hashtag_id;
  END IF;

  IF v_old_hashtag_id IS NOT DISTINCT FROM v_new_hashtag_id THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  PERFORM 1
  FROM public.hashtags AS hashtag
  WHERE hashtag.id IN (v_old_hashtag_id, v_new_hashtag_id)
  ORDER BY hashtag.id
  FOR UPDATE;

  IF v_old_hashtag_id IS NOT NULL THEN
    UPDATE public.hashtags AS hashtag
    SET post_count = hashtag.post_count - 1
    WHERE hashtag.id = v_old_hashtag_id;
    GET DIAGNOSTICS v_affected_rows = ROW_COUNT;

    -- A missing old parent is legitimate only while that same parent is
    -- deleting and its FK cascades this association. Normal deletes and moves
    -- retain their parent under the validated foreign key.
    IF v_affected_rows <> 1 AND TG_OP <> 'DELETE' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'old hashtag parent is missing';
    END IF;
  END IF;

  IF v_new_hashtag_id IS NOT NULL THEN
    UPDATE public.hashtags AS hashtag
    SET post_count = hashtag.post_count + 1
    WHERE hashtag.id = v_new_hashtag_id;
    GET DIAGNOSTICS v_affected_rows = ROW_COUNT;

    IF v_affected_rows <> 1 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23503',
        MESSAGE = 'new hashtag parent is missing';
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$function$;

ALTER FUNCTION public.maintain_post_hashtag_count() OWNER TO postgres;

DO $converge_function_acl$
DECLARE
  v_function regprocedure;
  v_owner oid;
  v_grantee record;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.recount_hashtag_posts(uuid[])'::regprocedure,
    'public.maintain_post_hashtag_count()'::regprocedure
  ]::regprocedure[]
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
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC CASCADE',
          v_function
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I CASCADE',
          v_function,
          v_grantee.rolname
        );
      END IF;
    END LOOP;
  END LOOP;

  REVOKE ALL PRIVILEGES
    ON FUNCTION public.recount_hashtag_posts(uuid[])
    FROM PUBLIC, anon, authenticated, authenticator, service_role;
  GRANT EXECUTE
    ON FUNCTION public.recount_hashtag_posts(uuid[])
    TO service_role;

  REVOKE ALL PRIVILEGES
    ON FUNCTION public.maintain_post_hashtag_count()
    FROM PUBLIC, anon, authenticated, authenticator, service_role;
END
$converge_function_acl$;

DO $attest_functions$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.recount_hashtag_posts(uuid[])'::regprocedure;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.recount_hashtag_posts(uuid[]) IS %L',
    'recount-hashtag-posts:v3:' || pg_catalog.md5(v_source)
  );

  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.maintain_post_hashtag_count()'::regprocedure;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.maintain_post_hashtag_count() IS %L',
    'post-hashtag-count-integrity:v1:' || pg_catalog.md5(v_source)
  );
END
$attest_functions$;

-- Remove every replay/drift alias wired to this function before installing one
-- canonical edge, otherwise a replay could apply the same delta twice.
DO $drop_count_trigger_aliases$
DECLARE
  v_trigger record;
BEGIN
  FOR v_trigger IN
    SELECT trigger_row.tgname
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.post_hashtags'::regclass
      AND trigger_row.tgfoid =
        'public.maintain_post_hashtag_count()'::regprocedure
      AND NOT trigger_row.tgisinternal
  LOOP
    EXECUTE pg_catalog.format(
      'DROP TRIGGER %I ON public.post_hashtags',
      v_trigger.tgname
    );
  END LOOP;
END
$drop_count_trigger_aliases$;

CREATE TRIGGER trg_post_hashtags_90_maintain_post_count
AFTER INSERT OR DELETE OR UPDATE OF hashtag_id
ON public.post_hashtags
FOR EACH ROW
EXECUTE FUNCTION public.maintain_post_hashtag_count();

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
  v_trigger_function regprocedure :=
    'public.maintain_post_hashtag_count()'::regprocedure;
  v_recount_function regprocedure :=
    'public.recount_hashtag_posts(uuid[])'::regprocedure;
  v_source text;
  v_comment text;
  v_trigger_definition text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.hashtags'::regclass
      AND attribute.attname = 'post_count'
      AND attribute.atttypid = 'integer'::regtype
      AND attribute.attnotnull
      AND pg_catalog.pg_get_expr(
        default_row.adbin,
        default_row.adrelid
      ) = '0'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.hashtags'::regclass
      AND constraint_row.conname = 'hashtags_post_count_nonnegative'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.replace(
        pg_catalog.pg_get_expr(
          constraint_row.conbin,
          constraint_row.conrelid
        ),
        ' ',
        ''
      ) = '(post_count>=0)'
  ) THEN
    RAISE EXCEPTION 'hashtag post count domain hardening failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.hashtags AS hashtag
    WHERE hashtag.post_count IS DISTINCT FROM (
      SELECT pg_catalog.count(*)::integer
      FROM public.post_hashtags AS post_hashtag
      WHERE post_hashtag.hashtag_id = hashtag.id
    )
  ) THEN
    RAISE EXCEPTION 'hashtag post count convergence failed';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_trigger_function
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'trigger'::regtype
    AND pg_catalog.cardinality(function_row.proconfig) = 2
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off'
    ];

  IF v_comment IS DISTINCT FROM
       'post-hashtag-count-integrity:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, 'ORDER BY hashtag.id') = 0
     OR pg_catalog.strpos(
       v_source,
       'SET post_count = hashtag.post_count - 1'
     ) = 0
     OR pg_catalog.strpos(
       v_source,
       'SET post_count = hashtag.post_count + 1'
     ) = 0
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_proc AS function_row
       CROSS JOIN LATERAL pg_catalog.aclexplode(
         COALESCE(
           function_row.proacl,
           pg_catalog.acldefault('f', function_row.proowner)
         )
       ) AS acl_entry
       WHERE function_row.oid = v_trigger_function
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee <> v_postgres_oid
     )
  THEN
    RAISE EXCEPTION 'post hashtag count trigger authority is invalid';
  END IF;

  SELECT pg_catalog.pg_get_triggerdef(trigger_row.oid, false)
  INTO STRICT v_trigger_definition
  FROM pg_catalog.pg_trigger AS trigger_row
  WHERE trigger_row.tgrelid = 'public.post_hashtags'::regclass
    AND trigger_row.tgname =
      'trg_post_hashtags_90_maintain_post_count'
    AND trigger_row.tgfoid = v_trigger_function
    AND trigger_row.tgenabled = 'O'
    AND trigger_row.tgtype = 29
    AND trigger_row.tgnargs = 0
    AND NOT trigger_row.tgisinternal;

  IF pg_catalog.strpos(
       v_trigger_definition,
       'UPDATE OF hashtag_id'
     ) = 0 OR (
       SELECT pg_catalog.count(*)
       FROM pg_catalog.pg_trigger AS trigger_row
       WHERE trigger_row.tgrelid = 'public.post_hashtags'::regclass
         AND trigger_row.tgfoid = v_trigger_function
         AND NOT trigger_row.tgisinternal
     ) <> 1
  THEN
    RAISE EXCEPTION 'post hashtag count trigger installation is invalid';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_recount_function
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'void'::regtype
    AND pg_catalog.cardinality(function_row.proconfig) = 2
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off'
    ];

  IF v_comment IS DISTINCT FROM
       'recount-hashtag-posts:v3:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(v_source, 'ORDER BY hashtag.id') = 0
     OR pg_catalog.strpos(v_source, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(v_source, 'SET post_count = (') = 0
     OR NOT pg_catalog.has_function_privilege(
       v_service_oid,
       v_recount_function,
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
       WHERE function_row.oid = v_recount_function
         AND acl_entry.privilege_type = 'EXECUTE'
         AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
     )
  THEN
    RAISE EXCEPTION 'locked hashtag recount authority is invalid';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
