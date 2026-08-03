-- Migration: 20260729183500_atomic_post_edit.sql
-- Created: 2026-07-30T01:35:00Z
-- Description: Make author edits compare-and-swap mutations. The caller must
--   present the exact content_version revision it rendered; a stale editor receives
--   an explicit conflict instead of overwriting a newer post.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('public.posts:atomic-post-edit:migration', 0)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'atomic post edit migration lock is busy';
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
  v_expected_function regprocedure := pg_catalog.to_regprocedure(
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[])'
  );
BEGIN
  SELECT pg_catalog.array_agg(required_role ORDER BY required_role)
  INTO v_missing_roles
  FROM pg_catalog.unnest(
    ARRAY['anon', 'authenticated', 'service_role', 'postgres']::text[]
  ) AS required_role
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname = required_role
  );

  IF v_missing_roles IS NOT NULL THEN
    RAISE EXCEPTION 'atomic post edit roles are missing: %', v_missing_roles;
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('public.user_profiles') IS NULL
     OR pg_catalog.to_regclass('public.posts') IS NULL
  THEN
    RAISE EXCEPTION 'canonical post edit relations must deploy first';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.posts'::regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'public.user_profiles'::regclass,
      'public.posts'::regclass
    )
      AND relation.relowner <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION 'post edit requires canonical permanent relation ownership';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.posts'::regclass
    )
       OR inheritance.inhparent IN (
         'auth.users'::regclass,
         'public.user_profiles'::regclass,
         'public.posts'::regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'auth.users'::regclass,
      'public.user_profiles'::regclass,
      'public.posts'::regclass
    )
  ) THEN
    RAISE EXCEPTION 'post edit relations must not use inheritance or rewrite rules';
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
      ('auth', 'users', 1, 'id', 'uuid'::regtype, true),
      ('public', 'user_profiles', 1, 'id', 'uuid'::regtype, true),
      ('public', 'user_profiles', 2, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 3, 'banned_at', 'timestamptz'::regtype, false),
      ('public', 'user_profiles', 4, 'is_banned', 'boolean'::regtype, true),
      ('public', 'user_profiles', 5, 'ban_expires_at', 'timestamptz'::regtype, false),
      ('public', 'posts', 1, 'id', 'uuid'::regtype, true),
      ('public', 'posts', 2, 'author_id', 'uuid'::regtype, true),
      ('public', 'posts', 3, 'group_id', 'uuid'::regtype, false),
      ('public', 'posts', 4, 'title', 'text'::regtype, false),
      ('public', 'posts', 5, 'content', 'text'::regtype, false),
      ('public', 'posts', 6, 'images', 'text[]'::regtype, false),
      ('public', 'posts', 7, 'updated_at', 'timestamptz'::regtype, false),
      ('public', 'posts', 8, 'deleted_at', 'timestamptz'::regtype, false),
      ('public', 'posts', 9, 'status', 'public.post_status'::regtype, true)
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
    RAISE EXCEPTION 'post edit has incompatible columns: %', v_invalid_columns;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = 'public.posts'::regclass
      AND attribute.attname = 'content_version'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.atttypid <> 'bigint'::regtype
  ) THEN
    RAISE EXCEPTION 'posts.content_version has an incompatible type';
  END IF;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL OR (
    SELECT function_row.prorettype
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
  ) <> 'text'::regtype THEN
    RAISE EXCEPTION 'auth.role() returning text must exist';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    JOIN pg_catalog.pg_namespace AS namespace_row
      ON namespace_row.oid = function_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND function_row.proname = 'edit_post_atomic'
      AND (
        v_expected_function IS NULL
        OR function_row.oid <> v_expected_function::oid
      )
  ) THEN
    RAISE EXCEPTION 'existing edit_post_atomic signature is incompatible';
  END IF;
END
$preflight$;

LOCK TABLE auth.users, public.user_profiles, public.posts IN SHARE MODE;

ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS content_version bigint;
ALTER TABLE public.posts
  ALTER COLUMN content_version SET DEFAULT 0;
UPDATE public.posts AS post_row
SET content_version = 0
WHERE post_row.content_version IS NULL;
ALTER TABLE public.posts
  ALTER COLUMN content_version SET NOT NULL;

DO $content_version_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.posts'::regclass
      AND constraint_row.conname = 'posts_content_version_nonnegative'
  ) THEN
    ALTER TABLE public.posts
      ADD CONSTRAINT posts_content_version_nonnegative
      CHECK (content_version >= 0) NOT VALID;
  END IF;
END
$content_version_constraint$;
ALTER TABLE public.posts
  VALIDATE CONSTRAINT posts_content_version_nonnegative;

CREATE OR REPLACE FUNCTION public.advance_post_content_version()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF TG_TABLE_SCHEMA IS DISTINCT FROM 'public'
     OR TG_TABLE_NAME IS DISTINCT FROM 'posts'
     OR TG_OP NOT IN ('INSERT', 'UPDATE')
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post content version trigger is misattached';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.content_version := 0;
    RETURN NEW;
  END IF;

  IF NEW.title IS DISTINCT FROM OLD.title
     OR NEW.content IS DISTINCT FROM OLD.content
     OR NEW.images IS DISTINCT FROM OLD.images
  THEN
    IF OLD.content_version = 9223372036854775807 THEN
      RAISE EXCEPTION USING
        ERRCODE = '22003',
        MESSAGE = 'post content version exhausted';
    END IF;
    NEW.content_version := OLD.content_version + 1;
    NEW.updated_at := pg_catalog.clock_timestamp();
    IF OLD.updated_at IS NOT NULL AND NEW.updated_at <= OLD.updated_at THEN
      NEW.updated_at := OLD.updated_at + '1 microsecond'::interval;
    END IF;
  ELSE
    -- content_version is database-owned. Counter, moderation, and other
    -- metadata writers cannot forge or roll back a rendered edit revision.
    NEW.content_version := OLD.content_version;
  END IF;

  RETURN NEW;
END
$function$;

ALTER FUNCTION public.advance_post_content_version() OWNER TO postgres;
REVOKE ALL PRIVILEGES
  ON FUNCTION public.advance_post_content_version()
  FROM PUBLIC, anon, authenticated, service_role;

DO $attest_content_version_function$
DECLARE
  v_source text;
BEGIN
  SELECT function_row.prosrc
  INTO STRICT v_source
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
    'public.advance_post_content_version()'::regprocedure;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION public.advance_post_content_version() IS %L',
    'post-content-version:v1:' || pg_catalog.md5(v_source)
  );
END
$attest_content_version_function$;

DROP TRIGGER IF EXISTS trg_posts_10_content_version ON public.posts;
CREATE TRIGGER trg_posts_10_content_version
BEFORE INSERT OR UPDATE ON public.posts
FOR EACH ROW
EXECUTE FUNCTION public.advance_post_content_version();

CREATE OR REPLACE FUNCTION public.edit_post_atomic(
  p_actor_id uuid,
  p_post_id uuid,
  p_expected_version bigint,
  p_title text,
  p_content text,
  p_update_images boolean,
  p_images text[]
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
  v_observed_author_id uuid;
  v_observed_group_id uuid;
  v_profile public.user_profiles%ROWTYPE;
  v_post public.posts%ROWTYPE;
  v_updated_post public.posts%ROWTYPE;
  v_update_count integer := 0;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_actor_id IS NULL
     OR p_post_id IS NULL
     OR p_expected_version IS NULL
     OR p_expected_version < 0
     OR p_title IS NULL
     OR p_content IS NULL
     OR p_update_images IS NULL
     OR pg_catalog.length(p_title) NOT BETWEEN 1 AND 200
     OR p_title IS DISTINCT FROM pg_catalog.btrim(p_title)
     OR p_title ~ '[[:cntrl:]]'
     OR pg_catalog.length(p_content) > 50000
     OR pg_catalog.regexp_replace(p_content, E'[\\n\\r\\t]', '', 'g') ~ '[[:cntrl:]]'
     OR (NOT p_update_images AND p_images IS NOT NULL)
     OR (p_update_images AND p_images IS NULL)
     OR (p_update_images AND pg_catalog.cardinality(p_images) > 9)
     OR (
       p_update_images
       AND EXISTS (
         SELECT 1
         FROM pg_catalog.unnest(p_images) AS image_url
         WHERE image_url IS NULL
            OR pg_catalog.length(image_url) NOT BETWEEN 1 AND 2048
            OR image_url IS DISTINCT FROM pg_catalog.btrim(image_url)
            OR image_url !~* '^https?://[^[:space:][:cntrl:]]+$'
       )
     )
     OR (
       p_update_images
       AND (
         SELECT pg_catalog.count(DISTINCT image_url)
         FROM pg_catalog.unnest(p_images) AS image_url
       ) <> pg_catalog.cardinality(p_images)
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'invalid');
  END IF;

  -- Observe only immutable scope identity before choosing the canonical group
  -- membership lock. The row is re-attested after it is locked below.
  SELECT target.author_id,
         target.group_id
  INTO v_observed_author_id,
       v_observed_group_id
  FROM public.posts AS target
  WHERE target.id = p_post_id
    AND target.deleted_at IS NULL
    AND target.status = 'active'::public.post_status;

  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  -- Group publication triggers take this lock before profiles/membership.
  -- Matching that order prevents an edit from deadlocking membership writers.
  IF v_observed_group_id IS NOT NULL THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        'group-membership:' || v_observed_group_id::text || ':' || p_actor_id::text,
        0
      )
    );
  END IF;

  PERFORM auth_user.id
  FROM auth.users AS auth_user
  WHERE auth_user.id = p_actor_id
  FOR SHARE;
  IF NOT FOUND THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  SELECT profile.*
  INTO v_profile
  FROM public.user_profiles AS profile
  WHERE profile.id = p_actor_id
  FOR UPDATE;
  IF NOT FOUND
     OR v_profile.deleted_at IS NOT NULL
     OR v_profile.banned_at IS NOT NULL
     OR (
       COALESCE(v_profile.is_banned, false)
       AND (
         v_profile.ban_expires_at IS NULL
         OR v_profile.ban_expires_at > pg_catalog.clock_timestamp()
       )
     )
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'account_inactive');
  END IF;

  SELECT target.*
  INTO v_post
  FROM public.posts AS target
  WHERE target.id = p_post_id
  FOR UPDATE;

  IF NOT FOUND
     OR v_post.deleted_at IS NOT NULL
     OR v_post.status IS DISTINCT FROM 'active'::public.post_status
  THEN
    RETURN pg_catalog.jsonb_build_object('status', 'not_found');
  END IF;

  IF v_post.author_id IS DISTINCT FROM v_observed_author_id
     OR v_post.group_id IS DISTINCT FROM v_observed_group_id
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '40001',
      MESSAGE = 'post edit scope changed before its canonical lock';
  END IF;

  IF v_post.author_id IS DISTINCT FROM p_actor_id THEN
    RETURN pg_catalog.jsonb_build_object('status', 'forbidden');
  END IF;

  -- A retry after a lost acknowledgement is safe even if its rendered token
  -- is now stale: identical desired content is an explicit unchanged success.
  IF v_post.title IS NOT DISTINCT FROM p_title
     AND v_post.content IS NOT DISTINCT FROM p_content
     AND (
       NOT p_update_images
       OR v_post.images IS NOT DISTINCT FROM p_images
     )
  THEN
    RETURN pg_catalog.jsonb_build_object(
      'status', 'unchanged',
      'actor_id', p_actor_id,
      'post', pg_catalog.jsonb_build_object(
        'id', v_post.id,
        'author_id', v_post.author_id,
        'group_id', v_post.group_id,
        'title', v_post.title,
        'content', v_post.content,
        'images', v_post.images,
        'content_version', v_post.content_version,
        'updated_at', v_post.updated_at
      )
    );
  END IF;

  IF v_post.content_version IS DISTINCT FROM p_expected_version THEN
    RETURN pg_catalog.jsonb_build_object('status', 'conflict');
  END IF;

  UPDATE public.posts AS target
  SET title = p_title,
      content = p_content,
      images = CASE WHEN p_update_images THEN p_images ELSE v_post.images END
  WHERE target.id = p_post_id
    AND target.author_id = p_actor_id
    AND target.deleted_at IS NULL
    AND target.status = 'active'::public.post_status
    AND target.content_version = p_expected_version
  RETURNING target.* INTO v_updated_post;
  GET DIAGNOSTICS v_update_count = ROW_COUNT;

  IF v_update_count <> 1
     OR v_updated_post.id IS DISTINCT FROM p_post_id
     OR v_updated_post.author_id IS DISTINCT FROM p_actor_id
     OR v_updated_post.group_id IS DISTINCT FROM v_post.group_id
     OR v_updated_post.title IS DISTINCT FROM p_title
     OR v_updated_post.content IS DISTINCT FROM p_content
     OR v_updated_post.images IS DISTINCT FROM (
       CASE WHEN p_update_images THEN p_images ELSE v_post.images END
     )
     OR v_updated_post.content_version <> v_post.content_version + 1
     OR v_updated_post.updated_at IS NULL
     OR v_updated_post.updated_at IS NOT DISTINCT FROM v_post.updated_at
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'post edit acknowledgement is invalid';
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'updated',
    'actor_id', p_actor_id,
    'post', pg_catalog.jsonb_build_object(
      'id', v_updated_post.id,
      'author_id', v_updated_post.author_id,
      'group_id', v_updated_post.group_id,
      'title', v_updated_post.title,
      'content', v_updated_post.content,
      'images', v_updated_post.images,
      'content_version', v_updated_post.content_version,
      'updated_at', v_updated_post.updated_at
    )
  );
END
$function$;

ALTER FUNCTION public.edit_post_atomic(
  uuid, uuid, bigint, text, text, boolean, text[]
) OWNER TO postgres;

DO $converge_acl_and_attest$
DECLARE
  v_function regprocedure :=
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[])'::regprocedure;
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
    ON FUNCTION public.edit_post_atomic(
      uuid, uuid, bigint, text, text, boolean, text[]
    )
    FROM PUBLIC, anon, authenticated, service_role;
  GRANT EXECUTE
    ON FUNCTION public.edit_post_atomic(
      uuid, uuid, bigint, text, text, boolean, text[]
    )
    TO service_role;

  EXECUTE pg_catalog.format(
    'COMMENT ON FUNCTION %s IS %L',
    v_function,
    'atomic-post-edit:v1:' || pg_catalog.md5(v_source)
  );
END
$converge_acl_and_attest$;

DO $postflight$
DECLARE
  v_function regprocedure :=
    'public.edit_post_atomic(uuid,uuid,bigint,text,text,boolean,text[])'::regprocedure;
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
  v_comment text;
  v_revision_source text;
  v_revision_comment text;
BEGIN
  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_source, v_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid = v_function
    AND function_row.proowner = v_postgres_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'jsonb'::regtype
    AND function_row.proconfig @> ARRAY[
      'search_path=pg_catalog, pg_temp',
      'row_security=off',
      'lock_timeout=5s',
      'statement_timeout=15s'
    ];

  IF v_comment IS DISTINCT FROM 'atomic-post-edit:v1:' || pg_catalog.md5(v_source) THEN
    RAISE EXCEPTION 'atomic post edit function attestation is invalid';
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
      AND acl_entry.grantee NOT IN (v_postgres_oid, v_service_oid)
  ) OR NOT pg_catalog.has_function_privilege(
    'service_role', v_function, 'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'atomic post edit function ACL is invalid';
  END IF;

  IF pg_catalog.strpos(v_source, 'FOR UPDATE') = 0
     OR pg_catalog.strpos(
       v_source,
       'v_post.content_version IS DISTINCT FROM p_expected_version'
     ) = 0
     OR pg_catalog.strpos(
       v_source,
       'target.content_version = p_expected_version'
     ) = 0
     OR pg_catalog.strpos(v_source, 'v_update_count <> 1') = 0
  THEN
    RAISE EXCEPTION 'atomic post edit compare-and-swap source is invalid';
  END IF;

  SELECT function_row.prosrc,
         pg_catalog.obj_description(function_row.oid, 'pg_proc')
  INTO STRICT v_revision_source, v_revision_comment
  FROM pg_catalog.pg_proc AS function_row
  WHERE function_row.oid =
      'public.advance_post_content_version()'::regprocedure
    AND function_row.proowner = v_postgres_oid
    AND NOT function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.prorettype = 'trigger'::regtype
    AND function_row.proconfig @> ARRAY['search_path=pg_catalog, pg_temp'];

  IF v_revision_comment IS DISTINCT FROM
       'post-content-version:v1:' || pg_catalog.md5(v_revision_source)
     OR pg_catalog.strpos(
       v_revision_source,
       'NEW.content_version := OLD.content_version + 1'
     ) = 0
     OR pg_catalog.strpos(
       v_revision_source,
       'NEW.content_version := OLD.content_version'
     ) = 0
  THEN
    RAISE EXCEPTION 'post content revision function attestation is invalid';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.aclexplode(
      COALESCE(
        (SELECT function_row.proacl
         FROM pg_catalog.pg_proc AS function_row
         WHERE function_row.oid =
           'public.advance_post_content_version()'::regprocedure),
        pg_catalog.acldefault('f', v_postgres_oid)
      )
    ) AS acl_entry
    WHERE acl_entry.privilege_type = 'EXECUTE'
      AND acl_entry.grantee <> v_postgres_oid
  ) THEN
    RAISE EXCEPTION 'post content revision function ACL is invalid';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS default_row
      ON default_row.adrelid = attribute.attrelid
     AND default_row.adnum = attribute.attnum
    WHERE attribute.attrelid = 'public.posts'::regclass
      AND attribute.attname = 'content_version'
      AND attribute.atttypid = 'bigint'::regtype
      AND attribute.attnotnull
      AND pg_catalog.pg_get_expr(
        default_row.adbin,
        default_row.adrelid
      ) = '0'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.posts'::regclass
      AND constraint_row.conname = 'posts_content_version_nonnegative'
      AND constraint_row.contype = 'c'
      AND constraint_row.convalidated
      AND pg_catalog.pg_get_constraintdef(constraint_row.oid) ~
        'CHECK \(\(content_version >= 0\)\)'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.posts'::regclass
      AND trigger_row.tgname = 'trg_posts_10_content_version'
      AND trigger_row.tgfoid =
        'public.advance_post_content_version()'::regprocedure
      AND trigger_row.tgenabled = 'O'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'post content revision schema is invalid';
  END IF;
END
$postflight$;

NOTIFY pgrst, 'reload schema';

COMMIT;
