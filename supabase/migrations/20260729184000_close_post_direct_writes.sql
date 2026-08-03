-- Migration: 20260729184000_close_post_direct_writes.sql
-- Created: 2026-07-30T01:40:00Z
-- Description: Postdeploy closure for browser UPDATE access to posts. Author
--   edits and pin changes now cross service-only atomic RPCs. Authenticated
--   clients retain only the one-time poll_id link needed by the legacy create
--   flow, guarded to the post author and a poll already owned by that post.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('public.posts:close-direct-writes:migration', 0)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'post direct-write closure migration lock is busy';
  END IF;
END
$migration_lock$;

DO $preflight$
DECLARE
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_missing_roles text[];
  v_invalid_columns text[];
  v_edit_function regprocedure := pg_catalog.to_regprocedure(
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[])'
  );
  v_pin_function regprocedure := pg_catalog.to_regprocedure(
    'public.set_post_pin_state_atomic(uuid,uuid,boolean)'
  );
  v_revision_function regprocedure := pg_catalog.to_regprocedure(
    'public.advance_post_content_version()'
  );
  v_existing_guard regprocedure := pg_catalog.to_regprocedure(
    'public.guard_authenticated_post_update_boundary()'
  );
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
    RAISE EXCEPTION 'post direct-write closure roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('public.posts') IS NULL
     OR pg_catalog.to_regclass('public.polls') IS NULL
  THEN
    RAISE EXCEPTION 'canonical post and poll relations must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN ('public.posts'::regclass, 'public.polls'::regclass)
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
      'public.polls'::regclass
    )
       OR inheritance.inhparent IN (
         'public.posts'::regclass,
         'public.polls'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'public.posts'::regclass,
      'public.polls'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'post direct-write closure requires canonical permanent relations';
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
    ORDER BY required_column.schema_name,
      required_column.relation_name,
      required_column.ordinality
  )
  INTO v_invalid_columns
  FROM (
    VALUES
      ('public', 'posts', 1, 'id', 'uuid'::regtype, true),
      ('public', 'posts', 2, 'author_id', 'uuid'::regtype, true),
      ('public', 'posts', 3, 'poll_id', 'uuid'::regtype, false),
      ('public', 'posts', 4, 'title', 'text'::regtype, false),
      ('public', 'posts', 5, 'content', 'text'::regtype, false),
      ('public', 'posts', 6, 'images', 'text[]'::regtype, false),
      ('public', 'posts', 7, 'is_pinned', 'boolean'::regtype, false),
      ('public', 'posts', 8, 'content_version', 'bigint'::regtype, true),
      ('public', 'posts', 9, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'posts', 10, 'status', 'public.post_status'::regtype, true),
      ('public', 'polls', 1, 'id', 'uuid'::regtype, true),
      ('public', 'polls', 2, 'post_id', 'uuid'::regtype, false)
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
    RAISE EXCEPTION 'post direct-write closure has incompatible columns: %',
      v_invalid_columns;
  END IF;

  IF v_edit_function IS NULL
     OR v_pin_function IS NULL
     OR v_revision_function IS NULL
  THEN
    RAISE EXCEPTION 'atomic post edit, pin, and revision authorities must deploy first';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::regclass
      AND trigger_row.tgname = 'trg_posts_10_content_version'
      AND trigger_row.tgfoid = v_revision_function
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'post content revision trigger must deploy first';
  END IF;

  IF v_existing_guard IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_existing_guard
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'trigger'::regtype
  ) THEN
    RAISE EXCEPTION 'existing authenticated post update guard is incompatible';
  END IF;
END
$preflight$;

LOCK TABLE public.posts, public.polls IN SHARE MODE;

CREATE OR REPLACE FUNCTION public.guard_authenticated_post_update_boundary()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET row_security = off
AS $function$
DECLARE
  v_actor_id uuid := (SELECT auth.uid());
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'posts'
     OR TG_OP IS DISTINCT FROM 'UPDATE'
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'authenticated post update boundary is misattached';
  END IF;

  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'authenticated' THEN
    RETURN NEW;
  END IF;

  IF v_actor_id IS NULL OR OLD.author_id IS DISTINCT FROM v_actor_id THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'only the post author may bind its poll';
  END IF;

  IF OLD.deleted_at IS NOT NULL
     OR OLD.status IS DISTINCT FROM 'active'::public.post_status
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'only active posts may bind a poll';
  END IF;

  -- Column ACLs below already permit only poll_id. This independent row guard
  -- fails closed if a later grant accidentally widens authenticated UPDATE.
  IF (pg_catalog.to_jsonb(NEW) - 'poll_id') IS DISTINCT FROM
       (pg_catalog.to_jsonb(OLD) - 'poll_id')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'authenticated post updates are limited to poll binding';
  END IF;

  IF NEW.poll_id IS NOT DISTINCT FROM OLD.poll_id THEN
    RETURN NEW;
  END IF;

  IF OLD.poll_id IS NOT NULL OR NEW.poll_id IS NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'post poll binding is immutable once assigned';
  END IF;

  PERFORM poll_row.id
  FROM public.polls AS poll_row
  WHERE poll_row.id = NEW.poll_id
    AND poll_row.post_id = OLD.id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'poll must already belong to the post';
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.guard_authenticated_post_update_boundary()
  OWNER TO postgres;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.guard_authenticated_post_update_boundary()
  FROM PUBLIC, anon, authenticated, authenticator, service_role;

DO $attest_guard$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.guard_authenticated_post_update_boundary()'::regprocedure;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.guard_authenticated_post_update_boundary() IS %L',
    'authenticated-post-update-boundary:v1:' || pg_catalog.md5(v_source)
  );
END
$attest_guard$;

DROP TRIGGER IF EXISTS trg_posts_05_authenticated_update_boundary
  ON public.posts;
CREATE TRIGGER trg_posts_05_authenticated_update_boundary
BEFORE UPDATE ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.guard_authenticated_post_update_boundary();

-- Remove table-wide UPDATE and any historical column-level grants from every
-- browser-facing role. Regrant only the compatibility poll_id column.
REVOKE UPDATE ON TABLE public.posts
  FROM PUBLIC, anon, authenticated, authenticator;

DO $revoke_column_update_drift$
DECLARE
  v_role text;
  v_column record;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['PUBLIC', 'anon', 'authenticated', 'authenticator']::text[]
  LOOP
    FOR v_column IN
      SELECT attribute.attname
      FROM pg_catalog.pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.posts'::regclass
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
        AND attribute.attname <> 'poll_id'
      ORDER BY attribute.attnum
    LOOP
      IF v_role = 'PUBLIC' THEN
        EXECUTE pg_catalog.format(
          'REVOKE UPDATE (%I) ON TABLE public.posts FROM PUBLIC',
          v_column.attname
        );
      ELSE
        EXECUTE pg_catalog.format(
          'REVOKE UPDATE (%I) ON TABLE public.posts FROM %I',
          v_column.attname,
          v_role
        );
      END IF;
    END LOOP;
  END LOOP;
END
$revoke_column_update_drift$;

REVOKE UPDATE (poll_id) ON TABLE public.posts
  FROM PUBLIC, anon, authenticator;
GRANT UPDATE (poll_id) ON TABLE public.posts TO authenticated;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.guard_authenticated_post_update_boundary()'::regprocedure;
  v_postgres_oid oid := (
    SELECT role_row.oid
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = 'postgres'
  );
  v_source text;
  v_comment text;
  v_role text;
BEGIN
  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'trigger'::regtype
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off'
    ];

  IF v_comment IS DISTINCT FROM
       'authenticated-post-update-boundary:v1:' || pg_catalog.md5(v_source)
     OR pg_catalog.strpos(
       v_source,
       'pg_catalog.to_jsonb(NEW) - ''poll_id'''
     ) = 0
     OR pg_catalog.strpos(v_source, 'OLD.author_id IS DISTINCT FROM v_actor_id') = 0
     OR pg_catalog.strpos(v_source, 'poll_row.post_id = OLD.id') = 0
  THEN
    RAISE EXCEPTION 'authenticated post update guard attestation is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(
      COALESCE(
        (SELECT function_row.proacl
         FROM pg_catalog.pg_proc AS function_row
         WHERE function_row.oid = v_function),
        pg_catalog.acldefault('f', v_postgres_oid)
      )
    ) AS acl_entry
    WHERE acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee <> v_postgres_oid
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::regclass
      AND trigger_row.tgname = 'trg_posts_05_authenticated_update_boundary'
      AND trigger_row.tgfoid = v_function
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'authenticated post update guard authority is invalid';
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
    WHERE relation.oid = 'public.posts'::regclass
      AND acl_entry.grantee = 0
      AND acl_entry.privilege_type = 'UPDATE'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.posts'::regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attacl IS NOT NULL
      AND acl_entry.grantee = 0
      AND acl_entry.privilege_type = 'UPDATE'
  ) THEN
    RAISE EXCEPTION 'post UPDATE remains exposed to PUBLIC';
  END IF;

  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticator']::text[]
  LOOP
    IF pg_catalog.has_table_privilege(v_role, 'public.posts', 'UPDATE')
       OR EXISTS (
         SELECT 1
         FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = 'public.posts'::regclass
           AND attribute.attnum > 0
           AND NOT attribute.attisdropped
           AND pg_catalog.has_column_privilege(
             v_role,
             'public.posts',
             attribute.attname,
             'UPDATE'
           )
       )
    THEN
      RAISE EXCEPTION 'post UPDATE remains exposed to role %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.has_table_privilege('authenticated', 'public.posts', 'UPDATE')
     OR NOT pg_catalog.has_column_privilege(
       'authenticated', 'public.posts', 'poll_id', 'UPDATE'
     )
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.pg_attribute AS attribute
       WHERE attribute.attrelid = 'public.posts'::regclass
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
         AND attribute.attname <> 'poll_id'
         AND pg_catalog.has_column_privilege(
           'authenticated',
           'public.posts',
           attribute.attname,
           'UPDATE'
         )
     )
     OR NOT pg_catalog.has_table_privilege(
       'service_role', 'public.posts', 'UPDATE'
     )
  THEN
    RAISE EXCEPTION 'post UPDATE privilege convergence is invalid';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
