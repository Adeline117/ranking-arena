-- Chat attachments belong to private conversations and group channels. Keep
-- the Storage bucket private and ensure browser roles cannot use an unrelated
-- permissive storage.objects policy to bypass server-side membership checks.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, pg_temp;

SELECT pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('private-chat-media-storage@1', 0)
);

-- Prove that every disjunct of a browser-visible permissive policy starts
-- with a literal non-chat bucket constraint. This accepts the repository's
-- avatar/cover policies while rejecting generic, function-derived, or
-- ambiguous policies. A first mandatory AND term is sufficient because the
-- remainder cannot make a chat row satisfy that term.
CREATE OR REPLACE FUNCTION pg_temp.chat_policy_excludes_chat(
  p_expression text
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
  IF v_expression IS NULL OR v_expression = '' THEN
    RETURN false;
  END IF;

  -- Remove only parentheses that wrap the complete expression.
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

  -- Every top-level OR branch must independently exclude chat.
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
    RETURN pg_temp.chat_policy_excludes_chat(
             pg_catalog.substr(v_expression, 1, v_split - 1)
           )
       AND pg_temp.chat_policy_excludes_chat(
             pg_catalog.substr(v_expression, v_split + 4)
           );
  END IF;

  -- Reduce a conjunction to its mandatory first term.
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
    RETURN pg_temp.chat_policy_excludes_chat(
      pg_catalog.substr(v_expression, 1, v_split - 1)
    );
  END IF;

  v_bucket_id := pg_catalog.substring(
    v_expression,
    '^bucket_id = ''([a-z0-9][a-z0-9_-]*)''::text$'
  );
  RETURN v_bucket_id IS NOT NULL AND v_bucket_id <> 'chat';
END
$function$;

DO $preflight$
DECLARE
  v_role text;
  v_current_role_oid oid := pg_catalog.to_regrole(CURRENT_USER);
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
  v_anon_role_oid oid := pg_catalog.to_regrole('anon');
  v_authenticated_role_oid oid := pg_catalog.to_regrole('authenticated');
  v_storage_admin_role_oid oid := pg_catalog.to_regrole('supabase_storage_admin');
  v_bucket_owner_oid oid;
  v_object_owner_oid oid;
  v_storage_mode text;
  v_unsafe_policy name;
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17 THEN
    RAISE EXCEPTION 'private chat media storage requires PostgreSQL 17';
  END IF;

  FOREACH v_role IN ARRAY ARRAY[
    'postgres', 'anon', 'authenticated', 'service_role'
  ]::text[]
  LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'required private-chat role is unavailable: %', v_role;
    END IF;
  END LOOP;

  IF pg_catalog.to_regclass('storage.buckets') IS NULL
     OR pg_catalog.to_regclass('storage.objects') IS NULL THEN
    RAISE EXCEPTION 'Supabase Storage tables must exist before private chat rollout';
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
    ) AS required_column(relation_name, column_name, type_oid, required_not_null)
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
  ) THEN
    RAISE EXCEPTION 'Supabase Storage relations must be canonical permanent tables';
  END IF;

  SELECT relation.relowner INTO STRICT v_bucket_owner_oid
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'storage.buckets'::pg_catalog.regclass;
  SELECT relation.relowner INTO STRICT v_object_owner_oid
  FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = 'storage.objects'::pg_catalog.regclass;

  IF v_bucket_owner_oid = v_current_role_oid
     AND v_object_owner_oid = v_current_role_oid THEN
    v_storage_mode := 'owner';
  ELSIF v_storage_admin_role_oid IS NOT NULL
        AND v_bucket_owner_oid = v_storage_admin_role_oid
        AND v_object_owner_oid = v_storage_admin_role_oid THEN
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
    WHERE relation.oid = 'storage.objects'::pg_catalog.regclass
  ) OR EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS browser_role
    WHERE browser_role.oid IN (v_anon_role_oid, v_authenticated_role_oid)
      AND (browser_role.rolsuper OR browser_role.rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'browser roles must remain behind storage.objects RLS';
  END IF;

  IF EXISTS (
    SELECT 1 FROM storage.buckets AS bucket
    WHERE bucket.id = 'chat' AND bucket.name <> 'chat'
  ) OR EXISTS (
    SELECT 1 FROM storage.buckets AS bucket
    WHERE bucket.name = 'chat' AND bucket.id <> 'chat'
  ) THEN
    RAISE EXCEPTION 'chat bucket id/name identity drifted';
  END IF;

  IF v_storage_mode = 'managed' THEN
    SELECT policy.polname INTO v_unsafe_policy
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'storage.objects'::pg_catalog.regclass
      AND policy.polpermissive
      AND (
        0::oid = ANY (policy.polroles)
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(policy.polroles) AS target_role(role_oid)
          WHERE target_role.role_oid <> 0
            AND (
              pg_catalog.pg_has_role(v_anon_role_oid, target_role.role_oid, 'USAGE')
              OR pg_catalog.pg_has_role(
                v_authenticated_role_oid,
                target_role.role_oid,
                'USAGE'
              )
            )
        )
      )
      AND (
        (
          policy.polcmd IN ('*', 'r', 'w', 'd')
          AND NOT pg_temp.chat_policy_excludes_chat(
            pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true)
          )
        )
        OR (
          policy.polcmd IN ('*', 'a', 'w')
          AND NOT pg_temp.chat_policy_excludes_chat(
            COALESCE(
              pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true),
              pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true)
            )
          )
        )
      )
    ORDER BY policy.polname
    LIMIT 1;

    IF v_unsafe_policy IS NOT NULL THEN
      RAISE EXCEPTION
        'managed storage policy % can authorize chat; restrict it before rollout',
        v_unsafe_policy;
    END IF;
  END IF;

  PERFORM pg_catalog.set_config(
    'app.private_chat_media_storage_mode',
    v_storage_mode,
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
  'chat',
  'chat',
  false,
  52428800,
  ARRAY[
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/avif',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'audio/webm',
    'application/zip',
    'application/x-rar-compressed'
  ]::text[]
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DO $configure_owner_policies$
BEGIN
  IF pg_catalog.current_setting('app.private_chat_media_storage_mode') = 'managed' THEN
    RETURN;
  ELSIF pg_catalog.current_setting('app.private_chat_media_storage_mode') <> 'owner' THEN
    RAISE EXCEPTION 'private chat storage mode is invalid';
  END IF;

  ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS "Non-service roles cannot access chat media"
    ON storage.objects;
  CREATE POLICY "Non-service roles cannot access chat media"
    ON storage.objects
    AS RESTRICTIVE
    FOR ALL
    TO PUBLIC
    USING (bucket_id <> 'chat' OR CURRENT_USER = 'service_role')
    WITH CHECK (bucket_id <> 'chat' OR CURRENT_USER = 'service_role');

  DROP POLICY IF EXISTS "Service role manages chat media"
    ON storage.objects;
  CREATE POLICY "Service role manages chat media"
    ON storage.objects
    AS PERMISSIVE
    FOR ALL
    TO service_role
    USING (bucket_id = 'chat')
    WITH CHECK (bucket_id = 'chat');
END
$configure_owner_policies$;

DO $postflight$
DECLARE
  v_mode text := pg_catalog.current_setting('app.private_chat_media_storage_mode');
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
  v_anon_role_oid oid := pg_catalog.to_regrole('anon');
  v_authenticated_role_oid oid := pg_catalog.to_regrole('authenticated');
  v_unsafe_policy name;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM storage.buckets AS bucket
    WHERE bucket.id = 'chat'
      AND bucket.name = 'chat'
      AND bucket.public IS false
      AND bucket.file_size_limit = 52428800
      AND bucket.allowed_mime_types = ARRAY[
        'image/jpeg',
        'image/jpg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/avif',
        'video/mp4',
        'video/webm',
        'video/quicktime',
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/plain',
        'audio/webm',
        'application/zip',
        'application/x-rar-compressed'
      ]::text[]
  ) THEN
    RAISE EXCEPTION 'private chat bucket contract is invalid';
  END IF;

  IF NOT (
    SELECT relation.relrowsecurity
    FROM pg_catalog.pg_class AS relation
    WHERE relation.oid = 'storage.objects'::pg_catalog.regclass
  ) THEN
    RAISE EXCEPTION 'storage.objects RLS was disabled during rollout';
  END IF;

  IF v_mode = 'owner' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = 'storage.objects'::pg_catalog.regclass
        AND policy.polname = 'Non-service roles cannot access chat media'
        AND NOT policy.polpermissive
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[0::oid]::oid[]
    ) OR NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_policy AS policy
      WHERE policy.polrelid = 'storage.objects'::pg_catalog.regclass
        AND policy.polname = 'Service role manages chat media'
        AND policy.polpermissive
        AND policy.polcmd = '*'
        AND policy.polroles = ARRAY[v_service_role_oid]::oid[]
    ) THEN
      RAISE EXCEPTION 'private chat storage policy contract is invalid';
    END IF;
  ELSIF v_mode = 'managed' THEN
    SELECT policy.polname INTO v_unsafe_policy
    FROM pg_catalog.pg_policy AS policy
    WHERE policy.polrelid = 'storage.objects'::pg_catalog.regclass
      AND policy.polpermissive
      AND (
        0::oid = ANY (policy.polroles)
        OR EXISTS (
          SELECT 1
          FROM pg_catalog.unnest(policy.polroles) AS target_role(role_oid)
          WHERE target_role.role_oid <> 0
            AND (
              pg_catalog.pg_has_role(v_anon_role_oid, target_role.role_oid, 'USAGE')
              OR pg_catalog.pg_has_role(
                v_authenticated_role_oid,
                target_role.role_oid,
                'USAGE'
              )
            )
        )
      )
      AND (
        (
          policy.polcmd IN ('*', 'r', 'w', 'd')
          AND NOT pg_temp.chat_policy_excludes_chat(
            pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true)
          )
        )
        OR (
          policy.polcmd IN ('*', 'a', 'w')
          AND NOT pg_temp.chat_policy_excludes_chat(
            COALESCE(
              pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true),
              pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true)
            )
          )
        )
      )
    ORDER BY policy.polname
    LIMIT 1;
    IF v_unsafe_policy IS NOT NULL THEN
      RAISE EXCEPTION 'chat storage policy boundary changed during rollout';
    END IF;
  ELSE
    RAISE EXCEPTION 'private chat storage mode changed during rollout';
  END IF;
END
$postflight$;

COMMIT;
