-- Migration: 20260729185500_post_media_storage.sql
-- Created: 2026-07-30T01:55:00Z
-- Description: Provision the public posts media bucket used by the image and
--   video upload APIs while keeping direct database object access service-only.
--   Public delivery is provided by the Storage public-object endpoint, not by
--   a browser SELECT policy on storage.objects.
-- Phase: predeploy.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $migration_lock$
BEGIN
  IF NOT pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('public-post-media-storage@1', 0)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '55P03',
      MESSAGE = 'post media storage migration lock is busy';
  END IF;
END
$migration_lock$;

-- In managed Supabase Storage, migrations intentionally retain the
-- supabase_storage_admin table owners and grants. Prove that every permissive
-- browser policy independently excludes posts before relying on that policy
-- set. A literal first AND term is sufficient because the rest cannot make a
-- posts row satisfy it; every top-level OR branch must pass independently.
CREATE OR REPLACE FUNCTION pg_temp.storage_policy_excludes_posts(
  p_expression text,
  p_identity_column text DEFAULT 'bucket_id'
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_expression text := pg_catalog.btrim(p_expression);
  v_index integer;
  v_length integer;
  v_depth integer;
  v_in_literal boolean;
  v_character text;
  v_split integer;
  v_outer_wrapper boolean;
  v_bucket_id text;
BEGIN
  IF v_expression IS NULL
     OR v_expression = ''
     OR p_identity_column NOT IN ('bucket_id', 'id')
  THEN
    RETURN false;
  END IF;

  LOOP
    EXIT WHEN pg_catalog.left(v_expression, 1) <> '('
      OR pg_catalog.right(v_expression, 1) <> ')';

    v_length := pg_catalog.length(v_expression);
    v_depth := 0;
    v_in_literal := false;
    v_outer_wrapper := true;
    v_index := 1;
    WHILE v_index <= v_length LOOP
      v_character := pg_catalog.substr(v_expression, v_index, 1);
      IF v_character = '''' THEN
        IF v_in_literal
           AND pg_catalog.substr(v_expression, v_index + 1, 1) = ''''
        THEN
          v_index := v_index + 2;
          CONTINUE;
        END IF;
        v_in_literal := NOT v_in_literal;
      ELSIF NOT v_in_literal AND v_character = '(' THEN
        v_depth := v_depth + 1;
      ELSIF NOT v_in_literal AND v_character = ')' THEN
        v_depth := v_depth - 1;
        IF v_depth = 0 AND v_index < v_length THEN
          v_outer_wrapper := false;
          EXIT;
        ELSIF v_depth < 0 THEN
          RETURN false;
        END IF;
      END IF;
      v_index := v_index + 1;
    END LOOP;
    IF v_in_literal OR v_depth <> 0 THEN
      RETURN false;
    END IF;
    EXIT WHEN NOT v_outer_wrapper;
    v_expression := pg_catalog.btrim(
      pg_catalog.substr(v_expression, 2, v_length - 2)
    );
  END LOOP;

  v_length := pg_catalog.length(v_expression);
  v_depth := 0;
  v_in_literal := false;
  v_split := 0;
  v_index := 1;
  WHILE v_index <= v_length LOOP
    v_character := pg_catalog.substr(v_expression, v_index, 1);
    IF v_character = '''' THEN
      IF v_in_literal
         AND pg_catalog.substr(v_expression, v_index + 1, 1) = ''''
      THEN
        v_index := v_index + 2;
        CONTINUE;
      END IF;
      v_in_literal := NOT v_in_literal;
    ELSIF NOT v_in_literal AND v_character = '(' THEN
      v_depth := v_depth + 1;
    ELSIF NOT v_in_literal AND v_character = ')' THEN
      v_depth := v_depth - 1;
      IF v_depth < 0 THEN
        RETURN false;
      END IF;
    ELSIF NOT v_in_literal
      AND v_depth = 0
      AND pg_catalog.substr(v_expression, v_index, 4) = ' OR '
    THEN
      v_split := v_index;
      EXIT;
    END IF;
    v_index := v_index + 1;
  END LOOP;
  IF v_in_literal OR v_depth <> 0 THEN
    RETURN false;
  END IF;

  IF v_split > 0 THEN
    RETURN pg_temp.storage_policy_excludes_posts(
             pg_catalog.substr(v_expression, 1, v_split - 1),
             p_identity_column
           )
       AND pg_temp.storage_policy_excludes_posts(
             pg_catalog.substr(v_expression, v_split + 4),
             p_identity_column
           );
  END IF;

  v_depth := 0;
  v_in_literal := false;
  v_split := 0;
  v_index := 1;
  WHILE v_index <= v_length LOOP
    v_character := pg_catalog.substr(v_expression, v_index, 1);
    IF v_character = '''' THEN
      IF v_in_literal
         AND pg_catalog.substr(v_expression, v_index + 1, 1) = ''''
      THEN
        v_index := v_index + 2;
        CONTINUE;
      END IF;
      v_in_literal := NOT v_in_literal;
    ELSIF NOT v_in_literal AND v_character = '(' THEN
      v_depth := v_depth + 1;
    ELSIF NOT v_in_literal AND v_character = ')' THEN
      v_depth := v_depth - 1;
    ELSIF NOT v_in_literal
      AND v_depth = 0
      AND pg_catalog.substr(v_expression, v_index, 5) = ' AND '
    THEN
      v_split := v_index;
      EXIT;
    END IF;
    v_index := v_index + 1;
  END LOOP;

  IF v_split > 0 THEN
    RETURN pg_temp.storage_policy_excludes_posts(
      pg_catalog.substr(v_expression, 1, v_split - 1),
      p_identity_column
    );
  END IF;

  v_bucket_id := pg_catalog.substring(
    v_expression,
    '^' || p_identity_column ||
      ' = ''([a-z0-9][a-z0-9_-]*)''::text$'
  );
  RETURN v_bucket_id IS NOT NULL AND v_bucket_id <> 'posts';
END
$function$;

DO $preflight$
DECLARE
  v_role text;
  v_current_role_oid oid := pg_catalog.to_regrole(CURRENT_USER);
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
  v_anon_role_oid oid := pg_catalog.to_regrole('anon');
  v_authenticated_role_oid oid := pg_catalog.to_regrole('authenticated');
  v_authenticator_role_oid oid := pg_catalog.to_regrole('authenticator');
  v_storage_admin_role_oid oid :=
    pg_catalog.to_regrole('supabase_storage_admin');
  v_bucket_owner_oid oid;
  v_object_owner_oid oid;
  v_storage_mode text;
  v_unsafe_policy name;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
  THEN
    RAISE EXCEPTION 'post media storage requires PostgreSQL 17';
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
      RAISE EXCEPTION 'required post-media role is unavailable: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('storage.buckets') IS NULL
     OR pg_catalog.to_regclass('storage.objects') IS NULL
  THEN
    RAISE EXCEPTION 'Supabase Storage tables must exist before post media';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (
      VALUES
        ('buckets', 'id', 'text'::pg_catalog.regtype, true),
        ('buckets', 'name', 'text'::pg_catalog.regtype, true),
        ('buckets', 'public', 'boolean'::pg_catalog.regtype, false),
        ('buckets', 'file_size_limit', 'bigint'::pg_catalog.regtype, false),
        ('buckets', 'allowed_mime_types', 'text[]'::pg_catalog.regtype, false),
        ('objects', 'bucket_id', 'text'::pg_catalog.regtype, false),
        ('objects', 'name', 'text'::pg_catalog.regtype, false)
    ) AS required_column(
      relation_name,
      column_name,
      type_oid,
      required_not_null
    )
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = pg_catalog.to_regclass(
        'storage.' || required_column.relation_name
      )
     AND attribute.attname = required_column.column_name
     AND attribute.attnum > 0
     AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
       OR attribute.atttypid <> required_column.type_oid
       OR (required_column.required_not_null AND NOT attribute.attnotnull)
  ) THEN
    RAISE EXCEPTION 'Supabase Storage column contract drifted';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'storage.buckets'::pg_catalog.regclass
      AND constraint_row.contype IN ('p', 'u')
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid =
            'storage.buckets'::pg_catalog.regclass
          AND attribute.attname = 'id'
      )]::smallint[]
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid =
        'storage.buckets'::pg_catalog.regclass
      AND constraint_row.contype IN ('p', 'u')
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_catalog.pg_attribute AS attribute
        WHERE attribute.attrelid =
            'storage.buckets'::pg_catalog.regclass
          AND attribute.attname = 'name'
      )]::smallint[]
  ) THEN
    RAISE EXCEPTION 'Supabase Storage bucket identity constraints drifted';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid IN (
      'storage.buckets'::pg_catalog.regclass,
      'storage.objects'::pg_catalog.regclass
    )
      AND (
        relation.relkind <> 'r'
        OR relation.relpersistence <> 'p'
        OR relation.relispartition
      )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_inherits AS inheritance
    WHERE inheritance.inhrelid IN (
      'storage.buckets'::pg_catalog.regclass,
      'storage.objects'::pg_catalog.regclass
    )
       OR inheritance.inhparent IN (
         'storage.buckets'::pg_catalog.regclass,
         'storage.objects'::pg_catalog.regclass
       )
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_rewrite AS rewrite_rule
    WHERE rewrite_rule.ev_class IN (
      'storage.buckets'::pg_catalog.regclass,
      'storage.objects'::pg_catalog.regclass
    )
  ) THEN
    RAISE EXCEPTION 'Supabase Storage relations must be canonical permanent tables';
  END IF;

  SELECT relation.relowner
  INTO STRICT v_bucket_owner_oid
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'storage.buckets'::pg_catalog.regclass;
  SELECT relation.relowner
  INTO STRICT v_object_owner_oid
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'storage.objects'::pg_catalog.regclass;

  IF v_bucket_owner_oid = v_current_role_oid
     AND v_object_owner_oid = v_current_role_oid
  THEN
    v_storage_mode := 'owner';
  ELSIF v_storage_admin_role_oid IS NOT NULL
        AND v_bucket_owner_oid = v_storage_admin_role_oid
        AND v_object_owner_oid = v_storage_admin_role_oid
  THEN
    v_storage_mode := 'managed';
    IF (
      SELECT role_row.rolsuper OR NOT role_row.rolbypassrls
      FROM pg_catalog.pg_roles AS role_row
      WHERE role_row.oid = v_current_role_oid
    ) OR pg_catalog.pg_has_role(
      v_current_role_oid,
      v_storage_admin_role_oid,
      'USAGE'
    ) OR NOT pg_catalog.has_table_privilege(
      v_current_role_oid,
      'storage.buckets'::pg_catalog.regclass,
      'SELECT'
    ) OR NOT pg_catalog.has_table_privilege(
      v_current_role_oid,
      'storage.buckets'::pg_catalog.regclass,
      'INSERT'
    ) OR NOT pg_catalog.has_table_privilege(
      v_current_role_oid,
      'storage.buckets'::pg_catalog.regclass,
      'UPDATE'
    ) OR NOT pg_catalog.has_table_privilege(
      v_current_role_oid,
      'storage.objects'::pg_catalog.regclass,
      'SELECT'
    ) OR NOT pg_catalog.has_table_privilege(
      v_current_role_oid,
      'storage.objects'::pg_catalog.regclass,
      'UPDATE'
    ) THEN
      RAISE EXCEPTION 'managed Supabase Storage role boundary is unsupported';
    END IF;
  ELSE
    RAISE EXCEPTION
      'unsupported Supabase Storage ownership: buckets %, objects %, deployer %',
      v_bucket_owner_oid::pg_catalog.regrole,
      v_object_owner_oid::pg_catalog.regrole,
      CURRENT_USER;
  END IF;

  IF NOT (
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'storage.buckets'::pg_catalog.regclass
  ) OR NOT (
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'storage.objects'::pg_catalog.regclass
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS browser_role
    WHERE browser_role.oid IN (
      v_anon_role_oid,
      v_authenticated_role_oid,
      v_authenticator_role_oid
    )
      AND (browser_role.rolsuper OR browser_role.rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'browser roles must remain behind Supabase Storage RLS';
  END IF;

  IF NOT pg_catalog.has_schema_privilege(
       v_service_role_oid,
       'storage',
       'USAGE'
     ) OR NOT pg_catalog.has_table_privilege(
       v_service_role_oid,
       'storage.buckets'::pg_catalog.regclass,
       'SELECT'
     ) OR NOT pg_catalog.has_table_privilege(
       v_service_role_oid,
       'storage.buckets'::pg_catalog.regclass,
       'INSERT'
     ) OR NOT pg_catalog.has_table_privilege(
       v_service_role_oid,
       'storage.buckets'::pg_catalog.regclass,
       'UPDATE'
     ) OR NOT pg_catalog.has_table_privilege(
       v_service_role_oid,
       'storage.buckets'::pg_catalog.regclass,
       'DELETE'
     ) OR NOT pg_catalog.has_table_privilege(
       v_service_role_oid,
       'storage.objects'::pg_catalog.regclass,
       'SELECT'
     ) OR NOT pg_catalog.has_table_privilege(
       v_service_role_oid,
       'storage.objects'::pg_catalog.regclass,
       'INSERT'
     ) OR NOT pg_catalog.has_table_privilege(
       v_service_role_oid,
       'storage.objects'::pg_catalog.regclass,
       'UPDATE'
     ) OR NOT pg_catalog.has_table_privilege(
       v_service_role_oid,
       'storage.objects'::pg_catalog.regclass,
       'DELETE'
     )
  THEN
    RAISE EXCEPTION 'service role lacks the managed object grants';
  END IF;

  -- anon/authenticated must never be able to assume the service identity that
  -- the restrictive policy deliberately admits. authenticator is omitted:
  -- PostgREST legitimately SET ROLEs to JWT roles, including service_role for
  -- service-key requests.
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS browser_role
    WHERE browser_role.oid IN (
      v_anon_role_oid,
      v_authenticated_role_oid
    )
      AND (
        pg_catalog.pg_has_role(
          browser_role.oid,
          v_service_role_oid,
          'MEMBER'
        )
        OR pg_catalog.pg_has_role(
          browser_role.oid,
          v_service_role_oid,
          'USAGE'
        )
      )
  ) THEN
    RAISE EXCEPTION 'browser role can assume the post media service role';
  END IF;

  IF v_storage_mode = 'managed' AND NOT (
    SELECT role_row.rolsuper OR role_row.rolbypassrls
    FROM pg_catalog.pg_roles AS role_row
    WHERE role_row.oid = v_service_role_oid
  ) THEN
    RAISE EXCEPTION 'managed Storage requires service_role RLS bypass';
  END IF;

  IF v_storage_mode = 'managed' AND EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS browser_role
    WHERE browser_role.oid IN (
      v_anon_role_oid,
      v_authenticated_role_oid
    )
      AND (
        pg_catalog.pg_has_role(
          browser_role.oid,
          v_storage_admin_role_oid,
          'MEMBER'
        )
        OR pg_catalog.pg_has_role(
          browser_role.oid,
          v_storage_admin_role_oid,
          'USAGE'
        )
      )
  ) THEN
    RAISE EXCEPTION 'browser role can assume the managed Storage owner';
  END IF;

  -- id='posts' can safely have its display name converged. A different id
  -- already owning name='posts' would require object ownership rewrites, so
  -- that ambiguity is rejected instead.
  IF EXISTS (
    SELECT 1
    FROM storage.buckets AS bucket
    WHERE bucket.name = 'posts'
      AND bucket.id <> 'posts'
  ) THEN
    RAISE EXCEPTION 'posts bucket name belongs to a different bucket id';
  END IF;

  IF v_storage_mode = 'managed' THEN
    SELECT policy.polname
    INTO v_unsafe_policy
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'storage.buckets'::pg_catalog.regclass
      AND policy.polpermissive
      AND policy.polcmd IN ('*', 'a', 'w', 'd')
      AND (
        0::oid = ANY(policy.polroles)
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(policy.polroles) AS target_role(role_oid)
          WHERE target_role.role_oid <> 0
            AND (
              pg_catalog.pg_has_role(
                v_anon_role_oid,
                target_role.role_oid,
                'USAGE'
              )
              OR pg_catalog.pg_has_role(
                v_authenticated_role_oid,
                target_role.role_oid,
                'USAGE'
              )
              OR pg_catalog.pg_has_role(
                v_authenticator_role_oid,
                target_role.role_oid,
                'USAGE'
              )
            )
        )
      )
      AND (
        (
          policy.polcmd IN ('*', 'w', 'd')
          AND NOT pg_temp.storage_policy_excludes_posts(
            pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
            'id'
          )
        )
        OR (
          policy.polcmd IN ('*', 'a', 'w')
          AND NOT pg_temp.storage_policy_excludes_posts(
            COALESCE(
              pg_catalog.pg_get_expr(
                policy.polwithcheck,
                policy.polrelid,
                true
              ),
              pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true)
            ),
            'id'
          )
        )
      )
    ORDER BY policy.polname
    LIMIT 1;

    IF v_unsafe_policy IS NOT NULL THEN
      RAISE EXCEPTION
        'managed bucket policy % can mutate posts; restrict it first',
        v_unsafe_policy;
    END IF;

    v_unsafe_policy := NULL;
    SELECT policy.polname
    INTO v_unsafe_policy
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'storage.objects'::pg_catalog.regclass
      AND policy.polpermissive
      AND (
        0::oid = ANY(policy.polroles)
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(policy.polroles) AS target_role(role_oid)
          WHERE target_role.role_oid <> 0
            AND (
              pg_catalog.pg_has_role(
                v_anon_role_oid,
                target_role.role_oid,
                'USAGE'
              )
              OR pg_catalog.pg_has_role(
                v_authenticated_role_oid,
                target_role.role_oid,
                'USAGE'
              )
              OR pg_catalog.pg_has_role(
                v_authenticator_role_oid,
                target_role.role_oid,
                'USAGE'
              )
            )
        )
      )
      AND (
        (
          policy.polcmd IN ('*', 'r', 'w', 'd')
          AND NOT pg_temp.storage_policy_excludes_posts(
            pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true)
          )
        )
        OR (
          policy.polcmd IN ('*', 'a', 'w')
          AND NOT pg_temp.storage_policy_excludes_posts(
            COALESCE(
              pg_catalog.pg_get_expr(
                policy.polwithcheck,
                policy.polrelid,
                true
              ),
              pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true)
            )
          )
        )
      )
    ORDER BY policy.polname
    LIMIT 1;

    IF v_unsafe_policy IS NOT NULL THEN
      RAISE EXCEPTION
        'managed storage policy % can authorize posts; restrict it first',
        v_unsafe_policy;
    END IF;
  END IF;

  PERFORM pg_catalog.set_config(
    'app.post_media_storage_mode',
    v_storage_mode,
    true
  );
  PERFORM pg_catalog.set_config(
    'app.post_media_bucket_owner',
    v_bucket_owner_oid::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'app.post_media_object_owner',
    v_object_owner_oid::text,
    true
  );
  PERFORM pg_catalog.set_config(
    'app.post_media_bucket_acl',
    COALESCE((
      SELECT relation.relacl::text
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = 'storage.buckets'::pg_catalog.regclass
    ), '<null>'),
    true
  );
  PERFORM pg_catalog.set_config(
    'app.post_media_object_acl',
    COALESCE((
      SELECT relation.relacl::text
      FROM pg_catalog.pg_class AS relation
      WHERE relation.oid = 'storage.objects'::pg_catalog.regclass
    ), '<null>'),
    true
  );
END
$preflight$;

LOCK TABLE storage.buckets IN ROW EXCLUSIVE MODE;
LOCK TABLE storage.objects IN SHARE ROW EXCLUSIVE MODE;

INSERT INTO storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
) VALUES (
  'posts',
  'posts',
  true,
  104857600,
  ARRAY[
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/avif',
    'video/mp4',
    'video/quicktime',
    'video/webm',
    'video/x-matroska',
    'video/x-msvideo'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DO $configure_owner_policies$
BEGIN
  IF pg_catalog.current_setting('app.post_media_storage_mode') = 'managed'
  THEN
    RETURN;
  ELSIF pg_catalog.current_setting('app.post_media_storage_mode') <> 'owner'
  THEN
    RAISE EXCEPTION 'post media storage mode is invalid';
  END IF;

  DROP POLICY IF EXISTS "Non-service roles cannot manage posts bucket"
    ON storage.buckets;
  CREATE POLICY "Non-service roles cannot manage posts bucket"
    ON storage.buckets
    AS RESTRICTIVE
    FOR ALL
    TO PUBLIC
    USING (id <> 'posts' OR CURRENT_USER = 'service_role')
    WITH CHECK (id <> 'posts' OR CURRENT_USER = 'service_role');

  DROP POLICY IF EXISTS "Service role manages posts bucket"
    ON storage.buckets;
  CREATE POLICY "Service role manages posts bucket"
    ON storage.buckets
    AS PERMISSIVE
    FOR ALL
    TO service_role
    USING (id = 'posts')
    WITH CHECK (id = 'posts');

  DROP POLICY IF EXISTS "Non-service roles cannot access post media"
    ON storage.objects;
  CREATE POLICY "Non-service roles cannot access post media"
    ON storage.objects
    AS RESTRICTIVE
    FOR ALL
    TO PUBLIC
    USING (bucket_id <> 'posts' OR CURRENT_USER = 'service_role')
    WITH CHECK (bucket_id <> 'posts' OR CURRENT_USER = 'service_role');

  DROP POLICY IF EXISTS "Service role manages post media"
    ON storage.objects;
  CREATE POLICY "Service role manages post media"
    ON storage.objects
    AS PERMISSIVE
    FOR ALL
    TO service_role
    USING (bucket_id = 'posts')
    WITH CHECK (bucket_id = 'posts');
END
$configure_owner_policies$;

DO $postflight$
DECLARE
  v_mode text := pg_catalog.current_setting('app.post_media_storage_mode');
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
  v_anon_role_oid oid := pg_catalog.to_regrole('anon');
  v_authenticated_role_oid oid := pg_catalog.to_regrole('authenticated');
  v_authenticator_role_oid oid := pg_catalog.to_regrole('authenticator');
  v_storage_admin_role_oid oid :=
    pg_catalog.to_regrole('supabase_storage_admin');
  v_unsafe_policy name;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM storage.buckets AS bucket
    WHERE bucket.id = 'posts'
      AND bucket.name = 'posts'
      AND bucket.public IS true
      AND bucket.file_size_limit = 104857600
      AND bucket.allowed_mime_types = ARRAY[
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/avif',
        'video/mp4',
        'video/quicktime',
        'video/webm',
        'video/x-matroska',
        'video/x-msvideo'
      ]::text[]
  ) OR EXISTS (
    SELECT 1
    FROM storage.buckets AS bucket
    WHERE bucket.name = 'posts'
      AND bucket.id <> 'posts'
  ) THEN
    RAISE EXCEPTION 'post media bucket contract is invalid';
  END IF;

  IF NOT (
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'storage.buckets'::pg_catalog.regclass
  ) OR NOT (
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'storage.objects'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'storage.objects RLS was disabled during post media rollout';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS browser_role
    WHERE browser_role.oid IN (
      v_anon_role_oid,
      v_authenticated_role_oid
    )
      AND (
        pg_catalog.pg_has_role(
          browser_role.oid,
          v_service_role_oid,
          'MEMBER'
        )
        OR pg_catalog.pg_has_role(
          browser_role.oid,
          v_service_role_oid,
          'USAGE'
        )
      )
  ) THEN
    RAISE EXCEPTION 'browser-to-service role boundary changed during rollout';
  END IF;

  IF (
    SELECT relation.relowner::text
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'storage.buckets'::pg_catalog.regclass
  ) IS DISTINCT FROM pg_catalog.current_setting('app.post_media_bucket_owner')
     OR (
       SELECT relation.relowner::text
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'storage.objects'::pg_catalog.regclass
     ) IS DISTINCT FROM pg_catalog.current_setting(
       'app.post_media_object_owner'
     )
     OR COALESCE((
       SELECT relation.relacl::text
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'storage.buckets'::pg_catalog.regclass
     ), '<null>') IS DISTINCT FROM pg_catalog.current_setting(
       'app.post_media_bucket_acl'
     )
     OR COALESCE((
       SELECT relation.relacl::text
       FROM pg_catalog.pg_class AS relation
       WHERE relation.oid = 'storage.objects'::pg_catalog.regclass
     ), '<null>') IS DISTINCT FROM pg_catalog.current_setting(
       'app.post_media_object_acl'
     )
  THEN
    RAISE EXCEPTION 'managed Storage ownership or grants changed';
  END IF;

  IF v_mode = 'owner' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = 'storage.buckets'::pg_catalog.regclass
        AND policy.polname =
          'Non-service roles cannot manage posts bucket'
        AND NOT policy.polpermissive
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[0::oid]::oid[]
        AND pg_catalog.pg_get_expr(
          policy.polqual,
          policy.polrelid,
          false
        ) =
          '((id <> ''posts''::text) OR (CURRENT_USER = ''service_role''::name))'
        AND pg_catalog.pg_get_expr(
          policy.polwithcheck,
          policy.polrelid,
          false
        ) =
          '((id <> ''posts''::text) OR (CURRENT_USER = ''service_role''::name))'
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = 'storage.buckets'::pg_catalog.regclass
        AND policy.polname = 'Service role manages posts bucket'
        AND policy.polpermissive
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
        AND pg_catalog.pg_get_expr(
          policy.polqual,
          policy.polrelid,
          false
        ) = '(id = ''posts''::text)'
        AND pg_catalog.pg_get_expr(
          policy.polwithcheck,
          policy.polrelid,
          false
        ) = '(id = ''posts''::text)'
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = 'storage.objects'::pg_catalog.regclass
        AND policy.polname =
          'Non-service roles cannot access post media'
        AND NOT policy.polpermissive
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[0::oid]::oid[]
        AND pg_catalog.pg_get_expr(
          policy.polqual,
          policy.polrelid,
          false
        ) =
          '((bucket_id <> ''posts''::text) OR (CURRENT_USER = ''service_role''::name))'
        AND pg_catalog.pg_get_expr(
          policy.polwithcheck,
          policy.polrelid,
          false
        ) =
          '((bucket_id <> ''posts''::text) OR (CURRENT_USER = ''service_role''::name))'
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = 'storage.objects'::pg_catalog.regclass
        AND policy.polname = 'Service role manages post media'
        AND policy.polpermissive
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
        AND pg_catalog.pg_get_expr(
          policy.polqual,
          policy.polrelid,
          false
        ) = '(bucket_id = ''posts''::text)'
        AND pg_catalog.pg_get_expr(
          policy.polwithcheck,
          policy.polrelid,
          false
        ) = '(bucket_id = ''posts''::text)'
    ) THEN
      RAISE EXCEPTION 'post media owner policy contract is invalid';
    END IF;
  ELSIF v_mode = 'managed' THEN
    IF v_storage_admin_role_oid IS NULL OR EXISTS (
      SELECT 1
      FROM pg_catalog.pg_roles AS browser_role
      WHERE browser_role.oid IN (
        v_anon_role_oid,
        v_authenticated_role_oid
      )
        AND (
          pg_catalog.pg_has_role(
            browser_role.oid,
            v_storage_admin_role_oid,
            'MEMBER'
          )
          OR pg_catalog.pg_has_role(
            browser_role.oid,
            v_storage_admin_role_oid,
            'USAGE'
          )
        )
    ) THEN
      RAISE EXCEPTION 'managed Storage owner role boundary changed';
    END IF;

    SELECT policy.polname
    INTO v_unsafe_policy
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'storage.buckets'::pg_catalog.regclass
      AND policy.polpermissive
      AND policy.polcmd IN ('*', 'a', 'w', 'd')
      AND (
        0::oid = ANY(policy.polroles)
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(policy.polroles) AS target_role(role_oid)
          WHERE target_role.role_oid <> 0
            AND (
              pg_catalog.pg_has_role(
                v_anon_role_oid,
                target_role.role_oid,
                'USAGE'
              )
              OR pg_catalog.pg_has_role(
                v_authenticated_role_oid,
                target_role.role_oid,
                'USAGE'
              )
              OR pg_catalog.pg_has_role(
                v_authenticator_role_oid,
                target_role.role_oid,
                'USAGE'
              )
            )
        )
      )
      AND (
        (
          policy.polcmd IN ('*', 'w', 'd')
          AND NOT pg_temp.storage_policy_excludes_posts(
            pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true),
            'id'
          )
        )
        OR (
          policy.polcmd IN ('*', 'a', 'w')
          AND NOT pg_temp.storage_policy_excludes_posts(
            COALESCE(
              pg_catalog.pg_get_expr(
                policy.polwithcheck,
                policy.polrelid,
                true
              ),
              pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true)
            ),
            'id'
          )
        )
      )
    ORDER BY policy.polname
    LIMIT 1;

    IF v_unsafe_policy IS NOT NULL THEN
      RAISE EXCEPTION 'post media managed bucket policy boundary changed';
    END IF;

    v_unsafe_policy := NULL;

    SELECT policy.polname
    INTO v_unsafe_policy
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'storage.objects'::pg_catalog.regclass
      AND policy.polpermissive
      AND (
        0::oid = ANY(policy.polroles)
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(policy.polroles) AS target_role(role_oid)
          WHERE target_role.role_oid <> 0
            AND (
              pg_catalog.pg_has_role(
                v_anon_role_oid,
                target_role.role_oid,
                'USAGE'
              )
              OR pg_catalog.pg_has_role(
                v_authenticated_role_oid,
                target_role.role_oid,
                'USAGE'
              )
              OR pg_catalog.pg_has_role(
                v_authenticator_role_oid,
                target_role.role_oid,
                'USAGE'
              )
            )
        )
      )
      AND (
        (
          policy.polcmd IN ('*', 'r', 'w', 'd')
          AND NOT pg_temp.storage_policy_excludes_posts(
            pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true)
          )
        )
        OR (
          policy.polcmd IN ('*', 'a', 'w')
          AND NOT pg_temp.storage_policy_excludes_posts(
            COALESCE(
              pg_catalog.pg_get_expr(
                policy.polwithcheck,
                policy.polrelid,
                true
              ),
              pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true)
            )
          )
        )
      )
    ORDER BY policy.polname
    LIMIT 1;

    IF v_unsafe_policy IS NOT NULL THEN
      RAISE EXCEPTION 'post media managed policy boundary changed';
    END IF;
  ELSE
    RAISE EXCEPTION 'post media storage mode changed during rollout';
  END IF;
END
$postflight$;

COMMIT;
