-- Migration: 20260803110000_post_media_upload_registry.sql
-- Created: 2026-08-03T11:00:00Z
-- Description: Add an inert, private reservation registry for posts-bucket
--   uploads. This expand migration does not change any upload route and does
--   not admit, lease, claim, delete, or garbage-collect an object. Later
--   migrations may compose this substrate only after every media claim writer
--   has an atomic registry boundary.
-- Phase: predeploy.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('public-post-media-upload-registry@1', 0)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'post media upload registry migration lock is busy';
  END IF;
END
$migration_lock$;

-- PostgreSQL 17 separates ADMIN, inheritance, and SET ROLE authority. Audit
-- both directions of the graph: which roles can assume/mint service_role, and
-- which roles service_role itself can assume/mint. The sole browser-adjacent
-- exception is the exact Supabase authenticator edge. A reviewed
-- cli_login_postgres bridge is accepted only through postgres with its exact
-- low-privilege role attributes and membership options.
CREATE OR REPLACE FUNCTION pg_temp.post_media_registry_role_graph_is_safe()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
AS $function$
  WITH RECURSIVE protected_root AS (
    SELECT
      role_row.oid AS origin_oid,
      role_row.rolname AS origin_name,
      role_row.rolsuper,
      role_row.rolbypassrls
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.rolname IN (
      'anon', 'authenticated', 'authenticator', 'service_role'
    )
  ), membership_path AS (
    SELECT
      protected_root.origin_name,
      membership.roleid AS reachable_oid,
      1 AS depth,
      ARRAY[protected_root.origin_oid, membership.roleid]::oid[] AS visited,
      membership.admin_option,
      membership.inherit_option,
      membership.set_option
    FROM protected_root
    JOIN pg_catalog.pg_auth_members AS membership
      ON membership.member = protected_root.origin_oid

    UNION ALL

    SELECT
      membership_path.origin_name,
      membership.roleid,
      membership_path.depth + 1,
      membership_path.visited || membership.roleid,
      membership.admin_option,
      membership.inherit_option,
      membership.set_option
    FROM membership_path
    JOIN pg_catalog.pg_auth_members AS membership
      ON membership.member = membership_path.reachable_oid
    WHERE NOT membership.roleid = ANY (membership_path.visited)
  ), service_authority AS (
    SELECT membership.member AS member_oid
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = pg_catalog.to_regrole('service_role')
      AND (
        membership.admin_option
        OR membership.inherit_option
        OR membership.set_option
      )

    UNION

    SELECT membership.member
    FROM pg_catalog.pg_auth_members AS membership
    JOIN service_authority AS inherited
      ON membership.roleid = inherited.member_oid
    WHERE membership.admin_option
       OR membership.inherit_option
       OR membership.set_option
  ), service_inherits AS (
    SELECT membership.roleid AS role_oid
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.member = pg_catalog.to_regrole('service_role')
      AND (
        membership.admin_option
        OR membership.inherit_option
        OR membership.set_option
      )

    UNION

    SELECT membership.roleid
    FROM pg_catalog.pg_auth_members AS membership
    JOIN service_inherits AS inherited
      ON membership.member = inherited.role_oid
    WHERE membership.admin_option
       OR membership.inherit_option
       OR membership.set_option
  )
  SELECT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = pg_catalog.to_regrole('service_role')
      AND membership.member = pg_catalog.to_regrole('authenticator')
      AND NOT membership.admin_option
      AND NOT membership.inherit_option
      AND membership.set_option
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_auth_members AS membership
    WHERE membership.roleid = pg_catalog.to_regrole('service_role')
      AND membership.member NOT IN (
        pg_catalog.to_regrole('authenticator'),
        pg_catalog.to_regrole('postgres')
      )
  ) AND NOT EXISTS (
    SELECT 1
    FROM service_authority AS inherited
    JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = inherited.member_oid
    WHERE inherited.member_oid NOT IN (
      pg_catalog.to_regrole('authenticator'),
      pg_catalog.to_regrole('postgres')
    )
      AND NOT (
        role_row.rolname = 'cli_login_postgres'
        AND role_row.rolcanlogin
        AND NOT role_row.rolinherit
        AND NOT role_row.rolcreaterole
        AND NOT role_row.rolcreatedb
        AND NOT role_row.rolreplication
        AND NOT role_row.rolbypassrls
        AND NOT role_row.rolsuper
        AND EXISTS (
          SELECT 1
          FROM pg_catalog.pg_auth_members AS managed_membership
          WHERE managed_membership.roleid = pg_catalog.to_regrole('postgres')
            AND managed_membership.member = role_row.oid
            AND NOT managed_membership.admin_option
            AND NOT managed_membership.inherit_option
            AND managed_membership.set_option
        )
      )
  ) AND NOT EXISTS (
    SELECT 1 FROM service_inherits
  ) AND NOT EXISTS (
    SELECT 1
    FROM protected_root
    WHERE (
      protected_root.origin_name IN ('anon', 'authenticated')
      AND (protected_root.rolsuper OR protected_root.rolbypassrls)
    ) OR (
      protected_root.origin_name = 'authenticator'
      AND (protected_root.rolsuper OR protected_root.rolbypassrls)
    ) OR (
      protected_root.origin_name = 'service_role'
      AND protected_root.rolsuper
    )
  ) AND NOT EXISTS (
    SELECT 1
    FROM membership_path
    JOIN pg_catalog.pg_roles AS reachable_role
      ON reachable_role.oid = membership_path.reachable_oid
    WHERE (
      membership_path.origin_name IN ('anon', 'authenticated')
      AND (
        reachable_role.rolname IN ('service_role', 'postgres')
        OR reachable_role.rolsuper
        OR reachable_role.rolbypassrls
      )
    ) OR (
      membership_path.origin_name = 'authenticator'
      AND (
        (
          reachable_role.rolname = 'service_role'
          AND NOT (
            membership_path.depth = 1
            AND membership_path.set_option
            AND NOT membership_path.inherit_option
            AND NOT membership_path.admin_option
          )
        ) OR (
          reachable_role.rolname <> 'service_role'
          AND (
            reachable_role.rolname = 'postgres'
            OR reachable_role.rolsuper
            OR reachable_role.rolbypassrls
          )
        )
      )
    )
  )
$function$;

LOCK TABLE auth.users, storage.objects IN SHARE MODE;

DO $preflight$
DECLARE
  v_role text;
  v_expected record;
  v_existing regprocedure;
  v_source text;
  v_comment text;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
  THEN
    RAISE EXCEPTION 'post media upload registry requires PostgreSQL 17';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'postgres',
    'anon',
    'authenticated',
    'authenticator',
    'service_role'
  ]::text[]
  LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'required post-media registry role is unavailable: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regprocedure('auth.role()') IS NULL
     OR (
       SELECT function_row.prorettype
       FROM pg_catalog.pg_proc AS function_row
       WHERE function_row.oid = pg_catalog.to_regprocedure('auth.role()')
     ) <> 'text'::pg_catalog.regtype
  THEN
    RAISE EXCEPTION 'auth.role() returning text is required';
  END IF;

  IF pg_catalog.to_regclass('auth.users') IS NULL
     OR pg_catalog.to_regclass('storage.buckets') IS NULL
     OR pg_catalog.to_regclass('storage.objects') IS NULL
  THEN
    RAISE EXCEPTION 'post media upload registry foundations are missing';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('auth.users', 'id', 'uuid'::pg_catalog.regtype, true),
        ('storage.buckets', 'id', 'text'::pg_catalog.regtype, true),
        ('storage.buckets', 'name', 'text'::pg_catalog.regtype, true),
        ('storage.objects', 'bucket_id', 'text'::pg_catalog.regtype, false),
        ('storage.objects', 'name', 'text'::pg_catalog.regtype, false)
    ) AS expected(relation_name, column_name, type_oid, required_not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass(expected.relation_name)
     AND attribute.attname = expected.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> expected.type_oid
       OR (expected.required_not_null AND NOT attribute.attnotnull)
  ) THEN
    RAISE EXCEPTION 'post media upload registry dependency columns drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = 'storage.objects'::pg_catalog.regclass
      AND index_row.indisunique
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 2
      AND index_row.indnatts = 2
      AND (
        SELECT pg_catalog.array_agg(attribute.attname ORDER BY key.ordinality)
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key.attnum
      ) = ARRAY['bucket_id', 'name']::name[]
  ) THEN
    RAISE EXCEPTION 'storage.objects bucket/name identity is not unique';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM storage.buckets AS bucket
    WHERE bucket.id = 'posts'
      AND bucket.name = 'posts'
  ) THEN
    RAISE EXCEPTION 'canonical posts bucket is required';
  END IF;

  IF NOT pg_temp.post_media_registry_role_graph_is_safe() THEN
    RAISE EXCEPTION 'post media upload registry role graph is unsafe';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.pronamespace = 'public'::pg_catalog.regnamespace
      AND function_row.proname IN (
        'reserve_post_media_upload_atomic',
        'finalize_post_media_upload_atomic'
      )
      AND function_row.oid IS DISTINCT FROM CASE function_row.proname
        WHEN 'reserve_post_media_upload_atomic' THEN
          pg_catalog.to_regprocedure(
            'public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'
          )::oid
        WHEN 'finalize_post_media_upload_atomic' THEN
          pg_catalog.to_regprocedure(
            'public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'
          )::oid
      END
  ) THEN
    RAISE EXCEPTION 'incompatible post media upload registry overload exists';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
          'post-media-upload-registry:reserve-v1:'
        ),
        (
          'public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
          'post-media-upload-registry:finalize-v1:'
        )
    ) AS expected(signature, comment_prefix)
  LOOP
    v_existing := pg_catalog.to_regprocedure(v_expected.signature);
    IF v_existing IS NOT NULL THEN
      SELECT function_row.prosrc,
             pg_catalog.obj_description(function_row.oid, 'pg_proc')
      INTO STRICT v_source, v_comment
      FROM pg_catalog.pg_proc AS function_row
      WHERE function_row.oid = v_existing;

      IF v_comment IS DISTINCT FROM
           v_expected.comment_prefix || pg_catalog.md5(v_source)
      THEN
        RAISE EXCEPTION
          'existing post media upload registry function source seal drifted: %',
          v_existing;
      END IF;
    END IF;
  END LOOP;
END
$preflight$;

CREATE TABLE IF NOT EXISTS public.post_media_uploads (
  upload_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  object_name text NOT NULL,
  purpose text NOT NULL,
  mime_type text NOT NULL,
  size_bytes bigint NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT pg_catalog.statement_timestamp(),
  gc_admitted_at timestamptz,
  CONSTRAINT post_media_uploads_pkey PRIMARY KEY (upload_id),
  CONSTRAINT post_media_uploads_object_name_key UNIQUE (object_name),
  CONSTRAINT post_media_uploads_purpose_check CHECK (
    purpose IN ('post_image', 'post_video', 'group_avatar', 'legacy_image')
  ),
  CONSTRAINT post_media_uploads_status_check CHECK (
    status IN ('reserved', 'uploaded')
  ),
  CONSTRAINT post_media_uploads_object_name_check CHECK (
    object_name = pg_catalog.btrim(object_name)
    AND pg_catalog.octet_length(object_name) BETWEEN 1 AND 512
    AND object_name !~ '[[:cntrl:]]'
    AND object_name !~ '(^/|/$|//|(^|/)\.{1,2}(/|$))'
  ),
  CONSTRAINT post_media_uploads_media_check CHECK (
    (
      purpose IN ('post_image', 'group_avatar', 'legacy_image')
      AND object_name ~ (
        '^' || pg_catalog.lower(owner_id::text)
          || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
          || '\.(jpg|png|gif|webp|avif)$'
      )
      AND mime_type IN (
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/avif'
      )
      AND (
        (mime_type = 'image/jpeg' AND pg_catalog.right(object_name, 4) = '.jpg')
        OR (mime_type = 'image/png' AND pg_catalog.right(object_name, 4) = '.png')
        OR (mime_type = 'image/gif' AND pg_catalog.right(object_name, 4) = '.gif')
        OR (mime_type = 'image/webp' AND pg_catalog.right(object_name, 5) = '.webp')
        OR (mime_type = 'image/avif' AND pg_catalog.right(object_name, 5) = '.avif')
      )
      AND size_bytes BETWEEN 1 AND 5242880
    ) OR (
      purpose = 'post_video'
      AND object_name ~ (
        '^' || pg_catalog.lower(owner_id::text)
          || '/videos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
          || '\.(mp4|mov|webm|mkv|avi)$'
      )
      AND mime_type IN (
        'video/mp4',
        'video/quicktime',
        'video/webm',
        'video/x-matroska',
        'video/x-msvideo'
      )
      AND (
        (mime_type = 'video/mp4' AND pg_catalog.right(object_name, 4) = '.mp4')
        OR (mime_type = 'video/quicktime' AND pg_catalog.right(object_name, 4) = '.mov')
        OR (mime_type = 'video/webm' AND pg_catalog.right(object_name, 5) = '.webm')
        OR (mime_type = 'video/x-matroska' AND pg_catalog.right(object_name, 4) = '.mkv')
        OR (mime_type = 'video/x-msvideo' AND pg_catalog.right(object_name, 4) = '.avi')
      )
      AND size_bytes BETWEEN 1 AND 104857600
    )
  ),
  CONSTRAINT post_media_uploads_lifecycle_check CHECK (
    pg_catalog.isfinite(expires_at)
    AND pg_catalog.isfinite(created_at)
    AND pg_catalog.isfinite(updated_at)
    AND expires_at > created_at
    AND updated_at >= created_at
    AND gc_admitted_at IS NULL
  )
);

ALTER TABLE public.post_media_uploads OWNER TO postgres;
ALTER TABLE public.post_media_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_media_uploads FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS post_media_uploads_expiry_idx
  ON public.post_media_uploads (status, expires_at, upload_id);

DO $table_shape_preflight$
DECLARE
  v_registry regclass := 'public.post_media_uploads'::pg_catalog.regclass;
BEGIN
  IF (
    SELECT relation.relkind = 'r'
      AND relation.relpersistence = 'p'
      AND NOT relation.relispartition
      AND relation.relowner = pg_catalog.to_regrole('postgres')
      AND relation.relrowsecurity
      AND relation.relforcerowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = v_registry
  ) IS NOT TRUE OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid = v_registry
       OR inheritance.inhparent = v_registry
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class = v_registry
      AND rewrite_rule.rulename <> '_RETURN'
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = v_registry
      AND NOT trigger_row.tgisinternal
  ) OR EXISTS (
    SELECT 1
    FROM (
      VALUES
        (1, 'upload_id', 'uuid', true),
        (2, 'owner_id', 'uuid', true),
        (3, 'object_name', 'text', true),
        (4, 'purpose', 'text', true),
        (5, 'mime_type', 'text', true),
        (6, 'size_bytes', 'bigint', true),
        (7, 'status', 'text', true),
        (8, 'expires_at', 'timestamp with time zone', true),
        (9, 'created_at', 'timestamp with time zone', true),
        (10, 'updated_at', 'timestamp with time zone', true),
        (11, 'gc_admitted_at', 'timestamp with time zone', false)
    ) AS expected(ordinality, column_name, type_name, required_not_null)
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = v_registry
     AND attribute.attnum = expected.ordinality
     AND attribute.attname = expected.column_name
     AND NOT attribute.attisdropped
    WHERE attribute.attname IS NULL
       OR pg_catalog.format_type(attribute.atttypid, attribute.atttypmod)
            <> expected.type_name
       OR attribute.attnotnull IS DISTINCT FROM expected.required_not_null
       OR attribute.attidentity <> ''
       OR attribute.attgenerated <> ''
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_attribute AS attribute
    WHERE attribute.attrelid = v_registry
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  ) <> 11 OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_registry
  ) <> 7 OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_registry
      AND constraint_row.contype = 'f'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_registry
      AND constraint_row.conname = 'post_media_uploads_pkey'
      AND constraint_row.contype = 'p'
      AND constraint_row.conkey = ARRAY[1]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_registry
      AND constraint_row.conname = 'post_media_uploads_object_name_key'
      AND constraint_row.contype = 'u'
      AND constraint_row.conkey = ARRAY[3]::smallint[]
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = v_registry
      AND constraint_row.conname NOT IN (
        'post_media_uploads_pkey',
        'post_media_uploads_object_name_key',
        'post_media_uploads_purpose_check',
        'post_media_uploads_status_check',
        'post_media_uploads_object_name_check',
        'post_media_uploads_media_check',
        'post_media_uploads_lifecycle_check'
      )
  ) OR EXISTS (
    -- Reviewed PostgreSQL 17 pg_get_constraintdef(..., true) digests pin
    -- complete bodies, not only attacker-reusable constraint names.
    SELECT 1
    FROM (
      VALUES
        ('post_media_uploads_lifecycle_check', '6110171e15c955de46058c9a0e800174'),
        ('post_media_uploads_media_check', 'b607d427abf640dd52d74f07b780542b'),
        ('post_media_uploads_object_name_check', '5e1c4876bde6236817377ec6964762a3'),
        ('post_media_uploads_object_name_key', '693ce417e8b6cde5db0a40e4b6b4f057'),
        ('post_media_uploads_pkey', '4fb802a92a43361ca53ee08d48a1d19c'),
        ('post_media_uploads_purpose_check', 'bf4dc82a81f6e525549898b9a30abd02'),
        ('post_media_uploads_status_check', '675ed1dfca4b0e465550cc52151b706d')
    ) AS expected(constraint_name, definition_digest)
    LEFT JOIN pg_catalog.pg_constraint AS constraint_row
      ON constraint_row.conrelid = v_registry
     AND constraint_row.conname = expected.constraint_name
    WHERE constraint_row.oid IS NULL
       OR pg_catalog.md5(
            pg_catalog.pg_get_constraintdef(constraint_row.oid, true)
          ) IS DISTINCT FROM expected.definition_digest
  ) OR (
    SELECT pg_catalog.pg_get_expr(
      column_default.adbin,
      column_default.adrelid,
      true
    )
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attrelid = v_registry
      AND attribute.attname = 'status'
  ) IS DISTINCT FROM '''reserved''::text' OR (
    SELECT pg_catalog.pg_get_expr(
      column_default.adbin,
      column_default.adrelid,
      true
    )
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attrelid = v_registry
      AND attribute.attname = 'created_at'
  ) IS DISTINCT FROM 'statement_timestamp()' OR (
    SELECT pg_catalog.pg_get_expr(
      column_default.adbin,
      column_default.adrelid,
      true
    )
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attrelid = v_registry
      AND attribute.attname = 'updated_at'
  ) IS DISTINCT FROM 'statement_timestamp()' OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_attrdef AS column_default
      ON column_default.adrelid = attribute.attrelid
     AND column_default.adnum = attribute.attnum
    WHERE attribute.attrelid = v_registry
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.attname NOT IN ('status', 'created_at', 'updated_at')
  ) THEN
    RAISE EXCEPTION 'post media upload registry table shape drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS index_row
    JOIN pg_catalog.pg_class AS index_relation
      ON index_relation.oid = index_row.indexrelid
    JOIN pg_catalog.pg_am AS access_method
      ON access_method.oid = index_relation.relam
    WHERE index_relation.relname = 'post_media_uploads_expiry_idx'
      AND index_row.indrelid = v_registry
      AND NOT index_row.indisunique
      AND NOT index_row.indisprimary
      AND index_row.indisvalid
      AND index_row.indisready
      AND index_row.indpred IS NULL
      AND index_row.indexprs IS NULL
      AND index_row.indnkeyatts = 3
      AND index_row.indnatts = 3
      AND access_method.amname = 'btree'
      -- Reviewed PostgreSQL 17 pg_get_indexdef digest pins ordering,
      -- collations, opclasses, NULL placement, predicates, and options.
      AND pg_catalog.md5(
        pg_catalog.pg_get_indexdef(index_row.indexrelid)
      ) = '83876798b71ac8054d76c9e09709dea4'
      AND (
        SELECT pg_catalog.array_agg(attribute.attname ORDER BY key.ordinality)
        FROM pg_catalog.unnest(index_row.indkey)
          WITH ORDINALITY AS key(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute
          ON attribute.attrelid = index_row.indrelid
         AND attribute.attnum = key.attnum
      ) = ARRAY['status', 'expires_at', 'upload_id']::name[]
  ) OR (
    SELECT pg_catalog.count(*)
    FROM pg_catalog.pg_index AS index_row
    WHERE index_row.indrelid = v_registry
  ) <> 3 THEN
    RAISE EXCEPTION 'post media upload registry index shape drifted';
  END IF;
END
$table_shape_preflight$;

DO $converge_registry_acl$
DECLARE
  v_grantee record;
  v_columns text;
BEGIN
  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee, role_row.rolname
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE relation.oid = 'public.post_media_uploads'::pg_catalog.regclass
      AND acl_entry.grantee <> relation.relowner
  LOOP
    IF v_grantee.grantee = 0 THEN
      REVOKE ALL ON TABLE public.post_media_uploads FROM PUBLIC CASCADE;
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE ALL ON TABLE public.post_media_uploads FROM %I CASCADE',
        v_grantee.rolname
      );
    END IF;
  END LOOP;

  SELECT pg_catalog.string_agg(
    pg_catalog.format('%I', attribute.attname),
    ', ' ORDER BY attribute.attnum
  )
  INTO STRICT v_columns
  FROM pg_catalog.pg_attribute AS attribute
  WHERE attribute.attrelid = 'public.post_media_uploads'::pg_catalog.regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  FOR v_grantee IN
    SELECT DISTINCT acl_entry.grantee, role_row.rolname
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    LEFT JOIN pg_catalog.pg_roles AS role_row
      ON role_row.oid = acl_entry.grantee
    WHERE attribute.attrelid = 'public.post_media_uploads'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> pg_catalog.to_regrole('postgres')
  LOOP
    IF v_grantee.grantee = 0 THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.post_media_uploads FROM PUBLIC CASCADE',
        v_columns
      );
    ELSIF v_grantee.rolname IS NOT NULL THEN
      EXECUTE pg_catalog.format(
        'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
          || 'ON TABLE public.post_media_uploads FROM %2$I CASCADE',
        v_columns,
        v_grantee.rolname
      );
    END IF;
  END LOOP;
END
$converge_registry_acl$;

DO $drop_registry_policies$
DECLARE
  v_policy name;
BEGIN
  FOR v_policy IN
    SELECT policy.polname
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.post_media_uploads'::pg_catalog.regclass
  LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY %I ON public.post_media_uploads',
      v_policy
    );
  END LOOP;
END
$drop_registry_policies$;

CREATE OR REPLACE FUNCTION public.reserve_post_media_upload_atomic(
  p_upload_id uuid,
  p_owner_id uuid,
  p_object_name text,
  p_purpose text,
  p_mime_type text,
  p_size_bytes bigint
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
  v_existing public.post_media_uploads%ROWTYPE;
  v_now timestamptz;
  v_expires_at timestamptz;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_upload_id IS NULL
     OR p_owner_id IS NULL
     OR p_object_name IS NULL
     OR p_object_name IS DISTINCT FROM pg_catalog.btrim(p_object_name)
     OR pg_catalog.octet_length(p_object_name) NOT BETWEEN 1 AND 512
     OR p_object_name ~ '[[:cntrl:]]'
     OR p_object_name ~ '(^/|/$|//|(^|/)\.{1,2}(/|$))'
     OR p_purpose IS NULL
     OR p_purpose NOT IN (
       'post_image', 'post_video', 'group_avatar', 'legacy_image'
     )
     OR p_mime_type IS NULL
     OR p_size_bytes IS NULL
     OR NOT (
       (
         p_purpose IN ('post_image', 'group_avatar', 'legacy_image')
         AND p_object_name ~ (
           '^' || pg_catalog.lower(p_owner_id::text)
             || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
             || '\.(jpg|png|gif|webp|avif)$'
         )
         AND p_mime_type IN (
           'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'
         )
         AND (
           (p_mime_type = 'image/jpeg' AND pg_catalog.right(p_object_name, 4) = '.jpg')
           OR (p_mime_type = 'image/png' AND pg_catalog.right(p_object_name, 4) = '.png')
           OR (p_mime_type = 'image/gif' AND pg_catalog.right(p_object_name, 4) = '.gif')
           OR (p_mime_type = 'image/webp' AND pg_catalog.right(p_object_name, 5) = '.webp')
           OR (p_mime_type = 'image/avif' AND pg_catalog.right(p_object_name, 5) = '.avif')
         )
         AND p_size_bytes BETWEEN 1 AND 5242880
       ) OR (
         p_purpose = 'post_video'
         AND p_object_name ~ (
           '^' || pg_catalog.lower(p_owner_id::text)
             || '/videos/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
             || '\.(mp4|mov|webm|mkv|avi)$'
         )
         AND p_mime_type IN (
           'video/mp4',
           'video/quicktime',
           'video/webm',
           'video/x-matroska',
           'video/x-msvideo'
         )
         AND (
           (p_mime_type = 'video/mp4' AND pg_catalog.right(p_object_name, 4) = '.mp4')
           OR (p_mime_type = 'video/quicktime' AND pg_catalog.right(p_object_name, 4) = '.mov')
           OR (p_mime_type = 'video/webm' AND pg_catalog.right(p_object_name, 5) = '.webm')
           OR (p_mime_type = 'video/x-matroska' AND pg_catalog.right(p_object_name, 4) = '.mkv')
           OR (p_mime_type = 'video/x-msvideo' AND pg_catalog.right(p_object_name, 4) = '.avi')
         )
         AND p_size_bytes BETWEEN 1 AND 104857600
       )
     )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid post media upload reservation';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-media-upload-id:' || pg_catalog.lower(p_upload_id::text),
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-media-object:' || p_object_name, 0)
  );

  SELECT upload_row.*
  INTO v_existing
  FROM public.post_media_uploads AS upload_row
  WHERE upload_row.upload_id = p_upload_id
  FOR UPDATE;

  IF FOUND THEN
    IF v_existing.owner_id IS DISTINCT FROM p_owner_id
       OR v_existing.object_name IS DISTINCT FROM p_object_name
       OR v_existing.purpose IS DISTINCT FROM p_purpose
       OR v_existing.mime_type IS DISTINCT FROM p_mime_type
       OR v_existing.size_bytes IS DISTINCT FROM p_size_bytes
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'post media upload reservation identity conflict';
    END IF;

    IF v_existing.status = 'reserved'
       AND v_existing.expires_at <= pg_catalog.statement_timestamp()
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '22023',
        MESSAGE = 'post media upload reservation expired';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
      'status', v_existing.status,
      'upload_id', v_existing.upload_id,
      'object_name', v_existing.object_name,
      'expires_at', v_existing.expires_at,
      'replayed', true
    );
  END IF;

  PERFORM 1
  FROM public.post_media_uploads AS upload_row
  WHERE upload_row.object_name = p_object_name
  FOR UPDATE;
  IF FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post media upload object identity conflict';
  END IF;

  PERFORM 1
  FROM auth.users AS owner_account
  WHERE owner_account.id = p_owner_id
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post media upload owner is unavailable';
  END IF;

  v_now := pg_catalog.statement_timestamp();
  v_expires_at := v_now + interval '1 hour';

  INSERT INTO public.post_media_uploads (
    upload_id,
    owner_id,
    object_name,
    purpose,
    mime_type,
    size_bytes,
    status,
    expires_at,
    created_at,
    updated_at
  ) VALUES (
    p_upload_id,
    p_owner_id,
    p_object_name,
    p_purpose,
    p_mime_type,
    p_size_bytes,
    'reserved',
    v_expires_at,
    v_now,
    v_now
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'reserved',
    'upload_id', p_upload_id,
    'object_name', p_object_name,
    'expires_at', v_expires_at,
    'replayed', false
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.finalize_post_media_upload_atomic(
  p_upload_id uuid,
  p_owner_id uuid,
  p_object_name text,
  p_purpose text,
  p_mime_type text,
  p_size_bytes bigint
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
  v_upload public.post_media_uploads%ROWTYPE;
  v_replayed boolean;
BEGIN
  IF COALESCE((SELECT auth.role()), '') IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION USING
      ERRCODE = '42501',
      MESSAGE = 'service role required';
  END IF;

  IF p_upload_id IS NULL
     OR p_owner_id IS NULL
     OR p_object_name IS NULL
     OR p_object_name IS DISTINCT FROM pg_catalog.btrim(p_object_name)
     OR pg_catalog.octet_length(p_object_name) NOT BETWEEN 1 AND 512
     OR p_purpose IS NULL
     OR p_purpose NOT IN (
       'post_image', 'post_video', 'group_avatar', 'legacy_image'
     )
     OR p_mime_type IS NULL
     OR p_size_bytes IS NULL
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'invalid post media upload finalization';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'post-media-upload-id:' || pg_catalog.lower(p_upload_id::text),
      0
    )
  );
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('post-media-object:' || p_object_name, 0)
  );

  SELECT upload_row.*
  INTO v_upload
  FROM public.post_media_uploads AS upload_row
  WHERE upload_row.upload_id = p_upload_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post media upload reservation is unavailable';
  END IF;

  IF v_upload.owner_id IS DISTINCT FROM p_owner_id
     OR v_upload.object_name IS DISTINCT FROM p_object_name
     OR v_upload.purpose IS DISTINCT FROM p_purpose
     OR v_upload.mime_type IS DISTINCT FROM p_mime_type
     OR v_upload.size_bytes IS DISTINCT FROM p_size_bytes
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post media upload finalization identity conflict';
  END IF;

  IF v_upload.status = 'reserved'
     AND v_upload.expires_at <= pg_catalog.statement_timestamp()
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'post media upload reservation expired';
  END IF;

  PERFORM 1
  FROM storage.objects AS object_row
  WHERE object_row.bucket_id = 'posts'
    AND object_row.name = v_upload.object_name
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING
      ERRCODE = '22023',
      MESSAGE = 'exact posts storage object is unavailable';
  END IF;

  v_replayed := v_upload.status = 'uploaded';
  IF NOT v_replayed THEN
    UPDATE public.post_media_uploads
    SET status = 'uploaded',
        updated_at = pg_catalog.statement_timestamp()
    WHERE upload_id = p_upload_id;
  END IF;

  RETURN pg_catalog.jsonb_build_object(
    'status', 'uploaded',
    'upload_id', v_upload.upload_id,
    'object_name', v_upload.object_name,
    'expires_at', v_upload.expires_at,
    'replayed', v_replayed
  );
END
$function$;

ALTER FUNCTION public.reserve_post_media_upload_atomic(
  uuid, uuid, text, text, text, bigint
) OWNER TO postgres;
ALTER FUNCTION public.finalize_post_media_upload_atomic(
  uuid, uuid, text, text, text, bigint
) OWNER TO postgres;

DO $converge_function_acl$
DECLARE
  v_function regprocedure;
  v_grantee record;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'::pg_catalog.regprocedure,
    'public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)'::pg_catalog.regprocedure
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
      WHERE function_row.oid = v_function
        AND acl_entry.grantee <> function_row.proowner
    LOOP
      IF v_grantee.grantee = 0 THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM PUBLIC CASCADE',
          v_function
        );
      ELSIF v_grantee.rolname IS NOT NULL THEN
        EXECUTE pg_catalog.format(
          'REVOKE ALL ON FUNCTION %s FROM %I CASCADE',
          v_function,
          v_grantee.rolname
        );
      END IF;
    END LOOP;

    EXECUTE pg_catalog.format(
      'GRANT EXECUTE ON FUNCTION %s TO service_role',
      v_function
    );
  END LOOP;
END
$converge_function_acl$;

DO $seal_registry_functions$
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
          'public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
          'post-media-upload-registry:reserve-v1:'
        ),
        (
          'public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
          'post-media-upload-registry:finalize-v1:'
        )
    ) AS expected(signature, comment_prefix)
  LOOP
    v_function := v_expected.signature::pg_catalog.regprocedure;
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
$seal_registry_functions$;

DO $postflight$
DECLARE
  v_expected record;
  v_function regprocedure;
  v_postgres oid := pg_catalog.to_regrole('postgres');
  v_service oid := pg_catalog.to_regrole('service_role');
  v_plpgsql oid := (
    SELECT language_row.oid
    FROM pg_catalog.pg_language AS language_row
    WHERE language_row.lanname = 'plpgsql'
  );
  v_source text;
  v_comment text;
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(
        relation.relacl,
        pg_catalog.acldefault('r', relation.relowner)
      )
    ) AS acl_entry
    WHERE relation.oid = 'public.post_media_uploads'::pg_catalog.regclass
      AND acl_entry.grantee <> relation.relowner
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute AS attribute
    CROSS JOIN LATERAL pg_catalog.aclexplode(attribute.attacl) AS acl_entry
    WHERE attribute.attrelid = 'public.post_media_uploads'::pg_catalog.regclass
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND acl_entry.grantee <> v_postgres
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'public.post_media_uploads'::pg_catalog.regclass
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = 'public.post_media_uploads'::pg_catalog.regclass
      AND NOT trigger_row.tgisinternal
  ) OR NOT pg_temp.post_media_registry_role_graph_is_safe() THEN
    RAISE EXCEPTION 'post media upload registry ACL/RLS convergence failed';
  END IF;

  FOR v_expected IN
    SELECT *
    FROM (
      VALUES
        (
          'public.reserve_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
          ARRAY[
            'p_upload_id',
            'p_owner_id',
            'p_object_name',
            'p_purpose',
            'p_mime_type',
            'p_size_bytes'
          ]::text[],
          'post-media-upload-registry:reserve-v1:'
        ),
        (
          'public.finalize_post_media_upload_atomic(uuid,uuid,text,text,text,bigint)',
          ARRAY[
            'p_upload_id',
            'p_owner_id',
            'p_object_name',
            'p_purpose',
            'p_mime_type',
            'p_size_bytes'
          ]::text[],
          'post-media-upload-registry:finalize-v1:'
        )
    ) AS expected(signature, argument_names, comment_prefix)
  LOOP
    v_function := v_expected.signature::pg_catalog.regprocedure;
    SELECT function_row.prosrc,
           pg_catalog.obj_description(function_row.oid, 'pg_proc')
    INTO STRICT v_source, v_comment
    FROM pg_catalog.pg_proc AS function_row
    WHERE function_row.oid = v_function
      AND function_row.prokind = 'f'
      AND function_row.prorettype = 'jsonb'::pg_catalog.regtype
      AND NOT function_row.proretset
      AND function_row.proowner = v_postgres
      AND function_row.prosecdef
      AND function_row.provolatile = 'v'
      AND function_row.prolang = v_plpgsql
      AND NOT function_row.proisstrict
      AND function_row.proparallel = 'u'
      AND NOT function_row.proleakproof
      AND function_row.pronargs = 6
      AND function_row.pronargdefaults = 0
      AND function_row.proargnames = v_expected.argument_names
      AND pg_catalog.cardinality(function_row.proconfig) = 4
      AND function_row.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'row_security=off',
        'lock_timeout=5s',
        'statement_timeout=15s'
      ]::text[];

    IF NOT FOUND
       OR v_comment IS DISTINCT FROM
            v_expected.comment_prefix || pg_catalog.md5(v_source)
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
           AND acl_entry.grantee = v_service
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
           AND acl_entry.grantee NOT IN (function_row.proowner, v_service)
       )
    THEN
      RAISE EXCEPTION
        'post media upload registry function contract failed: %',
        v_function;
    END IF;
  END LOOP;
END
$postflight$;

COMMIT;
